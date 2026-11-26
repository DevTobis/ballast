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

/**
 * Computes median unix timestamp from provider update times.
 * Filters out null, undefined, NaN, or non-finite entries.
 * For even counts, returns the mean of the two middle values (floored to integer seconds),
 * which is never later than the true median (conservative for a freshness signal).
 * For odd counts, returns the middle element.
 */
export function median(values: (number | undefined | null)[]): number {
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (valid.length === 0) return NaN;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
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
    const body = await getJson<EtherfuseTokenCost>(url, this.fetchImpl);

    if (!body || typeof body !== "object") {
      throw new Error(`etherfuseNavAdapter: invalid response body for ${assetCode}: expected object`);
    }
    if (typeof body.token_cost_in_usd !== "string" || !body.token_cost_in_usd.trim()) {
      throw new Error(`etherfuseNavAdapter: missing or invalid field "token_cost_in_usd" for ${assetCode}`);
    }
    if (body.sources !== undefined && (typeof body.sources !== "object" || body.sources === null)) {
      throw new Error(`etherfuseNavAdapter: missing or invalid field "sources" for ${assetCode}`);
    }
    if (typeof body.current_time !== "string" || !body.current_time.trim()) {
      if (!body.sources || Object.keys(body.sources).length === 0) {
        throw new Error(`etherfuseNavAdapter: missing or invalid field "current_time" for ${assetCode}`);
      }
    }

    const updates = Object.values(body.sources ?? {})
      .map((s) => s?.updated_at)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const med = updates.length > 0 ? median(updates) : NaN;
    const ts = Number.isFinite(med) ? med : Math.floor(Date.parse(body.current_time) / 1000);
    if (!Number.isFinite(ts)) {
      throw new Error(`etherfuseNavAdapter: no usable timestamp in response for ${assetCode}`);
    }
    return { value: decimalStringToScaled(body.token_cost_in_usd), ts };
  }
}
