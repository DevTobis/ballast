import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("../submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../submit.js")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runSyncCollateralJob } = await import("./syncCollateral.js");

function makeDb(creditLines: unknown[], pledgesByLine: Record<string, unknown[]>) {
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (table === schema.creditLine) {
        return { where: vi.fn().mockResolvedValue(creditLines) };
      }
      if (table === schema.pledge) {
        // `and(eq(creditLineId, x), eq(status, "active"))` — the fake just needs to return the
        // right bucket per call; tests only ever query one line's pledges per call.
        return { where: vi.fn().mockImplementation(() => Promise.resolve(currentPledges())) };
      }
      throw new Error(`unexpected table in test fake: ${String(table)}`);
    },
  }));
  let cursor = 0;
  const lineIds = Object.keys(pledgesByLine);
  function currentPledges() {
    const id = lineIds[cursor];
    cursor++;
    return pledgesByLine[id] ?? [];
  }
  return { select } as any;
}

const signer = {
  publicKey: vi.fn().mockReturnValue("GKEEPER"),
  sign: vi.fn().mockImplementation(async (xdr: string) => `signed:${xdr}`),
};

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({ hash: "hash-1", status: "SUCCESS" });
  process.env.STELLAR_RPC_URL = "http://localhost:8000/soroban/rpc";
  process.env.STELLAR_HORIZON_URL = "http://localhost:8000";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
});

describe("runSyncCollateralJob", () => {
  it("does nothing when there are no open credit lines", async () => {
    const db = makeDb([], {});
    const creditLineClient = { syncCollateral: vi.fn() };

    const result = await runSyncCollateralJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.syncCollateral).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 0, errors: [] });
  });

  it("sums active pledge units per line and pushes the total on-chain", async () => {
    const lines = [{ id: "line-1", contractLineId: "1" }];
    const pledges = {
      "line-1": [
        { units: "600.0000000", status: "active" },
        { units: "400.0000000", status: "active" },
      ],
    };
    const db = makeDb(lines, pledges);
    const creditLineClient = { syncCollateral: vi.fn().mockResolvedValue("unsigned-xdr") };

    const result = await runSyncCollateralJob(db, creditLineClient as any, signer as any);

    // 600 + 400 = 1000.0000000 units, scaled 7 decimals -> 10_000_000_000n
    expect(creditLineClient.syncCollateral).toHaveBeenCalledWith("GKEEPER", 1n, 10_000_000_000n);
    expect(result).toEqual({ processed: 1, skipped: 0, errors: [] });
  });

  it("skips lines with no on-chain contract_line_id yet", async () => {
    const lines = [{ id: "line-1", contractLineId: null }];
    const db = makeDb(lines, {});
    const creditLineClient = { syncCollateral: vi.fn() };

    const result = await runSyncCollateralJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.syncCollateral).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 1, errors: [] });
  });

  it("records an error and keeps going when the client call fails", async () => {
    const lines = [{ id: "line-1", contractLineId: "1" }];
    const db = makeDb(lines, { "line-1": [] });
    const creditLineClient = { syncCollateral: vi.fn().mockRejectedValue(new Error("simulation failed")) };

    const result = await runSyncCollateralJob(db, creditLineClient as any, signer as any);

    expect(result.processed).toBe(0);
    expect(result.errors).toEqual([{ id: "line-1", message: "simulation failed" }]);
  });
});
