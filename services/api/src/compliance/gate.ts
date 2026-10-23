/**
 * The compliance gate in front of every route that takes on risk or moves a party's funds into the
 * system. A party passes only if its KYB status is `approved` and its latest sanctions screening is
 * `clear` and recent. A hit is recorded, written to the audit log and blocks the party until a
 * person looks at it. Paths that let money leave (repay, release, withdraw) are not gated.
 */
import { and, desc, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { ScreeningUnavailableError, type SanctionsScreener } from "./screener.js";

/** A clear screening is reused for this long before the party is checked again. */
export const SCREENING_TTL_MS = 24 * 3600 * 1000;

export interface Hold {
  status: 403 | 503;
  error: string;
}

export async function checkParty(
  db: Database,
  screener: SanctionsScreener,
  partyId: string,
  now: Date = new Date(),
): Promise<Hold | null> {
  const [party] = await db.select().from(schema.party).where(eq(schema.party.id, partyId)).limit(1);
  if (!party) return { status: 403, error: "party not found" };
  if (party.kybStatus !== "approved") {
    return { status: 403, error: `compliance hold: KYB is ${party.kybStatus}` };
  }

  const [latest] = await db
    .select()
    .from(schema.complianceCheck)
    .where(and(eq(schema.complianceCheck.partyId, partyId), eq(schema.complianceCheck.kind, "sanctions")))
    .orderBy(desc(schema.complianceCheck.checkedAt))
    .limit(1);
  // A `match` is never reused or aged out: it stays a hold until a person clears the party.
  if (latest?.result === "match") {
    return { status: 403, error: "compliance hold: sanctions screening needs review" };
  }
  if (latest && now.getTime() - latest.checkedAt.getTime() < SCREENING_TTL_MS) return null;

  // Retrieve past manual clears and their reviewed matches to avoid re-flagging known false positives
  const allChecks = await db
    .select()
    .from(schema.complianceCheck)
    .where(and(eq(schema.complianceCheck.partyId, partyId), eq(schema.complianceCheck.kind, "sanctions")))
    .orderBy(desc(schema.complianceCheck.checkedAt));

  const reviewedEntNums = new Set<string>();
  for (let i = 0; i < allChecks.length; i++) {
    const c = allChecks[i];
    if (c.result === "clear" && c.listSource?.startsWith("manual review by ")) {
      // Find the match check that immediately preceded this manual clear
      for (let j = i + 1; j < allChecks.length; j++) {
        const prior = allChecks[j];
        if (prior.result === "match" && Array.isArray(prior.matches)) {
          for (const m of prior.matches as any[]) {
            if (m && typeof m.entNum === "string") {
              reviewedEntNums.add(m.entNum);
            }
          }
          break;
        }
      }
    }
  }

  const accounts = await db.select().from(schema.partyAccount).where(eq(schema.partyAccount.partyId, partyId));
  let result;
  try {
    result = await screener.screen({
      legalName: party.legalName,
      stellarAccounts: accounts.map((a) => a.stellarAccount),
    });
  } catch (err) {
    if (err instanceof ScreeningUnavailableError) return { status: 503, error: err.message };
    throw err;
  }

  // Filter out matches that have already been reviewed and cleared manually
  const unreviewedMatches = result.matches.filter((m) => !reviewedEntNums.has(m.entNum));
  const hit = unreviewedMatches.length > 0;

  await db.insert(schema.complianceCheck).values({
    partyId,
    kind: "sanctions",
    result: hit ? "match" : "clear",
    matches: result.matches,
    listSource: hit ? result.listSource : reviewedEntNums.size > 0 && result.matches.length > 0 ? `${result.listSource} (reviewed matches ignored)` : result.listSource,
    listLoadedAt: result.listLoadedAt,
    checkedAt: now,
  });
  if (hit) {
    await db.insert(schema.auditLog).values({
      actor: "compliance",
      action: "sanctions.match",
      payload: { partyId, matches: unreviewedMatches },
    });
    return { status: 403, error: "compliance hold: sanctions screening needs review" };
  }
  return null;
}
