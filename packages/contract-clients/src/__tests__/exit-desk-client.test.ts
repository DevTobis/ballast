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

  it("exit() returns non-empty unsigned XDR", async () => {
    const xdr = await client.exit(source, asset, 1_000n, 950_000n, source);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });
});
