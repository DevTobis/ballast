import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("@ballast/operator-signing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/operator-signing")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runCureExpiryJob } = await import("./cureExpiry.js");

/**
 * Table-keyed fake DB: `select().from(table)` resolves to that table's fixture rows however it's
 * chained (`where`/`orderBy`/`limit` don't filter), and `insert`/`update` calls are recorded.
 */
function makeDb(
  rows: Map<unknown, unknown[]>,
  options?: { onWrite?: (action: string, table: unknown) => void; throwOnTable?: unknown },
) {
  const inserted: Array<{ table: unknown; values: any }> = [];
  const updated: Array<{ table: unknown; set: any }> = [];
  const chain = (table: unknown): any => {
    const data = rows.get(table) ?? [];
    const promise: any = Promise.resolve(data);
    promise.where = () => chain(table);
    promise.orderBy = () => chain(table);
    promise.limit = () => chain(table);
    return promise;
  };
  const createTx = (txRows: Map<unknown, unknown[]>, txInserted: any[], txUpdated: any[]) => ({
    select: () => ({ from: (table: unknown) => chain(table) }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        if (options?.throwOnTable === table) {
          throw new Error(`simulated failure writing to table`);
        }
        options?.onWrite?.("insert", table);
        txInserted.push({ table, values });
        const list = txRows.get(table) ?? [];
        list.push(values);
        txRows.set(table, list);
      },
    }),
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: async () => {
          if (options?.throwOnTable === table) {
            throw new Error(`simulated failure updating table`);
          }
          options?.onWrite?.("update", table);
          txUpdated.push({ table, set });
        },
      }),
    }),
  });

  const db: any = {
    ...createTx(rows, inserted, updated),
    transaction: async (fn: any) => {
      const stageRows = new Map(Array.from(rows.entries()).map(([k, v]) => [k, [...v]]));
      const stageInserted: any[] = [];
      const stageUpdated: any[] = [];
      const tx = createTx(stageRows, stageInserted, stageUpdated);
      const res = await fn(tx);
      for (const [k, v] of stageRows.entries()) {
        rows.set(k, v);
      }
      inserted.push(...stageInserted);
      updated.push(...stageUpdated);
      return res;
    },
  };
  return { db, inserted, updated };
}

const signer = {
  publicKey: vi.fn().mockReturnValue("GKEEPER"),
  sign: vi.fn().mockImplementation(async (xdr: string) => `signed:${xdr}`),
};

const LINE = { id: "line-1", lenderId: "lender-party", cureWindowS: 60, contractLineId: "42", status: "open" };
const longAgo = () => new Date(Date.now() - 3_600_000);

function fixtures(marginEvents: unknown[], line: unknown = LINE) {
  return new Map<unknown, unknown[]>([
    [schema.creditLine, [line]],
    [schema.marginEvent, marginEvents],
    [schema.partyAccount, [{ partyId: "lender-party", stellarAccount: "GLENDER" }]],
    [
      schema.pledge,
      [
        { id: "pledge-1", assetId: "asset-1", units: "100.0000000", status: "active" },
        { id: "pledge-2", assetId: "asset-1", units: "50.0000000", status: "active" },
      ],
    ],
    [schema.asset, [{ id: "asset-1", contractC: "CASSET" }]],
  ]);
}

function clients(view: object, onChain: object, heldUnits: bigint = 1_500_000_000n) {
  return {
    creditLine: {
      ltv: vi.fn().mockResolvedValue(view),
      line: vi.fn().mockResolvedValue(onChain),
      poke: vi.fn().mockResolvedValue("poke-xdr"),
      liquidate: vi.fn().mockResolvedValue("liquidate-xdr"),
    },
    vault: { liquidate: vi.fn().mockResolvedValue("vault-xdr"), positionUnits: vi.fn().mockResolvedValue(heldUnits) },
  };
}

const run = (db: any, c: ReturnType<typeof clients>) =>
  runCureExpiryJob(db, c.creditLine as any, c.vault as any, signer as any);

