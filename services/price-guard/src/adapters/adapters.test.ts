import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { simulateReadMock } = vi.hoisted(() => ({ simulateReadMock: vi.fn() }));
vi.mock("@ballast/contract-clients", () => ({
  resolveSimulationSource: () => "GSIMULATION",
  simulateRead: simulateReadMock,
}));

const { SpikoNavAdapter } = await import("./spikoNavAdapter.js");
const { EtherfuseNavAdapter } = await import("./etherfuseNavAdapter.js");
const { RedstoneAdapter, rescalePrice } = await import("./redstoneAdapter.js");
const { getIssuerNavAdapter, getIndependentFeedAdapter } = await import("./registry.js");

/** Responses recorded from the live endpoints on 2026-10-08 (see ../__fixtures__). */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));

function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("SpikoNavAdapter", () => {
  it("reads the public NAV endpoint and scales to 1e7", async () => {
    const fetchImpl = fetchReturning(fixture("spiko-ustbl-latest.json"));
    const nav = await new SpikoNavAdapter("https://public-api.spiko.io/v0/", fetchImpl).fetchNav("ustbl");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://public-api.spiko.io/v0/net-asset-values/USTBL/latest",
      expect.objectContaining({ method: "GET" }),
    );
    expect(nav.value).toBe(10_984_790n);
    expect(nav.ts).toBe(Math.floor(Date.parse("2026-10-07T14:58:02.763Z") / 1000));
  });

  it("refuses a non-USD share class instead of pricing it in the wrong currency", async () => {
    const fetchImpl = fetchReturning(fixture("spiko-eutbl-latest.json"));
    await expect(new SpikoNavAdapter(undefined, fetchImpl).fetchNav("EUTBL")).rejects.toThrow(/EUR.*FX/);
  });

  it("surfaces an HTTP failure", async () => {
    const fetchImpl = fetchReturning({ error: "nope" }, false, 503);
    await expect(new SpikoNavAdapter(undefined, fetchImpl).fetchNav("USTBL")).rejects.toThrow(/503/);
  });

  it("truncates 5 kB HTML error bodies to 200 characters, strips newlines, and names spiko", async () => {
    const largeHtml = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n" +
      "Cloudflare CDN Error: Server unreachable.\n".repeat(200) +
      "\r\n</body>\r\n</html>";
    expect(largeHtml.length).toBeGreaterThan(5000);

    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => largeHtml,
    })) as unknown as typeof fetch;

    await expect(new SpikoNavAdapter(undefined, fetchImpl).fetchNav("USTBL")).rejects.toSatisfy((err: unknown) => {
      const error = err as Error;
      expect(error.message).toContain("spiko NAV request failed: GET https://public-api.spiko.io/v0/net-asset-values/USTBL/latest -> 502 Bad Gateway:");
      expect(error.message).not.toMatch(/[\r\n]/);
      // Ensure the error snippet after statusText is capped to at most 200 chars
      const prefix = "spiko NAV request failed: GET https://public-api.spiko.io/v0/net-asset-values/USTBL/latest -> 502 Bad Gateway: ";
      const snippet = error.message.slice(prefix.length);
      expect(snippet.length).toBeLessThanOrEqual(200);
      return true;
    });
  });
});

