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

export interface RpcClient {
  getEvents(args: { startLedger: number; filters: EventFilter[]; limit?: number }): Promise<GetEventsResult>;
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * Wraps `rpc.Server` (the SDK's Soroban RPC client, exposing the JSON-RPC `getEvents` and
 * `getLatestLedger` methods per https://developers.stellar.org/docs/data/rpc). Only the subset
 * this service needs is surfaced through `RpcClient`.
 */
export function createRpcClient(rpcUrl: string): RpcClient {
  const server = new rpc.Server(rpcUrl);

  return {
    async getEvents({ startLedger, filters, limit }) {
      const response = await server.getEvents({
        startLedger,
        filters: filters.map((f) => ({
          type: "contract",
          contractIds: f.contractIds,
          topics: f.topics,
        })),
        limit,
      });

      return {
        latestLedger: response.latestLedger,
        events: response.events.map((e) => ({
          ledger: e.ledger,
          txHash: e.txHash,
          contractId: e.contractId ? e.contractId.toString() : "",
          topic: e.topic,
          value: e.value,
        })),
      };
    },

    async getLatestLedger() {
      const result = await server.getLatestLedger();
      return { sequence: result.sequence };
    },
  };
}
