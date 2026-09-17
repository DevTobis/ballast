import type { CustodyMode } from "./margin.js";

export type AssetStandard = "classic_sac" | "sep57";
export type YieldType = "accumulating" | "distributing";

/** Mirrors the `asset` table (PRD §7). */
export interface AssetConfig {
  id: string;
  code: string;
  issuerG: string;
  /** Issuer registry code (e.g. `"spiko"`, `"etherfuse"`, `"franklin"`) — resolves the
   * `IssuerNavAdapter` in `services/price-guard/src/adapters/registry.ts` by exact match. */
  issuerCode: string;
  contractC: string;
  standard: AssetStandard;
  yieldType: YieldType;
  custodyMode: CustodyMode;
  ccy: string;
  redemptionLagDays: number;
  redemptionDailyCap: bigint;
  navSchedule: string;
  priceBandBps: number;
  dailyMoveBandBps: number;
  haircutBaseBps: number;
  haircutFxBps: number;
  status: string;
}
