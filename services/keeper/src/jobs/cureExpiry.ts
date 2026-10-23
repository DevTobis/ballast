/**
 * PRD §6.5: "Submits scheduled transactions: ... cure-window expiries." This is the whole
 * liquidation path, start to finish.
 *
 * `services/margin-monitor` records each margin-state change as a `margin_event`. For every open
 * line whose latest event is `MarginCall` or `Liquidation`, each run of this job:
 *
 *  1. re-reads the line's LTV from the contract (never trusting the recorded event alone — the
 *     borrower may have repaid or topped up since) and leaves a recovered line alone;
 *  2. `poke`s a line at liquidation level so the contract arms its breach flag. `CreditLine`
 *     only liquidates on a second read in a later ledger than that flag (PRD §8 invariant 3), so
 *     this is always at least one run ahead of step 3;
 *  3. once the cure window (counted from when the line first left the healthy/warning band) has
 *     run out and the breach is armed and still confirmed, calls `CreditLine.liquidate`, then
 *     `PledgeVault.liquidate` for each pledged asset, sending the collateral to the lender — the
 *     "transfer" route. `CreditLine.liquidate` only flips the line's status; it deliberately
 *     doesn't move collateral itself (see that contract's module docs), so both calls are this
 *     job's to make;
 *  4. books it: pledges become `liquidated`, a `liquidation` row records the units and
 *     transaction hashes, and the line becomes `liquidating` so no job picks it up again.
 *
 * A line that sits in `MarginCall` past its cure window without reaching the liquidation
 * threshold is not liquidated — the contract refuses, by design — and stays on the lender
 * console's watch list.
 *
 * Every step is safe to repeat: a run that dies after `CreditLine.liquidate` finds the line
 * already `Liquidating` on-chain next time and carries on from the vault.
 */
