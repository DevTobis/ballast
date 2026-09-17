import type { IssuerNavAdapter } from "./types.js";
import { fetchIssuerNav, requireLiveConfig } from "./liveNavShared.js";

/**
 * LIVE NAV adapter for Spiko. Reuses the same `SPIKO_API_BASE_URL`/`SPIKO_API_KEY` env vars
 * `services/issuer-gateway`'s live `SpikoAdapter` already established (see root `.env.example`),
 * hitting a NAV-specific endpoint (`GET {baseUrl}/v1/nav/{assetCode}`) rather than the back-office
 * lien/redemption endpoints. NOT live-verified end-to-end — see `liveNavShared.ts`'s doc comment.
 */
export class SpikoNavAdapter implements IssuerNavAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    const config = requireLiveConfig("Spiko", baseUrl, apiKey);
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  fetchNav(assetCode: string): Promise<{ value: bigint; ts: number; sig: Buffer }> {
    return fetchIssuerNav(this.baseUrl, this.apiKey, assetCode);
  }
}
