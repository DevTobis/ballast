import { BaseContractClient } from "./base-client.js";
import { scAddress, scBytes, scI128, scU64 } from "./scval.js";

export class PledgeVaultClient extends BaseContractClient {
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