import { and, desc, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { decimalStringToScaled, scaledToDecimalString } from "@ballast/domain-types";
import { loadNetworkConfig } from "@ballast/network-config";
import type { CreditLineClient, PledgeVaultClient } from "@ballast/contract-clients";
import { submitSignedTx, type KmsSigner } from "@ballast/operator-signing";
import { emptyResult, type JobResult } from "./types.js";

const UNHEALTHY = new Set(["MarginCall", "Liquidation"]);

/** How far back to look for the start of the current unhealthy stretch. */
const EVENT_LOOKBACK = 50;

async function signAndSubmit(signer: KmsSigner, unsignedXdr: string): Promise<string> {
  const network = loadNetworkConfig();
  const signedXdr = await signer.sign(unsignedXdr);
  const submitted = await submitSignedTx(network.rpcUrl, network.networkPassphrase, signedXdr);
  return submitted.hash;
}

export async function runCureExpiryJob(
  db: Database,
  creditLineClient: CreditLineClient,
  pledgeVaultClient: PledgeVaultClient,
  signer: KmsSigner,
): Promise<JobResult> {
  const result = emptyResult();
  const keeper = signer.publicKey();

  const openLines = await db.select().from(schema.creditLine).where(eq(schema.creditLine.status, "open"));

  for (const line of openLines) {
    const events = await db
      .select()
      .from(schema.marginEvent)
      .where(eq(schema.marginEvent.creditLineId, line.id))
      .orderBy(desc(schema.marginEvent.createdAt))
      .limit(EVENT_LOOKBACK);

    if (events.length === 0 || !UNHEALTHY.has(events[0].toState) || !line.contractLineId) {
      result.skipped++; // healthy, or not on-chain yet
      continue;
    }

    try {
      const contractLine = BigInt(line.contractLineId);
      const [view, onChain] = await Promise.all([
        creditLineClient.ltv(contractLine),
        creditLineClient.line(contractLine),
      ]);
      const alreadyLiquidating = onChain.status === "Liquidating";

      if (!alreadyLiquidating) {
        if (view.state !== "Liquidation" || view.priceStatus !== "Ok") {
          result.skipped++; // cured, only at margin-call level, or no trustworthy price
          continue;
        }

        if (onChain.breachLedger == null) {
          await signAndSubmit(signer, await creditLineClient.poke(contractLine, keeper));
          result.skipped++; // armed now; liquidation needs a later ledger, i.e. a later run
          continue;
        }

        // The cure clock starts at the oldest event of the current unbroken unhealthy stretch.
        let breachStart = events[0].createdAt;
        for (const event of events) {
          if (!UNHEALTHY.has(event.toState)) break;
          breachStart = event.createdAt;
        }
        if (Date.now() < breachStart.getTime() + line.cureWindowS * 1000) {
          result.skipped++; // still inside the cure window
          continue;
        }
      }

      const [lenderAccount] = await db
        .select()
        .from(schema.partyAccount)
        .where(eq(schema.partyAccount.partyId, line.lenderId))
        .limit(1);
      if (!lenderAccount) throw new Error(`no stellar account on file for lender ${line.lenderId}`);

      // What the vault actually holds is what gets seized, and what `CreditLine.liquidate` records
      // and `close_liquidated` later values: read it from the vault, never from our own pledge rows,
      // which can lag a transaction. They must agree before the line is liquidated; a mismatch means
      // the vault and credit line are momentarily out of step, which the sync-collateral job repairs.
      const collateralAsset = onChain.asset;
      const held = BigInt(await pledgeVaultClient.positionUnits(contractLine, collateralAsset));
      if (!alreadyLiquidating && held !== BigInt(onChain.pledgedUnits)) {
        result.skipped++;
        continue;
      }

      const txHashes: string[] = [];
      if (!alreadyLiquidating) {
        txHashes.push(
          await signAndSubmit(signer, await creditLineClient.liquidate(keeper, contractLine, "transfer")),
        );
      }

      // Zero when a previous run already moved it and died before booking: nothing left to send.
      if (held > 0n) {
        txHashes.push(
          await signAndSubmit(
            signer,
            await pledgeVaultClient.liquidate(
              keeper,
              contractLine,
              collateralAsset,
              held,
              lenderAccount.stellarAccount,
            ),
          ),
        );
      }

      // A resumed run finds the vault already emptied, so `held` is 0 even though collateral was
      // seized. The pledge rows are still `active` (booking never ran), so they carry the quantity.
      // The earlier run's transaction hashes aren't stored anywhere we can read back, so they stay
      // empty. Refuse to book a zero-unit liquidation rather than lose the quantity from the books.
      const activePledges = await db
        .select()
        .from(schema.pledge)
        .where(and(eq(schema.pledge.creditLineId, line.id), eq(schema.pledge.status, "active")));
      const totalUnits =
        alreadyLiquidating && held === 0n
          ? activePledges.reduce((sum, pledge) => sum + decimalStringToScaled(pledge.units), 0n)
          : held;
      if (totalUnits === 0n) throw new Error(`no seized units recoverable for line ${line.id}`);

      await db.transaction(async (tx) => {
        const pledges = await tx
          .select()
          .from(schema.pledge)
          .where(and(eq(schema.pledge.creditLineId, line.id), eq(schema.pledge.status, "active")));
        for (const pledge of pledges) {
          await tx.update(schema.pledge).set({ status: "liquidated" }).where(eq(schema.pledge.id, pledge.id));
        }

        const existingLiquidation = await tx
          .select()
          .from(schema.liquidation)
          .where(eq(schema.liquidation.creditLineId, line.id))
          .limit(1);

        if (existingLiquidation.length === 0) {
          await tx.insert(schema.liquidation).values({
            creditLineId: line.id,
            route: "transfer",
            units: scaledToDecimalString(totalUnits),
            txHashes,
            completedAt: new Date(),
          });
        } else if (txHashes.length > 0) {
          const mergedHashes = Array.from(new Set([...(existingLiquidation[0].txHashes ?? []), ...txHashes]));
          await tx
            .update(schema.liquidation)
            .set({
              txHashes: mergedHashes,
              completedAt: existingLiquidation[0].completedAt ?? new Date(),
            })
            .where(eq(schema.liquidation.id, existingLiquidation[0].id));
        }

        await tx.update(schema.creditLine).set({ status: "liquidating" }).where(eq(schema.creditLine.id, line.id));
      });

      result.processed++;
    } catch (err) {
      result.errors.push({ id: line.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
