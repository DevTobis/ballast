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

/** `RepoDvp::margin_view`: where a settled trade's margin stands, read without a transaction. */
export interface OnChainRepoMargin {
  exposure: bigint;
  collateralValue: bigint;
  ltvBps: number;
  state: "Healthy" | "Warning" | "MarginCall" | "Liquidation";
  /** False when the guarded price is not usable; the other fields are then zero. */
  priceOk: boolean;
}

/** The parts of the on-chain `RepoTrade` the keeper reads. */
export interface OnChainRepoTrade {
  units: bigint;
  status: "Proposed" | "Settled" | "Unwound" | "Defaulted" | "Cancelled";
  pendingMarginCall: boolean;
  marginCallAmount: bigint;
  /** Unix seconds; unset while no call is open. */
  cureDeadline?: bigint | number | null;
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

  cancelProposal(source: string, id: bigint): Promise<string> {
    return this.invoke(source, "cancel_proposal", [scAddress(source), scU64(id)]);
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

  /** The cash borrower adds collateral to a settled trade; cures a margin call if it is enough. */
  topUp(source: string, id: bigint, extraUnits: bigint): Promise<string> {
    return this.invoke(source, "top_up", [scAddress(source), scU64(id), scI128(extraUnits)]);
  }

  /** Read-only margin snapshot; simulated, so it costs nothing and changes nothing. */
  marginView(id: bigint): Promise<OnChainRepoMargin> {
    return this.read<OnChainRepoMargin>("margin_view", [scU64(id)]);
  }

  /** Read-only: the trade as the contract holds it. */
  trade(id: bigint): Promise<OnChainRepoTrade> {
    return this.read<OnChainRepoTrade>("trade", [scU64(id)]);
  }

  disableAsset(admin: string, assetAddress: string): Promise<string> {
    return this.invoke(admin, "disable_asset", [scAddress(admin), scAddress(assetAddress)]);
  }

  enableAsset(admin: string, assetAddress: string): Promise<string> {
    return this.invoke(admin, "enable_asset", [scAddress(admin), scAddress(assetAddress)]);
  }

  isAssetEnabled(assetAddress: string): Promise<boolean> {
    return this.read<boolean>("is_asset_enabled", [scAddress(assetAddress)]);
  }
}

