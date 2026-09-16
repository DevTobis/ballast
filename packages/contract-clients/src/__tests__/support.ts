import { Account, Keypair, StrKey, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { vi, type MockInstance } from "vitest";
import type { NetworkConfig } from "@ballast/network-config";

export const testNetwork: NetworkConfig = {
  network: "local",
  // https (not http) so the real `rpc.Server` constructor's insecure-URL guard doesn't throw
  // before our spies ever run — nothing here actually reaches the network.
  rpcUrl: "https://rpc.example.invalid/soroban/rpc",
  horizonUrl: "http://localhost:8000",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {},
};

export const randomAccountId = (): string => Keypair.random().publicKey();
export const randomContractId = (): string => StrKey.encodeContract(Buffer.alloc(32, 1));

/**
 * Stubs the three `rpc.Server` methods contract-clients calls, so tests never touch a real
 * network. `getAccount` returns a fresh sequence-0 account; `prepareTransaction` is a pass-through
 * (the real `TransactionBuilder`/`Contract` encoding still runs — only the network round-trip that
 * would normally simulate/assemble resource footprints is stubbed out); `simulateTransaction`
 * returns a canned success response wrapping `retval`.
 */
export function stubRpcServer(retval?: unknown): {
  restore: () => void;
  spies: {
    getAccount: MockInstance;
    prepareTransaction: MockInstance;
    simulateTransaction: MockInstance;
  };
} {
  const getAccount = vi
    .spyOn(rpc.Server.prototype, "getAccount")
    .mockImplementation(async (accountId: string) => new Account(accountId, "1"));

  const prepareTransaction = vi
    .spyOn(rpc.Server.prototype, "prepareTransaction")
    .mockImplementation(async (tx) => tx as never);

  const simulateTransaction = vi
    .spyOn(rpc.Server.prototype, "simulateTransaction")
    .mockImplementation(async () => ({
      id: "1",
      latestLedger: 1,
      events: [],
      transactionData: {} as never,
      minResourceFee: "100",
      result: {
        auth: [],
        retval: nativeToScVal(retval ?? null),
      },
      _parsed: true,
    }) as never);

  return {
    restore: () => {
      getAccount.mockRestore();
      prepareTransaction.mockRestore();
      simulateTransaction.mockRestore();
    },
    spies: { getAccount, prepareTransaction, simulateTransaction },
  };
}
