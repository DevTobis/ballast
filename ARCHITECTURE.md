# Architecture

A map of the code for people who want to change it. `PRD.md` is the product and market case;
`contracts/AUDIT_NOTES.md` is what the contracts assume and trust. This file connects the two and says
where things live.

## The shape of the system

```
                  customer wallet (Freighter)
                          │ signs XDR
   apps/console ──────────┼───────────────┐
        │  REST           ▼               │
        └──────────► services/api ──► Soroban RPC ──► contracts (testnet)
                       │     ▲                              ▲   ▲
                       ▼     │ reads                        │   │ signed, submitted by operator keys
                    Postgres ◄── services/indexer (events)  │   │
                       ▲  ▲                                 │   │
          services/margin-monitor   services/ledger         │   │
                                                            │   │
                        services/keeper ────────────────────┘   │
                        services/price-guard ───────────────────┘
```

Two kinds of transaction exist, and the distinction explains most of the layout:

- **Customer transactions** (open a line, fund, pledge, draw, repay, release, exit, repo). The API builds
  the unsigned XDR and records what it means in `tx_intent`. The customer signs it in their own wallet.
  The signed envelope returns through `POST /v1/tx/submit`; once the ledger closes, the API updates its
  books. A background sweep settles anything submitted another way and writes off transactions that
  were never signed.
- **Operator transactions** (publish a price, sync collateral, arm and run a liquidation, unwind a repo).
  These are signed by role keys held in `packages/operator-signing` (Vault Transit, AWS KMS, or a raw
  secret in local development only), submitted by `keeper` and `price-guard`.

Ballast never holds a customer key. The keeper is trusted for timing and completeness, never for value:
every amount in a settlement comes from contract state or the PriceGuard (see `AUDIT_NOTES.md`).

## Contracts (`contracts/`)

| Crate | Role | Calls |
|---|---|---|
| `common` | Library, not deployed: roles, timelock, pause, price types, risk and margin maths, custody modes | – |
| `registry` | Asset configs, haircut parameters, timelocked parameter and role changes, admin transfer, pause | – |
| `price-guard` | Median / band / staleness / halt over several price sources; verifies the Ed25519 NAV signature | – |
| `pledge-vault` | One collateral position per `(line, asset)`. Escrow mode holds the token; lien modes only record a reference | `CreditLine` (`sync_from_vault`, `ltv`, `borrower_of`), `PriceGuard` |
| `credit-line` | Lender commitments, draws, repayments, interest, LTV, the margin state machine, liquidation entry | `PriceGuard` |
| `exit-desk` | Atomic RWA → USDC swap at guarded price minus a spread | `PriceGuard` |
| `repo-dvp` | Bilateral repo: DvP on leg 1, scheduled unwind on leg 2, margin calls and default | `PriceGuard` |

Things that are easy to get wrong:

- The dependency between `PledgeVault` and `CreditLine` runs **one way**: the vault calls the credit line
  in the same transaction as every pledge, release, lien confirmation and liquidation. The credit line
  never calls the vault, so there is no cycle. This is what prevents "release collateral, then draw
  before the next sync".
- `CreditLine::liquidate` only flips the line to `Liquidating` after a two-read breach. Moving collateral
  is a separate keeper-only `PledgeVault::liquidate`. The keeper calls both.
- `Registry` is **not** read at runtime by the other contracts today. Haircuts, thresholds and spreads are
  set directly on each contract by the admin (`configure_asset`). Each module doc says so. Syncing them
  from `Registry` is open work.
- Roles on `Registry` and `PriceGuard` rotate in place without redeploying: non-admin roles (`Pauser`,
  `Keeper`, `PricePublisher`, `Risk`) rotate through the 48h timelock (`queue_role_change` /
  `execute_role_change`), and the admin transfers via two-step `propose_admin` / `accept_admin` (see
  `contracts/README.md`).
- Rust panic messages are stripped in release wasm. A trapped call shows as
  `VM call trapped: UnreachableCodeReached`; read the contract's state and its tests to learn the cause.
- A Soroban read is a simulation and stores nothing. `PriceGuard` therefore evaluates and persists on
  every **publish**, not on read.

## Pricing

