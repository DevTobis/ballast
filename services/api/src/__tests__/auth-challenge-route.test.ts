import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HOME_DOMAIN = "ballast.example.com";

const serverKeypair = Keypair.random();

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: serverKeypair.secret(),
  sep10HomeDomain: HOME_DOMAIN,
  sep10WebAuthDomain: HOME_DOMAIN,
  networkPassphrase: NETWORK_PASSPHRASE,
  webhookHmacSecret: "test-webhook-secret",
  webhookSubscribers: [],
  institutionApiKeys: {},
  consoleOrigin: "http://localhost:5173",
};

const PARTY_ID = "66666666-6666-6666-6666-666666666666";

function serverFor(linkedAccount?: string) {
  const db = createFakeDb(
    linkedAccount
      ? new Map<unknown, unknown[]>([
          [schema.partyAccount, [{ partyId: PARTY_ID, stellarAccount: linkedAccount, role: "borrower" }]],
        ])
      : new Map(),
  );
  return buildServer({ config, db, contracts: {} as ContractClients });
}

describe("POST /v1/auth/challenge + /v1/auth/token (real SEP-10)", () => {
  it("issues a challenge transaction for a known-shape Stellar account", async () => {
    const clientKeypair = Keypair.random();
    const app = serverFor(clientKeypair.publicKey());

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { account: clientKeypair.publicKey() },
    });

    expect(res.statusCode).toBe(200);
    const { transaction } = res.json();
    expect(typeof transaction).toBe("string");

    // The challenge should be signed by the server already, and buildable back into a Transaction.
    const tx = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
    expect(tx).toBeTruthy();
  });

  it("mints a valid JWT once the client signs and submits the challenge", async () => {
    const clientKeypair = Keypair.random();
    const app = serverFor(clientKeypair.publicKey());

    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { account: clientKeypair.publicKey() },
    });
    const { transaction } = challengeRes.json();

    const tx = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
    tx.sign(clientKeypair);
    const signedXdr = tx.toEnvelope().toXDR("base64").toString();

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { transaction: signedXdr },
    });

    expect(tokenRes.statusCode).toBe(200);
    const body = tokenRes.json();
    expect(body.partyId).toBe(PARTY_ID);
    const decoded = jwt.verify(body.token, config.jwtSigningSecret) as jwt.JwtPayload;
    expect(decoded.sub).toBe(clientKeypair.publicKey());
  });

  it("rejects an unsigned challenge transaction", async () => {
    const clientKeypair = Keypair.random();
    const app = serverFor(clientKeypair.publicKey());

    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { account: clientKeypair.publicKey() },
    });
    const { transaction } = challengeRes.json();

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { transaction },
    });

    expect(tokenRes.statusCode).toBe(401);
  });

  it("rejects a challenge transaction signed by the wrong account", async () => {
    const clientKeypair = Keypair.random();
    const wrongKeypair = Keypair.random();
    const app = serverFor(clientKeypair.publicKey());

    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { account: clientKeypair.publicKey() },
    });
    const { transaction } = challengeRes.json();

    const tx = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
    tx.sign(wrongKeypair);
    const signedXdr = tx.toEnvelope().toXDR("base64").toString();

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { transaction: signedXdr },
    });

    expect(tokenRes.statusCode).toBe(401);
  });

  it("returns 404 when the challenge signer isn't linked to a known party", async () => {
    const clientKeypair = Keypair.random();
    const app = serverFor(); // no party_account fixtures at all

    const challengeRes = await app.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { account: clientKeypair.publicKey() },
    });
    const { transaction } = challengeRes.json();

    const tx = TransactionBuilder.fromXDR(transaction, NETWORK_PASSPHRASE);
    tx.sign(clientKeypair);
    const signedXdr = tx.toEnvelope().toXDR("base64").toString();

    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/token",
      payload: { transaction: signedXdr },
    });

    expect(tokenRes.statusCode).toBe(404);
  });
});
