import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { z } from "zod";

const querySchema = z.object({ party: z.string().uuid() });

export function registerPositionRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/positions", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "party query param is required" });
    const { party } = parsed.data;

    const creditLines = await db
      .select()
      .from(schema.creditLine)
      .where(or(eq(schema.creditLine.borrowerId, party), eq(schema.creditLine.lenderId, party)));

    const pledges =
      creditLines.length > 0
        ? (
            await Promise.all(
              creditLines.map((line) =>
                db.select().from(schema.pledge).where(eq(schema.pledge.creditLineId, line.id)),
              ),
            )
          ).flat()
        : [];

    const exitQuotes = await db.select().from(schema.exitQuote).where(eq(schema.exitQuote.holderId, party));

    const repoTrades = await db
      .select()
      .from(schema.repoTrade)
      .where(or(eq(schema.repoTrade.cashLenderId, party), eq(schema.repoTrade.cashBorrowerId, party)));

    return { party, creditLines, pledges, exitQuotes, repoTrades };
  });
}
