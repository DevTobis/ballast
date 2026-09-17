import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    partyId: string;
    stellarAccount: string | null;
  }
  // `@fastify/rate-limit` augments `FastifyContextConfig` with its own `rateLimit` field, which
  // turns it from an effectively-open type into a closed one — route configs using this app's
  // own `public` convention (see `buildAuthHook` below) need to be declared here too, or every
  // `{ config: { public: true } }` route option becomes a TS excess-property error.
  interface FastifyContextConfig {
    public?: boolean;
  }
}

/**
 * Auth per PRD §9: "SEP-10 JWT for Stellar accounts; API key + HMAC for institutions."
 *
 * SEP-10 is real: `routes/auth.ts` issues a genuine challenge transaction (via
 * `@stellar/stellar-sdk`'s `WebAuth.buildChallengeTx`), the wallet signs it with the account's
 * own Stellar key, and `WebAuth.verifyChallengeTxSigners` verifies that signature before a JWT is
 * minted. This hook only verifies the resulting JWT — signed with `jwtSigningSecret` (HMAC), a
 * secret distinct from the SEP-10 server keypair — and never re-derives Stellar-key proof itself.
 *
 * The JWT is expected to carry a `sub` claim equal to the caller's Stellar G-address, matching
 * SEP-10 JWT convention; we then resolve `partyId` from the `party_account` table.
 *
 * The institution path (`x-api-key` + `x-signature`) is verified against a per-party secret
 * from `ApiConfig.institutionApiKeys` (env-var JSON stub — see config.ts for the gap re: not
 * reading a real `party` table column/secret store yet). The signature covers
 * `${x-timestamp}.${raw JSON body}`, and a required `x-timestamp` header (Unix seconds, checked
 * against a ±300s tolerance) prevents replaying a captured request indefinitely.
 */
export function buildAuthHook(config: ApiConfig, db: Database) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Routes registered with `{ config: { public: true } }` (health check, public asset/price
    // listings) skip auth entirely.
    if ((request.routeOptions.config as { public?: boolean } | undefined)?.public) {
      return;
    }

    const authHeader = request.headers.authorization;
    const apiKey = request.headers["x-api-key"];
    const signature = request.headers["x-signature"];
    const timestampHeader = request.headers["x-timestamp"];

    if (typeof apiKey === "string" && typeof signature === "string") {
      const institution = config.institutionApiKeys[apiKey];
      if (!institution) {
        return reply.code(401).send({ error: "unknown api key" });
      }

      if (typeof timestampHeader !== "string" || !/^\d+$/.test(timestampHeader)) {
        return reply.code(400).send({ error: "missing or invalid x-timestamp header" });
      }
      const timestamp = Number(timestampHeader);
      const skewS = Math.abs(Date.now() / 1000 - timestamp);
      if (skewS > 300) {
        return reply.code(401).send({ error: "stale or future x-timestamp" });
      }

      const expected = createHmac("sha256", institution.hmacSecret)
        .update(`${timestampHeader}.${JSON.stringify(request.body ?? {})}`)
        .digest("hex");
      const expectedBuf = Buffer.from(expected, "hex");
      const givenBuf = Buffer.from(signature, "hex");
      const valid =
        expectedBuf.length === givenBuf.length && timingSafeEqual(expectedBuf, givenBuf);
      if (!valid) {
        return reply.code(401).send({ error: "invalid signature" });
      }
      request.partyId = institution.partyId;
      request.stellarAccount = institution.stellarAccount;
      return;
    }

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);
      let payload: jwt.JwtPayload;
      try {
        const decoded = jwt.verify(token, config.jwtSigningSecret);
        if (typeof decoded === "string") throw new Error("unexpected string payload");
        payload = decoded;
      } catch {
        return reply.code(401).send({ error: "invalid or expired token" });
      }
      const stellarAccount = payload.sub;
      if (!stellarAccount) {
        return reply.code(401).send({ error: "token missing sub claim" });
      }
      const [account] = await db
        .select()
        .from(schema.partyAccount)
        .where(eq(schema.partyAccount.stellarAccount, stellarAccount))
        .limit(1);
      if (!account) {
        return reply.code(401).send({ error: "stellar account not linked to a known party" });
      }
      request.partyId = account.partyId;
      request.stellarAccount = stellarAccount;
      return;
    }

    return reply.code(401).send({ error: "missing bearer token or api key/signature" });
  };
}

export function registerAuth(app: FastifyInstance, config: ApiConfig, db: Database): void {
  app.decorateRequest("partyId", "");
  app.decorateRequest("stellarAccount", null);
  // Deviation from the task spec's literal "onRequest hook" wording: the institution HMAC check
  // needs the parsed JSON body, which isn't available yet in Fastify's `onRequest` phase (it
  // runs before body parsing). `preHandler` is the earliest phase where `request.body` exists.
  app.addHook("preHandler", buildAuthHook(config, db));
}
