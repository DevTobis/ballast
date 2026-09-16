/**
 * Mirrors `ballast-common::price` (contracts/common/src/price.rs). Keep in sync by hand — there
 * is no codegen bridge yet, so a change on one side needs the matching edit here.
 */

/** Fixed-point scale for on-chain values: 7 decimal places, the Stellar classic-asset convention. */
export const PRICE_SCALE = 10_000_000n;

export type PriceStatus = "Ok" | "Degraded" | "Halted";

export interface PriceSourceReading {
  name: string;
  value: bigint;
  observedAt: number;
  stale: boolean;
}

export interface GuardedPrice {
  asset: string;
  value: bigint;
  status: PriceStatus;
  ts: number;
  sources: PriceSourceReading[];
}

export function isUsableForNewRisk(price: Pick<GuardedPrice, "status">): boolean {
  return price.status === "Ok";
}

export function isUsableForLiquidation(price: Pick<GuardedPrice, "status">): boolean {
  return price.status === "Ok";
}
