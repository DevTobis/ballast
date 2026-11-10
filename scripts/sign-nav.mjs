#!/usr/bin/env node
// Signs the canonical NAV message "ballast-nav-v1:<contract_id>:<asset_code>:<ts>:<value>"
// (matching contracts/price-guard/src/lib.rs::build_nav_message and
// services/price-guard/src/navSignature.ts::canonicalNavMessage) with a Stellar S... secret key
// and prints the 64-byte Ed25519 signature as lowercase hex.
//
// Usage:
//   node scripts/sign-nav.mjs <secret-S...> <asset_code> <ts> <value> [contract_id]

import { Keypair } from "@stellar/stellar-sdk";

const [, , secret, assetCode, ts, value, contractIdArg] = process.argv;
if (!secret || !assetCode || !ts || !value) {
  console.error("usage: sign-nav.mjs <secret-S...> <asset_code> <ts> <value> [contract_id]");
  process.exit(2);
}

const contractId =
  contractIdArg ||
  process.env.PRICE_GUARD_CID ||
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const kp = Keypair.fromSecret(secret);
const msg = Buffer.from(`ballast-nav-v1:${contractId}:${assetCode}:${ts}:${value}`, "utf8");
process.stdout.write(Buffer.from(kp.sign(msg)).toString("hex") + "\n");
