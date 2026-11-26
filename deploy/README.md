# Deploying Ballast

`docker-compose.prod.yml` runs the price layer on one host: Postgres, a one-shot migration, the API,
the price-guard publisher, the indexer, and Caddy serving the console and terminating TLS (certificates
are fetched and renewed automatically).

```
cp deploy/.env.prod.example deploy/.env.prod        # fill it in
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build
```

Add `--profile lending` for the keeper, margin monitor and ledger once the lending contracts exist.

## Deployment Constraints

### Keeper: Single Instance Only
- **Constraint**: Run exactly **one** instance of the `keeper` service per operator signing account (`--scale keeper=1`).
- **Why**: The keeper signs on-chain transactions using a single operator key. Concurrent instances attempting to sign at the same time cause sequence number collisions (`txBadSeq`), redundant gas fees, and race conditions leading to duplicate liquidation bookings.
- **Restarts**: Deployments must use a **stop-before-start** strategy rather than overlapping rolling updates. The compose file configures `stop_grace_period: 70s` so in-flight keeper jobs can finish before shutdown.
- **Advisory locks**: Postgres advisory locks (`pg_try_advisory_lock`) are used internally to prevent concurrent job runs if an overlap occurs, but scaling replicas is unsupported. See `services/keeper/README.md`.

## Before the first start

1. **Run the shadow run first** (`scripts/shadow-run.sh`, or `PRICE_GUARD_PUBLISH=false` here) for a week
   or two and read the divergence and staleness in Postgres.
2. **Deploy the on-chain price layer** with `scripts/deploy-mainnet-prices.sh` (it previews with
   `--dry-run`, refuses to run without `CONFIRM_MAINNET=deploy-prices`, and never creates keys). Copy the
   ids from `.env.mainnet-deploy` into `.env.prod`.
3. **Keys.** The price publisher and keeper sign with Vault Transit (AppRole) or AWS KMS; the local
   raw-secret mode throws under `NODE_ENV=production`. The publisher account needs a little XLM; the
   services alert when it runs low (`OPERATOR_MIN_XLM`).
   The API's own secrets (`JWT_SIGNING_SECRET`, `SEP10_SERVER_SECRET`, `WEBHOOK_SECRET_KEY`,
   `API_KEY_SECRET_KEY`) can instead be mounted as files and named with `<NAME>_FILE`
   (e.g. `JWT_SIGNING_SECRET_FILE=/run/secrets/jwt`), the Docker/Kubernetes secrets convention, so
   they never appear in the container's environment.
4. **DNS** for `API_DOMAIN` and `CONSOLE_DOMAIN` must point at this host and ports 80/443 must be open
   before Caddy starts, or certificate issuance fails.
5. **Seed the asset table** once the stack is up (see the next section); without it nothing is published.

## Seed the asset table

The price-guard publishes the rows of the `asset` table whose `status` is `active`, and nothing but
this step fills it. Skip it and the price-guard logs `cycle complete` with `count: 0` forever while the
public live-price page stays empty. Run it once, after `up` and after step 2 (the on-chain assets
must already be configured, because the rows go live as soon as they exist):

```
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod --profile seed run --rm seed
```

It reads `scripts/shadow-assets.json` and prints `CODE: seeded (<contract id>)` per asset. It is safe
to repeat: assets already in the table print `already seeded` and are left alone. Check the result:

```
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod exec postgres \
  psql -U ballast -d ballast -c "select code, status, contract_c from asset order by code"
```

You should see one `active` row per entry in `scripts/shadow-assets.json` (three today), and each
`contract_c` should equal the matching `SAC_<CODE>` line in `.env.mainnet-deploy`. Within a cron tick
(one minute by default) `docker compose ... logs price-guard` shows `price-guard: cycle complete` with
`count` equal to that number of rows.

## Verified so far

The service image builds (`docker build --target service .`) and starts: with the production secrets
missing it exits at once with the list of what is missing, rather than booting insecurely. The full
compose stack, TLS issuance and the console image have not been run end to end.

## What is and is not covered

- Postgres data lives in the `pgdata` volume. Back it up; nothing here does.
- Single host, no failover. The services are safe to restart (every job is idempotent) but there is no
  second copy running.
- `docker-compose.yml` at the repo root is the local development stack, not this one.

## Replica Safety and Service Scaling

| Service | Replicas Allowed | What Breaks If Doubled | Restart Behaviour | Code Trace |
|---|---|---|---|---|
| `keeper` | **1 only** | Stellar account sequence collision (`txBadSeq`); race conditions on liquidations and repo margin calls; redundant gas fees. (Advisory locking mitigates temporary restarts, but multiple active replicas are unsupported). | Scheduled via `node-cron`. Missed ticks during downtime are not queued or backfilled; execution resumes at the next scheduled tick. | `services/keeper/src/index.ts:35`, `services/keeper/src/lock.ts` |
| `margin-monitor` | **1 only** | Concurrent instances poll the same lines, generating duplicate `margin_event` rows in Postgres, duplicate alert dispatches, and unnecessary contract simulation load. | Polling loop with delay. Resumes immediately on container startup; missed checks during downtime are evaluated on the first pass. | `services/margin-monitor/src/index.ts:22`, `services/margin-monitor/src/poll.ts` |
| `ledger` | **1 only** | Simultaneous reconciliation runs generate duplicate `reconciliation_run` and break audit records and duplicate alert notifications. | Scheduled task. Missed scheduled reconciliation runs are not backfilled; next run executes on schedule. | `services/ledger/src/index.ts`, `services/ledger/src/reconcile.ts` |
| `indexer` | **1 (idempotent)** | Safely deduplicates via unique constraint `chain_event_event_id_uq` (`onConflictDoNothing`), but concurrent replicas waste Stellar RPC credits, CPU, and DB connections scanning redundant ledger pages. | Poller loop. Reads the cursor or latest ledger from Postgres on startup and continues forward; missed ledgers during downtime are naturally caught up. | `services/indexer/src/poller.ts:235`, `services/indexer/src/index.ts` |

### Missed-Tick Policy
None of the operational services (keeper, margin-monitor, ledger) queue or replay missed cron ticks during container downtime. When restarted, cron jobs wait for the next scheduled tick without catch-up.
