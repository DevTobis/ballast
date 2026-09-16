import { createDatabase, schema } from "@ballast/db";
import { eq } from "drizzle-orm";
import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import { createLogger } from "@ballast/observability";
import { CreditLineClient } from "@ballast/contract-clients";
import { recomputeLine } from "./monitor.js";

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

async function pollOnce(): Promise<void> {
  const openLines = await db.select().from(schema.creditLine).where(eq(schema.creditLine.status, "open"));

  for (const line of openLines) {
    if (!line.contractLineId) {
      continue; // not yet opened on-chain
    }
    try {
      const result = await recomputeLine(db, creditLineClient, {
        id: line.id,
        contractLineId: line.contractLineId,
      });
      if (result.changed) {
        logger.info(
          { lineId: line.id, from: result.fromState, to: result.toState, ltvBps: result.ltvBps },
          "margin-monitor: margin state changed",
        );
      }
    } catch (err) {
      logger.error({ err, lineId: line.id }, "margin-monitor: recompute failed for line");
    }
  }
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      logger.error({ err }, "margin-monitor: poll pass failed");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop();
logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "margin-monitor service started");
