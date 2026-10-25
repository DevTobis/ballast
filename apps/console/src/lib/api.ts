import { notifyUnauthorized } from "./unauthorized.ts";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // Only with a body: Fastify rejects a JSON content-type on an empty one (e.g. DELETE).
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    notifyUnauthorized();
    throw new ApiError(401, "Your session expired. Log in again.", body);
  }
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? body.message ?? `request to ${path} failed with ${res.status}`, body);
  }
  return body as T;
}

export interface ChallengeResult {
  transaction: string;
}

export interface TokenResult {
  token: string;
  partyId: string;
}

export interface MarketReading {
  value: string;
  observedAt: string;
  ageS: number;
}

export interface Market {
  code: string;
  issuer: string;
  issuerCode: string;
  contract: string;
  ccy: string;
  priceBandBps: number;
  /** Null until the PriceGuard contract has published a price for this asset on-chain. */
  guarded: { value: string; status: string; asOf: string; ageS: number } | null;
  sources: { issuerNav: MarketReading | null; redstone: MarketReading | null };
  sourceCount: number;
  divergenceBps: number | null;
}

export interface MarketsResult {
  network: string;
  priceGuardContract: string | null;
  generatedAt: string;
  markets: Market[];
}

export const api = {
  /** Public, no session: the live price state of every asset. */
  markets: () => request<MarketsResult>("/v1/public/markets", null),

  /** SEP-10 step 1: get a challenge transaction (base64 XDR) to sign with `account`'s own key. */
  challenge: (account: string) =>
    request<ChallengeResult>("/v1/auth/challenge", null, {
      method: "POST",
      body: JSON.stringify({ account }),
    }),

  /** SEP-10 step 2: submit the wallet-signed challenge transaction and get back a session JWT. */
  token: (signedTransaction: string) =>
    request<TokenResult>("/v1/auth/token", null, {
      method: "POST",
      body: JSON.stringify({ transaction: signedTransaction }),
    }),

  /** Hands a wallet-signed envelope back; resolves once the network has a verdict (or `pending`). */
  submitTx: async (token: string, signedXdr: string): Promise<TxResult> => {
    try {
      return await request<TxResult>("/v1/tx/submit", token, {
        method: "POST",
        body: JSON.stringify({ signedXdr }),
      });
    } catch (err) {
      // 422 is "it closed, and failed on-chain" — a result, not a transport error.
      if (err instanceof ApiError && err.status === 422 && err.body) return err.body as TxResult;
      throw err;
    }
  },

  settleTx: (token: string, txHash: string) =>
    request<TxResult>(`/v1/tx/${txHash}/settle`, token, { method: "POST" }),

  partyByAccount: (token: string, account: string) =>
    request<{ partyId: string; legalName: string | null; kind: string }>(
      `/v1/parties/by-account/${account}`,
      token,
    ),

  openCreditLine: (
    token: string,
    args: {
      lenderId: string;
      borrowerId: string;
      loanCcy: string;
      limit: bigint;
      rateBps: number;
      cureWindowS: number;
      asset: string;
    },
  ) =>
    request<BuiltTx & { creditLineId: string }>("/v1/credit-lines", token, {
      method: "POST",
      body: JSON.stringify({
        ...args,
        limit: args.limit.toString(),
        feeBps: 0,
        // No off-chain agreement document is attached from the console yet.
        agreementHash: "00".repeat(32),
      }),
    }),

  exitQuote: (token: string, assetId: string, units: bigint) =>
    request<ExitQuoteResult>("/v1/exit/quotes", token, {
      method: "POST",
      body: JSON.stringify({ assetId, units: units.toString() }),
    }),

  exitExecute: (token: string, quoteId: string, minUsdcOut: bigint, to: string) =>
    request<BuiltTx>(`/v1/exit/quotes/${quoteId}/execute`, token, {
      method: "POST",
      body: JSON.stringify({ minUsdcOut: minUsdcOut.toString(), to }),
    }),

  repoPropose: (
    token: string,
    args: {
      cashLenderId: string;
      cashBorrowerId: string;
      assetId: string;
      units: bigint;
      cashAmount: bigint;
      rateBps: number;
      kind: RepoKind;
      maturityAt: string;
    },
  ) =>
    request<BuiltTx & { tradeId: string }>("/v1/repo/proposals", token, {
      method: "POST",
      body: JSON.stringify({
        ...args,
        units: args.units.toString(),
        cashAmount: args.cashAmount.toString(),
        agreementHash: "00".repeat(32),
      }),
    }),

  repoAccept: (token: string, tradeId: string) =>
    request<BuiltTx>(`/v1/repo/proposals/${tradeId}/accept`, token, { method: "POST" }),

  /** Cash borrower adds collateral to a settled repo (cures a margin call if it is enough). */
  repoTopUp: (token: string, tradeId: string, units: bigint) =>
    request<BuiltTx>(`/v1/repo/trades/${tradeId}/top-ups`, token, {
      method: "POST",
      body: JSON.stringify({ units: units.toString() }),
    }),

  repoUnwind: (token: string, tradeId: string) =>
    request<BuiltTx>(`/v1/repo/trades/${tradeId}/unwind`, token, { method: "POST" }),

  assets: (token: string) => request<{ assets: AssetSummary[] }>("/v1/assets", token),

  positions: (token: string, partyId: string) =>
    request<PositionsResult>(`/v1/positions?party=${partyId}`, token),

  creditLine: (token: string, id: string) => request<CreditLineDetail>(`/v1/credit-lines/${id}`, token),

  fund: (token: string, id: string, amount: bigint) =>
    request<BuiltTx>(`/v1/credit-lines/${id}/fund`, token, {
      method: "POST",
      body: JSON.stringify({ amount: amount.toString() }),
    }),

  /** Lender takes undrawn USDC (incl. repaid principal) or repaid interest back out of a line. */
  withdraw: (token: string, id: string, kind: "undrawn" | "interest", amount: bigint) =>
    request<BuiltTx>(`/v1/credit-lines/${id}/withdrawals`, token, {
      method: "POST",
      body: JSON.stringify({ kind, amount: amount.toString() }),
    }),

  /** Lender books a liquidation's outcome and closes the line. */
  closeLiquidation: (token: string, id: string) =>
    request<BuiltTx>(`/v1/credit-lines/${id}/close-liquidation`, token, { method: "POST" }),

  draw: (token: string, id: string, amount: bigint, to: string) =>
    request<BuiltTx>(`/v1/credit-lines/${id}/draws`, token, {
      method: "POST",
      body: JSON.stringify({ amount: amount.toString(), to }),
    }),

  repay: (token: string, id: string, amount: bigint) =>
    request<BuiltTx>(`/v1/credit-lines/${id}/repayments`, token, {
      method: "POST",
      body: JSON.stringify({ amount: amount.toString() }),
    }),

  pledge: (token: string, id: string, assetId: string, units: bigint, custodyMode: string) =>
    request<BuiltTx & { pledgeId: string }>(`/v1/credit-lines/${id}/pledges`, token, {
      method: "POST",
      body: JSON.stringify({ assetId, units: units.toString(), custodyMode }),
    }),

  releasePledge: (token: string, lineId: string, pledgeId: string) =>
    request<BuiltTx & { projectedLtvBps: number }>(
      `/v1/credit-lines/${lineId}/pledges/${pledgeId}`,
      token,
      { method: "DELETE" },
    ),
};

