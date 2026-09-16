/** Mirrors `ballast-common::risk` (contracts/common/src/risk.rs). */

import { PRICE_SCALE } from "./price.js";

export const BPS_DENOMINATOR = 10_000n;

export function collateralValue(units: bigint, guardedPrice: bigint, haircutBps: number): bigint {
  if (haircutBps < 0 || BigInt(haircutBps) > BPS_DENOMINATOR) {
    throw new Error("haircut exceeds 100%");
  }
  const gross = (units * guardedPrice) / PRICE_SCALE;
  return (gross * (BPS_DENOMINATOR - BigInt(haircutBps))) / BPS_DENOMINATOR;
}

export function ltvBps(debt: bigint, collateralValueAmount: bigint): number {
  if (debt <= 0n) return 0;
  if (collateralValueAmount <= 0n) return Number.MAX_SAFE_INTEGER;
  const bps = (debt * BPS_DENOMINATOR) / collateralValueAmount;
  return Number(bps);
}
