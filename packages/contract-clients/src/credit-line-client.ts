import type { LiquidationRoute, MarginState, PriceStatus } from "@ballast/domain-types";
import { BaseContractClient } from "./base-client.js";
import { enumToScVal, scAddress, scBytes, scI128, scU32, scU64 } from "./scval.js";
import { resolvePokeSource } from "./unsigned-tx.js";

const ROUTE_VARIANT: Record<LiquidationRoute, string> = {
  redeem: "Redeem",
  transfer: "Transfer",
  rfq: "Rfq",
};

export interface OpenCreditLineArgs {
  borrower: string;
  asset: string;
  limit: bigint;
  rateBps: number;
  feeBps: number;
  cureS: number;
  agreementHash: Buffer;
}

/**
 * The on-chain `ltv()` read returns a narrower shape than the DB-backed `CreditLineView` in
 * `@ballast/domain-types` (which also carries lender/borrower/limit/drawn/etc. from the
 * `credit_line` table). Per the task spec, this local `LtvView` matches PRD §8's `LtvView`
 * exactly and is re-exported for other packages that want to type against a raw contract read.
 */
export interface LtvView {
  debt: bigint;
  collateralValue: bigint;
  ltvBps: number;
  state: MarginState;
  priceStatus: PriceStatus;
}

/**
 * Exact payoff breakdown and pending accrual returned by `CreditLineClient.owed` without calling
 * PriceGuard (PRD §9, Backlog B-0131).
 */
export interface Owed {
  principal: bigint;
  accruedInterest: bigint;
  pendingInterest: bigint;
  accruedFee: bigint;
  pendingFee: bigint;
  /** principal + accrued/pending interest + accrued/pending fee; equals `debtOf`. */
  total: bigint;
  asOf: bigint;
}

/** The subset of the contract's `Line` struct (contracts/credit-line/src/lib.rs) callers read. */
export interface OnChainLine {
  lender: string;
  borrower: string;
  asset: string;
  limit: bigint;
  funded: bigint;
  drawn: bigint;
  pledgedUnits: bigint;
  feeBps?: number;
  accruedInterest: bigint;
  accruedFee?: bigint;
  status: "Open" | "Liquidating" | "Closed";
  /** Ledger at which `poke` first saw a liquidation-level breach; unset while there is none. */
  breachLedger?: number | null;
}

/** The liquidation outcome recorded on-chain (`LiquidationRecord`). Amounts are 7-decimal scaled. */
export interface OnChainLiquidationRecord {
  seizedUnits: bigint;
  price: bigint;
  debt: bigint;
  closed: boolean;
  recovered: bigint;
  surplus: bigint;
  shortfall: bigint;
  /** Ledger timestamp (seconds) at which `liquidate` froze the record; `closeExpired` waits `CLOSE_GRACE_S` from here. */
  liquidatedAt?: bigint;
}

export class CreditLineClient extends BaseContractClient {
  open(source: string, args: OpenCreditLineArgs): Promise<string> {
    return this.invoke(source, "open", [
      scAddress(source),
      scAddress(args.borrower),
      scAddress(args.asset),
      scI128(args.limit),
      scU32(args.rateBps),
      scU32(args.feeBps),
      scU64(args.cureS),
      scBytes(args.agreementHash),
    ]);
  }

  fund(source: string, line: bigint, amount: bigint): Promise<string> {
    return this.invoke(source, "fund", [scAddress(source), scU64(line), scI128(amount)]);
  }

  draw(source: string, line: bigint, amount: bigint, to: string): Promise<string> {
    return this.invoke(source, "draw", [
      scAddress(source),
      scU64(line),
      scI128(amount),
      scAddress(to),
    ]);
  }

  /**
   * Repay drawn balance and accrued interest. `amount` acts as a cap: on-chain `repay`
   * applies `min(amount, owed)` (interest first, then principal) and transfers only
   * what was applied, returning the applied amount.
   */
  repay(source: string, line: bigint, amount: bigint): Promise<string> {
    return this.invoke(source, "repay", [scAddress(source), scU64(line), scI128(amount)]);
  }

  /** Read-only: what the borrower owes right now (principal plus interest accrued to this ledger). */
  debtOf(line: bigint): Promise<bigint> {
    return this.read<bigint>("debt_of", [scU64(line)]);
  }

  /**
   * Syncs `PledgeVault`'s actual on-chain pledged units into this line's LTV view
   * (`contracts/credit-line/src/lib.rs::sync_collateral`, admin- or keeper-gated). Without this
   * being called after every pledge/release, a line's `pledged_units` stays at its last synced
   * value (0 for a brand-new line) and every `draw` would be rejected as unhealthy — this is the
   * off-chain `margin-monitor`/`indexer` service's job, driven by observed `pledged`/`released`
   * chain events, not something `services/api`'s pledge route calls directly (it only returns
   * unsigned XDR for the borrower to sign; the pledge hasn't landed on-chain yet at that point).
   */
  syncCollateral(source: string, line: bigint, units: bigint): Promise<string> {
    return this.invoke(source, "sync_collateral", [scAddress(source), scU64(line), scI128(units)]);
  }

