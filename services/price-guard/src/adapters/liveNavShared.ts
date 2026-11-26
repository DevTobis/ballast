/** Shared HTTP helper for the issuer NAV adapters (spikoNavAdapter.ts, etherfuseNavAdapter.ts). */

const REQUEST_TIMEOUT_MS = 10_000;

const ATTEMPTS = 2;

/**
 * GET `url` and parse JSON, failing on a non-2xx status or after `REQUEST_TIMEOUT_MS`. A timeout
 * or network error is retried once (Etherfuse's public endpoint times out intermittently); an
 * HTTP error status is not.
 */
export async function getJson<T>(
  url: string,
  fetchImpl: typeof fetch = fetch,
  adapterLabel = "issuer",
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const singleLine = text.replace(/[\r\n]+/g, " ").trim();
      const truncated = singleLine.length > 200 ? singleLine.slice(0, 200) : singleLine;
      throw new Error(
        `${adapterLabel} NAV request failed: GET ${url} -> ${res.status} ${res.statusText}${truncated ? `: ${truncated}` : ""}`,
      );
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${adapterLabel} NAV request failed to parse JSON from GET ${url}: ${message}`);
    }
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
