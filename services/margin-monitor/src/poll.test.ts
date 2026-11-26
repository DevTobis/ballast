import { describe, expect, it, vi } from "vitest";
import { pollOnce } from "./poll.js";

function makeDb(openLines: unknown[]) {
  const where = vi.fn(() => Promise.resolve(openLines));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, from, where } as any;
}

describe("pollOnce", () => {
  it("skips open lines without a contractLineId", async () => {
    const db = makeDb([
      { id: "line-no-contract", contractLineId: null },
      { id: "line-valid", contractLineId: "123" },
    ]);
    const creditLineClient = {} as any;
    const logger = { info: vi.fn(), error: vi.fn() };
    const recomputeFn = vi.fn().mockResolvedValue({ changed: false });

    await pollOnce(db, creditLineClient, logger as any, recomputeFn);

    expect(recomputeFn).toHaveBeenCalledTimes(1);
    expect(recomputeFn).toHaveBeenCalledWith(db, creditLineClient, {
      id: "line-valid",
      contractLineId: "123",
    });
  });

  it("isolates errors per line so failure on one does not block the next", async () => {
    const db = makeDb([
      { id: "line-1", contractLineId: "101" },
      { id: "line-2", contractLineId: "102" },
    ]);
    const creditLineClient = {} as any;
    const logger = { info: vi.fn(), error: vi.fn() };
    const error = new Error("RPC timeout");
    const recomputeFn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ changed: false });

    await pollOnce(db, creditLineClient, logger as any, recomputeFn);

    expect(recomputeFn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      { err: error, lineId: "line-1" },
      "margin-monitor: recompute failed for line",
    );
  });

  it("logs state transitions when recompute returns changed = true", async () => {
    const db = makeDb([{ id: "line-changed", contractLineId: "201" }]);
    const creditLineClient = {} as any;
    const logger = { info: vi.fn(), error: vi.fn() };
    const recomputeFn = vi.fn().mockResolvedValue({
      changed: true,
      fromState: "Healthy",
      toState: "MarginCall",
      ltvBps: 8500,
    });

    await pollOnce(db, creditLineClient, logger as any, recomputeFn);

    expect(logger.info).toHaveBeenCalledWith(
      { lineId: "line-changed", from: "Healthy", to: "MarginCall", ltvBps: 8500 },
      "margin-monitor: margin state changed",
    );
  });

  it("does not log info when recompute returns changed = false", async () => {
    const db = makeDb([{ id: "line-unchanged", contractLineId: "202" }]);
    const creditLineClient = {} as any;
    const logger = { info: vi.fn(), error: vi.fn() };
    const recomputeFn = vi.fn().mockResolvedValue({
      changed: false,
      fromState: "Healthy",
      toState: "Healthy",
      ltvBps: 5000,
    });

    await pollOnce(db, creditLineClient, logger as any, recomputeFn);

    expect(logger.info).not.toHaveBeenCalled();
  });
});
