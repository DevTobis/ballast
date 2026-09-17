/**
 * Off-chain verification of issuer-signed NAV readings (PRD §6.4/§6.5's "issuer-signed NAV").
 * Each `IssuerNavAdapter.fetchNav` call (see `./adapters/types.ts`) returns a detached Ed25519
 * signature over the canonical message `` `${assetCode}:${ts}:${value}` `` (UTF-8 bytes) —
 * `pipeline.ts` verifies it here before publishing the NAV on-chain.
 *
 * This is the SAME canonical message the on-chain `PriceGuard.publish_nav` verifies via
 * `env.crypto().ed25519_verify(...)` once `require_nav_signature` is enabled (see
 * `contracts/price-guard/src/lib.rs`) — keeping both sides in lockstep matters far more than
 * matching any particular literal wording, so if this format ever changes, change it in both
 * places in the same commit.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * Fixed DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key (RFC 8410's
 * `id-Ed25519` OID, `1.3.101.112`, wrapped in the minimal empty-parameters SPKI envelope every
 * Ed25519 key uses). Node's `crypto.createPublicKey` has no "raw Ed25519 key" format, so this
 * wraps the raw key in that fixed 12-byte prefix to get a DER SPKI blob it accepts. Verified
 * against `crypto.generateKeyPairSync("ed25519")` output during implementation.
 */
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Builds the canonical UTF-8 message both the off-chain and on-chain verifiers sign/verify. */
export function canonicalNavMessage(assetCode: string, ts: number, value: bigint): Buffer {
  return Buffer.from(`${assetCode}:${ts}:${value.toString()}`, "utf8");
}

/** Reconstructs a Node `KeyObject` from a raw 32-byte Ed25519 public key. */
export function publicKeyFromRawBase64(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `navSignature: expected a 32-byte raw Ed25519 public key (base64), got ${raw.length} bytes`,
    );
  }
  const der = Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Verifies `sig` is a valid Ed25519 detached signature of the canonical NAV message. */
export function verifyNavSignature(
  assetCode: string,
  ts: number,
  value: bigint,
  sig: Buffer,
  issuerPublicKeyRawBase64: string,
): boolean {
  const message = canonicalNavMessage(assetCode, ts, value);
  const publicKey = publicKeyFromRawBase64(issuerPublicKeyRawBase64);
  return cryptoVerify(null, message, publicKey, sig);
}

/**
 * Parses `ISSUER_NAV_PUBLIC_KEYS` — a JSON map `issuerCode -> base64 raw Ed25519 public key (32
 * bytes)`, e.g. `{"spiko":"<base64>","etherfuse":"<base64>","franklin":"<base64>"}`. Mirrors the
 * JSON-map-env-var parsing style `INSTITUTION_API_KEYS` uses in `services/api/src/config.ts`
 * (try/catch JSON.parse, throw a clear error rather than silently ignoring malformed input).
 */
export function loadIssuerNavPublicKeys(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.ISSUER_NAV_PUBLIC_KEYS) {
    return {};
  }
  try {
    return JSON.parse(env.ISSUER_NAV_PUBLIC_KEYS);
  } catch {
    throw new Error("price-guard: ISSUER_NAV_PUBLIC_KEYS is not valid JSON");
  }
}
