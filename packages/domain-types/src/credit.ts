import type { MarginState } from "./margin.js";

/** Mirrors the `credit_line` table (PRD §7) plus derived view fields from PRD §8 `LtvView`. */
export interface CreditLineView {
  id: string;
  lenderId: string;
  borrowerId: string;
  loanCcy: string;
  limit: bigint;
  drawn: bigint;
  rateBps: number;
  feeBps: number;
  cureWindowS: number;
  status: string;
  contractLineId: string | null;
  ltvBps: number;
  collateralValue: bigint;
  marginState: MarginState;
  priceStatusOk: boolean;
}

export interface PledgePosition {
  id: string;
  creditLineId: string;
  assetId: string;
  units: bigint;
  status: string;
}
