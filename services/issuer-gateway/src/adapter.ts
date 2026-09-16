/**
 * One adapter per issuer (PRD §6.5: "issuer-gateway: requests authorisation, SEP-8 approvals,
 * lien freeze and release, redemptions; one adapter per issuer"). This is the seam between
 * Ballast and each RWA issuer's actual (usually bespoke, non-standardized) back office API.
 *
 * Covers PRD §5 Phase 0 (issuer authorisation, SEP-8 approval) and Phase 1 (lien freeze/release
 * for issuer-lien custody mode, redemption on liquidation/exit-desk rebalancing).
 */
export interface IssuerAdapter {
  /** Requests the issuer authorise `holderAddress` to hold `assetCode` (PRD §5 Phase 0). */
  requestAuthorization(
    assetCode: string,
    holderAddress: string,
  ): Promise<{ approved: boolean; ref: string }>;

  /**
   * SEP-8 (Regulated Assets) approval flow: the issuer inspects a proposed transaction and either
   * approves it as-is, returns a revised (issuer-signed) transaction, or rejects it with a reason.
   */
  requestSep8Approval(
    assetCode: string,
    txXdr: string,
  ): Promise<{ approved: boolean; approvedTxXdr?: string; reason?: string }>;

  /**
   * Issuer-lien custody mode (PRD §6.3): the asset stays in the holder's own account, and the
   * issuer places a lien freezing `units` instead of Ballast escrowing the tokens on-chain.
   */
  requestLienFreeze(
    assetCode: string,
    holderAddress: string,
    units: bigint,
  ): Promise<{ lienRef: string }>;

  /** Releases a previously placed lien (e.g. on repayment, or after a cured margin call). */
  requestLienRelease(assetCode: string, lienRef: string): Promise<void>;

  /** Requests the issuer redeem `units` for USDC (or fiat) and pay out to `destination`. */
  requestRedemption(
    assetCode: string,
    units: bigint,
    destination: string,
  ): Promise<{ redemptionRef: string; expectedSettlementAt: number }>;
}
