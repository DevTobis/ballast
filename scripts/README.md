# Local end-to-end scripts

Proves the wiring for real, against a live local Stellar network, rather than unit-test mocks.

## Prerequisites

A local Stellar network (Core + Horizon + Soroban RPC + friendbot) via `stellar container start
local` (needs Docker or a Docker-compatible socket, e.g. Podman - see `docker-compose.yml`'s
`stellar` service for the equivalent image). This pulls the multi-GB `stellar/quickstart` image
the first time, which can be slow on a constrained connection.

## Running

```
stellar container start local
scripts/deploy-local.sh   # builds + deploys all 6 contracts, wires roles/config, writes .env.local-deploy
scripts/e2e-smoke.sh      # real signed pledge -> draw -> repay -> release flow, plus a security regression check
```

## What this does and doesn't prove

`deploy-local.sh` and `e2e-smoke.sh` drive the contracts directly via `stellar contract invoke`
(each a real signed, submitted transaction) - they prove the six Rust contracts work together
correctly on a live network, including the cross-contract calls (`PledgeVault.release` calling
`CreditLine.borrower_of`/`ltv`, `CreditLine.draw` calling `PriceGuard.guarded_price`).

They do **not** exercise `services/api`, `services/keeper`, `services/price-guard`, or
`apps/console` end-to-end against this network (that needs Postgres seeded with matching `party`/
`asset`/`credit_line` rows and every service pointed at the same RPC + contract IDs this script
prints into `.env.local-deploy`). `e2e-smoke.sh`'s "keeper syncs collateral" step calls
`sync_collateral` directly rather than running `services/keeper`'s actual job, and its price
publish step calls `PriceGuard` directly rather than running `services/price-guard`'s pipeline -
both are named stand-ins for the real service, not the real service.

## If a CLI flag doesn't match

`deploy-local.sh`'s comment block explains this: the flag names were derived from `stellar
contract info interface --wasm <path>` (offline, no network needed), but the auto-generated
`contract invoke` flag names themselves weren't hand-verified against a live deployment before
this script was committed. If one is wrong, `stellar contract invoke --id <CID> --source admin
--network local -- <fn> --help` against your own deployment shows the real one.
