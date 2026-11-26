export interface CycleLogger {
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  info?(obj: Record<string, unknown> | string, msg?: string): void;
  error?(obj: Record<string, unknown> | string, msg?: string): void;
}

/**
 * Wraps an async cycle runner with an in-flight guard.
 * If a cycle is already running, concurrent invocations are skipped.
 * Exceptions inside the cycle are caught and logged so the process does not crash.
 */
export function createGuardedRunner(
  runFn: () => Promise<void>,
  logger?: CycleLogger,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      logger?.warn("price-guard: cycle already running; skipping");
      return;
    }
    running = true;
    try {
      await runFn();
    } catch (err) {
      logger?.error?.({ err }, "price-guard: cycle failed");
    } finally {
      running = false;
    }
  };
}

/**
 * Startup trigger flag: runs by default unless explicitly disabled with "false".
 */
export function shouldRunOnStart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRICE_GUARD_RUN_ON_START !== "false";
}
