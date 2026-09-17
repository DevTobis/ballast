/**
 * PRD §6.5: "Submits scheduled transactions: ... interest accrual checkpoints."
 *
 * `CreditLine.poke` is permissionless on-chain (no role check — "anyone" per PRD §8), but the
 * resulting transaction still needs *a* signer to submit; this job uses the keeper operator key
 * for convenience, as the task brief calls for, even though the call itself isn't role-gated.
 */
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { loadNetworkConfig } from "@ballast/network-config";
import type { CreditLineClient } from "@ballast/contract-clients";
import { submitSignedTx, type KmsSigner } from "@ballast/operator-signing";
import { emptyResult, type JobResult } from "./types.js";

export async function runInterestAccrualJob(
  db: Database,
  creditLineClient: CreditLineClient,
  signer: KmsSigner,
): Promise<JobResult> {
  const result = emptyResult();

  const openLines = await db.select().from(schema.creditLine).where(eq(schema.creditLine.status, "open"));

  for (const line of openLines) {
    if (!line.contractLineId) {
      result.skipped++;
      continue;
    }

    try {
      // `poke` is permissionless on-chain and resolves its own fee-paying source internally
      // (see @ballast/contract-clients' resolvePokeSource) — it takes no caller argument.
      const unsignedXdr = await creditLineClient.poke(BigInt(line.contractLineId));
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
