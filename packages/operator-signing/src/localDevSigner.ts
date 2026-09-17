/**
 * Local-dev / test operator signer: reads a raw Ed25519 secret key straight from an environment
 * variable and signs with it in-process. This is the `"local"` operator signer mode (see
 * `factory.ts`) — fine for local dev and automated tests, but a real deployment must resolve
 * operator keys through Vault Transit (`vaultTransitSigner.ts`) or an AWS KMS envelope
 * (`kmsEnvelopeSigner.ts`) instead, so the raw secret never sits in an env var a running
 * production process can read.
 *
 * To make that mistake hard to make by accident, this class refuses to construct when
 * `NODE_ENV=production` unless `ALLOW_LOCAL_DEV_SIGNER=true` is explicitly set.
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { KmsSigner } from "./types.js";

/**
 * Builds a `KmsSigner` that signs in-process with a raw Ed25519 secret key. This is the one place
 * that touches a raw secret key: both `LocalDevSecretKeySigner` (secret read from an env var, for
 * local dev/tests) and `KmsEnvelopeSigner` (secret unwrapped from a KMS envelope just before
 * signing — see kmsEnvelopeSigner.ts's header for that mode's weaker guarantee) delegate to it
 * rather than each carrying their own copy of "build a Keypair, sign the tx".
 */
export function createRawSecretSigner(secret: string, networkPassphrase: string): KmsSigner {
  const keypair = Keypair.fromSecret(secret);
  return {
    publicKey(): string {
      return keypair.publicKey();
    },
    async sign(unsignedXdr: string): Promise<string> {
      const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}

export class LocalDevSecretKeySigner implements KmsSigner {
  private readonly inner: KmsSigner;

  constructor(secretEnvVar: string, networkPassphrase: string, env: NodeJS.ProcessEnv = process.env) {
    if (env.NODE_ENV === "production" && env.ALLOW_LOCAL_DEV_SIGNER !== "true") {
      throw new Error(
        `operator-signing: refusing to construct LocalDevSecretKeySigner under NODE_ENV=production ` +
          `(it reads a raw operator secret key from "${secretEnvVar}"). Configure a real signer mode ` +
          `(vault/kms-envelope, see factory.ts) instead, or set ALLOW_LOCAL_DEV_SIGNER=true to override.`,
      );
    }

    const secret = env[secretEnvVar];
    if (!secret) {
      throw new Error(`operator-signing: missing operator secret key env var "${secretEnvVar}"`);
    }
    this.inner = createRawSecretSigner(secret, networkPassphrase);
  }

  publicKey(): string {
    return this.inner.publicKey();
  }

  sign(unsignedXdr: string): Promise<string> {
    return this.inner.sign(unsignedXdr);
  }
}
