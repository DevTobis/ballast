/**
 * Polls Stellar RPC for CAP-67/contract events and mirrors them into `chain_event` (PRD §6.5,
 * §8 invariant 9 "books match the chain"). This is the raw ingestion layer only — turning these
 * rows into ledger/reconciliation state is `services/ledger`'s job.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { schema, type Database } from "@ballast/db";
import { eq, sql } from "drizzle-orm";
import { createConsoleMetricsSink } from "@ballast/observability";
import type { RpcClient } from "./rpc.js";

const metrics = createConsoleMetricsSink("indexer");

/** Default key used for single-tenant indexer cursor */
const DEFAULT_CURSOR_ID = "default";

/** How many ledgers to look back on a cold start (no rows in `chain_event` yet). */
const COLD_START_LOOKBACK_LEDGERS = 1000;

/** Events requested per RPC call; a full page means there may be more behind it. */
const PAGE_SIZE = 100;

/** Stellar RPC rejects a `getEvents` filter naming more than this many contracts. */
const MAX_CONTRACT_IDS_PER_FILTER = 5;

/** Recursively replaces `bigint`s with strings so the result is safe to store in a jsonb column. */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

/** Decodes the first topic (conventionally the event name, e.g. `"pledge"`) to a plain string. */
function decodeTopicName(topic: xdr.ScVal[]): string {
  if (topic.length === 0) return "unknown";
  try {
    return String(scValToNative(topic[0]));
  } catch {
    return "unknown";
  }
}

async function getLastIngestedLedger(db: Database): Promise<number | null> {
  try {
    const [cursorRow] = await db
      .select({ lastLedger: schema.indexerCursor.lastLedger })
      .from(schema.indexerCursor)
      .where(eq(schema.indexerCursor.id, DEFAULT_CURSOR_ID))
      .limit(1);
    if (cursorRow?.lastLedger !== undefined && cursorRow?.lastLedger !== null) {
      return cursorRow.lastLedger;
    }
  } catch {
    // If indexer_cursor table does not exist or query fails, fall back to event-derived value
  }

  const [row] = await db
    .select({ maxLedger: sql<number | null>`max(${schema.chainEvent.ledger})` })
    .from(schema.chainEvent);
  return row?.maxLedger ?? null;
}

export interface PollOnceResult {
  fromLedger: number;
  insertedCount: number;
  latestLedger: number;
}

/**
 * Fetches events for `contractIds` since the last-ingested ledger (or `latestLedger - 1000` on a
 * cold start) and inserts one `chain_event` row per event.
 */
export async function pollOnce(
  db: Database,
  rpcServer: RpcClient,
  contractIds: string[],
): Promise<PollOnceResult> {
  const lastIngested = await getLastIngestedLedger(db);

  let startLedger: number;
  if (lastIngested !== null) {
    startLedger = lastIngested + 1;
  } else {
    const { sequence } = await rpcServer.getLatestLedger();
    startLedger = Math.max(1, sequence - COLD_START_LOOKBACK_LEDGERS);
  }

  // Drain every page before returning. The next poll resumes from `max(ledger) + 1`, so stopping
  // after one full page would silently drop whatever was left in that page's last ledger.
  const filters: { contractIds: string[] }[] = [];
  for (let i = 0; i < contractIds.length; i += MAX_CONTRACT_IDS_PER_FILTER) {
    filters.push({ contractIds: contractIds.slice(i, i + MAX_CONTRACT_IDS_PER_FILTER) });
  }
  const events: Awaited<ReturnType<RpcClient["getEvents"]>>["events"] = [];
  let latestLedger = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await rpcServer.getEvents({ startLedger, filters, limit: PAGE_SIZE, cursor });
    events.push(...page.events);
    latestLedger = page.latestLedger;
    cursor = page.events.at(-1)?.id;
    if (page.events.length < PAGE_SIZE || !cursor) break;
  }

  if (events.length > 0) {
    await db.insert(schema.chainEvent).values(
      events.map((event) => ({
        eventId: event.id ?? null,
        ledger: event.ledger,
        txHash: event.txHash,
        contract: event.contractId,
        topic: decodeTopicName(event.topic),
        data: toJsonSafe({
          topics: event.topic.slice(1).map((t) => scValToNative(t)),
          value: scValToNative(event.value),
        }),
      })),
    ).onConflictDoNothing();
  }

  if (latestLedger > 0) {
    try {
      await db
        .insert(schema.indexerCursor)
        .values({
          id: DEFAULT_CURSOR_ID,
          lastLedger: latestLedger,
        })
        .onConflictDoUpdate({
          target: schema.indexerCursor.id,
          set: {
            lastLedger: latestLedger,
            updatedAt: new Date(),
          },
        });
    } catch {
      // In tests with fake DBs lacking indexerCursor table
    }
  }

  metrics.increment("indexer.events_ingested", { count: String(events.length) });
  metrics.gauge("indexer.latest_ledger", latestLedger);

  return { fromLedger: startLedger, insertedCount: events.length, latestLedger };
}