beforeEach(() => {
  submitMock.mockReset();
  let n = 0;
  submitMock.mockImplementation(async () => ({ hash: `hash-${++n}`, status: "SUCCESS" }));
  process.env.STELLAR_RPC_URL = "http://localhost:8000/soroban/rpc";
  process.env.STELLAR_HORIZON_URL = "http://localhost:8000";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
});

describe("runCureExpiryJob", () => {
  it("leaves a healthy line alone without reading the chain", async () => {
    const { db } = makeDb(fixtures([{ toState: "Healthy", createdAt: longAgo() }]));
    const c = clients({}, {});

    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(c.creditLine.ltv).not.toHaveBeenCalled();
  });

  it("leaves a line alone when the contract says it has recovered since the recorded event", async () => {
    const { db } = makeDb(fixtures([{ toState: "Liquidation", createdAt: longAgo() }]));
    const c = clients({ state: "Healthy", priceStatus: "Ok" }, { status: "Open", breachLedger: null });

    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("does not liquidate a line that is only at margin-call level, even past its cure window", async () => {
    const { db } = makeDb(fixtures([{ toState: "MarginCall", createdAt: longAgo() }]));
    const c = clients({ state: "MarginCall", priceStatus: "Ok" }, { status: "Open", breachLedger: null });

    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(c.creditLine.liquidate).not.toHaveBeenCalled();
  });

  it("pokes to arm the breach flag first, and liquidates nothing in that run", async () => {
    const { db } = makeDb(fixtures([{ toState: "Liquidation", createdAt: longAgo() }]));
    const c = clients({ state: "Liquidation", priceStatus: "Ok" }, { status: "Open", breachLedger: null });

    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(c.creditLine.poke).toHaveBeenCalledWith(42n, "GKEEPER");
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(c.creditLine.liquidate).not.toHaveBeenCalled();
  });

  it("waits out the cure window, counted from the start of the unhealthy stretch", async () => {
    const { db } = makeDb(
      fixtures([
        { toState: "Liquidation", createdAt: new Date() },
        { toState: "MarginCall", createdAt: new Date(Date.now() - 10_000) }, // 10s into a 60s window
        { toState: "Healthy", createdAt: longAgo() },
      ]),
    );
    const c = clients({ state: "Liquidation", priceStatus: "Ok" }, { status: "Open", breachLedger: 100, pledgedUnits: 1_500_000_000n, asset: "CASSET" });

    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("liquidates an armed, confirmed breach past its cure window and sends the collateral to the lender", async () => {
    const { db, inserted, updated } = makeDb(
      fixtures([
        { toState: "Liquidation", createdAt: new Date() },
        // The stretch began with this margin call an hour ago, so the window is long gone even
        // though the latest event is fresh.
        { toState: "MarginCall", createdAt: longAgo() },
      ]),
    );
    const c = clients({ state: "Liquidation", priceStatus: "Ok" }, { status: "Open", breachLedger: 100, pledgedUnits: 1_500_000_000n, asset: "CASSET" });

    expect(await run(db, c)).toEqual({ processed: 1, skipped: 0, errors: [] });

    expect(c.creditLine.liquidate).toHaveBeenCalledWith("GKEEPER", 42n, "transfer");
    // Both pledges are of one asset: one vault call for their 150 units combined.
    expect(c.vault.liquidate).toHaveBeenCalledTimes(1);
    expect(c.vault.liquidate).toHaveBeenCalledWith("GKEEPER", 42n, "CASSET", 1_500_000_000n, "GLENDER");

    expect(updated.filter((u) => u.table === schema.pledge)).toHaveLength(2);
    expect(updated).toContainEqual({ table: schema.creditLine, set: { status: "liquidating" } });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].values).toMatchObject({
      creditLineId: "line-1",
      route: "transfer",
      units: "150.0000000",
      txHashes: ["hash-1", "hash-2"],
    });
  });

  it("waits for sync-collateral when the credit line's figure differs from what the vault holds", async () => {
    const { db, inserted } = makeDb(fixtures([{ toState: "Liquidation", createdAt: longAgo() }]));
    // The vault holds 150 units but the credit line still counts 100.
    const c = clients(
      { state: "Liquidation", priceStatus: "Ok" },
      { status: "Open", breachLedger: 100, pledgedUnits: 1_000_000_000n, asset: "CASSET" },
      1_500_000_000n,
    );

    expect(await run(db, c)).toEqual({ processed: 0, skipped: 1, errors: [] });
    expect(c.creditLine.liquidate).not.toHaveBeenCalled();
    expect(c.vault.liquidate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("resumes at the vault when the line is already Liquidating on-chain", async () => {
    const { db, updated } = makeDb(fixtures([{ toState: "Liquidation", createdAt: new Date() }]));
    const c = clients({ state: "Liquidation", priceStatus: "Ok" }, { status: "Liquidating", breachLedger: 100, asset: "CASSET" });

    expect(await run(db, c)).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(c.creditLine.liquidate).not.toHaveBeenCalled();
    expect(c.vault.liquidate).toHaveBeenCalledTimes(1);
    expect(updated).toContainEqual({ table: schema.creditLine, set: { status: "liquidating" } });
  });

  it("books a liquidation whose vault transfer already happened in an earlier, interrupted run", async () => {
    const { db, inserted, updated } = makeDb(fixtures([{ toState: "Liquidation", createdAt: new Date() }]));
    const c = clients(
      { state: "Liquidation", priceStatus: "Ok" },
      { status: "Liquidating", breachLedger: 100, asset: "CASSET" },
      0n, // nothing left in the vault
    );

    expect(await run(db, c)).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(c.vault.liquidate).not.toHaveBeenCalled();
    expect(updated).toContainEqual({ table: schema.creditLine, set: { status: "liquidating" } });
    expect(inserted).toHaveLength(1);
  });

  it("records an error and books nothing when a submission fails", async () => {
    const { db, inserted } = makeDb(fixtures([{ toState: "Liquidation", createdAt: longAgo() }]));
    const c = clients({ state: "Liquidation", priceStatus: "Ok" }, { status: "Open", breachLedger: 100, pledgedUnits: 1_500_000_000n, asset: "CASSET" });
    submitMock.mockRejectedValue(new Error("rpc down"));

    const result = await run(db, c);

    expect(result.errors).toEqual([{ id: "line-1", message: "rpc down" }]);
    expect(inserted).toHaveLength(0);
  });

  it("commits all three DB writes or none do when transaction fails on the last write", async () => {
    const { db, inserted, updated } = makeDb(
      fixtures([{ toState: "Liquidation", createdAt: longAgo() }]),
      { throwOnTable: schema.creditLine },
    );
    const c = clients(
      { state: "Liquidation", priceStatus: "Ok" },
      { status: "Open", breachLedger: 100, pledgedUnits: 1_500_000_000n, asset: "CASSET" },
    );

    const result = await run(db, c);

    expect(result.errors).toEqual([
      { id: "line-1", message: "simulated failure updating table" },
    ]);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("leaves exactly one liquidation row for the line on a second run after a simulated crash", async () => {
    const marginEvents = [{ toState: "Liquidation", createdAt: new Date() }];
    const fixs = fixtures(marginEvents);
    fixs.set(schema.liquidation, [
      {
        id: "liq-1",
        creditLineId: "line-1",
        route: "transfer",
        units: "150.0000000",
        txHashes: ["hash-1"],
        completedAt: new Date(),
      },
    ]);

    const { db, inserted, updated } = makeDb(fixs);
    const c = clients(
      { state: "Liquidation", priceStatus: "Ok" },
      { status: "Liquidating", breachLedger: 100, asset: "CASSET" },
      0n,
    );

    const result = await run(db, c);
    expect(result).toEqual({ processed: 1, skipped: 0, errors: [] });
    expect(inserted.filter((i) => i.table === schema.liquidation)).toHaveLength(0);
    expect(updated).toContainEqual({ table: schema.creditLine, set: { status: "liquidating" } });
    expect(fixs.get(schema.liquidation)).toHaveLength(1);
  });
});
