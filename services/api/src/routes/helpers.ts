import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { collateralValue as computeCollateralValue, ltvBps as computeLtvBps, classifyMargin } from "@ballast/domain-types";

export async function requireStellarAccount(db: Database, partyId: string): Promise<string> {
  const [account] = await db
    .select()
    .from(schema.partyAccount)
    .where(eq(schema.partyAccount.partyId, partyId))
    .limit(1);
  if (!account) throw new Error(`no stellar account on file for party ${partyId}`);
  return account.stellarAccount;
}

export async function requireAsset(db: Database, assetId: string) {
  const [asset] = await db.select().from(schema.asset).where(eq(schema.asset.id, assetId)).limit(1);
  if (!asset) throw new Error(`asset ${assetId} not found`);
  return asset;
}

export async function requireCreditLine(db: Database, id: string) {
  const [line] = await db.select().from(schema.creditLine).where(eq(schema.creditLine.id, id)).limit(1);
  if (!line) throw new Error(`credit line ${id} not found`);
  return line;
}

/**
 * `credit_line` only tracks the limit ceiling (PRD §7) — outstanding debt is derived from the
 * `draw`/`repayment` ledger, mirroring what the on-chain `ltv()` read would report.
 */
export async function outstandingDebt(db: Database, creditLineId: string): Promise<bigint> {
  const draws = await db.select().from(schema.draw).where(eq(schema.draw.creditLineId, creditLineId));
  const repayments = await db
    .select()
    .from(schema.repayment)
    .where(eq(schema.repayment.creditLineId, creditLineId));
  const drawn = draws.reduce((sum, d) => sum + BigInt(Math.round(Number(d.amount))), 0n);
  const repaid = repayments.reduce((sum, r) => sum + BigInt(Math.round(Number(r.principal))), 0n);
  const debt = drawn - repaid;
  return debt > 0n ? debt : 0n;
}

async function latestGuardedPrice(db: Database, assetId: string): Promise<{ value: bigint; status: string } | null> {
  const rows = await db
    .select()
    .from(schema.priceSnapshot)
    .where(eq(schema.priceSnapshot.assetId, assetId));
  if (rows.length === 0) return null;
  const latest = rows.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return { value: BigInt(Math.round(Number(latest.guardedValue))), status: latest.status };
}

/**
 * Best-effort LTV recomputation for a credit line given its currently-active pledges and each
 * pledged asset's latest guarded price/haircut. Used to gate `DELETE .../pledges/:pledgeId`
 * (PRD §9: "release; returns unsigned XDR if LTV permits") without waiting on a live on-chain
 * `ltv()` read, which the API layer doesn't have a signer for in every request path.
 */
export async function estimateLtvBps(
  db: Database,
  creditLineId: string,
  excludePledgeId?: string,
): Promise<number> {
  const pledges = await db
    .select()
    .from(schema.pledge)
    .where(eq(schema.pledge.creditLineId, creditLineId));

  let totalCollateral = 0n;
  for (const pledge of pledges) {
    if (pledge.status !== "active") continue;
    if (excludePledgeId && pledge.id === excludePledgeId) continue;
    const asset = await requireAsset(db, pledge.assetId);
    const price = await latestGuardedPrice(db, pledge.assetId);
    if (!price || price.status !== "Ok") continue;
    totalCollateral += computeCollateralValue(
      BigInt(Math.round(Number(pledge.units))),
      price.value,
      asset.haircutBaseBps + asset.haircutFxBps,
    );
  }

  const debt = await outstandingDebt(db, creditLineId);
  return computeLtvBps(debt, totalCollateral);
}

export { classifyMargin };
