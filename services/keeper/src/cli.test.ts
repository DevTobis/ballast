import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeeperContext } from "./index.js";
import type { JobResult } from "./jobs/types.js";

const runSingleJob = vi.fn<(name: string, ctx: KeeperContext) => Promise<JobResult>>();
vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index.js")>()),
  runSingleJob: (name: string, ctx: KeeperContext) => runSingleJob(name, ctx),
}));

const { parseCliArgs, runCli } = await import("./cli.js");

function fakeContext(lockHeld = false) {
  const unlock = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const acquire = vi.fn().mockResolvedValue(lockHeld ? null : { unlock, release });
  const endDb = vi.fn().mockResolvedValue(undefined);
  const endSql = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    db: { $client: { end: endDb } },
    rawSql: { end: endSql },
    lockProvider: { acquire },
  } as unknown as KeeperContext;
  return { ctx, acquire, unlock, release, endDb, endSql };
}

describe("parseCliArgs", () => {
  it("accepts the job name with or without the 'run' prefix", () => {
    expect(parseCliArgs(["run", "cure-expiry"])).toEqual({ jobName: "cure-expiry" });
    expect(parseCliArgs(["sync-collateral"])).toEqual({ jobName: "sync-collateral" });
  });

  it("rejects a missing, unknown or extra job name with usage text", () => {
    expect(() => parseCliArgs([])).toThrow("Usage: keeper-cli");
    expect(() => parseCliArgs(["run"])).toThrow("Usage: keeper-cli");
    expect(() => parseCliArgs(["run", "nope"])).toThrow('Unknown job "nope"');
    expect(() => parseCliArgs(["cure-expiry", "balance"])).toThrow("Usage: keeper-cli");
  });

  it("refuses --dry-run, because jobs submit transactions directly", () => {
    expect(() => parseCliArgs(["run", "cure-expiry", "--dry-run"])).toThrow("--dry-run is not supported");
    expect(() => parseCliArgs(["cure-expiry", "--force"])).toThrow('Unknown option "--force"');
  });
});

describe("runCli", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    runSingleJob.mockReset();
  });

  it("returns 1 on a usage error without building a context", async () => {
    const factory = vi.fn();
    expect(await runCli([], factory)).toBe(1);
    expect(factory).not.toHaveBeenCalled();
  });

  it("runs the job under its advisory lock, prints the result and exits 0", async () => {
    const f = fakeContext();
    const result: JobResult = { processed: 2, skipped: 1, errors: [] };
    runSingleJob.mockResolvedValue(result);

    expect(await runCli(["run", "cure-expiry"], async () => f.ctx)).toBe(0);
    expect(f.acquire).toHaveBeenCalledWith("keeper:cure-expiry");
    expect(runSingleJob).toHaveBeenCalledWith("cure-expiry", f.ctx);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(f.unlock).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
    expect(f.endDb).toHaveBeenCalled();
    expect(f.endSql).toHaveBeenCalled();
  });

  it("exits 1 when any row errored", async () => {
    const f = fakeContext();
    runSingleJob.mockResolvedValue({ processed: 1, skipped: 0, errors: [{ id: "7", message: "boom" }] });
    expect(await runCli(["cure-expiry"], async () => f.ctx)).toBe(1);
  });

  it("exits 1 when the job crashes, and still releases the lock and pools", async () => {
    const f = fakeContext();
    runSingleJob.mockRejectedValue(new Error("rpc down"));
    expect(await runCli(["cure-expiry"], async () => f.ctx)).toBe(1);
    expect(f.unlock).toHaveBeenCalled();
    expect(f.endDb).toHaveBeenCalled();
  });

  it("refuses to run when the scheduled keeper holds the job's lock", async () => {
    const f = fakeContext(true);
    expect(await runCli(["cure-expiry"], async () => f.ctx)).toBe(1);
    expect(runSingleJob).not.toHaveBeenCalled();
    expect(f.endDb).toHaveBeenCalled();
  });
});
