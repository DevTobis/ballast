import { Account, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { Logger } from "@ballast/observability";
import { createOperatorSigner, type KmsSigner } from "@ballast/operator-signing";

/**
 * The seam between "who authorises and submits the operator's classic hop transaction" and "how
 * that key/RPC connection is managed" (PRD §5 Phase 2: the operator G-account hop). `hop.ts` only
 * depends on this interface, so swapping the implementation never touches call sites.
 *
 * This needs more than `@ballast/operator-signing`'s `KmsSigner` (`loadSequenceAccount()` and
 * `networkPassphrase()` are payout-hop-specific, `KmsSigner` doesn't have them), so it stays its
 * own interface — `OperatorPayoutSigner` below implements it by composing a `KmsSigner` for the
 * actual signing.
 */
export interface PayoutSigner {
  /** The operator's classic G-address. */
  publicKey(): string;
  networkPassphrase(): string;
  /** Loads the operator account's current sequence number from the network. */
  loadSequenceAccount(): Promise<Account>;
  /** Signs with the operator keypair and submits to the network. */
  signAndSubmit(tx: Transaction): Promise<{ hash: string; status: string }>;
}

/**
 * `PayoutSigner` implementation for the operator's classic hop account. Delegates the actual
 * signing to a `KmsSigner` from `@ballast/operator-signing` (resolved via `createOperatorSigner`,
 * mode controlled by `PAYOUT_HOP_SIGNER_MODE`), so this class only owns the payout-hop-specific
 * bits: loading the account's sequence number and submitting the signed tx.
 */
export class OperatorPayoutSigner implements PayoutSigner {
  private readonly rpcServer: rpc.Server;

  constructor(
    private readonly logger: Logger,
    private readonly rpcUrl: string,
    private readonly passphrase: string,
    private readonly kmsSigner: KmsSigner,
  ) {
    this.rpcServer = new rpc.Server(rpcUrl);
  }

  /** Resolves the operator signer per `PAYOUT_HOP_SIGNER_MODE` and builds an `OperatorPayoutSigner` around it. */
  static async create(logger: Logger, rpcUrl: string, passphrase: string): Promise<OperatorPayoutSigner> {
    const kmsSigner = await createOperatorSigner("payout-hop", passphrase);
    return new OperatorPayoutSigner(logger, rpcUrl, passphrase, kmsSigner);
  }

  publicKey(): string {
    return this.kmsSigner.publicKey();
  }

  networkPassphrase(): string {
    return this.passphrase;
  }

  async loadSequenceAccount(): Promise<Account> {
    const account = await this.rpcServer.getAccount(this.kmsSigner.publicKey());
    return account;
  }

  async signAndSubmit(tx: Transaction): Promise<{ hash: string; status: string }> {
    const signedXdr = await this.kmsSigner.sign(tx.toXDR());
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.passphrase) as Transaction;
    const result = await this.rpcServer.sendTransaction(signedTx);
    this.logger.info({ hash: result.hash, status: result.status }, "payout-hop: submitted anchor hop transaction");
    return { hash: result.hash, status: result.status };
  }
}
