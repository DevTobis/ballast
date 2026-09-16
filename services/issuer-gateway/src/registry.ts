import type { IssuerAdapter } from "./adapter.js";
import { MockSpikoAdapter } from "./adapters/mockSpiko.js";
import { MockEtherfuseAdapter } from "./adapters/mockEtherfuse.js";
import { MockFranklinAdapter } from "./adapters/mockFranklin.js";

/** Issuer code (asset-family key, e.g. `"spiko"`, lowercased) -> adapter instance. */
const mockAdapters: Record<string, IssuerAdapter> = {
  spiko: new MockSpikoAdapter(),
  etherfuse: new MockEtherfuseAdapter(),
  franklin: new MockFranklinAdapter(),
};

/**
 * Resolves the `IssuerAdapter` for `issuerCode` according to `ISSUER_GATEWAY_MODE` (see
 * `.env.example`). Only `"mock"` is implemented in this skeleton — any other value throws rather
 * than silently pretending to talk to a real issuer back office.
 */
export function getAdapter(issuerCode: string, env: NodeJS.ProcessEnv = process.env): IssuerAdapter {
  const mode = env.ISSUER_GATEWAY_MODE ?? "mock";

  if (mode !== "mock") {
    throw new Error(
      `issuer-gateway: ISSUER_GATEWAY_MODE="${mode}" is not implemented — only "mock" is supported by this skeleton`,
    );
  }

  const adapter = mockAdapters[issuerCode.toLowerCase()];
  if (!adapter) {
    throw new Error(
      `issuer-gateway: no mock adapter registered for issuer code "${issuerCode}" (known: ${Object.keys(mockAdapters).join(", ")})`,
    );
  }
  return adapter;
}
