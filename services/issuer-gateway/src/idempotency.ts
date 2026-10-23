/**
 * `Idempotency-Key` handling for the routes that create a lasting obligation at an issuer (a lien,
 * a redemption payout). A calling service that times out and retries would otherwise ask the issuer
 * twice. The first request with a key claims `(issuer, route, key)` in `issuer_idempotency` before
 * the issuer is called and stores the result afterwards; a later request with the same key gets
 * that stored result and the issuer is not called again.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";

/** The key was already used on this issuer and route with different parameters (422). */
export class IdempotencyKeyReusedError extends Error {}
/** The first request with this key has not finished yet (409); retry once it has. */
export class IdempotencyInFlightError extends Error {}
/** The header is present but not a usable key (400). */
export class InvalidIdempotencyKeyError extends Error {}

const MAX_KEY_LENGTH = 255;

/**
 * Reads the `Idempotency-Key` header: `undefined` when absent (the request runs exactly as it did
 * before keys existed), otherwise 1-255 printable ASCII characters.
 */
export function readIdempotencyKey(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (Array.isArray(header)) throw new InvalidIdempotencyKeyError("send a single Idempotency-Key header");
  if (header.length === 0 || header.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(header)) {
    throw new InvalidIdempotencyKeyError(
      `Idempotency-Key must be 1-${MAX_KEY_LENGTH} printable ASCII characters with no spaces`,
    );
  }
  return header;
}

export interface IdempotentRequest {
  issuerCode: string;
  route: string;
  key: string;
  /** What the request asks for; reusing the key with anything different is refused. */
  params: Record<string, string>;
}

export interface IdempotentOutcome<T> {
  result: T;
  /** True when `result` is the stored answer to an earlier request and the issuer was not called. */
  replayed: boolean;
}

function fingerprint(params: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Runs `call` at most once per `(issuerCode, route, key)`. If `call` throws, the claim is released
 * so the same key can be retried (the key is also passed to the issuer, which may itself drop the
 * duplicate if the failed attempt did reach it). If storing the result fails after `call`
 * succeeded, the result is still returned and the claim stays `in_flight`, so a retry gets 409
 * rather than a second obligation. Either bookkeeping failure is reported to `onStorageError`
 * (for logging) and never replaces the issuer's own answer or error.
 */
export async function runIdempotent<T>(
  db: Database,
  request: IdempotentRequest,
  call: () => Promise<T>,
  onStorageError: (err: unknown, stage: "store" | "release") => void,
): Promise<IdempotentOutcome<T>> {
  const t = schema.issuerIdempotency;
  const requestHash = fingerprint(request.params);
  const row = and(
    eq(t.issuerCode, request.issuerCode),
    eq(t.route, request.route),
    eq(t.idempotencyKey, request.key),
  );

  const claimed = await db
    .insert(t)
    .values({ issuerCode: request.issuerCode, route: request.route, idempotencyKey: request.key, requestHash })
    .onConflictDoNothing()
    .returning({ key: t.idempotencyKey });

  if (claimed.length === 0) {
    const [existing] = await db
      .select({ requestHash: t.requestHash, status: t.status, response: t.response })
      .from(t)
      .where(row)
      .limit(1);
    // Released between our insert and this read: the earlier attempt failed, so this one may run.
    if (!existing) return runIdempotent(db, request, call, onStorageError);
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyKeyReusedError(
        `Idempotency-Key "${request.key}" was already used for a different ${request.route} request`,
      );
    }
    if (existing.status !== "completed") {
      throw new IdempotencyInFlightError(
        `the ${request.route} request with Idempotency-Key "${request.key}" is still in progress`,
      );
    }
    return { result: existing.response as T, replayed: true };
  }

  let result: T;
  try {
    result = await call();
  } catch (err) {
    try {
      await db.delete(t).where(row);
    } catch (releaseErr) {
      // The key stays `in_flight` and later requests with it get 409 until the row is removed.
      onStorageError(releaseErr, "release");
    }
    throw err;
  }

  try {
    await db
      .update(t)
      .set({ status: "completed", response: result as unknown, completedAt: new Date() })
      .where(row);
  } catch (err) {
    onStorageError(err, "store");
  }
  return { result, replayed: false };
}
