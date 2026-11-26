# Troubleshooting

Problems people hit running the stack and the e2e drills. Read this before assuming you found a bug.

## Testnet RPC is flaky

Symptoms: `fetch failed`, `Account not found` for an account you know exists, TLS errors from `stellar`.

- The contract clients and operator signing retry transient failures, and the scripts wrap `stellar`
  calls in a `retry()` helper. A drill that dies on one is usually the network, so run it again.
- Node can be slow to pick an IP family. Set this for local runs **and** inside container builds:

  ```
  export NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000
  ```

## `UnreachableCodeReached` after a retried script step

Rust panic messages are stripped from release wasm, so a trapped call reads
`VM call trapped: UnreachableCodeReached`. If it came right after a retry, the earlier attempt probably
landed and the retry hit the contract's own guard (for example `already initialized`). Check the
contract's state before assuming the step failed. The same note is in `scripts/README.md`.

## `pnpm dev` restarts in the middle of a drill

`pnpm dev` runs `tsx watch`. Editing service source, or rebuilding a workspace package's `dist`
(`pnpm build`, or a `packages/db` schema change), restarts services. Do not edit or rebuild while an e2e
script runs. Stop the stack first.

## Every redeploy abandons the last one

`scripts/deploy.sh` regenerates every role key, so the previous deployment can no longer be administered.
Use a fresh database for each deployment:

```
PG_DB=ballast_2 scripts/dev-setup.sh testnet
```

`scripts/redeploy-price-guard.sh` swaps only `PriceGuard` on an existing deployment.

## `stellar` CLI identities clash between networks

Identity names (`admin`, `pauser`, …) are not network-namespaced. Running a testnet deploy after a local
one overwrites the local keypairs, and the reverse.

## Contracts won't build to wasm

`soroban-sdk` 28 needs `stellar-cli` 25.2 or newer and refuses a plain
`cargo build --target wasm32-unknown-unknown`. Use `stellar contract build` from inside the crate.
`cargo test --workspace` in `contracts/` runs on the host target and needs no CLI.

## Ports 3000–3002 are taken

Change `API_PORT`, `ISSUER_GATEWAY_PORT` or `PAYOUT_HOP_PORT` in the repo-root `.env` and re-run
`scripts/dev-setup.sh`. It keeps the ports and secrets already in `.env`.

## The guard says `Degraded` and the API refuses to lend

`PriceGuard` needs at least two fresh, agreeing sources. Check, in order:

1. `max_staleness_s` against how often the source updates. RedStone's USTRY feed updates every 1–2 hours,
   so a 1-hour window will report `Degraded`. The testnet deployment uses 6 hours.
2. That `services/price-guard` is running and its operator account has XLM (`OPERATOR_MIN_XLM`).
3. That the issuer NAV key is registered: `scripts/configure-nav-key.sh testnet`.

A move beyond `daily_move_band_bps` against the last good value puts the guard into a sticky `Halted`
state that only the `risk` role clears (`confirm_halt_cleared`). Follow
[`docs/runbooks/price-halt.md`](docs/runbooks/price-halt.md) before clearing it.

## Requests are refused with a compliance error

With `COMPLIANCE_ENFORCED=true`, risk-taking routes need an `approved` KYB status and a recent clear
sanctions screening. For local work, approve the seeded parties with the CLI in `services/api/README.md`,
or leave enforcement off in your local `.env`. Repay, release, withdraw and unwind are never gated.

## `dev-login` doesn't work

It is for local development only and is refused in production. See `SECURITY.md`.

## The console can't be tested by the e2e scripts

Signing goes through the Freighter extension, which the scripts cannot drive. To use the console, import
the deployment's key into Freighter (`stellar keys secret lender`), switch Freighter to the same network,
and open http://localhost:5173.

## Liquidation runs get stuck or stop half-finished

See [`services/keeper/src/jobs/cureExpiry.ts`](services/keeper/src/jobs/cureExpiry.ts) for the automated transfer-route flow and [`contracts/AUDIT_NOTES.md`](contracts/AUDIT_NOTES.md) for contract guarantees. Every keeper step (`poke`, `CreditLine::liquidate`, `PledgeVault::liquidate`, and DB booking) is idempotent and safe to repeat; final settlement (`CreditLine::close_liquidated`) always requires the lender's signature.

Common inspection commands (read-only simulations against Soroban RPC):

```bash
stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- line --line <LINE_ID>
stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- ltv --line <LINE_ID>
stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- liquidation_record --line <LINE_ID>
stellar contract invoke --id "$PLEDGE_VAULT_CID" --source "$SIGNER" --network "$NETWORK" -- position_units --line <LINE_ID> --asset <ASSET_CID>
```

### 1. Keeper died between `CreditLine::liquidate` and `PledgeVault::liquidate`

- **Symptom:** The credit line is `Liquidating` on-chain (`CreditLine` froze the debt and price), while collateral still sits in `PledgeVault` (`position_units > 0`) and Postgres `credit_line.status` is still `open`.
- **Confirm on-chain:**
  ```bash
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- line --line <LINE_ID>
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- liquidation_record --line <LINE_ID>
  stellar contract invoke --id "$PLEDGE_VAULT_CID" --source "$SIGNER" --network "$NETWORK" -- position_units --line <LINE_ID> --asset <ASSET_CID>
  ```
  Expect `line.status == "Liquidating"`, `liquidation_record.closed == false`, and `position_units > 0` (or `0` if `PledgeVault::liquidate` already ran and the keeper died right before Postgres booking).