/** What every state-changing route returns: an unsigned envelope and the hash it will have. */
export interface BuiltTx {
  xdr: string;
  txHash: string;
}

export interface TxResult {
  txHash: string;
  kind: string;
  refId: string | null;
  status: "pending" | "settled" | "failed" | "expired";
  ledger: number | null;
}

export interface AssetSummary {
  id: string;
  code: string;
  contractC: string;
  ccy: string;
  standard: string;
  custodyMode: string;
  haircutBps: number;
  status: string;
  price: { value: string; status: string; asOf: string } | null;
}

export interface CreditLineRow {
  id: string;
  lenderId: string;
  borrowerId: string;
  loanCcy: string;
  limitAmount: string;
  rateBps: number;
  feeBps: number;
  cureWindowS: number;
  status: string;
  contractLineId: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface PledgeRow {
  id: string;
  creditLineId: string;
  assetId: string;
  units: string;
  custodyMode: string;
  status: string;
}

export type RepoKind = "intraday" | "overnight" | "open" | "term";

/** A fresh quote: amounts are 7-decimal-scaled bigint strings (see lib/format.ts). */
export interface ExitQuoteResult {
  id: string;
  assetId: string;
  units: string;
  price: string;
  spreadBps: number;
  usdcOut: string;
  expiresAt: string;
}

/** A stored quote row from `/v1/positions`: amounts are decimal strings. */
export interface ExitQuoteRow {
  id: string;
  assetId: string;
  units: string;
  usdcOut: string;
  spreadBps: number;
  expiresAt: string;
  status: string;
}

export interface RepoTradeRow {
  id: string;
  cashLenderId: string;
  cashBorrowerId: string;
  assetId: string;
  units: string;
  cashAmount: string;
  rateBps: number;
  kind: RepoKind;
  maturityAt: string;
  status: string;
  contractTradeId: string | null;
}

export interface PositionsResult {
  party: string;
  creditLines: CreditLineRow[];
  pledges: PledgeRow[];
  exitQuotes: ExitQuoteRow[];
  repoTrades: RepoTradeRow[];
}

export interface CreditLineDetail {
  id: string;
  lenderId: string;
  borrowerId: string;
  loanCcy: string;
  limit: string;
  drawn: string;
  rateBps: number;
  feeBps: number;
  cureWindowS: number;
  status: string;
  contractLineId: string | null;
  ltvBps: number;
  marginState: "Healthy" | "Warning" | "MarginCall" | "Liquidation";
  /** On-chain figures; null until the line has settled on-chain. */
  funded: string | null;
  /** Principal the lender could withdraw now (funded minus principal out on loan). */
  undrawn: string | null;
  /** Interest repaid and not yet withdrawn. */
  claimableInterest: string | null;
  collateralValue: string | null;
  priceStatus: string | null;
  /** Present once the line has been liquidated; amounts are 7-decimal scaled strings. */
  liquidation: {
    closed: boolean;
    debt: string;
    recovered: string;
    surplus: string;
    shortfall: string;
  } | null;
}
