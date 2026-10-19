/**
 * Bridges "the API handed out unsigned XDR" and "the books reflect what happened on-chain" — see
 * the `tx_intent` table's doc comment in `@ballast/db` for why this exists. `recordIntent` runs
 * when a route builds a transaction; `settleIntent` runs once the network has a final status for
 * it and applies that intent's effect to Postgres exactly once.
 *
 * Settle atomicity: Any external RPC or contract data needed for book effects is fetched first,
 * outside the database transaction. Then the conditional status claim (`status = 'pending' -> 'settled'|'failed'`)
 * and the bookkeeping writes (`applySuccess` / `applyFailure`) are executed together within a single
 * `db.transaction`. If the process crashes or an error is raised during book application, the entire
 * transaction rolls back, leaving the intent `pending` so it can be retried rather than permanently settled
 * without effects.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { scaledToDecimalString } from "@ballast/domain-types";
import { UNSIGNED_TX_TIMEOUT_S } from "@ballast/contract-clients";
import type { ChainGateway } from "./chain.js";
import type { ContractClients } from "./contract-clients.js";
import { outstandingDebt } from "./routes/helpers.js";

export type IntentKind =
  | "credit_line.open"
  | "credit_line.fund"
  | "credit_line.withdraw"
  | "credit_line.close_liquidated"
  | "credit_line.draw"
  | "credit_line.repay"
  | "pledge.create"
  | "pledge.release"
  | "exit.execute"
  | "repo.propose"
  | "repo.accept"
  | "repo.unwind"
  | "repo.top_up";

export interface IntentArgs {
  xdr: string;
  kind: IntentKind;
  /** The Postgres row this transaction is about (credit line, pledge, quote or trade id). */
  refId: string;
  partyId: string;
  payload?: Record<string, string>;
}

type IntentRow = typeof schema.txIntent.$inferSelect;

export async function recordIntent(db: Database, chain: ChainGateway, args: IntentArgs): Promise<string> {
  const txHash = chain.txHash(args.xdr);
  await db.insert(schema.txIntent).values({
    txHash,
    kind: args.kind,
    refId: args.refId,
    partyId: args.partyId,
    payload: args.payload ?? {},
  });
  return txHash;
}

export async function findIntent(db: Database, txHash: string): Promise<IntentRow | undefined> {
  const [intent] = await db.select().from(schema.txIntent).where(eq(schema.txIntent.txHash, txHash)).limit(1);
  return intent;
}

export interface SettleResult {
  txHash: string;
  kind: string;
  refId: string | null;
  status: "pending" | "settled" | "failed" | "expired";
  ledger: number | null;
}

function result(intent: IntentRow, status: SettleResult["status"], ledger: number | null): SettleResult {
  return { txHash: intent.txHash, kind: intent.kind, refId: intent.refId, status, ledger };
}

/**
 * Extra data fetched outside the DB transaction (e.g. from contract RPCs or pre-transaction queries)
 * needed to update the books.
 */
interface SettleContext {
  liquidationRecord?: { recovered: bigint; shortfall: bigint };
  outstandingDebt?: bigint;
  contractLineDrawn?: bigint;
  repoTradeUnits?: bigint;
  repoMarginCallPending?: boolean;
}

