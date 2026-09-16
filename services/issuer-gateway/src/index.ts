/**
 * Internal Fastify server for `services/issuer-gateway` (PRD §6.5). Each endpoint resolves the
 * issuer's `IssuerAdapter` via `getAdapter` and calls the matching method, then writes an
 * `audit_log` row for the call (every issuer interaction is a compliance-relevant event).
 *
 * These are internal-only endpoints — no public auth is applied here. Callers (e.g.
 * `services/api`'s pledge/exit/liquidation handlers, or `services/keeper`) are expected to reach
 * this service over a private network / service mesh, not the public internet.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase, schema, type Database } from "@ballast/db";
import { createLogger } from "@ballast/observability";
import { getAdapter } from "./registry.js";

interface AuthorizeBody {
  assetCode: string;
  holderAddress: string;
}

interface Sep8ApproveBody {
  assetCode: string;
  txXdr: string;
}

interface LienFreezeBody {
  assetCode: string;
  holderAddress: string;
  units: string; // bigint over the wire as a decimal string
}

interface LienReleaseBody {
  assetCode: string;
  lienRef: string;
}

interface RedeemBody {
  assetCode: string;
  units: string; // bigint over the wire as a decimal string
  destination: string;
}

async function audit(db: Database, action: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(schema.auditLog).values({
    actor: "issuer-gateway",
    action,
    payload,
  });
}

export function buildServer(db: Database): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post<{ Params: { code: string }; Body: AuthorizeBody }>(
    "/internal/issuers/:code/authorize",
    async (req, reply) => {
      const { code } = req.params;
      const { assetCode, holderAddress } = req.body;
      const adapter = getAdapter(code);
      const result = await adapter.requestAuthorization(assetCode, holderAddress);
      await audit(db, "issuer.authorize", { issuerCode: code, assetCode, holderAddress, result });
      return reply.send(result);
    },
  );

  app.post<{ Params: { code: string }; Body: Sep8ApproveBody }>(
    "/internal/issuers/:code/sep8-approve",
    async (req, reply) => {
      const { code } = req.params;
      const { assetCode, txXdr } = req.body;
      const adapter = getAdapter(code);
      const result = await adapter.requestSep8Approval(assetCode, txXdr);
      await audit(db, "issuer.sep8_approve", { issuerCode: code, assetCode, result });
      return reply.send(result);
    },
  );

  app.post<{ Params: { code: string }; Body: LienFreezeBody }>(
    "/internal/issuers/:code/lien-freeze",
    async (req, reply) => {
      const { code } = req.params;
      const { assetCode, holderAddress, units } = req.body;
      const adapter = getAdapter(code);
      const result = await adapter.requestLienFreeze(assetCode, holderAddress, BigInt(units));
      await audit(db, "issuer.lien_freeze", { issuerCode: code, assetCode, holderAddress, units, result });
      return reply.send(result);
    },
  );

  app.post<{ Params: { code: string }; Body: LienReleaseBody }>(
    "/internal/issuers/:code/lien-release",
    async (req, reply) => {
      const { code } = req.params;
      const { assetCode, lienRef } = req.body;
      const adapter = getAdapter(code);
      await adapter.requestLienRelease(assetCode, lienRef);
      await audit(db, "issuer.lien_release", { issuerCode: code, assetCode, lienRef });
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { code: string }; Body: RedeemBody }>(
    "/internal/issuers/:code/redeem",
    async (req, reply) => {
      const { code } = req.params;
      const { assetCode, units, destination } = req.body;
      const adapter = getAdapter(code);
      const result = await adapter.requestRedemption(assetCode, BigInt(units), destination);
      await audit(db, "issuer.redeem", { issuerCode: code, assetCode, units, destination, result });
      return reply.send(result);
    },
  );

  return app;
}

async function main() {
  const logger = createLogger("issuer-gateway");
  const db = createDatabase();
  const app = buildServer(db);
  const port = Number(process.env.ISSUER_GATEWAY_PORT ?? 3001);

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "issuer-gateway: listening");
}

if (process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
