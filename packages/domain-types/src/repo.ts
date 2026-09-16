/** Mirrors the `repo_trade`/`repo_margin_call` tables (PRD §7). */
export type RepoKind = "intraday" | "overnight" | "open" | "term";

export interface RepoTrade {
  id: string;
  cashLenderId: string;
  cashBorrowerId: string;
  assetId: string;
  units: bigint;
  cashAmount: bigint;
  rateBps: number;
  kind: RepoKind;
  startLedger: number;
  maturityAt: number;
  agreementHash: string;
  status: "proposed" | "settled" | "unwound" | "defaulted";
  leg1Tx: string | null;
  leg2Tx: string | null;
}

export interface RepoMarginCall {
  id: string;
  tradeId: string;
  amount: bigint;
  ccy: string;
  dueAt: number;
  curedAt: number | null;
}
