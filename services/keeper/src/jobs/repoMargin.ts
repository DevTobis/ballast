/**
 * Keeps repo trades margined: opens a margin call when a settled trade's collateral no longer
 * covers its exposure, clears it when the price recovers, and closes the trade out when the
 * borrower has not cured it by the end of the cure window.
 *
 * Each run reads every settled trade's margin from the contract (`margin_view`, a free
 * simulation) and only submits a transaction when something has to change:
 *
 *  - in the margin-call band or worse with no call open  -> `call_margin` (starts the cure clock)
 *  - back under the band with a call open                -> `call_margin` (clears it)
 *  - call open, cure window over, still in the band      -> `default_close`
 *
 * `default_close` re-checks the position itself and refuses a cured one, so a price that
 * recovers between this job's read and its transaction cannot cost the borrower their collateral.
 * Every step is safe to repeat. A trade whose guarded price is not usable is left alone: a call
 * is never opened or defaulted on a price the PriceGuard does not stand behind.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { scaledToDecimalString } from "@ballast/domain-types";
import type { RepoDvpClient } from "@ballast/contract-clients";
import type { KmsSigner } from "@ballast/operator-signing";
import { signAndSubmit, type NetworkSubmissionConfig } from "./submit.js";
import { emptyResult, type JobResult } from "./types.js";

const IN_CALL_BAND = new Set(["MarginCall", "Liquidation"]);

export async function runRepoMarginJob(
  db: Database,
  repoDvpClient: RepoDvpClient,
  signer: KmsSigner,
  now: Date = new Date(),
  /** RPC URL and passphrase from the keeper's startup config; omitted, the environment is read. */
  network?: NetworkSubmissionConfig,
): Promise<JobResult> {
  const result = emptyResult();
  const keeper = signer.publicKey();

  const settled = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.status, "settled"));

  for (const trade of settled) {
    if (!trade.contractTradeId) {
      result.skipped++;
      continue;
    }

    try {
      const id = BigInt(trade.contractTradeId);
      const onChain = await repoDvpClient.trade(id);

      // The trade ended on-chain by a route this job did not take (e.g. the unwind job has not
      // caught up yet): nothing to margin. Reconcile a default into the books.
      if (onChain.status !== "Settled") {
        if (onChain.status === "Defaulted") {
          await db.update(schema.repoTrade).set({ status: "defaulted" }).where(eq(schema.repoTrade.id, trade.id));
        }
        result.skipped++;
        continue;
      }

      const view = await repoDvpClient.marginView(id);
      if (!view.priceOk) {
        result.skipped++;
        continue;
      }
      const inBand = IN_CALL_BAND.has(view.state);
      const deadline = onChain.cureDeadline != null ? Number(onChain.cureDeadline) : null;

      if (onChain.pendingMarginCall && inBand && deadline !== null && now.getTime() / 1000 >= deadline) {
        await signAndSubmit(signer, await repoDvpClient.defaultClose(keeper, id), network);
        await db.update(schema.repoTrade).set({ status: "defaulted" }).where(eq(schema.repoTrade.id, trade.id));
        result.processed++;
        continue;
      }

      if (inBand !== onChain.pendingMarginCall) {
        // Either a call has to be opened, or the open one has been cured by the price.
        await signAndSubmit(signer, await repoDvpClient.callMargin(keeper, id), network);
        const after = await repoDvpClient.trade(id);

        if (after.pendingMarginCall && after.cureDeadline != null) {
          // USDC is correct by construction, not a shortcut: RepoDvP holds one cash token per
          // deployment (the instance `usdc` set by `set_usdc`), every cash leg moves that token,
          // and `margin_call_amount` is denominated in it. `repo_trade` therefore has no currency
          // column; if RepoDvP ever supports more than one cash token, store it on the trade
          // and read it here instead.
          await db.insert(schema.repoMarginCall).values({
            tradeId: trade.id,
            amount: scaledToDecimalString(BigInt(after.marginCallAmount)),
            ccy: "USDC",
            dueAt: new Date(Number(after.cureDeadline) * 1000),
          });
        } else {
          await db
            .update(schema.repoMarginCall)
            .set({ curedAt: now })
            .where(and(eq(schema.repoMarginCall.tradeId, trade.id), isNull(schema.repoMarginCall.curedAt)));
        }
        result.processed++;
        continue;
      }

      result.skipped++; // healthy with no call, or a call still inside its cure window
    } catch (err) {
      result.errors.push({ id: trade.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
