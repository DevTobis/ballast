import cron from "node-cron";
import { createDatabase, schema } from "@ballast/db";
import { eq } from "drizzle-orm";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { createLogger } from "@ballast/observability";
import { PriceGuardClient } from "@ballast/contract-clients";
import type { AssetConfig } from "@ballast/domain-types";
import { createOperatorSigner } from "@ballast/operator-signing";
import { runPriceUpdateCycle } from "./pipeline.js";
import { decimalStringToScaled } from "./scaled.js";

const logger = createLogger("price-guard");
const db = createDatabase();
const network = loadNetworkConfig();

const priceGuardClient = new PriceGuardClient({
  network,
  contractId: requireContractId(network, "priceGuard"),
});

const signer = await createOperatorSigner("price-publisher", network.networkPassphrase);

// PRD §5 Phase 1: "every 60s is a reasonable default", configurable via env.
const CRON_EXPR = process.env.PRICE_GUARD_CRON ?? "*/1 * * * *";

function toAssetConfig(row: typeof schema.asset.$inferSelect): AssetConfig {
  return {
    id: row.id,
    code: row.code,
    issuerG: row.issuerG,
    issuerCode: row.issuerCode,
    contractC: row.contractC,
    standard: row.standard,
    yieldType: row.yieldType,
    custodyMode: row.custodyMode,
    ccy: row.ccy,
    redemptionLagDays: row.redemptionLagDays,
    redemptionDailyCap: row.redemptionDailyCap ? decimalStringToScaled(row.redemptionDailyCap) : 0n,
    navSchedule: row.navSchedule,
    priceBandBps: row.priceBandBps,
    dailyMoveBandBps: row.dailyMoveBandBps,
    haircutBaseBps: row.haircutBaseBps,
    haircutFxBps: row.haircutFxBps,
    status: row.status,
  };
}

cron.schedule(CRON_EXPR, async () => {
  try {
    const rows = await db.select().from(schema.asset).where(eq(schema.asset.status, "active"));
    const assets = rows.map(toAssetConfig);
    await runPriceUpdateCycle(db, priceGuardClient, signer, assets);
    logger.info({ count: assets.length }, "price-guard: cycle complete");
  } catch (err) {
    logger.error({ err }, "price-guard: cycle failed");
  }
});

logger.info({ cron: CRON_EXPR }, "price-guard service started");
