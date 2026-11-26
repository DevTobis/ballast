/**
 * Webhook subscription management. A party registers an https endpoint and the events it wants;
 * the signing secret is returned once, at creation, and never again. Everything is scoped to the
 * calling party (`request.partyId`), so one party cannot read or change another's subscriptions.
 */
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@ballast/db";
import { DELIVERABLE_WEBHOOK_EVENTS } from "@ballast/domain-types";
import type { ApiConfig } from "../config.js";
import { encryptSecret, isValidSecretKey } from "../webhooks/secretBox.js";
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from "../webhooks/ssrf.js";

const MAX_SUBSCRIPTIONS_PER_PARTY = 10;

const createSchema = z.object({
  url: z.string().min(1).max(2048),
  events: z.array(z.enum(DELIVERABLE_WEBHOOK_EVENTS)).min(1),
});

export function registerWebhookRoutes(app: FastifyInstance, db: Database, config: ApiConfig): void {
  const allowHttp = process.env.NODE_ENV !== "production";

  app.get("/v1/webhooks/events", async () => ({ events: DELIVERABLE_WEBHOOK_EVENTS }));

  app.post("/v1/webhooks/subscriptions", async (request, reply) => {
    if (!isValidSecretKey(config.webhookSecretKey)) {
      return reply.code(503).send({ error: "webhooks are not configured on this deployment" });
    }
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });

    try {
      await assertSafeWebhookUrl(parsed.data.url, { allowHttp });
    } catch (err) {
      if (err instanceof UnsafeWebhookUrlError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const mine = await db
      .select()
      .from(schema.webhookSubscription)
      .where(eq(schema.webhookSubscription.partyId, request.partyId));
    if (mine.filter((s) => s.active).length >= MAX_SUBSCRIPTIONS_PER_PARTY) {
      return reply.code(409).send({ error: `at most ${MAX_SUBSCRIPTIONS_PER_PARTY} active subscriptions per party` });
    }

    const secret = randomBytes(32).toString("hex");
    const [row] = await db
      .insert(schema.webhookSubscription)
      .values({
        partyId: request.partyId,
        url: parsed.data.url,
        events: [...new Set(parsed.data.events)],
        secretCiphertext: encryptSecret(secret, config.webhookSecretKey),
      })
      .returning();

    return reply.code(201).send({ id: row.id, url: row.url, events: row.events, secret });
  });

  app.get("/v1/webhooks/subscriptions", async (request) => {
    const rows = await db
      .select()
      .from(schema.webhookSubscription)
      .where(eq(schema.webhookSubscription.partyId, request.partyId));
    return {
      subscriptions: rows
        .filter((s) => s.active)
        .map((s) => ({ id: s.id, url: s.url, events: s.events, createdAt: s.createdAt })),
    };
  });

  app.delete<{ Params: { id: string } }>("/v1/webhooks/subscriptions/:id", async (request, reply) => {
    const [sub] = await db
      .select()
      .from(schema.webhookSubscription)
      .where(
        and(
          eq(schema.webhookSubscription.id, request.params.id),
          eq(schema.webhookSubscription.partyId, request.partyId),
        ),
      )
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "subscription not found" });
    // Deactivated, not deleted: its deliveries (and dead letters) keep their history.
    await db
      .update(schema.webhookSubscription)
      .set({ active: false })
      .where(eq(schema.webhookSubscription.id, sub.id));
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/v1/webhooks/subscriptions/:id/deliveries", async (request, reply) => {
    const [sub] = await db
      .select()
      .from(schema.webhookSubscription)
      .where(
        and(
          eq(schema.webhookSubscription.id, request.params.id),
          eq(schema.webhookSubscription.partyId, request.partyId),
        ),
      )
      .limit(1);
    if (!sub) return reply.code(404).send({ error: "subscription not found" });
    const rows = await db
      .select()
      .from(schema.webhookDelivery)
      .where(eq(schema.webhookDelivery.subscriptionId, sub.id))
      .orderBy(desc(schema.webhookDelivery.createdAt))
      .limit(50);
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        createdAt: d.createdAt,
        deliveredAt: d.deliveredAt,
      })),
    };
  });

  /** Puts a dead-lettered delivery back in the queue. */
  app.post<{ Params: { id: string } }>("/v1/webhooks/deliveries/:id/redeliver", async (request, reply) => {
    const [delivery] = await db
      .select()
      .from(schema.webhookDelivery)
      .where(eq(schema.webhookDelivery.id, request.params.id))
      .limit(1);
    const [sub] = delivery
      ? await db
          .select()
          .from(schema.webhookSubscription)
          .where(eq(schema.webhookSubscription.id, delivery.subscriptionId))
          .limit(1)
      : [];
    // Same answer for "no such delivery" and "someone else's delivery": don't confirm it exists.
    if (!delivery || !sub || sub.partyId !== request.partyId) {
      return reply.code(404).send({ error: "delivery not found" });
    }
    if (!sub.active) return reply.code(409).send({ error: "subscription is inactive" });
    if (delivery.status !== "dead") return reply.code(409).send({ error: `delivery is ${delivery.status}` });
    const updated = await db
      .update(schema.webhookDelivery)
      .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(and(eq(schema.webhookDelivery.id, delivery.id), eq(schema.webhookDelivery.status, "dead")))
      .returning({ id: schema.webhookDelivery.id });
    if (updated.length === 0) {
      return reply.code(409).send({ error: "delivery is not dead" });
    }
    return reply.code(202).send({ id: delivery.id, status: "pending" });
  });
}
