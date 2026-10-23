/**
 * Thin wrapper around `@stellar/stellar-sdk`'s Soroban RPC client (PRD §6.5: "CAP-67 events and
 * contract events over Stellar RPC"). Keeping this as a seam (rather than calling
 * `rpc.Server` directly from `poller.ts`) makes `pollOnce` easy to unit test with a mock.
 */
import { rpc, xdr } from "@stellar/stellar-sdk";

export interface EventFilter {
  /** Contract addresses (C...) to filter events for. */
  contractIds: string[];
  /** Optional topic filters — each entry is an OR'd list of base64 XDR `ScVal`s, `"*"` wildcard allowed. */
  topics?: string[][];
}

export interface RawChainEvent {
  /** The RPC's paging token for this event; pass the last one back as `cursor` for the next page. */
  id?: string;
  ledger: number;
  txHash: string;
  contractId: string;
  /** Topics, still `ScVal`-typed as returned by the RPC client (decoded by the caller via `scValToNative`). */
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

export interface GetEventsResult {
  events: RawChainEvent[];
  latestLedger: number;
}

export interface GetHealthResult {
  latestLedger: number;
  /** Oldest ledger this RPC still retains events for; `getEvents` rejects a smaller `startLedger`. */
  oldestLedger: number;
  /** How many ledgers of history the RPC keeps, so callers can reason about the next clamp. */
  ledgerRetentionWindow: number;
}

export interface RpcClient {
  getEvents(args: {
    startLedger: number;
    filters: EventFilter[];
    limit?: number;
    /** Resume after this event id instead of from `startLedger` (the RPC accepts one or the other). */
    cursor?: string;
  }): Promise<GetEventsResult>;
  getLatestLedger(): Promise<{ sequence: number }>;
  getHealth(): Promise<GetHealthResult>;
}

/**
 * Retries a flaky RPC call with exponential backoff. Public RPC endpoints drop connections and
 * rate-limit; one failed call should not abandon a whole poll when the next attempt would work.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseDelayMs = 500 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Wraps `rpc.Server` (the SDK's Soroban RPC client, exposing the JSON-RPC `getEvents`,
 * `getLatestLedger` and `getHealth` methods per https://developers.stellar.org/docs/data/rpc).
 * Only the subset this service needs is surfaced through `RpcClient`.
 */
export function createRpcClient(rpcUrl: string): RpcClient {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  return {
    async getEvents({ startLedger, filters, limit, cursor }) {
      const rpcFilters = filters.map((f) => ({
        type: "contract" as const,
        contractIds: f.contractIds,
        topics: f.topics,
      }));
      const response = await withRetry(() =>
        server.getEvents(
          cursor ? { cursor, filters: rpcFilters, limit } : { startLedger, filters: rpcFilters, limit },
        ),
      );

      return {
        latestLedger: response.latestLedger,
        events: response.events.map((e) => ({
          id: e.id,
          ledger: e.ledger,
          txHash: e.txHash,
          contractId: e.contractId ? e.contractId.toString() : "",
          topic: e.topic,
          value: e.value,
        })),
      };
    },

    async getLatestLedger() {
      const result = await withRetry(() => server.getLatestLedger());
      return { sequence: result.sequence };
    },

    async getHealth() {
      const result = await withRetry(() => server.getHealth());
      return {
        latestLedger: result.latestLedger,
        oldestLedger: result.oldestLedger,
        ledgerRetentionWindow: result.ledgerRetentionWindow,
      };
    },
  };
}
