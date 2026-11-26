import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { simulateReadMock } = vi.hoisted(() => ({ simulateReadMock: vi.fn() }));
vi.mock("@ballast/contract-clients", () => ({
  resolveSimulationSource: () => "GSIMULATION",
  simulateRead: simulateReadMock,
}));

const { SpikoNavAdapter } = await import("./spikoNavAdapter.js");
const { EtherfuseNavAdapter, median } = await import("./etherfuseNavAdapter.js");
const { RedstoneAdapter, rescalePrice } = await import("./redstoneAdapter.js");
const { getJson } = await import("./liveNavShared.js");
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

  it("throws clear error naming adapter, asset and field when required fields are missing", async () => {
    const valid = fixture("spiko-ustbl-latest.json");

    // Missing amount
    const noAmount = { ...valid, amount: undefined };
    await expect(new SpikoNavAdapter(undefined, fetchReturning(noAmount)).fetchNav("USTBL")).rejects.toThrow(
      'spikoNavAdapter: missing or invalid field "amount" for USTBL',
    );

    // Missing amount.value
    const noValue = { ...valid, amount: { currency: "USD" } };
    await expect(new SpikoNavAdapter(undefined, fetchReturning(noValue)).fetchNav("USTBL")).rejects.toThrow(
      'spikoNavAdapter: missing or invalid field "amount.value" for USTBL',
    );

    // Missing amount.currency
    const noCurrency = { ...valid, amount: { value: "1.00" } };
    await expect(new SpikoNavAdapter(undefined, fetchReturning(noCurrency)).fetchNav("USTBL")).rejects.toThrow(
      'spikoNavAdapter: missing or invalid field "amount.currency" for USTBL',
    );

    // Missing updatedAt
    const noUpdatedAt = { ...valid, updatedAt: "" };
    await expect(new SpikoNavAdapter(undefined, fetchReturning(noUpdatedAt)).fetchNav("USTBL")).rejects.toThrow(
      'spikoNavAdapter: missing or invalid field "updatedAt" for USTBL',
    );
  });
});

describe("liveNavShared", () => {
  it("includes the URL in error when JSON parsing fails", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
      text: async () => "<!DOCTYPE html><html>error</html>",
    })) as unknown as typeof fetch;

    await expect(getJson("https://api.example.com/bad-json", fetchImpl)).rejects.toThrow(
      /issuer NAV request failed to parse JSON from GET https:\/\/api\.example\.com\/bad-json/,
    );
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

  it("computes median timestamp correctly for even, odd, and dirty counts", () => {
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(median([100, 200, 300])).toBe(200);
    expect(median([100, NaN, 200, undefined, 300, 400])).toBe(250);
  });

  it("handles a 4-source response using mean of middle values", async () => {
    const fourSources = {
      token_symbol: "CETES",
      token_cost_in_usd: "0.065766",
      current_time: "2026-10-08T08:13:12Z",
      sources: {
        s1: { token_cost_in_usd: "0.0657", updated_at: 100 },
        s2: { token_cost_in_usd: "0.0657", updated_at: 200 },
        s3: { token_cost_in_usd: "0.0657", updated_at: 300 },
        s4: { token_cost_in_usd: "0.0657", updated_at: 400 },
      },
    };
    const fetchImpl = fetchReturning(fourSources);
    const nav = await new EtherfuseNavAdapter(undefined, fetchImpl).fetchNav("CETES");
    expect(nav.ts).toBe(250);
    expect(nav.value).toBe(657_660n);
  });

  it("throws clear error naming adapter, asset and field when token_cost_in_usd is missing", async () => {
    const noCost = { current_time: "2026-10-08T08:13:12Z" };
    await expect(new EtherfuseNavAdapter(undefined, fetchReturning(noCost)).fetchNav("CETES")).rejects.toThrow(
      'etherfuseNavAdapter: missing or invalid field "token_cost_in_usd" for CETES',
    );
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

  it("memoises decimals per contract id across fetches and refreshes after TTL", async () => {
    const feed = fixture("redstone-cetes-feed.json");
    let decimalsCallCount = 0;
    simulateReadMock.mockImplementation(async (_n, _c, _id, method: string) => {
      if (method === "decimals") {
        decimalsCallCount++;
        return BigInt(feed.decimals);
      }
      return {
        packageTimestamp: BigInt(feed.read_price_data.package_timestamp),
        price: BigInt(feed.read_price_data.price),
        writeTimestamp: BigInt(feed.read_price_data.write_timestamp),
      };
    });

    let mockTime = 1_000_000;
    const adapter = new RedstoneAdapter(
      { CETES: feed.contractId },
      {
        STELLAR_RPC_URL: "https://rpc.example",
        STELLAR_HORIZON_URL: "https://horizon.example",
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      } as NodeJS.ProcessEnv,
      {
        decimalsTtlMs: 60_000,
        now: () => mockTime,
      },
    );

    // Fetch 1: reads read_price_data + decimals
    await adapter.fetchPrice("CETES");
    expect(decimalsCallCount).toBe(1);

    // Fetch 2 (within TTL): reads read_price_data only
    await adapter.fetchPrice("CETES");
    expect(decimalsCallCount).toBe(1);

    // Fetch 3 (within TTL): reads read_price_data only
    await adapter.fetchPrice("CETES");
    expect(decimalsCallCount).toBe(1);
    expect(simulateReadMock).toHaveBeenCalledTimes(4); // 1 decimals + 3 read_price_data

    // Advance time past TTL
    mockTime += 60_001;

    // Fetch 4 (after TTL expired): re-reads decimals
    await adapter.fetchPrice("CETES");
    expect(decimalsCallCount).toBe(2);
    expect(simulateReadMock).toHaveBeenCalledTimes(6); // 2 decimals + 4 read_price_data
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