/** What a transaction that closed successfully means for the books. */
async function applySuccess(
  db: Database,
  intent: IntentRow,
  ledger: number,
  returnValue: unknown,
  ctx?: SettleContext,
): Promise<void> {
  const refId = intent.refId!;
  const payload = (intent.payload ?? {}) as Record<string, string>;

  switch (intent.kind as IntentKind) {
    case "credit_line.open":
      // `CreditLine::open` returns the new line's on-chain id.
      await db
        .update(schema.creditLine)
        .set({ contractLineId: String(returnValue), status: "open" })
        .where(eq(schema.creditLine.id, refId));
      return;

    case "credit_line.fund":
      return; // moves the lender's USDC into the contract; nothing in `credit_line` tracks it

    case "credit_line.withdraw":
      return; // moves USDC from the contract back to the lender; nothing in `credit_line` tracks it

    case "credit_line.close_liquidated": {
      // The contract values the collateral at the price frozen when the liquidation was confirmed;
      // the books take its recorded outcome rather than recomputing it.
      const record = ctx?.liquidationRecord;
      const [liquidation] = await db
        .select()
        .from(schema.liquidation)
        .where(eq(schema.liquidation.creditLineId, refId))
        .orderBy(desc(schema.liquidation.startedAt))
        .limit(1);
      if (liquidation && record) {
        await db
          .update(schema.liquidation)
          .set({
            proceeds: scaledToDecimalString(record.recovered),
            shortfall: scaledToDecimalString(record.shortfall),
            txHashes: [...(liquidation.txHashes ?? []), intent.txHash],
            completedAt: new Date(),
          })
          .where(eq(schema.liquidation.id, liquidation.id));
      }
      await db
        .update(schema.creditLine)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(schema.creditLine.id, refId));
      return;
    }

    case "credit_line.draw":
      await db
        .insert(schema.draw)
        .values({ creditLineId: refId, amount: scaledToDecimalString(BigInt(payload.amount)), txHash: intent.txHash, ledger });
      return;

    case "credit_line.repay": {
      // `repay` pays accrued interest first, then principal, and returns nothing — so the split
      // is read back from the contract: whatever principal the line no longer owes is what this
      // repayment retired, and the rest of the amount was interest.
      const amount = BigInt(payload.amount);
      const before = ctx?.outstandingDebt ?? 0n;
      const drawn = ctx?.contractLineDrawn ?? 0n;
      let principal = before - drawn;
      if (principal < 0n) principal = 0n;
      if (principal > amount) principal = amount;
      await db.insert(schema.repayment).values({
        creditLineId: refId,
        principal: scaledToDecimalString(principal),
        interest: scaledToDecimalString(amount - principal),
        txHash: intent.txHash,
        ledger,
      });
      return;
    }

    case "pledge.create":
      await db.update(schema.pledge).set({ status: "active" }).where(eq(schema.pledge.id, refId));
      return;

    case "pledge.release":
      await db.update(schema.pledge).set({ status: "released" }).where(eq(schema.pledge.id, refId));
      return;

    case "exit.execute":
      await db.update(schema.exitQuote).set({ status: "filled" }).where(eq(schema.exitQuote.id, refId));
      await db.insert(schema.exitFill).values({ quoteId: refId, txHash: intent.txHash, payoutRoute: "direct" });
      return;

    case "repo.propose":
      await db
        .update(schema.repoTrade)
        .set({ contractTradeId: String(returnValue) })
        .where(eq(schema.repoTrade.id, refId));
      return;

    case "repo.accept":
      await db
        .update(schema.repoTrade)
        .set({ status: "settled", leg1Tx: intent.txHash, startLedger: ledger })
        .where(eq(schema.repoTrade.id, refId));
      return;

    case "repo.unwind":
      await db
        .update(schema.repoTrade)
        .set({ status: "unwound", leg2Tx: intent.txHash })
        .where(eq(schema.repoTrade.id, refId));
      return;

    case "repo.top_up": {
      // The contract decides whether the top-up was enough to cure; the books follow it.
      if (ctx?.repoTradeUnits !== undefined) {
        await db
          .update(schema.repoTrade)
          .set({ units: scaledToDecimalString(ctx.repoTradeUnits) })
          .where(eq(schema.repoTrade.id, refId));
      }
      if (ctx && !ctx.repoMarginCallPending) {
        await db
          .update(schema.repoMarginCall)
          .set({ curedAt: new Date() })
          .where(and(eq(schema.repoMarginCall.tradeId, refId), isNull(schema.repoMarginCall.curedAt)));
      }
      return;
    }
  }
}

/** Undoes the optimistic row a route wrote when it built a transaction that then failed. */
async function applyFailure(db: Database, intent: IntentRow): Promise<void> {
  const refId = intent.refId!;
  switch (intent.kind as IntentKind) {
    case "credit_line.open":
      await db.update(schema.creditLine).set({ status: "failed" }).where(eq(schema.creditLine.id, refId));
      return;
    case "pledge.create":
      await db.update(schema.pledge).set({ status: "failed" }).where(eq(schema.pledge.id, refId));
      return;
    case "pledge.release":
      await db.update(schema.pledge).set({ status: "active" }).where(eq(schema.pledge.id, refId));
      return;
    case "repo.propose":
      await db.update(schema.repoTrade).set({ status: "failed" }).where(eq(schema.repoTrade.id, refId));
      return;
    default:
      return;
  }
}

/**
 * Asks the network how `intent`'s transaction ended and, the first time it has a final answer,
 * applies it. Safe to call repeatedly and concurrently: claiming the intent and writing its
 * book effects happen in an atomic `db.transaction`. If a crash occurs or an error is thrown
 * during book updates, the transaction rolls back, leaving the intent pending so it is retried.
 */
