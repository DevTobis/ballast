import type { CustodyMode } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scBytes, scI128, scU64 } from "./scval.js";

const CUSTODY_MODE_VARIANT: Record<CustodyMode, string> = {
  escrow: "Escrow",
  issuer_lien: "IssuerLien",
  custodian_lien: "CustodianLien",
};

export class PledgeVaultClient extends BaseContractClient {
  /**
   * Admin-only. Configures the asset with its linked credit line and custody mode.
   * Haircut, thresholds, and PriceGuard are managed solely by CreditLine.
   */
  configureAsset(
    source: string,
    assetAddress: string,
    creditLineAddress: string,
    custodyMode: CustodyMode,
  ): Promise<string> {
    return this.invoke(source, "configure_asset", [
      scAddress(source),
      scAddress(assetAddress),
      scAddress(creditLineAddress),
      enumToScVal(CUSTODY_MODE_VARIANT[custodyMode]),
    ]);
  }

  /**
   * `pledge` takes no custody-mode argument on-chain — the contract derives it from the asset's
   * own `configure_asset` record (an asset has one custody mode, a borrower doesn't choose one
   * per call). See `contracts/pledge-vault/src/lib.rs`.
   */
  pledge(source: string, line: bigint, assetAddress: string, units: bigint): Promise<string> {
    return this.invoke(source, "pledge", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
    ]);
  }

  release(source: string, line: bigint, assetAddress: string, units: bigint): Promise<string> {
    return this.invoke(source, "release", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
    ]);
  }

  /**
   * Keeper-only: moves `units` of a liquidating line's collateral out of the vault to `to`
   * (`PledgeVault::liquidate`). The contract applies no LTV check here — it's the caller's job
   * to have had `CreditLine::liquidate` confirm the breach first.
   */
  liquidate(source: string, line: bigint, assetAddress: string, units: bigint, to: string): Promise<string> {
    return this.invoke(source, "liquidate", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
      scAddress(to),
    ]);
  }

  /** Read-only: units currently counted for `(line, asset)`. */
  positionUnits(line: bigint, assetAddress: string): Promise<bigint> {
    return this.read<bigint>("position_units", [scU64(line), scAddress(assetAddress)]);
  }

  recordLien(
    source: string,
    line: bigint,
    assetAddress: string,
    units: bigint,
    lienRef: Buffer,
  ): Promise<string> {
    return this.invoke(source, "record_lien", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
      scBytes(lienRef),
    ]);
  }
}
