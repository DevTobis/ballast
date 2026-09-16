import type { IssuerAdapter } from "../adapter.js";
import { SECONDS_PER_DAY, delay, randomRef } from "./shared.js";

/**
 * MOCK adapter for Etherfuse (PRD §5 Phase 1 asset #3 / Phase 4 LATAM bundle: CETES, custodied by
 * Anchorage, with a RedStone feed and an MXN/USD FX haircut). Real integration is Phase 0 work;
 * every response here is a plausible fake, not a live call to Etherfuse's back office.
 */
export class MockEtherfuseAdapter implements IssuerAdapter {
  /** ASSUMPTION: cross-border CETES redemption settles slower than a domestic USD MMF, T+2. */
  private readonly redemptionLagDays = 2;

  async requestAuthorization(assetCode: string, holderAddress: string): Promise<{ approved: boolean; ref: string }> {
    await delay(180);
    void assetCode;
    void holderAddress;
    return { approved: true, ref: randomRef("etherfuse-auth") };
  }

  async requestSep8Approval(
    assetCode: string,
    txXdr: string,
  ): Promise<{ approved: boolean; approvedTxXdr?: string; reason?: string }> {
    await delay(350);
    void assetCode;
    return { approved: true, approvedTxXdr: txXdr };
  }

  async requestLienFreeze(
    assetCode: string,
    holderAddress: string,
    units: bigint,
  ): Promise<{ lienRef: string }> {
    await delay(220);
    void assetCode;
    void holderAddress;
    void units;
    return { lienRef: randomRef("etherfuse-lien") };
  }

  async requestLienRelease(assetCode: string, lienRef: string): Promise<void> {
    await delay(180);
    void assetCode;
    void lienRef;
  }

  async requestRedemption(
    assetCode: string,
    units: bigint,
    destination: string,
  ): Promise<{ redemptionRef: string; expectedSettlementAt: number }> {
    await delay(300);
    void assetCode;
    void units;
    void destination;
    const expectedSettlementAt = Math.floor(Date.now() / 1000) + this.redemptionLagDays * SECONDS_PER_DAY;
    return { redemptionRef: randomRef("etherfuse-redeem"), expectedSettlementAt };
  }
}
