import type { AssetConfig, PauseScope } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scI128, scStruct, scSymbol, scU32, scU64 } from "./scval.js";

/** One variant per field `Registry::ParamChange` supports (contracts/registry, PRD §8). */
export type RegistryParamChange =
  | { field: "HaircutBaseBps"; value: number }
  | { field: "HaircutFxBps"; value: number }
  | { field: "PriceBandBps"; value: number }
  | { field: "DailyMoveBandBps"; value: number }
  | { field: "RedemptionLagDays"; value: number }
  | { field: "Status"; value: string };

function encodeParamChange(change: RegistryParamChange) {
  if (change.field === "Status") return enumToScVal(change.field, scSymbol(change.value));
  return enumToScVal(change.field, scU32(change.value));
}

// TODO(integration): AssetConfig's on-chain struct field names/types are a best-effort mapping
// (see scval.ts) — `id` is a Ballast DB-only key and is intentionally omitted here.
function encodeAssetConfig(config: AssetConfig) {
  return scStruct({
    issuer_g: scAddress(config.issuerG),
    contract_c: scAddress(config.contractC),
    standard: scSymbol(config.standard),
    yield_type: scSymbol(config.yieldType),
    custody_mode: scSymbol(config.custodyMode),
    ccy: scSymbol(config.ccy),
    redemption_lag_days: scU32(config.redemptionLagDays),
    redemption_daily_cap: scI128(config.redemptionDailyCap),
    nav_schedule: scSymbol(config.navSchedule),
    price_band_bps: scU32(config.priceBandBps),
    daily_move_band_bps: scU32(config.dailyMoveBandBps),
    haircut_base_bps: scU32(config.haircutBaseBps),
    haircut_fx_bps: scU32(config.haircutFxBps),
    status: scSymbol(config.status),
  });
}

export class RegistryClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  asset(assetAddress: string): Promise<AssetConfig> {
    return this.read<AssetConfig>("asset", [scAddress(assetAddress)]);
  }

  registerAsset(source: string, assetAddress: string, config: AssetConfig): Promise<string> {
    return this.invoke(source, "register_asset", [
      scAddress(source),
      scAddress(assetAddress),
      encodeAssetConfig(config),
    ]);
  }

  queueParam(source: string, assetAddress: string, change: RegistryParamChange): Promise<string> {
    return this.invoke(source, "queue_param", [
      scAddress(source),
      scAddress(assetAddress),
      encodeParamChange(change),
    ]);
  }

  executeParam(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "execute_param", [scU64(id)]);
  }

  raiseHaircutNow(source: string, assetAddress: string, addBps: number): Promise<string> {
    return this.invoke(source, "raise_haircut_now", [
      scAddress(source),
      scAddress(assetAddress),
      scU32(addBps),
    ]);
  }

  pause(source: string, scope: PauseScope): Promise<string> {
    return this.invoke(source, "pause", [scAddress(source), enumToScVal(scope)]);
  }

  unpause(source: string, scope: PauseScope): Promise<string> {
    return this.invoke(source, "unpause", [scAddress(source), enumToScVal(scope)]);
  }
}
