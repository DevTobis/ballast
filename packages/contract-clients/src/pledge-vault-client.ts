import type { CustodyMode } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scBytes, scI128, scU64 } from "./scval.js";

const CUSTODY_MODE_FROM_CHAIN: Record<string, CustodyMode> = {
  Escrow: "escrow",
  IssuerLien: "issuer_lien",
  CustodianLien: "custodian_lien",
};

const CUSTODY_MODE_TO_CHAIN: Record<CustodyMode, string> = {
  escrow: "Escrow",
  issuer_lien: "IssuerLien",
  custodian_lien: "CustodianLien",
};

/** Full collateral position returned by `PledgeVault::position(line, asset)`. */
export interface OnChainPledgePosition {
  units: bigint;
  pendingLienUnits: bigint;
  mode: CustodyMode;
  lienRef: Uint8Array | null;
}

export class PledgeVaultClient extends BaseContractClient {
  /**
   * Admin-only. The vault's whole per-asset config: the CreditLine that owns lines against the
   * asset and the asset's custody mode. Haircut, thresholds and PriceGuard are CreditLine's
   * (`CreditLine::configure_asset`); the vault keeps no copy of them (#180).
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
      enumToScVal(CUSTODY_MODE_TO_CHAIN[custodyMode]),
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

  /**
   * Read-only: full collateral position for `(line, asset)` (`PledgeVault::position`).
   * Unknown keys return a default empty Escrow position (`units: 0n`, `pendingLienUnits: 0n`,
   * `mode: "escrow"`, `lienRef: null`).
   */
  async position(line: bigint, assetAddress: string): Promise<OnChainPledgePosition> {
    const raw = await this.read<OnChainPledgePosition>("position", [
      scU64(line),
      scAddress(assetAddress),
    ]);
    return {
      ...raw,
      mode: CUSTODY_MODE_FROM_CHAIN[raw.mode as unknown as string] ?? raw.mode,
      lienRef: raw.lienRef ?? null,
    };
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

  /**
   * Borrower-only: cancels unconfirmed pending lien units (`IssuerLien` / `CustodianLien`).
   * Never touches confirmed position units or moves tokens.
   */
  cancelPending(
    source: string,
    line: bigint,
    assetAddress: string,
    units: bigint,
  ): Promise<string> {
    return this.invoke(source, "cancel_pending", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
    ]);
  }

  /**
   * Gateway-only: rejects unconfirmed pending lien units (`IssuerLien` / `CustodianLien`) with a reason.
   * Never touches confirmed position units or moves tokens.
   */
  rejectLien(
    source: string,
    line: bigint,
    assetAddress: string,
    units: bigint,
    reason: Buffer,
  ): Promise<string> {
    return this.invoke(source, "reject_lien", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
      scBytes(reason),
    ]);
  }
}
