import type { GuardedPrice } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { scAddress, scBool, scBytes, scI128, scSymbol, scU64 } from "./scval.js";

export class PriceGuardClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  guardedPrice(assetAddress: string): Promise<GuardedPrice> {
    return this.read<GuardedPrice>("guarded_price", [scAddress(assetAddress)]);
  }

  /**
   * `assetCode` (UTF-8, e.g. `"SPIKO"`) is the SAME string the caller signed into `sig`'s
   * canonical message (`{assetCode}:{ts}:{value}` — see `services/price-guard/src/navSignature.ts`)
   * and is what the contract verifies `sig` against on-chain when `require_nav_signature` is
   * `true` (contracts/price-guard/src/lib.rs) — Soroban's `Address` has no reverse lookup back to
   * a ticker, so this is passed explicitly rather than derived from `assetAddress`.
   */
  publishNav(
    source: string,
    assetAddress: string,
    assetCode: string,
    value: bigint,
    ts: number,
    sig: Buffer,
  ): Promise<string> {
    return this.invoke(source, "publish_nav", [
      scAddress(source),
      scAddress(assetAddress),
      scBytes(Buffer.from(assetCode, "utf8")),
      scI128(value),
      scU64(ts),
      scBytes(sig),
    ]);
  }

  /** Admin-only. Registers/rotates the raw 32-byte Ed25519 public key `assetAddress`'s issuer
   * signs NAV readings with (see `configure_issuer_key` in contracts/price-guard/src/lib.rs). */
  configureIssuerKey(source: string, assetAddress: string, issuerPublicKey: Buffer): Promise<string> {
    return this.invoke(source, "configure_issuer_key", [
      scAddress(source),
      scAddress(assetAddress),
      scBytes(issuerPublicKey),
    ]);
  }

  /** Admin-only. Global (not per-asset) toggle for whether `publishNav` verifies `sig` on-chain —
   * see `configure_signature_requirement` in contracts/price-guard/src/lib.rs. */
  configureSignatureRequirement(source: string, required: boolean): Promise<string> {
    return this.invoke(source, "configure_signature_requirement", [scAddress(source), scBool(required)]);
  }

  /**
   * Pushes an independent-feed or last-redemption-price reading. The on-chain function is named
   * `publish_source` (contracts/price-guard/src/lib.rs) — kept as `publishFeed` here for the
   * TS-side name already used by callers.
   */
  publishFeed(
    source: string,
    assetAddress: string,
    sourceName: string,
    value: bigint,
    ts: number,
  ): Promise<string> {
    return this.invoke(source, "publish_source", [
      scAddress(source),
      scAddress(assetAddress),
      scSymbol(sourceName),
      scI128(value),
      scU64(ts),
    ]);
  }

  confirmHaltCleared(source: string, assetAddress: string): Promise<string> {
    return this.invoke(source, "confirm_halt_cleared", [scAddress(source), scAddress(assetAddress)]);
  }
}
