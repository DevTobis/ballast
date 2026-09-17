/**
 * Dev-only stand-in for the real SEP-10 challenge/response flow (see `auth.ts`'s module doc
 * comment on that gap). A real wallet integration issues a challenge transaction, has the wallet
 * sign it with the account's own Stellar key, verifies the signature, and only then mints a JWT.
 * This route skips all of that and mints a JWT for any Stellar account that's already linked to a
 * party via `party_account` — good enough to drive the console against a local/testnet
 * deployment where the caller already controls the keys in question, never acceptable in
 * production (there is no proof of key ownership here at all).
 */
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";

const devLoginSchema = z.object({ stellarAccount: z.string().min(1) });

export function registerDevAuthRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  app.post("/v1/auth/dev-login", { config: { public: true } }, async (request, reply) => {
    const body = devLoginSchema.parse(request.body);

    const [account] = await db
      .select()
      .from(schema.partyAccount)
      .where(eq(schema.partyAccount.stellarAccount, body.stellarAccount))
      .limit(1);
    if (!account) {
      return reply.code(404).send({ error: "stellar account not linked to a known party" });
    }

    const token = jwt.sign({ sub: body.stellarAccount }, config.jwtSigningSecret, { expiresIn: "12h" });
    return { token, partyId: account.partyId };
  });
}
