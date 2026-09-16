import { createDatabase } from "@ballast/db";
import { loadNetworkConfig } from "@ballast/network-config";
import { createLogger, createConsoleAlerter } from "@ballast/observability";
import { createRpcClient } from "./rpc.js";
import { pollOnce } from "./poller.js";

const logger = createLogger("indexer");
const alerter = createConsoleAlerter("indexer");

const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 5000);
const LEDGER_CLOSE_SECONDS = 5; // Stellar's approximate ledger close time
const LAG_ALERT_SECONDS = Number(process.env.INDEXER_LAG_ALERT_SECONDS ?? 60);
const LAG_ALERT_LEDGERS = Math.ceil(LAG_ALERT_SECONDS / LEDGER_CLOSE_SECONDS);

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

  while (!stopped) {
    try {
      const result = await pollOnce(db, rpcServer, contractIds);
      logger.info(result, "indexer: poll complete");

      const lagLedgers = result.latestLedger - result.fromLedger;
      if (lagLedgers > LAG_ALERT_LEDGERS) {
        alerter.fire("rpc_lag_high", {
          lagLedgers,
          latestLedger: result.latestLedger,
          lastIngestedFrom: result.fromLedger,
        });
      }
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
