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

## Run

```
pnpm --filter @ballast/service-indexer dev      # tsx watch, loads the repo-root .env
pnpm --filter @ballast/service-indexer build && pnpm --filter @ballast/service-indexer start
```

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
