/**
 * Live read-only smoke test: calls each real source once and prints what it returned. Sends
 * nothing on-chain and touches no database, so it is safe against mainnet.
 *
 * Usage:
 *   # Human mode (supports 1 or more targets):
 *   STELLAR_RPC_URL=https://mainnet.sorobanrpc.com \
 *   STELLAR_HORIZON_URL=https://horizon.stellar.org \
 *   STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" \
 *   STELLAR_SIMULATION_SOURCE=<any existing mainnet account> \
 *   REDSTONE_FEED_CONTRACT_IDS='{"CETES":"CCYGBQZ5JKE2TGK2XNNVIZRKFEIT27NZADS3XJFSO4CCIH3LHIUP34LG"}' \
 *   pnpm --filter @ballast/service-price-guard smoke CETES:etherfuse USTBL:spiko
 *
 *   # JSON mode (requires exactly one target):
 *   pnpm --filter @ballast/service-price-guard smoke --json CETES:etherfuse
 *
 * Flags:
 *   --json                 Output machine-readable JSON object `{ nav, feed }`. Requires exactly
 *                          one target. Scaled 1e7 integer prices are represented as strings.
 *                          For issuers with no public NAV API (e.g. Franklin), `nav` is `null`.
 *
 * Arguments:
 *   ASSET_CODE:issuerCode  One or more asset-to-issuer pairs (e.g. CETES:etherfuse, USTBL:spiko, BENJI:franklin).
 *
 * Exit Codes:
 *   0                      Success: every queried source answered successfully (or single target evaluated in --json mode).
 *   1                      Failure: one or more sources failed, invalid arguments, or --json called with !== 1 target.
 *
 * Environment:
 *   STELLAR_RPC_URL             Soroban RPC endpoint (e.g. mainnet RPC) for simulating RedStone reads.
 *   STELLAR_HORIZON_URL         Stellar Horizon endpoint.
 *   STELLAR_NETWORK_PASSPHRASE  Stellar network passphrase.
 *   STELLAR_SIMULATION_SOURCE   Valid funded account address used for read-only simulations.
 *   REDSTONE_FEED_CONTRACT_IDS  JSON map of `{ assetCode: feedContractId }`.
 *   ISSUER_NAV_SYMBOLS          (Optional) JSON map of `{ assetCode: issuerSymbol }`.
 *   SPIKO_NAV_API_BASE_URL      (Optional) Custom Spiko endpoint.
 *   ETHERFUSE_NAV_API_BASE_URL  (Optional) Custom Etherfuse endpoint.
 *   Note: The script never submits transactions on-chain and does not touch any database.
 *
 * Sample Human Output:
 *   CETES (etherfuse)
 *     issuer NAV   $0.0657660  updated 2026-10-08T06:52:59.000Z (2 min ago)
 *     RedStone     $0.0657500  updated 2026-10-08T06:25:40.000Z (29 min ago)
 *     divergence   2 bps
 *
 *   BENJI (franklin)
 *     issuer NAV   none (no public NAV API for this issuer)
 *     RedStone     $1.0000000  updated 2026-10-08T06:25:40.000Z (29 min ago)
 *
 * Sample JSON Output:
 *   {"nav":{"value":"657660","ts":1791447179},"feed":{"value":"657500","ts":1791445540}}
 *
 * Sample JSON Output (Franklin / no public NAV):
 *   {"nav":null,"feed":{"value":"10000000","ts":1791445540}}
 */
import { scaledToDecimalString } from "./scaled.js";
import { getIndependentFeedAdapter, getIssuerNavAdapter } from "./adapters/registry.js";

const json = process.argv.includes("--json");
const targets = process.argv.slice(2).filter((a) => a !== "--json").map((arg) => {
  const [code, issuerCode] = arg.split(":");
  if (!code || !issuerCode) throw new Error(`bad target "${arg}", expected ASSET_CODE:issuerCode`);
  return { code, issuerCode };
});
if (targets.length === 0) throw new Error("usage: smoke ASSET_CODE:issuerCode [...]");

function describe(label: string, reading: { value: bigint; ts: number }): string {
  const ageMin = Math.round((Date.now() / 1000 - reading.ts) / 60);
  return `${label.padEnd(12)} $${scaledToDecimalString(reading.value)}  updated ${new Date(reading.ts * 1000).toISOString()} (${ageMin} min ago)`;
}

if (json) {
  if (targets.length !== 1) throw new Error("--json takes exactly one target");
  const { code, issuerCode } = targets[0];
  const nav = await getIssuerNavAdapter(issuerCode)?.fetchNav(code);
  const feed = await getIndependentFeedAdapter().fetchPrice(code);
  const out = (r?: { value: bigint; ts: number }) => (r ? { value: r.value.toString(), ts: r.ts } : null);
  console.log(JSON.stringify({ nav: out(nav), feed: out(feed) }));
  process.exit(0);
}

let failed = false;
for (const { code, issuerCode } of targets) {
  console.log(`\n${code} (${issuerCode})`);
  const readings: Record<string, { value: bigint; ts: number }> = {};

  const nav = getIssuerNavAdapter(issuerCode);
  if (!nav) {
    console.log("  issuer NAV   none (no public NAV API for this issuer)");
  } else {
    try {
      readings.issuer = await nav.fetchNav(code);
      console.log("  " + describe("issuer NAV", readings.issuer));
    } catch (err) {
      failed = true;
      console.log(`  issuer NAV   FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  try {
    readings.feed = await getIndependentFeedAdapter().fetchPrice(code);
    console.log("  " + describe("RedStone", readings.feed));
  } catch (err) {
    failed = true;
    console.log(`  RedStone     FAILED: ${err instanceof Error ? err.message : err}`);
  }

  if (readings.issuer && readings.feed) {
    const diff = readings.issuer.value > readings.feed.value ? readings.issuer.value - readings.feed.value : readings.feed.value - readings.issuer.value;
    console.log(`  divergence   ${Number((diff * 10_000n) / readings.issuer.value)} bps`);
  }
}
process.exit(failed ? 1 : 0);
