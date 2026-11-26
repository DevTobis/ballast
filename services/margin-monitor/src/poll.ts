import { schema, type Database } from "@ballast/db";
import { eq } from "drizzle-orm";
import type { CreditLineClient } from "@ballast/contract-clients";
import type { Logger } from "@ballast/observability";
import { recomputeLine } from "./monitor.js";

export async function pollOnce(
  db: Database,
  creditLineClient: CreditLineClient,
  logger: Pick<Logger, "info" | "error">,
  recomputeFn = recomputeLine,
): Promise<void> {
  const openLines = await db.select().from(schema.creditLine).where(eq(schema.creditLine.status, "open"));

  for (const line of openLines) {
    if (!line.contractLineId) {
      continue; // not yet opened on-chain
    }
    try {
      const result = await recomputeFn(db, creditLineClient, {
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
