import { describe, expect, it } from "vitest";
import { runReconciliation } from "./reconcile.js";
import { schema } from "@ballast/db";

const ASSET_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTRACT_C = "CASSETSAC0000000000000000000000000000000000000000000000";
const VAULT_C = "CPLEDGEVAULT000000000000000000000000000000000000000000";

function fakeDb(rows: {
  journalEntry?: unknown[];
  asset?: unknown[];
  pledge?: unknown[];
  chainEvent?: unknown[];
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const tableRows = new Map<unknown, unknown[]>([
    [schema.journalEntry, rows.journalEntry ?? []],
    [schema.asset, rows.asset ?? []],
    [schema.pledge, rows.pledge ?? []],
    [schema.chainEvent, rows.chainEvent ?? []],
  ]);

  const db = {
    select: () => ({
      from: (table: unknown) => Promise.resolve(tableRows.get(table) ?? []),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { db, inserted };
}

const baseAsset = {
  id: ASSET_ID,
  code: "EUTBL",
  contractC: CONTRACT_C,
};

describe("runReconciliation", () => {
  it("reports zero breaks when postgres pledge units match the chain-event-implied units", async () => {
    const { db, inserted } = fakeDb({
      asset: [baseAsset],
      pledge: [{ assetId: ASSET_ID, status: "active", units: "1000.0000000" }],
      chainEvent: [
        { contract: VAULT_C, topic: "pledged", data: { value: [CONTRACT_C, "10000000000"] } }, // 1000.0000000 scaled
      ],
    });

    const { breaks, report } = await runReconciliation(db);

    expect(breaks).toBe(0);
    expect(report.mismatches).toHaveLength(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ scope: "nightly", breaks: 0 });
  });

  it("flags a break and fires the reconciliation_break alert on a deliberate mismatch", async () => {
    const { db, inserted } = fakeDb({
      asset: [baseAsset],
      // Postgres says 1000 units pledged and active...
      pledge: [{ assetId: ASSET_ID, status: "active", units: "1000.0000000" }],
      // ...but the chain only shows 400 units pledged, net of a release. That's a real break.
      chainEvent: [
        { contract: VAULT_C, topic: "pledged", data: { value: [CONTRACT_C, "10000000000"] } },
        { contract: VAULT_C, topic: "released", data: { value: [CONTRACT_C, "6000000000"] } },
      ],
    });

    const { breaks, report } = await runReconciliation(db);

    expect(breaks).toBe(1);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      assetId: ASSET_ID,
      code: "EUTBL",
      pgUnits: "10000000000",
      chainUnitsImplied: "4000000000",
    });
    expect(inserted[0]).toMatchObject({ scope: "nightly", breaks: 1 });
  });

  it("ignores mismatches within the tolerance band", async () => {
    const { db } = fakeDb({
      asset: [baseAsset],
      pledge: [{ assetId: ASSET_ID, status: "active", units: "1000.0000000" }],
      // off by 0.0000050 units, well inside TOLERANCE_UNITS
      chainEvent: [{ contract: VAULT_C, topic: "pledged", data: { value: [CONTRACT_C, "9999999950"] } }],
    });

    const { breaks } = await runReconciliation(db);
    expect(breaks).toBe(0);
  });

  it("applies released and liquidated events as negative deltas and ignores unrelated topics", async () => {
    const chainEvents = [
      { contract: VAULT_C, topic: "pledged", data: { value: [CONTRACT_C, "1000000000"] } },
      { contract: VAULT_C, topic: "released", data: { value: [CONTRACT_C, "100000000"] } },
      { contract: VAULT_C, topic: "liquidated", data: { value: [CONTRACT_C, "200000000", "GLENDER"] } },
      { contract: VAULT_C, topic: "fund", data: { value: [CONTRACT_C, "500000000"] } },
    ];

    const { db: matchingDb } = fakeDb({
      asset: [baseAsset],
      pledge: [{ assetId: ASSET_ID, status: "active", units: "70.0000000" }],
      chainEvent: chainEvents,
    });

    const matchingOutcome = await runReconciliation(matchingDb);
    expect(matchingOutcome.breaks).toBe(0);
    expect(matchingOutcome.report.mismatches).toHaveLength(0);

    const { db: mismatchDb } = fakeDb({
      asset: [baseAsset],
      pledge: [{ assetId: ASSET_ID, status: "active", units: "100.0000000" }],
      chainEvent: chainEvents,
    });

    const mismatchOutcome = await runReconciliation(mismatchDb);
    expect(mismatchOutcome.breaks).toBe(1);
    expect(mismatchOutcome.report.mismatches).toHaveLength(1);
    expect(mismatchOutcome.report.mismatches[0]).toMatchObject({
      assetId: ASSET_ID,
      code: "EUTBL",
      pgUnits: "1000000000",
      chainUnitsImplied: "700000000",
      diffUnits: "300000000",
    });
  });
});
