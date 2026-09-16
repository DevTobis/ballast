/** The webhook event names from PRD §9, HMAC-signed and retried with backoff. */
export type WebhookEvent =
  | "price.status_changed"
  | "margin.state_changed"
  | "margin.call_issued"
  | "margin.cured"
  | "liquidation.started"
  | "liquidation.completed"
  | "exit.filled"
  | "repo.leg1_settled"
  | "repo.unwind_due"
  | "repo.defaulted";

export interface WebhookPayload<T = unknown> {
  event: WebhookEvent;
  occurredAt: string;
  data: T;
}
