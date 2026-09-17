import type { IssuerAdapter } from "../adapter.js";
import { issuerApiRequest, requestSep8ApprovalHttp, requireLiveConfig, type Sep8ApprovalResult } from "./liveShared.js";

/**
 * LIVE adapter for Spiko (PRD §5 Phase 1 asset #1 — an EU/US T-bill MMF, the largest RWA issuer on
 * Stellar at ~$1.55B). Talks to Spiko's actual back-office API (bespoke, no public spec — see the
 * per-method TODOs) and its real SEP-8 "Regulated Assets" approval server (a documented protocol).
 *
 * PROTOCOL-CORRECT AND READY once real Spiko credentials are supplied, but NOT live-verified
 * end-to-end — no real credentials were available in this environment. See
 * `services/issuer-gateway`'s implementation report.
 */
export class SpikoAdapter implements IssuerAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sep8ApprovalServerUrl: string;

  constructor(baseUrl: string, apiKey: string, sep8ApprovalServerUrl?: string) {
    const config = requireLiveConfig("Spiko", baseUrl, apiKey);
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.sep8ApprovalServerUrl = sep8ApprovalServerUrl || `${this.baseUrl}/sep8`;
  }

  // TODO: confirm against Spiko's real API docs once live credentials are available
  async requestAuthorization(assetCode: string, holderAddress: string): Promise<{ approved: boolean; ref: string }> {
    return issuerApiRequest("POST", `${this.baseUrl}/v1/authorizations`, this.apiKey, { assetCode, holderAddress });
  }

  async requestSep8Approval(assetCode: string, txXdr: string): Promise<Sep8ApprovalResult> {
    void assetCode;
    return requestSep8ApprovalHttp(this.sep8ApprovalServerUrl, txXdr);
  }

  // TODO: confirm against Spiko's real API docs once live credentials are available
  async requestLienFreeze(assetCode: string, holderAddress: string, units: bigint): Promise<{ lienRef: string }> {
    return issuerApiRequest("POST", `${this.baseUrl}/v1/liens`, this.apiKey, {
      assetCode,
      holderAddress,
      units: units.toString(),
    });
  }

  // TODO: confirm against Spiko's real API docs once live credentials are available
  async requestLienRelease(assetCode: string, lienRef: string): Promise<void> {
    await issuerApiRequest<void>("DELETE", `${this.baseUrl}/v1/liens/${encodeURIComponent(lienRef)}`, this.apiKey, {
      assetCode,
    });
  }

  // TODO: confirm against Spiko's real API docs once live credentials are available
  async requestRedemption(
    assetCode: string,
    units: bigint,
    destination: string,
  ): Promise<{ redemptionRef: string; expectedSettlementAt: number }> {
    return issuerApiRequest("POST", `${this.baseUrl}/v1/redemptions`, this.apiKey, {
      assetCode,
      units: units.toString(),
      destination,
    });
  }
}
