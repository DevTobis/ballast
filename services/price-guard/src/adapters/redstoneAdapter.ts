/**
 * Independent feed adapter reading RedStone's on-chain price feeds on Stellar (PRD §6.4's "Check"
 * source, weight 1). Each asset has its own feed contract; verified against mainnet on 2026-10-08
 * (CETES, USTRY, TESOURO, BENJI_ETHEREUM_FUNDAMENTAL) to expose:
 *
 *   decimals() -> u64                       (8)
 *   read_price_data() -> PriceData { package_timestamp: u64 (ms), price: U256, write_timestamp: u64 (ms) }
 *
 * The repo prices in 1e7 fixed point and the contracts compare unix-seconds timestamps, so the
 * price is rescaled from the feed's decimals and the timestamp converted from ms to s here.
 */
import { loadNetworkConfig, type NetworkConfig } from "@ballast/network-config";
import { resolveSimulationSource, simulateRead } from "@ballast/contract-clients";
import type { IndependentFeedAdapter } from "./types.js";

const PRICE_SCALE_DECIMALS = 7;

/** `simulateRead` camelCases struct keys, so the contract's `package_timestamp` arrives as `packageTimestamp`. */
interface OnChainPriceData {
  packageTimestamp: number | bigint;
  price: bigint;
  writeTimestamp: number | bigint;
}

/** Rescales a feed price with `decimals` fractional digits to the repo's 1e7 fixed point. */
export function rescalePrice(price: bigint, decimals: number): bigint {
  const shift = decimals - PRICE_SCALE_DECIMALS;
  if (shift === 0) return price;
  if (shift > 0) return price / 10n ** BigInt(shift);
  return price * 10n ** BigInt(-shift);
}

/**
 * RedStone publishes its RWA feeds on mainnet only, so a testnet or local deployment must read
 * them from there: `REDSTONE_RPC_URL` (+ `REDSTONE_NETWORK_PASSPHRASE`) point the oracle read at
 * its own network while everything else keeps using `STELLAR_RPC_URL`.
 */
function oracleNetwork(env: NodeJS.ProcessEnv): NetworkConfig {
  if (!env.REDSTONE_RPC_URL) return loadNetworkConfig(env);
  if (!env.REDSTONE_NETWORK_PASSPHRASE) {
    throw new Error("redstoneAdapter: REDSTONE_RPC_URL is set but REDSTONE_NETWORK_PASSPHRASE is not");
  }
  return {
    network: "mainnet",
    rpcUrl: env.REDSTONE_RPC_URL,
    horizonUrl: "",
    networkPassphrase: env.REDSTONE_NETWORK_PASSPHRASE,
    contracts: {},
  };
}

export const DEFAULT_DECIMALS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedDecimals {
  decimals: number;
  cachedAt: number;
}

export class RedstoneAdapter implements IndependentFeedAdapter {
  private readonly decimalsCache = new Map<string, CachedDecimals>();
  private readonly decimalsTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly feedContractIds: Record<string, string>,
    private readonly env: NodeJS.ProcessEnv = process.env,
    options?: {
      decimalsTtlMs?: number;
      now?: () => number;
    },
  ) {
    this.decimalsTtlMs = options?.decimalsTtlMs ?? DEFAULT_DECIMALS_TTL_MS;
    this.now = options?.now ?? Date.now;
  }

  private async getDecimals(
    network: NetworkConfig,
    caller: string,
    contractId: string,
  ): Promise<number> {
    const cached = this.decimalsCache.get(contractId);
    const now = this.now();
    if (cached && now - cached.cachedAt < this.decimalsTtlMs) {
      return cached.decimals;
    }
    const raw = await simulateRead<bigint | number>(network, caller, contractId, "decimals", []);
    const decimals = Number(raw);
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new Error(`redstoneAdapter: invalid decimals ${decimals} returned for contract ${contractId}`);
    }
    this.decimalsCache.set(contractId, { decimals, cachedAt: now });
    return decimals;
  }

  async fetchPrice(assetCode: string): Promise<{ value: bigint; ts: number }> {
    const contractId = this.feedContractIds[assetCode];
    if (!contractId) {
      throw new Error(
        `redstoneAdapter: no REDSTONE_FEED_CONTRACT_IDS entry for asset code "${assetCode}" ` +
          `(known: ${Object.keys(this.feedContractIds).join(", ") || "<none configured>"})`,
      );
    }

    const network = oracleNetwork(this.env);
    const caller = resolveSimulationSource(this.env);

    const [data, decimals] = await Promise.all([
      simulateRead<OnChainPriceData>(network, caller, contractId, "read_price_data", []),
      this.getDecimals(network, caller, contractId),
    ]);

    return {
      value: rescalePrice(BigInt(data.price), decimals),
      ts: Math.floor(Number(data.packageTimestamp) / 1000),
    };
  }
}

/**
 * Parses `REDSTONE_FEED_CONTRACT_IDS` — a JSON map `assetCode -> feed contract id`. Throws on
 * malformed JSON rather than silently ignoring it.
 */
export function loadRedstoneFeedContractIds(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.REDSTONE_FEED_CONTRACT_IDS) {
    return {};
  }
  try {
    return JSON.parse(env.REDSTONE_FEED_CONTRACT_IDS);
  } catch {
    throw new Error("price-guard: REDSTONE_FEED_CONTRACT_IDS is not valid JSON");
  }
}
