/**
 * Where to look a transaction up. The console only knows its network through the passphrase it
 * signs for; a local or unknown network has no public explorer, so it gets no link rather than a
 * link to the wrong chain.
 */
export function networkPassphrase(): string | undefined {
  const value = import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE;
  // An empty string (an unset Docker build arg) must reach Freighter as "not provided".
  return value ? value : undefined;
}

export function txExplorerUrl(txHash: string): string | null {
  const passphrase = networkPassphrase() ?? "";
  if (passphrase.startsWith("Public Global")) return `https://stellar.expert/explorer/public/tx/${txHash}`;
  if (passphrase.startsWith("Test SDF Network")) return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
  return null;
}
