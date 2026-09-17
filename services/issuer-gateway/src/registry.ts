import type { IssuerAdapter } from "./adapter.js";
import { MockSpikoAdapter } from "./adapters/mockSpiko.js";
import { MockEtherfuseAdapter } from "./adapters/mockEtherfuse.js";
import { MockFranklinAdapter } from "./adapters/mockFranklin.js";
import { SpikoAdapter } from "./adapters/spikoAdapter.js";
import { EtherfuseAdapter } from "./adapters/etherfuseAdapter.js";
import { FranklinAdapter } from "./adapters/franklinAdapter.js";

/** Issuer code (asset-family key, e.g. `"spiko"`, lowercased) -> adapter instance. */
const mockAdapters: Record<string, IssuerAdapter> = {
  spiko: new MockSpikoAdapter(),
  etherfuse: new MockEtherfuseAdapter(),
  franklin: new MockFranklinAdapter(),
};

/**
 * Builds the `"live"`-mode adapters from env (see `.env.example`'s "issuer-gateway live adapters"
 * section). Lazy (called only when `ISSUER_GATEWAY_MODE === "live"`) so `"mock"` mode — the
 * default for local dev/test — never requires these vars to be set.
 *
 * NOTE: these adapters are protocol-correct (SEP-8 follows the real documented Stellar
 * "Regulated Assets" approval-server protocol; the bespoke back-office endpoints follow this
 * repo's REST conventions) and are ready to work once real Spiko/Etherfuse/Franklin credentials
 * are supplied, but they have NOT been live-verified end-to-end — no real issuer credentials were
 * available in this environment. See `services/issuer-gateway`'s implementation report.
 */
function buildLiveAdapters(env: NodeJS.ProcessEnv): Record<string, IssuerAdapter> {
  return {
    spiko: new SpikoAdapter(
      env.SPIKO_API_BASE_URL ?? "",
      env.SPIKO_API_KEY ?? "",
      env.SPIKO_SEP8_APPROVAL_SERVER_URL,
    ),
    etherfuse: new EtherfuseAdapter(
      env.ETHERFUSE_API_BASE_URL ?? "",
      env.ETHERFUSE_API_KEY ?? "",
      env.ETHERFUSE_SEP8_APPROVAL_SERVER_URL,
    ),
    franklin: new FranklinAdapter(
      env.FRANKLIN_API_BASE_URL ?? "",
      env.FRANKLIN_API_KEY ?? "",
      env.FRANKLIN_SEP8_APPROVAL_SERVER_URL,
    ),
  };
}

/**
 * Resolves the `IssuerAdapter` for `issuerCode` according to `ISSUER_GATEWAY_MODE` (see
 * `.env.example`). `"mock"` (the default) returns in-memory fakes for local dev/test; `"live"`
 * constructs real adapters that call each issuer's actual back-office API and SEP-8 approval
 * server. Any other value throws rather than silently pretending to talk to a real issuer.
 */
export function getAdapter(issuerCode: string, env: NodeJS.ProcessEnv = process.env): IssuerAdapter {
  const mode = env.ISSUER_GATEWAY_MODE ?? "mock";

  let adapters: Record<string, IssuerAdapter>;
  if (mode === "mock") {
    adapters = mockAdapters;
  } else if (mode === "live") {
    adapters = buildLiveAdapters(env);
  } else {
    throw new Error(
      `issuer-gateway: ISSUER_GATEWAY_MODE="${mode}" is not implemented — only "mock" and "live" are supported`,
    );
  }

  const adapter = adapters[issuerCode.toLowerCase()];
  if (!adapter) {
    throw new Error(
      `issuer-gateway: no ${mode} adapter registered for issuer code "${issuerCode}" (known: ${Object.keys(adapters).join(", ")})`,
    );
  }
  return adapter;
}
