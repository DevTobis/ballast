# services/margin-monitor

Polling worker that watches every open credit line and records when its margin state changes. It has no
HTTP surface and sends no transactions, so it needs no operator key.

Every poll it selects `credit_line` rows with status `open` and an on-chain `contract_line_id`, and for each
one calls `CreditLine.ltv` (a read-only simulation). The LTV and state (`Healthy`, `Warning`, `MarginCall`,
`Liquidation`, as the contract defines them) always come from the contract, never from off-chain arithmetic,
so they match what a real liquidation would use. The result is compared with the line's latest
`margin_event`; a line with no prior event counts as `Healthy`.

On a change it inserts a `margin_event` (`from_state`, `to_state`, `ltv_bps`, and the newest `price_snapshot`
for the first pledged asset of the line, if any) and logs it. Moving to `MarginCall` or `Liquidation` also
fires a `margin_call` alert. Recovering from an unhealthy state (`MarginCall` or `Liquidation`) back into
`Healthy` or `Warning` fires a `margin_recovered` alert. An unchanged state writes nothing. A failure on one
line is logged and the other lines are still checked.

## Timing and Cure Window Latency

### Detection Latency
The margin monitor runs a continuous polling loop (`MARGIN_MONITOR_POLL_MS`, default 15,000 ms / 15 seconds).
- **Worst-case detection latency**: `MARGIN_MONITOR_POLL_MS` + duration of the polling pass across all open credit lines.
- During quiet conditions, a collateral shortfall or price drop is detected within seconds of the price snapshot being published.

### Relationship to the Cure Window
The keeper's `cure-expiry` liquidation job explicitly uses the monitor's `margin_event.created_at` timestamp as the start of the borrower's cure clock (`breachStart = event.createdAt` in `services/keeper/src/jobs/cureExpiry.ts:94-98`):
- If the margin monitor is delayed, stopped, or experiencing slow poll passes, the `created_at` timestamp is recorded later than the true on-chain price breach.
- Consequently, **any monitor delay directly extends the effective cure window** afforded to the borrower before liquidation can be triggered on-chain.

### Choosing MARGIN_MONITOR_POLL_MS vs. cureWindowS
- Keep `MARGIN_MONITOR_POLL_MS` significantly smaller (e.g. 15–30 seconds) than contractual line cure windows (`cureWindowS`, typically hours or days).
- If poll duration grows as line volume scales, monitor metrics and tune `MARGIN_MONITOR_POLL_MS` to ensure detection lag remains a negligible fraction of `cureWindowS`.

## Alerts and Webhook Delivery

When a credit line transitions into `MarginCall` or `Liquidation`, the monitor fires a `margin_call` alert via `@ballast/observability`. Alerts are logged to stdout and posted as JSON to `ALERT_WEBHOOK_URL` (if configured).

### Sample Payload

```json
{
  "text": "[ballast/margin-monitor] margin_call (line-f47ac10b)",
  "content": "[ballast/margin-monitor] margin_call (line-f47ac10b)",
  "service": "margin-monitor",
  "kind": "margin_call",
  "context": {
    "creditLineId": "line-f47ac10b",
    "state": "MarginCall",
    "ltvBps": 8500
  },
  "at": "2026-10-15T12:00:00.000Z"
}
```

- `text`: Alert summary for Slack-compatible integrations.
- `content`: Alert summary for Discord-compatible integrations.
- `service`: `"margin-monitor"`.
- `kind`: `"margin_call"`.
- `context`:
  - `creditLineId`: The database UUID of the credit line.
  - `state`: The contract margin state (`"MarginCall"` or `"Liquidation"`).
  - `ltvBps`: The loan-to-value ratio in basis points (e.g. `8500` = 85.00%).
- `at`: ISO 8601 timestamp of alert generation.

### Cooldown and Deduplication Rule

- **Cooldown window**: Defined by `ALERT_COOLDOWN_S` (default `900` seconds / 15 minutes).
- **Dedupe key**: Formatted as `${kind}:${creditLineId}:${state}` (e.g. `margin_call:line-f47ac10b:MarginCall`).
- **Suppression**: Repeated alerts for the same line in the same state within the cooldown window are suppressed from webhook dispatch (always logged to console).
- **Escalation**: Because the target state is included in the dedupe key, a line escalating from `MarginCall` to `Liquidation` within 15 minutes generates a distinct key (`margin_call:line-f47ac10b:Liquidation`) and is delivered immediately without being suppressed by the previous warning (see [#53](https://github.com/DevTobis/ballast/issues/53)).

### Current Limitations

- **Summary Text Headline**: The outer `text` and `content` fields format as `[ballast/margin-monitor] margin_call (<creditLineId>)` and do not include the specific target state in the text string itself. Downstream consumers and notification parsers must inspect `context.state` (or `context.ltvBps`) to distinguish between an initial `MarginCall` and an urgent `Liquidation` escalation. The escalation itself is no longer swallowed by the cooldown, because the state is part of the dedupe key (#53).

## How it connects to the rest

- `services/api` has a webhook outbox that scans new `margin_event` rows and enqueues deliveries to
  subscribers. This service does not call the API.
- `services/keeper`'s `cure-expiry` job reads the latest `margin_event` to decide which lines to poke and
  liquidate, and counts the cure window from these rows' timestamps. This service never liquidates.
- `services/price-guard` writes the `price_snapshot` rows referenced by `margin_event`.

## Run

```
pnpm dev                                          # from the repo root, with every other service
pnpm --filter @ballast/service-margin-monitor dev # this service only (tsx watch)
pnpm --filter @ballast/service-margin-monitor build && pnpm --filter @ballast/service-margin-monitor start
```

The repo-root `.env` is loaded automatically.

## Environment

- `DATABASE_URL`: Postgres.
- `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`: network.
- `STELLAR_SIMULATION_SOURCE`: funded account the `ltv` simulation runs as. Required; it never signs.
- `CREDIT_LINE_CONTRACT_ID`: required; startup fails without it.
- `MARGIN_MONITOR_POLL_MS`: pause between polls, default `15000`. The next poll starts after the previous
  one finishes plus this pause.
- `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_S`: optional delivery of the `margin_call` alert; it is always logged.

## Source map

- `src/index.ts`: startup, the polling loop, per-line error handling.
- `src/monitor.ts`: `recomputeLine`, the read, compare and record step.

## Tests

`pnpm --filter @ballast/service-margin-monitor test` (vitest). `monitor.test.ts` uses a stubbed database
query chain, a stubbed `CreditLineClient` and a spy alerter. It covers: no write when the state is
unchanged; a `margin_event` plus alert on the move to `MarginCall`; a first event treated as coming from
`Healthy`. The polling loop in `index.ts` is not covered. Test doubles live only in `*.test.ts`; `src` has
no mock data.

## Does not

- Subscribe to price updates or chain events: it polls, so a state change is seen up to one interval late
  (a code comment calls polling a stand-in until the indexer's `chain_event` stream can drive it).
- Record a repeat of the same state, or distinguish a changed LTV within a state.
- Check repo trades: repo margin is handled by `services/keeper`'s `repo-margin` job.
- Send webhooks or call `liquidate`.
