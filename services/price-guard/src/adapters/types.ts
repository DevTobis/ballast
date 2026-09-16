/**
 * Adapter interfaces for the two sources Price Guard actually feeds into the median (PRD §6.4:
 * issuer NAV weight 1, independent SEP-40 feed weight 1). The last-redemption-price and
 * DEX/RFQ-monitoring-only inputs from the same table are indexer/monitoring concerns, not this
 * service's adapters.
 */

export interface IssuerNavAdapter {
  fetchNav(assetCode: string): Promise<{ value: bigint; ts: number }>;
}

export interface IndependentFeedAdapter {
  fetchPrice(assetCode: string): Promise<{ value: bigint; ts: number }>;
}
