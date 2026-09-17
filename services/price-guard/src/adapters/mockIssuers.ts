/**
 * MOCK issuer NAV adapters for the PRD §5 Phase 1 priority assets (Spiko, Etherfuse, Franklin).
 * Real issuer NAV integrations live in `spikoNavAdapter.ts`/`etherfuseNavAdapter.ts`/
 * `franklinNavAdapter.ts`, selected instead of these via `PRICE_GUARD_MODE=live` (see
 * `./registry.ts`). Every class below is explicitly named and doc-commented as a mock, and makes
 * no real network calls.
 *
 * Each mock still returns a REAL Ed25519 signature (not a stub) over the canonical NAV message,
 * signed with a fixed/deterministic MOCK/TEST-ONLY keypair, so `pipeline.ts`'s signature
 * verification runs its real logic in mock mode/tests instead of being bypassed.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import type { IssuerNavAdapter } from "./types.js";
import { canonicalNavMessage } from "../navSignature.js";

const PRICE_SCALE = 10_000_000n;

function jitteredDollar(baseValue: bigint, maxJitterBps: number): bigint {
  const wobbleBps = BigInt(Math.round((Math.random() - 0.5) * 2 * maxJitterBps));
  return baseValue + (baseValue * wobbleBps) / 10_000n;
}

/**
 * Fixed, deterministic Ed25519 test keypair — MOCK/TEST ONLY, never use for anything real.
 * Node's `crypto.generateKeyPairSync("ed25519")` has no deterministic-seed option, so this
 * hardcodes a raw 32-byte seed (bytes `01..20` hex) and reconstructs the PKCS8 DER private key
 * from it via the fixed, well-known Ed25519 PKCS8 prefix (RFC 8410). The matching raw public key
 * is exported as `MOCK_ISSUER_NAV_PUBLIC_KEY_BASE64` below — set
 * `ISSUER_NAV_PUBLIC_KEYS={"spiko":"<that value>","etherfuse":"<that value>","franklin":"<that
 * value>"}` (all three issuer codes share this one mock key) to verify these mock signatures in
 * local dev/tests.
 */
const MOCK_SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const ED25519_PKCS8_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const mockPrivateKey = createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_DER_PREFIX, MOCK_SEED]),
  format: "der",
  type: "pkcs8",
});
const mockPublicKey = createPublicKey(mockPrivateKey);

/** Base64 raw (32-byte) Ed25519 public key matching `mockPrivateKey` above. */
export const MOCK_ISSUER_NAV_PUBLIC_KEY_BASE64 = mockPublicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("base64");

function signMockNav(assetCode: string, ts: number, value: bigint): Buffer {
  return cryptoSign(null, canonicalNavMessage(assetCode, ts, value), mockPrivateKey);
}

/** MOCK — stands in for a real Spiko NAV feed integration. */
export class MockSpikoAdapter implements IssuerNavAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 2,
  ) {}

  async fetchNav(assetCode: string): Promise<{ value: bigint; ts: number; sig: Buffer }> {
    const value = jitteredDollar(this.baseValue, this.maxJitterBps);
    const ts = Math.floor(Date.now() / 1000);
    return { value, ts, sig: signMockNav(assetCode, ts, value) };
  }
}

/** MOCK — stands in for a real Etherfuse (CETES) NAV feed integration. */
export class MockEtherfuseAdapter implements IssuerNavAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 5,
  ) {}

  async fetchNav(assetCode: string): Promise<{ value: bigint; ts: number; sig: Buffer }> {
    const value = jitteredDollar(this.baseValue, this.maxJitterBps);
    const ts = Math.floor(Date.now() / 1000);
    return { value, ts, sig: signMockNav(assetCode, ts, value) };
  }
}

/** MOCK — stands in for a real Franklin Templeton (BENJI) NAV feed integration. */
export class MockFranklinAdapter implements IssuerNavAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 1,
  ) {}

  async fetchNav(assetCode: string): Promise<{ value: bigint; ts: number; sig: Buffer }> {
    const value = jitteredDollar(this.baseValue, this.maxJitterBps);
    const ts = Math.floor(Date.now() / 1000);
    return { value, ts, sig: signMockNav(assetCode, ts, value) };
  }
}
