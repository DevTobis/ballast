import { createDatabase } from "@ballast/db";
import { loadNetworkConfig } from "@ballast/network-config";
import { createLogger, createConsoleAlerter } from "@ballast/observability";
import { createRpcClient } from "./rpc.js";
import { pollOnce, runIndexerCycle, type IndexerState } from "./poller.js";
import { shouldAlertLag, DEFAULT_LAG_ALERT_SECONDS, LEDGER_CLOSE_SECONDS } from "./lag.js";

const logger = createLogger("indexer");
const alerter = createConsoleAlerter("indexer");

const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 5000);
const LAG_ALERT_SECONDS = Number(process.env.INDEXER_LAG_ALERT_SECONDS ?? DEFAULT_LAG_ALERT_SECONDS);
const LAG_ALERT_LEDGERS = Math.ceil(
  (!Number.isNaN(LAG_ALERT_SECONDS) && LAG_ALERT_SECONDS > 0 ? LAG_ALERT_SECONDS : DEFAULT_LAG_ALERT_SECONDS) /
    LEDGER_CLOSE_SECONDS,
);

/**
 * Contracts to watch. PRD §6.5: the indexer ingests CAP-67 and contract events for every Ballast
 * contract; `network-config` gives us the deployed ids (undefined ones are skipped, e.g. before
 * a contract is deployed in a given environment).
 */
function watchedContractIds(network: ReturnType<typeof loadNetworkConfig>): string[] {
  return Object.values(network.contracts).filter((id): id is string => Boolean(id));
}

async function main() {
  const db = createDatabase();
  const network = loadNetworkConfig();
  const rpcServer = createRpcClient(network.rpcUrl);
  const contractIds = watchedContractIds(network);

  if (contractIds.length === 0) {
    logger.warn("indexer: no contract ids configured in network-config — polling will fetch no events");
  }

  logger.info({ contractIds, pollIntervalMs: POLL_INTERVAL_MS }, "indexer: starting poll loop");

  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });

  const state: IndexerState = {};

  while (!stopped) {
    try {
      const result = await runIndexerCycle(db, rpcServer, contractIds, state, alerter, LAG_ALERT_LEDGERS);
      if (shouldAlertLag(result.latestLedger, result.fromLedger, LAG_ALERT_SECONDS)) {
        logger.warn(
          { latestLedger: result.latestLedger, fromLedger: result.fromLedger, lagAlertSeconds: LAG_ALERT_SECONDS },
          "indexer: RPC lag exceeded configured alert threshold",
        );
      }
      if (result.skippedFrom !== undefined && result.skippedTo !== undefined) {
        logger.warn(
          { fromLedger: result.skippedFrom, toLedger: result.skippedTo },
          "indexer: events skipped because the resume cursor is older than the RPC retention window",
        );
      }
      logger.info(result, "indexer: poll complete");
    } catch (err) {
      logger.error({ err }, "indexer: poll failed");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
