import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { isTransientRpcError, withRpcRetry, type NetworkConfig } from "@ballast/network-config";
import { normalizeContractValue } from "./scval.js";

/**
 * Thrown when a contract call fails Soroban simulation or is rejected by contract logic (e.g. panic, assertion).
 * Mapped to HTTP 422 by services/api.
 */
export class ContractRejectedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`contract rejected the request: ${detail}`);
    this.name = "ContractRejectedError";
    this.detail = detail;
  }
}

/**
 * Read-only contract calls (`asset`, `guardedPrice`, `ltv`, `quote`, ...) are simulated, not
 * submitted, so they need no signer. `simulateRead` builds the envelope against a zero-sequence
 * account object (no ledger lookup), so the source only has to be a valid G-address; it need not
 * exist or be funded. It is read from STELLAR_SIMULATION_SOURCE.
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

/** How long an envelope from {@link buildUnsignedTx} stays valid for submission. */
export const UNSIGNED_TX_TIMEOUT_S = 300;

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
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  const sourceAccount = await withRpcRetry(() => server.getAccount(sourcePublicKey));

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...scArgs))
    // Long enough for a person to read and approve it in a wallet; `services/api` gives up on
    // an unsubmitted transaction a little after this (see its intent sweeper).
    .setTimeout(UNSIGNED_TX_TIMEOUT_S)
    .build();

  // Simulates the invocation and attaches the resulting Soroban resource footprint/fee so the
  // envelope is submittable as-is once signed.
  try {
    const prepared = await withRpcRetry(() => server.prepareTransaction(tx));
    return prepared.toXDR();
  } catch (err) {
    if (isTransientRpcError(err)) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ContractRejectedError(message);
  }
}

/** @deprecated use {@link buildUnsignedTx} */
export const buildUnsignedInvocation = buildUnsignedTx;

/**
 * Simulates a read-only contract call and decodes the return value, without building a
 * submittable transaction. `callerPublicKey` is only the envelope's source: the transaction is
 * never submitted, so the account need not exist on the target network (sequence 0 is used).
 */
export async function simulateRead<T = unknown>(
  config: NetworkConfig,
  callerPublicKey: string,
  contractId: string,
  method: string,
  scArgs: xdr.ScVal[],
): Promise<T> {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  const sourceAccount = new Account(callerPublicKey, "0");

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...scArgs))
    .setTimeout(30)
    .build();

  const sim = await withRpcRetry(() => server.simulateTransaction(tx));

  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractRejectedError(`contract-clients: simulation of "${method}" failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error(`contract-clients: simulation of "${method}" returned no result`);
  }
  return normalizeContractValue(scValToNative(sim.result.retval)) as T;
}

/** `Account` is only needed by callers who want to inspect/mutate a fetched source account. */
export type { Account };
