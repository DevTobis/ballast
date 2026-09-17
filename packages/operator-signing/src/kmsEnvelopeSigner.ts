/**
 * KmsSigner backed by an AWS KMS-wrapped Ed25519 secret ("envelope encryption"): the operator's
 * raw secret key is stored (out of band, not by this package) as ciphertext produced by AWS KMS
 * `Encrypt`, held in an env var like `KEEPER_WRAPPED_SECRET`. At startup this class calls KMS
 * `Decrypt` once to unwrap it, then signs in-process using the same raw-secret signing logic as
 * `LocalDevSecretKeySigner` (see `createRawSecretSigner` in `localDevSigner.ts`).
 *
 * WEAKER GUARANTEE THAN VAULT: unlike `vaultTransitSigner.ts`, where the private key never leaves
 * Vault, this mode's raw secret transiently exists in this process's memory after `Decrypt`
 * returns (from startup until the process exits). It is never written to disk or logged, but a
 * memory dump or a compromised process would expose it — Vault Transit does not have this
 * exposure window. Prefer `"vault"` mode where available; use `"kms-envelope"` only when Vault
 * Transit isn't an option.
 */
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { createRawSecretSigner } from "./localDevSigner.js";
import type { KmsSigner } from "./types.js";

export interface KmsEnvelopeSignerOptions {
  awsRegion: string;
  kmsKeyId: string;
  /** Base64-encoded KMS `Encrypt` ciphertext blob wrapping the raw Ed25519 secret (`S...`). */
  wrappedSecretBase64: string;
  networkPassphrase: string;
  /** Overridable for tests; defaults to a real `KMSClient` for `awsRegion`. */
  kmsClient?: KMSClient;
}

export class KmsEnvelopeSigner implements KmsSigner {
  private constructor(private readonly inner: KmsSigner) {}

  /**
   * Decrypts the wrapped secret via KMS and builds the signer. Async because unwrapping requires
   * a KMS round trip; `createOperatorSigner()` awaits this once at startup.
   */
  static async create(options: KmsEnvelopeSignerOptions): Promise<KmsEnvelopeSigner> {
    const client = options.kmsClient ?? new KMSClient({ region: options.awsRegion });
    let plaintext: Uint8Array | undefined;
    try {
      const result = await client.send(
        new DecryptCommand({
          KeyId: options.kmsKeyId,
          CiphertextBlob: Buffer.from(options.wrappedSecretBase64, "base64"),
        }),
      );
      plaintext = result.Plaintext;
    } finally {
      if (!options.kmsClient) {
        client.destroy();
      }
    }

    if (!plaintext) {
      throw new Error(
        `operator-signing: KMS Decrypt for key "${options.kmsKeyId}" returned no plaintext — check the wrapped secret and key permissions`,
      );
    }

    const secret = Buffer.from(plaintext).toString("utf8").trim();
    const inner = createRawSecretSigner(secret, options.networkPassphrase);
    return new KmsEnvelopeSigner(inner);
  }

  publicKey(): string {
    return this.inner.publicKey();
  }

  sign(unsignedXdr: string): Promise<string> {
    return this.inner.sign(unsignedXdr);
  }
}
