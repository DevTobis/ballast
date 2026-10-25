import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobQueue } from "./jobQueue.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("job queue deadline", () => {
  it("does not let a job that never resolves stall the next one", async () => {
    const onTimeout = vi.fn();
    const queue = createJobQueue({ timeoutMs: 1_000, logger, onTimeout });
    const next = vi.fn().mockResolvedValue(undefined);

    const stuck = queue.run("sync-collateral", () => new Promise<never>(() => {}));
    const after = queue.run("cure-expiry", next);

    await vi.advanceTimersByTimeAsync(999);
    expect(next).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await Promise.all([stuck, after]);

    expect(onTimeout).toHaveBeenCalledWith("sync-collateral");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: "sync-collateral", timeoutMs: 1_000 }),
      expect.stringContaining("deadline"),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not time out a job that finishes in time", async () => {
    const onTimeout = vi.fn();
    const queue = createJobQueue({ timeoutMs: 1_000, logger, onTimeout });

    const done = queue.run("repo-margin", () => new Promise<void>((resolve) => setTimeout(resolve, 500)));
    await vi.advanceTimersByTimeAsync(500);
    await done;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("swallows a late rejection from an abandoned job", async () => {
    const queue = createJobQueue({ timeoutMs: 1_000, logger });
    let reject!: (err: Error) => void;

    const run = queue.run("repo-unwind", () => new Promise<never>((_, rej) => (reject = rej)));
    await vi.advanceTimersByTimeAsync(1_001);
    await run;

    // No unhandled rejection: the abandoned promise was given a catch.
    expect(() => reject(new Error("late failure"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("job queue one instance per job", () => {
  it("drops a tick while the previous run of the same job is still going", async () => {
    const queue = createJobQueue({ timeoutMs: 60_000, logger });
    const work = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));

    const first = queue.run("sync-collateral", work);
    await queue.run("sync-collateral", work);
    await queue.run("sync-collateral", work);

    expect(queue.skippedCount()).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ job: "sync-collateral" }),
      expect.stringContaining("previous run still in progress"),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await first;

    expect(work).toHaveBeenCalledTimes(1);
  });

  it("accepts the job again once the previous run has finished", async () => {
    const queue = createJobQueue({ timeoutMs: 60_000, logger });
    const work = vi.fn().mockResolvedValue(undefined);

    await queue.run("sync-collateral", work);
    await queue.run("sync-collateral", work);

    expect(work).toHaveBeenCalledTimes(2);
    expect(queue.skippedCount()).toBe(0);
  });

  it("still runs different jobs one after another", async () => {
    const queue = createJobQueue({ timeoutMs: 60_000, logger });
    const order: string[] = [];

    const a = queue.run("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push("a");
    });
    const b = queue.run("b", async () => {
      order.push("b");
    });

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([a, b]);

    expect(order).toEqual(["a", "b"]);
  });

  it("releases the name when a job throws, so the next tick is not skipped forever", async () => {
    const queue = createJobQueue({ timeoutMs: 60_000, logger });

    await expect(queue.run("sync-collateral", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const next = vi.fn().mockResolvedValue(undefined);
    await queue.run("sync-collateral", next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
