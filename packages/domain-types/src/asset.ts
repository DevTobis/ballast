import type { CustodyMode } from "./margin.js";

export type AssetStandard = "classic_sac" | "sep57";
export type YieldType = "accumulating" | "distributing";

/** Mirrors the `asset` table (PRD §7). */
export interface AssetConfig {
  id: string;
  code: string;
  issuerG: string;
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
