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

Both scripts wrap every `stellar` network call in a `retry()` helper (a few attempts with a short
backoff) - real testnet runs have shown intermittent transient TLS failures from some networks
unrelated to the contracts themselves. If a retried call reports failure but the underlying
transaction actually landed (the drop hit status confirmation, not submission), the next retry
will correctly hit the target contract's own idempotency guard (e.g. "already initialized") and
panic - that panic means the step already succeeded, not that something is broken; check the
contract's state before assuming otherwise.

This has been run for real against public testnet - see `TESTNET_DEPLOYMENT.md` at the repo root
for the live contract IDs, role addresses, and e2e smoke-test result.

## Running the full stack

`deploy.sh` and `e2e-smoke.sh` only touch the contracts. To run the services and the console
against a deployment:

```
scripts/dev-setup.sh testnet   # or `local`
pnpm dev
scripts/e2e-services.sh testnet
scripts/e2e-liquidation.sh testnet
scripts/e2e-repo-margin.sh testnet
```

`deploy.sh` ends by calling `configure-desks.sh`, which configures `ExitDesk` (asset, spread,
caps, a USDC float) and `RepoDvp` (cash token, asset) and sets up the trustlines and test cash the
exit, repo and liquidation flows need. It can be re-run on its own against an existing deployment.

`dev-setup.sh` starts a Postgres container (`ballast-pg`, Docker or Podman), writes the repo-root
`.env` from `.env.<network>-deploy` plus the operator keys in the `stellar` CLI's identity store,
writes `apps/console/.env`, applies migrations, and seeds one lender party, one borrower party and
the test RWA (`packages/db/src/seed.ts`). It is safe to re-run, and keeps the ports and secrets
already in `.env` - so if 3000-3002 are taken on your machine, change `API_PORT` /
`ISSUER_GATEWAY_PORT` / `PAYOUT_HOP_PORT` there and re-run it. Every service loads the root `.env`
itself, so `pnpm dev` needs no exported variables.

`e2e-services.sh` plays both customers against the running stack: real SEP-10 login, every
transaction built by `services/api`, signed locally with the lender's/borrower's key, and
submitted back through `POST /v1/tx/submit`. It runs two scripts from `services/api/e2e/`:

- `collateral-rail.ts`: open, fund, two pledges, wait for `services/keeper` to sync the collateral
  and `services/price-guard` to publish an `Ok` price, draw, repay, release.
- `release-draw.ts`: the release-then-draw race. A borrower releases collateral and draws in the next
  breath; the draw is judged against what is left and refused, because the vault reports every change
  to the credit line in the same transaction.
- `exit-repo.ts`: an exit-desk quote and its execution; then a repo proposed by the lender,
  accepted by the borrower, and unwound at maturity by `services/keeper` with nobody else signing.

`e2e-liquidation.sh` runs `liquidation.ts`: the borrower draws against healthy collateral, then the
line's margin thresholds are tightened under its real LTV (real prices do not fall on demand, so the
price itself is left alone). From there only the services act: `margin-monitor` records the move into
`Liquidation`, and `keeper` arms the breach, waits out the cure window, liquidates the line and sends
the collateral to the lender. The lender then closes the line (the contract books the outcome at the
price it confirmed and pays the borrower the surplus) and withdraws the funding that was never drawn.
It is separate because the thresholds are shared by every line on the asset; the original ones are
put back on exit.

`e2e-repo-margin.sh` runs `repo-margin.ts` the same way for a repo: the keeper opens a margin call
under tightened thresholds, the borrower cures it by adding collateral through the API, a second call is
left uncured, and after the (shortened) cure window the keeper defaults the trade, giving the lender
only the units that cover what is owed. It needs `KEEPER_REPO_MARGIN_CRON` set to every minute, which
`dev-setup.sh` does.

To use the console, import the deploy's `lender` or `borrower` key into Freighter
(`stellar keys secret lender`), switch Freighter to the same network, and open
http://localhost:5173.

## What this does and doesn't prove

`deploy.sh` and `e2e-smoke.sh` drive the contracts directly via `stellar contract invoke` - they
prove the Rust contracts work together on a live network, including the cross-contract calls.
`e2e-services.sh` and `e2e-liquidation.sh` prove the layer above: `services/api`, the keeper's
jobs, `services/price-guard`'s publish cycle, `services/margin-monitor` and Postgres, against that
same deployment.

