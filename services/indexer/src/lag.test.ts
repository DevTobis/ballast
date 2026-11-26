import { describe, expect, it } from "vitest";
import { DEFAULT_LAG_ALERT_SECONDS, LEDGER_CLOSE_SECONDS, shouldAlertLag } from "./lag.js";

describe("shouldAlertLag", () => {
  it("does not alert when lag is exactly at threshold", () => {
    // 60 seconds threshold / 5s per ledger = 12 ledgers
    const from = 100;
    const latestAtThreshold = from + 12; // lag = 12 ledgers (60s)
    expect(shouldAlertLag(latestAtThreshold, from, 60)).toBe(false);
  });

  it("alerts when lag is one ledger past threshold", () => {
    // 60 seconds threshold / 5s per ledger = 12 ledgers
    const from = 100;
    const latestPastThreshold = from + 13; // lag = 13 ledgers (65s > 60s)
    expect(shouldAlertLag(latestPastThreshold, from, 60)).toBe(true);
  });

  it("handles NaN seconds by defaulting to DEFAULT_LAG_ALERT_SECONDS", () => {
    const from = 100;
    // Default is 60s (12 ledgers)
    const atDefaultThreshold = from + 12;
    const pastDefaultThreshold = from + 13;

    expect(shouldAlertLag(atDefaultThreshold, from, Number.NaN)).toBe(false);
    expect(shouldAlertLag(pastDefaultThreshold, from, Number.NaN)).toBe(true);
  });

  it("correctly handles seconds not divisible by 5 using ceiling calculation", () => {
    const from = 100;

    // Case A: 61 seconds -> Math.ceil(61 / 5) = 13 ledgers
    expect(shouldAlertLag(from + 13, from, 61)).toBe(false);
    expect(shouldAlertLag(from + 14, from, 61)).toBe(true);

    // Case B: 14 seconds -> Math.ceil(14 / 5) = 3 ledgers
    expect(shouldAlertLag(from + 3, from, 14)).toBe(false);
    expect(shouldAlertLag(from + 4, from, 14)).toBe(true);
  });

  it("returns false when latest is behind from", () => {
    expect(shouldAlertLag(99, 100, 60)).toBe(false);
  });
});
