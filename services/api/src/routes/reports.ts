import type { FastifyInstance } from "fastify";
import { and, eq, gte, lt, or } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { z } from "zod";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    date: z.string().regex(DATE_REGEX, "date must be YYYY-MM-DD").optional(),
    from: z.string().regex(DATE_REGEX, "from must be YYYY-MM-DD").optional(),
    to: z.string().regex(DATE_REGEX, "to must be YYYY-MM-DD").optional(),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .refine((data) => data.date !== undefined || data.from !== undefined, {
    message: "either date or from must be provided",
  })
  .refine((data) => data.date === undefined || (data.from === undefined && data.to === undefined), {
    message: "use either date or from/to, not both",
  });

export const REPORT_CSV_FALLBACK_COLUMNS = [
  "kind",
  "id",
  "creditLineId",
  "fromState",
  "toState",
  "ltvBps",
  "priceSnapshotId",
  "createdAt",
  "route",
  "units",
  "proceeds",
  "shortfall",
  "txHashes",
  "startedAt",
  "completedAt",
  "amount",
  "txHash",
  "ledger",
  "principal",
  "interest",
];

export function toCsv(rows: Record<string, unknown>[], defaultColumns: string[] = REPORT_CSV_FALLBACK_COLUMNS): string {
  const headerSet = new Set<string>();
  if (rows.length === 0) {
    for (const col of defaultColumns) {
      headerSet.add(col);
    }
  } else {
    // Ensure 'kind' is always first if present in any row
    let hasKind = false;
    for (const row of rows) {
      if ("kind" in row) {
        hasKind = true;
        break;
      }
    }
    if (hasKind) {
      headerSet.add("kind");
    }

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        headerSet.add(key);
      }
    }
  }

  const headers = Array.from(headerSet);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => JSON.stringify(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

export function registerReportRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/reports/daily", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const { date, from: queryFrom, to: queryTo, format } = parsed.data;
    const from = date ?? queryFrom!;
    const to = queryTo ?? (date ? date : from);

    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T00:00:00.000Z`);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return reply.code(400).send({ error: "invalid date format" });
    }
    if (fromDate.getTime() > toDate.getTime()) {
      return reply.code(400).send({ error: "from date must be before or equal to to date" });
    }

    const diffMs = toDate.getTime() - fromDate.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;
    if (diffDays > 31) {
      return reply.code(400).send({ error: "date range must not exceed 31 days" });
    }

    const dayStart = fromDate;
    const dayEnd = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
    const inRange = (col: any) => and(gte(col, dayStart), lt(col, dayEnd));

    // The report covers the caller's own lines only. Price snapshots are public.
    const mine = new Set(
      (
        await db
          .select()
          .from(schema.creditLine)
          .where(or(eq(schema.creditLine.lenderId, request.partyId), eq(schema.creditLine.borrowerId, request.partyId)))
      ).map((l) => l.id),
    );
    const ownLines = <T extends { creditLineId: string }>(rows: T[]) => rows.filter((r) => mine.has(r.creditLineId));

    const [marginEventsAll, liquidationsAll, drawsAll, repaymentsAll, priceSnapshots] = await Promise.all([
      db.select().from(schema.marginEvent).where(inRange(schema.marginEvent.createdAt)),
      db.select().from(schema.liquidation).where(inRange(schema.liquidation.startedAt)),
      db.select().from(schema.draw).where(inRange(schema.draw.createdAt)),
      db.select().from(schema.repayment).where(inRange(schema.repayment.createdAt)),
      db.select().from(schema.priceSnapshot).where(inRange(schema.priceSnapshot.createdAt)),
    ]);
    const marginEvents = ownLines(marginEventsAll);
    const liquidations = ownLines(liquidationsAll);
    const draws = ownLines(drawsAll);
    const repayments = ownLines(repaymentsAll);

    const totalRows = marginEvents.length + liquidations.length + draws.length + repayments.length + priceSnapshots.length;
    const MAX_REPORT_ROWS = 10_000;
    if (totalRows > MAX_REPORT_ROWS) {
      return reply.code(413).send({ error: "report exceeds maximum allowed rows (10000)" });
    }

    const report = {
      date: from,
      from,
      to,
      marginEvents,
      liquidations,
      draws,
      repayments,
      priceSnapshots,
    };

    if (format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8");
      const filenameDate = from === to ? from : `${from}-to-${to}`;
      reply.header("content-disposition", `attachment; filename="ballast-daily-${filenameDate}.csv"`);
      return toCsv([
        ...marginEvents.map((e) => ({ kind: "margin_event", ...e })),
        ...liquidations.map((e) => ({ kind: "liquidation", ...e })),
        ...draws.map((e) => ({ kind: "draw", ...e })),
        ...repayments.map((e) => ({ kind: "repayment", ...e })),
      ]);
    }
    return report;
  });
}
