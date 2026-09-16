/**
 * MOCK issuer NAV adapters for the PRD §5 Phase 1 priority assets (Spiko, Etherfuse, Franklin).
 * Real issuer NAV integrations (signed feeds or verified endpoints per PRD §6.4) are Phase 0/1
 * work — every class below is explicitly named and doc-commented as a mock, and makes no real
 * network calls. Swap these for real adapters behind the same `IssuerNavAdapter` interface once
 * an issuer integration exists.
 */
import type { IssuerNavAdapter } from "./types.js";

const PRICE_SCALE = 10_000_000n;

function jitteredDollar(baseValue: bigint, maxJitterBps: number): bigint {
  const wobbleBps = BigInt(Math.round((Math.random() - 0.5) * 2 * maxJitterBps));
  return baseValue + (baseValue * wobbleBps) / 10_000n;
}

/** MOCK — stands in for a real Spiko NAV feed integration. */
export class MockSpikoAdapter implements IssuerNavAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 2,
  ) {}

  async fetchNav(_assetCode: string): Promise<{ value: bigint; ts: number }> {
    return {
      value: jitteredDollar(this.baseValue, this.maxJitterBps),
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

/** MOCK — stands in for a real Etherfuse (CETES) NAV feed integration. */
export class MockEtherfuseAdapter implements IssuerNavAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 5,
  ) {}

  async fetchNav(_assetCode: string): Promise<{ value: bigint; ts: number }> {
    return {
      value: jitteredDollar(this.baseValue, this.maxJitterBps),
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

/** MOCK — stands in for a real Franklin Templeton (BENJI) NAV feed integration. */
export class MockFranklinAdapter implements IssuerNavAdapter {
  constructor(
    private readonly baseValue: bigint = PRICE_SCALE,
    private readonly maxJitterBps = 1,
  ) {}

  async fetchNav(_assetCode: string): Promise<{ value: bigint; ts: number }> {
    return {
      value: jitteredDollar(this.baseValue, this.maxJitterBps),
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

/** Naive asset-code -> issuer mapping for this skeleton; real onboarding stores this per asset row. */
export const issuerNavAdapters: Record<string, IssuerNavAdapter> = {
  spiko: new MockSpikoAdapter(),
  etherfuse: new MockEtherfuseAdapter(),
  franklin: new MockFranklinAdapter(),
};

export function issuerAdapterForAsset(assetCode: string): IssuerNavAdapter {
  const key = Object.keys(issuerNavAdapters).find((k) => assetCode.toLowerCase().includes(k));
  return issuerNavAdapters[key ?? "spiko"];
}
