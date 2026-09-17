/**
 * KmsSigner backed by HashiCorp Vault's Transit secrets engine (PRD §11's KMS seam). The
 * operator's Ed25519 private key never leaves Vault and is never read into this process: this
 * class only ever sends the transaction's 32-byte signature-base hash to Vault's
 * `/transit/sign/{key_name}` endpoint and gets a detached signature back.
 *
 * Configured via the shared `VAULT_ADDR` + `VAULT_TOKEN` env vars and a per-role
 * `${ROLE_ENV_PREFIX}_VAULT_KEY_NAME` naming the Transit key (see `factory.ts`).
 */
import { StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { KmsSigner } from "./types.js";

interface VaultTransitKeyResponse {
  data: {
    latest_version: number;
    keys: Record<string, { public_key: string }>;
  };
}

interface VaultTransitSignResponse {
  data: {
    signature: string;
  };
}

export interface VaultTransitSignerOptions {
  vaultAddr: string;
  vaultToken: string;
  keyName: string;
  networkPassphrase: string;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Vault Transit signatures come back as `"vault:v<version>:<base64>"` — strip that prefix. */
function stripVaultSignaturePrefix(signature: string): string {
  const match = /^vault:v\d+:(.+)$/.exec(signature);
  if (!match) {
    throw new Error(`operator-signing: unexpected Vault Transit signature format: "${signature}"`);
  }
  return match[1];
}

export class VaultTransitSigner implements KmsSigner {
  private readonly vaultAddr: string;
  private readonly vaultToken: string;
  private readonly keyName: string;
  private readonly networkPassphrase: string;
  private readonly fetchImpl: typeof fetch;
  private cachedPublicKey: string | undefined;

  constructor(options: VaultTransitSignerOptions) {
    this.vaultAddr = options.vaultAddr.replace(/\/+$/, "");
    this.vaultToken = options.vaultToken;
    this.keyName = options.keyName;
    this.networkPassphrase = options.networkPassphrase;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetches and caches the Transit key's public key, converted to a Stellar G-address.
   * `createOperatorSigner()` awaits this once at startup so `publicKey()` can stay synchronous
   * (matching the `KmsSigner` interface) for the rest of this signer's lifetime.
   */
  async resolvePublicKey(): Promise<string> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }
    const res = await this.fetchImpl(`${this.vaultAddr}/v1/transit/keys/${this.keyName}`, {
      headers: { "X-Vault-Token": this.vaultToken },
    });
    if (!res.ok) {
      throw new Error(
        `operator-signing: Vault Transit key lookup failed for "${this.keyName}": ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as VaultTransitKeyResponse;
    const latest = body.data.keys[String(body.data.latest_version)];
    if (!latest?.public_key) {
      throw new Error(
        `operator-signing: Vault Transit key "${this.keyName}" has no public key at its latest version (${body.data.latest_version})`,
      );
    }
    const rawPublicKey = Buffer.from(latest.public_key, "base64");
    this.cachedPublicKey = StrKey.encodeEd25519PublicKey(rawPublicKey);
    return this.cachedPublicKey;
  }

  publicKey(): string {
    if (!this.cachedPublicKey) {
      throw new Error(
        "operator-signing: VaultTransitSigner.publicKey() called before resolvePublicKey() — " +
          "createOperatorSigner() resolves it for you, so this only happens if VaultTransitSigner is constructed directly.",
      );
    }
    return this.cachedPublicKey;
  }

  async sign(unsignedXdr: string): Promise<string> {
    const publicKey = await this.resolvePublicKey();
    const tx = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    const hash = tx.hash();

    const res = await this.fetchImpl(`${this.vaultAddr}/v1/transit/sign/${this.keyName}`, {
      method: "POST",
      headers: { "X-Vault-Token": this.vaultToken, "content-type": "application/json" },
      body: JSON.stringify({ input: hash.toString("base64") }),
    });
    if (!res.ok) {
      throw new Error(
        `operator-signing: Vault Transit sign failed for "${this.keyName}": ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as VaultTransitSignResponse;
    const signatureBase64 = stripVaultSignaturePrefix(body.data.signature);

    tx.addSignature(publicKey, signatureBase64);
    return tx.toXDR();
  }
}
