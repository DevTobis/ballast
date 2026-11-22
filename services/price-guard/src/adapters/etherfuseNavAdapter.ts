import type { IssuerNavAdapter } from "./types.js";
import { getJson, trimTrailingSlash } from "./liveNavShared.js";
import { decimalStringToScaled } from "../scaled.js";

export const ETHERFUSE_API = "https://api.etherfuse.com";

/** Shape of `GET /lookup/tokens/cost/{symbol}` (docs.etherfuse.com/price-feeds). Public, no key. */
interface EtherfuseTokenCost {
  token_symbol: string;
  token_cost_in_usd: string;
  current_time: string;
  /** Per FX-provider quotes; `updated_at` is unix seconds. */
  sources?: Record<string, { token_cost_in_usd: string; updated_at: number }>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Etherfuse stablebond price (CETES, USTRY, TESOURO, ...), already converted to USD by Etherfuse.
 * The timestamp is the median of its FX providers' own update times, not the response time, so a
 * stuck upstream cannot look fresh.
 */
export class EtherfuseNavAdapter implements IssuerNavAdapter {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string = ETHERFUSE_API,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = trimTrailingSlash(baseUrl);
  }

  async fetchNav(assetCode: string): Promise<{ value: bigint; ts: number }> {
    const url = `${this.baseUrl}/lookup/tokens/cost/${encodeURIComponent(assetCode.toUpperCase())}`;
    const body = await getJson<EtherfuseTokenCost>(url, this.fetchImpl, "etherfuse");

    const updates = Object.values(body.sources ?? {}).map((s) => s.updated_at);
    const ts = updates.length > 0 ? median(updates) : Math.floor(Date.parse(body.current_time) / 1000);
    if (!Number.isFinite(ts)) {
      throw new Error(`etherfuseNavAdapter: no usable timestamp in response for ${assetCode}`);
    }
    return { value: decimalStringToScaled(body.token_cost_in_usd), ts };
  }
}
