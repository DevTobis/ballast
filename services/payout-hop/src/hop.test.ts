import { describe, expect, it } from "vitest";
import { Account, Keypair, MemoID, MemoText, Networks, type Transaction } from "@stellar/stellar-sdk";
import { forwardPayout } from "./hop.js";
import type { PayoutSigner } from "./signer.js";

const OPERATOR = Keypair.random().publicKey();
const ANCHOR = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();

function fakeSigner(): PayoutSigner & { submittedTx: Transaction | null } {
  const signer = {
    submittedTx: null as Transaction | null,
    publicKey: () => OPERATOR,
    networkPassphrase: () => Networks.STANDALONE,
    loadSequenceAccount: async () => new Account(OPERATOR, "100"),
    signAndSubmit: async (tx: Transaction) => {
      signer.submittedTx = tx;
      return { hash: "fakehash123", status: "PENDING" };
    },
  };
  return signer;
}

interface FakeTrx {
  insert: (table: unknown) => { values: (row: Record<string, unknown>) => Promise<void> };
}

/** Minimal fake of the slice of `Database` `forwardPayout` touches: a transaction with inserts. */
function fakeDb() {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const trx: FakeTrx = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        inserted.push({ table: String(table), row });
        return Promise.resolve();
      },
    }),
  };
  const db = {
    transaction: async (fn: (trx: FakeTrx) => Promise<void>) => fn(trx),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, inserted };
}

describe("forwardPayout", () => {
  it("attaches Memo.text for a non-numeric memo and records exit_fill + journal_entry", async () => {
    const signer = fakeSigner();
    const { db, inserted } = fakeDb();

    const result = await forwardPayout(db, signer, {
      fromContractPayoutTxHash: "contracttxhash",
      toAnchorAccount: ANCHOR,
      amount: 50_000_000_000n, // 5,000.0000000 USDC at 7-decimal scale
      memo: "customer-ref-123",
      usdcAssetAddress: USDC_ISSUER,
      quoteId: "9d1f8f2a-1234-4a3b-9c00-abcdefabcdef",
    });

    expect(result).toEqual({ hash: "fakehash123", status: "PENDING" });
    expect(signer.submittedTx?.memo.type).toBe(MemoText);
    expect(signer.submittedTx?.memo.value?.toString()).toBe("customer-ref-123");

    expect(inserted).toHaveLength(2);
    expect(inserted.find((i) => i.row.payoutRoute === "anchor_hop")).toMatchObject({
      row: { payoutRoute: "anchor_hop", payoutMemo: "customer-ref-123", txHash: "fakehash123" },
    });
    expect(inserted.find((i) => i.row.account === "operator:payout_hop")).toMatchObject({
      row: { account: "operator:payout_hop", credit: "5000.0000000", ccy: "USDC" },
    });
  });

  it("attaches Memo.id for a numeric memo, and skips exit_fill when there's no quoteId", async () => {
    const signer = fakeSigner();
    const { db, inserted } = fakeDb();

    const result = await forwardPayout(db, signer, {
      fromContractPayoutTxHash: "contracttxhash2",
      toAnchorAccount: ANCHOR,
      amount: 10_0000000n, // 10.0000000 USDC
      memo: "88221199",
      usdcAssetAddress: USDC_ISSUER,
    });

    expect(result.status).toBe("PENDING");
    expect(signer.submittedTx?.memo.type).toBe(MemoID);
    expect(signer.submittedTx?.memo.value?.toString()).toBe("88221199");

    // no quoteId -> no exit_fill row, only the journal_entry leg
    expect(inserted).toHaveLength(1);
    expect(inserted[0].row).toMatchObject({ account: "operator:payout_hop", credit: "10.0000000" });
  });
});
