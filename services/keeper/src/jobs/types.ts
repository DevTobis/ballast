/**
 * Shared return shape so `index.ts` can log "rows processed, errors" per job run uniformly.
 *
 * Counter definitions:
 * - `processed`: Count of items where an action was taken (an on-chain transaction was submitted,
 *   or a terminal state was reconciled into the database).
 * - `skipped`: Count of items inspected where no action was required or possible (e.g. healthy
 *   positions, positions still within cure window, uninitialized on-chain IDs, or balances already in sync).
 * - `errors`: List of item IDs and error messages for rows where an attempted inspection or
 *   submission threw an exception; processing continues for subsequent items.
 */
export interface JobResult {
  processed: number;
  skipped: number;
  errors: Array<{ id: string; message: string }>;
}

export function emptyResult(): JobResult {
  return { processed: 0, skipped: 0, errors: [] };
}
