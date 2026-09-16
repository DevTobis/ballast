import type { GuardedPrice } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { scAddress, scBytes, scI128, scSymbol, scU64 } from "./scval.js";

export class PriceGuardClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  guardedPrice(assetAddress: string): Promise<GuardedPrice> {
    return this.read<GuardedPrice>("guarded_price", [scAddress(assetAddress)]);
  }

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

  /** Pushes an independent-feed or last-redemption-price reading (contracts/price-guard). */
  publishFeed(
    source: string,
    assetAddress: string,
    sourceName: string,
    value: bigint,
    ts: number,
  ): Promise<string> {
    return this.invoke(source, "publish_feed", [
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
