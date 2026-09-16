import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0,
  sep10SigningKey: "test-signing-key",
  webhookHmacSecret: "test-webhook-secret",
  webhookSubscribers: [],
  institutionApiKeys: {},
};

function testServer() {
  return buildServer({
    config,
    db: createFakeDb(new Map()),
    contracts: {} as ContractClients,
  });
}

describe("auth hook", () => {
  it("rejects a request with no Authorization header and no api key", async () => {
    const app = testServer();
    const res = await app.inject({ method: "GET", url: "/v1/positions?party=00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("rejects an invalid/garbage bearer token", async () => {
    const app = testServer();
    const res = await app.inject({
      method: "GET",
      url: "/v1/positions?party=00000000-0000-0000-0000-000000000000",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a JWT signed with the wrong secret", async () => {
    const app = testServer();
    const token = jwt.sign({ sub: "GBOGUSACCOUNT" }, "wrong-secret");
    const res = await app.inject({
      method: "GET",
      url: "/v1/positions?party=00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown x-api-key", async () => {
    const app = testServer();
    const res = await app.inject({
      method: "GET",
      url: "/v1/positions?party=00000000-0000-0000-0000-000000000000",
      headers: { "x-api-key": "nope", "x-signature": "deadbeef" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not require auth for the public /v1/assets route", async () => {
    const app = testServer();
    const res = await app.inject({ method: "GET", url: "/v1/assets" });
    expect(res.statusCode).toBe(200);
  });
});
