import { describe, expect, it, vi } from "vitest";
import { Account, Keypair, MemoID, MemoText, Networks, type Transaction } from "@stellar/stellar-sdk";
import { Param, SQL } from "drizzle-orm";
import { schema } from "@ballast/db";
import type { Alerter } from "@ballast/observability";
import {
  DuplicatePayoutError,
  PayoutRefusedError,
  forwardPayout,
  loadPayoutPolicy,
  type ForwardPayoutArgs,
  type PayoutPolicy,
} from "./hop.js";
import { bookPendingPayouts } from "./repair.js";
import type { PayoutSigner } from "./signer.js";

const OPERATOR = Keypair.random().publicKey();
const ANCHOR = Keypair.random().publicKey();
const OTHER_ANCHOR = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();
const UNIT = 10_000_000n;
const QUOTE_ID = "9d1f8f2a-1234-4a3b-9c00-abcdefabcdef";

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

function fakeAlerter(): Alerter & { fire: ReturnType<typeof vi.fn> } {
  return { fire: vi.fn() };
}

type Row = Record<string, unknown>;

/** Every value bound in a drizzle `eq`/`and` condition. */
function boundValues(condition: unknown): unknown[] {
  if (condition instanceof Param) return [condition.value];
  if (condition instanceof SQL) return condition.queryChunks.flatMap(boundValues);
  return [];
}

/** True when each bound value equals one of the row's fields: enough for the `eq`/`and` filters used here. */
const matches = (row: Row, condition: unknown) => boundValues(condition).every((v) => Object.values(row).includes(v));

/**
 * In-memory stand-in for the slice of `Database` the hop and the repair touch. Tables keep real
 * rows, `where` honours `eq`/`and` filters, the `payout_forward` primary key makes a second claim
 * insert a no-op, and a transaction that throws rolls its writes back.
 *
 * `failNextTransaction` makes the next transaction throw after running its callback (a dropped
 * connection mid-commit); `goDownOnTransaction` additionally makes every later call throw.
 */
function fakeDb() {
  let tables = new Map<unknown, Row[]>();
  const rowsOf = (table: unknown): Row[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const state = { failNextTransaction: null as Error | null, goDownOnTransaction: false, down: false };
  const guard = () => {
    if (state.down) throw new Error("connection terminated");
  };
  const query = <T>(run: () => T, extra: object = {}) =>
    Object.assign(
      {
        then: (resolve: (v: T) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => { guard(); return run(); }).then(resolve, reject),
      },
      extra,
    );
  const project = (row: Row, fields?: Record<string, { name: string }>) =>
    fields ? Object.fromEntries(Object.keys(fields).map((k) => [k, row[k]])) : { ...row };

  const ops = {
    insert: (table: unknown) => ({
      values: (row: Row) => {
        const full =
          table === schema.payoutForward ? { status: "claimed", txHash: null, quoteId: null, ...row } : { ...row };
        return query(() => { rowsOf(table).push(full); }, {
          onConflictDoNothing: () => ({
            returning: async () => {
              guard();
              if (rowsOf(table).some((r) => r.fromTxHash === row.fromTxHash)) return [];
              rowsOf(table).push(full);
              return [{ fromTxHash: row.fromTxHash }];
            },
          }),
        });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: (condition: unknown) => {
          const apply = () => {
            const touched = rowsOf(table).filter((r) => matches(r, condition));
            for (const r of touched) Object.assign(r, set);
            return touched;
          };
          return query(() => { apply(); }, {
            returning: async () => { guard(); return apply().map((r) => ({ fromTxHash: r.fromTxHash })); },
          });
        },
      }),
    }),
    select: (fields?: Record<string, { name: string }>) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const found = () => rowsOf(table).filter((r) => matches(r, condition)).map((r) => project(r, fields));
          return query(found, { limit: (n: number) => query(() => found().slice(0, n)) });
        },
      }),
    }),
  };

  const db = {
    ...ops,
    transaction: async <T>(fn: (trx: typeof ops) => Promise<T>): Promise<T> => {
      guard();
      const snapshot = new Map([...tables].map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
      try {
        const result = await fn(ops);
        if (state.failNextTransaction) {
          const err = state.failNextTransaction;
          state.failNextTransaction = null;
          if (state.goDownOnTransaction) state.down = true;
          throw err;
        }
        return result;
      } catch (err) {
        tables = snapshot;
        throw err;
      }
    },
  } as unknown as Parameters<typeof forwardPayout>[0];

  return {
    db,
    state,
    claim: (hash: string) => rowsOf(schema.payoutForward).find((r) => r.fromTxHash === hash),
    claims: () => rowsOf(schema.payoutForward),
    journal: () => rowsOf(schema.journalEntry),
    exitFills: () => rowsOf(schema.exitFill),
  };
}

