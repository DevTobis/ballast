import cron from "node-cron";
import { createDatabase, createRawClient, type Database } from "@ballast/db";
import { loadNetworkConfig, requireContractId, type NetworkConfig } from "@ballast/network-config";
import { checkOperatorBalance, createConsoleAlerter, createLogger } from "@ballast/observability";
import { CreditLineClient, PledgeVaultClient, RepoDvpClient } from "@ballast/contract-clients";
import { createOperatorSigner, type KmsSigner } from "@ballast/operator-signing";
import { executeJobWithLock, PostgresLockProvider, type LockProvider } from "./lock.js";
import { createJobQueue } from "./jobQueue.js";
import { runRepoUnwindJob } from "./jobs/repoUnwind.js";
import { runRepoMarginJob } from "./jobs/repoMargin.js";
import { runCureExpiryJob } from "./jobs/cureExpiry.js";
import { runInterestAccrualJob } from "./jobs/interestAccrual.js";
import { runSyncCollateralJob } from "./jobs/syncCollateral.js";
import type { JobResult } from "./jobs/types.js";

export interface KeeperContext {
  logger: ReturnType<typeof createLogger>;
  alerter: ReturnType<typeof createConsoleAlerter>;
  db: Database;
  rawSql: ReturnType<typeof createRawClient>;
  network: NetworkConfig;
  signer: KmsSigner;
  creditLineClient: CreditLineClient;
  pledgeVaultClient: PledgeVaultClient;
  repoDvpClient: RepoDvpClient;
  lockProvider: LockProvider;
  jobQueue: ReturnType<typeof createJobQueue>;
}

export async function createKeeperContext(): Promise<KeeperContext> {
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

  const rawSql = createRawClient();
  const lockProvider = new PostgresLockProvider(rawSql);

  const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
  const configuredTimeout = Number(process.env.KEEPER_JOB_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS);
  const JOB_TIMEOUT_MS =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_JOB_TIMEOUT_MS;

  const jobQueue = createJobQueue({
    timeoutMs: JOB_TIMEOUT_MS,
    logger,
    onTimeout: (job) => alerter.fire("keeper_job_timeout", { job, timeoutMs: JOB_TIMEOUT_MS }),
  });

  return {
    logger,
    alerter,
    db,
    rawSql,
    network,
    signer,
    creditLineClient,
    pledgeVaultClient,
    repoDvpClient,
    lockProvider,
    jobQueue,
  };
}

/** Job names accepted by `runSingleJob` and the run-once CLI (`src/cli.ts`). */
export const KEEPER_JOBS = [
  "cure-expiry",
  "repo-unwind",
  "repo-margin",
  "interest-accrual",
  "sync-collateral",
  "balance",
] as const;

/** Runs one job once, outside the scheduler. The caller is responsible for the advisory lock. */
export async function runSingleJob(name: string, ctx: KeeperContext): Promise<JobResult> {
  const { db, creditLineClient, pledgeVaultClient, repoDvpClient, signer, alerter, network } = ctx;
  switch (name) {
    case "repo-unwind":
      return runRepoUnwindJob(db, repoDvpClient, signer, network);
    case "repo-margin":
      return runRepoMarginJob(db, repoDvpClient, signer, new Date(), network);
    case "cure-expiry":
      return runCureExpiryJob(db, creditLineClient, pledgeVaultClient, signer, network);
    case "interest-accrual":
      return runInterestAccrualJob(db, creditLineClient, signer, network);
    case "sync-collateral":
      return runSyncCollateralJob(db, creditLineClient, pledgeVaultClient, signer, network);
    case "balance": {
      await checkOperatorBalance(alerter, {
        horizonUrl: network.horizonUrl,
        account: signer.publicKey(),
        label: "keeper",
      });
      return { processed: 1, skipped: 0, errors: [] };
    }
    default:
      throw new Error(`Unknown job: "${name}". Valid jobs: ${KEEPER_JOBS.join(", ")}`);
  }
}

export function execute(
  name: string,
  fn: () => Promise<JobResult>,
  lockProvider: LockProvider,
  logger: ReturnType<typeof createLogger>,
): Promise<boolean> {
  return executeJobWithLock(name, fn, lockProvider, logger);
}

