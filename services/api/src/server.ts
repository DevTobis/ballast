import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Database } from "@ballast/db";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { registerAuth } from "./auth.js";
import { getDb } from "./db.js";
import { getContractClients, type ContractClients } from "./contract-clients.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDevAuthRoutes } from "./routes/dev-auth.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerCreditLineRoutes } from "./routes/credit-lines.js";
import { registerExitRoutes } from "./routes/exit.js";
import { registerRepoRoutes } from "./routes/repo.js";
import { registerPositionRoutes } from "./routes/positions.js";
import { registerReportRoutes } from "./routes/reports.js";

export interface BuildServerOptions {
  config?: ApiConfig;
  db?: Database;
  contracts?: ContractClients;
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

  const app = Fastify({ logger: false });

  // Registered before auth: this is a pure JSON API (no HTML, so helmet's defaults are fine
  // as-is) that the console browser app calls cross-origin, so CORS must be locked to that one
  // known origin rather than left as `*`.
  void app.register(helmet);
  void app.register(cors, { origin: config.consoleOrigin });
  // Cheap differentiation using the existing `x-api-key` institution-auth header: authenticated
  // institutions get a much higher ceiling than anonymous/JWT-bearer callers. `/healthz` is
  // exempted below via its own route config.
  void app.register(rateLimit, {
    max: (req: { headers: Record<string, unknown> }) => (req.headers["x-api-key"] ? 1000 : 100),
    timeWindow: "1 minute",
  });

  registerAuth(app, config, db);

  // GET /v1/assets and /v1/assets/:id/price are public per PRD §9 (no auth required to browse
  // supported assets/prices); everything else needs a resolved partyId.
  app.get("/healthz", { config: { public: true, rateLimit: false } }, async () => ({ ok: true }));

  registerAuthRoutes(app, db, config);

  // Dev-only raw-G-address login (see routes/dev-auth.ts's module doc comment) — never wired up
  // unless explicitly opted into, and never the default even in local dev, so it can't be reached
  // by accident.
  if (process.env.ENABLE_DEV_LOGIN === "true") {
    app.log.warn(
      "services/api: ENABLE_DEV_LOGIN=true — /v1/auth/dev-login is active (no proof of Stellar key ownership). Never set this in production.",
    );
    registerDevAuthRoutes(app, db, config);
  }

  registerAssetRoutes(app, db);
  registerCreditLineRoutes(app, db, contracts);
  registerExitRoutes(app, db, contracts);
  registerRepoRoutes(app, db, contracts);
  registerPositionRoutes(app, db);
  registerReportRoutes(app, db);

  return app;
}
