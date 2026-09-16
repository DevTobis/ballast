import type { AssetStandard, CustodyMode, PauseScope, YieldType } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scStruct, scSymbol, scU32, scU64 } from "./scval.js";

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

const STANDARD_VARIANT: Record<AssetStandard, string> = { classic_sac: "ClassicSac", sep57: "Sep57" };
const YIELD_TYPE_VARIANT: Record<YieldType, string> = {
  accumulating: "Accumulating",
  distributing: "Distributing",
};
const CUSTODY_MODE_VARIANT: Record<CustodyMode, string> = {
  escrow: "Escrow",
  issuer_lien: "IssuerLien",
  custodian_lien: "CustodianLien",
};
const STANDARD_FROM_CHAIN: Record<string, AssetStandard> = { ClassicSac: "classic_sac", Sep57: "sep57" };
const YIELD_TYPE_FROM_CHAIN: Record<string, YieldType> = {
  Accumulating: "accumulating",
  Distributing: "distributing",
};
const CUSTODY_MODE_FROM_CHAIN: Record<string, CustodyMode> = {
  Escrow: "escrow",
  IssuerLien: "issuer_lien",
  CustodianLien: "custodian_lien",
};

/**
 * The on-chain shape of `ballast_common::asset::AssetConfig` (contracts/common/src/asset.rs) —
 * distinct from `@ballast/domain-types`' `AssetConfig`, which mirrors the full `asset` DB table
 * (PRD §7) and carries DB-only fields (`id`, `code`, `navSchedule`, `redemptionDailyCap`) the
 * contract has never heard of, plus DB-naming (`issuerG`/`contractC`) that doesn't match the
 * contract's own field names (`issuer`/`contract`).
 */
export interface OnChainAssetConfig {
  issuer: string;
  contract: string;
  standard: AssetStandard;
  yieldType: YieldType;
  custodyMode: CustodyMode;
  ccy: string;
  redemptionLagDays: number;
  haircutBaseBps: number;
  haircutFxBps: number;
  priceBandBps: number;
  dailyMoveBandBps: number;
  status: string;
}

function encodeAssetConfig(config: OnChainAssetConfig) {
  return scStruct({
    issuer: scAddress(config.issuer),
    contract: scAddress(config.contract),
    standard: enumToScVal(STANDARD_VARIANT[config.standard]),
    yield_type: enumToScVal(YIELD_TYPE_VARIANT[config.yieldType]),
    custody_mode: enumToScVal(CUSTODY_MODE_VARIANT[config.custodyMode]),
    ccy: scSymbol(config.ccy),
    redemption_lag_days: scU32(config.redemptionLagDays),
    haircut_base_bps: scU32(config.haircutBaseBps),
    haircut_fx_bps: scU32(config.haircutFxBps),
    price_band_bps: scU32(config.priceBandBps),
    daily_move_band_bps: scU32(config.dailyMoveBandBps),
    status: scSymbol(config.status),
  });
}

export class RegistryClient extends BaseContractClient {
  /**
   * Read-only; simulated rather than returned as unsigned XDR since it changes no state. `read()`
   * already converts the decoded struct's snake_case keys to camelCase and unwraps unit-enum
   * arrays to their bare variant string (see `scval.ts::normalizeContractValue`) — this method
   * only needs to map those PascalCase variant strings back to Ballast's snake_case vocabulary.
   */
  async asset(assetAddress: string): Promise<OnChainAssetConfig> {
    const raw = await this.read<OnChainAssetConfig>("asset", [scAddress(assetAddress)]);
    return {
      ...raw,
      standard: STANDARD_FROM_CHAIN[raw.standard as unknown as string] ?? raw.standard,
      yieldType: YIELD_TYPE_FROM_CHAIN[raw.yieldType as unknown as string] ?? raw.yieldType,
      custodyMode: CUSTODY_MODE_FROM_CHAIN[raw.custodyMode as unknown as string] ?? raw.custodyMode,
    };
  }

  registerAsset(source: string, assetAddress: string, config: OnChainAssetConfig): Promise<string> {
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

  /**
   * There is no single `unpause` on-chain — lifting a pause is timelocked (PRD §6.2's "48h
   * timelock on parameter changes" applies to unpausing too, unlike `pause` itself, which is
   * immediate). Queue it here, then call `executeUnpause` once the 48h delay has elapsed.
   */
  queueUnpause(source: string, scope: PauseScope): Promise<string> {
    return this.invoke(source, "queue_unpause", [scAddress(source), enumToScVal(scope)]);
  }

  executeUnpause(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "execute_unpause", [scU64(id)]);
  }

  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  isPaused(scope: PauseScope): Promise<boolean> {
    return this.read<boolean>("is_paused", [enumToScVal(scope)]);
  }
}
