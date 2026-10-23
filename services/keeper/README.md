# services/keeper

Scheduled worker that submits the transactions nobody else is going to send: collateral reconciliation,
interest accrual, cure-window liquidation, and repo margin and unwind. It has no HTTP surface. Every
transaction is signed by one operator account (the `keeper` role of `@ballast/operator-signing`).

It talks to three contracts through `@ballast/contract-clients` (`CreditLine`, `PledgeVault`, `RepoDvp`)
and to Postgres through `@ballast/db`. It reads `margin_event` rows written by `services/margin-monitor`
but does not call that service.

## Jobs

| job | default schedule | what it does |
|---|---|---|
| `sync-collateral` | every minute | For each open line, compares `CreditLine`'s pledged units with what `PledgeVault` holds and pushes the vault's figure if they differ. Never derives it from Postgres. Submits nothing for a line already in step. |
| `cure-expiry` | `*/5 * * * *` | For open lines whose latest `margin_event` is `MarginCall` or `Liquidation`: re-reads LTV from the contract, `poke`s to arm the breach flag, and once the cure window has run out calls `CreditLine.liquidate` then `PledgeVault.liquidate` (collateral goes to the lender). Books `pledge`, `liquidation` and `credit_line` rows. A line only in `MarginCall` is never liquidated. |
| `interest-accrual` | hourly (`0 * * * *`) | `poke`s every open line that has an on-chain id. |
| `repo-margin` | `*/5 * * * *` | For settled repo trades: `call_margin` when collateral stops covering exposure, `call_margin` again to clear a cured call, `default_close` after the cure deadline. Records `repo_margin_call` rows. Skips a trade whose guarded price is not usable. |
| `repo-unwind` | `*/5 * * * *` | `RepoDvp.unwind` for settled trades past maturity; records status and `leg2_tx` on `repo_trade`. |
| balance check | `7 * * * *` | Alerts when the keeper account's XLM balance is low. |

Jobs run one at a time through a shared queue, because they share one account and its sequence number.
Each job returns `{ processed, skipped, errors }`; a failing row is logged and does not stop the rest.
Liquidation and margin steps are written to be safe to repeat after a crash.

## Replica Behaviour and Advisory Locking

All keeper jobs sign with a single operator account and need sequential transaction sequence numbers. To prevent duplicate submissions, race conditions, or `tx_bad_seq` errors across multiple replicas (e.g. `--scale keeper=2` or during rolling restarts):

- Each tick acquires a session-level Postgres advisory lock (`pg_try_advisory_lock`) on a dedicated connection.
- If another keeper instance holds the lock, the tick is logged and skipped.
- When the job finishes, the lock is released. If an instance crashes or disconnects, Postgres automatically releases the advisory lock.
- `KEEPER_LOCK_SCOPE`: controls locking granularity:
  - `job` (default): lock key is `hashtext('keeper:' || name)`, allowing different jobs to run while locking out duplicates of the same job.
  - `global`: lock key is `hashtext('keeper:global')`, ensuring strict single-job execution across the entire cluster.

### Storage TTL Maintenance

Soroban persistent storage entries archive if not extended. `CreditLine::extend_ttl(line)` is an unauthenticated contract entry point that extends instance and persistent entry TTLs (`Line`, `Claimable`, `Liquidation`). Keepers or periodic tasks can call this for dormant lines to ensure they remain accessible without requiring restoration.

## Run

```
pnpm dev                                    # from the repo root, with every other service
pnpm --filter @ballast/service-keeper dev   # this service only (tsx watch)
pnpm --filter @ballast/service-keeper build && pnpm --filter @ballast/service-keeper start
```

The repo-root `.env` is loaded automatically. `scripts/dev-setup.sh` writes one and sets the cure-expiry,
repo-unwind and repo-margin schedules to every minute for local work.

## Environment

- `DATABASE_URL`: Postgres.
- `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`: network.
- `STELLAR_SIMULATION_SOURCE`: funded account used for read-only contract simulations (`ltv`, `margin_view`).
- `CREDIT_LINE_CONTRACT_ID`, `PLEDGE_VAULT_CONTRACT_ID`, `REPO_DVP_CONTRACT_ID`: required; startup fails without them.
- `KEEPER_SIGNER_MODE`: `local` (default), `vault` or `kms-envelope`. `local` reads `KEEPER_SECRET_KEY` and
  is refused when `NODE_ENV=production`. Vault and KMS variables (`VAULT_*`, `KEEPER_VAULT_KEY_NAME`,
  `AWS_REGION`, `KEEPER_KMS_KEY_ID`, `KEEPER_WRAPPED_SECRET`) are listed in `.env.example`.
- `KEEPER_SYNC_COLLATERAL_CRON`, `KEEPER_CURE_EXPIRY_CRON`, `KEEPER_REPO_UNWIND_CRON`,
  `KEEPER_REPO_MARGIN_CRON`, `KEEPER_INTEREST_ACCRUAL_CRON`, `KEEPER_BALANCE_CRON`: cron overrides.
- `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_S`, `OPERATOR_MIN_XLM`: low-balance alert delivery and threshold.

## Source map

- `src/index.ts`: wiring, cron registration, the serial job queue, balance check.
- `src/jobs/syncCollateral.ts`, `cureExpiry.ts`, `interestAccrual.ts`, `repoMargin.ts`, `repoUnwind.ts`: one file per job.
- `src/jobs/types.ts`: the shared `JobResult` shape.

## Tests

`pnpm --filter @ballast/service-keeper test` (vitest). Each job has a `*.test.ts` that runs it against
`vi.fn` stubs for the database query chain, contract clients and signer (`submitSignedTx` is mocked). They cover: skipping lines and trades
with no on-chain id; the arm-then-liquidate ordering and cure-window timing in `cure-expiry`; resuming
a half-finished liquidation; refusing to liquidate while the vault and credit line disagree; opening,
clearing and defaulting repo margin calls; error handling per row. Nothing touches a network.

## Does not

- Compute LTV or margin state itself: it asks the contracts, and it relies on `services/margin-monitor`
  to have recorded the unhealthy state before `cure-expiry` acts.
- Liquidate a line that has not reached the liquidation threshold, or one whose price status is not `Ok`.
- Retry a failed row within a run; the next scheduled run picks it up.
- Use mock data: test doubles live only in `*.test.ts` (`scripts/check-no-mocks.sh` is a CI tripwire for known regressions).
