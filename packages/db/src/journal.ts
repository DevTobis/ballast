/**
 * Postgres double-entry books (PRD §6.5: "Postgres double-entry books mirroring on-chain
 * state"). Every logical event (a draw, a repayment, a payout-hop leg, ...) must land as a
 * balanced pair of `journal_entry` rows — one debit, one credit, same amount, same currency —
 * never as a single unbalanced row. `recordJournalEntry` enforces the per-row shape (exactly one
 * of debit/credit is nonzero); `recordDoubleEntry` is the only sanctioned way to record a full
 * event, inserting both rows atomically inside one transaction.
 *
 * Lives in `@ballast/db` (not `services/ledger`) specifically so every service that touches
 * Postgres can book through it directly — a prior version lived in `services/ledger` with a
 * comment saying other services should call it, but nothing outside a Node package can import
 * another service's `src/`, so `services/payout-hop` ended up writing an unbalanced single-leg
 * row by hand instead. Don't reintroduce that split.
 */
import { scaledToDecimalString } from "@ballast/domain-types";
import * as schema from "./schema.js";
import type { Database } from "./client.js";

/** Drizzle's transaction callback receives a `tx` object, not the top-level `Database` — this
 * covers both so `recordJournalEntry` can be called standalone or from inside `recordDoubleEntry`'s
 * transaction. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

export interface JournalEntryArgs {
  refType: string;
  refId: string;
  account: string;
  debit: bigint;
  credit: bigint;
  ccy: string;
}

/**
 * Thin insert wrapper into `journal_entry`. Enforces that a single row is either a debit leg or a
 * credit leg — never both, never neither — since a row that's both/neither can't be part of a
 * balanced pair. Use `recordDoubleEntry` to record a full logical event.
 */
export async function recordJournalEntry(db: DbOrTx, args: JournalEntryArgs): Promise<void> {
  if (args.debit < 0n || args.credit < 0n) {
    throw new Error("journal: entry amounts must not be negative");
  }
  const isDebitLeg = args.debit > 0n;
  const isCreditLeg = args.credit > 0n;
  if (isDebitLeg === isCreditLeg) {
    throw new Error(
      "journal: a journal_entry row must be exactly one of a debit leg or a credit leg (got " +
        `debit=${args.debit}, credit=${args.credit}) — use recordDoubleEntry for a balanced pair`,
    );
  }

  await db.insert(schema.journalEntry).values({
    refType: args.refType,
    refId: args.refId,
    account: args.account,
    debit: scaledToDecimalString(args.debit),
    credit: scaledToDecimalString(args.credit),
    ccy: args.ccy,
  });
}

export interface DoubleEntryArgs {
  refType: string;
  refId: string;
  debitAccount: string;
  creditAccount: string;
  amount: bigint;
  ccy: string;
}

/**
 * Records one logical event as a balanced pair of `journal_entry` rows, atomically. This is the
 * only sanctioned way to book an event — never insert a lone `journal_entry` row directly.
 */
export async function recordDoubleEntry(db: Database, args: DoubleEntryArgs): Promise<void> {
  if (args.amount <= 0n) {
    throw new Error("journal: recordDoubleEntry amount must be positive");
  }

  await db.transaction(async (trx) => {
    await recordJournalEntry(trx, {
      refType: args.refType,
      refId: args.refId,
      account: args.debitAccount,
      debit: args.amount,
      credit: 0n,
      ccy: args.ccy,
    });
    await recordJournalEntry(trx, {
      refType: args.refType,
      refId: args.refId,
      account: args.creditAccount,
      debit: 0n,
      credit: args.amount,
      ccy: args.ccy,
    });
  });
}
