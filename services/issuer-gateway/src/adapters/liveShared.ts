/**
 * Shared HTTP helpers for the "live" issuer adapters (spikoAdapter.ts, etherfuseAdapter.ts,
 * franklinAdapter.ts). Not part of the `IssuerAdapter` contract itself — just plumbing so the
 * three live adapters don't each reimplement the same fetch/error-handling boilerplate.
 */

/**
 * Fails fast (matches `packages/network-config`'s `loadNetworkConfig` convention: a missing
 * required config value throws immediately with a clear message, rather than the adapter silently
 * making requests against an empty base URL or with no auth).
 */
export function requireLiveConfig(
  issuerName: string,
  baseUrl: string,
  apiKey: string,
): { baseUrl: string; apiKey: string } {
  const missing: string[] = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (missing.length > 0) {
    throw new Error(`${issuerName}Adapter: missing required config: ${missing.join(", ")}`);
  }
  return { baseUrl, apiKey };
}

/**
 * Authenticated JSON request to an issuer's bespoke back-office API
 * (`Authorization: Bearer {apiKey}`, `Content-Type: application/json`). Throws an `Error` with the
 * response status and body text included in the message on any non-2xx response.
 */
export async function issuerApiRequest<T>(method: string, url: string, apiKey: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`issuer API request failed: ${method} ${url} -> ${res.status} ${res.statusText}: ${text}`);
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** The Stellar SEP-8 "Regulated Assets" approval-server response shape. */
export type Sep8ApprovalResponse =
  | { status: "success"; tx: string }
  | { status: "revised"; tx: string; message: string }
  | { status: "rejected"; error: string }
  | { status: "pending"; timeout: number };

export interface Sep8ApprovalResult {
  approved: boolean;
  approvedTxXdr?: string;
  reason?: string;
  pending?: { retryAfterS: number };
}

/** Maps a SEP-8 approval-server response onto `IssuerAdapter.requestSep8Approval`'s return shape. */
export function mapSep8Response(response: Sep8ApprovalResponse): Sep8ApprovalResult {
  switch (response.status) {
    case "success":
      return { approved: true, approvedTxXdr: response.tx };
    case "revised":
      return { approved: false, approvedTxXdr: response.tx, reason: response.message };
    case "rejected":
      return { approved: false, reason: response.error };
    case "pending":
      return { approved: false, pending: { retryAfterS: response.timeout } };
  }
}

/**
 * `POST {approvalServerUrl}` with JSON body `{ tx: "<base64 XDR>" }`, per the real, documented
 * SEP-8 "Regulated Assets" approval-server protocol. The response always communicates outcome via
 * a `status` field in the JSON body (never via HTTP status alone), so this parses the body
 * regardless of `res.ok`.
 */
export async function requestSep8ApprovalHttp(approvalServerUrl: string, txXdr: string): Promise<Sep8ApprovalResult> {
  const res = await fetch(approvalServerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx: txXdr }),
  });

  const body = (await res.json()) as Sep8ApprovalResponse;
  return mapSep8Response(body);
}
