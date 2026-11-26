# @ballast/observability

Logging, metrics and alerting shared by all services, so each one wires them up the same way.

## Exports

- `createLogger(service)`: a pino logger named for the service; level from `LOG_LEVEL` (default
  `info`). `Logger` is its type.
- `MetricsSink` and `createConsoleMetricsSink(service)`: `increment`, `gauge` and `timing`, printed to
  the console. The interface exists so a real backend can replace it without touching call sites.
- `createAlerter(service, options?)`, `createConsoleAlerter(service)`, `Alerter`, `AlertKind`: `fire`
  logs to stderr and, when `ALERT_WEBHOOK_URL` is set, also POSTs JSON (`text`, `content`, `kind`,
  `context`) so Slack and Discord both render it. The alert kinds are `price_degraded`,
  `price_halted`, `margin_call`, `keeper_balance_low`, `operator_balance_low`,
  `reconciliation_break`, `event_gap_skipped` and `rpc_lag_high`.
- `checkOperatorBalance(alerter, { horizonUrl, account, label, minXlm? })` and `nativeBalanceXlm`:
  fire `operator_balance_low` when an operator account holds less than `OPERATOR_MIN_XLM` (default
  `DEFAULT_MIN_XLM`, 20).

## Who imports it

`services/api`, `price-guard`, `indexer`, `margin-monitor`, `keeper`, `issuer-gateway`, `payout-hop`
and `ledger`.

## Build and test

`pnpm --filter @ballast/observability build`, `typecheck` and `test`. Tests in `src/__tests__/` cover
the alerter and the balance check with an injected `fetch`.

## Gotchas

- The alerter repeats the same alert for the same subject at most once per cooldown
  (`ALERT_COOLDOWN_S`, default 900). The subject is the first of `assetId`, `code`, `creditLineId` or
  `line` in the context, so alerts about different assets do not suppress each other.
- A failing webhook never throws into the caller; the console line is the record that always exists.
  Webhook requests time out after 5 s.
- `nativeBalanceXlm` returns 0 for an account Horizon does not know (404) but throws on any other
  failure. `checkOperatorBalance` logs that failure and returns null rather than reporting a low
  balance.
- Rebuilding `dist/` restarts `pnpm dev` services.
