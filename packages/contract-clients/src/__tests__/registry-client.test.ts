import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryClient } from "../registry-client.js";
import { randomAccountId, randomContractId, stubRpcServer, testNetwork } from "./support.js";
import type { AssetConfig } from "@ballast/domain-types";

describe("RegistryClient", () => {
  let stub: ReturnType<typeof stubRpcServer>;
  let client: RegistryClient;
  const source = randomAccountId();
  const asset = randomAccountId();

  beforeEach(() => {
    process.env.STELLAR_SIMULATION_SOURCE = randomAccountId();
    stub = stubRpcServer({ status: "active" });
    client = new RegistryClient({ network: testNetwork, contractId: randomContractId() });
  });

  afterEach(() => {
    stub.restore();
    delete process.env.STELLAR_SIMULATION_SOURCE;
  });

  it("asset() simulates a read and does not throw", async () => {
    const result = await client.asset(asset);
    expect(result).toBeDefined();
  });

  it("registerAsset() returns non-empty unsigned XDR", async () => {
    const config: AssetConfig = {
      id: "id",
      code: "RWA1",
      issuerG: randomAccountId(),
      contractC: randomContractId(),
      standard: "classic_sac",
      yieldType: "accumulating",
      custodyMode: "escrow",
      ccy: "USD",
      redemptionLagDays: 2,
      redemptionDailyCap: 1_000_000n,
      navSchedule: "daily",
      priceBandBps: 100,
      dailyMoveBandBps: 200,
      haircutBaseBps: 500,
      haircutFxBps: 0,
      status: "active",
    };
    const xdr = await client.registerAsset(source, asset, config);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("queueParam() returns non-empty unsigned XDR", async () => {
    const xdr = await client.queueParam(source, asset, { field: "HaircutBaseBps", value: 600 });
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("executeParam() returns non-empty unsigned XDR", async () => {
    const xdr = await client.executeParam(source, 1n);
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("raiseHaircutNow() returns non-empty unsigned XDR", async () => {
    const xdr = await client.raiseHaircutNow(source, asset, 50);
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("pause() and unpause() return non-empty unsigned XDR", async () => {
    expect((await client.pause(source, "Draws")).length).toBeGreaterThan(0);
    expect((await client.unpause(source, "All")).length).toBeGreaterThan(0);
  });
});
