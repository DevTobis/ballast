const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `request to ${path} failed with ${res.status}`);
  }
  return body as T;
}

export interface DevLoginResult {
  token: string;
  partyId: string;
}

export const api = {
  devLogin: (stellarAccount: string) =>
    request<DevLoginResult>("/v1/auth/dev-login", null, {
      method: "POST",
      body: JSON.stringify({ stellarAccount }),
    }),

  assets: (token: string) => request<{ assets: AssetSummary[] }>("/v1/assets", token),

  positions: (token: string, partyId: string) =>
    request<PositionsResult>(`/v1/positions?party=${partyId}`, token),

  creditLine: (token: string, id: string) => request<CreditLineDetail>(`/v1/credit-lines/${id}`, token),

  fund: (token: string, id: string, amount: bigint) =>
    request<{ xdr: string }>(`/v1/credit-lines/${id}/fund`, token, {
      method: "POST",
      body: JSON.stringify({ amount: amount.toString() }),
    }),

  draw: (token: string, id: string, amount: bigint, to: string) =>
    request<{ xdr: string }>(`/v1/credit-lines/${id}/draws`, token, {
      method: "POST",
      body: JSON.stringify({ amount: amount.toString(), to }),
    }),

  repay: (token: string, id: string, amount: bigint) =>
    request<{ xdr: string }>(`/v1/credit-lines/${id}/repayments`, token, {
      method: "POST",
      body: JSON.stringify({ amount: amount.toString() }),
    }),

  pledge: (token: string, id: string, assetId: string, units: bigint, custodyMode: string) =>
    request<{ xdr: string; pledgeId: string }>(`/v1/credit-lines/${id}/pledges`, token, {
      method: "POST",
      body: JSON.stringify({ assetId, units: units.toString(), custodyMode }),
    }),

  releasePledge: (token: string, lineId: string, pledgeId: string) =>
    request<{ xdr: string; projectedLtvBps: number }>(
      `/v1/credit-lines/${lineId}/pledges/${pledgeId}`,
      token,
      { method: "DELETE" },
    ),
};

export interface AssetSummary {
  id: string;
  code: string;
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

export interface PositionsResult {
  party: string;
  creditLines: CreditLineRow[];
  pledges: PledgeRow[];
  exitQuotes: unknown[];
  repoTrades: unknown[];
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
}
