import { describe, expect, it } from "vitest";
import {
  createDrawSchema,
  createPledgeSchema,
  createRepaymentSchema,
  exitExecuteSchema,
  exitQuoteRequestSchema,
  fundCreditLineSchema,
  nonNegativeAmount,
  openCreditLineSchema,
  positiveAmount,
  repoProposalSchema,
  repoTopUpSchema,
  repoTradeActionSchema,
  withdrawSchema,
} from "../schemas.js";

describe("schemas amount validation", () => {
  describe("positiveAmount helper", () => {
    it("accepts valid positive digit strings", () => {
      expect(positiveAmount.parse("1")).toBe(1n);
      expect(positiveAmount.parse("10000000")).toBe(10000000n);
      expect(positiveAmount.parse("9007199254740993")).toBe(9007199254740993n);
    });

    it("accepts valid positive safe numbers", () => {
      expect(positiveAmount.parse(1)).toBe(1n);
      expect(positiveAmount.parse(1000)).toBe(1000n);
      expect(positiveAmount.parse(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    });

    it("rejects zero", () => {
      expect(() => positiveAmount.parse("0")).toThrow();
      expect(() => positiveAmount.parse(0)).toThrow();
      expect(() => positiveAmount.parse("0000")).toThrow();
    });

    it("rejects negative numbers and strings", () => {
      expect(() => positiveAmount.parse("-5")).toThrow();
      expect(() => positiveAmount.parse(-5)).toThrow();
    });

    it("rejects empty strings", () => {
      expect(() => positiveAmount.parse("")).toThrow();
    });

    it("rejects hex strings", () => {
      expect(() => positiveAmount.parse("0x10")).toThrow();
      expect(() => positiveAmount.parse("0x0")).toThrow();
    });

    it("rejects unsafe numbers (past MAX_SAFE_INTEGER) and floats/exponential notation", () => {
      expect(() => positiveAmount.parse(9007199254740993)).toThrow();
      expect(() => positiveAmount.parse(1e30)).toThrow();
      expect(() => positiveAmount.parse(1.5)).toThrow();
      expect(() => positiveAmount.parse("1e30")).toThrow();
      expect(() => positiveAmount.parse("1.5")).toThrow();
    });
  });

  describe("nonNegativeAmount helper", () => {
    it("accepts zero", () => {
      expect(nonNegativeAmount.parse("0")).toBe(0n);
      expect(nonNegativeAmount.parse(0)).toBe(0n);
    });

    it("accepts positive amounts", () => {
      expect(nonNegativeAmount.parse("100")).toBe(100n);
      expect(nonNegativeAmount.parse(100)).toBe(100n);
    });

    it("rejects negative numbers and strings", () => {
      expect(() => nonNegativeAmount.parse("-1")).toThrow();
      expect(() => nonNegativeAmount.parse(-1)).toThrow();
    });

    it("rejects empty strings and hex strings", () => {
      expect(() => nonNegativeAmount.parse("")).toThrow();
      expect(() => nonNegativeAmount.parse("0x10")).toThrow();
    });

    it("rejects unsafe numbers", () => {
      expect(() => nonNegativeAmount.parse(9007199254740993)).toThrow();
      expect(() => nonNegativeAmount.parse(1e30)).toThrow();
    });
  });

  describe("rejection across all amount-bearing schemas", () => {
    const invalidInputs = ["0", 0, "-5", -5, "", "0x10", 9007199254740993, 1e30];

    it("fundCreditLineSchema rejects invalid amount inputs", () => {
      for (const input of invalidInputs) {
        expect(() => fundCreditLineSchema.parse({ amount: input })).toThrow();
      }
    });

    it("withdrawSchema rejects invalid amount inputs", () => {
      for (const input of invalidInputs) {
        expect(() => withdrawSchema.parse({ kind: "undrawn", amount: input })).toThrow();
      }
    });

    it("createDrawSchema rejects invalid amount inputs", () => {
      for (const input of invalidInputs) {
        expect(() => createDrawSchema.parse({ amount: input, to: "GACCOUNT" })).toThrow();
      }
    });

    it("createRepaymentSchema rejects invalid amount inputs", () => {
      for (const input of invalidInputs) {
        expect(() => createRepaymentSchema.parse({ amount: input })).toThrow();
      }
    });

    it("exitExecuteSchema rejects invalid minUsdcOut inputs", () => {
      for (const input of invalidInputs) {
        expect(() => exitExecuteSchema.parse({ minUsdcOut: input, to: "GACCOUNT" })).toThrow();
      }
    });

    it("exitQuoteRequestSchema rejects invalid units inputs", () => {
      for (const input of invalidInputs) {
        expect(() =>
          exitQuoteRequestSchema.parse({
            assetId: "00000000-0000-0000-0000-000000000000",
            units: input,
          }),
        ).toThrow();
      }
    });

    it("repoTopUpSchema rejects invalid units inputs", () => {
      for (const input of invalidInputs) {
        expect(() => repoTopUpSchema.parse({ units: input })).toThrow();
      }
    });

    it("repoProposalSchema rejects invalid units and cashAmount inputs", () => {
      const base = {
        cashLenderId: "00000000-0000-0000-0000-000000000000",
        cashBorrowerId: "11111111-1111-1111-1111-111111111111",
        assetId: "22222222-2222-2222-2222-222222222222",
        units: "100",
        cashAmount: "100",
        rateBps: 500,
        kind: "overnight" as const,
        maturityAt: new Date().toISOString(),
        agreementHash: "0x1234",
      };
      for (const input of invalidInputs) {
        expect(() => repoProposalSchema.parse({ ...base, units: input })).toThrow();
        expect(() => repoProposalSchema.parse({ ...base, cashAmount: input })).toThrow();
      }
    });

    it("openCreditLineSchema rejects invalid limit inputs", () => {
      const base = {
        lenderId: "00000000-0000-0000-0000-000000000000",
        borrowerId: "11111111-1111-1111-1111-111111111111",
        loanCcy: "USDC",
        limit: "1000",
        rateBps: 500,
        cureWindowS: 3600,
        asset: "CASSET",
        agreementHash: "0x1234",
      };
      for (const input of invalidInputs) {
        expect(() => openCreditLineSchema.parse({ ...base, limit: input })).toThrow();
      }
    });

    it("createPledgeSchema rejects invalid units inputs", () => {
      for (const input of invalidInputs) {
        expect(() =>
          createPledgeSchema.parse({
            assetId: "00000000-0000-0000-0000-000000000000",
            units: input,
            custodyMode: "escrow",
          }),
        ).toThrow();
      }
    });

    it("repoTradeActionSchema allows zero and positive for contractTradeId, but rejects negative, hex, and unsafe numbers", () => {
      expect(repoTradeActionSchema.parse({ contractTradeId: "0" }).contractTradeId).toBe(0n);
      expect(repoTradeActionSchema.parse({ contractTradeId: 0 }).contractTradeId).toBe(0n);
      expect(repoTradeActionSchema.parse({ contractTradeId: "10" }).contractTradeId).toBe(10n);
      expect(repoTradeActionSchema.parse({}).contractTradeId).toBeUndefined();

      expect(() => repoTradeActionSchema.parse({ contractTradeId: "-1" })).toThrow();
      expect(() => repoTradeActionSchema.parse({ contractTradeId: -1 })).toThrow();
      expect(() => repoTradeActionSchema.parse({ contractTradeId: "0x10" })).toThrow();
      expect(() => repoTradeActionSchema.parse({ contractTradeId: 9007199254740993 })).toThrow();
    });
  });
});
