/**
 * PRD §6.5: "Pulls issuer NAV and feeds, signs and pushes updates to `PriceGuard`."
 *
 * For each configured asset: fetch issuer NAV + independent feed, record both as
 * `price_observation` rows (PRD §7), push them on-chain via `PriceGuardClient.publishNav` /
 * `.publishFeed` (signed with the price-publisher operator key and submitted), then read back the
 * contract's own `guarded_price()` — the guarded value/status stored in `price_snapshot` always
 * comes from the contract, never recomputed off-chain, so this service can't drift from what a
 * draw/exit/repo would actually see.
 */
import { schema, type Database } from "@ballast/db";
import { createConsoleAlerter } from "@ballast/observability";
import { loadNetworkConfig } from "@ballast/network-config";
import type { AssetConfig } from "@ballast/domain-types";
import type { PriceGuardClient } from "@ballast/contract-clients";
import { issuerAdapterForAsset } from "./adapters/mockIssuers.js";
import { MockRedstoneAdapter } from "./adapters/mockRedstone.js";
import type { IndependentFeedAdapter } from "./adapters/types.js";
import { scaledToDecimalString } from "./scaled.js";
import { submitSignedTx, type KmsSigner, type SubmitResult } from "./submit.js";

const alerter = createConsoleAlerter("price-guard");
const independentFeedAdapter: IndependentFeedAdapter = new MockRedstoneAdapter();

/** MOCK issuer signature — real issuer-signed NAV verification is Phase 0/1 work (PRD §6.4). */
function mockSignatureBytes(seed: string): Buffer {
  const seedBytes = Buffer.from(seed, "utf8");
  const bytes = Buffer.alloc(64);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = seedBytes[i % seedBytes.length] ?? 0;
  }
  return bytes;
}

type SubmitFn = (signedXdr: string) => Promise<SubmitResult>;

/**
 * Default submit function, built lazily from `loadNetworkConfig()` so importing this module never
 * requires network env vars to be set (tests inject their own `submit` mock instead).
 */
function defaultSubmit(signedXdr: string): Promise<SubmitResult> {
  const network = loadNetworkConfig();
  return submitSignedTx(network.rpcUrl, network.networkPassphrase, signedXdr);
}

export async function runPriceUpdateCycle(
  db: Database,
  priceGuardClient: PriceGuardClient,
  signer: KmsSigner,
  assets: AssetConfig[],
  submit: SubmitFn = defaultSubmit,
): Promise<void> {
  const publisherPublicKey = signer.publicKey();

  for (const asset of assets) {
    const adapter = issuerAdapterForAsset(asset.code);
    const [nav, feed] = await Promise.all([
      adapter.fetchNav(asset.code),
      independentFeedAdapter.fetchPrice(asset.code),
    ]);

    await db.insert(schema.priceObservation).values({
      assetId: asset.id,
      source: "issuer_nav",
      value: scaledToDecimalString(nav.value),
      observedAt: new Date(nav.ts * 1000),
      stale: false,
    });
    await db.insert(schema.priceObservation).values({
      assetId: asset.id,
      source: "redstone",
      value: scaledToDecimalString(feed.value),
      observedAt: new Date(feed.ts * 1000),
      stale: false,
    });

    const navUnsignedXdr = await priceGuardClient.publishNav(
      publisherPublicKey,
      asset.contractC,
      nav.value,
      nav.ts,
      mockSignatureBytes(`${asset.code}:${nav.ts}`),
    );
    const navSignedXdr = await signer.sign(navUnsignedXdr);
    await submit(navSignedXdr);

    const feedUnsignedXdr = await priceGuardClient.publishFeed(
      publisherPublicKey,
      asset.contractC,
      "redstone",
      feed.value,
      feed.ts,
    );
    const feedSignedXdr = await signer.sign(feedUnsignedXdr);
    await submit(feedSignedXdr);

    // Read-only; the underlying client simulates this against STELLAR_SIMULATION_SOURCE rather
    // than taking a caller argument (see @ballast/contract-clients' base-client.ts).
    const guarded = await priceGuardClient.guardedPrice(asset.contractC);

    await db.insert(schema.priceSnapshot).values({
      assetId: asset.id,
      guardedValue: scaledToDecimalString(guarded.value),
      status: guarded.status,
      // jsonb can't hold bigint directly — serialize values to strings first.
      sources: guarded.sources.map((s) => ({ ...s, value: s.value.toString() })),
      ledger: 0, // filled in by the indexer once the on-chain tx is confirmed
    });

    if (guarded.status === "Degraded") {
      alerter.fire("price_degraded", { assetId: asset.id, code: asset.code, status: guarded.status });
    } else if (guarded.status === "Halted") {
      alerter.fire("price_halted", { assetId: asset.id, code: asset.code, status: guarded.status });
    }
  }
}
