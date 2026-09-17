/**
 * Shared KMS-backed operator signing for Ballast's operator-key services (services/keeper,
 * services/price-guard, services/payout-hop). Ballast never holds customer signing keys (PRD §9);
 * the keeper, price publisher and payout hop are the narrow exceptions, and this package is where
 * their operator key handling lives — one `KmsSigner` interface with three implementations
 * (`"local" | "vault" | "kms-envelope"`, see `factory.ts`) instead of near-identical raw-secret
 * signers duplicated per service.
 */
export type { KmsSigner, SubmitResult } from "./types.js";
export { submitSignedTx } from "./submit.js";

export { createRawSecretSigner, LocalDevSecretKeySigner } from "./localDevSigner.js";
export { VaultTransitSigner, type VaultTransitSignerOptions } from "./vaultTransitSigner.js";
export { KmsEnvelopeSigner, type KmsEnvelopeSignerOptions } from "./kmsEnvelopeSigner.js";

export { createOperatorSigner, type OperatorRole } from "./factory.js";
