import { Account, Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import type { Logger } from "@ballast/observability";

/**
 * The seam between "who authorises and submits the operator's classic hop transaction" and "how
 * that key/RPC connection is managed" (PRD §5 Phase 2: the operator G-account hop). Ballast never
 * holds customer keys — this operator key is the deliberate exception, and production should back
 * it with a real KMS rather than a raw env var. `hop.ts` only depends on this interface, so
 * swapping the implementation never touches call sites.
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
 * MOCK-ish, same caveat as `services/keeper`'s `MockEnvKeypairSigner`: fine for local dev, but a
 * production deployment must use a KMS-backed signer that never exposes the raw secret key to
 * this process. Reads `PAYOUT_HOP_SECRET_KEY` from the environment.
 */
export class EnvKeypairPayoutSigner implements PayoutSigner {
  private readonly keypair: Keypair;
  private readonly rpcServer: rpc.Server;

  constructor(
    private readonly logger: Logger,
    private readonly rpcUrl: string,
    private readonly passphrase: string,
    secretKeyEnvVar = "PAYOUT_HOP_SECRET_KEY",
  ) {
    const secret = process.env[secretKeyEnvVar];
    if (!secret) {
      throw new Error(
        `payout-hop: ${secretKeyEnvVar} is not set — the operator hop account key is required, there is no dry-run mode for moving anchor funds`,
      );
    }
    this.keypair = Keypair.fromSecret(secret);
    this.rpcServer = new rpc.Server(rpcUrl);
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  networkPassphrase(): string {
    return this.passphrase;
  }

  async loadSequenceAccount(): Promise<Account> {
    const account = await this.rpcServer.getAccount(this.keypair.publicKey());
    return account;
  }

  async signAndSubmit(tx: Transaction): Promise<{ hash: string; status: string }> {
    tx.sign(this.keypair);
    const result = await this.rpcServer.sendTransaction(tx);
    this.logger.info({ hash: result.hash, status: result.status }, "payout-hop: submitted anchor hop transaction");
    return { hash: result.hash, status: result.status };
  }
}
