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

export class CreditLineClient extends BaseContractClient {
  open(source: string, args: OpenCreditLineArgs): Promise<string> {
    return this.invoke(source, "open", [
      scAddress(source),
      scAddress(args.borrower),
      scAddress(args.asset),
      scI128(args.limit),
      scU32(args.rateBps),
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

  repay(source: string, line: bigint, amount: bigint): Promise<string> {
    return this.invoke(source, "repay", [scAddress(source), scU64(line), scI128(amount)]);
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
   * `poke` is a state-changing (though permissionless) call, so per Ballast's "never returns a
   * pre-signed tx" rule it returns unsigned XDR like every other write — despite the spec
   * pseudocode's `Promise<MarginState>` return-type annotation, which conflicts with its own
   * "still returns unsigned XDR" comment. Honoring the comment/convention here. See
   * `resolvePokeSource` for how the fee-paying source account is resolved.
   */
  poke(line: bigint): Promise<string> {
    const source = resolvePokeSource();
    return this.invoke(source, "poke", [scAddress(source), scU64(line)]);
  }

  liquidate(source: string, line: bigint, route: LiquidationRoute): Promise<string> {
    return this.invoke(source, "liquidate", [
      scAddress(source),
      scU64(line),
      enumToScVal(ROUTE_VARIANT[route]),
    ]);
  }
}
