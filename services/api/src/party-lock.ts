import { sql } from "drizzle-orm";
import type { Database } from "@ballast/db";

class PartyMutex {
  private queue = Promise.resolve();

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const ticket = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = this.queue.then(() => ticket);
    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

const partyMutexes = new Map<string, PartyMutex>();

function getPartyMutex(partyId: string): PartyMutex {
  let m = partyMutexes.get(partyId);
  if (!m) {
    m = new PartyMutex();
    partyMutexes.set(partyId, m);
  }
  return m;
}

/**
 * Runs a task inside a database transaction guarded by an advisory transaction-level lock
 * (`pg_advisory_xact_lock(hashtext(partyId))`) on Postgres, backed by an in-process mutex
 * per partyId to serialize concurrent requests.
 */
export async function withPartyAdvisoryLock<T>(
  db: Database,
  partyId: string,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  const mutex = getPartyMutex(partyId);
  return mutex.acquire(async () => {
    if (typeof (db as any).transaction === "function") {
      return (db as any).transaction(async (tx: any) => {
        if (typeof tx.execute === "function") {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${partyId}))`);
        }
        return work(tx);
      });
    }

    if (typeof (db as any).execute === "function") {
      await (db as any).execute(sql`SELECT pg_advisory_xact_lock(hashtext(${partyId}))`);
    }
    return work(db);
  });
}
