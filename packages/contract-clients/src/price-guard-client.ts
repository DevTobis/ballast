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

  /** Admin-only. Per-asset toggle for whether `publishNav` verifies `sig` on-chain —
   * see `configure_signature_requirement` in contracts/price-guard/src/lib.rs. */
  configureSignatureRequirement(source: string, assetAddress: string, required: boolean): Promise<string> {
    return this.invoke(source, "configure_signature_requirement", [
      scAddress(source),
      scAddress(assetAddress),
      scBool(required),
    ]);
  }

  /** Admin-only. Allows or disallows a price source name for an asset (PRD §6.4, issue #84). */
  configureSource(
    source: string,
    assetAddress: string,
    sourceName: string,
    enabled: boolean,
  ): Promise<string> {
    return this.invoke(source, "configure_source", [
      scAddress(source),
      scAddress(assetAddress),
      scSymbol(sourceName),
      scBool(enabled),
    ]);
  }

  /** Read-only; returns whether `sourceName` is currently allowlisted for `assetAddress`. */
  isSourceAllowed(assetAddress: string, sourceName: string): Promise<boolean> {
    return this.read<boolean>("is_source_allowed", [
      scAddress(assetAddress),
      scSymbol(sourceName),
    ]);
  }

  /**
   * Admin-only. Tightens the staleness window for one source of an asset (issue #86). The contract
   * refuses a wider window or a clear (`0`); those go through `queue_config` with the 48h timelock.
   */
  configureSourceStaleness(
    source: string,
    assetAddress: string,
    sourceName: string,
    maxStalenessS: bigint | number,
  ): Promise<string> {
    return this.invoke(source, "configure_source_staleness", [
      scAddress(source),
      scAddress(assetAddress),
      scSymbol(sourceName),
      scU64(maxStalenessS),
    ]);
  }

  /** Read-only; the per-source staleness override in seconds, or `undefined` when the asset's
   * `max_staleness_s` applies. A `u64` decodes to a `bigint`. */
  sourceStaleness(assetAddress: string, sourceName: string): Promise<bigint | undefined> {
    return this.read<bigint | undefined>("source_staleness", [
      scAddress(assetAddress),
      scSymbol(sourceName),
    ]);
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
