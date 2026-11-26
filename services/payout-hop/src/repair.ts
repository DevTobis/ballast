/**
 * Books payouts that were sent but whose bookkeeping failed (`payout_forward.status =
 * 'bookkeeping_pending'`, see `forwardPayout`). Safe to run any number of times, from any number of
 * processes: each row is taken by a conditional update inside its own transaction, and a row whose
 * journal pair already exists (the original write committed but the acknowledgement was lost) is
 * only marked `sent`, not booked again.
 */
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { decimalStringToScaled } from "@ballast/domain-types";
import type { Alerter } from "@ballast/observability";
import { bookPayout } from "./hop.js";

export interface RepairResult {
  /** First-leg hashes whose journal pair this run wrote. */
  booked: string[];
  /** First-leg hashes that turned out to be booked already; only their status was fixed. */
  alreadyBooked: string[];
  /** First-leg hashes that still could not be booked; they stay `bookkeeping_pending`. */
  failed: string[];
}

export async function bookPendingPayouts(db: Database, alerter: Alerter): Promise<RepairResult> {
  const result: RepairResult = { booked: [], alreadyBooked: [], failed: [] };
  const pending = await db
    .select()
    .from(schema.payoutForward)
    .where(eq(schema.payoutForward.status, "bookkeeping_pending"));

  for (const row of pending) {
    try {
      const outcome = await db.transaction(async (trx) => {
        // Taking the row first locks it, so a concurrent repair waits here and then finds it gone.
        const taken = await trx
          .update(schema.payoutForward)
          .set({ status: "sent" })
          .where(
            and(
              eq(schema.payoutForward.fromTxHash, row.fromTxHash),
              eq(schema.payoutForward.status, "bookkeeping_pending"),
            ),
          )
          .returning({ fromTxHash: schema.payoutForward.fromTxHash });
        if (taken.length === 0) return "taken";

        const existing = await trx
          .select({ id: schema.journalEntry.id })
          .from(schema.journalEntry)
          .where(and(eq(schema.journalEntry.refType, "payout_hop"), eq(schema.journalEntry.refId, row.refId)))
          .limit(1);
        if (existing.length > 0) return "already";

        // `markUnbooked` writes the hash together with the status, so this only trips on a hand edit.
        if (!row.txHash) throw new Error("bookkeeping_pending row has no tx_hash");
        await bookPayout(trx, {
          fromTxHash: row.fromTxHash,
          txHash: row.txHash,
          refId: row.refId,
          quoteId: row.quoteId,
          amount: decimalStringToScaled(row.amount),
          memo: row.memo,
        });
        return "booked";
      });
      if (outcome === "booked") result.booked.push(row.fromTxHash);
      if (outcome === "already") result.alreadyBooked.push(row.fromTxHash);
    } catch (err) {
      result.failed.push(row.fromTxHash);
      alerter.fire("payout_unbooked", {
        subject: row.fromTxHash,
        txHash: row.txHash,
        refId: row.refId,
        reason: `repair could not book it: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return result;
}