`services/price-guard` fetches from independent real sources (issuer NAV APIs such as Etherfuse and
Spiko, and RedStone's on-chain feeds), signs each NAV with the price-publisher key, and publishes to the
`PriceGuard` contract. The contract verifies the signature, then computes the guarded price. No issuer
signs NAV, so the guarantee is "Ballast's publisher saw this value from the issuer's API", not issuer
attestation. There are no mock sources and no mock mode; a missing source degrades the price rather than
inventing one. `scripts/check-no-mocks.sh` enforces this in CI.

## Services (`services/`)

| Service | Responsibility |
|---|---|
| `api` | REST API, SEP-10 login, institution API keys, webhooks, KYB/OFAC gate. Builds unsigned XDR, records `tx_intent`, settles on ledger close |
| `price-guard` | Fetch, sign and publish prices; alert on stale or diverging sources |
| `keeper` | Scheduled jobs: collateral sync, interest accrual, cure-window expiry (arms and runs liquidation), repo margin, repo unwind, operator balance check |
| `margin-monitor` | Polls `CreditLine.ltv` and records margin-state changes (`margin_event`) and alerts on calls. It does not liquidate; the keeper does |
| `indexer` | Mirrors contract events into Postgres (idempotent ingestion) |
| `ledger` | Nightly reconciliation of recorded pledges against `chain_event` (writes a `reconciliation_run`, alerts on a mismatch) and the journal re-export |
| `issuer-gateway` | Issuer back-office calls (SEP-8 approvals, lien and redemption). Internal only |
| `payout-hop` | Forwards USDC to an approved anchor with the memo a contract account cannot carry. Internal only, capped, not yet wired into the exit flow |

Each service has its own README with its environment variables and tests. `issuer-gateway` and
`payout-hop` authenticate every call with an internal token and bind to `127.0.0.1`.

## Packages (`packages/`)

| Package | Used for |
|---|---|
| `db` | Drizzle schema, migrations, seed, compliance CLI. The shared Postgres schema |
| `domain-types` | Types shared across services |
| `network-config` | Network name ↔ passphrase ↔ RPC URLs; refuses a name that disagrees with its passphrase |
| `contract-clients` | Typed Soroban calls (retries transient RPC failures via `withRpcRetry` from `network-config`) |
| `operator-signing` | Role-key signing backends and signature self-check |
| `observability` | Logging, webhook alerts with cooldown, operator-balance watch |

## Data (`packages/db/src/schema.ts`)

Postgres tables, grouped:

- **Parties and assets:** `party`, `party_account`, `asset`, `asset_param_change`, `api key` and nonce tables
- **Lending:** `credit_line`, `pledge`, `draw`, `repayment`, `margin_event`, `liquidation`
- **Exit and repo:** `exit_quote`, `exit_fill`, `repo_trade`, `repo_margin_call`, `payout_forward`
- **Pricing:** `price_snapshot`, `price_observation`
- **Plumbing and audit:** `tx_intent`, `chain_event`, `journal_entry`, `reconciliation_run`, `audit_log`,
  `compliance_check`, `webhook_subscription`, `webhook_delivery`

Postgres mirrors and explains chain state; the contracts are the source of truth for balances and
status.

## Console (`apps/console`)

React + Vite. Pages for borrower, lender, exit and repo, plus a public live-price page backed by
`GET /v1/public/markets`. Signing goes through Freighter. See `apps/console/README.md`.

## Where to start for common changes

| You want to… | Start in |
|---|---|
| Change a lending rule | `contracts/credit-line` and `contracts/common`, then `contracts/AUDIT_NOTES.md` |
| Add a price source | `services/price-guard/src/adapters/`, then `scripts/real-sources.env` |
| Add an API route | `services/api/src/routes/` with a test in `services/api/src/__tests__/` |
| Add a keeper job | `services/keeper/src/jobs/` |
| Change a table | `packages/db/src/schema.ts`, then `pnpm --filter @ballast/db migrate` and commit the migration |
| Add a webhook event | `services/api/src/webhooks/` |

## Status

Pre-audit, testnet-only. See `SECURITY.md` and `TESTNET_DEPLOYMENT.md`. The live deployment uses
self-issued test tokens (`RWA1`, `TUSD`); prices for `RWA1` come from real sources.