export async function main(): Promise<void> {
  const ctx = await createKeeperContext();
  const {
    logger,
    alerter,
    db,
    rawSql,
    network,
    signer,
    creditLineClient,
    pledgeVaultClient,
    repoDvpClient,
    lockProvider,
    jobQueue,
  } = ctx;

  let shuttingDown = false;

  function runJob(name: string, fn: () => Promise<JobResult>): Promise<void> {
    if (shuttingDown) {
      logger.info({ job: name }, "keeper: shutdown in progress — skipping new job");
      return Promise.resolve();
    }
    return jobQueue.run(name, () => executeJobWithLock(name, fn, lockProvider, logger));
  }

  // PRD §6.5 defaults: repo leg 2 and cure-window expiries every 5 minutes; interest accrual
  // checkpoints hourly. All configurable via env.
  const REPO_UNWIND_CRON = process.env.KEEPER_REPO_UNWIND_CRON ?? "*/5 * * * *";
  const REPO_MARGIN_CRON = process.env.KEEPER_REPO_MARGIN_CRON ?? "*/5 * * * *";
  const BALANCE_CRON = process.env.KEEPER_BALANCE_CRON ?? "7 * * * *";
  const CURE_EXPIRY_CRON = process.env.KEEPER_CURE_EXPIRY_CRON ?? "*/5 * * * *";
  const INTEREST_ACCRUAL_CRON = process.env.KEEPER_INTEREST_ACCRUAL_CRON ?? "0 * * * *";
  const SYNC_COLLATERAL_CRON = process.env.KEEPER_SYNC_COLLATERAL_CRON ?? "* * * * *";

  const SHUTDOWN_GRACE_MS = Number(process.env.KEEPER_SHUTDOWN_GRACE_MS ?? "60000");

  const tasks = [
    cron.schedule(REPO_UNWIND_CRON, () => runJob("repo-unwind", () => runRepoUnwindJob(db, repoDvpClient, signer, network))),
    cron.schedule(REPO_MARGIN_CRON, () => runJob("repo-margin", () => runRepoMarginJob(db, repoDvpClient, signer, new Date(), network))),
    cron.schedule(BALANCE_CRON, () => {
      checkOperatorBalance(alerter, {
        horizonUrl: network.horizonUrl,
        account: signer.publicKey(),
        label: "keeper",
      }).catch((err) => logger.error({ err }, "keeper: balance check failed"));
    }),
    cron.schedule(CURE_EXPIRY_CRON, () =>
      runJob("cure-expiry", () => runCureExpiryJob(db, creditLineClient, pledgeVaultClient, signer, network)),
    ),
    cron.schedule(INTEREST_ACCRUAL_CRON, () =>
      runJob("interest-accrual", () => runInterestAccrualJob(db, creditLineClient, signer, network)),
    ),
    cron.schedule(SYNC_COLLATERAL_CRON, () =>
      runJob("sync-collateral", () => runSyncCollateralJob(db, creditLineClient, pledgeVaultClient, signer, network)),
    ),
  ];

  logger.info(
    { REPO_UNWIND_CRON, REPO_MARGIN_CRON, CURE_EXPIRY_CRON, INTEREST_ACCRUAL_CRON, SYNC_COLLATERAL_CRON },
    "keeper: scheduled jobs registered",
  );

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.warn({ signal }, "keeper: second signal received — forcing exit");
      process.exit(1);
    }

    shuttingDown = true;
    logger.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, "keeper: shutdown signal received — stopping cron tasks");

    for (const task of tasks) {
      task.stop();
    }
    logger.info("keeper: all cron tasks stopped");

    const gracePeriod = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    const winner = await Promise.race([
      jobQueue.idle().then(() => "queue" as const),
      gracePeriod.then(() => "timeout" as const),
    ]);

    if (winner === "timeout") {
      logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, "keeper: grace period elapsed — job may not have finished cleanly");
    } else {
      logger.info("keeper: in-flight job finished");
    }

    logger.info("keeper: closing database pool");
    try {
      await Promise.all([db.$client.end(), rawSql.end()]);
      logger.info("keeper: database pool closed");
    } catch (err) {
      logger.error({ err }, "keeper: error closing database pool");
    }

    logger.info("keeper: shutdown complete — exiting 0");
    process.exit(0);
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (
  process.env.VITEST !== "true" &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith("dist/index.js") ||
    process.argv[1]?.endsWith("src/index.ts"))
) {
  main().catch((err) => {
    console.error("keeper fatal startup error:", err);
    process.exit(1);
  });
}
