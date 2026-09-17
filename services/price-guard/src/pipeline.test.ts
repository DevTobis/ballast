import { beforeEach, describe, expect, it, vi } from "vitest";

const { fireSpy } = vi.hoisted(() => ({ fireSpy: vi.fn() }));

vi.mock("@ballast/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/observability")>();
  return {
    ...actual,
    createConsoleAlerter: () => ({ fire: fireSpy }),
  };
});

const { runPriceUpdateCycle } = await import("./pipeline.js");
const { MOCK_ISSUER_NAV_PUBLIC_KEY_BASE64 } = await import("./adapters/mockIssuers.js");
type AssetConfig = import("@ballast/domain-types").AssetConfig;

/**
 * `runPriceUpdateCycle` resolves adapters via the registry (`PRICE_GUARD_MODE`, default "mock")
 * and verifies the mock adapters' real Ed25519 signatures against `ISSUER_NAV_PUBLIC_KEYS` — so
 * tests pass this `testEnv` (rather than mutating global `process.env`) to exercise the real
 * verification path instead of a stub.
 */
function makeTestEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ISSUER_NAV_PUBLIC_KEYS: JSON.stringify({
      spiko: MOCK_ISSUER_NAV_PUBLIC_KEY_BASE64,
      etherfuse: MOCK_ISSUER_NAV_PUBLIC_KEY_BASE64,
      franklin: MOCK_ISSUER_NAV_PUBLIC_KEY_BASE64,
    }),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function makeDb() {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return { insert, values };
}

