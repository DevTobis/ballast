import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

const { fireSpy, simulateReadMock } = vi.hoisted(() => ({ fireSpy: vi.fn(), simulateReadMock: vi.fn() }));

vi.mock("@ballast/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/observability")>();
  return { ...actual, createConsoleAlerter: () => ({ fire: fireSpy }) };
});
vi.mock("@ballast/contract-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/contract-clients")>();
  return { ...actual, resolveSimulationSource: () => "GSIMULATION", simulateRead: simulateReadMock };
});

const { runPriceUpdateCycle } = await import("./pipeline.js");
const { createRawSecretSigner } = await import("@ballast/operator-signing");
const { verifyNavSignature } = await import("./navSignature.js");
const { attestorPublicKeyBase64 } = await import("./navAttestor.js");
type AssetConfig = import("@ballast/domain-types").AssetConfig;

/** Responses recorded from the live endpoints on 2026-10-08 (see ./__fixtures__). */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
const redstoneCetes = fixture("redstone-cetes-feed.json");

const TEST_ENV = {
  STELLAR_RPC_URL: "https://rpc.example",
  STELLAR_HORIZON_URL: "https://horizon.example",
  STELLAR_NETWORK: "mainnet",
  STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
  REDSTONE_FEED_CONTRACT_IDS: JSON.stringify({ CETES: redstoneCetes.contractId }),
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: "", json: async () => body, text: async () => JSON.stringify(body) };
}

/** Routes the issuer HTTP calls to the recorded responses; everything else is a 404. */
function stubIssuerHttp(overrides: Record<string, ReturnType<typeof jsonResponse>> = {}) {
  const routes: Record<string, ReturnType<typeof jsonResponse>> = {
    "https://api.etherfuse.com/lookup/tokens/cost/CETES": jsonResponse(fixture("etherfuse-cetes-cost.json")),
    "https://public-api.spiko.io/v0/net-asset-values/USTBL/latest": jsonResponse(fixture("spiko-ustbl-latest.json")),
    ...overrides,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => routes[url] ?? jsonResponse({}, 404)));
}

function stubRedstone() {
  simulateReadMock.mockImplementation(async (_n, _c, _id, method: string) =>
    method === "decimals"
      ? BigInt(redstoneCetes.decimals)
      : {
          packageTimestamp: BigInt(redstoneCetes.read_price_data.package_timestamp),
          price: BigInt(redstoneCetes.read_price_data.price),
          writeTimestamp: BigInt(redstoneCetes.read_price_data.write_timestamp),
        },
  );
}

function makeDb() {
  // Drizzle's `values()` is awaitable and also chainable with `.onConflictDoNothing()`.
  const values = vi.fn(() => Object.assign(Promise.resolve(undefined), { onConflictDoNothing: () => Promise.resolve(undefined) }));
  const insert = vi.fn(() => ({ values }));
  return { insert, values };
}

function makeAsset(overrides: Partial<AssetConfig> = {}): AssetConfig {
  return {
    id: "asset-1",
    code: "CETES",
    issuerG: "GISSUER",
    issuerCode: "etherfuse",
    contractC: "CASSETCONTRACT",
    standard: "classic_sac",
    yieldType: "accumulating",
    custodyMode: "escrow",
    ccy: "USD",
    redemptionLagDays: 1,
    redemptionDailyCap: 0n,
    navSchedule: "daily",
    priceBandBps: 50,
    dailyMoveBandBps: 100,
    haircutBaseBps: 200,
    haircutFxBps: 0,
    status: "active",
    ...overrides,
  };
}

function makeClient(guarded: Record<string, unknown> = {}) {
  return {
    publishNav: vi.fn().mockResolvedValue("unsigned-nav-xdr"),
    publishFeed: vi.fn().mockResolvedValue("unsigned-feed-xdr"),
    guardedPrice: vi.fn().mockResolvedValue({
      asset: "CASSETCONTRACT",
      value: 657_660n,
      status: "Ok",
      ts: 1_791_447_179,
      sources: [{ name: "issuer_nav", value: 657_660n, observedAt: 1_791_447_179, stale: false }],
      ...guarded,
    }),
  };
}

