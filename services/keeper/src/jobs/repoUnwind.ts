/**
 * PRD §6.5: "Submits scheduled transactions: repo leg 2 ..."
 *
 * Finds settled repo trades past maturity, triggers `RepoDvP.unwind`, signs and submits with the
 * keeper operator key, and records the resulting tx hash on success.
 *
 * The on-chain trade id comes from `repo_trade.contract_trade_id`, which `services/api` fills in
 * when the propose transaction settles. A trade without one never reached the chain through this
 * API and is skipped (counted, not errored).
 */
import { and, eq, lte } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { RepoDvpClient } from "@ballast/contract-clients";
import type { KmsSigner } from "@ballast/operator-signing";
import { signAndSubmit, type NetworkSubmissionConfig } from "./submit.js";
import { emptyResult, type JobResult } from "./types.js";

export async function runRepoUnwindJob(
  db: Database,
  repoDvpClient: RepoDvpClient,
  signer: KmsSigner,
  /** RPC URL and passphrase from the keeper's startup config; omitted, the environment is read. */
  network?: NetworkSubmissionConfig,
): Promise<JobResult> {
  const result = emptyResult();
  const now = new Date();

  const dueTrades = await db
    .select()
    .from(schema.repoTrade)
    .where(and(eq(schema.repoTrade.status, "settled"), lte(schema.repoTrade.maturityAt, now)));

  for (const trade of dueTrades) {
    const contractId = trade.contractTradeId ? BigInt(trade.contractTradeId) : null;
    if (contractId === null) {
      result.skipped++;
      continue;
    }

    try {
      const onChain = await repoDvpClient.trade(contractId);

      if (onChain.status !== "Settled") {
        if (onChain.status === "Unwound") {
          await db
            .update(schema.repoTrade)
            .set({ status: "unwound" })
            .where(eq(schema.repoTrade.id, trade.id));
          result.processed++;
        } else if (onChain.status === "Defaulted") {
          await db
            .update(schema.repoTrade)
            .set({ status: "defaulted" })
            .where(eq(schema.repoTrade.id, trade.id));
          result.skipped++;
        } else {
          result.skipped++;
        }
        continue;
      }

      const unsignedXdr = await repoDvpClient.unwind(signer.publicKey(), contractId);
      const hash = await signAndSubmit(signer, unsignedXdr, network);

      await db
        .update(schema.repoTrade)
        .set({ status: "unwound", leg2Tx: hash })
        .where(eq(schema.repoTrade.id, trade.id));

      result.processed++;
    } catch (err) {
      result.errors.push({ id: trade.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
