import { loadNetworkConfig, type NetworkConfig } from "@ballast/network-config";
import { submitSignedTx, type KmsSigner } from "@ballast/operator-signing";

export type NetworkSubmissionConfig = Pick<NetworkConfig, "rpcUrl" | "networkPassphrase">;

/**
 * Signs an unsigned Soroban transaction envelope with the keeper's KMS/operator signer
 * and submits it to the Stellar RPC network. Returns the resulting transaction hash.
 */
export async function signAndSubmit(
  signer: KmsSigner,
  unsignedXdr: string,
  network?: NetworkSubmissionConfig,
): Promise<string> {
  const net = network ?? loadNetworkConfig();
  const signedXdr = await signer.sign(unsignedXdr);
  const submitted = await submitSignedTx(net.rpcUrl, net.networkPassphrase, signedXdr);
  return submitted.hash;
}
