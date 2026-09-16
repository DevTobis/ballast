/**
 * MOCK independent feed adapter — stands in for a real RedStone SEP-40 feed read (PRD §6.4's
 * "Check" source, weight 1, live for USDY/deJTRSY/deJAAA/Etherfuse debt per PRD §18). No real
 * network call is made; swap for a real implementation behind `IndependentFeedAdapter`.
 */
import type { IndependentFeedAdapter } from "./types.js";

const PRICE_SCALE = 10_000_000n;

export class MockRedstoneAdapter implements IndependentFeedAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 3,
  ) {}

  async fetchPrice(_assetCode: string): Promise<{ value: bigint; ts: number }> {
    const wobbleBps = BigInt(Math.round((Math.random() - 0.5) * 2 * this.maxJitterBps));
    return {
      value: this.baseValue + (this.baseValue * wobbleBps) / 10_000n,
      ts: Math.floor(Date.now() / 1000),
    };
  }
}
