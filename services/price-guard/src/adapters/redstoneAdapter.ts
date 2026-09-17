/**
 * LIVE independent feed adapter — RedStone's SEP-40 feed (PRD §6.4's "Check" source, weight 1).
 * Unlike the issuer NAV adapters, this is an ON-CHAIN CONTRACT READ, not a REST call: SEP-40
 * ("Interoperability Standards: Price Feeds") feed contracts are read via a `lastprice` method,
 * matching the same SEP-40-shaped alias convention this repo's own `PriceGuard.lastprice`
 * (contracts/price-guard/src/lib.rs) uses. Each asset has its own feed contract (per
 * `REDSTONE_FEED_CONTRACT_IDS`), so — unlike `PriceGuard.lastprice(asset: Address)`, which serves
 * many assets from one contract instance and so needs an asset argument — this calls the
 * per-asset feed contract's `lastprice` with NO arguments, matching a single-asset feed contract.
 *
 * NOT live-verified end-to-end: no real RedStone Soroban feed contract address was available in
 * this environment (same caveat as the live issuer adapters) — this is protocol-correct against
 * the documented `simulateRead`-style read path this repo already uses elsewhere
 * (`packages/contract-clients/src/unsigned-tx.ts`), with the on-chain `PriceData` struct shape
 * (`{ price: i128, timestamp: u64 }`) assumed per SEP-40 convention.
 */
import type { NetworkConfig } from "@ballast/network-config";
import { loadNetworkConfig } from "@ballast/network-config";
import { resolveSimulationSource, simulateRead } from "@ballast/contract-clients";
import type { IndependentFeedAdapter } from "./types.js";

interface OnChainPriceData {
  price: bigint;
  timestamp: number | bigint;
}

export class RedstoneAdapter implements IndependentFeedAdapter {
  constructor(
    private readonly feedContractIds: Record<string, string>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async fetchPrice(assetCode: string): Promise<{ value: bigint; ts: number }> {
    const contractId = this.feedContractIds[assetCode];
    if (!contractId) {
      throw new Error(
        `redstoneAdapter: no REDSTONE_FEED_CONTRACT_IDS entry for asset code "${assetCode}" ` +
          `(known: ${Object.keys(this.feedContractIds).join(", ") || "<none configured>"})`,
      );
    }

    const network: NetworkConfig = loadNetworkConfig(this.env);
    const callerPublicKey = resolveSimulationSource(this.env);

    const result = await simulateRead<OnChainPriceData | null>(
      network,
      callerPublicKey,
      contractId,
      "lastprice",
      [],
    );

    if (result == null) {
      throw new Error(
        `redstoneAdapter: "lastprice" returned no data for asset code "${assetCode}" (feed contract ${contractId})`,
      );
    }

    return { value: BigInt(result.price), ts: Number(result.timestamp) };
  }
}

/**
 * Parses `REDSTONE_FEED_CONTRACT_IDS` — a JSON map `assetCode -> feed contract id`, e.g.
 * `{"USDY":"C...","deJTRSY":"C..."}`. Mirrors the JSON-map-env-var parsing style
 * `INSTITUTION_API_KEYS` uses in `services/api/src/config.ts` (try/catch JSON.parse, throw a
 * clear error rather than silently ignoring malformed input).
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
