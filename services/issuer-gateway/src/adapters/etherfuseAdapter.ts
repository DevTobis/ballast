import type { IssuerAdapter } from "../adapter.js";
import { issuerApiRequest, requestSep8ApprovalHttp, requireLiveConfig, type Sep8ApprovalResult } from "./liveShared.js";

/**
 * LIVE adapter for Etherfuse (PRD §5 Phase 1 asset #3 / Phase 4 LATAM bundle: CETES, custodied by
 * Anchorage, with a RedStone feed and an MXN/USD FX haircut). Talks to Etherfuse's actual
 * back-office API (bespoke, no public spec — see the per-method TODOs) and its real SEP-8
 * "Regulated Assets" approval server (a documented protocol).
 *
 * PROTOCOL-CORRECT AND READY once real Etherfuse credentials are supplied, but NOT live-verified
 * end-to-end — no real credentials were available in this environment. See
 * `services/issuer-gateway`'s implementation report.
 */
export class EtherfuseAdapter implements IssuerAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sep8ApprovalServerUrl: string;

  constructor(baseUrl: string, apiKey: string, sep8ApprovalServerUrl?: string) {
    const config = requireLiveConfig("Etherfuse", baseUrl, apiKey);
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.sep8ApprovalServerUrl = sep8ApprovalServerUrl || `${this.baseUrl}/sep8`;
  }

  // TODO: confirm against Etherfuse's real API docs once live credentials are available
  async requestAuthorization(assetCode: string, holderAddress: string): Promise<{ approved: boolean; ref: string }> {
    return issuerApiRequest("POST", `${this.baseUrl}/v1/authorizations`, this.apiKey, { assetCode, holderAddress });
  }

  async requestSep8Approval(assetCode: string, txXdr: string): Promise<Sep8ApprovalResult> {
    void assetCode;
    return requestSep8ApprovalHttp(this.sep8ApprovalServerUrl, txXdr);
  }

  // TODO: confirm against Etherfuse's real API docs once live credentials are available
  async requestLienFreeze(assetCode: string, holderAddress: string, units: bigint): Promise<{ lienRef: string }> {
    return issuerApiRequest("POST", `${this.baseUrl}/v1/liens`, this.apiKey, {
      assetCode,
      holderAddress,
      units: units.toString(),
    });
  }

  // TODO: confirm against Etherfuse's real API docs once live credentials are available
  async requestLienRelease(assetCode: string, lienRef: string): Promise<void> {
    await issuerApiRequest<void>("DELETE", `${this.baseUrl}/v1/liens/${encodeURIComponent(lienRef)}`, this.apiKey, {
      assetCode,
    });
  }

  // TODO: confirm against Etherfuse's real API docs once live credentials are available
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
