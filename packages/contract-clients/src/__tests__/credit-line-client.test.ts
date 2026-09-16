import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreditLineClient } from "../credit-line-client.js";
import { randomAccountId, randomContractId, stubRpcServer, testNetwork } from "./support.js";

describe("CreditLineClient", () => {
  let stub: ReturnType<typeof stubRpcServer>;
  let client: CreditLineClient;
  const source = randomAccountId();
  const borrower = randomAccountId();
  const asset = randomAccountId();

  beforeEach(() => {
    process.env.STELLAR_SIMULATION_SOURCE = randomAccountId();
    process.env.STELLAR_POKE_SOURCE = randomAccountId();
    stub = stubRpcServer({ ltvBps: 5000 });
    client = new CreditLineClient({ network: testNetwork, contractId: randomContractId() });
  });

  afterEach(() => {
    stub.restore();
    delete process.env.STELLAR_SIMULATION_SOURCE;
    delete process.env.STELLAR_POKE_SOURCE;
  });

  it("open() returns non-empty unsigned XDR", async () => {
    const xdr = await client.open(source, {
      borrower,
      asset,
      limit: 10_000_000n,
      rateBps: 800,
      cureS: 3600,
      agreementHash: Buffer.alloc(32, 7),
    });
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("fund() returns non-empty unsigned XDR", async () => {
    expect((await client.fund(source, 1n, 1_000_000n)).length).toBeGreaterThan(0);
  });

  it("draw() returns non-empty unsigned XDR", async () => {
    expect((await client.draw(source, 1n, 500_000n, borrower)).length).toBeGreaterThan(0);
  });

  it("repay() returns non-empty unsigned XDR", async () => {
    expect((await client.repay(source, 1n, 250_000n)).length).toBeGreaterThan(0);
  });

  it("ltv() simulates a read and does not throw", async () => {
    const result = await client.ltv(1n);
    expect(result).toBeDefined();
  });

  it("poke() returns non-empty unsigned XDR", async () => {
    const xdr = await client.poke(1n);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("liquidate() returns non-empty unsigned XDR", async () => {
    const xdr = await client.liquidate(source, 1n, "redeem");
    expect(xdr.length).toBeGreaterThan(0);
  });
});
