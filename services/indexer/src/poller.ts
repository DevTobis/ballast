/**
 * Polls Stellar RPC for CAP-67/contract events and mirrors them into `chain_event` (PRD §6.5,
 * §8 invariant 9 "books match the chain"). This is the raw ingestion layer only — turning these
 * rows into ledger/reconciliation state is `services/ledger`'s job.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { schema, type Database } from "@ballast/db";
import { sql } from "drizzle-orm";
import { createConsoleMetricsSink } from "@ballast/observability";
import type { RpcClient } from "./rpc.js";

const metrics = createConsoleMetricsSink("indexer");

/** How many ledgers to look back on a cold start (no rows in `chain_event` yet). */
const COLD_START_LOOKBACK_LEDGERS = 1000;

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

  const { events, latestLedger } = await rpcServer.getEvents({
    startLedger,
    filters: [{ contractIds }],
  });

  if (events.length > 0) {
    await db.insert(schema.chainEvent).values(
      events.map((event) => ({
        ledger: event.ledger,
        txHash: event.txHash,
        contract: event.contractId,
        topic: decodeTopicName(event.topic),
        data: toJsonSafe({
          topics: event.topic.slice(1).map((t) => scValToNative(t)),
          value: scValToNative(event.value),
        }),
      })),
    );
  }

  metrics.increment("indexer.events_ingested", { count: String(events.length) });
  metrics.gauge("indexer.latest_ledger", latestLedger);

  return { fromLedger: startLedger, insertedCount: events.length, latestLedger };
}
