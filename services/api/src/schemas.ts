import { z } from "zod";

const DIGITS_ONLY = /^\d+$/;

/** Parses a positive (> 0n) integer amount from a string of digits or a safe non-negative integer. */
export const positiveAmount = z.union([z.string(), z.number()]).transform((v, ctx) => {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expected a safe integer or numeric string; send a string for large values",
      });
      return z.NEVER;
    }
    if (v <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "amount must be positive (> 0)",
      });
      return z.NEVER;
    }
    return BigInt(v);
  }

  if (!DIGITS_ONLY.test(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expected a string of digits only",
    });
    return z.NEVER;
  }

  const parsed = BigInt(v);
  if (parsed <= 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amount must be positive (> 0)",
    });
    return z.NEVER;
  }
  return parsed;
});

/** Parses a non-negative (>= 0n) integer from a string of digits or a safe non-negative integer. */
export const nonNegativeAmount = z.union([z.string(), z.number()]).transform((v, ctx) => {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expected a safe integer or numeric string; send a string for large values",
      });
      return z.NEVER;
    }
    if (v < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "amount must be non-negative (>= 0)",
      });
      return z.NEVER;
    }
    return BigInt(v);
  }

  if (!DIGITS_ONLY.test(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expected a string of digits only",
    });
    return z.NEVER;
  }

  return BigInt(v);
});

/** Loose numeric-string -> bigint coercion for backward-compatibility. */
export const bigintish = nonNegativeAmount;

const hexBuffer = z.string().transform((hex) => Buffer.from(hex.replace(/^0x/, ""), "hex"));

export const openCreditLineSchema = z.object({
  lenderId: z.string().uuid(),
  borrowerId: z.string().uuid(),
  loanCcy: z.string(),
  limit: positiveAmount,
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
  units: positiveAmount,
  custodyMode: z.enum(["escrow", "issuer_lien", "custodian_lien"]),
});

export const fundCreditLineSchema = z.object({
  amount: positiveAmount,
});

export const withdrawSchema = z.object({
  /** `undrawn` returns committed USDC (including repaid principal); `interest` returns repaid interest. */
  kind: z.enum(["undrawn", "interest"]),
  amount: positiveAmount,
});

export const createDrawSchema = z.object({
  amount: positiveAmount,
  to: z.string(),
});

export const createRepaymentSchema = z.object({
  amount: positiveAmount,
});

export const exitQuoteRequestSchema = z.object({
  assetId: z.string().uuid(),
  units: positiveAmount,
});

export const exitExecuteSchema = z.object({
  // Optional: omitted means "no worse than the quote". See `EXIT_MIN_OUT_FLOOR_BPS` in routes/exit.ts.
  minUsdcOut: positiveAmount.optional(),
  to: z.string(),
});

// `repo_trade.contract_trade_id` is filled in when the propose transaction settles (see
// `intents.ts`), so accept/unwind normally need no body at all. Passing `contractTradeId`
// explicitly still works, for a trade proposed outside this API.
export const repoTradeActionSchema = z.object({
  contractTradeId: nonNegativeAmount.optional(),
});

export const repoTopUpSchema = z.object({
  /** RWA units to add to the trade's collateral. */
  units: positiveAmount,
});

export const repoProposalSchema = z.object({
  cashLenderId: z.string().uuid(),
  cashBorrowerId: z.string().uuid(),
  assetId: z.string().uuid(),
  units: positiveAmount,
  cashAmount: positiveAmount,
  rateBps: z.number().int().nonnegative(),
  kind: z.enum(["intraday", "overnight", "open", "term"]),
  maturityAt: z.string().datetime(),
  agreementHash: hexBuffer,
});
