/**
 * Seeds the real mainnet assets a shadow run watches (scripts/shadow-assets.json) into the `asset`
 * table. Each row's `contract_c` is the asset's Stellar Asset Contract id, derived from its
 * classic code + issuer, so it is the same id any contract would see on mainnet. Idempotent.
 *
 * Issuers and feed contracts in that file were checked against the issuer's own stellar.toml and
 * RedStone's repository on 2026-10-08. Spiko and Franklin are absent on purpose: Spiko's Stellar
 * issuer could not be confirmed from a stellar.toml, and Franklin has no public NAV API.
 *
 *   pnpm --filter @ballast/service-price-guard shadow:seed
 *   pnpm --filter @ballast/service-price-guard shadow:seed --dry-run
 */
import { readFileSync } from "node:fs";
import { Asset, StrKey } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { createDatabase, schema } from "@ballast/db";

export const MAINNET = "Public Global Stellar Network ; September 2015";

export const KNOWN_ISSUER_CODES = new Set(["etherfuse", "spiko", "franklin"]);

export interface ShadowAsset {
  code: string;
  issuer: string;
  issuerCode: string;
  ccy: string;
  feed?: string;
  priceBandBps?: number;
  dailyMoveBandBps?: number;
  haircutBaseBps?: number;
  haircutFxBps?: number;
  redemptionLagDays?: number;
}

export function validateShadowAssets(assets: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(assets) || assets.length === 0) {
    errors.push("shadow-assets must be a non-empty array");
    return errors;
  }
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i] as Partial<ShadowAsset>;
    const prefix = `entry ${i} (${a?.code ?? "unknown"})`;
    if (!a?.code || typeof a.code !== "string" || !/^[a-zA-Z0-9]{1,12}$/.test(a.code)) {
      errors.push(`${prefix}: invalid asset code "${a?.code}"`);
    }
    if (!a?.issuer || typeof a.issuer !== "string" || !StrKey.isValidEd25519PublicKey(a.issuer)) {
      errors.push(`${prefix}: invalid issuer G-address "${a?.issuer}"`);
    }
    if (!a?.issuerCode || typeof a.issuerCode !== "string" || !KNOWN_ISSUER_CODES.has(a.issuerCode.toLowerCase())) {
      errors.push(`${prefix}: unknown issuerCode "${a?.issuerCode}"`);
    }
    if (!a?.ccy || typeof a.ccy !== "string" || !/^[a-zA-Z]{3,4}$/.test(a.ccy)) {
      errors.push(`${prefix}: invalid currency code "${a?.ccy}"`);
    }
  }
  return errors;
}

export interface SeedShadowOptions {
  dryRun?: boolean;
  log?: (msg: string) => void;
  network?: string;
}

export interface SeedShadowResult {
  seeded: string[];
  alreadySeeded: string[];
  dryRun: string[];
}

export async function seedShadow(
  db: any,
  assets: ShadowAsset[],
  options: SeedShadowOptions = {},
): Promise<SeedShadowResult> {
  const errors = validateShadowAssets(assets);
  if (errors.length > 0) {
    throw new Error(`seed:shadow validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  const log = options.log ?? console.log;
  const network = options.network ?? MAINNET;
  const dryRun = Boolean(options.dryRun);

  const result: SeedShadowResult = {
    seeded: [],
    alreadySeeded: [],
    dryRun: [],
  };

  if (dryRun) {
    for (const a of assets) {
      const contractC = new Asset(a.code, a.issuer).contractId(network);
      log(`${a.code}: dry-run contract id ${contractC}`);
      result.dryRun.push(contractC);
    }
    return result;
  }

  for (const a of assets) {
    const contractC = new Asset(a.code, a.issuer).contractId(network);
    const [existing] = await db.select().from(schema.asset).where(eq(schema.asset.contractC, contractC)).limit(1);
    if (existing) {
      log(`${a.code}: already seeded (${contractC})`);
      result.alreadySeeded.push(a.code);
      continue;
    }
    await db.insert(schema.asset).values({
      code: a.code,
      issuerG: a.issuer,
      issuerCode: a.issuerCode,
      contractC,
      standard: "classic_sac",
      yieldType: "accumulating",
      custodyMode: "escrow",
      ccy: a.ccy,
      redemptionLagDays: a.redemptionLagDays ?? 1,
      navSchedule: "daily",
      priceBandBps: a.priceBandBps ?? 50,
      dailyMoveBandBps: a.dailyMoveBandBps ?? 100,
      haircutBaseBps: a.haircutBaseBps ?? 500,
      haircutFxBps: a.haircutFxBps ?? 0,
    });
    log(`${a.code}: seeded (${contractC})`);
    result.seeded.push(a.code);
  }

  return result;
}

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const file = new URL("../../../scripts/shadow-assets.json", import.meta.url);
  const assets = JSON.parse(readFileSync(file, "utf8")) as ShadowAsset[];

  if (dryRun) {
    await seedShadow(null, assets, { dryRun: true });
    process.exit(0);
  }

  const db = createDatabase();
  try {
    await seedShadow(db, assets);
  } finally {
    if (db?.$client && typeof db.$client.end === "function") {
      await db.$client.end();
    }
  }
  process.exit(0);
}

if (!process.env.VITEST && process.argv[1]?.includes("seedShadow")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
