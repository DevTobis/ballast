import type { GuardedPrice } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { scAddress, scBool, scBytes, scI128, scSymbol, scU64 } from "./scval.js";

export class PriceGuardClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  guardedPrice(assetAddress: string): Promise<GuardedPrice> {
    return this.read<GuardedPrice>("guarded_price", [scAddress(assetAddress)]);
  }

  /**
   * `publishNav` verifies `sig` against the asset's registered issuer key and bound asset code on-chain
   * when `require_nav_signature` is `true` (contracts/price-guard/src/lib.rs). The canonical message
   * is bound to the contract deployment and asset code (`ballast-nav-v1:{contract}:{assetCode}:{ts}:{value}`).
   */
  publishNav(
    source: string,
    assetAddress: string,
    value: bigint,
    ts: number,
    sig: Buffer,
  ): Promise<string> {
    return this.invoke(source, "publish_nav", [
      scAddress(source),
      scAddress(assetAddress),
      scI128(value),
      scU64(ts),
      scBytes(sig),
    ]);
  }

  /** Admin-only. Registers/rotates the raw 32-byte Ed25519 public key and binds the asset code that
   * `assetAddress`'s issuer signs NAV readings with (see `configure_issuer_key` in contracts/price-guard/src/lib.rs). */
  configureIssuerKey(
    source: string,
    assetAddress: string,
    assetCode: string,
    issuerPublicKey: Buffer,
  ): Promise<string> {
    return this.invoke(source, "configure_issuer_key", [
      scAddress(source),
      scAddress(assetAddress),
      scBytes(Buffer.from(assetCode, "utf8")),
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
