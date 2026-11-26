/**
 * Canonical NAV message and its Ed25519 verification. Issuers do not sign NAV, so the
 * price-publisher key attests each reading over `` `ballast-nav-v1:${contractAddress}:${assetCode}:${ts}:${value}` `` (UTF-8 bytes)
 * — see `navAttestor.ts` — and `pipeline.ts` checks the signature here before publishing.
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
export function canonicalNavMessage(
  contractAddress: string,
  assetCode: string,
  ts: number,
  value: bigint,
): Buffer {
  return Buffer.from(`ballast-nav-v1:${contractAddress}:${assetCode}:${ts}:${value.toString()}`, "utf8");
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
  contractAddress: string,
  assetCode: string,
  ts: number,
  value: bigint,
  sig: Buffer,
  issuerPublicKeyRawBase64: string,
): boolean {
  const message = canonicalNavMessage(contractAddress, assetCode, ts, value);
  const publicKey = publicKeyFromRawBase64(issuerPublicKeyRawBase64);
  return cryptoVerify(null, message, publicKey, sig);
}
