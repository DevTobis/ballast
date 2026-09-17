/**
 * Resolves the `KmsSigner` for an operator role (`"keeper" | "price-publisher" | "payout-hop"`)
 * according to `${ROLE_ENV_PREFIX}_SIGNER_MODE` (see `.env.example`'s "operator signer modes"
 * section). Same env-flag-dispatch pattern as `services/issuer-gateway/src/registry.ts`: throws
 * clearly on a missing required env var for the selected mode rather than silently defaulting.
 */
import { KmsEnvelopeSigner } from "./kmsEnvelopeSigner.js";
import { LocalDevSecretKeySigner } from "./localDevSigner.js";
import type { KmsSigner } from "./types.js";
import { VaultTransitSigner } from "./vaultTransitSigner.js";

export type OperatorRole = "keeper" | "price-publisher" | "payout-hop";

const ROLE_ENV_PREFIX: Record<OperatorRole, string> = {
  keeper: "KEEPER",
  "price-publisher": "PRICE_PUBLISHER",
  "payout-hop": "PAYOUT_HOP",
};

/** The `"local"` mode's per-role raw secret env var (unchanged from the pre-KMS signers). */
const LOCAL_SECRET_ENV_VAR: Record<OperatorRole, string> = {
  keeper: "KEEPER_SECRET_KEY",
  "price-publisher": "PRICE_PUBLISHER_SECRET_KEY",
  "payout-hop": "PAYOUT_HOP_SECRET_KEY",
};

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(`operator-signing: missing required env var "${name}" for the selected signer mode`);
  }
  return value;
}

/**
 * Builds the `KmsSigner` for `role` per `${ROLE_ENV_PREFIX}_SIGNER_MODE` (`"local" | "vault" |
 * "kms-envelope"`, default `"local"`). Async because the `"vault"` mode resolves the operator's
 * public key over the network and the `"kms-envelope"` mode unwraps its secret via KMS, both
 * before this returns — callers await it once at startup, then treat the returned `KmsSigner` as
 * synchronous for `publicKey()`.
 */
export async function createOperatorSigner(
  role: OperatorRole,
  networkPassphrase: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KmsSigner> {
  const prefix = ROLE_ENV_PREFIX[role];
  const mode = env[`${prefix}_SIGNER_MODE`] ?? "local";

  switch (mode) {
    case "local": {
      return new LocalDevSecretKeySigner(LOCAL_SECRET_ENV_VAR[role], networkPassphrase, env);
    }
    case "vault": {
      const vaultAddr = requireEnv("VAULT_ADDR", env);
      const vaultToken = requireEnv("VAULT_TOKEN", env);
      const keyName = requireEnv(`${prefix}_VAULT_KEY_NAME`, env);
      const signer = new VaultTransitSigner({ vaultAddr, vaultToken, keyName, networkPassphrase });
      await signer.resolvePublicKey();
      return signer;
    }
    case "kms-envelope": {
      const awsRegion = requireEnv("AWS_REGION", env);
      const kmsKeyId = requireEnv(`${prefix}_KMS_KEY_ID`, env);
      const wrappedSecretBase64 = requireEnv(`${prefix}_WRAPPED_SECRET`, env);
      return KmsEnvelopeSigner.create({ awsRegion, kmsKeyId, wrappedSecretBase64, networkPassphrase });
    }
    default:
      throw new Error(
        `operator-signing: unknown ${prefix}_SIGNER_MODE "${mode}" (expected "local" | "vault" | "kms-envelope")`,
      );
  }
}
