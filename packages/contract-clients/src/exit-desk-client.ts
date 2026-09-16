import type { ExitQuote } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { scAddress, scI128 } from "./scval.js";

export class ExitDeskClient extends BaseContractClient {
  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  quote(assetAddress: string, units: bigint): Promise<ExitQuote> {
    return this.read<ExitQuote>("quote", [scAddress(assetAddress), scI128(units)]);
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