- **Safe next step:** **Safe for keeper / operator to repeat.** Restart or wait for the next `cure-expiry` keeper tick. Because `runCureExpiryJob` checks `onChain.status === "Liquidating"`, it skips `CreditLine::liquidate`, submits `PledgeVault::liquidate` if `position_units > 0`, recovers `totalUnits` from active DB pledges if `position_units == 0`, and finishes Postgres booking.

### 2. Keeper skips an overdue line due to collateral sync lag (`held != onChain.pledgedUnits`)

- **Symptom:** A line is past its cure window and at liquidation LTV, yet `cure-expiry` keeps skipping it because `PledgeVault`'s held balance differs from `CreditLine.pledged_units`.
- **Confirm on-chain:**
  ```bash
  stellar contract invoke --id "$PLEDGE_VAULT_CID" --source "$SIGNER" --network "$NETWORK" -- position_units --line <LINE_ID> --asset <ASSET_CID>
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- line --line <LINE_ID>
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- ltv --line <LINE_ID>
  ```
  Compare `position_units` against `line.pledged_units` and check `ltv.state` / `ltv.price_status`.
- **Safe next step:** **Safe to repeat reconciliation; do not bypass the mismatch check.** Let the `sync-collateral` keeper job (runs every minute) call `CreditLine::sync_collateral` with the vault's `position_units`, or invoke it manually as `keeper`/`admin` using the vault's on-chain figure (never Postgres):
  ```bash
  stellar contract invoke --id "$CREDIT_LINE_CID" --source keeper --network "$NETWORK" -- sync_collateral --caller <KEEPER_ADDR> --line <LINE_ID> --units <POSITION_UNITS>
  ```
  Once synchronized, `cure-expiry` is safe to repeat (it arms `breach_ledger` via `poke` if cleared and proceeds after one ledger when `price_status == "Ok"` and `ltv.state == "Liquidation"`).

### 3. Lender has not called `close_liquidated` (`Liquidating` indefinitely)

- **Symptom:** Collateral was transferred to the lender in kind (`position_units == 0` in `PledgeVault`), `line.status` stays `Liquidating`, and any borrower surplus has not been paid out.
- **Confirm on-chain:**
  ```bash
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- line --line <LINE_ID>
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- liquidation_record --line <LINE_ID>
  stellar contract invoke --id "$PLEDGE_VAULT_CID" --source "$SIGNER" --network "$NETWORK" -- position_units --line <LINE_ID> --asset <ASSET_CID>
  ```
  Expect `line.status == "Liquidating"`, `liquidation_record.closed == false` (with `price`, `debt`, and `seized_units` already frozen), and `position_units == 0`.
- **Safe next step:** **Requires the lender (not keeper, admin, or borrower).** Re-running keeper jobs has no effect here, and `price`/`debt` remain frozen in `LiquidationRecord` regardless of delay. Coordinate with the lender to sign `CreditLine::close_liquidated` (either in the Lender Console or via CLI):
  ```bash
  stellar contract invoke --id "$CREDIT_LINE_CID" --source <LENDER_IDENTITY> --network "$NETWORK" -- close_liquidated --lender <LENDER_ADDR> --line <LINE_ID>
  ```

### 4. `close_liquidated` reverts when transferring surplus (lender lacks USDC)

- **Symptom:** The lender calls `CreditLine::close_liquidated`, but the transaction traps/reverts inside the USDC token transfer (`surplus > 0` because `recovered = seized_units * price` exceeds `debt`).
- **Confirm on-chain:**
  ```bash
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- liquidation_record --line <LINE_ID>
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- line --line <LINE_ID>
  stellar contract invoke --id "$CREDIT_LINE_CID" --source "$SIGNER" --network "$NETWORK" -- ltv --line <LINE_ID>
  stellar contract invoke --id "$USDC_CID" --source "$SIGNER" --network "$NETWORK" -- balance --id <LENDER_ADDR>
  ```
  Check `liquidation_record` (`seized_units * price / 10_000_000 - debt`) against the lender's USDC `balance` (both 7-decimal stroops).
- **Safe next step:** **Requires the lender.** Have the lender fund their wallet with at least the `surplus` USDC shortfall (and verify the borrower's USDC trustline if classic), then **safely repeat** `CreditLine::close_liquidated` — because earlier attempts reverted atomically, no state was mutated.

## PriceGuard calls fail due to archived state

Symptoms: Transactions trap or RPC simulation fails reporting that a contract data entry or contract instance is archived or missing from the active footprint.

Cause: An asset's price source was not republished for longer than the persistent entry TTL, or the contract instance was inactive past its instance TTL.

Fix:
1. Run `stellar contract restore` for the contract instance:
   ```bash
   stellar contract restore --id <PRICE_GUARD_CONTRACT_ID> --source <OPERATOR_IDENTITY> --network <NETWORK>
   ```
2. For specific persistent source keys, include the key in a restore footprint transaction or trigger a re-publish once the instance is restored. Regular publishing automatically keeps active keys extended via `extend_ttl`.

## Still stuck

Open a bug report with the exact error, your network, commit hash, and Node and `stellar` versions.
