import { describe, expect, it } from "vitest";
import { Account, Keypair, MemoID, MemoText, Networks, type Transaction } from "@stellar/stellar-sdk";
import { schema } from "@ballast/db";
import {
  DuplicatePayoutError,
  PayoutRefusedError,
  forwardPayout,
  loadPayoutPolicy,
  type ForwardPayoutArgs,
  type PayoutPolicy,
} from "./hop.js";
import type { PayoutSigner } from "./signer.js";
import {
  FirstLegRefusedError,
  FirstLegUnavailableError,
  type FirstLegExpectation,
  type FirstLegVerifier,
} from "./firstLeg.js";

const OPERATOR = Keypair.random().publicKey();
const ANCHOR = Keypair.random().publicKey();
const OTHER_ANCHOR = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();
const UNIT = 10_000_000n;

const policy: PayoutPolicy = { allowedDestinations: new Set([ANCHOR]), usdcIssuer: USDC_ISSUER, maxAmount: 10_000n * UNIT };

function fakeSigner(status = "PENDING"): PayoutSigner & { submittedTx: Transaction | null; calls: number } {
  const signer = {
    submittedTx: null as Transaction | null,
    calls: 0,
    publicKey: () => OPERATOR,
    networkPassphrase: () => Networks.STANDALONE,
    loadSequenceAccount: async () => new Account(OPERATOR, "100"),
    signAndSubmit: async (tx: Transaction) => {
      signer.calls++;
      signer.submittedTx = tx;
      return { hash: "fakehash123", status };
    },
  };
  return signer;
}

/** Accepts every first leg; the first-leg tests below swap in one that refuses or is down. */
const verified: FirstLegVerifier = { verify: async () => {} };

/**
 * Stateful fake of the slice of `Database` the hop touches: the payout_forward claim table
 * (insert-or-ignore, status updates) and a transaction for the journal rows.
 */
function fakeDb() {
  const claims = new Map<string, { status: string; txHash?: string; toAccount: string }>();
  const inserted: Array<{ table: unknown; row: Record<string, unknown> }> = [];
  const insertInto = (sink: Array<{ table: unknown; row: Record<string, unknown> }>) => (table: unknown) => ({
    values: (row: Record<string, unknown>) => {
      const record = () => sink.push({ table, row });
      const isClaim = table === schema.payoutForward;
      return Object.assign(Promise.resolve(record()), {
        onConflictDoNothing: () => ({
          returning: async () => {
            const key = row.fromTxHash as string;
            if (isClaim && claims.has(key)) return [];
            if (isClaim) claims.set(key, { status: "claimed", toAccount: row.toAccount as string });
            return [{ fromTxHash: key }];
          },
        }),
      });
    },
  });
  let lastSet: Record<string, unknown> = {};
  const db = {
    insert: insertInto(inserted),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        lastSet = set;
        return {
          where: () => {
            // The only conditional update is the "re-claim a failed payout" one; apply it to the failed claims.
            const reclaimable = [...claims.entries()].filter(([, c]) => c.status === "failed");
            const touched = set.status === "claimed" ? reclaimable : [...claims.entries()];
            for (const [, c] of touched) Object.assign(c, set);
            return Object.assign(Promise.resolve(), {
              returning: async () => (set.status === "claimed" ? touched.map(([k]) => ({ fromTxHash: k })) : []),
            });
          },
        };
      },
    }),
    transaction: async (fn: (trx: unknown) => Promise<void>) => fn({ insert: insertInto(inserted) }),
  } as unknown as Parameters<typeof forwardPayout>[0];
  return { db, inserted, claims, lastSet: () => lastSet };
}

const base = (over: Partial<ForwardPayoutArgs> = {}): ForwardPayoutArgs => ({
  fromContractPayoutTxHash: "contracttxhash",
  toAnchorAccount: ANCHOR,
  amount: 5_000n * UNIT,
  memo: "customer-ref-123",
  usdcAssetAddress: USDC_ISSUER,
  quoteId: "9d1f8f2a-1234-4a3b-9c00-abcdefabcdef",
  ...over,
});