const base = (over: Partial<ForwardPayoutArgs> = {}): ForwardPayoutArgs => ({
  fromContractPayoutTxHash: "contracttxhash",
  toAnchorAccount: ANCHOR,
  amount: 5_000n * UNIT,
  memo: "customer-ref-123",
  usdcAssetAddress: USDC_ISSUER,
  quoteId: QUOTE_ID,
  ...over,
});

describe("forwardPayout", () => {
  it("attaches Memo.text for a non-numeric memo and records exit_fill + a balanced journal pair", async () => {
    const signer = fakeSigner();
    const { db, claim, journal, exitFills } = fakeDb();

    const result = await forwardPayout(db, signer, base(), policy, fakeAlerter());

    expect(result).toEqual({ hash: "fakehash123", status: "PENDING", booked: true });
    expect(signer.submittedTx?.memo.type).toBe(MemoText);
    expect(Buffer.from(signer.submittedTx?.memo.value as Uint8Array).toString()).toBe("customer-ref-123");
    expect(claim("contracttxhash")).toMatchObject({ status: "sent", txHash: "fakehash123", refId: QUOTE_ID, quoteId: QUOTE_ID });

    expect(exitFills()).toEqual([
      { quoteId: QUOTE_ID, payoutRoute: "anchor_hop", payoutMemo: "customer-ref-123", txHash: "fakehash123" },
    ]);
    expect(journal()).toEqual([
      { refType: "payout_hop", refId: QUOTE_ID, account: "usdc_cash", debit: "5000.0000000", credit: "0.0000000", ccy: "USDC" },
      { refType: "payout_hop", refId: QUOTE_ID, account: "operator:payout_hop", debit: "0.0000000", credit: "5000.0000000", ccy: "USDC" },
    ]);
  });

  it("attaches Memo.id for a numeric memo, and skips exit_fill when there's no quoteId", async () => {
    const signer = fakeSigner();
    const { db, claim, journal, exitFills } = fakeDb();

    await forwardPayout(db, signer, base({ fromContractPayoutTxHash: "h2", amount: 10n * UNIT, memo: "88221199", quoteId: undefined }), policy, fakeAlerter());

    expect(signer.submittedTx?.memo.type).toBe(MemoID);
    expect(signer.submittedTx?.memo.value?.toString()).toBe("88221199");
    expect(exitFills()).toHaveLength(0);
    // Without a quote the journal pair is booked under the id generated at claim time.
    expect(journal().map((r) => r.refId)).toEqual([claim("h2")?.refId, claim("h2")?.refId]);
  });

  it("pays a given first-leg transaction once, however many times it is asked", async () => {
    const signer = fakeSigner();
    const { db } = fakeDb();

    await forwardPayout(db, signer, base(), policy, fakeAlerter());
    await expect(forwardPayout(db, signer, base(), policy, fakeAlerter())).rejects.toBeInstanceOf(DuplicatePayoutError);
    await expect(forwardPayout(db, signer, base({ amount: 1n * UNIT }), policy, fakeAlerter())).rejects.toBeInstanceOf(DuplicatePayoutError);

    expect(signer.calls).toBe(1);
  });

  it("lets a payout that failed to send be tried again, and pays it once it succeeds", async () => {
    const { db, claim } = fakeDb();
    const failing: PayoutSigner = { ...fakeSigner(), signAndSubmit: async () => { throw new Error("rpc down"); } };
    await expect(forwardPayout(db, failing, base(), policy, fakeAlerter())).rejects.toThrow("rpc down");
    expect(claim("contracttxhash")?.status).toBe("failed");

    const working = fakeSigner();
    await forwardPayout(db, working, base(), policy, fakeAlerter());
    expect(working.calls).toBe(1);
    expect(claim("contracttxhash")?.status).toBe("sent");
  });

  it("treats a network ERROR status as a failed payout, not a sent one", async () => {
    const { db, claim } = fakeDb();
    await expect(forwardPayout(db, fakeSigner("ERROR"), base(), policy, fakeAlerter())).rejects.toThrow(/submission failed/);
    expect(claim("contracttxhash")?.status).toBe("failed");
  });
});

