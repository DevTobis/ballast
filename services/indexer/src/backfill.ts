/**
 * Backfill from the public Stellar ledger S3 data lake (PRD §6.5: "S3 data lake for backfill
 * (RPC keeps about 7 days; VERIFIED)").
 *
 * Soroban RPC's `getEvents` only retains ~7 days of history, so recovering from an outage longer
 * than that (or seeding a fresh environment against historical ledgers) requires reading the
 * public ledger data lake (`https://xdr.stellar.org` / the "history archives + captive-core
 * ledger export" pipeline) directly — downloading LedgerCloseMeta XDR from S3, decoding it, and
 * re-deriving the same `chain_event` rows `pollOnce` would have produced from RPC.
 *
 * That pipeline (S3 client, LedgerCloseMeta XDR parsing, pagination across a date range) is out
 * of scope for this skeleton. This stub exists so the ~7-day RPC retention limit is documented
 * and callers get a clear, honest failure instead of a service that silently only ever indexes
 * the last week.
 */
export async function backfillFromDataLake(rangeStart: number, rangeEnd: number): Promise<never> {
  void rangeStart;
  void rangeEnd;
  throw new Error(
    "not implemented: requires the public Stellar ledger S3 data lake, out of scope for this skeleton",
  );
}
