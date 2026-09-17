/**
 * Real SEP-10 web-authentication challenge/response, replacing `dev-auth.ts`'s raw-G-address
 * login for production use. Two stateless endpoints:
 *
 *  - `POST /v1/auth/challenge` builds a SEP-10 challenge transaction (an unsigned, unsubmittable
 *    Stellar tx encoding the caller's account + a nonce) with `WebAuth.buildChallengeTx`, signed
 *    by this service's own SEP-10 server keypair, and returns it as base64 XDR.
 *  - `POST /v1/auth/token` takes that same transaction back, now also signed by the caller's
 *    Stellar account, verifies it with `WebAuth.readChallengeTx` + `WebAuth.verifyChallengeTxSigners`
 *    (single-signer verification, matching this app's single-key `party_account` model — no
 *    multisig account support today), and on success mints the same app-level session JWT
 *    `dev-auth.ts` mints, via the same `party_account` lookup.
 *
 * No server-side challenge store is needed: the challenge transaction's own 300s `timeBounds`
 * already prevent replay past expiry, so verification is entirely a function of the submitted
 * transaction plus this service's config.
 */
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";

const CHALLENGE_TIMEOUT_S = 300;

const challengeSchema = z.object({
  account: z.string().refine(StrKey.isValidEd25519PublicKey, "invalid Stellar account (G...)"),
});

const tokenSchema = z.object({
  transaction: z.string().min(1, "transaction is required"),
});

function loadServerKeypair(config: ApiConfig): Keypair {
  if (!config.sep10ServerSecret) {
    throw new Error("SEP10_SERVER_SECRET is not configured");
  }
  return Keypair.fromSecret(config.sep10ServerSecret);
}

export function registerAuthRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  app.post("/v1/auth/challenge", { config: { public: true } }, async (request, reply) => {
    const parsed = challengeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid account" });
    }

    let serverKeypair: Keypair;
    try {
      serverKeypair = loadServerKeypair(config);
    } catch {
      return reply.code(500).send({ error: "SEP-10 server keypair not configured" });
    }

    const transaction = WebAuth.buildChallengeTx(
      serverKeypair,
      parsed.data.account,
      config.sep10HomeDomain,
      CHALLENGE_TIMEOUT_S,
      config.networkPassphrase,
      config.sep10WebAuthDomain,
    );

    return { transaction };
  });

  app.post("/v1/auth/token", { config: { public: true } }, async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid transaction" });
    }

    let serverKeypair: Keypair;
    try {
      serverKeypair = loadServerKeypair(config);
    } catch {
      return reply.code(500).send({ error: "SEP-10 server keypair not configured" });
    }

    let clientAccountID: string;
    try {
      const { clientAccountID: parsedAccountID } = WebAuth.readChallengeTx(
        parsed.data.transaction,
        serverKeypair.publicKey(),
        config.networkPassphrase,
        config.sep10HomeDomain,
        config.sep10WebAuthDomain,
      );
      // Single-signer verification only, matching this app's single-key `party_account` model —
      // no multisig account support today, so `verifyChallengeTxThreshold`'s extra Horizon
      // round-trip to fetch a signer summary isn't needed.
      WebAuth.verifyChallengeTxSigners(
        parsed.data.transaction,
        serverKeypair.publicKey(),
        config.networkPassphrase,
        [parsedAccountID],
        config.sep10HomeDomain,
        config.sep10WebAuthDomain,
      );
      clientAccountID = parsedAccountID;
    } catch {
      return reply.code(401).send({ error: "invalid, expired, or unsigned challenge transaction" });
    }

    const [account] = await db
      .select()
      .from(schema.partyAccount)
      .where(eq(schema.partyAccount.stellarAccount, clientAccountID))
      .limit(1);
    if (!account) {
      return reply.code(404).send({ error: "stellar account not linked to a known party" });
    }

    const token = jwt.sign({ sub: clientAccountID }, config.jwtSigningSecret, { expiresIn: "12h" });
    return { token, partyId: account.partyId };
  });
}
