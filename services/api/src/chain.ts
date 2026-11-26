import { rpc } from "@stellar/stellar-sdk";
import { loadNetworkConfig } from "@ballast/network-config";
import { getTxOutcome, sendSignedTx, txHashOf, type TxOutcome } from "@ballast/contract-clients";

/**
 * The API's view of the network for transactions it built but didn't sign: hash an envelope,
 * send a signed one, ask how it ended. A seam (like `ContractClients`) so tests can inject a fake
 * instead of reaching a real Stellar RPC.
 */
export interface ChainGateway {
  txHash(envelopeXdr: string): string;
  send(signedXdr: string): Promise<string>;
  outcome(hash: string): Promise<TxOutcome>;
  /** Cheap RPC round trip for `/readyz`. Optional so test fakes need not implement it. */
  getLatestLedger?(): Promise<unknown>;
}

/**
 * Resolves network config on first use rather than at construction, so `buildServer()` can be
 * called (as tests do) without Stellar env vars as long as no route actually reaches the network.
 */
export function getChainGateway(): ChainGateway {
  let network: ReturnType<typeof loadNetworkConfig> | undefined;
  const config = () => (network ??= loadNetworkConfig());
  return {
    txHash: (envelopeXdr) => txHashOf(envelopeXdr, config().networkPassphrase),
    send: (signedXdr) => sendSignedTx(config(), signedXdr),
    outcome: (hash) => getTxOutcome(config(), hash),
    getLatestLedger: async () => {
      const { rpcUrl } = config();
      const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
      return server.getLatestLedger();
    },
  };
}
