import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@ballast/db";

const priceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function latestSnapshotByAsset(snapshots: (typeof schema.priceSnapshot.$inferSelect)[]) {
  const byAsset = new Map<string, (typeof schema.priceSnapshot.$inferSelect)>();
  for (const snap of snapshots) {
    const existing = byAsset.get(snap.assetId);
    if (!existing || snap.createdAt > existing.createdAt) byAsset.set(snap.assetId, snap);
  }
  return byAsset;
}

export function registerAssetRoutes(app: FastifyInstance, db: Database): void {
  app.get("/v1/assets", { config: { public: true } }, async () => {
    const assets = await db.select().from(schema.asset);
    const snapshots = await db.select().from(schema.priceSnapshot);
    const latest = latestSnapshotByAsset(snapshots);

    return {
      assets: assets.map((asset) => {
        const snapshot = latest.get(asset.id);
        return {
          id: asset.id,
          code: asset.code,
          contractC: asset.contractC,
          ccy: asset.ccy,
          standard: asset.standard,
          custodyMode: asset.custodyMode,
          haircutBps: asset.haircutBaseBps + asset.haircutFxBps,
          status: asset.status,
          price: snapshot
            ? { value: snapshot.guardedValue, status: snapshot.status, asOf: snapshot.createdAt }
            : null,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/v1/assets/:id/price",
    { config: { public: true } },
    async (request, reply) => {
      const parsedQuery = priceQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply.code(400).send({ error: "invalid query parameters", issues: parsedQuery.error.issues });
      }
      const { limit, from, to } = parsedQuery.data;

      const [asset] = await db
        .select()
        .from(schema.asset)
        .where(eq(schema.asset.id, request.params.id))
        .limit(1);
      if (!asset) return reply.code(404).send({ error: "asset not found" });

      const conditions = [eq(schema.priceSnapshot.assetId, asset.id)];
      if (from) {
        conditions.push(gte(schema.priceSnapshot.createdAt, new Date(from)));
      }
      if (to) {
        conditions.push(lte(schema.priceSnapshot.createdAt, new Date(to)));
      }

      const history = await db
        .select()
        .from(schema.priceSnapshot)
        .where(and(...conditions))
        .orderBy(desc(schema.priceSnapshot.createdAt))
        .limit(limit);

      const [latest] = history;
      return {
        assetId: asset.id,
        status: latest?.status ?? "Halted",
        value: latest?.guardedValue ?? null,
        ts: latest?.createdAt ?? null,
        sources: latest?.sources ?? [],
        history,
      };
    },
  );
}