  /** Read-only; simulated rather than returned as unsigned XDR since it changes no state. */
  ltv(line: bigint): Promise<LtvView> {
    return this.read<LtvView>("ltv", [scU64(line)]);
  }

  /**
   * Read-only: the `ltv` view as if the line had `newUnits` of collateral pledged, computed with
   * the line's own haircut, thresholds and price. `PledgeVault::release` uses it on-chain (#180).
   */
  ltvAfter(line: bigint, newUnits: bigint): Promise<LtvView> {
    return this.read<LtvView>("ltv_after", [scU64(line), scI128(newUnits)]);
  }

  /** Read-only: exact payoff components and timestamp without calling PriceGuard (PRD §9, Backlog B-0131). */
  owed(line: bigint): Promise<Owed> {
    return this.read<Owed>("owed", [scU64(line)]);
  }

  /** Read-only: the line's raw on-chain state (principal `drawn`, `funded`, `pledgedUnits`...). */
  line(line: bigint): Promise<OnChainLine> {
    return this.read<OnChainLine>("line", [scU64(line)]);
  }

  /**
   * `poke` is a state-changing (though permissionless) call, so per Ballast's "never returns a
   * pre-signed tx" rule it returns unsigned XDR like every other write — despite the spec
   * pseudocode's `Promise<MarginState>` return-type annotation, which conflicts with its own
   * "still returns unsigned XDR" comment. Honoring the comment/convention here. See
   * `resolvePokeSource` for how the fee-paying source account is resolved.
   */
  poke(line: bigint, source: string = resolvePokeSource()): Promise<string> {
    return this.invoke(source, "poke", [scU64(line)]);
  }

  liquidate(source: string, line: bigint, route: LiquidationRoute): Promise<string> {
    return this.invoke(source, "liquidate", [
      scAddress(source),
      scU64(line),
      enumToScVal(ROUTE_VARIANT[route]),
    ]);
  }

  /** Lender takes undrawn USDC (including repaid principal) back out of the line. */
  withdrawUndrawn(source: string, line: bigint, amount: bigint): Promise<string> {
    return this.invoke(source, "withdraw_undrawn", [scAddress(source), scU64(line), scI128(amount)]);
  }

  /** Lender takes repaid interest out of the line. */
  withdrawInterest(source: string, line: bigint, amount: bigint): Promise<string> {
    return this.invoke(source, "withdraw_interest", [scAddress(source), scU64(line), scI128(amount)]);
  }

  /**
   * Lender books a liquidation's outcome and closes the line. If the collateral was worth more than
   * the debt the surplus is recorded for the borrower to pull with `claimSurplus`; no USDC moves.
   */
  closeLiquidated(source: string, line: bigint): Promise<string> {
    return this.invoke(source, "close_liquidated", [scAddress(source), scU64(line)]);
  }

  /**
   * Borrower or keeper closes a liquidated line once 7 days (`CLOSE_GRACE_S`) have passed since
   * `liquidate`, booking the same outcome as `closeLiquidated`.
   */
  closeExpired(source: string, line: bigint): Promise<string> {
    return this.invoke(source, "close_expired", [scAddress(source), scU64(line)]);
  }

  /**
   * Borrower pulls a liquidation surplus from the lender. The lender must have approved this
   * contract on the USDC token for at least the surplus first.
   */
  claimSurplus(borrower: string, line: bigint): Promise<string> {
    return this.invoke(borrower, "claim_surplus", [scAddress(borrower), scU64(line)]);
  }

  /** Read-only: liquidation surplus booked but not yet claimed by the borrower. */
  surplusOwed(line: bigint): Promise<bigint> {
    return this.read<bigint>("surplus_owed", [scU64(line)]);
  }

  /** Read-only: interest repaid on the line and not yet withdrawn. */
  claimableInterest(line: bigint): Promise<bigint> {
    return this.read<bigint>("claimable_interest", [scU64(line)]);
  }

  /** Configures the protocol treasury address allowed to claim repaid platform fees. */
  setTreasury(source: string, treasury: string): Promise<string> {
    return this.invoke(source, "set_treasury", [scAddress(source), scAddress(treasury)]);
  }

  /** Treasury withdraws repaid platform fees from `line`. */
  claimFee(source: string, line: bigint, amount: bigint): Promise<string> {
    return this.invoke(source, "claim_fee", [scAddress(source), scU64(line), scI128(amount)]);
  }

  /** Read-only: platform fees repaid on the line and not yet withdrawn by treasury. */
  claimableFee(line: bigint): Promise<bigint> {
    return this.read<bigint>("claimable_fee", [scU64(line)]);
  }

  /** Read-only: the recorded outcome of a liquidated line (throws if it was never liquidated). */
  liquidationRecord(line: bigint): Promise<OnChainLiquidationRecord> {
    return this.read<OnChainLiquidationRecord>("liquidation_record", [scU64(line)]);
  }
}
