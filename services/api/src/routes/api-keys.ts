/**
 * Institution API-key management. A party creates, lists and revokes its own keys with a normal
 * SEP-10 session. A request authenticated with an API key cannot reach these routes, so a leaked
 * key can be revoked by its owner but can never mint, list or extend keys.
 *
 * Rotation is create-then-revoke: issue the new key, move traffic to it, revoke the old one.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import { newKeyId, newKeySecret } from "../apiKeys.js";
import { encryptSecret, isValidSecretKey } from "../webhooks/secretBox.js";
import { withPartyAdvisoryLock } from "../party-lock.js";

const MAX_ACTIVE_KEYS_PER_PARTY = 10;

const createSchema = z.object({ label: z.string().trim().min(1).max(80).optional() });

export function registerApiKeyRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const sessionOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authMethod !== "session") {
      return reply.code(403).send({ error: "API keys are managed with a session, not with an API key" });
    }
  };

  app.post("/v1/api-keys", { preHandler: sessionOnly }, async (request, reply) => {
    if (!isValidSecretKey(config.apiKeySecretKey)) {
      return reply.code(503).send({ error: "API keys are not configured on this deployment" });
    }
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });

    const result = await withPartyAdvisoryLock(db, request.partyId, async (tx) => {
      const mine = await tx.select().from(schema.partyApiKey).where(eq(schema.partyApiKey.partyId, request.partyId));
      if (mine.filter((k) => k.status === "active").length >= MAX_ACTIVE_KEYS_PER_PARTY) {
        return { status: 409, body: { error: `at most ${MAX_ACTIVE_KEYS_PER_PARTY} active API keys per party` } };
      }

      const keyId = newKeyId();
      const secret = newKeySecret();
      await tx.insert(schema.partyApiKey).values({
        partyId: request.partyId,
        stellarAccount: request.stellarAccount!,
        keyId,
        secretCiphertext: encryptSecret(secret, config.apiKeySecretKey),
        label: parsed.data.label ?? null,
      });
      await tx.insert(schema.auditLog).values({
        actor: request.stellarAccount!,
        action: "api_key.create",
        payload: { keyId, partyId: request.partyId },
      });

      // The secret is shown exactly once; only its ciphertext is kept.
      return { status: 201, body: { keyId, secret, label: parsed.data.label ?? null } };
    });

    return reply.code(result.status).send(result.body);
  });

  app.get("/v1/api-keys", { preHandler: sessionOnly }, async (request) => {
    const rows = await db.select().from(schema.partyApiKey).where(eq(schema.partyApiKey.partyId, request.partyId));
    return {
      keys: rows.map((k) => ({
        keyId: k.keyId,
        label: k.label,
        status: k.status,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      })),
    };
  });

  app.delete<{ Params: { keyId: string } }>("/v1/api-keys/:keyId", { preHandler: sessionOnly }, async (request, reply) => {
    const [key] = await db
      .select()
      .from(schema.partyApiKey)
      .where(and(eq(schema.partyApiKey.keyId, request.params.keyId), eq(schema.partyApiKey.partyId, request.partyId)))
      .limit(1);
    if (!key) return reply.code(404).send({ error: "api key not found" });
    if (key.status === "revoked") {
      return reply.code(204).send();
    }

    await db
      .update(schema.partyApiKey)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(schema.partyApiKey.id, key.id));
    await db.insert(schema.auditLog).values({
      actor: request.stellarAccount!,
      action: "api_key.revoke",
      payload: { keyId: key.keyId, partyId: request.partyId },
    });
    return reply.code(204).send();
  });
}
