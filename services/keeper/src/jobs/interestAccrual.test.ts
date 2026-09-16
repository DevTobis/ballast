import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("../submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../submit.js")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runInterestAccrualJob } = await import("./interestAccrual.js");

function makeDb(openLines: unknown[]) {
  const where = vi.fn().mockResolvedValue(openLines);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as any;
}

const signer = {
  publicKey: vi.fn().mockReturnValue("GKEEPER"),
  sign: vi.fn().mockImplementation(async (xdr: string) => `signed:${xdr}`),
};

beforeEach(() => {
  submitMock.mockReset();
  process.env.STELLAR_RPC_URL = "http://localhost:8000/soroban/rpc";
  process.env.STELLAR_HORIZON_URL = "http://localhost:8000";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
});

describe("runInterestAccrualJob", () => {
  it("does nothing when there are no open credit lines", async () => {
    const db = makeDb([]);
    const creditLineClient = { poke: vi.fn() };

    const result = await runInterestAccrualJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.poke).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 0, errors: [] });
  });

  it("pokes every open line that has an on-chain contract_line_id", async () => {
    const lines = [
      { id: "line-1", contractLineId: "1" },
      { id: "line-2", contractLineId: null }, // not yet opened on-chain
    ];
    const db = makeDb(lines);
    const creditLineClient = { poke: vi.fn().mockResolvedValue("unsigned-xdr") };
    submitMock.mockResolvedValue({ hash: "hash-1", status: "SUCCESS" });

    const result = await runInterestAccrualJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.poke).toHaveBeenCalledTimes(1);
    expect(creditLineClient.poke).toHaveBeenCalledWith(1n);
    expect(result).toEqual({ processed: 1, skipped: 1, errors: [] });
  });

  it("records an error and keeps going when the client call fails", async () => {
    const lines = [{ id: "line-1", contractLineId: "1" }];
    const db = makeDb(lines);
    const creditLineClient = { poke: vi.fn().mockRejectedValue(new Error("simulation failed")) };

    const result = await runInterestAccrualJob(db, creditLineClient as any, signer as any);

    expect(result.processed).toBe(0);
    expect(result.errors).toEqual([{ id: "line-1", message: "simulation failed" }]);
  });
});
