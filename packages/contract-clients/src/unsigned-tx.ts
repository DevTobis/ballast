import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@ballast/network-config";
import { normalizeContractValue } from "./scval.js";

/**
 * Read-only contract calls (`asset`, `guardedPrice`, `ltv`, `quote`, ...) are simulated, not
 * submitted, so they don't need a real signer — but Soroban's `simulateTransaction` still needs
 * *some* existing account to build the envelope against. Per the task spec: "read calls currently
 * need STELLAR_SIMULATION_SOURCE env var pointing at any existing account." This is a documented
 * limitation of this skeleton, not a design choice — a future pass could special-case a
 * well-known dummy account once we confirm the RPC simulation path tolerates one that has never
 * been funded.
 */
export function resolveSimulationSource(env: NodeJS.ProcessEnv = process.env): string {
  const source = env.STELLAR_SIMULATION_SOURCE;
  if (!source) {
    throw new Error(
      "contract-clients: STELLAR_SIMULATION_SOURCE env var is not set (required for read-only " +
        "contract simulation — point it at any existing account on the target network)",
    );
  }
  return source;
}

/**
 * `CreditLineClient.poke` is permissionless on-chain (PRD §8: "anyone" can call `poke` to move
 * the margin state machine) but building *any* unsigned tx envelope still needs a fee-paying
 * source account, and the spec's `poke(line: bigint)` signature takes no caller. This resolves
 * one from `STELLAR_POKE_SOURCE`, falling back to `STELLAR_SIMULATION_SOURCE` — documented
 * limitation of this skeleton; a production caller (e.g. the keeper service) would likely want to
 * supply its own operator account instead.
 */
export function resolvePokeSource(env: NodeJS.ProcessEnv = process.env): string {
  const source = env.STELLAR_POKE_SOURCE ?? env.STELLAR_SIMULATION_SOURCE;
  if (!source) {
    throw new Error(
      "contract-clients: STELLAR_POKE_SOURCE (or STELLAR_SIMULATION_SOURCE) env var is not set " +
        "(required to build the unsigned poke tx's fee-paying source account)",
    );
  }
  return source;
}

/**
 * Builds an unsigned, Soroban-resource-prepared transaction envelope for a single contract
 * invocation and returns it as base64 XDR. Per PRD §9, Ballast never holds customer signing
 * keys — every state-changing API route returns this for the caller to sign client-side.
 */
export async function buildUnsignedTx(
  config: NetworkConfig,
  sourcePublicKey: string,
  contractId: string,
  method: string,
  scArgs: xdr.ScVal[],
): Promise<string> {
  const server = new rpc.Server(config.rpcUrl);
  const sourceAccount = await server.getAccount(sourcePublicKey);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...scArgs))
    .setTimeout(60)
    .build();

  // Simulates the invocation and attaches the resulting Soroban resource footprint/fee so the
  // envelope is submittable as-is once signed.
  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/** @deprecated use {@link buildUnsignedTx} */
export const buildUnsignedInvocation = buildUnsignedTx;

/**
 * Simulates a read-only contract call and decodes the return value, without building a
 * submittable transaction. `callerPublicKey` only needs to be a funded account that exists on
 * the target network — it never signs or pays for anything.
 */
export async function simulateRead<T = unknown>(
  config: NetworkConfig,
  callerPublicKey: string,
  contractId: string,
  method: string,
  scArgs: xdr.ScVal[],
): Promise<T> {
  const server = new rpc.Server(config.rpcUrl);
  const sourceAccount = await server.getAccount(callerPublicKey);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...scArgs))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`contract-clients: simulation of "${method}" failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error(`contract-clients: simulation of "${method}" returned no result`);
  }
  return normalizeContractValue(scValToNative(sim.result.retval)) as T;
}

/** `Account` is only needed by callers who want to inspect/mutate a fetched source account. */
export type { Account };