function makeAsset(overrides: Partial<AssetConfig> = {}): AssetConfig {
  return {
    id: "asset-1",
    code: "SPIKO",
    issuerG: "GISSUER",
    issuerCode: "spiko",
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

function makeSigner() {
  return {
    publicKey: vi.fn().mockReturnValue("GPUBLISHER"),
    sign: vi.fn().mockImplementation(async (xdr: string) => `signed:${xdr}`),
  };
}

beforeEach(() => {
  fireSpy.mockClear();
});

describe("runPriceUpdateCycle", () => {
  it("records observations + a snapshot and pushes nav/feed for each asset", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn().mockResolvedValue("unsigned-nav-xdr"),
      publishFeed: vi.fn().mockResolvedValue("unsigned-feed-xdr"),
      guardedPrice: vi.fn().mockResolvedValue({
        asset: "CASSETCONTRACT",
        value: 10_000_000n,
        status: "Ok",
        ts: 1_700_000_000,
        sources: [{ name: "issuer_nav", value: 10_000_000n, observedAt: 1_700_000_000, stale: false }],
      }),
    };
    const signer = makeSigner();
    const submit = vi.fn().mockResolvedValue({ hash: "hash1", status: "SUCCESS" });

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit, makeTestEnv());

    // 2 price_observation rows + 1 price_snapshot row
    expect(db.insert).toHaveBeenCalledTimes(3);
    expect(db.values).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ assetId: "asset-1", status: "Ok" }),
    );

    expect(priceGuardClient.publishNav).toHaveBeenCalledWith(
      "GPUBLISHER",
      "CASSETCONTRACT",
      "SPIKO",
      expect.any(BigInt),
      expect.any(Number),
      expect.any(Buffer),
    );
    expect(priceGuardClient.publishFeed).toHaveBeenCalledWith(
      "GPUBLISHER",
      "CASSETCONTRACT",
      "redstone",
      expect.any(BigInt),
      expect.any(Number),
    );
    expect(priceGuardClient.guardedPrice).toHaveBeenCalledWith("CASSETCONTRACT");

    // Each publish (nav + feed) is signed and submitted once.
    expect(signer.sign).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);

    expect(fireSpy).not.toHaveBeenCalled();
  });

  it("fires a price_degraded alert when the contract reports Degraded", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn().mockResolvedValue("x"),
      publishFeed: vi.fn().mockResolvedValue("y"),
      guardedPrice: vi.fn().mockResolvedValue({
        asset: "CASSETCONTRACT",
        value: 0n,
        status: "Degraded",
        ts: 1_700_000_000,
        sources: [],
      }),
    };
    const signer = makeSigner();
    const submit = vi.fn().mockResolvedValue({ hash: "hash2", status: "SUCCESS" });

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit, makeTestEnv());

    expect(fireSpy).toHaveBeenCalledWith(
      "price_degraded",
      expect.objectContaining({ assetId: "asset-1", status: "Degraded" }),
    );
  });

  it("fires a price_halted alert when the contract reports Halted", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn().mockResolvedValue("x"),
      publishFeed: vi.fn().mockResolvedValue("y"),
      guardedPrice: vi.fn().mockResolvedValue({
        asset: "CASSETCONTRACT",
        value: 11_000_000n,
        status: "Halted",
        ts: 1_700_000_000,
        sources: [],
      }),
    };
    const signer = makeSigner();
    const submit = vi.fn().mockResolvedValue({ hash: "hash3", status: "SUCCESS" });

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit, makeTestEnv());

    expect(fireSpy).toHaveBeenCalledWith(
      "price_halted",
      expect.objectContaining({ assetId: "asset-1", status: "Halted" }),
    );
  });

  it("skips an asset with an unknown issuer code instead of crashing the whole cycle", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn().mockResolvedValue("x"),
      publishFeed: vi.fn().mockResolvedValue("y"),
      guardedPrice: vi.fn().mockResolvedValue({
        asset: "CASSETCONTRACT",
        value: 10_000_000n,
        status: "Ok",
        ts: 1_700_000_000,
        sources: [],
      }),
    };
    const signer = makeSigner();
    const submit = vi.fn().mockResolvedValue({ hash: "hash4", status: "SUCCESS" });

    const badAsset = makeAsset({ id: "asset-bad", code: "UNKNOWN", issuerCode: "not-a-real-issuer" });
    const goodAsset = makeAsset({ id: "asset-good", code: "SPIKO", issuerCode: "spiko" });

    await runPriceUpdateCycle(
      db as any,
      priceGuardClient as any,
      signer as any,
      [badAsset, goodAsset],
      submit,
      makeTestEnv(),
    );

    // Only the good asset's cycle actually published anything.
    expect(priceGuardClient.publishNav).toHaveBeenCalledTimes(1);
    expect(priceGuardClient.publishNav).toHaveBeenCalledWith(
      "GPUBLISHER",
      "CASSETCONTRACT",
      "SPIKO",
      expect.any(BigInt),
      expect.any(Number),
      expect.any(Buffer),
    );
  });

  it("skips publishing when the issuer NAV signature does not verify against ISSUER_NAV_PUBLIC_KEYS", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn().mockResolvedValue("x"),
      publishFeed: vi.fn().mockResolvedValue("y"),
      guardedPrice: vi.fn().mockResolvedValue({
        asset: "CASSETCONTRACT",
        value: 10_000_000n,
        status: "Ok",
        ts: 1_700_000_000,
        sources: [],
      }),
    };
    const signer = makeSigner();
    const submit = vi.fn().mockResolvedValue({ hash: "hash5", status: "SUCCESS" });

    // A syntactically valid but WRONG public key (a different Ed25519 key than the mock adapters
    // actually sign with) — verification must fail, not silently pass.
    const wrongPublicKeyBase64 = Buffer.alloc(32, 7).toString("base64");
    const env = makeTestEnv({
      ISSUER_NAV_PUBLIC_KEYS: JSON.stringify({ spiko: wrongPublicKeyBase64 }),
    });

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit, env);

    expect(priceGuardClient.publishNav).not.toHaveBeenCalled();
    expect(priceGuardClient.publishFeed).not.toHaveBeenCalled();
    expect(fireSpy).toHaveBeenCalledWith(
      "price_degraded",
      expect.objectContaining({ assetId: "asset-1", reason: "issuer NAV signature verification failed" }),
    );
  });

  it("skips publishing when no ISSUER_NAV_PUBLIC_KEYS entry exists for the asset's issuer code", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn().mockResolvedValue("x"),
      publishFeed: vi.fn().mockResolvedValue("y"),
      guardedPrice: vi.fn(),
    };
    const signer = makeSigner();
    const submit = vi.fn().mockResolvedValue({ hash: "hash6", status: "SUCCESS" });

    await runPriceUpdateCycle(
      db as any,
      priceGuardClient as any,
      signer as any,
      [makeAsset()],
      submit,
      { ISSUER_NAV_PUBLIC_KEYS: JSON.stringify({}) } as NodeJS.ProcessEnv,
    );

    expect(priceGuardClient.publishNav).not.toHaveBeenCalled();
    expect(priceGuardClient.guardedPrice).not.toHaveBeenCalled();
  });

  it("throws for an unknown PRICE_GUARD_MODE rather than silently defaulting", async () => {
    const db = makeDb();
    const priceGuardClient = {
      publishNav: vi.fn(),
      publishFeed: vi.fn(),
      guardedPrice: vi.fn(),
    };
    const signer = makeSigner();
    const submit = vi.fn();

    // getIndependentFeedAdapter is resolved once up front, before the per-asset try/catch, so an
    // invalid mode fails the whole cycle loudly rather than being swallowed per-asset.
    await expect(
      runPriceUpdateCycle(
        db as any,
        priceGuardClient as any,
        signer as any,
        [makeAsset()],
        submit,
        { PRICE_GUARD_MODE: "bogus" } as NodeJS.ProcessEnv,
      ),
    ).rejects.toThrow(/PRICE_GUARD_MODE="bogus"/);
  });
});
