import type { IssuerNavAdapter } from "./types.js";
import { getJson, trimTrailingSlash } from "./liveNavShared.js";
import { decimalStringToScaled } from "../scaled.js";

export const SPIKO_PUBLIC_API = "https://public-api.spiko.io/v0";

/** Shape of `GET /net-asset-values/{shareClassSymbol}/latest` (docs.spiko.io/developers/public_api). */
interface SpikoLatestNav {
  day: string;
  amount: { value: string; currency: string };
  updatedAt: string;
}

/**
 * Spiko's public NAV API: no auth, NAV published once per business day. The asset code on Stellar
 * is the share-class symbol (USTBL, EUTBL, UKTBL). EUR/GBP share classes need an FX leg that is
 * not wired yet, so they are refused rather than priced at the wrong currency.
 */
export class SpikoNavAdapter implements IssuerNavAdapter {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string = SPIKO_PUBLIC_API,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = trimTrailingSlash(baseUrl);
  }

  async fetchNav(assetCode: string): Promise<{ value: bigint; ts: number }> {
    const url = `${this.baseUrl}/net-asset-values/${encodeURIComponent(assetCode.toUpperCase())}/latest`;
    const body = await getJson<SpikoLatestNav>(url, this.fetchImpl);

    if (!body || typeof body !== "object") {
      throw new Error(`spikoNavAdapter: invalid response body for ${assetCode}: expected object`);
    }
    if (!body.amount || typeof body.amount !== "object") {
      throw new Error(`spikoNavAdapter: missing or invalid field "amount" for ${assetCode}`);
    }
    if (typeof body.amount.value !== "string" || !body.amount.value.trim()) {
      throw new Error(`spikoNavAdapter: missing or invalid field "amount.value" for ${assetCode}`);
    }
    if (typeof body.amount.currency !== "string" || !body.amount.currency.trim()) {
      throw new Error(`spikoNavAdapter: missing or invalid field "amount.currency" for ${assetCode}`);
    }
    if (typeof body.updatedAt !== "string" || !body.updatedAt.trim()) {
      throw new Error(`spikoNavAdapter: missing or invalid field "updatedAt" for ${assetCode}`);
    }

    if (body.amount.currency !== "USD") {
      throw new Error(
        `spikoNavAdapter: ${assetCode} NAV is quoted in ${body.amount.currency}; FX conversion to USD is not configured`,
      );
    }
    const updatedMs = Date.parse(body.updatedAt);
    if (Number.isNaN(updatedMs)) {
      throw new Error(`spikoNavAdapter: unparseable updatedAt "${body.updatedAt}" for ${assetCode}`);
    }
    return { value: decimalStringToScaled(body.amount.value), ts: Math.floor(updatedMs / 1000) };
  }
}
