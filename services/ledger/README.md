# services/ledger

Nightly reconciliation of Postgres against the indexed chain log, plus the double-entry journal
helpers. A mismatch is logged, alerted, and stored; it does not change any data.

## What it does

`runReconciliation` (`src/reconcile.ts`) reads `asset`, `pledge`, `chain_event` and `journal_entry`
in full and, for each asset, compares:

- Postgres: the sum of `pledge.units` where `status = 'active'`;
- chain proxy: the net of `pledged` (+) and `released` / `liquidated` (-) rows in `chain_event` whose
  decoded body `[asset, units, ...]` names that asset's `contract_c`. These events are emitted by
  `contracts/pledge-vault` and stored by `services/indexer`.

A difference above 100 raw units (1e-7 of a unit each) counts as a break. Every run inserts a
`reconciliation_run` row (`scope = 'nightly'`, break count, JSON report). With any break it fires a
`reconciliation_break` alert (always logged; posted to `ALERT_WEBHOOK_URL` if set). The report also
lists debit, credit and net per `journal_entry` account; that part is informational only.

`src/index.ts` schedules this with `node-cron`, default `0 2 * * *`, using the server's timezone.

`src/journal.ts` only re-exports `recordJournalEntry` and `recordDoubleEntry` from `@ballast/db`, which
enforce that each row is exactly one debit or one credit and that a double entry is balanced and
atomic. `services/payout-hop` calls the db package directly.

## Run

```
pnpm --filter @ballast/service-ledger dev      # tsx watch, loads the repo-root .env
pnpm --filter @ballast/service-ledger build && pnpm --filter @ballast/service-ledger start
```

### Reconcile CLI (run-once)

Run an on-demand reconciliation check immediately without starting the scheduler (useful for CI, drills, and incident investigation):

```bash
pnpm --filter @ballast/service-ledger reconcile
# or via compiled dist:
node dist/cli.js
```

The command prints the full reconciliation report JSON to stdout and exits with code 1 if `breaks > 0` (or 0 if fully in balance).

`pnpm dev` at the root starts it with the rest. To adjust the nightly schedule, set `LEDGER_RECONCILIATION_CRON` (e.g. `* * * * *`).

## Environment

| variable | purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `LEDGER_RECONCILIATION_CRON` | schedule (default `0 2 * * *`); not in `.env.example` |
| `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_S` | optional alert delivery |

## Source map

- `src/index.ts`: cron schedule (not started when `VITEST=true`).
- `src/reconcile.ts`: `runReconciliation`, report shape, tolerance.
- `src/journal.ts`: re-export of the db journal helpers.

## Tests

`pnpm --filter @ballast/service-ledger test` (vitest, fake database, no Postgres). Covers: zero breaks
when pledges match the events, a break plus the `reconciliation_break` alert on a deliberate mismatch,
the tolerance band, and the journal rules (balanced pair in one go, non-positive amount rejected, a row
that is both or neither debit and credit rejected).

## Known limits

The report says this itself under `scope.deferred`:

- It compares against our own `chain_event` log, not a fresh read of contract storage, so it is only as
  complete as the indexer. A gap in `chain_event` shows up as a break on pledges that are in fact fine.
- Only RWA pledge units are reconciled. Credit-line USDC, repo trades and exit fills are not.
- All four tables are loaded into memory on each run.