const keypair = Keypair.random();
const signer = createRawSecretSigner(keypair.secret(), TEST_ENV.STELLAR_NETWORK_PASSPHRASE!);
const sendSigner = {
  publicKey: () => signer.publicKey(),
  signMessage: (m: Uint8Array) => signer.signMessage(m),
  sign: vi.fn(async (xdr: string) => `signed:${xdr}`),
};

beforeEach(() => {
  fireSpy.mockClear();
  sendSigner.sign.mockClear();
  stubRedstone();
  stubIssuerHttp();
});
afterEach(() => vi.unstubAllGlobals());

describe("runPriceUpdateCycle", () => {
  it("records observations + a snapshot, and publishes an attested NAV and the feed", async () => {
    const db = makeDb();
    const client = makeClient();
    const submit = vi.fn().mockResolvedValue({ hash: "h", status: "SUCCESS" });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [makeAsset()], submit, TEST_ENV);

    // 2 price_observation rows + 1 price_snapshot row
    expect(db.insert).toHaveBeenCalledTimes(3);
    expect(db.values).toHaveBeenNthCalledWith(1, expect.objectContaining({ source: "issuer_nav", value: "0.0657660" }));
    expect(db.values).toHaveBeenNthCalledWith(2, expect.objectContaining({ source: "redstone", value: "0.0657500" }));
    expect(db.values).toHaveBeenNthCalledWith(3, expect.objectContaining({ assetId: "asset-1", status: "Ok" }));

    // The NAV signature is made by the publisher key and verifies over the canonical message.
    const [, , code, value, ts, sig] = client.publishNav.mock.calls[0];
    expect(code).toBe("CETES");
    expect(value).toBe(657_660n);
    expect(ts).toBe(1_791_447_179);
    expect(verifyNavSignature(code, ts, value, sig, attestorPublicKeyBase64(sendSigner as any))).toBe(true);

    expect(client.publishFeed).toHaveBeenCalledWith(
      keypair.publicKey(),
      "CASSETCONTRACT",
      "redstone",
      657_500n,
      1_791_445_540,
    );
    expect(submit).toHaveBeenCalledTimes(2);
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it("still publishes the feed and alerts when the issuer NAV request fails", async () => {
    stubIssuerHttp({ "https://api.etherfuse.com/lookup/tokens/cost/CETES": jsonResponse({}, 503) });
    const db = makeDb();
    const client = makeClient({ status: "Degraded" });
    const submit = vi.fn().mockResolvedValue({ hash: "h", status: "SUCCESS" });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [makeAsset()], submit, TEST_ENV);

    expect(client.publishNav).not.toHaveBeenCalled();
    expect(client.publishFeed).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledWith("price_degraded", expect.objectContaining({ reason: expect.stringContaining("issuer NAV fetch failed") }));
    expect(fireSpy).toHaveBeenCalledWith("price_degraded", expect.objectContaining({ status: "Degraded" }));
  });

  it("still publishes the feed and records a snapshot when the NAV submit fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb();
    const client = makeClient();
    const submit = vi.fn(async (xdr: string) => {
      if (xdr === "signed:unsigned-nav-xdr") throw new Error("tx failed on-chain");
      return { hash: "h", status: "SUCCESS" };
    });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [makeAsset()], submit as any, TEST_ENV);

    expect(client.publishFeed).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("signed:unsigned-feed-xdr");
    expect(client.guardedPrice).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenLastCalledWith(expect.objectContaining({ assetId: "asset-1", status: "Ok" }));
    expect(fireSpy).toHaveBeenCalledWith(
      "price_degraded",
      expect.objectContaining({ code: "CETES", source: "issuer NAV", reason: expect.stringContaining("tx failed on-chain") }),
    );
  });

  it("still publishes the NAV and alerts naming the feed when the feed submit fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb();
    const client = makeClient();
    const submit = vi.fn(async (xdr: string) => {
      if (xdr === "signed:unsigned-feed-xdr") throw new Error("simulation reverted");
      return { hash: "h", status: "SUCCESS" };
    });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [makeAsset()], submit as any, TEST_ENV);

    expect(client.publishNav).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("signed:unsigned-nav-xdr");
    expect(db.values).toHaveBeenLastCalledWith(expect.objectContaining({ assetId: "asset-1", status: "Ok" }));
    expect(fireSpy).toHaveBeenCalledWith(
      "price_degraded",
      expect.objectContaining({ code: "CETES", source: "RedStone feed", reason: expect.stringContaining("simulation reverted") }),
    );
  });

  it("publishes only the feed for an issuer with no NAV API (franklin)", async () => {
    const db = makeDb();
    const client = makeClient({ status: "Degraded" });
    const submit = vi.fn().mockResolvedValue({ hash: "h", status: "SUCCESS" });
    const benji = makeAsset({ id: "asset-benji", code: "CETES", issuerCode: "franklin" });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [benji], submit, TEST_ENV);

    expect(client.publishNav).not.toHaveBeenCalled();
    expect(client.publishFeed).toHaveBeenCalledTimes(1);
  });

  it("fires price_halted when the contract reports Halted", async () => {
    const db = makeDb();
    const client = makeClient({ status: "Halted" });
    const submit = vi.fn().mockResolvedValue({ hash: "h", status: "SUCCESS" });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [makeAsset()], submit, TEST_ENV);

    expect(fireSpy).toHaveBeenCalledWith("price_halted", expect.objectContaining({ assetId: "asset-1", status: "Halted" }));
  });

  it("skips an asset with an unknown issuer code without failing the others", async () => {
    const db = makeDb();
    const client = makeClient();
    const submit = vi.fn().mockResolvedValue({ hash: "h", status: "SUCCESS" });
    const bad = makeAsset({ id: "asset-bad", issuerCode: "not-a-real-issuer" });

    await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [bad, makeAsset()], submit, TEST_ENV);

    expect(client.publishNav).toHaveBeenCalledTimes(1);
  });

  it("fails the whole cycle loudly when no RedStone feed is configured", async () => {
    const env = { ...TEST_ENV, REDSTONE_FEED_CONTRACT_IDS: "" } as NodeJS.ProcessEnv;
    await expect(
      runPriceUpdateCycle(makeDb() as any, makeClient() as any, sendSigner as any, [makeAsset()], vi.fn(), env),
    ).rejects.toThrow(/REDSTONE_FEED_CONTRACT_IDS is not configured/);
  });

  describe("shadow run (PRICE_GUARD_PUBLISH=false)", () => {
    const shadowEnv = { ...TEST_ENV, PRICE_GUARD_PUBLISH: "false" } as NodeJS.ProcessEnv;

    it("records real readings but sends nothing on-chain and writes no snapshot", async () => {
      const db = makeDb();
      const client = makeClient();
      const submit = vi.fn();

      await runPriceUpdateCycle(db as any, client as any, sendSigner as any, [makeAsset()], submit, shadowEnv);

      expect(db.insert).toHaveBeenCalledTimes(2);
      expect(client.publishNav).not.toHaveBeenCalled();
      expect(client.publishFeed).not.toHaveBeenCalled();
      expect(client.guardedPrice).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      // 0.065766 vs 0.06575 is ~2 bps, inside the 50 bps band.
      expect(fireSpy).not.toHaveBeenCalled();
    });

    it("alerts when the issuer NAV and the feed disagree by more than the asset's band", async () => {
      const db = makeDb();
      await runPriceUpdateCycle(
        db as any,
        makeClient() as any,
        sendSigner as any,
        [makeAsset({ priceBandBps: 1 })],
        vi.fn(),
        shadowEnv,
      );

      expect(fireSpy).toHaveBeenCalledWith(
        "price_degraded",
        expect.objectContaining({ reason: expect.stringContaining("disagree by 2 bps") }),
      );
    });
  });
});
