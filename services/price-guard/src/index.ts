import cron from "node-cron";
import { createDatabase, schema } from "@ballast/db";
import { eq } from "drizzle-orm";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { checkOperatorBalance, createConsoleAlerter, createLogger } from "@ballast/observability";
import { PriceGuardClient } from "@ballast/contract-clients";
import type { AssetConfig } from "@ballast/domain-types";
import { createOperatorSigner } from "@ballast/operator-signing";
import { createGuardedRunner, shouldRunOnStart } from "./cycleGuard.js";
import { runPriceUpdateCycle } from "./pipeline.js";
import { decimalStringToScaled } from "./scaled.js";

const logger = createLogger("price-guard");
const alerter = createConsoleAlerter("price-guard");
const db = createDatabase();
const network = loadNetworkConfig();

// PRICE_GUARD_PUBLISH=false: shadow run - record real readings and flag disagreement, but send
// nothing on-chain, so no PriceGuard contract or publisher key is needed.
const shadow = process.env.PRICE_GUARD_PUBLISH === "false";

const priceGuardClient = shadow
  ? null
  : new PriceGuardClient({ network, contractId: requireContractId(network, "priceGuard") });

const signer = shadow ? null : await createOperatorSigner("price-publisher", network.networkPassphrase);

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

const triggerGuardedCycle = createGuardedRunner(async () => {
  const rows = await db.select().from(schema.asset).where(eq(schema.asset.status, "active"));
  const assets = rows.map(toAssetConfig);
  await runPriceUpdateCycle(db, priceGuardClient, signer, assets);
  logger.info({ count: assets.length }, "price-guard: cycle complete");
}, logger);

cron.schedule(CRON_EXPR, () => {
  void triggerGuardedCycle();
});

if (shouldRunOnStart()) {
  void triggerGuardedCycle();
}

// The publisher pays the fee on every price it pushes; a dry account freezes the on-chain price
// and, once it goes stale, every draw with it. Checked every 30 minutes (not in shadow mode, where
// nothing is sent on-chain).
if (signer) {
  const checkBalance = () =>
    checkOperatorBalance(alerter, { horizonUrl: network.horizonUrl, account: signer.publicKey(), label: "price-publisher" }).catch(
      (err) => logger.error({ err }, "price-guard: balance check failed"),
    );
  cron.schedule("*/30 * * * *", checkBalance);
  void checkBalance();
}

logger.info({ cron: CRON_EXPR, shadow }, "price-guard service started");
