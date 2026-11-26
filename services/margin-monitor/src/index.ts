import { createDatabase } from "@ballast/db";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { createLogger } from "@ballast/observability";
import { CreditLineClient } from "@ballast/contract-clients";
import { pollOnce } from "./poll.js";

const logger = createLogger("margin-monitor");
const db = createDatabase();
const network = loadNetworkConfig();

const creditLineClient = new CreditLineClient({
  network,
  contractId: requireContractId(network, "creditLine"),
});

// PRD §6.5: recomputes on every price update and position event; this polling loop is a "short
// interval" stand-in for that until the indexer's chain_event stream drives it directly.
const POLL_INTERVAL_MS = Number(process.env.MARGIN_MONITOR_POLL_MS ?? 15_000);

async function loop(): Promise<void> {
  for (;;) {
    try {
      await pollOnce(db, creditLineClient, logger);
    } catch (err) {
      logger.error({ err }, "margin-monitor: poll pass failed");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop();
logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "margin-monitor service started");
