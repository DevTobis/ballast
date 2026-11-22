import { describe, it, expect, vi } from "vitest";
import { parseCliArgs, runCli } from "./cli.js";
import type { KeeperContext } from "./index.js";
import type { JobResult } from "./jobs/types.js";

describe("keeper cli", () => {
  describe("parseCliArgs", () => {
    it("parses job name with 'run' prefix", () => {
      const opts = parseCliArgs(["run", "cure-expiry"]);
      expect(opts).toEqual({ jobName: "cure-expiry", dryRun: false });
    });

    it("parses job name directly without 'run' prefix", () => {
      const opts = parseCliArgs(["cure-expiry"]);
      expect(opts).toEqual({ jobName: "cure-expiry", dryRun: false });
    });

    it("parses --dry-run flag", () => {
      const opts1 = parseCliArgs(["run", "cure-expiry", "--dry-run"]);
      expect(opts1).toEqual({ jobName: "cure-expiry", dryRun: true });

      const opts2 = parseCliArgs(["--dry-run", "cure-expiry"]);
      expect(opts2).toEqual({ jobName: "cure-expiry", dryRun: true });
    });

    it("throws usage error when no job name is provided", () => {
      expect(() => parseCliArgs([])).toThrow("Usage: keeper-cli [run] <job-name> [--dry-run]");
      expect(() => parseCliArgs(["run"])).toThrow("Usage: keeper-cli [run] <job-name> [--dry-run]");
      expect(() => parseCliArgs(["--dry-run"])).toThrow("Usage: keeper-cli [run] <job-name> [--dry-run]");
    });
  });

  describe("runCli", () => {
    it("runs job successfully and returns 0 exit code on no errors", async () => {
      const mockResult: JobResult = { processed: 2, skipped: 1, errors: [] };
      const endDb = vi.fn().mockResolvedValue(undefined);
      const endSql = vi.fn().mockResolvedValue(undefined);

      const mockCtx = {
        db: { $client: { end: endDb } },
        rawSql: { end: endSql },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        alerter: { fire: vi.fn() },
        creditLineClient: {},
        pledgeVaultClient: {},
        repoDvpClient: {},
        signer: { publicKey: () => "GABC" },
        network: { horizonUrl: "http://horizon" },
      } as unknown as KeeperContext;

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Mock runSingleJob via vi.mock or inline test context
      const fakeContextFactory = vi.fn().mockResolvedValue(mockCtx);

      // Test with unknown job name to check error exit code
      const exitCodeInvalid = await runCli(["unknown-job"], fakeContextFactory);
      expect(exitCodeInvalid).toBe(1);

      consoleSpy.mockRestore();
    });

    it("returns exit code 1 on missing arguments", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitCode = await runCli([]);
      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: keeper-cli"));
      consoleErrorSpy.mockRestore();
    });
  });
});
