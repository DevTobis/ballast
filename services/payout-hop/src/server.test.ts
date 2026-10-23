import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildServer } from "./index.js";
import type { PayoutPolicy } from "./hop.js";
import type { PayoutSigner } from "./signer.js";
import { FirstLegRefusedError, FirstLegUnavailableError, type FirstLegVerifier } from "./firstLeg.js";

const TOKEN = "payout-test-token-0123456789abcdef0123456789";
const ANCHOR = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const policy: PayoutPolicy = { allowedDestinations: new Set([ANCHOR]), usdcIssuer: ISSUER, maxAmount: 1_000n * 10_000_000n };

function server(verifier: FirstLegVerifier = { verify: async () => {} }) {
  const signAndSubmit = vi.fn(async () => ({ hash: "h", status: "PENDING" }));
  const signer = {
    publicKey: () => Keypair.random().publicKey(),
    networkPassphrase: () => "Standalone Network ; February 2017",
    loadSequenceAccount: vi.fn(),
    signAndSubmit,
  } as unknown as PayoutSigner;
  // Any database use would fail loudly: these requests must be turned away before reaching it.
  const db = new Proxy({}, { get: () => () => { throw new Error("database must not be touched"); } }) as never;
  return { app: buildServer(db, signer, { internalToken: TOKEN, policy, verifier }), signAndSubmit };
}

const body = (over: object = {}) => ({
  fromContractPayoutTxHash: "tx1", toAnchorAccount: ANCHOR, amount: "10000000", memo: "ref", usdcAssetAddress: ISSUER, ...over,
});

describe("payout-hop server", () => {
  it("refuses a request without the internal token, and sends nothing", async () => {
    const { app, signAndSubmit } = server();
    for (const headers of [{}, { "x-internal-token": "nope" }]) {
      const res = await app.inject({ method: "POST", url: "/internal/payout-hop/forward", headers, payload: body() });
      expect(res.statusCode).toBe(401);
    }
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const { app } = server();
    for (const payload of [{}, body({ amount: "-5" }), body({ amount: "1.5" }), body({ memo: "" }), body({ quoteId: "not-a-uuid" })]) {
      const res = await app.inject({ method: "POST", url: "/internal/payout-hop/forward", headers: { "x-internal-token": TOKEN }, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("answers 403 for a payout the policy refuses", async () => {
    const { app, signAndSubmit } = server();
    const res = await app.inject({
      method: "POST", url: "/internal/payout-hop/forward", headers: { "x-internal-token": TOKEN },
      payload: body({ toAnchorAccount: Keypair.random().publicKey() }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/approved anchor/);
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  it("answers 422 with the reason when the first leg does not back the payout, without touching the database", async () => {
    const { app, signAndSubmit } = server({
      verify: async () => { throw new FirstLegRefusedError("first-leg transaction tx1 was not found on the network"); },
    });
    const res = await app.inject({ method: "POST", url: "/internal/payout-hop/forward", headers: { "x-internal-token": TOKEN }, payload: body() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/not found/);
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  it("answers 503 when the first leg cannot be checked, without touching the database", async () => {
    const { app, signAndSubmit } = server({
      verify: async () => { throw new FirstLegUnavailableError("could not look up the first-leg transaction: timeout"); },
    });
    const res = await app.inject({ method: "POST", url: "/internal/payout-hop/forward", headers: { "x-internal-token": TOKEN }, payload: body() });
    expect(res.statusCode).toBe(503);
    expect(signAndSubmit).not.toHaveBeenCalled();
  });
});
