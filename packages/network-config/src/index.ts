export type StellarNetworkName = "local" | "testnet" | "mainnet";

export interface ContractIds {
  registry?: string;
  priceGuard?: string;
  pledgeVault?: string;
  creditLine?: string;
  exitDesk?: string;
  repoDvp?: string;
  usdcSac?: string;
}

export interface NetworkConfig {
  network: StellarNetworkName;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  contracts: ContractIds;
}

const REQUIRED = ["STELLAR_RPC_URL", "STELLAR_HORIZON_URL", "STELLAR_NETWORK_PASSPHRASE"] as const;

/**
 * Loads Stellar network settings from environment variables (see `.env.example` at the repo
 * root). Every Ballast service calls this once at startup rather than reading `process.env`
 * directly, so a missing variable fails fast with one clear error instead of a confusing crash
 * three layers down.
 */
export function loadNetworkConfig(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`network-config: missing required env vars: ${missing.join(", ")}`);
  }

  const network = (env.STELLAR_NETWORK as StellarNetworkName) ?? "local";

  return {
    network,
    rpcUrl: env.STELLAR_RPC_URL!,
    horizonUrl: env.STELLAR_HORIZON_URL!,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE!,
    contracts: {
      registry: env.REGISTRY_CONTRACT_ID || undefined,
      priceGuard: env.PRICE_GUARD_CONTRACT_ID || undefined,
      pledgeVault: env.PLEDGE_VAULT_CONTRACT_ID || undefined,
      creditLine: env.CREDIT_LINE_CONTRACT_ID || undefined,
      exitDesk: env.EXIT_DESK_CONTRACT_ID || undefined,
      repoDvp: env.REPO_DVP_CONTRACT_ID || undefined,
      usdcSac: env.USDC_SAC_CONTRACT_ID || undefined,
    },
  };
}

export function requireContractId(config: NetworkConfig, key: keyof ContractIds): string {
  const id = config.contracts[key];
  if (!id) {
    throw new Error(`network-config: contract id for "${key}" is not set (deploy it first)`);
  }
  return id;
}
