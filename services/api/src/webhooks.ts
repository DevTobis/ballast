import { createHmac } from "node:crypto";
import type { WebhookEvent, WebhookPayload } from "@ballast/domain-types";
import type { Logger } from "@ballast/observability";
import type { ApiConfig } from "./config.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fires a webhook to every configured subscriber, HMAC-signing the body (`X-Ballast-Signature`)
 * and retrying with exponential backoff (3 attempts: immediate, then ~500ms, ~1000ms).
 *
 * Gap (documented, follow-up): subscriber URLs come from the static `WEBHOOK_SUBSCRIBERS` env
 * var (comma-separated), not a real per-party subscription-management API — every event goes to
 * every subscriber, with no per-event-type filtering or per-tenant scoping yet.
 */
export async function dispatchWebhook(
  config: Pick<ApiConfig, "webhookHmacSecret" | "webhookSubscribers">,
  event: WebhookEvent,
  data: unknown,
  logger?: Pick<Logger, "warn" | "error">,
): Promise<void> {
  const payload: WebhookPayload = { event, occurredAt: new Date().toISOString(), data };
  const body = JSON.stringify(payload);
  const signature = sign(config.webhookHmacSecret, body);

  await Promise.all(
    config.webhookSubscribers.map((url) => deliverWithRetry(url, body, signature, logger)),
  );
}

async function deliverWithRetry(
  url: string,
  body: string,
  signature: string,
  logger?: Pick<Logger, "warn" | "error">,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ballast-signature": signature,
        },
        body,
      });
      if (res.ok) return;
      throw new Error(`webhook POST ${url} responded ${res.status}`);
    } catch (err) {
      logger?.warn?.({ url, attempt, err }, "webhook delivery attempt failed");
      if (attempt === MAX_ATTEMPTS) {
        logger?.error?.({ url, err }, "webhook delivery exhausted retries");
        return;
      }
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
