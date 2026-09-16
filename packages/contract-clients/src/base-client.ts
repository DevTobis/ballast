import type { NetworkConfig } from "@ballast/network-config";
import type { xdr } from "@stellar/stellar-sdk";
import { buildUnsignedTx, resolveSimulationSource, simulateRead } from "./unsigned-tx.js";

export interface ContractClientConfig {
  network: NetworkConfig;
  contractId: string;
}

export abstract class BaseContractClient {
  protected readonly network: NetworkConfig;
  protected readonly contractId: string;

  constructor(config: ContractClientConfig) {
    this.network = config.network;
    this.contractId = config.contractId;
  }

  /** Returns unsigned, prepared XDR for a state-changing call. */
  protected invoke(sourcePublicKey: string, method: string, args: xdr.ScVal[]): Promise<string> {
    return buildUnsignedTx(this.network, sourcePublicKey, this.contractId, method, args);
  }

  /**
   * Simulates and decodes a read-only call. There is no caller-supplied source account in the
   * public read methods (`asset`, `guardedPrice`, `ltv`, `quote`) per the spec — simulation uses
   * `STELLAR_SIMULATION_SOURCE` (see unsigned-tx.ts) as a stand-in signer-less source.
   */
  protected read<T>(method: string, args: xdr.ScVal[]): Promise<T> {
    return simulateRead<T>(this.network, resolveSimulationSource(), this.contractId, method, args);
  }
}
