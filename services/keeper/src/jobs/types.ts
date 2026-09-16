/** Shared return shape so `index.ts` can log "rows processed, errors" per job run uniformly. */
export interface JobResult {
  processed: number;
  skipped: number;
  errors: Array<{ id: string; message: string }>;
}

export function emptyResult(): JobResult {
  return { processed: 0, skipped: 0, errors: [] };
}
