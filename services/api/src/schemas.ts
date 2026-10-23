import { z } from "zod";

/** Loose numeric-string -> bigint coercion for request bodies (JSON has no bigint literal). */
const bigintish = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return BigInt(v);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expected a valid numeric string or number for integer conversion",
    });
    return z.NEVER;
  }
});
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

export const fundCreditLineSchema = z.object({
  amount: bigintish,
});

export const withdrawSchema = z.object({
  /** `undrawn` returns committed USDC (including repaid principal); `interest` returns repaid interest. */
  kind: z.enum(["undrawn", "interest"]),
  amount: bigintish,
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

// `repo_trade.contract_trade_id` is filled in when the propose transaction settles (see
// `intents.ts`), so accept/unwind normally need no body at all. Passing `contractTradeId`
// explicitly still works, for a trade proposed outside this API.
export const repoTradeActionSchema = z.object({
  contractTradeId: bigintish.optional(),
});

export const repoTopUpSchema = z.object({
  /** RWA units to add to the trade's collateral. */
  units: bigintish,
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
