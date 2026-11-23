/**
 * NAV attestation. No issuer signs the NAV it publishes (Spiko and Etherfuse serve plain JSON), so
 * the price-publisher operator key signs each reading Ballast fetched. `PriceGuard.publish_nav`
 * verifies that signature on-chain against the key registered with `configure_issuer_key`, so the
 * guarantee is "Ballast's publisher saw this value from the issuer API", not issuer attestation.
 */
import { StrKey } from "@stellar/stellar-sdk";
import type { KmsSigner } from "@ballast/operator-signing";
import { canonicalNavMessage, verifyNavSignature } from "./navSignature.js";

/** The signer's raw 32-byte Ed25519 public key, base64 — the value `configure_issuer_key` stores. */
export function attestorPublicKeyBase64(signer: KmsSigner): string {
  return Buffer.from(StrKey.decodeEd25519PublicKey(signer.publicKey())).toString("base64");
}

/**
 * Signs the canonical NAV message and verifies the result against the signer's own public key
 * before returning, so a misconfigured Vault/KMS key fails here instead of as an on-chain revert.
 */
export async function attestNav(
  signer: KmsSigner,
  contractAddress: string,
  assetCode: string,
  ts: number,
  value: bigint,
): Promise<Buffer> {
  const sig = await signer.signMessage(canonicalNavMessage(contractAddress, assetCode, ts, value));
  if (!verifyNavSignature(contractAddress, assetCode, ts, value, sig, attestorPublicKeyBase64(signer))) {
    throw new Error(`navAttestor: signature for ${assetCode} does not verify against the signer's public key`);
  }
  return sig;
}
