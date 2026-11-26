/**
 * Reconciles each open line's collateral figure on `CreditLine` with what `PledgeVault` actually
 * holds for it.
 *
 * The vault reports every change to a position to the credit line in the same transaction
 * (`CreditLine::sync_from_vault`), so a healthy deployment never needs this job to change anything.
 * It exists to repair drift: a line that predates the vault wiring, a vault reconfigured after
 * positions existed, anything that left the two out of step. The vault's own balance is the source
 * of truth. This job never derives the figure from Postgres: our pledge rows can lag a transaction
 * by a sweep interval, and syncing from them would briefly write back a collateral number that no
 * longer exists, reopening the release-then-draw window the vault reporting closes.
 *
 * A line already in step costs two reads and no transaction, which is what lets this run every
 * minute without paying a fee per line per run.
 *
 * Counts as: processed = `sync_collateral` submitted with the vault's units. skipped = no on-chain
 * id, or the credit line already matches the vault. error = the line threw.
 */
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { CreditLineClient, PledgeVaultClient } from "@ballast/contract-clients";
import type { KmsSigner } from "@ballast/operator-signing";
import { signAndSubmit, type NetworkSubmissionConfig } from "./submit.js";
import { emptyResult, type JobResult } from "./types.js";

export async function runSyncCollateralJob(
  db: Database,
  creditLineClient: CreditLineClient,
  pledgeVaultClient: PledgeVaultClient,
  signer: KmsSigner,
  /** RPC URL and passphrase from the keeper's startup config; omitted, the environment is read. */
  network?: NetworkSubmissionConfig,
): Promise<JobResult> {
  const result = emptyResult();

  const openLines = await db.select().from(schema.creditLine).where(eq(schema.creditLine.status, "open"));

  for (const line of openLines) {
    if (!line.contractLineId) {
      result.skipped++;
      continue;
    }

    try {
      const contractLine = BigInt(line.contractLineId);
      const onChain = await creditLineClient.line(contractLine);
      const held = BigInt(await pledgeVaultClient.positionUnits(contractLine, onChain.asset));

      if (BigInt(onChain.pledgedUnits) === held) {
        result.skipped++;
        continue;
      }

      const unsignedXdr = await creditLineClient.syncCollateral(signer.publicKey(), contractLine, held);
      await signAndSubmit(signer, unsignedXdr, network);
      result.processed++;
    } catch (err) {
      result.errors.push({ id: line.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
