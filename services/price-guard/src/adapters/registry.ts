/**
 * Resolves this service's two adapter kinds (`IndependentFeedAdapter`, `IssuerNavAdapter`)
 * according to `PRICE_GUARD_MODE` (`.env.example`), mirroring
 * `services/issuer-gateway/src/registry.ts`'s "mode env var + registry + real adapter" pattern:
 * `"mock"` (the default) returns in-memory fakes for local dev/test; `"live"` constructs real
 * adapters. Any other mode, or an unknown issuer code, throws rather than silently defaulting —
 * this replaces `mockIssuers.ts`'s old `issuerAdapterForAsset()`, which silently substring-matched
 * asset codes and fell back to "spiko" on no match.
 */
import type { IndependentFeedAdapter, IssuerNavAdapter } from "./types.js";
import { MockRedstoneAdapter } from "./mockRedstone.js";
import { MockEtherfuseAdapter, MockFranklinAdapter, MockSpikoAdapter } from "./mockIssuers.js";
import { RedstoneAdapter, loadRedstoneFeedContractIds } from "./redstoneAdapter.js";
import { SpikoNavAdapter } from "./spikoNavAdapter.js";
import { EtherfuseNavAdapter } from "./etherfuseNavAdapter.js";
import { FranklinNavAdapter } from "./franklinNavAdapter.js";

/** Issuer code -> mock adapter instance. */
const mockIssuerAdapters: Record<string, IssuerNavAdapter> = {
  spiko: new MockSpikoAdapter(),
  etherfuse: new MockEtherfuseAdapter(),
  franklin: new MockFranklinAdapter(),
};

const mockFeedAdapter: IndependentFeedAdapter = new MockRedstoneAdapter();

/**
 * Builds the `"live"`-mode issuer NAV adapters from env (see `.env.example`'s "issuer-gateway
 * live adapters" section — these reuse the same `SPIKO_API_BASE_URL`/etc. vars). Lazy (called
 * only when `PRICE_GUARD_MODE === "live"`) so `"mock"` mode never requires these vars to be set.
 */
function buildLiveIssuerAdapters(env: NodeJS.ProcessEnv): Record<string, IssuerNavAdapter> {
  return {
    spiko: new SpikoNavAdapter(env.SPIKO_API_BASE_URL ?? "", env.SPIKO_API_KEY ?? ""),
    etherfuse: new EtherfuseNavAdapter(env.ETHERFUSE_API_BASE_URL ?? "", env.ETHERFUSE_API_KEY ?? ""),
    franklin: new FranklinNavAdapter(env.FRANKLIN_API_BASE_URL ?? "", env.FRANKLIN_API_KEY ?? ""),
  };
}

/**
 * Resolves the `IssuerNavAdapter` for `issuerCode` (the `asset.issuer_code` DB column — an exact
 * match, never a substring guess). Throws on an unknown mode or an unknown issuer code rather than
 * silently defaulting.
 */
export function getIssuerNavAdapter(
  issuerCode: string,
  env: NodeJS.ProcessEnv = process.env,
): IssuerNavAdapter {
  const mode = env.PRICE_GUARD_MODE ?? "mock";

  let adapters: Record<string, IssuerNavAdapter>;
  if (mode === "mock") {
    adapters = mockIssuerAdapters;
  } else if (mode === "live") {
    adapters = buildLiveIssuerAdapters(env);
  } else {
    throw new Error(
      `price-guard: PRICE_GUARD_MODE="${mode}" is not implemented — only "mock" and "live" are supported`,
    );
  }

  const adapter = adapters[issuerCode.toLowerCase()];
  if (!adapter) {
    throw new Error(
      `price-guard: no ${mode} issuer NAV adapter registered for issuer code "${issuerCode}" (known: ${Object.keys(adapters).join(", ")})`,
    );
  }
  return adapter;
}

/**
 * Resolves the single `IndependentFeedAdapter` (RedStone's SEP-40 feed) for this cycle. Throws on
 * an unknown mode.
 */
export function getIndependentFeedAdapter(env: NodeJS.ProcessEnv = process.env): IndependentFeedAdapter {
  const mode = env.PRICE_GUARD_MODE ?? "mock";

  if (mode === "mock") {
    return mockFeedAdapter;
  }
  if (mode === "live") {
    return new RedstoneAdapter(loadRedstoneFeedContractIds(env), env);
  }
  throw new Error(
    `price-guard: PRICE_GUARD_MODE="${mode}" is not implemented — only "mock" and "live" are supported`,
  );
}
