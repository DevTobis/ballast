import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeJobWithLock, getLockKey, PostgresLockProvider, type LockProvider } from "./lock.js";

describe("getLockKey", () => {
  const originalEnv = process.env.KEEPER_LOCK_SCOPE;

  beforeEach(() => {
    delete process.env.KEEPER_LOCK_SCOPE;
  });

  it("defaults to job scope", () => {
    expect(getLockKey("cure-expiry")).toBe("keeper:cure-expiry");
    expect(getLockKey("repo-unwind")).toBe("keeper:repo-unwind");
  });

  it("uses global key when scope is global", () => {
    expect(getLockKey("cure-expiry", "global")).toBe("keeper:global");
    expect(getLockKey("repo-unwind", "global")).toBe("keeper:global");
  });

  it("respects KEEPER_LOCK_SCOPE environment variable", () => {
    process.env.KEEPER_LOCK_SCOPE = "global";
    expect(getLockKey("cure-expiry")).toBe("keeper:global");

    process.env.KEEPER_LOCK_SCOPE = "job";
    expect(getLockKey("cure-expiry")).toBe("keeper:cure-expiry");

    if (originalEnv) {
      process.env.KEEPER_LOCK_SCOPE = originalEnv;
    } else {
      delete process.env.KEEPER_LOCK_SCOPE;
    }
  });
});

describe("PostgresLockProvider", () => {
  it("acquires advisory lock successfully and returns unlock/release handles", async () => {
    const unlockMock = vi.fn().mockResolvedValue([]);
    const releaseMock = vi.fn();
    const reservedMock = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("pg_try_advisory_lock")) {
        return Promise.resolve([{ locked: true }]);
      }
      if (query.includes("pg_advisory_unlock")) {
        return unlockMock();
      }
      return Promise.resolve([]);
    });
    (reservedMock as any).release = releaseMock;

    const sqlClient = {
      reserve: vi.fn().mockResolvedValue(reservedMock),
    };

    const provider = new PostgresLockProvider(sqlClient as any);
    const lock = await provider.acquire("keeper:sync-collateral");

    expect(lock).not.toBeNull();
    expect(sqlClient.reserve).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();

    await lock!.unlock();
    expect(unlockMock).toHaveBeenCalledTimes(1);

    lock!.release();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("returns null and releases reservation when advisory lock is already held", async () => {
    const releaseMock = vi.fn();
    const reservedMock = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("pg_try_advisory_lock")) {
        return Promise.resolve([{ locked: false }]);
      }
      return Promise.resolve([]);
    });
    (reservedMock as any).release = releaseMock;

    const sqlClient = {
      reserve: vi.fn().mockResolvedValue(reservedMock),
    };

    const provider = new PostgresLockProvider(sqlClient as any);
    const lock = await provider.acquire("keeper:sync-collateral");

    expect(lock).toBeNull();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("releases connection and propagates error when lock query throws", async () => {
    const releaseMock = vi.fn();
    const reservedMock = vi.fn().mockRejectedValue(new Error("connection terminated"));
    (reservedMock as any).release = releaseMock;

    const sqlClient = {
      reserve: vi.fn().mockResolvedValue(reservedMock),
    };

    const provider = new PostgresLockProvider(sqlClient as any);
    await expect(provider.acquire("keeper:sync-collateral")).rejects.toThrow("connection terminated");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("executeJobWithLock", () => {
  function makeMockLogger() {
    return {
      info: vi.fn(),
      error: vi.fn(),
    };
  }

  function createInMemoryLockProvider() {
    const heldLocks = new Set<string>();
    return {
      heldLocks,
      acquire: vi.fn().mockImplementation(async (lockKey: string) => {
        if (heldLocks.has(lockKey)) {
          return null;
        }
        heldLocks.add(lockKey);
        let released = false;
        return {
          unlock: vi.fn().mockImplementation(async () => {
            heldLocks.delete(lockKey);
          }),
          release: vi.fn().mockImplementation(() => {
            released = true;
          }),
        };
      }),
    };
  }

  it("executes the job when lock is acquired and unlocks on completion", async () => {
    const provider = createInMemoryLockProvider();
    const logger = makeMockLogger();
    const jobFn = vi.fn().mockResolvedValue({ processed: 2, skipped: 0, errors: [] });

    const executed = await executeJobWithLock("repo-unwind", jobFn, provider, logger);

    expect(executed).toBe(true);
    expect(jobFn).toHaveBeenCalledTimes(1);
    expect(provider.heldLocks.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ job: "repo-unwind", lockKey: "keeper:repo-unwind" }),
      "keeper: job starting",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ job: "repo-unwind", processed: 2, skipped: 0, errors: 0 }),
      "keeper: job finished",
    );
  });

  it("skips tick without executing when another replica holds the lock", async () => {
    const provider = createInMemoryLockProvider();
    const logger1 = makeMockLogger();
    const logger2 = makeMockLogger();

    // Instance 1 holds the lock during an ongoing job
    let finishInstance1Job: (res: any) => void;
    const instance1JobPromise = new Promise((resolve) => {
      finishInstance1Job = resolve;
    });

    const instance1Run = executeJobWithLock("repo-margin", () => instance1JobPromise as any, provider, logger1);

    // Yield to let instance 1 acquire the lock
    await new Promise((r) => setTimeout(r, 10));

    // Instance 2 attempts to run the same job concurrently
    const instance2Fn = vi.fn().mockResolvedValue({ processed: 1, skipped: 0, errors: [] });
    const instance2Executed = await executeJobWithLock("repo-margin", instance2Fn, provider, logger2);

    expect(instance2Executed).toBe(false);
    expect(instance2Fn).not.toHaveBeenCalled();
    expect(logger2.info).toHaveBeenCalledWith(
      expect.objectContaining({ job: "repo-margin", lockKey: "keeper:repo-margin" }),
      "keeper: advisory lock busy; skipping tick",
    );

    // Now instance 1 completes
    finishInstance1Job!({ processed: 5, skipped: 0, errors: [] });
    const instance1Executed = await instance1Run;
    expect(instance1Executed).toBe(true);

    // Next tick can acquire the lock again
    const nextTickExecuted = await executeJobWithLock("repo-margin", instance2Fn, provider, logger2);
    expect(nextTickExecuted).toBe(true);
    expect(instance2Fn).toHaveBeenCalledTimes(1);
  });

  it("releases lock when job function crashes", async () => {
    const provider = createInMemoryLockProvider();
    const logger = makeMockLogger();
    const crashingJob = vi.fn().mockRejectedValue(new Error("unexpected crash"));

    const executed = await executeJobWithLock("interest-accrual", crashingJob, provider, logger);

    expect(executed).toBe(false);
    expect(provider.heldLocks.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: "interest-accrual" }),
      "keeper: job crashed",
    );
  });

  it("handles lock provider acquisition failures gracefully", async () => {
    const failingProvider: LockProvider = {
      acquire: vi.fn().mockRejectedValue(new Error("Postgres connection timeout")),
    };
    const logger = makeMockLogger();
    const jobFn = vi.fn();

    const executed = await executeJobWithLock("repo-unwind", jobFn, failingProvider, logger);

    expect(executed).toBe(false);
    expect(jobFn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: "repo-unwind", lockKey: "keeper:repo-unwind" }),
      "keeper: error acquiring advisory lock",
    );
  });
});