describe("EtherfuseNavAdapter", () => {
  it("uses token_cost_in_usd and the median provider update time", async () => {
    const fetchImpl = fetchReturning(fixture("etherfuse-cetes-cost.json"));
    const nav = await new EtherfuseNavAdapter(undefined, fetchImpl).fetchNav("CETES");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.etherfuse.com/lookup/tokens/cost/CETES",
      expect.objectContaining({ method: "GET" }),
    );
    expect(nav.value).toBe(657_660n);
    expect(nav.ts).toBe(1_791_447_179);
  });

  it("truncates 5 kB HTML error bodies to 200 characters, strips newlines, and names etherfuse", async () => {
    const largeHtml = "<html>\r\n<body>\r\n" + "WAF Blocked Request.\n".repeat(300) + "\r\n</body>\r\n</html>";
    expect(largeHtml.length).toBeGreaterThan(5000);

    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => largeHtml,
    })) as unknown as typeof fetch;

    await expect(new EtherfuseNavAdapter(undefined, fetchImpl).fetchNav("CETES")).rejects.toSatisfy((err: unknown) => {
      const error = err as Error;
      expect(error.message).toContain("etherfuse NAV request failed: GET https://api.etherfuse.com/lookup/tokens/cost/CETES -> 403 Forbidden:");
      expect(error.message).not.toMatch(/[\r\n]/);
      const prefix = "etherfuse NAV request failed: GET https://api.etherfuse.com/lookup/tokens/cost/CETES -> 403 Forbidden: ";
      const snippet = error.message.slice(prefix.length);
      expect(snippet.length).toBeLessThanOrEqual(200);
      return true;
    });
  });
});

describe("RedstoneAdapter", () => {
  beforeEach(() => simulateReadMock.mockReset());

  it("rescales 8-decimal U256 prices to 1e7 and converts ms timestamps to seconds", async () => {
    const feed = fixture("redstone-cetes-feed.json");
    simulateReadMock.mockImplementation(async (_n, _c, _id, method: string) =>
      method === "decimals"
        ? BigInt(feed.decimals)
        : {
            packageTimestamp: BigInt(feed.read_price_data.package_timestamp),
            price: BigInt(feed.read_price_data.price),
            writeTimestamp: BigInt(feed.read_price_data.write_timestamp),
          },
    );
    const env = {
      STELLAR_RPC_URL: "https://rpc.example",
      STELLAR_HORIZON_URL: "https://horizon.example",
      STELLAR_NETWORK: "mainnet",
      STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    } as NodeJS.ProcessEnv;

    const price = await new RedstoneAdapter({ CETES: feed.contractId }, env).fetchPrice("CETES");

    expect(simulateReadMock).toHaveBeenCalledWith(expect.anything(), "GSIMULATION", feed.contractId, "read_price_data", []);
    expect(price).toEqual({ value: 657_500n, ts: 1_791_445_540 });
  });

  it("throws for an asset with no configured feed contract", async () => {
    await expect(new RedstoneAdapter({}, {} as NodeJS.ProcessEnv).fetchPrice("CETES")).rejects.toThrow(
      /REDSTONE_FEED_CONTRACT_IDS/,
    );
  });

  it("rescalePrice handles decimals above and below 7", () => {
    expect(rescalePrice(6_575_000n, 8)).toBe(657_500n);
    expect(rescalePrice(657_500n, 7)).toBe(657_500n);
    expect(rescalePrice(65_750n, 6)).toBe(657_500n);
  });
});

describe("registry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns adapters for spiko and etherfuse, none for franklin, and throws for unknown issuers", () => {
    expect(getIssuerNavAdapter("spiko", {})).toBeDefined();
    expect(getIssuerNavAdapter("Etherfuse", {})).toBeDefined();
    expect(getIssuerNavAdapter("franklin", {})).toBeUndefined();
    expect(() => getIssuerNavAdapter("nobody", {})).toThrow(/no issuer NAV adapter/);
  });

  it("queries the issuer under the mapped symbol when ISSUER_NAV_SYMBOLS maps the asset code", async () => {
    const fetchMock = fetchReturning(fixture("etherfuse-cetes-cost.json"));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = getIssuerNavAdapter("etherfuse", { ISSUER_NAV_SYMBOLS: '{"RWA1":"CETES"}' })!;

    await adapter.fetchNav("RWA1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.etherfuse.com/lookup/tokens/cost/CETES",
      expect.anything(),
    );
  });

  it("refuses to run without any RedStone feed configured", () => {
    expect(() => getIndependentFeedAdapter({})).toThrow(/REDSTONE_FEED_CONTRACT_IDS is not configured/);
  });
});
