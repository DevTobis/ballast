import { z } from "zod";

/** Loose numeric-string -> bigint coercion for request bodies (JSON has no bigint literal). */
const bigintish = z.union([z.string(), z.number()]).transform((v) => BigInt(v));
const hexBuffer = z.string().transform((hex) => Buffer.from(hex.replace(/^0x/, ""), "hex"));

export const openCreditLineSchema = z.object({
  lenderId: z.string().uuid(),
  borrowerId: z.string().uuid(),
  loanCcy: z.string(),
  limit: bigintish,
  rateBps: z.number().int().nonnegative(),
  feeBps: z.number().int().nonnegative().default(0),
  cureWindowS: z.number().int().positive(),
  // Passed through to CreditLineClient.open() per its exact spec'd signature — the on-chain
  // credit_line row itself doesn't persist an asset (a line can be backed by multiple pledged
  // assets), so this is not stored on the `credit_line` DB row, only forwarded to the tx builder.
  asset: z.string(),
  agreementHash: hexBuffer,
});

export const createPledgeSchema = z.object({
  assetId: z.string().uuid(),
  units: bigintish,
  custodyMode: z.enum(["escrow", "issuer_lien", "custodian_lien"]),
});

export const createDrawSchema = z.object({
  amount: bigintish,
  to: z.string(),
});

export const createRepaymentSchema = z.object({
  amount: bigintish,
});

export const exitQuoteRequestSchema = z.object({
  assetId: z.string().uuid(),
  units: bigintish,
});

export const exitExecuteSchema = z.object({
  minUsdcOut: bigintish,
  to: z.string(),
});

// Gap: `repo_trade` (unlike `credit_line.contractLineId`) has no column tracking the on-chain
// numeric trade id `RepoDvp::propose` returns — it's only known once the indexer picks the
// `TradeProposed` event back up. Until that's wired, the caller (who received it out-of-band, or
// from a client-side simulation) supplies it directly for accept/unwind. Follow-up: add
// `repo_trade.contract_trade_id` and have services/ledger backfill it.
export const repoTradeActionSchema = z.object({
  contractTradeId: bigintish,
});

export const repoProposalSchema = z.object({
  cashLenderId: z.string().uuid(),
  cashBorrowerId: z.string().uuid(),
  assetId: z.string().uuid(),
  units: bigintish,
  cashAmount: bigintish,
  rateBps: z.number().int().nonnegative(),
  kind: z.enum(["intraday", "overnight", "open", "term"]),
  maturityAt: z.string().datetime(),
  agreementHash: hexBuffer,
});
