import { createPublicKey, verify } from "node:crypto";

/**
 * RFC 8410 / SubjectPublicKeyInfo DER prefix for a raw 32-byte Ed25519 public key:
 *   SEQUENCE (42 bytes) {
 *     SEQUENCE (5 bytes) { OID 1.3.101.112 (id-Ed25519) }
 *     BIT STRING (33 bytes, 0 unused bits) { <32-byte raw key> }
 *   }
 * Prepending these 12 bytes lets Node's built-in `crypto.verify` consume the raw 32-byte key stored
 * in `asset.issuerPublicKey` without pulling in an external Ed25519 library.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Domain-separation prefix shared with `build_nav_message` in `contracts/price-guard/src/lib.rs`. */
export const NAV_DOMAIN_TAG = "ballast-nav-v1";

/** Default reference contract StrKey used when a caller does not pass an explicit `contractId`. */
export const DEFAULT_NAV_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/**
 * Canonical byte string the issuer signs over for an NAV reading (`PRD §6.4`: "verifies the issuer
 * signature on NAV"). Format: `ballast-nav-v1:{contractId}:{assetCode}:{ts}:{value}` in UTF-8, where
 * `contractId` is the PriceGuard contract `C...` StrKey, `ts` is integer unix seconds and `value` is
 * the `1e7`-scaled fixed-point integer as base-10 ASCII.
 *
 * This MUST stay byte-for-byte identical to `build_nav_message` in
 * `contracts/price-guard/src/lib.rs` (the on-chain `ed25519_verify` in `publish_nav` rebuilds the
 * message the same way). Shared golden vectors in `navSignature.test.ts` and the contract's
 * `build_nav_message_matches_golden_vectors` unit test pin both sides to the same inputs/outputs.
 */
export function canonicalNavMessage(
  assetCode: string,
  ts: number,
  value: bigint,
  contractId: string = DEFAULT_NAV_CONTRACT_ID,
): Buffer {
  return Buffer.from(`${NAV_DOMAIN_TAG}:${contractId}:${assetCode}:${ts}:${value.toString(10)}`, "utf8");
}

/**
 * Verifies an Ed25519 signature over `canonicalNavMessage(assetCode, ts, value, contractId)`.
 *
 * @param issuerPublicKeyBase64 Raw 32-byte Ed25519 public key (base64), as stored in
 *   `asset.issuer_public_key`. Note: a Stellar `G...` strkey is 32 raw bytes wrapped in a version
 *   byte + 2-byte CRC16 checksum — strip those before storing, or store the raw 32 bytes directly.
 * @returns `true` iff `sig` is 64 bytes, the public key is 32 bytes, and the signature verifies.
 */
export function verifyNavSignature(
  assetCode: string,
  ts: number,
  value: bigint,
  sig: Buffer,
  issuerPublicKeyBase64: string,
  contractId: string = DEFAULT_NAV_CONTRACT_ID,
): boolean {
  if (sig.length !== 64) return false;
  const rawPub = Buffer.from(issuerPublicKeyBase64, "base64");
  if (rawPub.length !== 32) return false;
  try {
    const pubKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPub]),
      format: "der",
      type: "spki",
    });
    return verify(null, canonicalNavMessage(assetCode, ts, value, contractId), pubKey, sig);
  } catch {
    return false;
  }
}
