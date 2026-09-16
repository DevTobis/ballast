import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("../submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../submit.js")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runRepoUnwindJob } = await import("./repoUnwind.js");

function makeDb(dueTrades: unknown[]) {
  const where = vi.fn().mockResolvedValue(dueTrades);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return { select, update, set, updateWhere } as any;
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

describe("runRepoUnwindJob", () => {
  it("does nothing when no repo trades are due", async () => {
    const db = makeDb([]);
    const repoDvpClient = { unwind: vi.fn() };

    const result = await runRepoUnwindJob(db, repoDvpClient as any, signer as any);

    expect(repoDvpClient.unwind).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 0, errors: [] });
  });

  it("unwinds a due repo trade, submits it, and updates status/leg2Tx on success", async () => {
    const trade = { id: "123456789", status: "settled", maturityAt: new Date(Date.now() - 1000) };
    const db = makeDb([trade]);
    const repoDvpClient = { unwind: vi.fn().mockResolvedValue("unsigned-xdr") };
    submitMock.mockResolvedValue({ hash: "hash-1", status: "SUCCESS" });

    const result = await runRepoUnwindJob(db, repoDvpClient as any, signer as any);

    expect(repoDvpClient.unwind).toHaveBeenCalledWith("GKEEPER", 123456789n);
    expect(signer.sign).toHaveBeenCalledWith("unsigned-xdr");
    expect(submitMock).toHaveBeenCalledWith(
      "http://localhost:8000/soroban/rpc",
      "Standalone Network ; February 2017",
      "signed:unsigned-xdr",
    );
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith({ status: "unwound", leg2Tx: "hash-1" });
    expect(result).toEqual({ processed: 1, skipped: 0, errors: [] });
  });

  it("skips (without erroring) a trade whose id doesn't parse as an on-chain numeric id", async () => {
    const trade = { id: "not-a-numeric-uuid", status: "settled", maturityAt: new Date(Date.now() - 1000) };
    const db = makeDb([trade]);
    const repoDvpClient = { unwind: vi.fn() };

    const result = await runRepoUnwindJob(db, repoDvpClient as any, signer as any);

    expect(repoDvpClient.unwind).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 1, errors: [] });
  });

  it("records an error and keeps going when the client call fails", async () => {
    const trade = { id: "42", status: "settled", maturityAt: new Date(Date.now() - 1000) };
    const db = makeDb([trade]);
    const repoDvpClient = { unwind: vi.fn().mockRejectedValue(new Error("rpc down")) };

    const result = await runRepoUnwindJob(db, repoDvpClient as any, signer as any);

    expect(result.processed).toBe(0);
    expect(result.errors).toEqual([{ id: "42", message: "rpc down" }]);
  });
});
