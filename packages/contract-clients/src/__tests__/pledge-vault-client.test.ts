import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PledgeVaultClient } from "../pledge-vault-client.js";
import { randomAccountId, randomContractId, stubRpcServer, testNetwork } from "./support.js";

describe("PledgeVaultClient", () => {
  let stub: ReturnType<typeof stubRpcServer>;
  let client: PledgeVaultClient;
  const source = randomAccountId();
  const asset = randomAccountId();

  beforeEach(() => {
    stub = stubRpcServer();
    client = new PledgeVaultClient({ network: testNetwork, contractId: randomContractId() });
  });

  afterEach(() => {
    stub.restore();
  });

  it("pledge() returns non-empty unsigned XDR", async () => {
    const xdr = await client.pledge(source, 1n, asset, 1_000n);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("release() returns non-empty unsigned XDR", async () => {
    const xdr = await client.release(source, 1n, asset, 500n);
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("recordLien() returns non-empty unsigned XDR", async () => {
    const xdr = await client.recordLien(source, 1n, asset, 500n, Buffer.from("lien-ref"));
    expect(xdr.length).toBeGreaterThan(0);
  });
});
