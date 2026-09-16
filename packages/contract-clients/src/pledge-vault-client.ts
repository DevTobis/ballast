import type { CustodyMode } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scBytes, scI128, scU64 } from "./scval.js";

const CUSTODY_MODE_VARIANT: Record<CustodyMode, string> = {
  escrow: "Escrow",
  issuer_lien: "IssuerLien",
  custodian_lien: "CustodianLien",
};

export class PledgeVaultClient extends BaseContractClient {
  pledge(
    source: string,
    line: bigint,
    assetAddress: string,
    units: bigint,
    mode: CustodyMode,
  ): Promise<string> {
    return this.invoke(source, "pledge", [
      scAddress(source),
      scU64(line),
      scAddress(assetAddress),
      scI128(units),
      enumToScVal(CUSTODY_MODE_VARIANT[mode]),
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
