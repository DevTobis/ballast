import cron from "node-cron";
import { createDatabase } from "@ballast/db";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { checkOperatorBalance, createConsoleAlerter, createLogger } from "@ballast/observability";
import { CreditLineClient, PledgeVaultClient, RepoDvpClient } from "@ballast/contract-clients";
import { createOperatorSigner } from "@ballast/operator-signing";
import { runRepoUnwindJob } from "./jobs/repoUnwind.js";
import { runRepoMarginJob } from "./jobs/repoMargin.js";
import { runCureExpiryJob } from "./jobs/cureExpiry.js";
import { runInterestAccrualJob } from "./jobs/interestAccrual.js";
import { runSyncCollateralJob } from "./jobs/syncCollateral.js";
import type { JobResult } from "./jobs/types.js";

const logger = createLogger("keeper");
const alerter = createConsoleAlerter("keeper");
const db = createDatabase();
const network = loadNetworkConfig();
const signer = await createOperatorSigner("keeper", network.networkPassphrase);

const creditLineClient = new CreditLineClient({
  network,
  contractId: requireContractId(network, "creditLine"),
});
const pledgeVaultClient = new PledgeVaultClient({
  network,
  contractId: requireContractId(network, "pledgeVault"),
});
const repoDvpClient = new RepoDvpClient({
  network,
  contractId: requireContractId(network, "repoDvp"),
});

// Every job signs with the one keeper account, and a Stellar account's transactions must land in
// sequence-number order — two jobs building transactions at the same moment would both take the
// same number and one would be rejected. So jobs queue up behind each other.
let queue: Promise<void> = Promise.resolve();

// Set to true once shutdown is initiated; prevents new ticks from entering the queue.
let shuttingDown = false;

function runJob(name: string, fn: () => Promise<JobResult>): Promise<void> {
  if (shuttingDown) {
    logger.info({ job: name }, "keeper: shutdown in progress — skipping new job");
    return Promise.resolve();
  }
  queue = queue.then(() => execute(name, fn));
  return queue;
}

async function execute(name: string, fn: () => Promise<JobResult>): Promise<void> {
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
const REPO_MARGIN_CRON = process.env.KEEPER_REPO_MARGIN_CRON ?? "*/5 * * * *";
// The keeper pays the fee on every margin call, liquidation, unwind and sync: if its account runs
// dry they all stop, so it is checked hourly.
const BALANCE_CRON = process.env.KEEPER_BALANCE_CRON ?? "7 * * * *";
const CURE_EXPIRY_CRON = process.env.KEEPER_CURE_EXPIRY_CRON ?? "*/5 * * * *";
const INTEREST_ACCRUAL_CRON = process.env.KEEPER_INTEREST_ACCRUAL_CRON ?? "0 * * * *";
// Every minute: a pledge only counts toward a line's LTV (and so only unlocks a draw) once this
// has pushed it on-chain, and the job submits nothing for a line that's already in sync.
const SYNC_COLLATERAL_CRON = process.env.KEEPER_SYNC_COLLATERAL_CRON ?? "* * * * *";

// Grace period (ms) to wait for the running job to finish before forcing exit.
const SHUTDOWN_GRACE_MS = Number(process.env.KEEPER_SHUTDOWN_GRACE_MS ?? "60000");

const tasks = [
  cron.schedule(REPO_UNWIND_CRON, () => runJob("repo-unwind", () => runRepoUnwindJob(db, repoDvpClient, signer))),
  cron.schedule(REPO_MARGIN_CRON, () => runJob("repo-margin", () => runRepoMarginJob(db, repoDvpClient, signer))),
  cron.schedule(BALANCE_CRON, () => {
    checkOperatorBalance(alerter, { horizonUrl: network.horizonUrl, account: signer.publicKey(), label: "keeper" }).catch((err) =>
      logger.error({ err }, "keeper: balance check failed"),
    );
  }),
  cron.schedule(CURE_EXPIRY_CRON, () =>
    runJob("cure-expiry", () => runCureExpiryJob(db, creditLineClient, pledgeVaultClient, signer)),
  ),
  cron.schedule(INTEREST_ACCRUAL_CRON, () =>
    runJob("interest-accrual", () => runInterestAccrualJob(db, creditLineClient, signer)),
  ),
  cron.schedule(SYNC_COLLATERAL_CRON, () =>
    runJob("sync-collateral", () => runSyncCollateralJob(db, creditLineClient, pledgeVaultClient, signer)),
  ),
];

logger.info(
  { REPO_UNWIND_CRON, REPO_MARGIN_CRON, CURE_EXPIRY_CRON, INTEREST_ACCRUAL_CRON, SYNC_COLLATERAL_CRON },
  "keeper: scheduled jobs registered",
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal: force-exit immediately.
    logger.warn({ signal }, "keeper: second signal received — forcing exit");
    process.exit(1);
  }

  shuttingDown = true;
  logger.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, "keeper: shutdown signal received — stopping cron tasks");

  // 1. Stop all scheduled tasks so no new ticks fire.
  for (const task of tasks) {
    task.stop();
  }
  logger.info("keeper: all cron tasks stopped");

  // 2. Wait for the running job (if any) to finish, bounded by the grace period.
  const gracePeriod = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  const winner = await Promise.race([
    queue.then(() => "queue" as const),
    gracePeriod.then(() => "timeout" as const),
  ]);

  if (winner === "timeout") {
    logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, "keeper: grace period elapsed — job may not have finished cleanly");
  } else {
    logger.info("keeper: in-flight job finished");
  }

  // 3. Close the database pool.
  logger.info("keeper: closing database pool");
  try {
    await db.$client.end();
    logger.info("keeper: database pool closed");
  } catch (err) {
    logger.error({ err }, "keeper: error closing database pool");
  }

  logger.info("keeper: shutdown complete — exiting 0");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
