import cron from "node-cron";
import { createDatabase, createRawClient } from "@ballast/db";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { checkOperatorBalance, createConsoleAlerter, createLogger } from "@ballast/observability";
import { CreditLineClient, PledgeVaultClient, RepoDvpClient } from "@ballast/contract-clients";
import { createOperatorSigner } from "@ballast/operator-signing";
import { executeJobWithLock, PostgresLockProvider, type LockProvider } from "./lock.js";
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
// Across multiple keeper instances or rolling restarts, a Postgres session-level advisory lock
// prevents duplicate job execution and sequence conflicts.
let queue: Promise<void> = Promise.resolve();
const rawSql = createRawClient();
const defaultLockProvider = new PostgresLockProvider(rawSql);

export function runJob(
  name: string,
  fn: () => Promise<JobResult>,
  lockProvider: LockProvider = defaultLockProvider,
): Promise<void> {
  queue = queue.then(async () => {
    await execute(name, fn, lockProvider);
  });
  return queue;
}

export function execute(
  name: string,
  fn: () => Promise<JobResult>,
  lockProvider: LockProvider = defaultLockProvider,
): Promise<boolean> {
  return executeJobWithLock(name, fn, lockProvider, logger);
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

cron.schedule(REPO_UNWIND_CRON, () => runJob("repo-unwind", () => runRepoUnwindJob(db, repoDvpClient, signer)));
cron.schedule(REPO_MARGIN_CRON, () => runJob("repo-margin", () => runRepoMarginJob(db, repoDvpClient, signer)));
cron.schedule(BALANCE_CRON, () => {
  checkOperatorBalance(alerter, { horizonUrl: network.horizonUrl, account: signer.publicKey(), label: "keeper" }).catch((err) =>
    logger.error({ err }, "keeper: balance check failed"),
  );
});
cron.schedule(CURE_EXPIRY_CRON, () =>
  runJob("cure-expiry", () => runCureExpiryJob(db, creditLineClient, pledgeVaultClient, signer)),
);
cron.schedule(INTEREST_ACCRUAL_CRON, () =>
  runJob("interest-accrual", () => runInterestAccrualJob(db, creditLineClient, signer)),
);
cron.schedule(SYNC_COLLATERAL_CRON, () =>
  runJob("sync-collateral", () => runSyncCollateralJob(db, creditLineClient, pledgeVaultClient, signer)),
);

logger.info(
  { REPO_UNWIND_CRON, REPO_MARGIN_CRON, CURE_EXPIRY_CRON, INTEREST_ACCRUAL_CRON, SYNC_COLLATERAL_CRON },
  "keeper: scheduled jobs registered",
);