describe("bookkeeping after the payment is sent", () => {
  it("answers with the hash, flags the row bookkeeping_pending and alerts when the booking transaction throws", async () => {
    const signer = fakeSigner();
    const alerter = fakeAlerter();
    const { db, state, claim, journal, exitFills } = fakeDb();
    state.failNextTransaction = new Error("insert on exit_fill violates foreign key constraint");

    const result = await forwardPayout(db, signer, base(), policy, alerter);

    expect(result).toEqual({ hash: "fakehash123", status: "PENDING", booked: false });
    expect(signer.calls).toBe(1);
    // The transaction rolled back, so nothing half-booked; the row says what happened and keeps the hash.
    expect(claim("contracttxhash")).toMatchObject({ status: "bookkeeping_pending", txHash: "fakehash123", refId: QUOTE_ID });
    expect(journal()).toHaveLength(0);
    expect(exitFills()).toHaveLength(0);
    expect(alerter.fire).toHaveBeenCalledWith(
      "payout_unbooked",
      expect.objectContaining({ subject: "contracttxhash", txHash: "fakehash123", refId: QUOTE_ID, flagged: true }),
    );
    expect(alerter.fire.mock.calls[0][1].reason).toMatch(/foreign key constraint/);

    // A caller retrying is still refused: the anchor was paid.
    await expect(forwardPayout(db, signer, base(), policy, alerter)).rejects.toBeInstanceOf(DuplicatePayoutError);
    expect(signer.calls).toBe(1);
  });

  it("still answers with the hash when the database is gone and the row cannot even be flagged", async () => {
    const alerter = fakeAlerter();
    const { db, state, claim } = fakeDb();
    state.failNextTransaction = new Error("connection terminated");
    state.goDownOnTransaction = true;

    const result = await forwardPayout(db, fakeSigner(), base(), policy, alerter);

    expect(result).toEqual({ hash: "fakehash123", status: "PENDING", booked: false });
    expect(claim("contracttxhash")?.status).toBe("claimed");
    expect(alerter.fire).toHaveBeenCalledWith(
      "payout_unbooked",
      expect.objectContaining({ subject: "contracttxhash", txHash: "fakehash123", flagged: false }),
    );
  });
});

