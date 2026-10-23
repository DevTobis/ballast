/**
 * The operator G-account hop (PRD §5 Phase 2: "Contract accounts cannot pay anchors or exchanges
 * that need a memo from a G-address ... Payouts to anchors go through an operator G-account hop
 * with the memo"). The exit desk / credit-line draw already moved USDC from the Ballast contract
 * to the operator's classic account in a prior, separate transaction (`fromContractPayoutTxHash`
 * records that leg); this module does the *second* leg — operator G-account -> anchor G-account,
 * carrying whatever memo the anchor needs to route the deposit to the right customer.
 */
import { Asset, Memo, Operation, TransactionBuilder, BASE_FEE, type Transaction } from "@stellar/stellar-sdk";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { StrKey } from "@stellar/stellar-sdk";
import { schema, recordJournalEntry, type Database } from "@ballast/db";
import { scaledToDecimalString } from "@ballast/domain-types";
import type { PayoutSigner } from "./signer.js";
import type { FirstLegVerifier } from "./firstLeg.js";


/**
 * What the hop is allowed to do, fixed by the operator's configuration rather than by the caller.
 * The endpoint moves the operator's own USDC, so a request alone never decides where money goes or
 * how much: it must name a pre-approved destination, the configured USDC issuer, and an amount
 * under the cap.
 */
export interface PayoutPolicy {
  /** Anchor accounts the hop may pay. Empty means it refuses every payout. */
  allowedDestinations: ReadonlySet<string>;
  usdcIssuer: string;
  /** Largest single payout, in the 7-decimal fixed point used throughout. */
  maxAmount: bigint;
}

export class PayoutRefusedError extends Error {}
export class DuplicatePayoutError extends Error {}

const UNIT = 10_000_000n;
const DEFAULT_MAX_WHOLE_USDC = 5_000n;

export function loadPayoutPolicy(env: NodeJS.ProcessEnv = process.env): PayoutPolicy {
  const issuer = env.PAYOUT_HOP_USDC_ISSUER;
  if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error("payout-hop: PAYOUT_HOP_USDC_ISSUER must be the USDC issuer's G-address");
  }
  const destinations = (env.PAYOUT_HOP_ALLOWED_DESTINATIONS ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (destinations.length === 0) {
    throw new Error("payout-hop: PAYOUT_HOP_ALLOWED_DESTINATIONS must list the anchor accounts it may pay");
  }
  const bad = destinations.find((a) => !StrKey.isValidEd25519PublicKey(a));
  if (bad) throw new Error(`payout-hop: "${bad}" in PAYOUT_HOP_ALLOWED_DESTINATIONS is not a G-address`);
  const maxWhole = env.PAYOUT_HOP_MAX_AMOUNT ? BigInt(env.PAYOUT_HOP_MAX_AMOUNT) : DEFAULT_MAX_WHOLE_USDC;
  return { allowedDestinations: new Set(destinations), usdcIssuer: issuer, maxAmount: maxWhole * UNIT };
}

function checkPolicy(args: ForwardPayoutArgs, policy: PayoutPolicy): void {
  if (!policy.allowedDestinations.has(args.toAnchorAccount)) {
    throw new PayoutRefusedError("destination is not an approved anchor account");
  }
  if (args.usdcAssetAddress !== policy.usdcIssuer) {
    throw new PayoutRefusedError("asset is not the configured USDC");
  }
  if (args.amount <= 0n) throw new PayoutRefusedError("amount must be positive");
  if (args.amount > policy.maxAmount) {
    throw new PayoutRefusedError(`amount exceeds the per-payout cap of ${scaledToDecimalString(policy.maxAmount)} USDC`);
  }
  if (/^[0-9]+$/.test(args.memo)) {
    if (BigInt(args.memo) > 18_446_744_073_709_551_615n) throw new PayoutRefusedError("numeric memo does not fit a MEMO_ID");
  } else if (Buffer.byteLength(args.memo) > 28) {
    throw new PayoutRefusedError("text memo is longer than 28 bytes");
  }
}

/** SEP conventions: anchors ask for either a text memo or a numeric (MEMO_ID) memo — support both. */
function buildMemo(memo: string): Memo {
  if (/^[0-9]+$/.test(memo)) {
    return Memo.id(memo);
  }
  return Memo.text(memo);
}

export interface ForwardPayoutArgs {
  /**
   * The tx hash of the prior leg: Ballast contract -> operator G-account. Checked on-chain before
   * anything is paid (see `firstLeg.ts`), then recorded as the idempotency key.
   */
  fromContractPayoutTxHash: string;
  toAnchorAccount: string;
  /** Fixed-point USDC amount, `PRICE_SCALE` (7 decimals) convention. */
  amount: bigint;
  memo: string;
  /**
   * ASSUMPTION: the classic USDC asset's issuing G-account. Named to match the task spec, but a
   * classic `Operation.payment` needs `Asset(code, issuerG)`, not the USDC Soroban Asset
   * Contract's C-address — if the real caller only has the SAC's C-address on hand, resolve the
   * issuer G-account from `network-config`/asset registry before calling this.
   */
  usdcAssetAddress: string;
  /**
   * The `exit_quote` this payout fulfils, when the caller is the exit-execute flow. Optional
   * because `payout-hop` also serves credit-line-draw payouts, which have no exit_quote — see the
   * `exit_fill` row comment below for why this is a documented schema gap, not an oversight.
   */
  quoteId?: string;
}

