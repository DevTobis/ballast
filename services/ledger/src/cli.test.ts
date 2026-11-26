import { describe, it, expect, vi } from "vitest";
import { runReconcileCli } from "./cli.js";
import type { Database } from "@ballast/db";
import type { ReconciliationReport } from "./reconcile.js";
import cron from "node-cron";

describe("ledger cli", () => {
  it("does not start the cron schedule when imported", async () => {
    vi.resetModules();
    const cronSpy = vi.spyOn(cron, "schedule");
    await import("./cli.js");
    expect(cronSpy).not.toHaveBeenCalled();
    cronSpy.mockRestore();
  });

  it("prints report JSON and returns breaks count", async () => {
    const fakeReport: ReconciliationReport = {
      comparedAssets: 1,
      mismatches: [],
      journalAccountBalances: {},
      scope: { compared: "pledge vs. chain_event net (pledged - released - liquidated)", deferred: [] },
    };

    // Create a mock database with $client
    const fakeDb = {
      $client: { end: vi.fn().mockResolvedValue(undefined) },
      select: vi.fn(),
      insert: vi.fn(),
    } as unknown as Database;

    const reconcile = vi.fn().mockResolvedValue({ breaks: 0, report: fakeReport });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runReconcileCli(fakeDb, reconcile);
    expect(reconcile).toHaveBeenCalledWith(fakeDb);
    expect(result.breaks).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(fakeReport, null, 2));

    consoleLogSpy.mockRestore();
  });

  it("handles non-zero breaks count correctly", async () => {
    const fakeReport: ReconciliationReport = {
      comparedAssets: 1,
      mismatches: [
        {
          assetId: "test-asset",
          code: "TEST",
          pgUnits: "1000",
          chainUnitsImplied: "500",
          diffUnits: "500",
        },
      ],
      journalAccountBalances: {},
      scope: { compared: "pledge vs. chain_event net (pledged - released - liquidated)", deferred: [] },
    };

    const fakeDb = {
      $client: { end: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Database;

    const reconcile = vi.fn().mockResolvedValue({ breaks: 1, report: fakeReport });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runReconcileCli(fakeDb, reconcile);
    expect(reconcile).toHaveBeenCalledWith(fakeDb);
    expect(result.breaks).toBe(1);
    // A caller-supplied database is left open for the caller to close.
    expect((fakeDb as unknown as { $client: { end: ReturnType<typeof vi.fn> } }).$client.end).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });
});
