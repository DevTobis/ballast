import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Database } from "@ballast/db";
import { ContractRejectedError } from "@ballast/contract-clients";
import { isTransientRpcError } from "@ballast/network-config";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { registerAuth } from "./auth.js";
import { getDb } from "./db.js";
import { getChainGateway, type ChainGateway } from "./chain.js";
import { getContractClients, type ContractClients } from "./contract-clients.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDevAuthRoutes } from "./routes/dev-auth.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerMarketRoutes } from "./routes/markets.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerCompliance } from "./compliance/hook.js";
import { OfacScreener, type SanctionsScreener } from "./compliance/screener.js";
import { registerCreditLineRoutes } from "./routes/credit-lines.js";
import { registerExitRoutes } from "./routes/exit.js";
import { registerRepoRoutes } from "./routes/repo.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerPartyRoutes } from "./routes/parties.js";
import { registerTxRoutes } from "./routes/tx.js";

export interface BuildServerOptions {
  config?: ApiConfig;
  db?: Database;
  contracts?: ContractClients;
  chain?: ChainGateway;
  /** Overridable for tests; defaults to the OFAC SDN screener when compliance is enforced. */
  screener?: SanctionsScreener;
}

function sanitizeErrorMessage(message: unknown): string {
  if (!message) return "";
  let text = String(message);
  text = text.replace(/https?:\/\/[^\s"'`]+/g, "[rpc-url]");
  if (text.includes("\n    at ")) {
    text = text.split("\n    at ")[0].trim();
  }
  return text;
}

/**
 * Builds (but doesn't start) the Fastify app. Split out from `index.ts` so tests can inject a
 * mocked `db`/`contracts` and call `app.inject(...)` without opening a real port or touching
 * Postgres/Stellar RPC.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadApiConfig();
  const db = options.db ?? getDb();
  const contracts = options.contracts ?? getContractClients();
  const chain = options.chain ?? getChainGateway();

  const app = Fastify({
    logger: false,
    // A hop count (TRUST_PROXY=1) is accepted at runtime by Fastify but missing from its typings.
    trustProxy: (config.trustProxy ?? false) as boolean | string,
  });

  // Registered before auth: this is a pure JSON API (no HTML, so helmet's defaults are fine
  // as-is) that the console browser app calls cross-origin, so CORS must be locked to that one
  // known origin rather than left as `*`.
  // Keep the raw bytes next to the parsed JSON: signed-request auth hashes exactly what was sent,
  // not a re-serialised copy that could differ in whitespace or key order.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  void app.register(helmet);
  void app.register(cors, { origin: config.consoleOrigin });
  // Per-address ceiling: callers presenting an `x-api-key` get a higher one. A bogus key buys no
  // more than failed attempts, which `auth.ts` caps separately, and each valid key also has its own
  // per-key limit there. `/healthz` is exempted below via its own route config.
  void app.register(rateLimit, {
    max: (req: { headers: Record<string, unknown> }) => (req.headers["x-api-key"] ? 1000 : 100),
    timeWindow: "1 minute",
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid request", issues: error.issues });
    }

    const isContractRejected =
      error instanceof ContractRejectedError ||
      error?.name === "ContractRejectedError" ||
      (error as any)?.code === "CONTRACT_REJECTED" ||
      /simulation of "[^"]+" failed/i.test(error?.message ?? "") ||
      /contract rejected the request/i.test(error?.message ?? "") ||
      /HostError|Error\(Contract/i.test(error?.message ?? "");

    if (isContractRejected) {
      let detail =
        error?.detail ??
        (error?.message?.match(/simulation of "[^"]+" failed:\s*(.*)/)?.[1] ?? error?.message);
      if (typeof detail === "string" && detail.startsWith("contract rejected the request: ")) {
        detail = detail.slice("contract rejected the request: ".length);
      }
      return reply.code(422).send({
        error: "contract rejected the request",
        detail: sanitizeErrorMessage(detail),
      });
    }

    const isTimeout = /timed? ?out|timeout/i.test(error?.message ?? "");
    if (isTransientRpcError(error) || isTimeout) {
      return reply.code(503).send({
        error: isTimeout ? "rpc request timed out" : "upstream rpc unavailable",
        detail: isTimeout ? "rpc request timed out" : "rpc connection failed",
      });
    }

    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send(error);
    }

    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
      statusCode,
      error: "Internal Server Error",
    });
  });

  registerAuth(app, config, db);
  if (config.complianceEnforced) registerCompliance(app, db, options.screener ?? new OfacScreener());

  // GET /v1/assets and /v1/assets/:id/price are public per PRD §9 (no auth required to browse
  // supported assets/prices); everything else needs a resolved partyId.
  app.get("/healthz", { config: { public: true, rateLimit: false } }, async () => ({ ok: true }));

  registerAuthRoutes(app, db, config);

  // Dev-only raw-G-address login (see routes/dev-auth.ts's module doc comment) — never wired up
  // unless explicitly opted into, and never the default even in local dev, so it can't be reached
  // by accident.
  if (process.env.ENABLE_DEV_LOGIN === "true") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "services/api: ENABLE_DEV_LOGIN=true with NODE_ENV=production — dev-login has no proof of key ownership and must never run in production",
      );
    }
    app.log.warn(
      "services/api: ENABLE_DEV_LOGIN=true — /v1/auth/dev-login is active (no proof of Stellar key ownership). Never set this in production.",
    );
    registerDevAuthRoutes(app, db, config);
  }

  registerAssetRoutes(app, db);
  registerMarketRoutes(app, db);
  registerWebhookRoutes(app, db, config);
  registerApiKeyRoutes(app, db, config);
  registerCreditLineRoutes(app, db, contracts, chain);
  registerExitRoutes(app, db, contracts, chain);
  registerRepoRoutes(app, db, contracts, chain);
  registerTxRoutes(app, db, chain, contracts);
  registerPartyRoutes(app, db);
  registerPositionRoutes(app, db);
  registerReportRoutes(app, db);

  return app;
}
