import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

// dev-auth's route is only registered when this explicit flag is set (see server.ts) — never on
// by default, including in local dev, so it can't be reached by accident.
const PREVIOUS_ENABLE_DEV_LOGIN = process.env.ENABLE_DEV_LOGIN;
beforeAll(() => {
  process.env.ENABLE_DEV_LOGIN = "true";
});
afterAll(() => {
  process.env.ENABLE_DEV_LOGIN = PREVIOUS_ENABLE_DEV_LOGIN;
});

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookHmacSecret: "test-webhook-secret",
  webhookSubscribers: [],
  institutionApiKeys: {},
  consoleOrigin: "http://localhost:5173",
};

const PARTY_ID = "33333333-3333-3333-3333-333333333333";
const STELLAR_ACCOUNT = "GABCDEFTESTACCOUNT";

describe("POST /v1/auth/dev-login", () => {
  it("mints a JWT for an already-linked Stellar account", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: PARTY_ID, stellarAccount: STELLAR_ACCOUNT, role: "borrower" }]],
      ]),
    );
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { stellarAccount: STELLAR_ACCOUNT },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.partyId).toBe(PARTY_ID);
    const decoded = jwt.verify(body.token, config.jwtSigningSecret) as jwt.JwtPayload;
    expect(decoded.sub).toBe(STELLAR_ACCOUNT);
  });

  it("does not require auth (it's how you get auth)", async () => {
    const db = createFakeDb(new Map());
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { stellarAccount: "GNOTLINKED" },
    });

    // No `party_account` fixture at all -> the lookup finds nothing -> 404, not 401. Reaching the
    // route handler at all (rather than being blocked by the auth hook) is what this test proves.
    expect(res.statusCode).toBe(404);
  });
});
