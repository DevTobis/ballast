import { describe, expect, it } from "vitest";
import { recordDoubleEntry, recordJournalEntry } from "./journal.js";

interface FakeTrx {
  insert: () => { values: (row: Record<string, unknown>) => Promise<void> };
}

function fakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const trx: FakeTrx = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      },
    }),
  };
  const db = {
    ...trx,
    transaction: async (fn: (trx: FakeTrx) => Promise<void>) => fn(trx),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, inserted };
}

describe("recordDoubleEntry", () => {
  it("inserts a balanced debit and credit row for the same amount, atomically", async () => {
    const { db, inserted } = fakeDb();

    await recordDoubleEntry(db, {
      refType: "draw",
      refId: "11111111-1111-1111-1111-111111111111",
      debitAccount: "borrower:usdc",
      creditAccount: "lender:usdc",
      amount: 250_0000000n, // 250.0000000
      ccy: "USDC",
    });

    expect(inserted).toHaveLength(2);
    const [debitRow, creditRow] = inserted;
    expect(debitRow).toMatchObject({ account: "borrower:usdc", debit: "250.0000000", credit: "0.0000000" });
    expect(creditRow).toMatchObject({ account: "lender:usdc", debit: "0.0000000", credit: "250.0000000" });
    // both legs share the same refType/refId, tying them to the same logical event
    expect(debitRow.refId).toBe(creditRow.refId);
    expect(debitRow.refType).toBe(creditRow.refType);
  });

  it("rejects a non-positive amount", async () => {
    const { db } = fakeDb();
    await expect(
      recordDoubleEntry(db, {
        refType: "draw",
        refId: "id",
        debitAccount: "a",
        creditAccount: "b",
        amount: 0n,
        ccy: "USDC",
      }),
    ).rejects.toThrow();
  });
});

describe("recordJournalEntry", () => {
  it("rejects a row that is both a debit and a credit leg", async () => {
    const { db } = fakeDb();
    await expect(
      recordJournalEntry(db, {
        refType: "draw",
        refId: "id",
        account: "a",
        debit: 10n,
        credit: 10n,
        ccy: "USDC",
      }),
    ).rejects.toThrow();
  });

  it("rejects a row that is neither a debit nor a credit leg", async () => {
    const { db } = fakeDb();
    await expect(
      recordJournalEntry(db, {
        refType: "draw",
        refId: "id",
        account: "a",
        debit: 0n,
        credit: 0n,
        ccy: "USDC",
      }),
    ).rejects.toThrow();
  });
});
