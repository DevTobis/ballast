import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));

vi.mock("../submit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../submit.js")>();
  return { ...actual, submitSignedTx: submitMock };
});

const { runCureExpiryJob } = await import("./cureExpiry.js");

/**
 * Queue-based fake DB: each call site (`db.select().from(X).where(...)`, optionally chained with
 * `.orderBy().limit()`) draws the next array off `queue`, in the exact order the job issues them.
 */
function makeDb(queue: unknown[][]) {
  let i = 0;
  const next = () => queue[i++] ?? [];
  const where = vi.fn(() => ({
    then: (resolve: (v: unknown) => void) => resolve(next()),
    orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(next())) })),
    limit: vi.fn(() => Promise.resolve(next())),
  }));
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

describe("runCureExpiryJob", () => {
  it("does nothing when there are no open credit lines", async () => {
    const db = makeDb([[]]); // openLines
    const creditLineClient = { liquidate: vi.fn() };

    const result = await runCureExpiryJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.liquidate).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 0, errors: [] });
  });

  it("skips a line whose cure window hasn't elapsed yet", async () => {
    const line = { id: "line-1", cureWindowS: 24 * 3600, contractLineId: "42" };
    const db = makeDb([
      [line], // openLines
      [{ toState: "MarginCall", createdAt: new Date() }], // latest margin_event, just now
    ]);
    const creditLineClient = { liquidate: vi.fn() };

    const result = await runCureExpiryJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.liquidate).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 1, errors: [] });
  });

  it("liquidates a line whose cure window elapsed with no repayment since", async () => {
    const line = { id: "line-1", cureWindowS: 1, contractLineId: "42" };
    const marginCallAt = new Date(Date.now() - 60_000);
    const db = makeDb([
      [line], // openLines
      [{ toState: "MarginCall", createdAt: marginCallAt }], // latest margin_event
      [], // repayments since (none)
    ]);
    const creditLineClient = { liquidate: vi.fn().mockResolvedValue("unsigned-xdr") };
    submitMock.mockResolvedValue({ hash: "hash-1", status: "SUCCESS" });

    const result = await runCureExpiryJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.liquidate).toHaveBeenCalledWith("GKEEPER", 42n, "transfer");
    expect(submitMock).toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, skipped: 0, errors: [] });
  });

  it("skips a line that was cured by a repayment after the margin call", async () => {
    const line = { id: "line-1", cureWindowS: 1, contractLineId: "42" };
    const marginCallAt = new Date(Date.now() - 60_000);
    const db = makeDb([
      [line],
      [{ toState: "MarginCall", createdAt: marginCallAt }],
      [{ createdAt: new Date() }], // a repayment recorded after the margin call
    ]);
    const creditLineClient = { liquidate: vi.fn() };

    const result = await runCureExpiryJob(db, creditLineClient as any, signer as any);

    expect(creditLineClient.liquidate).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, skipped: 1, errors: [] });
  });
});
