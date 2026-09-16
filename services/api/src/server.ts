import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "@ballast/db";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { registerAuth } from "./auth.js";
import { getDb } from "./db.js";
import { getContractClients, type ContractClients } from "./contract-clients.js";
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

  registerAuth(app, config, db);

  // GET /v1/assets and /v1/assets/:id/price are public per PRD §9 (no auth required to browse
  // supported assets/prices); everything else needs a resolved partyId.
  app.get("/healthz", { config: { public: true } }, async () => ({ ok: true }));

  registerDevAuthRoutes(app, db, config);
  registerAssetRoutes(app, db);
  registerCreditLineRoutes(app, db, contracts);
  registerExitRoutes(app, db, contracts);
  registerRepoRoutes(app, db, contracts);
  registerPositionRoutes(app, db);
  registerReportRoutes(app, db);

  return app;
}
