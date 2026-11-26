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
  /** Lender party UUID; stored in `credit_line.lender_id`. */
  lenderId: z.string().uuid(),
  /** Borrower party UUID; stored in `credit_line.borrower_id`. */
  borrowerId: z.string().uuid(),
  /** Loan currency code (e.g. USDC); stored in `credit_line.loan_ccy`. */
  loanCcy: z.string(),
  /** Maximum credit limit as a 7-decimal scaled integer (> 0); stored in `credit_line.limit_amount` and forwarded to contract open(). */
  limit: positiveAmount,
  /** Annual interest rate in basis points (non-negative integer); stored in `credit_line.rate_bps` and forwarded to contract open(). */
  rateBps: z.number().int().nonnegative(),
  /** Annual platform fee in basis points (0-10,000, default 0), accrued on drawn principal alongside interest and paid to the treasury; stored in `credit_line.fee_bps` and forwarded to contract open(). */
  feeBps: z.number().int().nonnegative().max(10_000).default(0),
  /** Margin cure period duration in seconds (positive integer); stored in `credit_line.cure_window_s` and forwarded to contract open(). */
  cureWindowS: z.number().int().positive(),
  /**
   * Collateral asset contract address (C...), passed to `CreditLineClient.open()`. Not stored on the
   * `credit_line` row: a line's collateral is recorded per pledge (`pledge.asset_id`).
   */
  asset: z.string(),
  /** 32-byte hex hash of the off-chain legal credit agreement; stored in `credit_line.agreement_hash` and forwarded to contract open(). */
  agreementHash: hexBuffer,
});

export const createPledgeSchema = z.object({
  /** Collateral asset UUID; stored in `pledge.asset_id`. */
  assetId: z.string().uuid(),
  /** RWA collateral units as a 7-decimal scaled integer (> 0); stored in `pledge.units` and forwarded to contract pledge(). */
  units: positiveAmount,
  /** Collateral custody mode ("escrow", "issuer_lien", or "custodian_lien"); stored in `pledge.custody_mode` and forwarded to contract pledge(). */
  custodyMode: z.enum(["escrow", "issuer_lien", "custodian_lien"]),
});

export const fundCreditLineSchema = z.object({
  /** Principal amount to fund as a 7-decimal scaled integer (> 0); forwarded to contract fund() and recorded in tx intent payload. */
  amount: positiveAmount,
});

export const withdrawSchema = z.object({
  /** `undrawn` returns committed USDC not currently drawn (including repaid principal) via `withdraw_undrawn`; `interest` returns repaid interest via `withdraw_interest`. */
  kind: z.enum(["undrawn", "interest"]),
  /** Amount to withdraw as a 7-decimal scaled integer (> 0); forwarded to contract withdraw() and recorded in tx intent payload. */
  amount: positiveAmount,
});

export const createDrawSchema = z.object({
  /** Draw amount as a 7-decimal scaled integer (> 0); forwarded to contract draw(), and written to `draw.amount` when the transaction settles. */
  amount: positiveAmount,
  /** Stellar account (G...) that receives the drawn USDC; forwarded to contract draw() and kept in the tx intent payload (the `draw` row has no recipient column). */
  to: z.string(),
});

export const createRepaymentSchema = z.object({
  /** Repayment amount as a 7-decimal scaled integer (> 0); forwarded to contract repay(). When it settles, the applied amount is booked as `repayment.interest` and `repayment.principal` (interest first). */
  amount: positiveAmount,
});

export const exitQuoteRequestSchema = z.object({
  /** Asset UUID to exit/liquidate; stored in `exit_quote.asset_id`. */
  assetId: z.string().uuid(),
  /** RWA units to exit as a 7-decimal scaled integer (> 0); stored in `exit_quote.units` and forwarded to exit quote contract call. */
  units: positiveAmount,
});

export const exitExecuteSchema = z.object({
  /** Minimum USDC payout as a 7-decimal scaled integer, forwarded to contract execute(). Optional: omitted means "no worse than the quote"; a value below 99% of the quote (`EXIT_MIN_OUT_FLOOR_BPS` in routes/exit.ts) is refused. */
  minUsdcOut: positiveAmount.optional(),
  /** Destination Stellar account address receiving USDC proceeds; forwarded to contract execute(). */
  to: z.string(),
});

export const repoTradeActionSchema = z.object({
  /**
   * On-chain trade id, forwarded to contract accept_and_settle() / unwind(). Optional:
   * `repo_trade.contract_trade_id` is filled in when the propose transaction settles (see
   * `intents.ts`), so a trade proposed through this API needs no body. Pass it for a trade proposed
   * outside this API.
   */
  contractTradeId: nonNegativeAmount.optional(),
});

export const repoTopUpSchema = z.object({
  /** Additional RWA collateral units as a 7-decimal scaled integer (> 0); forwarded to contract top_up() and recorded in tx intent payload. */
  units: positiveAmount,
});

export const repoProposalSchema = z.object({
  /** Cash lender party UUID; stored in `repo_trade.cash_lender_id`. */
  cashLenderId: z.string().uuid(),
  /** Cash borrower party UUID; stored in `repo_trade.cash_borrower_id`. */
  cashBorrowerId: z.string().uuid(),
  /** Collateral asset UUID; stored in `repo_trade.asset_id`. */
  assetId: z.string().uuid(),
  /** Collateral RWA units as a 7-decimal scaled integer (> 0); stored in `repo_trade.units` and forwarded to contract propose(). */
  units: positiveAmount,
  /** Cash loan amount in USDC as a 7-decimal scaled integer (> 0); stored in `repo_trade.cash_amount` and forwarded to contract propose(). */
  cashAmount: positiveAmount,
  /** Annual repo interest rate in basis points (non-negative integer); stored in `repo_trade.rate_bps` and forwarded to contract propose(). */
  rateBps: z.number().int().nonnegative(),
  /** Repo tenor classification ("intraday", "overnight", "open", "term"); stored in `repo_trade.kind`. */
  kind: z.enum(["intraday", "overnight", "open", "term"]),
  /** Trade maturity ISO-8601 UTC timestamp string; stored in `repo_trade.maturity_at` and forwarded to contract propose() as Unix seconds. */
  maturityAt: z.string().datetime(),
  /** 32-byte hex hash of the repo agreement; stored in `repo_trade.agreement_hash` and forwarded to contract propose(). */
  agreementHash: hexBuffer,
});
