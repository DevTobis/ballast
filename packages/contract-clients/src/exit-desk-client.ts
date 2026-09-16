import { BaseContractClient } from "./base-client.js";
import { scAddress, scI128 } from "./scval.js";

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
  expiresAt: number;
}

export class ExitDeskClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  quote(assetAddress: string, units: bigint): Promise<OnChainExitQuote> {
    return this.read<OnChainExitQuote>("quote", [scAddress(assetAddress), scI128(units)]);
  }

  exit(
    source: string,
    assetAddress: string,
    units: bigint,
    minUsdcOut: bigint,
    to: string,
  ): Promise<string> {
    return this.invoke(source, "exit", [
      scAddress(source),
      scAddress(assetAddress),
      scI128(units),
      scI128(minUsdcOut),
      scAddress(to),
    ]);
  }
}
