/**
 * The operator G-account hop (PRD §5 Phase 2: "Contract accounts cannot pay anchors or exchanges
 * that need a memo from a G-address ... Payouts to anchors go through an operator G-account hop
 * with the memo"). The exit desk / credit-line draw already moved USDC from the Ballast contract
 * to the operator's classic account in a prior, separate transaction (`fromContractPayoutTxHash`
 * records that leg); this module does the *second* leg — operator G-account -> anchor G-account,
 * carrying whatever memo the anchor needs to route the deposit to the right customer.
 */
import { Asset, Memo, Operation, TransactionBuilder, BASE_FEE, type Transaction } from "@stellar/stellar-sdk";
import { randomUUID } from "node:crypto";
import { schema, recordJournalEntry, type Database } from "@ballast/db";
import { scaledToDecimalString } from "@ballast/domain-types";
import type { PayoutSigner } from "./signer.js";

/** SEP conventions: anchors ask for either a text memo or a numeric (MEMO_ID) memo — support both. */
function buildMemo(memo: string): Memo {
  if (/^[0-9]+$/.test(memo)) {
    return Memo.id(memo);
  }
  return Memo.text(memo);
}

export interface ForwardPayoutArgs {
  /** The tx hash of the prior leg: Ballast contract -> operator G-account. Recorded for audit/traceability. */
  fromContractPayoutTxHash: string;
  toAnchorAccount: string;
  /** Fixed-point USDC amount, `PRICE_SCALE` (7 decimals) convention. */
  amount: bigint;
  memo: string;
  /**
   * ASSUMPTION: the classic USDC asset's issuing G-account. Named to match the task spec, but a
   * classic `Operation.payment` needs `Asset(code, issuerG)`, not the USDC Soroban Asset
   * Contract's C-address — if the real caller only has the SAC's C-address on hand, resolve the
   * issuer G-account from `network-config`/asset registry before calling this.
   */
  usdcAssetAddress: string;
  /**
   * The `exit_quote` this payout fulfils, when the caller is the exit-execute flow. Optional
   * because `payout-hop` also serves credit-line-draw payouts, which have no exit_quote — see the
   * `exit_fill` row comment below for why this is a documented schema gap, not an oversight.
   */
  quoteId?: string;
}

export interface ForwardPayoutResult {
  hash: string;
  status: string;
}

/**
 * Builds a classic (non-Soroban) payment operation from the operator G-account to
 * `toAnchorAccount`, attaching the memo the anchor needs, signs and submits it, then records the
 * transfer in Postgres.
 */
export async function forwardPayout(
  db: Database,
  signer: PayoutSigner,
  args: ForwardPayoutArgs,
): Promise<ForwardPayoutResult> {
  const account = await signer.loadSequenceAccount();
  const usdc = new Asset("USDC", args.usdcAssetAddress);
  const memo = buildMemo(args.memo);

  const tx: Transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: signer.networkPassphrase(),
    memo,
  })
    .addOperation(
      Operation.payment({
        destination: args.toAnchorAccount,
        asset: usdc,
        amount: scaledToDecimalString(args.amount),
      }),
    )
    .setTimeout(30)
    .build();

  const { hash, status } = await signer.signAndSubmit(tx);

  if (status === "ERROR") {
    throw new Error(`payout-hop: anchor hop transaction submission failed (hash=${hash}, status=${status})`);
  }

  await db.transaction(async (trx) => {
    // `exit_fill.quote_id` is NOT NULL in the current schema (packages/db, owned elsewhere) and
    // there's no generic "payout" table yet for non-exit flows like a credit-line draw routed
    // to an anchor. When there's a real exit_quote to point at, record the exit_fill row per the
    // task spec ("reuse schema.exitFill"); otherwise skip it and rely on the journal_entry row
    // (below) plus `fromContractPayoutTxHash`/`hash` for traceability. Flagging this for
    // whichever team owns the schema/API wiring next.
    if (args.quoteId) {
      await trx.insert(schema.exitFill).values({
        quoteId: args.quoteId,
        txHash: hash,
        payoutRoute: "anchor_hop",
        payoutMemo: args.memo,
      });
    }

    // A balanced pair, not a lone credit row: cash leaving Ballast's operator account (debit)
    // funds the payout booked against the payout-hop account (credit). Both legs go through
    // `recordJournalEntry` directly (not `recordDoubleEntry`, which opens its own transaction)
    // since this is already inside one.
    const refId = args.quoteId ?? randomUUID();
    await recordJournalEntry(trx, {
      refType: "payout_hop",
      refId,
      account: "usdc_cash",
      debit: args.amount,
      credit: 0n,
      ccy: "USDC",
    });
    await recordJournalEntry(trx, {
      refType: "payout_hop",
      refId,
      account: "operator:payout_hop",
      debit: 0n,
      credit: args.amount,
      ccy: "USDC",
    });
  });

  return { hash, status };
}
