/** Mirrors PRD §9 `/v1/exit/quotes` and the `exit_quote`/`exit_fill` tables (PRD §7). */
export interface ExitQuote {
  id: string;
  holderId: string;
  assetId: string;
  units: bigint;
  price: bigint;
  spreadBps: number;
  usdcOut: bigint;
  expiresAt: number;
  status: "open" | "filled" | "expired" | "cancelled";
}

export interface ExitFill {
  id: string;
  quoteId: string;
  txHash: string;
  payoutRoute: "direct" | "anchor_hop";
  payoutMemo: string | null;
}
