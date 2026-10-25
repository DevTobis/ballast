/**
 * The keeper's job queue. Every job signs with the one keeper account, and a Stellar account's
 * transactions must land in sequence-number order, so jobs run one at a time behind each other.
 *
 * Two guards keep that single lane from jamming:
 * - A job that outlasts its cron interval does not queue again behind itself. Otherwise a long run
 *   (say hourly interest accrual poking every line) makes `sync-collateral` stack up dozens of runs
 *   that then execute back to back, each re-reading every line, while time-critical jobs wait.
 * - Each job runs against a deadline. A stalled RPC or Vault socket can leave a promise that never
 *   settles; without a deadline every later tick, liquidation included, queues behind it forever.
 */
export interface QueueLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface JobQueueOptions {
  /** A job still running after this long is abandoned so the queue can move on. */
  timeoutMs: number;
  logger: QueueLogger;
  /** Called once per abandoned job, e.g. to fire an alert. */
  onTimeout?: (name: string) => void;
}

export interface JobQueue {
  /** Queues `fn` unless a job of this name is already queued or running. Resolves when it settles. */
  run(name: string, fn: () => Promise<unknown>): Promise<void>;
  /** Resolves once everything queued so far has settled. */
  idle(): Promise<void>;
  /** How many ticks were dropped because the previous run of that job was still in progress. */
  skippedCount(): number;
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const { timeoutMs, logger, onTimeout } = options;
  let tail: Promise<void> = Promise.resolve();
  const inFlight = new Set<string>();
  let skipped = 0;

  async function withDeadline(name: string, work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const winner = await Promise.race([work.then(() => "done" as const), deadline]);
      if (winner === "timeout") {
        logger.error({ job: name, timeoutMs }, "keeper: job exceeded its deadline, abandoning it so the queue can move on");
        onTimeout?.(name);
        // The abandoned promise may still settle later; a rejection must not become unhandled.
        work.catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    run(name, fn) {
      if (inFlight.has(name)) {
        skipped++;
        logger.warn({ job: name, skipped }, "keeper: skipped, previous run still in progress");
        return Promise.resolve();
      }
      inFlight.add(name);
      const result = tail.then(async () => {
        try {
          await withDeadline(name, fn());
        } finally {
          inFlight.delete(name);
        }
      });
      // The lane itself must never end up rejected: a job that throws would otherwise make every
      // later `.then` skip its callback and silently stop all jobs. The caller still sees the error.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    idle: () => tail,
    skippedCount: () => skipped,
  };
}
