import { describe, expect, it, vi } from "vitest";
import {
  AMOUNT_HINT,
  formatDecimalString,
  formatDuration,
  formatScaledBigintString,
  toScaled,
} from "../format.ts";

describe("toScaled", () => {
  it.each([
    ["100", 1_000_000_000n],
    ["100.25", 1_002_500_000n],
    ["0.0000001", 1n],
    [".5", 5_000_000n],
    ["  7  ", 70_000_000n],
  ])("accepts %s", (input, expected) => {
    expect(toScaled(input)).toBe(expected);
  });

  it.each(["1.2.3", "", "abc", "-5", "1e3", "0.00000001", "1,5"])("rejects %j with a readable message", (input) => {
    expect(() => toScaled(input)).toThrow(AMOUNT_HINT);
  });
});

describe("formatScaledBigintString", () => {
  it("formats a scaled integer", () => {
    expect(formatScaledBigintString("12500000", "USDC")).toBe("1.25 USDC");
  });

  it("returns a placeholder instead of throwing for a decimal string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => formatScaledBigintString("12.5")).not.toThrow();
    expect(formatScaledBigintString("12.5")).toBe("--");
    warn.mockRestore();
  });

  it("returns a placeholder for an empty or missing value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatScaledBigintString("")).toBe("--");
    expect(formatScaledBigintString(undefined as unknown as string)).toBe("--");
    warn.mockRestore();
  });
});

describe("formatDecimalString", () => {
  it("keeps fractional token units instead of rounding to two places", () => {
    expect(formatDecimalString("0.0004")).toBe((0.0004).toLocaleString(undefined, { maximumFractionDigits: 7 }));
    expect(formatDecimalString("1.2345678")).not.toBe(formatDecimalString("1.23"));
  });
});

describe("formatDuration", () => {
  it.each([
    [1800, "30 min"],
    [21600, "6 h"],
    [86400, "24 h"],
    [259200, "3 d"],
  ])("%d s -> %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("is safe for bad input", () => {
    expect(formatDuration(Number.NaN)).toBe("--");
    expect(formatDuration(-1)).toBe("--");
  });
});
