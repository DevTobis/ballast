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
  | "reconciliation_break"
  | "rpc_lag_high";

export interface Alerter {
  fire(kind: AlertKind, context: Record<string, unknown>): void;
}

export function createConsoleAlerter(service: string): Alerter {
  return {
    fire(kind, context) {
      console.error(`[alert] ${service} ${kind}`, context);
    },
  };
}
