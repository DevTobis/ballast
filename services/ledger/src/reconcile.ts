/**
 * Nightly on-chain vs. database reconciliation (PRD §6.5, §8 invariant 9: "Sum of positions in
 * Postgres equals contract balances per asset at each reconciliation. A mismatch is a P1
 * incident.").
 *
 * ## What this compares
 *
 * For each `asset` row: the sum of `pledge.units` in Postgres where `status = 'active'`, against
 * the net units implied by every `chain_event` row tagged with that asset's `contract_c` and a
 * `pledge` / `release` / `liquidate` topic (`+units` for `pledge`, `-units` for `release` and
 * `liquidate`, reading the amount out of the event's decoded `data.value`).
 *
 * Separately (and only for the report, not for break detection), it sums `journal_entry`
 * debit/credit per `account`, so the nightly report shows the Postgres books' own internal
 * balances alongside the chain comparison.
 *
 * ## What this defers (documented, not silently skipped)
 *
 * - No direct on-chain contract-balance introspection: invariant 9 as written in the PRD compares
 *   against the contract's actual storage/balance. This skeleton has no `contract-clients`
 *   dependency (that package is owned by a concurrent agent) and no Soroban `getLedgerEntries`
 *   reads, so it compares against our own indexed `chain_event` log instead — a proxy for chain
 *   state, not chain state itself. A full implementation would additionally read
 *   `PledgeVault`/`CreditLine` contract storage directly and treat *that* as ground truth.
 * - Only RWA pledge units are reconciled. Credit-line USDC draw/repay balances, repo trades and
 *   exit fills are not yet folded into the chain-event-implied comparison.
 * - Event decoding matches how `services/indexer`'s `poller.ts` actually stores events: the
 *   `pledged`/`released`/`liquidated` events from `contracts/pledge-vault` publish a `(asset,
 *   units, ...)` tuple as their event body, which `scValToNative` decodes as a plain array — so
 *   `data.value` is `[assetAddress, unitsAsString, ...]`, not a bare unit amount. Index 1 is the
 *   units field for all three topics. (An earlier version of this file assumed `data.value` was
 *   itself the unit amount and called `BigInt(data.value)` directly, which throws on an array —
 *   fixed here.)
 */
import { schema, type Database } from "@ballast/db";
import { createConsoleAlerter } from "@ballast/observability";
import { decimalStringToScaled } from "@ballast/domain-types";

const alerter = createConsoleAlerter("ledger");

/** Tolerance in raw scaled units (1n = 1e-7 of an asset unit) below which a diff isn't a break. */
const TOLERANCE_UNITS = 100n;

const PLEDGE_TOPICS = new Set(["pledge", "release", "liquidate"]);

function topicDelta(topic: string, units: bigint): bigint {
  if (topic === "pledge") return units;
  if (topic === "release" || topic === "liquidate") return -units;
  return 0n;
}

interface AssetMismatch {
  assetId: string;
  code: string;
  pgUnits: string;
  chainUnitsImplied: string;
  diffUnits: string;
}

export interface ReconciliationReport {
  comparedAssets: number;
  mismatches: AssetMismatch[];
  journalAccountBalances: Record<string, { debit: string; credit: string; net: string }>;
  scope: {
    compared: string;
    deferred: string[];
  };
}

export interface ReconciliationOutcome {
  breaks: number;
  report: ReconciliationReport;
}

export async function runReconciliation(db: Database): Promise<ReconciliationOutcome> {
  const [journalRows, assets, pledgeRows, chainEventRows] = await Promise.all([
    db.select().from(schema.journalEntry),
    db.select().from(schema.asset),
    db.select().from(schema.pledge),
    db.select().from(schema.chainEvent),
  ]);

  // --- Postgres books: per-account debit/credit balances (informational, part of the report). ---
  const journalAccountBalances: Record<string, { debit: bigint; credit: bigint; net: bigint }> = {};
  for (const row of journalRows) {
    const acct = (journalAccountBalances[row.account] ??= { debit: 0n, credit: 0n, net: 0n });
    const debit = decimalStringToScaled(row.debit);
    const credit = decimalStringToScaled(row.credit);
    acct.debit += debit;
    acct.credit += credit;
    acct.net += debit - credit;
  }

  // --- Per-asset: active pledge units (Postgres) vs. chain_event-implied units (chain proxy). ---
  const mismatches: AssetMismatch[] = [];

  for (const asset of assets) {
    const pgUnits = pledgeRows
      .filter((p) => p.assetId === asset.id && p.status === "active")
      .reduce((sum, p) => sum + decimalStringToScaled(p.units), 0n);

    const relevantEvents = chainEventRows.filter(
      (e) => e.contract === asset.contractC && PLEDGE_TOPICS.has(e.topic),
    );
    const chainUnits = relevantEvents.reduce((sum, e) => {
      // `data.value` is the decoded `(asset, units, ...)` event-body tuple — a plain array, with
      // units always at index 1 for `pledged`/`released`/`liquidated` (see the module doc above).
      const data = e.data as { value?: unknown } | null;
      const tuple = Array.isArray(data?.value) ? data.value : undefined;
      const unitsField = tuple?.[1];
      const units = typeof unitsField === "string" ? BigInt(unitsField) : 0n;
      return sum + topicDelta(e.topic, units);
    }, 0n);

    const diff = pgUnits - chainUnits;
    const absDiff = diff < 0n ? -diff : diff;

    if (absDiff > TOLERANCE_UNITS) {
      mismatches.push({
        assetId: asset.id,
        code: asset.code,
        pgUnits: pgUnits.toString(),
        chainUnitsImplied: chainUnits.toString(),
        diffUnits: diff.toString(),
      });
    }
  }

  const breaks = mismatches.length;
  const report: ReconciliationReport = {
    comparedAssets: assets.length,
    mismatches,
    journalAccountBalances: Object.fromEntries(
      Object.entries(journalAccountBalances).map(([account, b]) => [
        account,
        { debit: b.debit.toString(), credit: b.credit.toString(), net: b.net.toString() },
      ]),
    ),
    scope: {
      compared:
        "postgres pledge.units (status='active') per asset vs. chain_event rows tagged with that " +
        "asset's contract_c and a pledge/release/liquidate topic, reading units from index 1 of " +
        "each event's decoded (asset, units, ...) data.value tuple",
      deferred: [
        "no direct on-chain contract-balance introspection (this compares against our own indexed " +
          "chain_event log, not a fresh read of contract storage)",
        "credit-line USDC draw/repay balances are not reconciled here, only RWA pledge units",
        "repo_trade and exit_fill flows are not yet folded into the chain-event-implied comparison",
      ],
    },
  };

  await db.insert(schema.reconciliationRun).values({
    scope: "nightly",
    breaks,
    report,
  });

  if (breaks > 0) {
    alerter.fire("reconciliation_break", { breaks, mismatches });
  }

  return { breaks, report };
}
