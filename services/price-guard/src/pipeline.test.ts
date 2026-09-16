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
type AssetConfig = import("@ballast/domain-types").AssetConfig;

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

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit);

    // 2 price_observation rows + 1 price_snapshot row
    expect(db.insert).toHaveBeenCalledTimes(3);
    expect(db.values).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ assetId: "asset-1", status: "Ok" }),
    );

    expect(priceGuardClient.publishNav).toHaveBeenCalledWith(
      "GPUBLISHER",
      "CASSETCONTRACT",
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

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit);

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

    await runPriceUpdateCycle(db as any, priceGuardClient as any, signer as any, [makeAsset()], submit);

    expect(fireSpy).toHaveBeenCalledWith(
      "price_halted",
      expect.objectContaining({ assetId: "asset-1", status: "Halted" }),
    );
  });
});
