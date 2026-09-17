/**
 * Shared HTTP helpers for the "live" issuer NAV adapters (spikoNavAdapter.ts,
 * etherfuseNavAdapter.ts, franklinNavAdapter.ts). Mirrors `services/issuer-gateway/src/adapters/
 * liveShared.ts`'s pattern (native `fetch` + `Authorization: Bearer` + fail-fast config
 * validation) for consistency, hitting each issuer's NAV-specific endpoint instead of its
 * back-office/SEP-8 endpoints.
 */
import { decimalStringToScaled } from "../scaled.js";

/** Fails fast rather than silently making requests against an empty base URL or with no auth. */
export function requireLiveConfig(
  issuerName: string,
  baseUrl: string,
  apiKey: string,
): { baseUrl: string; apiKey: string } {
  const missing: string[] = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (missing.length > 0) {
    throw new Error(`${issuerName}NavAdapter: missing required config: ${missing.join(", ")}`);
  }
  return { baseUrl, apiKey };
}

/**
 * The expected `GET {baseUrl}/v1/nav/{assetCode}` response shape: a decimal NAV string (e.g.
 * `"1.0023000"`), a unix-seconds timestamp, and a base64-encoded detached Ed25519 signature over
 * the canonical message `` `${assetCode}:${ts}:${value}` `` (see `../navSignature.ts`) — the same
 * scheme the mock adapters sign with, so `pipeline.ts`'s verification step doesn't need to know
 * whether it's looking at a mock or a live reading.
 *
 * PROTOCOL SHAPE NOT LIVE-VERIFIED: no real issuer NAV API docs were available in this
 * environment (same caveat as `services/issuer-gateway`'s live adapters) — this is the documented
 * assumption to confirm/adjust once real credentials and API docs are available.
 */
interface IssuerNavResponse {
  value: string;
  ts: number;
  sig: string;
}

/** Authenticated GET to an issuer's NAV endpoint, decoded into `IssuerNavAdapter.fetchNav`'s shape. */
export async function fetchIssuerNav(
  baseUrl: string,
  apiKey: string,
  assetCode: string,
): Promise<{ value: bigint; ts: number; sig: Buffer }> {
  const url = `${baseUrl}/v1/nav/${encodeURIComponent(assetCode)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`issuer NAV request failed: GET ${url} -> ${res.status} ${res.statusText}: ${text}`);
  }

  const body = (await res.json()) as IssuerNavResponse;
  return {
    value: decimalStringToScaled(body.value),
    ts: body.ts,
    sig: Buffer.from(body.sig, "base64"),
  };
}
