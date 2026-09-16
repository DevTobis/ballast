import type { RepoKind } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { scAddress, scBytes, scI128, scStruct, scSymbol, scU32, scU64 } from "./scval.js";

const REPO_KIND_VARIANT: Record<RepoKind, string> = {
  intraday: "Intraday",
  overnight: "Overnight",
  open: "Open",
  term: "Term",
};

/**
 * Terms for `RepoDvp::propose` (PRD §8 `RepoTerms`). `cashLender` is implied by the `source`
 * argument to `propose` (it signs and is the `cash_lender` param on-chain), so it's omitted here.
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

function encodeRepoTerms(terms: RepoProposeTerms) {
  return scStruct({
    cash_borrower: scAddress(terms.cashBorrower),
    asset: scAddress(terms.asset),
    units: scI128(terms.units),
    cash_amount: scI128(terms.cashAmount),
    rate_bps: scU32(terms.rateBps),
    kind: scSymbol(REPO_KIND_VARIANT[terms.kind]),
    maturity_at: scU64(terms.maturityAt),
    agreement_hash: scBytes(terms.agreementHash),
  });
}

export class RepoDvpClient extends BaseContractClient {
  propose(source: string, terms: RepoProposeTerms): Promise<string> {
    return this.invoke(source, "propose", [scAddress(source), encodeRepoTerms(terms)]);
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
