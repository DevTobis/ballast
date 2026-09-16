/** Mirrors `ballast-common::margin` (contracts/common/src/margin.rs) and PRD §5 Phase 1. */

export type MarginState = "Healthy" | "Warning" | "MarginCall" | "Liquidation";

export interface MarginThresholds {
  warningBps: number;
  marginCallBps: number;
  liquidationBps: number;
}

export function classifyMargin(ltvBps: number, thresholds: MarginThresholds): MarginState {
  if (ltvBps >= thresholds.liquidationBps) return "Liquidation";
  if (ltvBps >= thresholds.marginCallBps) return "MarginCall";
  if (ltvBps >= thresholds.warningBps) return "Warning";
  return "Healthy";
}

/** PRD §8 `LiquidationRoute`: issuer redemption or transfer in kind first, RFQ sale second, AMM never. */
export type LiquidationRoute = "redeem" | "transfer" | "rfq";

/** PRD §6.3 custody modes. */
export type CustodyMode = "escrow" | "issuer_lien" | "custodian_lien";

/** PRD §6.2 `PauseScope`. */
export type PauseScope = "Pledges" | "Draws" | "Exits" | "Repos" | "All";
