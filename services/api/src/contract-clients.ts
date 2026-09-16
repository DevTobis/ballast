import { loadNetworkConfig, requireContractId } from "@ballast/network-config";
import {
  CreditLineClient,
  ExitDeskClient,
  PledgeVaultClient,
  PriceGuardClient,
  RegistryClient,
  RepoDvpClient,
} from "@ballast/contract-clients";

export interface ContractClients {
  registry: RegistryClient;
  priceGuard: PriceGuardClient;
  pledgeVault: PledgeVaultClient;
  creditLine: CreditLineClient;
  exitDesk: ExitDeskClient;
  repoDvp: RepoDvpClient;
}

let instance: ContractClients | undefined;

/** Lazily builds one client per Soroban contract, per `@ballast/contract-clients`. */
export function getContractClients(): ContractClients {
  if (!instance) {
    const network = loadNetworkConfig();
    instance = {
      registry: new RegistryClient({ network, contractId: requireContractId(network, "registry") }),
      priceGuard: new PriceGuardClient({
        network,
        contractId: requireContractId(network, "priceGuard"),
      }),
      pledgeVault: new PledgeVaultClient({
        network,
        contractId: requireContractId(network, "pledgeVault"),
      }),
      creditLine: new CreditLineClient({
        network,
        contractId: requireContractId(network, "creditLine"),
      }),
      exitDesk: new ExitDeskClient({ network, contractId: requireContractId(network, "exitDesk") }),
      repoDvp: new RepoDvpClient({ network, contractId: requireContractId(network, "repoDvp") }),
    };
  }
  return instance;
}
