import { sql } from "drizzle-orm";
import type { Database } from "@ballast/db";

/**
 * Tail of each party's in-process queue. An entry exists only while that party has a task running
 * or waiting, and is removed by the last task to finish, so the map does not grow with the number
 * of parties ever seen.
 */
const partyQueues = new Map<string, Promise<void>>();

async function runSerially<T>(partyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = partyQueues.get(partyId) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  partyQueues.set(partyId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (partyQueues.get(partyId) === tail) partyQueues.delete(partyId);
  }
}

/**
 * Runs `work` for one party at a time: the count-then-insert that enforces a per-party cap (API
 * keys, webhook subscriptions) cannot interleave with another request for the same party.
 *
 * On Postgres the work runs in a transaction that first takes
 * `pg_advisory_xact_lock(hashtext(partyId))`, which serialises it across API replicas and is
 * released at commit or rollback. Requests within this process are also queued per party, which
 * saves a pooled connection blocking on the lock and is what serialises them against test fakes
 * that have no transactions.
 */
export async function withPartyAdvisoryLock<T>(
  db: Database,
  partyId: string,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return runSerially(partyId, async () => {
    const maybeTx = db as unknown as { transaction?: Database["transaction"] };
    if (typeof maybeTx.transaction !== "function") return work(db);
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${partyId}))`);
      return work(tx as unknown as Database);
    });
  });
}
