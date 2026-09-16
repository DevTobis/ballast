import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoDvpClient } from "../repo-dvp-client.js";
import { randomAccountId, randomContractId, stubRpcServer, testNetwork } from "./support.js";

describe("RepoDvpClient", () => {
  let stub: ReturnType<typeof stubRpcServer>;
  let client: RepoDvpClient;
  const source = randomAccountId();
  const borrower = randomAccountId();
  const asset = randomAccountId();

  beforeEach(() => {
    stub = stubRpcServer();
    client = new RepoDvpClient({ network: testNetwork, contractId: randomContractId() });
  });

  afterEach(() => {
    stub.restore();
  });

  it("propose() returns non-empty unsigned XDR", async () => {
    const xdr = await client.propose(source, {
      cashBorrower: borrower,
      asset,
      units: 1_000n,
      cashAmount: 900_000n,
      rateBps: 300,
      kind: "overnight",
      maturityAt: Math.floor(Date.now() / 1000) + 86_400,
      agreementHash: Buffer.alloc(32, 3),
    });
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("acceptAndSettle() returns non-empty unsigned XDR", async () => {
    expect((await client.acceptAndSettle(source, 1n)).length).toBeGreaterThan(0);
  });

  it("unwind() returns non-empty unsigned XDR", async () => {
    expect((await client.unwind(source, 1n)).length).toBeGreaterThan(0);
  });

  it("callMargin() returns non-empty unsigned XDR", async () => {
    expect((await client.callMargin(source, 1n)).length).toBeGreaterThan(0);
  });

  it("defaultClose() returns non-empty unsigned XDR", async () => {
    expect((await client.defaultClose(source, 1n)).length).toBeGreaterThan(0);
  });
});
