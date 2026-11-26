import type { RawSql } from "@ballast/db";

export type KeeperLockScope = "global" | "job";

export function getLockKey(name: string, scope?: KeeperLockScope): string {
  const resolvedScope = scope ?? (process.env.KEEPER_LOCK_SCOPE as KeeperLockScope) ?? "job";
  return resolvedScope === "global" ? "keeper:global" : `keeper:${name}`;
}

export interface LockClient {
  unlock(): Promise<void>;
  release(): void | Promise<void>;
}

export interface LockProvider {
  acquire(lockKey: string): Promise<LockClient | null>;
}

export class PostgresLockProvider implements LockProvider {
  constructor(private sqlClient: RawSql) {}

  async acquire(lockKey: string): Promise<LockClient | null> {
    const reserved = await this.sqlClient.reserve();
    try {
      const [res] = await reserved`SELECT pg_try_advisory_lock(hashtext(${lockKey})) as locked`;
      if (!res?.locked) {
        reserved.release();
        return null;
      }
      return {
        unlock: async () => {
          try {
            await reserved`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
          } catch {
            // ignore
          }
        },
        release: () => {
          reserved.release();
        },
      };
    } catch (err) {
      reserved.release();
      throw err;
    }
  }
}

export interface JobExecutionLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export async function executeJobWithLock(
  name: string,
  fn: () => Promise<{ processed: number; skipped: number; errors: Array<{ id?: string; message: string }> }>,
  lockProvider: LockProvider,
  logger: JobExecutionLogger,
  scope?: KeeperLockScope,
): Promise<boolean> {
  const lockKey = getLockKey(name, scope);
  let lockClient: LockClient | null;
  try {
    lockClient = await lockProvider.acquire(lockKey);
  } catch (err) {
    logger.error({ job: name, lockKey, err }, "keeper: error acquiring advisory lock");
    return false;
  }

  if (!lockClient) {
    logger.info({ job: name, lockKey }, "keeper: advisory lock busy; skipping tick");
    return false;
  }

  logger.info({ job: name, lockKey }, "keeper: job starting");
  try {
    const result = await fn();
    logger.info(
      { job: name, processed: result.processed, skipped: result.skipped, errors: result.errors.length },
      "keeper: job finished",
    );
    for (const e of result.errors) {
      logger.error({ job: name, id: e.id, message: e.message }, "keeper: row failed within job");
    }
    return true;
  } catch (err) {
    logger.error({ job: name, err }, "keeper: job crashed");
    return false;
  } finally {
    try {
      await lockClient.unlock();
    } finally {
      await lockClient.release();
    }
  }
}
