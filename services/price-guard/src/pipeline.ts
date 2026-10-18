/**
 * PRD §6.5: "Pulls issuer NAV and feeds, signs and pushes updates to `PriceGuard`."
 *
 * For each configured asset: fetch issuer NAV (where the issuer has an API) + independent feed, record both as
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
import { attestNav } from "./navAttestor.js";
import { scaledToDecimalString } from "./scaled.js";
import { submitSignedTx, type KmsSigner, type SubmitResult } from "@ballast/operator-signing";

const alerter = createConsoleAlerter("price-guard");

type SubmitFn = (signedXdr: string) => Promise<SubmitResult>;
type Reading = { value: bigint; ts: number };

/**
 * Default submit function, built lazily from `loadNetworkConfig()` so importing this module never
 * requires network env vars to be set (tests inject their own `submit` instead).
 */
function defaultSubmit(signedXdr: string): Promise<SubmitResult> {
  const network = loadNetworkConfig();
  return submitSignedTx(network.rpcUrl, network.networkPassphrase, signedXdr);
}

/** Awaits a source fetch; a failure alerts and yields `undefined` so the other source still publishes. */
async function settle(asset: AssetConfig, source: string, read: Promise<Reading>): Promise<Reading | undefined> {
  try {
    return await read;
  } catch (err) {
    const reason = `${source} fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    alerter.fire("price_degraded", { assetId: asset.id, code: asset.code, reason });
    console.error(`price-guard: ${asset.code}: ${reason}`);
    return undefined;
  }
}

/** Absolute disagreement between two readings, in basis points of the first. */
function divergenceBps(a: bigint, b: bigint): number {
  if (a === 0n) return Number.POSITIVE_INFINITY;
  const diff = a > b ? a - b : b - a;
  return Number((diff * 10_000n) / a);
}

/**
 * One pass over `assets`. With `PRICE_GUARD_PUBLISH=false` this is a shadow run: it records the
 * real readings and flags source disagreement but sends nothing on-chain and writes no snapshot,
 * which is how the real mainnet feeds are observed before any contract is deployed against them.
 */
export async function runPriceUpdateCycle(
  db: Database,
  priceGuardClient: PriceGuardClient | null,
  signer: KmsSigner | null,
  assets: AssetConfig[],
  submit: SubmitFn = defaultSubmit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const independentFeedAdapter = getIndependentFeedAdapter(env);
  const shadow = env.PRICE_GUARD_PUBLISH === "false";
  if (!shadow && (!priceGuardClient || !signer)) {
    throw new Error("price-guard: publishing needs a PriceGuard client and an operator signer");
  }

  for (const asset of assets) {
    try {
      const issuerAdapter = getIssuerNavAdapter(asset.issuerCode, env);
      const [nav, feed] = await Promise.all([
        issuerAdapter ? settle(asset, "issuer NAV", issuerAdapter.fetchNav(asset.code)) : undefined,
        settle(asset, "RedStone feed", independentFeedAdapter.fetchPrice(asset.code)),
      ]);

      if (!nav && !feed) {
        continue;
      }

      if (nav) {
        await db.insert(schema.priceObservation).values({
          assetId: asset.id,
          source: "issuer_nav",
          value: scaledToDecimalString(nav.value),
          observedAt: new Date(nav.ts * 1000),
          stale: false,
        }).onConflictDoNothing();
      }
      if (feed) {
        await db.insert(schema.priceObservation).values({
          assetId: asset.id,
          source: "redstone",
          value: scaledToDecimalString(feed.value),
          observedAt: new Date(feed.ts * 1000),
          stale: false,
        }).onConflictDoNothing();
      }

      if (shadow) {
        if (nav && feed) {
          const bps = divergenceBps(nav.value, feed.value);
          if (bps > asset.priceBandBps) {
            alerter.fire("price_degraded", {
              assetId: asset.id,
              code: asset.code,
              reason: `issuer NAV and RedStone feed disagree by ${bps} bps (band ${asset.priceBandBps})`,
            });
          }
        }
        continue;
      }

      // Past the shadow `continue` above, so the guard at the top of the function applies.
      const client = priceGuardClient!;
      const publisher = signer!;
      const publisherPublicKey = publisher.publicKey();

      // Publish each source independently: a failed NAV tx must not stop the feed publish (and
      // vice versa). Collect per-source errors and alert after the read-back.
      const publishErrors: { source: string; reason: string }[] = [];

      if (nav) {
        try {
          const sig = await attestNav(publisher, asset.code, nav.ts, nav.value);
          const navUnsignedXdr = await client.publishNav(
            publisherPublicKey,
            asset.contractC,
            asset.code,
            nav.value,
            nav.ts,
            sig,
          );
          await submit(await publisher.sign(navUnsignedXdr));
        } catch (err) {
          const reason = `issuer NAV publish failed: ${err instanceof Error ? err.message : String(err)}`;
          publishErrors.push({ source: "issuer NAV", reason });
          console.error(`price-guard: ${asset.code}: ${reason}`);
        }
      }
      if (feed) {
        try {
          const feedUnsignedXdr = await client.publishFeed(
            publisherPublicKey,
            asset.contractC,
            "redstone",
            feed.value,
            feed.ts,
          );
          await submit(await publisher.sign(feedUnsignedXdr));
        } catch (err) {
          const reason = `RedStone feed publish failed: ${err instanceof Error ? err.message : String(err)}`;
          publishErrors.push({ source: "RedStone feed", reason });
          console.error(`price-guard: ${asset.code}: ${reason}`);
        }
      }

      // Read-only; the underlying client simulates this against STELLAR_SIMULATION_SOURCE rather
      // than taking a caller argument (see @ballast/contract-clients' base-client.ts).
      const guarded = await client.guardedPrice(asset.contractC);

      await db.insert(schema.priceSnapshot).values({
        assetId: asset.id,
        guardedValue: scaledToDecimalString(guarded.value),
        status: guarded.status,
        // jsonb can't hold bigint directly, and a decoded reading carries more than one (its
        // i128 `value` and its u64 `ts`) — stringify every bigint field, not just `value`.
        sources: guarded.sources.map((s) =>
          Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
        ),
        ledger: 0, // filled in by the indexer once the on-chain tx is confirmed
      });

      // Alert for any source that failed to publish, naming the source.
      for (const { source, reason } of publishErrors) {
        alerter.fire("price_degraded", { assetId: asset.id, code: asset.code, source, reason });
      }

      if (guarded.status === "Degraded") {
        alerter.fire("price_degraded", { assetId: asset.id, code: asset.code, status: guarded.status });
      } else if (guarded.status === "Halted") {
        alerter.fire("price_halted", { assetId: asset.id, code: asset.code, status: guarded.status });
      }
    } catch (err) {
      // Don't let one asset's failure crash the whole cycle — other assets still need their
      // prices published this run.
      console.error(`price-guard: cycle failed for asset ${asset.code}`, err);
    }
  }
}
