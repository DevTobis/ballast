import type { FastifyInstance } from "fastify";
import { and, gte, lt } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  format: z.enum(["json", "csv"]).default("json"),
});

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
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
    const { date, format } = parsed.data;
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const inDay = (col: any) => and(gte(col, dayStart), lt(col, dayEnd));

    const [marginEvents, liquidations, draws, repayments, priceSnapshots] = await Promise.all([
      db.select().from(schema.marginEvent).where(inDay(schema.marginEvent.createdAt)),
      db.select().from(schema.liquidation).where(inDay(schema.liquidation.startedAt)),
      db.select().from(schema.draw).where(inDay(schema.draw.createdAt)),
      db.select().from(schema.repayment).where(inDay(schema.repayment.createdAt)),
      db.select().from(schema.priceSnapshot).where(inDay(schema.priceSnapshot.createdAt)),
    ]);

    const report = { date, marginEvents, liquidations, draws, repayments, priceSnapshots };

    if (format === "csv") {
      reply.header("content-type", "text/csv");
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