describe("bookPendingPayouts", () => {
  /** Sends a payout whose booking fails, leaving it `bookkeeping_pending`. */
  async function unbooked(over: Partial<ForwardPayoutArgs> = {}) {
    const fake = fakeDb();
    fake.state.failNextTransaction = new Error("connection reset");
    await forwardPayout(fake.db, fakeSigner(), base(over), policy, fakeAlerter());
    expect(fake.claim(over.fromContractPayoutTxHash ?? "contracttxhash")?.status).toBe("bookkeeping_pending");
    return fake;
  }

  it("books a pending payout under the refId fixed at claim time, with its exit_fill, and marks it sent", async () => {
    const { db, claim, journal, exitFills } = await unbooked();

    const result = await bookPendingPayouts(db, fakeAlerter());

    expect(result).toEqual({ booked: ["contracttxhash"], alreadyBooked: [], failed: [] });
    expect(claim("contracttxhash")?.status).toBe("sent");
    expect(exitFills()).toEqual([
      { quoteId: QUOTE_ID, payoutRoute: "anchor_hop", payoutMemo: "customer-ref-123", txHash: "fakehash123" },
    ]);
    expect(journal()).toEqual([
      { refType: "payout_hop", refId: QUOTE_ID, account: "usdc_cash", debit: "5000.0000000", credit: "0.0000000", ccy: "USDC" },
      { refType: "payout_hop", refId: QUOTE_ID, account: "operator:payout_hop", debit: "0.0000000", credit: "5000.0000000", ccy: "USDC" },
    ]);
  });

  it("uses the generated refId of a payout with no quote, the same one the original attempt used", async () => {
    const { db, claim, journal, exitFills } = await unbooked({ quoteId: undefined });
    const refId = claim("contracttxhash")?.refId;
    expect(refId).toMatch(/^[0-9a-f-]{36}$/);

    await bookPendingPayouts(db, fakeAlerter());

    expect(journal().map((r) => r.refId)).toEqual([refId, refId]);
    expect(exitFills()).toHaveLength(0);
  });

  it("is idempotent: a second run books nothing more", async () => {
    const { db, journal } = await unbooked();

    await bookPendingPayouts(db, fakeAlerter());
    const again = await bookPendingPayouts(db, fakeAlerter());

    expect(again).toEqual({ booked: [], alreadyBooked: [], failed: [] });
    expect(journal()).toHaveLength(2);
  });

  it("only marks sent a payout whose journal pair did commit (the acknowledgement was what got lost)", async () => {
    const { db, claim, journal } = await unbooked();
    journal().push(
      { refType: "payout_hop", refId: QUOTE_ID, account: "usdc_cash", debit: "5000.0000000", credit: "0.0000000", ccy: "USDC" },
      { refType: "payout_hop", refId: QUOTE_ID, account: "operator:payout_hop", debit: "0.0000000", credit: "5000.0000000", ccy: "USDC" },
    );

    const result = await bookPendingPayouts(db, fakeAlerter());

    expect(result).toEqual({ booked: [], alreadyBooked: ["contracttxhash"], failed: [] });
    expect(journal()).toHaveLength(2);
    expect(claim("contracttxhash")?.status).toBe("sent");
  });

  it("leaves a payout it cannot book pending, alerts, and books it on a later run", async () => {
    const { db, state, claim, journal } = await unbooked();
    const alerter = fakeAlerter();
    state.failNextTransaction = new Error("deadlock detected");

    const first = await bookPendingPayouts(db, alerter);

    expect(first).toEqual({ booked: [], alreadyBooked: [], failed: ["contracttxhash"] });
    expect(claim("contracttxhash")?.status).toBe("bookkeeping_pending");
    expect(journal()).toHaveLength(0);
    expect(alerter.fire).toHaveBeenCalledWith("payout_unbooked", expect.objectContaining({ subject: "contracttxhash" }));

    expect((await bookPendingPayouts(db, alerter)).booked).toEqual(["contracttxhash"]);
    expect(journal()).toHaveLength(2);
  });

  it("leaves claimed, failed and already-sent payouts alone", async () => {
    const { db, claims, journal } = fakeDb();
    claims().push(
      { fromTxHash: "a", status: "claimed", txHash: null, refId: "00000000-0000-4000-8000-000000000001", quoteId: null, amount: "1.0000000", memo: "m" },
      { fromTxHash: "b", status: "failed", txHash: null, refId: "00000000-0000-4000-8000-000000000002", quoteId: null, amount: "1.0000000", memo: "m" },
      { fromTxHash: "c", status: "sent", txHash: "t", refId: "00000000-0000-4000-8000-000000000003", quoteId: null, amount: "1.0000000", memo: "m" },
    );

    expect(await bookPendingPayouts(db, fakeAlerter())).toEqual({ booked: [], alreadyBooked: [], failed: [] });
    expect(journal()).toHaveLength(0);
  });
});

describe("payout policy", () => {
  const refused = async (over: Partial<ForwardPayoutArgs>, reason: RegExp) => {
    const signer = fakeSigner();
    const { db, claims } = fakeDb();
    await expect(forwardPayout(db, signer, base(over), policy, fakeAlerter())).rejects.toThrow(reason);
    await expect(forwardPayout(db, signer, base(over), policy, fakeAlerter())).rejects.toBeInstanceOf(PayoutRefusedError);
    expect(signer.calls).toBe(0);
    expect(claims()).toHaveLength(0); // refused before anything was claimed
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
    await expect(forwardPayout(db, fakeSigner(), base({ amount: 10_000n * UNIT }), policy, fakeAlerter())).resolves.toBeDefined();
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
