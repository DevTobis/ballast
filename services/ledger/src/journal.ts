/**
 * Re-exports `@ballast/db`'s double-entry journal helpers. This used to be defined here, but a
 * copy that only `services/ledger` could import meant nothing else could actually book through
 * it — `services/payout-hop` ended up writing an unbalanced single-leg `journal_entry` row by
 * hand instead of using it. The real implementation now lives in `@ballast/db` (every service
 * that touches Postgres already depends on it); this re-export just keeps existing imports in
 * this service working.
 */
export { recordJournalEntry, recordDoubleEntry, type DbOrTx, type JournalEntryArgs, type DoubleEntryArgs } from "@ballast/db";