describe("forwardPayout", () => {
  it("attaches Memo.text for a non-numeric memo and records exit_fill + a balanced journal pair", async () => {
    const signer = fakeSigner();
    const { db, inserted, claims } = fakeDb();

    const result = await forwardPayout(db, signer, verified, base(), policy);

    expect(result).toEqual({ hash: "fakehash123", status: "PENDING" });
    expect(signer.submittedTx?.memo.type).toBe(MemoText);
    expect(Buffer.from(signer.submittedTx?.memo.value as Uint8Array).toString()).toBe("customer-ref-123");
    expect(claims.get("contracttxhash")).toMatchObject({ status: "sent", txHash: "fakehash123" });

    const rows = inserted.filter((i) => i.table !== schema.payoutForward);
    expect(rows).toHaveLength(3);
    expect(rows.find((i) => i.row.payoutRoute === "anchor_hop")).toMatchObject({
      row: { payoutRoute: "anchor_hop", payoutMemo: "customer-ref-123", txHash: "fakehash123" },
    });
    expect(rows.find((i) => i.row.account === "usdc_cash")).toMatchObject({
      row: { account: "usdc_cash", debit: "5000.0000000", credit: "0.0000000", ccy: "USDC" },
    });
    expect(rows.find((i) => i.row.account === "operator:payout_hop")).toMatchObject({
      row: { account: "operator:payout_hop", debit: "0.0000000", credit: "5000.0000000", ccy: "USDC" },
    });
  });

  it("attaches Memo.id for a numeric memo, and skips exit_fill when there's no quoteId", async () => {
    const signer = fakeSigner();
    const { db, inserted } = fakeDb();

    await forwardPayout(db, signer, verified, base({ fromContractPayoutTxHash: "h2", amount: 10n * UNIT, memo: "88221199", quoteId: undefined }), policy);

    expect(signer.submittedTx?.memo.type).toBe(MemoID);
    expect(signer.submittedTx?.memo.value?.toString()).toBe("88221199");
    expect(inserted.filter((i) => i.table !== schema.payoutForward)).toHaveLength(2);
  });

  it("pays a given first-leg transaction once, however many times it is asked", async () => {
    const signer = fakeSigner();
    const { db } = fakeDb();

    await forwardPayout(db, signer, verified, base(), policy);
    await expect(forwardPayout(db, signer, verified, base(), policy)).rejects.toBeInstanceOf(DuplicatePayoutError);
    await expect(forwardPayout(db, signer, verified, base({ amount: 1n * UNIT }), policy)).rejects.toBeInstanceOf(DuplicatePayoutError);

    expect(signer.calls).toBe(1);
  });

  it("lets a payout that failed to send be tried again, and pays it once it succeeds", async () => {
    const { db, claims } = fakeDb();
    const failing: PayoutSigner = { ...fakeSigner(), signAndSubmit: async () => { throw new Error("rpc down"); } };
    await expect(forwardPayout(db, failing, verified, base(), policy)).rejects.toThrow("rpc down");
    expect(claims.get("contracttxhash")?.status).toBe("failed");

    const working = fakeSigner();
    await forwardPayout(db, working, verified, base(), policy);
    expect(working.calls).toBe(1);
    expect(claims.get("contracttxhash")?.status).toBe("sent");
  });

  it("treats a network ERROR status as a failed payout, not a sent one", async () => {
    const { db, claims } = fakeDb();
    await expect(forwardPayout(db, fakeSigner("ERROR"), verified, base(), policy)).rejects.toThrow(/submission failed/);
    expect(claims.get("contracttxhash")?.status).toBe("failed");
  });
});

