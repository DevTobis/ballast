import { BaseContractClient } from "./base-client.js";
import { scAddress, scI128, scU64 } from "./scval.js";

/**
 * The on-chain shape of `ExitDesk::quote`'s return (contracts/exit-desk/src/lib.rs) — distinct
 * from `@ballast/domain-types`' `ExitQuote`, which is the DB-backed `exit_quote` row (carries
 * `id`/`holderId`/`assetId`/`status`, none of which the contract knows about; it returns `asset`,
 * not `assetId`).
 */
export interface OnChainExitQuote {
  asset: string;
  units: bigint;
  price: bigint;
  spreadBps: number;
  usdcOut: bigint;
  /** Unix seconds; a u64 on-chain, so it decodes as a bigint. */
  expiresAt: bigint | number;
}

export interface OnChainExitDeskAssetConfig {
  priceGuard: string;
  spreadBps: number;
  perHolderDailyCap: bigint;
  /** Units accepted per UTC day across all holders. */
  deskDailyCap: bigint;
  deskInventoryCap: bigint;
}

export class ExitDeskClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  quote(assetAddress: string, units: bigint): Promise<OnChainExitQuote> {
    return this.read<OnChainExitQuote>("quote", [scAddress(assetAddress), scI128(units)]);
  }

  usdc(): Promise<string> {
    return this.read<string>("usdc", []);
  }

  assetConfig(assetAddress: string): Promise<OnChainExitDeskAssetConfig> {
    return this.read<OnChainExitDeskAssetConfig>("asset_config", [scAddress(assetAddress)]);
  }

  inventory(assetAddress: string): Promise<bigint> {
    return this.read<bigint>("inventory", [scAddress(assetAddress)]);
  }

  dailyUsed(holder: string, assetAddress: string): Promise<bigint> {
    return this.read<bigint>("daily_used", [scAddress(holder), scAddress(assetAddress)]);
  }

  /** Units exited for the asset today across all holders (counted against `deskDailyCap`). */
  deskDailyUsed(assetAddress: string): Promise<bigint> {
    return this.read<bigint>("desk_daily_used", [scAddress(assetAddress)]);
  }

  /** `[holderRoom, deskRoom]`; `deskRoom` is the smaller of the desk daily and inventory room. */
  capacity(holder: string, assetAddress: string): Promise<[bigint, bigint]> {
    return this.read<[bigint, bigint]>("capacity", [scAddress(holder), scAddress(assetAddress)]);
  }

  setUsdc(admin: string, usdc: string): Promise<string> {
    return this.invoke(admin, "set_usdc", [scAddress(admin), scAddress(usdc)]);
  }

  exit(
    source: string,
    assetAddress: string,
    units: bigint,
    minUsdcOut: bigint,
    to: string,
    deadline?: bigint,
  ): Promise<string> {
    if (deadline !== undefined) {
      return this.exitBefore(source, assetAddress, units, minUsdcOut, to, deadline);
    }
    return this.invoke(source, "exit", [
      scAddress(source),
      scAddress(assetAddress),
      scI128(units),
      scI128(minUsdcOut),
      scAddress(to),
    ]);
  }

  exitBefore(
    source: string,
    assetAddress: string,
    units: bigint,
    minUsdcOut: bigint,
    to: string,
    deadline: bigint,
  ): Promise<string> {
    return this.invoke(source, "exit_before", [
      scAddress(source),
      scAddress(assetAddress),
      scI128(units),
      scI128(minUsdcOut),
      scAddress(to),
      scU64(deadline),
    ]);
  }

  disableAsset(admin: string, assetAddress: string): Promise<string> {
    return this.invoke(admin, "disable_asset", [scAddress(admin), scAddress(assetAddress)]);
  }

  enableAsset(admin: string, assetAddress: string): Promise<string> {
    return this.invoke(admin, "enable_asset", [scAddress(admin), scAddress(assetAddress)]);
  }

  isAssetEnabled(assetAddress: string): Promise<boolean> {
    return this.read<boolean>("is_asset_enabled", [scAddress(assetAddress)]);
  }
}

