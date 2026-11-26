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

  it("cancelPending() returns non-empty unsigned XDR", async () => {
    const xdr = await client.cancelPending(source, 1n, asset, 500n);
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("rejectLien() returns non-empty unsigned XDR", async () => {
    const xdr = await client.rejectLien(source, 1n, asset, 500n, Buffer.from("declined"));
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("position() simulates a read and normalizes mode and lienRef", async () => {
    stub.restore();
    process.env.STELLAR_SIMULATION_SOURCE = randomAccountId();
    stub = stubRpcServer({
      units: 100n,
      pending_lien_units: 50n,
      mode: ["IssuerLien"],
      lien_ref: null,
    });
    const pos = await client.position(1n, asset);
    delete process.env.STELLAR_SIMULATION_SOURCE;
    expect(pos).toEqual({
      units: 100n,
      pendingLienUnits: 50n,
      mode: "issuer_lien",
      lienRef: null,
    });
  });
});
