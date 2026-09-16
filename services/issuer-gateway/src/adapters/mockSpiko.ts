import type { IssuerAdapter } from "../adapter.js";
import { SECONDS_PER_DAY, delay, randomRef } from "./shared.js";

/**
 * MOCK adapter for Spiko (PRD §5 Phase 1 asset #1: "An EU/US T-bill MMF with a price feed" —
 * Spiko is the largest on Stellar at ~$1.55B). Real integration is Phase 0 work; every response
 * here is a plausible fake, not a live call to Spiko's back office.
 */
export class MockSpikoAdapter implements IssuerAdapter {
  /** ASSUMPTION: Spiko's EUTBL/USTBL funds settle redemptions T+1. */
  private readonly redemptionLagDays = 1;

  async requestAuthorization(assetCode: string, holderAddress: string): Promise<{ approved: boolean; ref: string }> {
    await delay(150);
    void assetCode;
    void holderAddress;
    return { approved: true, ref: randomRef("spiko-auth") };
  }

  async requestSep8Approval(
    assetCode: string,
    txXdr: string,
  ): Promise<{ approved: boolean; approvedTxXdr?: string; reason?: string }> {
    await delay(300);
    void assetCode;
    return { approved: true, approvedTxXdr: txXdr };
  }

  async requestLienFreeze(
    assetCode: string,
    holderAddress: string,
    units: bigint,
  ): Promise<{ lienRef: string }> {
    await delay(200);
    void assetCode;
    void holderAddress;
    void units;
    return { lienRef: randomRef("spiko-lien") };
  }

  async requestLienRelease(assetCode: string, lienRef: string): Promise<void> {
    await delay(150);
    void assetCode;
    void lienRef;
  }

  async requestRedemption(
    assetCode: string,
    units: bigint,
    destination: string,
  ): Promise<{ redemptionRef: string; expectedSettlementAt: number }> {
    await delay(250);
    void assetCode;
    void units;
    void destination;
    const expectedSettlementAt = Math.floor(Date.now() / 1000) + this.redemptionLagDays * SECONDS_PER_DAY;
    return { redemptionRef: randomRef("spiko-redeem"), expectedSettlementAt };
  }
}
