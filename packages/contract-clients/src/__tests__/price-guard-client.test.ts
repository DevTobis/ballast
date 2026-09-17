import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PriceGuardClient } from "../price-guard-client.js";
import { randomAccountId, randomContractId, stubRpcServer, testNetwork } from "./support.js";

describe("PriceGuardClient", () => {
  let stub: ReturnType<typeof stubRpcServer>;
  let client: PriceGuardClient;
  const source = randomAccountId();
  const asset = randomAccountId();

  beforeEach(() => {
    process.env.STELLAR_SIMULATION_SOURCE = randomAccountId();
    stub = stubRpcServer({ status: "Ok" });
    client = new PriceGuardClient({ network: testNetwork, contractId: randomContractId() });
  });

  afterEach(() => {
    stub.restore();
    delete process.env.STELLAR_SIMULATION_SOURCE;
  });

  it("guardedPrice() simulates a read and does not throw", async () => {
    const result = await client.guardedPrice(asset);
    expect(result).toBeDefined();
  });

  it("publishNav() returns non-empty unsigned XDR", async () => {
    const xdr = await client.publishNav(source, asset, "SPIKO", 100_000_000n, Date.now(), Buffer.alloc(64));
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("configureIssuerKey() returns non-empty unsigned XDR", async () => {
    const xdr = await client.configureIssuerKey(source, asset, Buffer.alloc(32));
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("configureSignatureRequirement() returns non-empty unsigned XDR", async () => {
    const xdr = await client.configureSignatureRequirement(source, true);
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("publishFeed() returns non-empty unsigned XDR", async () => {
    const xdr = await client.publishFeed(source, asset, "kraken", 100_000_000n, Date.now());
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("confirmHaltCleared() returns non-empty unsigned XDR", async () => {
    const xdr = await client.confirmHaltCleared(source, asset);
    expect(xdr.length).toBeGreaterThan(0);
  });
});
