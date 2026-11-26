import { describe, expect, it, vi } from "vitest";
import { createGuardedRunner, shouldRunOnStart, type CycleLogger } from "./cycleGuard.js";

describe("cycleGuard", () => {
  describe("shouldRunOnStart", () => {
    it("returns true by default when unset", () => {
      expect(shouldRunOnStart({})).toBe(true);
    });

    it("returns true when explicitly set to true or any value other than false", () => {
      expect(shouldRunOnStart({ PRICE_GUARD_RUN_ON_START: "true" })).toBe(true);
      expect(shouldRunOnStart({ PRICE_GUARD_RUN_ON_START: "1" })).toBe(true);
    });

    it("returns false when set to false", () => {
      expect(shouldRunOnStart({ PRICE_GUARD_RUN_ON_START: "false" })).toBe(false);
    });
  });

  describe("createGuardedRunner", () => {
    it("runs the provided cycle function", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const runner = createGuardedRunner(fn);

      await runner();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("prevents concurrent execution when a cycle is in-flight", async () => {
      let resolveFirst: (() => void) | undefined;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const fn = vi.fn().mockReturnValueOnce(firstPromise).mockResolvedValue(undefined);
      const logger: CycleLogger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const runner = createGuardedRunner(fn, logger);

      // Trigger first execution (stays pending)
      const p1 = runner();
      expect(fn).toHaveBeenCalledTimes(1);

      // Trigger second execution while first is in-flight
      await runner();
      // Should not call fn again
      expect(fn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("price-guard: cycle already running; skipping");

      // Resolve first execution
      resolveFirst!();
      await p1;

      // Now that first is complete, subsequent execution should work
      await runner();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("catches errors without crashing and resets the running flag", async () => {
      const error = new Error("cycle failed abruptly");
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
      const logger: CycleLogger = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const runner = createGuardedRunner(fn, logger);

      // Should not throw
      await expect(runner()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith({ err: error }, "price-guard: cycle failed");

      // Running flag is reset, next run succeeds
      await expect(runner()).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