describe("first-leg verification", () => {
  it("asks the verifier whether the named hash paid the operator at least the requested USDC", async () => {
    const seen: FirstLegExpectation[] = [];
    const recording: FirstLegVerifier = { verify: async (e) => { seen.push(e); } };
    const { db } = fakeDb();

    await forwardPayout(db, fakeSigner(), recording, base(), policy);

    expect(seen).toEqual([
      { txHash: "contracttxhash", operator: OPERATOR, usdcIssuer: USDC_ISSUER, minAmount: 5_000n * UNIT },
    ]);
  });

  it.each([
    "first-leg transaction contracttxhash was not found on the network",
    "first-leg transaction contracttxhash did not succeed (status FAILED)",
    "first-leg transaction did not pay the configured USDC to the operator account",
    "first leg paid the operator 4999.0000000 USDC, less than the 5000.0000000 requested",
  ])("refuses before claiming or sending when the verifier says: %s", async (reason) => {
    const signer = fakeSigner();
    const { db, claims } = fakeDb();
    const refusing: FirstLegVerifier = { verify: async () => { throw new FirstLegRefusedError(reason); } };

    await expect(forwardPayout(db, signer, refusing, base(), policy)).rejects.toThrow(new FirstLegRefusedError(reason));

    expect(claims.size).toBe(0);
    expect(signer.calls).toBe(0);
  });

  it("claims nothing when the verifier cannot reach the network, so a later request can still pay", async () => {
    const signer = fakeSigner();
    const { db, claims } = fakeDb();
    const down: FirstLegVerifier = { verify: async () => { throw new FirstLegUnavailableError("rpc timeout"); } };

    await expect(forwardPayout(db, signer, down, base(), policy)).rejects.toBeInstanceOf(FirstLegUnavailableError);
    expect(claims.size).toBe(0);
    expect(signer.calls).toBe(0);

    await forwardPayout(db, signer, verified, base(), policy);
    expect(signer.calls).toBe(1);
  });

  it("does not consult the verifier for a payout the policy already refuses", async () => {
    let asked = false;
    const { db } = fakeDb();
    const watching: FirstLegVerifier = { verify: async () => { asked = true; } };

    await expect(forwardPayout(db, fakeSigner(), watching, base({ toAnchorAccount: OTHER_ANCHOR }), policy)).rejects.toBeInstanceOf(PayoutRefusedError);
    expect(asked).toBe(false);
  });
});

describe("payout policy", () => {
  const refused = async (over: Partial<ForwardPayoutArgs>, reason: RegExp) => {
    const signer = fakeSigner();
    const { db, claims } = fakeDb();
    await expect(forwardPayout(db, signer, verified, base(over), policy)).rejects.toThrow(reason);
    await expect(forwardPayout(db, signer, verified, base(over), policy)).rejects.toBeInstanceOf(PayoutRefusedError);
    expect(signer.calls).toBe(0);
    expect(claims.size).toBe(0); // refused before anything was claimed
  };

  it("refuses a destination that is not an approved anchor", () => refused({ toAnchorAccount: OTHER_ANCHOR }, /approved anchor/));
  it("refuses an asset other than the configured USDC", () => refused({ usdcAssetAddress: Keypair.random().publicKey() }, /configured USDC/));
  it("refuses an amount over the cap", () => refused({ amount: 10_001n * UNIT }, /per-payout cap/));
  it("refuses zero and negative amounts", async () => {
    await refused({ amount: 0n }, /positive/);
    await refused({ amount: -5n }, /positive/);
  });
  it("refuses a text memo that cannot fit a MEMO_TEXT", () => refused({ memo: "x".repeat(29) }, /28 bytes/));
  it("refuses a numeric memo that overflows a MEMO_ID", () => refused({ memo: "18446744073709551616" }, /MEMO_ID/));

  it("accepts a payout exactly at the cap", async () => {
    const { db } = fakeDb();
    await expect(forwardPayout(db, fakeSigner(), verified, base({ amount: 10_000n * UNIT }), policy)).resolves.toBeDefined();
  });
});

describe("loadPayoutPolicy", () => {
  const env = { PAYOUT_HOP_USDC_ISSUER: USDC_ISSUER, PAYOUT_HOP_ALLOWED_DESTINATIONS: `${ANCHOR}, ${OTHER_ANCHOR}` };

  it("reads the issuer, the approved destinations and the cap", () => {
    const p = loadPayoutPolicy({ ...env, PAYOUT_HOP_MAX_AMOUNT: "250" });
    expect([...p.allowedDestinations]).toEqual([ANCHOR, OTHER_ANCHOR]);
    expect(p.maxAmount).toBe(250n * UNIT);
    expect(loadPayoutPolicy(env).maxAmount).toBe(5_000n * UNIT);
  });

  it("refuses to start without an issuer, a destination list or valid addresses", () => {
    expect(() => loadPayoutPolicy({})).toThrow(/USDC_ISSUER/);
    expect(() => loadPayoutPolicy({ PAYOUT_HOP_USDC_ISSUER: USDC_ISSUER })).toThrow(/ALLOWED_DESTINATIONS/);
    expect(() => loadPayoutPolicy({ ...env, PAYOUT_HOP_ALLOWED_DESTINATIONS: "GNOTANADDRESS" })).toThrow(/not a G-address/);
  });
});
