/**
 * Polls Stellar RPC for CAP-67/contract events and mirrors them into `chain_event` (PRD §6.5,
 * §8 invariant 9 "books match the chain"). This is the raw ingestion layer only — turning these
 * rows into ledger/reconciliation state is `services/ledger`'s job.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { schema, type Database } from "@ballast/db";
import { sql } from "drizzle-orm";
import { createConsoleMetricsSink, type Alerter } from "@ballast/observability";
import type { RpcClient } from "./rpc.js";

const metrics = createConsoleMetricsSink("indexer");

/** How many ledgers to look back on a cold start (no rows in `chain_event` yet). */
const COLD_START_LOOKBACK_LEDGERS = 1000;

/** Events requested per RPC call; a full page means there may be more behind it. */
const PAGE_SIZE = 100;

/** Stellar RPC rejects a `getEvents` filter naming more than this many contracts. */
const MAX_CONTRACT_IDS_PER_FILTER = 5;

/** Approximate ledger close time in seconds on Stellar. */
export const LEDGER_CLOSE_SECONDS = 5;

/** Default threshold (in ledgers) before rpc_lag_high alert is raised (60s / 5s). */
export const DEFAULT_LAG_ALERT_LEDGERS = 12;

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
  scannedUpTo: number;
}

export interface IndexerState {
  lastScannedLedger?: number;
}

export interface LagCheckResult {
  lagLedgers: number;
  isLagging: boolean;
}

/**
 * Computes lag between current RPC tip and the last scanned ledger sequence.
 * During quiet periods when contracts emit no events, lastScannedLedger advances
 * with the chain tip so no false lag alert is raised.
 */
export function computeRpcLag(
  rpcTip: number,
  lastScannedLedger?: number,
  thresholdLedgers: number = DEFAULT_LAG_ALERT_LEDGERS,
): LagCheckResult {
  if (lastScannedLedger === undefined) {
    return { lagLedgers: 0, isLagging: false };
  }
  const lagLedgers = Math.max(0, rpcTip - lastScannedLedger);
  return {
    lagLedgers,
    isLagging: lagLedgers > thresholdLedgers,
  };
}

/**
 * Fetches events for `contractIds` since `cursorLedger + 1` (or the last-ingested ledger, or
 * `latestLedger - 1000` on a cold start) and inserts one `chain_event` row per event.
 */
export async function pollOnce(
  db: Database,
  rpcServer: RpcClient,
  contractIds: string[],
  cursorLedger?: number,
): Promise<PollOnceResult> {
  let startLedger: number;
  if (cursorLedger !== undefined) {
    startLedger = cursorLedger + 1;
  } else {
    const lastIngested = await getLastIngestedLedger(db);
    if (lastIngested !== null) {
      startLedger = lastIngested + 1;
    } else {
      const { sequence } = await rpcServer.getLatestLedger();
      startLedger = Math.max(1, sequence - COLD_START_LOOKBACK_LEDGERS);
    }
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

  metrics.increment("indexer.events_ingested", { count: String(events.length) });
  metrics.gauge("indexer.latest_ledger", latestLedger);

  const scannedUpTo = Math.max(cursorLedger ?? 0, latestLedger);
  return { fromLedger: startLedger, insertedCount: events.length, latestLedger, scannedUpTo };
}

/**
 * Executes a single indexer cycle:
 * 1. Inspects RPC tip and verifies RPC lag against the previous cycle's scanned ledger.
 * 2. Runs `pollOnce` with the in-memory cursor to avoid re-requesting old ledgers on quiet chains.
 * 3. Advances `state.lastScannedLedger` to the newly scanned ledger tip.
 */
export async function runIndexerCycle(
  db: Database,
  rpcServer: RpcClient,
  contractIds: string[],
  state: IndexerState,
  alerter: Alerter,
  lagAlertLedgers: number = DEFAULT_LAG_ALERT_LEDGERS,
): Promise<PollOnceResult> {
  const { sequence: rpcTip } = await rpcServer.getLatestLedger();

  if (state.lastScannedLedger !== undefined) {
    const lag = computeRpcLag(rpcTip, state.lastScannedLedger, lagAlertLedgers);
    if (lag.isLagging) {
      alerter.fire("rpc_lag_high", {
        lagLedgers: lag.lagLedgers,
        latestLedger: rpcTip,
        lastScannedLedger: state.lastScannedLedger,
        lastIngestedFrom: state.lastScannedLedger,
      });
    }
  }

  const result = await pollOnce(db, rpcServer, contractIds, state.lastScannedLedger);
  state.lastScannedLedger = result.scannedUpTo;
  return result;
}
