import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";

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
      const [asset] = await db
        .select()
        .from(schema.asset)
        .where(eq(schema.asset.id, request.params.id))
        .limit(1);
      if (!asset) return reply.code(404).send({ error: "asset not found" });

      const history = await db
        .select()
        .from(schema.priceSnapshot)
        .where(eq(schema.priceSnapshot.assetId, asset.id))
        .orderBy(desc(schema.priceSnapshot.createdAt))
        .limit(50);

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
