import { describe, it, expect, vi } from "vitest";
import { parseBackfillArgs, runBackfillCli } from "./backfillCli.js";

describe("indexer backfillCli", () => {
  describe("parseBackfillArgs", () => {
    it("parses valid --from and --to with default source 'rpc'", () => {
      const opts = parseBackfillArgs(["--from", "100", "--to", "200"]);
      expect(opts).toEqual({ from: 100, to: 200, source: "rpc" });
    });

    it("parses valid --from, --to and explicit --source rpc", () => {
      const opts = parseBackfillArgs(["--from", "50", "--to", "150", "--source", "rpc"]);
      expect(opts).toEqual({ from: 50, to: 150, source: "rpc" });
    });

    it("parses valid --from, --to and explicit --source lake (case-insensitive)", () => {
      const opts = parseBackfillArgs(["--from", "10", "--to", "20", "--source", "LAKE"]);
      expect(opts).toEqual({ from: 10, to: 20, source: "lake" });
    });

    it("accepts a single ledger range where from == to", () => {
      const opts = parseBackfillArgs(["--from", "500", "--to", "500"]);
      expect(opts).toEqual({ from: 500, to: 500, source: "rpc" });
    });

    it("throws usage error if --from is missing", () => {
      expect(() => parseBackfillArgs(["--to", "200"])).toThrow(
        "Missing required arguments: both --from and --to are required",
      );
    });

    it("throws usage error if --to is missing", () => {
      expect(() => parseBackfillArgs(["--from", "100"])).toThrow(
        "Missing required arguments: both --from and --to are required",
      );
    });

    it("throws usage error if --from is not a positive integer", () => {
      expect(() => parseBackfillArgs(["--from", "0", "--to", "100"])).toThrow(
        'Invalid --from value "0": must be a positive integer',
      );
      expect(() => parseBackfillArgs(["--from", "-5", "--to", "100"])).toThrow(
        'Invalid --from value "-5": must be a positive integer',
      );
      expect(() => parseBackfillArgs(["--from", "abc", "--to", "100"])).toThrow(
        'Invalid --from value "abc": must be a positive integer',
      );
    });

    it("throws usage error if --to is not a positive integer", () => {
      expect(() => parseBackfillArgs(["--from", "100", "--to", "0"])).toThrow(
        'Invalid --to value "0": must be a positive integer',
      );
      expect(() => parseBackfillArgs(["--from", "100", "--to", "3.14"])).toThrow(
        'Invalid --to value "3.14": must be a positive integer',
      );
    });

    it("throws error if from > to", () => {
      expect(() => parseBackfillArgs(["--from", "500", "--to", "100"])).toThrow(
        "Invalid range: --from (500) must be less than or equal to --to (100)",
      );
    });

    it("throws error if --source is invalid", () => {
      expect(() => parseBackfillArgs(["--from", "100", "--to", "200", "--source", "s3"])).toThrow(
        "Invalid --source value \"s3\": must be 'rpc' or 'lake'",
      );
    });

    it("throws usage error on --help", () => {
      expect(() => parseBackfillArgs(["--help"])).toThrow("Usage: pnpm backfill");
    });
  });

  describe("runBackfillCli", () => {
    it("prints planned count and exits 0 on valid rpc range", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await runBackfillCli(["--from", "100", "--to", "200"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(
        "Planning backfill of 101 ledgers (100 to 200) from source: rpc",
      );
      logSpy.mockRestore();
    });

    it("reports 'not implemented' clearly and exits 1 when source is lake", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const code = await runBackfillCli(["--from", "10", "--to", "20", "--source", "lake"]);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("not implemented: requires the public Stellar ledger S3 data lake"),
      );

      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("prints usage text and exits 1 on invalid arguments", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const code = await runBackfillCli(["--from", "invalid"]);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: pnpm backfill"));
      errSpy.mockRestore();
    });
  });
});
