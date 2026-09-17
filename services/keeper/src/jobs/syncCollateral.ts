/**
 * PRD §6.5 / `contracts/credit-line/src/lib.rs::sync_collateral`'s own doc comment: "In the real
 * system the off-chain `margin-monitor` service keeps this synced from `PledgeVault`'s on-chain
 * balance via the indexer." Nothing did this until now — without it, every `CreditLine`'s
 * `pledged_units` stays at 0 forever, and every `draw` would be rejected as unhealthy (found in
 * audit; see `syncCollateral.test.ts`).
 *
 * This keeper job (not margin-monitor — margin-monitor is a read-only observer with no signer;
 * writing on-chain state is keeper's job elsewhere in this codebase too) sums each open credit
 * line's `active` pledge units in Postgres and pushes the total via `CreditLine.sync_collateral`,
 * admin-or-keeper-gated on-chain. This is a Postgres-vs-chain proxy, same caveat as
 * `services/ledger`'s reconciliation: it trusts our own indexed pledge rows as ground truth for
 * "what's really pledged," rather than reading `PledgeVault`'s contract storage directly.
 */
import { eq, and } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { decimalStringToScaled } from "@ballast/domain-types";
import { loadNetworkConfig } from "@ballast/network-config";
import type { CreditLineClient } from "@ballast/contract-clients";
import { submitSignedTx, type KmsSigner } from "@ballast/operator-signing";
import { emptyResult, type JobResult } from "./types.js";

export async function runSyncCollateralJob(
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
      const activePledges = await db
        .select()
        .from(schema.pledge)
        .where(and(eq(schema.pledge.creditLineId, line.id), eq(schema.pledge.status, "active")));

      const totalUnits = activePledges.reduce(
        (sum, p) => sum + decimalStringToScaled(p.units),
        0n,
      );

      const unsignedXdr = await creditLineClient.syncCollateral(
        signer.publicKey(),
        BigInt(line.contractLineId),
        totalUnits,
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
