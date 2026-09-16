import { describe, expect, it } from "vitest";
import { runReconciliation } from "./reconcile.js";
import { schema } from "@ballast/db";

const ASSET_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTRACT_C = "CPLEDGEVAULT000000000000000000000000000000000000000000";

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
        { contract: CONTRACT_C, topic: "pledge", data: { value: ["GASSET000000000000000000000000000000000000000000000000", "10000000000"] } }, // 1000.0000000 scaled
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
        { contract: CONTRACT_C, topic: "pledge", data: { value: ["GASSET000000000000000000000000000000000000000000000000", "10000000000"] } },
        { contract: CONTRACT_C, topic: "release", data: { value: ["GASSET000000000000000000000000000000000000000000000000", "6000000000"] } },
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
      chainEvent: [{ contract: CONTRACT_C, topic: "pledge", data: { value: ["GASSET000000000000000000000000000000000000000000000000", "9999999950"] } }],
    });

    const { breaks } = await runReconciliation(db);
    expect(breaks).toBe(0);
  });
});
