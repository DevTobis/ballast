import cron from "node-cron";
import { createDatabase } from "@ballast/db";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { createLogger } from "@ballast/observability";
import { CreditLineClient, RepoDvpClient } from "@ballast/contract-clients";
import { createOperatorSigner } from "@ballast/operator-signing";
import { runRepoUnwindJob } from "./jobs/repoUnwind.js";
import { runCureExpiryJob } from "./jobs/cureExpiry.js";
import { runInterestAccrualJob } from "./jobs/interestAccrual.js";
import { runSyncCollateralJob } from "./jobs/syncCollateral.js";
import type { JobResult } from "./jobs/types.js";

const logger = createLogger("keeper");
const db = createDatabase();
const network = loadNetworkConfig();
const signer = await createOperatorSigner("keeper", network.networkPassphrase);

const creditLineClient = new CreditLineClient({
  network,
  contractId: requireContractId(network, "creditLine"),
});
const repoDvpClient = new RepoDvpClient({
  network,
  contractId: requireContractId(network, "repoDvp"),
});

async function runJob(name: string, fn: () => Promise<JobResult>): Promise<void> {
  logger.info({ job: name }, "keeper: job starting");
  try {
    const result = await fn();
    logger.info(
      { job: name, processed: result.processed, skipped: result.skipped, errors: result.errors.length },
      "keeper: job finished",
    );
    for (const e of result.errors) {
      logger.error({ job: name, id: e.id, message: e.message }, "keeper: row failed within job");
    }
  } catch (err) {
    logger.error({ job: name, err }, "keeper: job crashed");
  }
}

// PRD §6.5 defaults: repo leg 2 and cure-window expiries every 5 minutes; interest accrual
// checkpoints hourly. All configurable via env.
const REPO_UNWIND_CRON = process.env.KEEPER_REPO_UNWIND_CRON ?? "*/5 * * * *";
const CURE_EXPIRY_CRON = process.env.KEEPER_CURE_EXPIRY_CRON ?? "*/5 * * * *";
const INTEREST_ACCRUAL_CRON = process.env.KEEPER_INTEREST_ACCRUAL_CRON ?? "0 * * * *";
// Runs before cure-expiry/interest-accrual in wall-clock terms often enough that CreditLine's LTV
// view reflects recent pledges — every 5 minutes, same cadence as the other position-sensitive
// jobs. Without this job, `pledged_units` never leaves 0 and every draw fails (see the job's doc
// comment).
const SYNC_COLLATERAL_CRON = process.env.KEEPER_SYNC_COLLATERAL_CRON ?? "*/5 * * * *";

cron.schedule(REPO_UNWIND_CRON, () => runJob("repo-unwind", () => runRepoUnwindJob(db, repoDvpClient, signer)));
cron.schedule(CURE_EXPIRY_CRON, () => runJob("cure-expiry", () => runCureExpiryJob(db, creditLineClient, signer)));
cron.schedule(INTEREST_ACCRUAL_CRON, () =>
  runJob("interest-accrual", () => runInterestAccrualJob(db, creditLineClient, signer)),
);
cron.schedule(SYNC_COLLATERAL_CRON, () =>
  runJob("sync-collateral", () => runSyncCollateralJob(db, creditLineClient, signer)),
);

logger.info(
  { REPO_UNWIND_CRON, CURE_EXPIRY_CRON, INTEREST_ACCRUAL_CRON, SYNC_COLLATERAL_CRON },
  "keeper: scheduled jobs registered",
);
