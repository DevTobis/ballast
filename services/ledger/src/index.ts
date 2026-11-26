import cron from "node-cron";
import { createDatabase } from "@ballast/db";
import { createLogger } from "@ballast/observability";
import { runReconciliation } from "./reconcile.js";

const logger = createLogger("ledger");
const db = createDatabase();

/** PRD §6.5: "nightly on-chain vs. database reconciliation". Default 2am, env-configurable. */
const CRON_EXPR = process.env.LEDGER_RECONCILIATION_CRON ?? "0 2 * * *";

export function startReconciliationSchedule(cronExpr = CRON_EXPR): cron.ScheduledTask {
  return cron.schedule(cronExpr, async () => {
    logger.info("ledger: starting nightly reconciliation");
    try {
      const { breaks, report } = await runReconciliation(db);
      logger.info({ breaks, comparedAssets: report.comparedAssets }, "ledger: reconciliation complete");
    } catch (err) {
      logger.error({ err }, "ledger: reconciliation run failed");
    }
  });
}

if (
  process.env.VITEST !== "true" &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("dist/index.js") ||
    process.argv[1]?.endsWith("src/index.ts"))
) {
  startReconciliationSchedule();
  logger.info({ cronExpr: CRON_EXPR }, "ledger: reconciliation schedule started");
}