Not covered:

- **The console in a browser.** It builds and type-checks, and uses the same API calls the e2e
  scripts do, but signing goes through the Freighter extension, which the scripts can't drive.
- **Real RWAs and real USDC.** RWA1 and TUSD are tokens this repo issues itself. Prices for RWA1
  are real: it is priced as Etherfuse's USTRY bond (Etherfuse's price API plus RedStone's USTRY
  feed read from mainnet, see `scripts/real-sources.env`). But no issuer has authorised Ballast to
  hold the real bonds, so nothing here custodies a real RWA.
- **A price move.** Real prices do not fall on demand, so the liquidation drill tightens the
  line's margin thresholds under its real LTV instead of dropping the price.
- **Lien custody modes, repo margin calls and default-close, the payout hop, webhooks.** The code
  is there and unit-tested; none of it is exercised against a live network.
- **A margin call that is cured.** The liquidation drill goes straight through to liquidation.
- **Issuer back-office calls.** `services/issuer-gateway` is not called by anything yet, and its
  lien/redemption endpoints are not verified against any real issuer API.

## Price sources

NAV is not signed by issuers, so `services/price-guard` signs each NAV it fetched with the
price-publisher key and `PriceGuard.publish_nav` verifies that signature on-chain. The guarantee
is "Ballast's publisher saw this value from the issuer's API", not issuer attestation.
`scripts/configure-nav-key.sh [network]` registers the publisher key and turns the requirement on;
`deploy.sh` runs it, and it is the way to bring an older deployment in line.

Rotating the publisher no longer needs `scripts/redeploy-price-guard.sh`: queue
`queue_role_change --role '"PricePublisher"' --new_address ...`, execute it after the 48h timelock,
then update `PRICE_PUBLISHER` in `.env.<network>-deploy` and re-run `scripts/configure-nav-key.sh`
so the new key is the registered NAV attestor. See `contracts/README.md` for the full sequence and
why the issuer-key step is required.

To see the real sources without any contract or database (safe against mainnet):

```
STELLAR_RPC_URL=https://mainnet.sorobanrpc.com STELLAR_HORIZON_URL=https://horizon.stellar.org \
STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" \
STELLAR_SIMULATION_SOURCE=<any valid G address> \
REDSTONE_FEED_CONTRACT_IDS='{"CETES":"CCYGBQZ5JKE2TGK2XNNVIZRKFEIT27NZADS3XJFSO4CCIH3LHIUP34LG"}' \
pnpm --filter @ballast/service-price-guard smoke CETES:etherfuse USTBL:spiko
```

For a long-running shadow run set `PRICE_GUARD_PUBLISH=false` on `services/price-guard`: it records
the real readings and alerts when issuer NAV and oracle disagree by more than the asset's band,
and sends nothing on-chain.

## Mainnet price layer

`scripts/deploy-mainnet-prices.sh` deploys only `registry` and `price-guard` to mainnet (no funds
are held by either) and registers the assets in `scripts/shadow-assets.json`, so the public
live-price page has an on-chain guarded price to show. It does nothing without
`CONFIRM_MAINNET=deploy-prices`, `--dry-run` prints every command without sending any, and
`--help` displays usage. Unknown options are rejected with exit code 2 to prevent accidental live runs.

Run `scripts/shadow-run.sh` for a week or two first and look at source divergence and staleness
before sending the first mainnet transaction. The role accounts (`mainnet_admin`, `mainnet_pauser`,
`mainnet_keeper`, `mainnet_price_publisher`, `mainnet_risk`) must already exist and be funded; the
script never generates keys on mainnet.

## If a CLI flag doesn't match

The flag names were originally derived offline from `stellar contract info interface --wasm
<path>`, then hand-verified against a real testnet deployment (see `TESTNET_DEPLOYMENT.md`) -
two real bugs surfaced that way and are now fixed: `deploy.sh` was missing a TUSD trustline for
the borrower (needed for `CreditLine.draw` to reach them), and `e2e-smoke.sh`'s `publish_nav` call
needed an `--asset_code` argument after `contracts/price-guard`'s on-chain issuer-signature
verification change (see `contracts/README.md`). If a contract changes again and a flag stops
matching, `stellar contract invoke --id <CID> --source admin --network local -- <fn> --help`
against your own deployment shows the current one.
