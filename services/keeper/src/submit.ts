/**
 * Signing + submission helper shared (by duplication, per this build's convention — there is no
 * shared package for this yet, and adding one is out of scope for this pass) across
 * services/price-guard, services/margin-monitor and services/keeper. This copy is identical to
 * services/price-guard/src/submit.ts.
 *
 * Ballast never holds customer signing keys (PRD §9). The keeper, price publisher and payout hop
 * are the narrow exceptions — operator keys that in production resolve through a KMS (PRD §6.6,
 * §11). `KmsSigner` is that seam; `SecretKeySigner` is the clearly-named mock implementation used
 * for local dev and tests, reading a raw secret from an env var. Swap it for a real KMS-backed
 * implementation without touching call sites.
 */
import { Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

export interface KmsSigner {
  /** Returns the operator's Stellar public key (G...), used as the tx source/caller address. */
  publicKey(): string;
  /** Signs an unsigned XDR envelope and returns the signed XDR. */
  sign(unsignedXdr: string): Promise<string>;
}

/**
 * MOCK signer: reads a raw secret key straight from an environment variable. This is fine for
 * local dev and tests; production must resolve operator keys through a real KMS that never
 * exposes the raw secret to this process (PRD §11).
 */
export class SecretKeySigner implements KmsSigner {
  private readonly keypair: Keypair;

  constructor(
    secretEnvVar: string,
    private readonly networkPassphrase: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const secret = env[secretEnvVar];
    if (!secret) {
      throw new Error(`submit: missing operator secret key env var "${secretEnvVar}"`);
    }
    this.keypair = Keypair.fromSecret(secret);
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }

  async sign(unsignedXdr: string): Promise<string> {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    tx.sign(this.keypair);
    return tx.toXDR();
  }
}

export interface SubmitResult {
  hash: string;
  status: string;
}

/**
 * Submits an already-signed transaction envelope and polls `getTransaction` until the network
 * reports a final status. Throws on send failure or a non-SUCCESS final status.
 */
export async function submitSignedTx(
  rpcUrl: string,
  networkPassphrase: string,
  signedXdr: string,
  pollIntervalMs = 1000,
  maxAttempts = 30,
): Promise<SubmitResult> {
  const server = new rpc.Server(rpcUrl);
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    throw new Error(`submitSignedTx: send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const got = await server.getTransaction(hash);
    if (got.status === "SUCCESS") {
      return { hash, status: got.status };
    }
    if (got.status === "FAILED") {
      throw new Error(`submitSignedTx: transaction ${hash} failed on-chain`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`submitSignedTx: transaction ${hash} did not finalize after ${maxAttempts} attempts`);
}
