/**
 * Soroban-RPC submit+poll logic, shared by every service that submits an operator-signed
 * transaction (services/price-guard, services/keeper). Previously duplicated byte-for-byte across
 * both services' own `submit.ts`; this is the one copy.
 */
import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { SubmitResult } from "./types.js";

/**
 * Submits an already-signed transaction envelope and polls `getTransaction` until the network
 * reports a final status. Throws on send failure or a non-SUCCESS final status.
 */
export async function submitSignedTx(
  rpcUrl: string,
  networkPassphrase: string,
  signedXdr: string,
  pollIntervalMs = 1000,
  maxAttempts = 30,
): Promise<SubmitResult> {
  const server = new rpc.Server(rpcUrl);
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    throw new Error(`submitSignedTx: send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const got = await server.getTransaction(hash);
    if (got.status === "SUCCESS") {
      return { hash, status: got.status };
    }
    if (got.status === "FAILED") {
      throw new Error(`submitSignedTx: transaction ${hash} failed on-chain`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`submitSignedTx: transaction ${hash} did not finalize after ${maxAttempts} attempts`);
}
