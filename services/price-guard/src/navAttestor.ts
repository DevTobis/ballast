/**
 * Signs a fetched NAV reading with the price-publisher key so `PriceGuard.publish_nav` can verify
 * it on-chain. Neither Etherfuse nor Spiko signs its HTTP response; the contract checks the key
 * registered via `configure_issuer_key`, which `scripts/configure-nav-key.sh` sets to the
 * publisher's Ed25519 public key.
 */
import { StrKey } from "@stellar/stellar-sdk";
import type { KmsSigner } from "@ballast/operator-signing";
import { canonicalNavMessage, DEFAULT_NAV_CONTRACT_ID, verifyNavSignature } from "./navSignature.js";

/** The signer's raw 32-byte Ed25519 public key, base64 — the value `configure_issuer_key` stores. */
export function attestorPublicKeyBase64(signer: Pick<KmsSigner, "publicKey">): string {
  return Buffer.from(StrKey.decodeEd25519PublicKey(signer.publicKey())).toString("base64");
}

/**
 * Signs `canonicalNavMessage(assetCode, ts, value, contractId)` with `signer` and self-checks the
 * signature with `verifyNavSignature` before returning, so a broken signer fails here rather than
 * trapping inside `publish_nav` on-chain.
 */
export async function attestNav(
  signer: Pick<KmsSigner, "publicKey" | "signMessage">,
  assetCode: string,
  ts: number,
  value: bigint,
  contractId: string = DEFAULT_NAV_CONTRACT_ID,
): Promise<Buffer> {
  const sig = await signer.signMessage(canonicalNavMessage(assetCode, ts, value, contractId));
  if (!verifyNavSignature(assetCode, ts, value, sig, attestorPublicKeyBase64(signer), contractId)) {
    throw new Error(`navAttestor: self-check failed for ${assetCode} @ ${ts}`);
  }
  return sig;
}
