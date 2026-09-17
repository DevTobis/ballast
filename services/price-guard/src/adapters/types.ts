/**
 * Adapter interfaces for the two sources Price Guard actually feeds into the median (PRD §6.4:
 * issuer NAV weight 1, independent SEP-40 feed weight 1). The last-redemption-price and
 * DEX/RFQ-monitoring-only inputs from the same table are indexer/monitoring concerns, not this
 * service's adapters.
 */

export interface IssuerNavAdapter {
  /**
   * `sig` is a detached Ed25519 signature (64 bytes) over the canonical message
   * `` `${assetCode}:${ts}:${value}` `` (UTF-8 bytes) — see `../navSignature.ts`. `pipeline.ts`
   * verifies it against the issuer's registered public key (`ISSUER_NAV_PUBLIC_KEYS`) before
   * publishing the NAV on-chain.
   */
  fetchNav(assetCode: string): Promise<{ value: bigint; ts: number; sig: Buffer }>;
}

export interface IndependentFeedAdapter {
  fetchPrice(assetCode: string): Promise<{ value: bigint; ts: number }>;
}
