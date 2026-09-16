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
