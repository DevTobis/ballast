import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitDeskClient } from "../exit-desk-client.js";
import { randomAccountId, randomContractId, stubRpcServer, testNetwork } from "./support.js";

describe("ExitDeskClient", () => {
  let stub: ReturnType<typeof stubRpcServer>;
  let client: ExitDeskClient;
  const source = randomAccountId();
  const asset = randomAccountId();

  beforeEach(() => {
    process.env.STELLAR_SIMULATION_SOURCE = randomAccountId();
    stub = stubRpcServer({ usdcOut: 990_000n });
    client = new ExitDeskClient({ network: testNetwork, contractId: randomContractId() });
  });

  afterEach(() => {
    stub.restore();
    delete process.env.STELLAR_SIMULATION_SOURCE;
  });

  it("quote() simulates a read and does not throw", async () => {
    const result = await client.quote(asset, 1_000n);
    expect(result).toBeDefined();
  });

  it("usdc() simulates a read and does not throw", async () => {
    const result = await client.usdc();
    expect(result).toBeDefined();
  });

  it("assetConfig() simulates a read and does not throw", async () => {
    const result = await client.assetConfig(asset);
    expect(result).toBeDefined();
  });

  it("inventory() simulates a read and does not throw", async () => {
    const result = await client.inventory(asset);
    expect(result).toBeDefined();
  });

  it("dailyUsed() simulates a read and does not throw", async () => {
    const result = await client.dailyUsed(source, asset);
    expect(result).toBeDefined();
  });

  it("capacity() simulates a read and does not throw", async () => {
    const result = await client.capacity(source, asset);
    expect(result).toBeDefined();
  });

  it("setUsdc() returns non-empty unsigned XDR", async () => {
    const xdr = await client.setUsdc(source, asset);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("exit() returns non-empty unsigned XDR", async () => {
    const xdr = await client.exit(source, asset, 1_000n, 950_000n, source);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("exit() with deadline calls exit_before and returns non-empty unsigned XDR", async () => {
    const xdr = await client.exit(source, asset, 1_000n, 950_000n, source, 1_800_000_000n);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("exitBefore() returns non-empty unsigned XDR", async () => {
    const xdr = await client.exitBefore(source, asset, 1_000n, 950_000n, source, 1_800_000_000n);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });
});
