/**
 * PRD §6.5: "Submits scheduled transactions: repo leg 2 ..."
 *
 * Finds settled repo trades past maturity, triggers `RepoDvP.unwind`, signs and submits with the
 * keeper operator key, and records the resulting tx hash on success.
 *
 * KNOWN GAP: `repo_trade.id` is a Postgres uuid (PRD §7's schema has no `contract_trade_id`
 * column analogous to `credit_line.contract_line_id`). `packages/db` is out of scope for this
 * pass, so this job best-effort-parses `trade.id` as the on-chain numeric id and skips (counted,
 * not errored) any row where that doesn't parse — forward-compatible once such a column exists.
 */
import { and, eq, lte } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { loadNetworkConfig } from "@ballast/network-config";
import type { RepoDvpClient } from "@ballast/contract-clients";
import { submitSignedTx, type KmsSigner } from "@ballast/operator-signing";
import { emptyResult, type JobResult } from "./types.js";

function contractTradeId(id: string): bigint | null {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

export async function runRepoUnwindJob(
  db: Database,
  repoDvpClient: RepoDvpClient,
  signer: KmsSigner,
): Promise<JobResult> {
  const result = emptyResult();
  const now = new Date();

  const dueTrades = await db
    .select()
    .from(schema.repoTrade)
    .where(and(eq(schema.repoTrade.status, "settled"), lte(schema.repoTrade.maturityAt, now)));

  for (const trade of dueTrades) {
    const contractId = contractTradeId(trade.id);
    if (contractId === null) {
      result.skipped++;
      continue;
    }

    try {
      const unsignedXdr = await repoDvpClient.unwind(signer.publicKey(), contractId);
      const signedXdr = await signer.sign(unsignedXdr);
      const network = loadNetworkConfig();
      const submitted = await submitSignedTx(network.rpcUrl, network.networkPassphrase, signedXdr);

      await db
        .update(schema.repoTrade)
        .set({ status: "unwound", leg2Tx: submitted.hash })
        .where(eq(schema.repoTrade.id, trade.id));

      result.processed++;
    } catch (err) {
      result.errors.push({ id: trade.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
