/**
 * PRD §6.5: "Submits scheduled transactions: ... cure-window expiries."
 *
 * Finds open credit lines whose most recent `margin_event` moved them into `MarginCall` more
 * than `credit_line.cure_window_s` seconds ago, with no repayment recorded since (a pledge
 * top-up would show up as a later, healthier `margin_event` from margin-monitor's own recompute,
 * which this job also checks), and triggers `CreditLine.liquidate`.
 *
 * Route defaults to "transfer" (collateral moves directly to the lender) — PRD §6.4's
 * liquidation-order preference is issuer redemption first, but a real deployment would pick the
 * route per asset/situation from the lender console; this job just needs *a* sensible default.
 */
import { desc, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { loadNetworkConfig } from "@ballast/network-config";
import type { CreditLineClient } from "@ballast/contract-clients";
import type { KmsSigner } from "../submit.js";
import { submitSignedTx } from "../submit.js";
import { emptyResult, type JobResult } from "./types.js";

export async function runCureExpiryJob(
  db: Database,
  creditLineClient: CreditLineClient,
  signer: KmsSigner,
): Promise<JobResult> {
  const result = emptyResult();

  const openLines = await db.select().from(schema.creditLine).where(eq(schema.creditLine.status, "open"));

  for (const line of openLines) {
    const [latestEvent] = await db
      .select()
      .from(schema.marginEvent)
      .where(eq(schema.marginEvent.creditLineId, line.id))
      .orderBy(desc(schema.marginEvent.createdAt))
      .limit(1);

    if (!latestEvent || latestEvent.toState !== "MarginCall") {
      result.skipped++; // not currently in a margin call, or already moved on (cured/liquidated)
      continue;
    }

    const cureDeadlineMs = latestEvent.createdAt.getTime() + line.cureWindowS * 1000;
    if (Date.now() < cureDeadlineMs) {
      result.skipped++; // still inside the cure window
      continue;
    }

    const repayments = await db.select().from(schema.repayment).where(eq(schema.repayment.creditLineId, line.id));
    const curedByRepayment = repayments.some((r) => r.createdAt.getTime() > latestEvent.createdAt.getTime());
    if (curedByRepayment) {
      result.skipped++;
      continue;
    }

    if (!line.contractLineId) {
      result.skipped++; // not yet opened on-chain
      continue;
    }

    try {
      const unsignedXdr = await creditLineClient.liquidate(
        signer.publicKey(),
        BigInt(line.contractLineId),
        "transfer",
      );
      const signedXdr = await signer.sign(unsignedXdr);
      const network = loadNetworkConfig();
      await submitSignedTx(network.rpcUrl, network.networkPassphrase, signedXdr);
      result.processed++;
    } catch (err) {
      result.errors.push({ id: line.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
