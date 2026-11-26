import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { seedShadow, validateShadowAssets, type ShadowAsset, MAINNET } from "./seedShadow.js";
import { Asset } from "@stellar/stellar-sdk";

function makeInMemoryDb(initialRows: any[] = []) {
  const rows = [...initialRows];
  const insertCalls: any[] = [];
  return {
    rows,
    insertCalls,
    select: () => ({
      from: () => ({
        where: (expr: any) => ({
          limit: async (_n: number) => {
            const targetContract = expr?.right?.value ?? expr?.value;
            if (targetContract) {
              return rows.filter((r) => r.contractC === targetContract);
            }
            return [];
          },
        }),
      }),
    }),
    insert: (_table: any) => ({
      values: async (data: any) => {
        insertCalls.push(data);
        rows.push(data);
        return [data];
      },
    }),
    $client: {
      end: vi.fn(async () => {}),
    },
  };
}

describe("seedShadow", () => {
  it("fails before any insert with all errors listed when input has invalid fields", async () => {
    const invalidAssets = [
      {
        code: "TOOLONGASSETNAME123", // invalid code (>12 chars)
        issuer: "INVALID_G_ADDRESS",  // invalid G-address
        issuerCode: "unknown_issuer", // unknown issuer
        ccy: "TOOLONGCCY",           // invalid currency
      },
      {
        code: "",
        issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
        issuerCode: "etherfuse",
        ccy: "USD",
      },
    ];

    const errors = validateShadowAssets(invalidAssets);
    expect(errors.length).toBe(5);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("invalid asset code \"TOOLONGASSETNAME123\""),
        expect.stringContaining("invalid issuer G-address \"INVALID_G_ADDRESS\""),
        expect.stringContaining("unknown issuerCode \"unknown_issuer\""),
        expect.stringContaining("invalid currency code \"TOOLONGCCY\""),
        expect.stringContaining("invalid asset code \"\""),
      ]),
    );

    const db = makeInMemoryDb();
    await expect(seedShadow(db, invalidAssets as any)).rejects.toThrow(/seed:shadow validation failed with 5 error\(s\)/);
    expect(db.insertCalls).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it("--dry-run derives contract ids and writes nothing to the database", async () => {
    const assets: ShadowAsset[] = [
      {
        code: "CETES",
        issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
        issuerCode: "etherfuse",
        ccy: "MXN",
      },
      {
        code: "USTRY",
        issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
        issuerCode: "etherfuse",
        ccy: "USD",
      },
    ];

    const logs: string[] = [];
    const db = makeInMemoryDb();
    const result = await seedShadow(db, assets, { dryRun: true, log: (msg) => logs.push(msg) });

    expect(result.dryRun).toHaveLength(2);
    expect(result.seeded).toHaveLength(0);
    expect(db.insertCalls).toHaveLength(0);
    expect(db.rows).toHaveLength(0);

    const expectedCetes = new Asset(assets[0].code, assets[0].issuer).contractId(MAINNET);
    const expectedUstry = new Asset(assets[1].code, assets[1].issuer).contractId(MAINNET);
    expect(result.dryRun[0]).toBe(expectedCetes);
    expect(result.dryRun[1]).toBe(expectedUstry);
    expect(logs[0]).toContain(`CETES: dry-run contract id ${expectedCetes}`);
    expect(logs[1]).toContain(`USTRY: dry-run contract id ${expectedUstry}`);
  });

  it("seeds entries into in-memory db with defaults unchanged for the shipped file", async () => {
    const file = new URL("../../../scripts/shadow-assets.json", import.meta.url);
    const shippedAssets = JSON.parse(readFileSync(file, "utf8")) as ShadowAsset[];

    const db = makeInMemoryDb();
    const result = await seedShadow(db, shippedAssets);

    expect(result.seeded).toHaveLength(shippedAssets.length);
    expect(db.rows).toHaveLength(shippedAssets.length);

    // Verify default parameters match the expected production defaults
    for (const row of db.rows) {
      expect(row.redemptionLagDays).toBe(1);
      expect(row.navSchedule).toBe("daily");
      expect(row.priceBandBps).toBe(50);
      expect(row.dailyMoveBandBps).toBe(100);
      expect(row.haircutBaseBps).toBe(500);
      expect(row.haircutFxBps).toBe(0);
      expect(row.standard).toBe("classic_sac");
      expect(row.yieldType).toBe("accumulating");
      expect(row.custodyMode).toBe("escrow");
    }
  });

  it("reads custom band and haircut parameters when present in the JSON entry", async () => {
    const customAsset: ShadowAsset = {
      code: "CETES",
      issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
      issuerCode: "etherfuse",
      ccy: "MXN",
      priceBandBps: 80,
      dailyMoveBandBps: 150,
      haircutBaseBps: 600,
      haircutFxBps: 50,
      redemptionLagDays: 3,
    };

    const db = makeInMemoryDb();
    await seedShadow(db, [customAsset]);

    expect(db.rows[0].priceBandBps).toBe(80);
    expect(db.rows[0].dailyMoveBandBps).toBe(150);
    expect(db.rows[0].haircutBaseBps).toBe(600);
    expect(db.rows[0].haircutFxBps).toBe(50);
    expect(db.rows[0].redemptionLagDays).toBe(3);
  });
});
