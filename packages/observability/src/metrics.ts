/**
 * A minimal metrics interface so services don't hardcode a vendor. The console exporter is the
 * local-dev default; a real deployment swaps in a Prometheus/Datadog-backed implementation
 * without touching call sites.
 */
export interface MetricsSink {
  increment(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  timing(name: string, ms: number, tags?: Record<string, string>): void;
}

export function createConsoleMetricsSink(service: string): MetricsSink {
  const tag = (tags?: Record<string, string>) => (tags ? JSON.stringify(tags) : "");
  return {
    increment(name, tags) {
      console.log(`[metrics] ${service} ${name} +1 ${tag(tags)}`);
    },
    gauge(name, value, tags) {
      console.log(`[metrics] ${service} ${name}=${value} ${tag(tags)}`);
    },
    timing(name, ms, tags) {
      console.log(`[metrics] ${service} ${name} ${ms}ms ${tag(tags)}`);
    },
  };
}

/** The alert conditions named explicitly in PRD §11. */
export type AlertKind =
  | "price_degraded"
  | "price_halted"
  | "margin_call"
  | "keeper_balance_low"
  | "operator_balance_low"
  | "reconciliation_break"
  | "rpc_lag_high"
  | "payout_unbooked";

export interface Alerter {
  fire(kind: AlertKind, context: Record<string, unknown>): void;
}

export interface AlerterOptions {
  /** Where to POST alerts (Slack/Discord/generic JSON). Defaults to `ALERT_WEBHOOK_URL`; unset means console only. */
  webhookUrl?: string;
  /** Don't repeat the same alert for the same subject within this long. Defaults to `ALERT_COOLDOWN_S` or 15 minutes. */
  cooldownMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

const jsonSafe = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/**
 * Logs every alert and, when a webhook is configured, posts it there too. A condition that stays
 * true (a price that stays Degraded fires every cycle) is sent once per cooldown per subject, so a
 * channel gets one message about it, not one a minute. A failing webhook never throws into the
 * service that raised the alert: the console line is the record that always exists.
 */
export function createAlerter(service: string, options: AlerterOptions = {}): Alerter {
  const env = options.env ?? process.env;
  const webhookUrl = options.webhookUrl ?? env.ALERT_WEBHOOK_URL;
  const cooldownMs = options.cooldownMs ?? Number(env.ALERT_COOLDOWN_S ?? 900) * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, number>();

  return {
    fire(kind, context) {
      console.error(`[alert] ${service} ${kind}`, context);
      if (!webhookUrl) return;

      // The subject is whichever identifier the alert names; alerts about different assets or
      // lines must not suppress each other. State is included when present so state escalations
      // (e.g. MarginCall -> Liquidation) are not swallowed by the cooldown.
      const baseSubject = String(context.subject ?? context.assetId ?? context.code ?? context.creditLineId ?? context.line ?? "");
      const stateSuffix = typeof context.state === "string" ? `:${context.state}` : "";
      const subject = baseSubject;
      const key = `${kind}:${subject}${stateSuffix}`;
      const at = now();
      const previous = lastSent.get(key);
      if (previous !== undefined && at - previous < cooldownMs) return;
      lastSent.set(key, at);

      const detail = typeof context.reason === "string" ? ` - ${context.reason}` : "";
      const text = `[ballast/${service}] ${kind}${subject ? ` (${subject})` : ""}${detail}`;
      // `text` is what Slack shows and `content` what Discord shows; the rest is for anything parsing it.
      const body = JSON.stringify({ text, content: text, service, kind, context, at: new Date(at).toISOString() }, jsonSafe);
      void fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      }).then(
        (res) => {
          if (!res.ok) console.error(`[alert] ${service}: webhook responded ${res.status}`);
        },
        (err) => console.error(`[alert] ${service}: webhook failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
  };
}

/** Same alerter, named for where it has always been used. Posts to the webhook when one is set. */
export function createConsoleAlerter(service: string): Alerter {
  return createAlerter(service);
}
