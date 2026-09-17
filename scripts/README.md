# End-to-end scripts

Proves the wiring for real, against a live Stellar network (local or testnet), rather than
unit-test mocks.

## Prerequisites

A local Stellar network (Core + Horizon + Soroban RPC + friendbot) via `stellar container start
local` (needs Docker or a Docker-compatible socket, e.g. Podman - see `docker-compose.yml`'s
`stellar` service for the equivalent image). This pulls the multi-GB `stellar/quickstart` image
the first time, which can be slow on a constrained connection.

## Local end-to-end run

```
stellar container start local
scripts/deploy.sh local   # builds + deploys all 6 contracts, wires roles/config, writes .env.local-deploy
scripts/e2e-smoke.sh local   # real signed pledge -> draw -> repay -> release flow, plus a security regression check
```

(`local` is also the default for both scripts, so `scripts/deploy.sh` and `scripts/e2e-smoke.sh`
with no argument behave the same way.)

## Testnet end-to-end run

Unlike the local run, no Docker container is needed - `deploy.sh testnet` and `e2e-smoke.sh
testnet` talk directly to the public Stellar testnet. The `stellar` CLI does need real network
access to reach it.

```
scripts/deploy.sh testnet      # builds + deploys all 6 contracts, wires roles/config, writes .env.testnet-deploy
scripts/e2e-smoke.sh testnet   # real signed pledge -> draw -> repay -> release flow, plus a security regression check
```

`deploy.sh` generates and funds identities with `stellar keys generate --fund --network testnet`,
which uses the Stellar CLI's built-in public testnet friendbot automatically - there's no need to
run `stellar network add testnet` first, since `testnet` is one of the CLI's default network
profiles.

See the NOTE in `deploy.sh`'s header comment: CLI identity names (`admin`, `pauser`, etc.) aren't
network-namespaced, so running the testnet deploy after a local one overwrites those local
identities' keypairs.

## What this does and doesn't prove

`deploy.sh` and `e2e-smoke.sh` drive the contracts directly via `stellar contract invoke`
(each a real signed, submitted transaction) - they prove the six Rust contracts work together
correctly on a live network, including the cross-contract calls (`PledgeVault.release` calling
`CreditLine.borrower_of`/`ltv`, `CreditLine.draw` calling `PriceGuard.guarded_price`).

They do **not** exercise `services/api`, `services/keeper`, `services/price-guard`, or
`apps/console` end-to-end against this network (that needs Postgres seeded with matching `party`/
`asset`/`credit_line` rows and every service pointed at the same RPC + contract IDs this script
prints into `.env.<network>-deploy`). `e2e-smoke.sh`'s "keeper syncs collateral" step calls
`sync_collateral` directly rather than running `services/keeper`'s actual job, and its price
publish step calls `PriceGuard` directly rather than running `services/price-guard`'s pipeline -
both are named stand-ins for the real service, not the real service.

## If a CLI flag doesn't match

`deploy.sh`'s comment block explains this: the flag names were derived from `stellar
contract info interface --wasm <path>` (offline, no network needed), but the auto-generated
`contract invoke` flag names themselves weren't hand-verified against a live deployment before
this script was committed. If one is wrong, `stellar contract invoke --id <CID> --source admin
--network local -- <fn> --help` against your own deployment shows the real one.
