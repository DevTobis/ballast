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
state that only the `risk` role clears (`confirm_halt_cleared`).

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

