/**
 * Checks that the first leg (Ballast contract -> operator G-account) actually landed before the hop
 * pays the second one out of the operator's own USDC. Without this, any caller holding the internal
 * token could name a made-up hash and be paid up to the per-payout cap for it.
 *
 * `hop.ts` only depends on the `FirstLegVerifier` interface, so tests swap in a fake and stay offline;
 * `RpcFirstLegVerifier` is the network-backed implementation.
 */
import {
  Asset,
  FeeBumpTransaction,
  MuxedAccount,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { decimalStringToScaled, scaledToDecimalString } from "@ballast/domain-types";

export interface FirstLegExpectation {
  txHash: string;
  /** The operator's classic G-address: the first leg must have paid this account. */
  operator: string;
  usdcIssuer: string;
  /** The first leg must have delivered at least this much USDC, 7-decimal fixed point. */
  minAmount: bigint;
}

export interface FirstLegVerifier {
  /**
   * Resolves when the first leg is on-chain, succeeded, and paid at least `minAmount` USDC to the
   * operator. Throws `FirstLegRefusedError` when it did not, `FirstLegUnavailableError` when the
   * network could not be asked.
   */
  verify(expected: FirstLegExpectation): Promise<void>;
}

/** The first leg does not back this payout (missing, failed, wrong account or asset, too little). */
export class FirstLegRefusedError extends Error {}
/** The verifier could not reach the network, so nothing is known either way. */
export class FirstLegUnavailableError extends Error {}

const TX_HASH = /^[0-9a-f]{64}$/i;

/** The slice of `rpc.Server` the verifier needs. */
export interface TransactionSource {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export class RpcFirstLegVerifier implements FirstLegVerifier {
  constructor(
    private readonly source: TransactionSource,
    private readonly networkPassphrase: string,
  ) {}

  async verify(expected: FirstLegExpectation): Promise<void> {
    const { txHash } = expected;
    if (!TX_HASH.test(txHash)) {
      throw new FirstLegRefusedError("first-leg hash is not a 64-character hex transaction hash");
    }

    let response: rpc.Api.GetTransactionResponse;
    try {
      response = await this.source.getTransaction(txHash);
    } catch (err) {
      throw new FirstLegUnavailableError(
        `could not look up the first-leg transaction: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      // RPC only keeps recent history, so a real but old first leg also lands here.
      throw new FirstLegRefusedError(`first-leg transaction ${txHash} was not found on the network`);
    }
    if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new FirstLegRefusedError(`first-leg transaction ${txHash} did not succeed (status ${response.status})`);
    }

    const received = this.usdcReceived(response, expected);
    if (received === 0n) {
      throw new FirstLegRefusedError("first-leg transaction did not pay the configured USDC to the operator account");
    }
    if (received < expected.minAmount) {
      throw new FirstLegRefusedError(
        `first leg paid the operator ${scaledToDecimalString(received)} USDC, less than the ${scaledToDecimalString(expected.minAmount)} requested`,
      );
    }
  }

  /**
   * USDC the operator received in this transaction, counted two ways: classic `payment` operations
   * in the envelope, and `transfer` events from the USDC Stellar Asset Contract (how a contract
   * pays). A Soroban transaction carries a single operation, so both can't add to the same total;
   * and where the network also emits SAC events for classic payments, the events already include
   * them. Taking the larger of the two therefore never counts a transfer twice.
   */
  private usdcReceived(
    response: rpc.Api.GetSuccessfulTransactionResponse,
    expected: FirstLegExpectation,
  ): bigint {
    return [this.fromPayments(response, expected), this.fromSacEvents(response, expected)].reduce(
      (a, b) => (a > b ? a : b),
    );
  }

  private fromPayments(response: rpc.Api.GetSuccessfulTransactionResponse, expected: FirstLegExpectation): bigint {
    const parsed = TransactionBuilder.fromXDR(response.envelopeXdr, this.networkPassphrase);
    const tx: Transaction = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    let total = 0n;
    for (const op of tx.operations) {
      if (op.type !== "payment") continue;
      if (baseAccount(op.destination) !== expected.operator) continue;
      if (op.asset.isNative() || op.asset.getCode() !== "USDC" || op.asset.getIssuer() !== expected.usdcIssuer) continue;
      total += decimalStringToScaled(op.amount);
    }
    return total;
  }

  private fromSacEvents(response: rpc.Api.GetSuccessfulTransactionResponse, expected: FirstLegExpectation): bigint {
    // Any contract can emit an event that looks like a transfer, so only the USDC SAC's own count.
    const usdcSac = new Asset("USDC", expected.usdcIssuer).contractId(this.networkPassphrase);
    let total = 0n;
    for (const event of (response.events?.contractEventsXdr ?? []).flat()) {
      if (event.type.name !== "contract") continue;
      if (!event.contractId || StrKey.encodeContract(event.contractId.toBytes()) !== usdcSac) continue;
      const { topics, data } = event.body.v0;
      if (topics.length < 3 || scValToNative(topics[0]) !== "transfer") continue;
      if (scValToNative(topics[2]) !== expected.operator) continue;
      total += transferAmount(data);
    }
    return total;
  }
}

/** A SAC transfer's data is the i128 amount, or (with a muxed destination) a map holding `amount`. */
function transferAmount(data: xdr.ScVal): bigint {
  const native: unknown = scValToNative(data);
  if (typeof native === "bigint") return native;
  if (native && typeof native === "object" && typeof (native as { amount?: unknown }).amount === "bigint") {
    return (native as { amount: bigint }).amount;
  }
  return 0n;
}

function baseAccount(address: string): string {
  return address.startsWith("M") ? MuxedAccount.fromAddress(address, "0").baseAccount().accountId() : address;
}
