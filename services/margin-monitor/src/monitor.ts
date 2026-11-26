/**
 * PRD §6.5: "Recomputes LTV on every price update and position event; drives the margin state
 * machine; calls liquidation." The LTV/state read here always comes from the CreditLine
 * contract's own `ltv()` view (never recomputed off-chain), so this service can't drift from the
 * value the contract itself would use for a real liquidation.
 *
 * Boundary: this service's job ends at writing the `margin_event` row and firing an internal
 * alert. Webhooks to subscribers are services/api's outbox (`webhooks/outbox.ts`), which scans
 * new `margin_event` rows and enqueues one signed delivery per matching subscription; this
 * service does not call services/api directly.
 *
 * Calling `liquidate` itself is services/keeper's job (see `cureExpiry.ts`), triggered once the
 * cure window on a `MarginCall` state has elapsed — this service only detects and records state
 * transitions.
 */
import { desc, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { createConsoleAlerter } from "@ballast/observability";
import type { MarginState } from "@ballast/domain-types";
import type { CreditLineClient } from "@ballast/contract-clients";

const alerter = createConsoleAlerter("margin-monitor");

export interface CreditLineRef {
  /** Postgres `credit_line.id` (uuid). */
  id: string;
  /** On-chain `CreditLine` line id, as text (mirrors `credit_line.contract_line_id`). */
  contractLineId: string;
}

export interface RecomputeLineResult {
  changed: boolean;
  fromState: MarginState | null;
  toState: MarginState;
  ltvBps: number;
}

export async function recomputeLine(
  db: Database,
  creditLineClient: CreditLineClient,
  line: CreditLineRef,
): Promise<RecomputeLineResult> {
  // Read-only; @ballast/contract-clients simulates this against STELLAR_SIMULATION_SOURCE
  // internally rather than taking a caller argument (see that package's base-client.ts) — that
  // env var must be set wherever this service runs.
  const view = await creditLineClient.ltv(BigInt(line.contractLineId));

  const [lastEvent] = await db
    .select()
    .from(schema.marginEvent)
    .where(eq(schema.marginEvent.creditLineId, line.id))
    .orderBy(desc(schema.marginEvent.createdAt))
    .limit(1);

  const fromState = (lastEvent?.toState as MarginState | undefined) ?? null;
  const changed = fromState !== view.state;

  if (changed) {
    let priceSnapshotId: string | null = null;

    const [pledgeRow] = await db
      .select()
      .from(schema.pledge)
      .where(eq(schema.pledge.creditLineId, line.id))
      .limit(1);

    if (pledgeRow) {
      const [snapshot] = await db
        .select()
        .from(schema.priceSnapshot)
        .where(eq(schema.priceSnapshot.assetId, pledgeRow.assetId))
        .orderBy(desc(schema.priceSnapshot.createdAt))
        .limit(1);
      priceSnapshotId = snapshot?.id ?? null;
    }

    await db.insert(schema.marginEvent).values({
      creditLineId: line.id,
      fromState: fromState ?? "Healthy",
      toState: view.state,
      ltvBps: view.ltvBps,
      priceSnapshotId,
    });

    if (view.state === "MarginCall" || view.state === "Liquidation") {
      alerter.fire("margin_call", { creditLineId: line.id, state: view.state, ltvBps: view.ltvBps });
    } else if (fromState === "MarginCall" || fromState === "Liquidation") {
      alerter.fire("margin_recovered", {
        creditLineId: line.id,
        fromState,
        toState: view.state,
        ltvBps: view.ltvBps,
      });
    }
  }

  return { changed, fromState, toState: view.state, ltvBps: view.ltvBps };
}
