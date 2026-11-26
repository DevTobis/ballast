# services/indexer

Mirrors Soroban contract events into Postgres. It polls Stellar RPC `getEvents` for every Ballast
contract and writes one `chain_event` row per event. That is all it does: it does not interpret the
events. The only reader of `chain_event` in this repo today is `services/ledger`, which uses the
pledge events in its nightly reconciliation.

## What it talks to

- **Stellar RPC** (`getHealth`, `getLatestLedger`, `getEvents`), through `@stellar/stellar-sdk`.
- **Postgres**: reads `max(chain_event.ledger)` and inserts into `chain_event`.
- **Contracts watched**: every id `loadNetworkConfig()` returns, i.e. `REGISTRY`, `PRICE_GUARD`,
  `PLEDGE_VAULT`, `CREDIT_LINE`, `EXIT_DESK`, `REPO_DVP` and `USDC_SAC` `_CONTRACT_ID`. Unset ids are
  skipped; with none set it logs a warning and fetches nothing.

## How it polls

Each cycle resumes from the previous cycle's scanned ledger cursor + 1 (or `max(ledger) + 1` from
the database on initial startup; on an empty table it starts `1000` ledgers behind the latest).
Contract ids are split into filters of at most 5 (the RPC's limit), and pages of 100 are drained
before the cycle ends. Rows carry the RPC event id, which has a unique index, so re-reading a range
inserts nothing twice. `data` holds `{ topics, value }` decoded with `scValToNative`, with bigints
stored as strings. RPC calls are retried 4 times with exponential backoff.

If the resume cursor is older than the RPC retention window (`getHealth().oldestLedger`), `pollOnce`
clamps `startLedger` to that oldest ledger and reports the skipped range as `skippedFrom`/`skippedTo`.
`runIndexerCycle` fires an `event_gap_skipped` alert for it and the poll loop logs the range at warn
level. Those events are gone, but the cursor advances instead of retrying the same rejected request
forever.

If the chain tip is more than `INDEXER_LAG_ALERT_SECONDS / 5` ledgers ahead of what has been scanned,
it fires an `rpc_lag_high` alert (logged, and posted to `ALERT_WEBHOOK_URL` if set). Because lag is
computed from the scanned ledger cursor rather than event rows, quiet periods on chain emit no false lag
alerts. A failed cycle is logged and retried on the next tick. It stops after the current cycle on `SIGTERM`.

## Monitoring

### Metrics

| Metric | Type | Labels / Context | Purpose |
|---|---|---|---|
| `indexer.events_ingested` | counter | `{ count }` | Count of decoded contract events written to `chain_event` in each cycle. |
| `indexer.latest_ledger` | gauge | `latestLedger` | The latest ledger sequence observed from the RPC node during the cycle. |
| `indexer.events_gap_skipped` | counter | `{ from, to }` | Incremented when the resume point is older than the RPC retention window and a ledger range is skipped (also recorded in `chain_event_gap`). |

### Alerts

Alerts are fired via `@ballast/observability` and sent to `ALERT_WEBHOOK_URL` when configured:

- **`rpc_lag_high`**: Fired when the difference between the RPC chain tip and the last scanned ledger exceeds `LAG_ALERT_LEDGERS` (derived from `INDEXER_LAG_ALERT_SECONDS / 5`, default 12 ledgers for 60 seconds).
  - **Context fields**:
    - `lagLedgers`: Number of ledgers the indexer is behind the chain tip (`rpcTip - lastScannedLedger`).
    - `latestLedger`: Current ledger sequence of the RPC tip.
    - `lastScannedLedger`: Sequence of the last ledger successfully scanned by the indexer.
    - `lastIngestedFrom`: Alias for `lastScannedLedger`.
- **`event_gap_skipped`**: Fired when the indexer's resume cursor is older than the RPC node's retention window (`getHealth().oldestLedger`).
  - **Context fields**:
    - `fromLedger`: The first ledger in the unrecoverable skipped range.
    - `toLedger`: The last skipped ledger (`oldestLedger - 1`). Events in this range must be recovered with a data-lake backfill.

### Lag Semantics and Caveats

- **Scanned cursor vs. event rows**: Lag is computed against the scanned ledger sequence (`state.lastScannedLedger` in memory and persisted in `indexer_cursor`), **not** the ledger of the latest ingested event row. On quiet chains where contracts produce no events for long periods, `lastScannedLedger` continues to advance with each cycle, avoiding false `rpc_lag_high` alerts (fixed in #62; before that, lag was measured from the last event row and fired whenever the chain was quiet).
- **Cold start / gap catch-up caveat**: On an initial cold start with an empty database or after a prolonged downtime, the indexer resumes scanning from `latestLedger - 1000` (or `max(ledger) + 1`). During the initial catch-up window until it reaches the tip, `rpc_lag_high` may fire until the backlog is drained.

## Run

```
pnpm --filter @ballast/service-indexer dev      # tsx watch, loads the repo-root .env
pnpm --filter @ballast/service-indexer build && pnpm --filter @ballast/service-indexer start
```

### Backfill CLI

Validate and plan a historical ledger backfill range:

```bash
pnpm --filter @ballast/service-indexer backfill --from <start> --to <end> [--source rpc|lake]
```

- `--from`: positive integer start ledger.
- `--to`: positive integer end ledger (`to >= from`).
- `--source`: `rpc` (default) or `lake`. `--source lake` clearly reports not implemented.

`pnpm dev` at the root starts it with the other services. Migrations must already be applied
(`pnpm db:migrate`).

## Environment

| variable | purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `STELLAR_RPC_URL`, `STELLAR_NETWORK`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE` | network, via `@ballast/network-config` |
| `*_CONTRACT_ID` (seven, above) | which contracts to watch |
| `INDEXER_POLL_INTERVAL_MS` | pause between cycles (default `5000`) |
| `INDEXER_LAG_ALERT_SECONDS` | lag before `rpc_lag_high` fires (default `60`) |
| `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_S` | optional alert delivery |

The two `INDEXER_*` variables are not listed in `.env.example`.

## Source map

- `src/index.ts`: poll loop, contract list, lag alert.
- `src/poller.ts`: `pollOnce`, cursor logic, event decoding, insert.
- `src/rpc.ts`: `RpcClient` seam over `rpc.Server`, and `withRetry`.
- `src/backfill.ts`: `backfillFromDataLake`, a stub that throws.

## Tests

`pnpm --filter @ballast/service-indexer test` (vitest, no network or database; both are faked).
Covers cold start at `latest - 1000`, the 5-contract filter split, warm start at `max(ledger) + 1`
with one row per event, cursor resumption without database queries, clamping a cursor older than the
RPC retention window against a fake RPC that rejects out-of-range start ledgers, quiet-chain lag
immunity, lag and event-gap alert firing, and `withRetry` success and exhaustion.

## Known limits

- Stellar RPC keeps about 7 days of events. A longer outage used to wedge the indexer on a rejected
  `startLedger`; it now clamps to the oldest retained ledger and fires `event_gap_skipped`, but the
  events in the skipped range are still lost. `backfillFromDataLake` is not implemented and nothing
  calls it, so a fresh database on an old deployment has the same gap.
- Cold start reads only the last 1000 ledgers (roughly 80 minutes).
- Nothing else consumes `chain_event` for live decisions yet; `services/margin-monitor` still polls.
