import type { RepoKind } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scBytes, scI128, scU32, scU64 } from "./scval.js";

const REPO_KIND_VARIANT: Record<RepoKind, string> = {
  intraday: "Intraday",
  overnight: "Overnight",
  open: "Open",
  term: "Term",
};

/**
 * Terms for `RepoDvp::propose`. `cashLender` is implied by the `source` argument to `propose`
 * (it signs and is the `cash_lender` param on-chain), so it's omitted here. Unlike PRD §8's
 * pseudocode (a single `RepoTerms` struct param), the real contract flattens these into individual
 * arguments — see `contracts/repo-dvp/src/lib.rs::propose`.
 */
export interface RepoProposeTerms {
  cashBorrower: string;
  asset: string;
  units: bigint;
  cashAmount: bigint;
  rateBps: number;
  kind: RepoKind;
  maturityAt: number;
  agreementHash: Buffer;
}

export class RepoDvpClient extends BaseContractClient {
  propose(source: string, terms: RepoProposeTerms): Promise<string> {
    return this.invoke(source, "propose", [
      scAddress(source),
      scAddress(terms.cashBorrower),
      scAddress(terms.asset),
      scI128(terms.units),
      scI128(terms.cashAmount),
      scU32(terms.rateBps),
      enumToScVal(REPO_KIND_VARIANT[terms.kind]),
      scU64(terms.maturityAt),
      scBytes(terms.agreementHash),
    ]);
  }

  acceptAndSettle(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "accept_and_settle", [scAddress(source), scU64(id)]);
  }

  unwind(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "unwind", [scAddress(source), scU64(id)]);
  }

  callMargin(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "call_margin", [scAddress(source), scU64(id)]);
  }

  defaultClose(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "default_close", [scAddress(source), scU64(id)]);
  }
}