export async function settleIntent(
  db: Database,
  chain: ChainGateway,
  contracts: ContractClients,
  intent: IntentRow,
): Promise<SettleResult> {
  if (intent.status !== "pending") {
    return result(intent, intent.status as SettleResult["status"], intent.ledger);
  }

  const outcome = await chain.outcome(intent.txHash);
  if (outcome.status === "NOT_FOUND") {
    return result(intent, "pending", null);
  }

  // Pre-fetch any external RPC or contract data needed for book updates before opening the DB transaction.
  const ctx: SettleContext = {};
  if (outcome.status === "SUCCESS" && intent.refId) {
    if (intent.kind === "credit_line.close_liquidated") {
      const [line] = await db.select().from(schema.creditLine).where(eq(schema.creditLine.id, intent.refId)).limit(1);
      if (line?.contractLineId) {
        const record = await contracts.creditLine.liquidationRecord(BigInt(line.contractLineId));
        ctx.liquidationRecord = { recovered: BigInt(record.recovered), shortfall: BigInt(record.shortfall) };
      }
    } else if (intent.kind === "credit_line.repay") {
      const [line] = await db.select().from(schema.creditLine).where(eq(schema.creditLine.id, intent.refId)).limit(1);
      ctx.outstandingDebt = await outstandingDebt(db, intent.refId);
      if (line?.contractLineId) {
        const onChain = await contracts.creditLine.line(BigInt(line.contractLineId));
        ctx.contractLineDrawn = BigInt(onChain.drawn);
      }
    } else if (intent.kind === "repo.top_up") {
      const [trade] = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.id, intent.refId)).limit(1);
      if (trade?.contractTradeId) {
        const onChain = await contracts.repoDvp.trade(BigInt(trade.contractTradeId));
        ctx.repoTradeUnits = BigInt(onChain.units);
        ctx.repoMarginCallPending = Boolean(onChain.pendingMarginCall);
      }
    }
  }

  const next = outcome.status === "SUCCESS" ? "settled" : "failed";

  // Atomically claim the intent and write book changes. If an error is thrown or process crashes,
  // the transaction rolls back so tx_intent remains pending.
  const runInTx = typeof db.transaction === "function" ? db.transaction.bind(db) : (fn: (tx: any) => Promise<any>) => fn(db);

  const claimedWinner = await runInTx(async (tx: any) => {
    const claimed = await tx
      .update(schema.txIntent)
      .set({ status: next, ledger: outcome.ledger, settledAt: new Date() })
      .where(and(eq(schema.txIntent.txHash, intent.txHash), eq(schema.txIntent.status, "pending")))
      .returning();

    if (claimed.length === 0) {
      return false;
    }

    if (outcome.status === "SUCCESS") {
      await applySuccess(tx as unknown as Database, intent, outcome.ledger, outcome.returnValue, ctx);
    } else {
      await applyFailure(tx as unknown as Database, intent);
    }

    return true;
  });

  if (!claimedWinner) {
    const current = (await findIntent(db, intent.txHash)) ?? intent;
    return result(current, current.status as SettleResult["status"], current.ledger);
  }

  return result(intent, next, outcome.ledger);
}

/** How long after it was built an unsubmitted transaction is written off (its envelope is only
 * valid for `UNSIGNED_TX_TIMEOUT_S`; the margin covers clock skew and a slow ledger close). */
export const INTENT_EXPIRY_MS = (UNSIGNED_TX_TIMEOUT_S + 120) * 1000;

/**
 * Settles every pending intent the network now has an answer for, and writes off the ones that
 * can no longer land. `POST /v1/tx/submit` settles the common case inline; this catches the rest
 * — a transaction signed and sent outside the API, a submit call that timed out before the
 * ledger closed, a transaction the customer built and never signed. Without it those would leave
 * a `pending` line or pledge on the books forever.
 */
export async function sweepPendingIntents(
  db: Database,
  chain: ChainGateway,
  contracts: ContractClients,
  now: number = Date.now(),
): Promise<{ settled: number; failed: number; expired: number; errors: number }> {
  const tally = { settled: 0, failed: 0, expired: 0, errors: 0 };
  const pending = await db.select().from(schema.txIntent).where(eq(schema.txIntent.status, "pending"));

  for (const intent of pending) {
    // One intent the RPC chokes on must not stop the sweep reaching the others; it stays
    // pending (and is retried next sweep) until it settles or ages out below.
    let status: SettleResult["status"] = "pending";
    try {
      status = (await settleIntent(db, chain, contracts, intent)).status;
    } catch {
      tally.errors++;
    }

    if (status === "settled") tally.settled++;
    else if (status === "failed") tally.failed++;
    else if (status === "pending" && now - intent.createdAt.getTime() > INTENT_EXPIRY_MS) {
      const runInTx = typeof db.transaction === "function" ? db.transaction.bind(db) : (fn: (tx: any) => Promise<any>) => fn(db);
      const expiredWinner = await runInTx(async (tx: any) => {
        const claimed = await tx
          .update(schema.txIntent)
          .set({ status: "expired", settledAt: new Date(now) })
          .where(and(eq(schema.txIntent.txHash, intent.txHash), eq(schema.txIntent.status, "pending")))
          .returning();
        if (claimed.length === 0) return false;
        await applyFailure(tx as unknown as Database, intent);
        return true;
      });
      if (expiredWinner) {
        tally.expired++;
      }
    }
  }
  return tally;
}