export interface ForwardPayoutResult {
  hash: string;
  status: string;
}

/**
 * Checks that the first leg landed and paid the operator at least `amount` USDC, then builds a
 * classic (non-Soroban) payment operation from the operator G-account to `toAnchorAccount`,
 * attaching the memo the anchor needs, signs and submits it, and records the transfer in Postgres.
 */
export async function forwardPayout(
  db: Database,
  signer: PayoutSigner,
  verifier: FirstLegVerifier,
  args: ForwardPayoutArgs,
  policy: PayoutPolicy,
): Promise<ForwardPayoutResult> {
  checkPolicy(args, policy);

  // Before the claim, so a hash that does not back this payout (or a verifier outage) leaves no row.
  await verifier.verify({
    txHash: args.fromContractPayoutTxHash,
    operator: signer.publicKey(),
    usdcIssuer: policy.usdcIssuer,
    minAmount: args.amount,
  });

  // Claim the first-leg transaction before any money moves. The primary key means the same payout
  // can be requested any number of times (a retry, a replay, a duplicate caller) and be paid once;
  // a payout that failed is the one case that may be claimed again.
  const claimed = await db
    .insert(schema.payoutForward)
    .values({
      fromTxHash: args.fromContractPayoutTxHash,
      toAccount: args.toAnchorAccount,
      amount: scaledToDecimalString(args.amount),
      memo: args.memo,
    })
    .onConflictDoNothing()
    .returning({ fromTxHash: schema.payoutForward.fromTxHash });
  if (claimed.length === 0) {
    const reclaimed = await db
      .update(schema.payoutForward)
      .set({ status: "claimed", toAccount: args.toAnchorAccount, amount: scaledToDecimalString(args.amount), memo: args.memo })
      .where(
        and(
          eq(schema.payoutForward.fromTxHash, args.fromContractPayoutTxHash),
          eq(schema.payoutForward.status, "failed"),
        ),
      )
      .returning({ fromTxHash: schema.payoutForward.fromTxHash });
    if (reclaimed.length === 0) {
      throw new DuplicatePayoutError(`payout for ${args.fromContractPayoutTxHash} was already requested`);
    }
  }

  let hash: string;
  let status: string;
  try {
    const account = await signer.loadSequenceAccount();
    const usdc = new Asset("USDC", policy.usdcIssuer);
    const tx: Transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: signer.networkPassphrase(),
      memo: buildMemo(args.memo),
    })
      .addOperation(
        Operation.payment({
          destination: args.toAnchorAccount,
          asset: usdc,
          amount: scaledToDecimalString(args.amount),
        }),
      )
      .setTimeout(30)
      .build();
    ({ hash, status } = await signer.signAndSubmit(tx));
    if (status === "ERROR") {
      throw new Error(`payout-hop: anchor hop transaction submission failed (hash=${hash}, status=${status})`);
    }
  } catch (err) {
    await db
      .update(schema.payoutForward)
      .set({ status: "failed" })
      .where(eq(schema.payoutForward.fromTxHash, args.fromContractPayoutTxHash));
    throw err;
  }

  await db
    .update(schema.payoutForward)
    .set({ status: "sent", txHash: hash })
    .where(eq(schema.payoutForward.fromTxHash, args.fromContractPayoutTxHash));

  await db.transaction(async (trx) => {
    // `exit_fill.quote_id` is NOT NULL in the current schema and there's no generic "payout" table
    // for non-exit flows (a credit-line draw routed to an anchor). When there's a real exit_quote
    // to point at, record the exit_fill row; otherwise rely on the journal_entry rows below plus
    // `payout_forward` for traceability.
    if (args.quoteId) {
      await trx.insert(schema.exitFill).values({
        quoteId: args.quoteId,
        txHash: hash,
        payoutRoute: "anchor_hop",
        payoutMemo: args.memo,
      });
    }

    // A balanced pair, not a lone credit row: cash leaving Ballast's operator account (debit)
    // funds the payout booked against the payout-hop account (credit). Both legs go through
    // `recordJournalEntry` directly (not `recordDoubleEntry`, which opens its own transaction)
    // since this is already inside one.
    const refId = args.quoteId ?? randomUUID();
    await recordJournalEntry(trx, {
      refType: "payout_hop",
      refId,
      account: "usdc_cash",
      debit: args.amount,
      credit: 0n,
      ccy: "USDC",
    });
    await recordJournalEntry(trx, {
      refType: "payout_hop",
      refId,
      account: "operator:payout_hop",
      debit: 0n,
      credit: args.amount,
      ccy: "USDC",
    });
  });

  return { hash, status };
}
