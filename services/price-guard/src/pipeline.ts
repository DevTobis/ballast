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
import { getIndependentFeedAdapter, getIssuerNavAdapter } from "./adapters/registry.js";
import { loadIssuerNavPublicKeys, verifyNavSignature } from "./navSignature.js";
import { scaledToDecimalString } from "./scaled.js";
import { submitSignedTx, type KmsSigner, type SubmitResult } from "@ballast/operator-signing";

const alerter = createConsoleAlerter("price-guard");

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
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const publisherPublicKey = signer.publicKey();
  const independentFeedAdapter = getIndependentFeedAdapter(env);
  const issuerPublicKeys = loadIssuerNavPublicKeys(env);

  for (const asset of assets) {
    try {
      const issuerAdapter = getIssuerNavAdapter(asset.issuerCode, env);
      const [nav, feed] = await Promise.all([
        issuerAdapter.fetchNav(asset.code),
        independentFeedAdapter.fetchPrice(asset.code),
      ]);

      const issuerPublicKey = issuerPublicKeys[asset.issuerCode];
      if (!issuerPublicKey) {
        alerter.fire("price_degraded", {
          assetId: asset.id,
          code: asset.code,
          reason: `no ISSUER_NAV_PUBLIC_KEYS entry for issuer code "${asset.issuerCode}"`,
        });
        console.error(
          `price-guard: skipping ${asset.code} this cycle — no ISSUER_NAV_PUBLIC_KEYS entry for issuer code "${asset.issuerCode}"`,
        );
        continue;
      }
      const verified = verifyNavSignature(asset.code, nav.ts, nav.value, nav.sig, issuerPublicKey);
      if (!verified) {
        alerter.fire("price_degraded", {
          assetId: asset.id,
          code: asset.code,
          reason: "issuer NAV signature verification failed",
        });
        console.error(
          `price-guard: skipping ${asset.code} this cycle — issuer NAV signature verification failed`,
        );
        continue;
      }

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
        asset.code,
        nav.value,
        nav.ts,
        nav.sig,
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
    } catch (err) {
      // Don't let one asset's adapter/verification failure crash the whole cycle — other assets
      // still need their prices published this run.
      console.error(`price-guard: cycle failed for asset ${asset.code}`, err);
    }
  }
}
