import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  FirstLegRefusedError,
  FirstLegUnavailableError,
  RpcFirstLegVerifier,
  type FirstLegExpectation,
} from "./firstLeg.js";

const PASSPHRASE = Networks.TESTNET;
const OPERATOR = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();
const BALLAST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const OTHER_ISSUER = Keypair.random().publicKey();
const USDC = new Asset("USDC", ISSUER);
const UNIT = 10_000_000n;
const HASH = "a".repeat(64);

const expected = (over: Partial<FirstLegExpectation> = {}): FirstLegExpectation => ({
  txHash: HASH,
  operator: OPERATOR,
  usdcIssuer: ISSUER,
  minAmount: 10n * UNIT,
  ...over,
});

function envelope(...ops: xdr.Operation[]): xdr.TransactionEnvelope {
  const builder = new TransactionBuilder(new Account(BALLAST, "1"), { fee: "100", networkPassphrase: PASSPHRASE });
  for (const op of ops.length ? ops : [Operation.bumpSequence({ bumpTo: "2" })]) builder.addOperation(op);
  return builder.setTimeout(30).build().toEnvelope();
}

const pay = (destination: string, amount: string, asset: Asset = USDC) => Operation.payment({ destination, asset, amount });

/** A `transfer` event as the USDC Stellar Asset Contract (or, with `contract`, any other contract) emits it. */
function transferEvent(
  to: string,
  amount: bigint,
  opts: { contract?: string; asset?: Asset; mapData?: boolean } = {},
): xdr.ContractEvent {
  const asset = opts.asset ?? USDC;
  const contract = opts.contract ?? asset.contractId(PASSPHRASE);
  const data = opts.mapData
    ? nativeToScVal({ amount, to_muxed_id: 7n }, { type: { amount: ["symbol", "i128"], to_muxed_id: ["symbol", "u64"] } })
    : nativeToScVal(amount, { type: "i128" });
  return new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: new xdr.ContractId(StrKey.decodeContract(contract)),
    type: xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(
      new xdr.ContractEventV0({
        topics: [
          nativeToScVal("transfer", { type: "symbol" }),
          nativeToScVal(BALLAST, { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(`${asset.getCode()}:${asset.getIssuer()}`, { type: "string" }),
        ],
        data,
      }),
    ),
  });
}

function success(envelopeXdr: xdr.TransactionEnvelope, events: xdr.ContractEvent[] = []): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: HASH,
    envelopeXdr,
    events: { transactionEventsXdr: [], contractEventsXdr: [events] },
  } as unknown as rpc.Api.GetTransactionResponse;
}

function verifier(response: rpc.Api.GetTransactionResponse | Error) {
  const getTransaction = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { verifier: new RpcFirstLegVerifier({ getTransaction }, PASSPHRASE), getTransaction };
}

const refusedWith = async (response: rpc.Api.GetTransactionResponse, reason: RegExp, over: Partial<FirstLegExpectation> = {}) => {
  const promise = verifier(response).verifier.verify(expected(over));
  await expect(promise).rejects.toBeInstanceOf(FirstLegRefusedError);
  await expect(promise).rejects.toThrow(reason);
};

describe("RpcFirstLegVerifier", () => {
  it("accepts a classic USDC payment to the operator of at least the requested amount", async () => {
    await expect(verifier(success(envelope(pay(OPERATOR, "10")))).verifier.verify(expected())).resolves.toBeUndefined();
    await expect(verifier(success(envelope(pay(OPERATOR, "12.5")))).verifier.verify(expected())).resolves.toBeUndefined();
  });

  it("accepts a USDC SAC transfer to the operator, with plain or muxed (map) event data", async () => {
    await expect(verifier(success(envelope(), [transferEvent(OPERATOR, 10n * UNIT)])).verifier.verify(expected())).resolves.toBeUndefined();
    await expect(
      verifier(success(envelope(), [transferEvent(OPERATOR, 10n * UNIT, { mapData: true })])).verifier.verify(expected()),
    ).resolves.toBeUndefined();
  });

  it("looks through a fee bump to the inner transaction's payments", async () => {
    const inner = TransactionBuilder.fromXDR(envelope(pay(OPERATOR, "10")), PASSPHRASE);
    const bump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), "200", inner as never, PASSPHRASE);
    await expect(verifier(success(bump.toEnvelope())).verifier.verify(expected())).resolves.toBeUndefined();
  });

  it("refuses a hash that does not exist", () =>
    refusedWith({ status: rpc.Api.GetTransactionStatus.NOT_FOUND, txHash: HASH } as rpc.Api.GetTransactionResponse, /not found/));

  it("refuses a transaction that failed", () =>
    refusedWith(
      { ...success(envelope(pay(OPERATOR, "10"))), status: rpc.Api.GetTransactionStatus.FAILED } as rpc.Api.GetTransactionResponse,
      /did not succeed/,
    ));

  it("refuses a transaction that paid a different account", async () => {
    await refusedWith(success(envelope(pay(STRANGER, "10"))), /did not pay the configured USDC to the operator/);
    await refusedWith(success(envelope(), [transferEvent(STRANGER, 10n * UNIT)]), /did not pay/);
  });

  it("refuses a transaction that paid a different asset", async () => {
    await refusedWith(success(envelope(pay(OPERATOR, "10", new Asset("USDC", OTHER_ISSUER)))), /did not pay/);
    await refusedWith(success(envelope(pay(OPERATOR, "10", Asset.native()))), /did not pay/);
    await refusedWith(success(envelope(), [transferEvent(OPERATOR, 10n * UNIT, { asset: new Asset("USDC", OTHER_ISSUER) })]), /did not pay/);
  });

  it("ignores a look-alike transfer event emitted by a contract other than the USDC SAC", () =>
    refusedWith(
      success(envelope(), [transferEvent(OPERATOR, 10n * UNIT, { contract: StrKey.encodeContract(Buffer.alloc(32, 1)) })]),
      /did not pay/,
    ));

  it("refuses a transaction that paid less than requested", async () => {
    await refusedWith(success(envelope(pay(OPERATOR, "9.9999999"))), /9\.9999999 USDC, less than the 10\.0000000 requested/);
    await refusedWith(success(envelope(), [transferEvent(OPERATOR, 10n * UNIT - 1n)]), /less than/);
  });

  it("counts a classic payment once even when the network also emits its SAC event", () =>
    // 10 USDC paid, reported both ways; 15 requested must still be refused.
    refusedWith(success(envelope(pay(OPERATOR, "10")), [transferEvent(OPERATOR, 10n * UNIT)]), /less than/, {
      minAmount: 15n * UNIT,
    }));

  it("refuses a malformed hash without asking the network", async () => {
    const { verifier: v, getTransaction } = verifier(success(envelope(pay(OPERATOR, "10"))));
    for (const txHash of ["contracttxhash", "a".repeat(63), "g".repeat(64)]) {
      await expect(v.verify(expected({ txHash }))).rejects.toThrow(/64-character hex/);
    }
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("reports an RPC failure as unavailable, not as a refusal", async () => {
    const promise = verifier(new Error("ECONNREFUSED")).verifier.verify(expected());
    await expect(promise).rejects.toBeInstanceOf(FirstLegUnavailableError);
    await expect(promise).rejects.toThrow(/ECONNREFUSED/);
  });
});
