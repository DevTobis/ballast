import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { bigintish, fundCreditLineSchema } from "../schemas.js";

describe("bigintish schema", () => {
  it("rejects non-numeric strings, empty strings, floats, null, and non-primitives with ZodError", () => {
    const invalidInputs = ["abc", "", "1.5", 1.5, null, {}];

    for (const input of invalidInputs) {
      // Direct parsing on bigintish
      const directResult = bigintish.safeParse(input);
      expect(directResult.success).toBe(false);
      if (!directResult.success) {
        expect(directResult.error).toBeInstanceOf(ZodError);
        expect(directResult.error.issues.length).toBeGreaterThan(0);
      }

      // Inside a parent request body schema like fundCreditLineSchema
      const parentResult = fundCreditLineSchema.safeParse({ amount: input });
      expect(parentResult.success).toBe(false);
      if (!parentResult.success) {
        expect(parentResult.error).toBeInstanceOf(ZodError);
        expect(parentResult.error.issues.length).toBeGreaterThan(0);
      }

      // Assert parse does not throw SyntaxError or RangeError
      expect(() => bigintish.parse(input)).toThrow(ZodError);
      expect(() => fundCreditLineSchema.parse({ amount: input })).toThrow(ZodError);
    }
  });

  it("successfully parses valid decimal strings and integers to BigInt", () => {
    expect(bigintish.parse("10000000")).toBe(10000000n);
    expect(bigintish.parse(10000000)).toBe(10000000n);
    expect(bigintish.parse("0")).toBe(0n);
    expect(bigintish.parse(0)).toBe(0n);

    const fundResult = fundCreditLineSchema.parse({ amount: "10000000" });
    expect(fundResult.amount).toBe(10000000n);
  });
});
