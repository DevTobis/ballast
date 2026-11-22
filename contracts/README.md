# Ballast contracts

Six Soroban contracts (Rust) plus `common`, a shared library of access-control, timelock, pause,
price, risk, and margin logic used across all of them. See `../PRD.md` §6.2 and §8 for the design
and interface each one implements, and each crate's own module doc comment for what's simplified
in this skeleton pass.

| Crate | Responsibility |
|---|---|
| `common` | Shared roles/timelock/pause/price/risk/margin logic — not itself a deployable contract |
| `registry` | [Asset configs, haircut parameters, timelocked param changes](registry/README.md) |
| `price-guard` | [Median/band/staleness/halt price logic (PRD §6.4)](price-guard/README.md) |
| `pledge-vault` | [Escrow/lien collateral positions](pledge-vault/README.md) |
| `credit-line` | [Credit lines, draws, repayments, the margin state machine](credit-line/README.md) |
| `exit-desk` | [RWA → USDC instant exit](exit-desk/README.md) |
| `repo-dvp` | Bilateral repo, atomic DvP |

## Differences from PRD section 8

The PRD (`../PRD.md` §8) is the product doc and is untouched; this table is where the code
diverges from it, so a reader who trusts the PRD writes clients against the right shapes. Each
row is verified against the code at the cited lines. Status is one of `intended` (a deliberate
design choice), `planned` (tracked work, not yet built) or `bug` (the code does something the
PRD does not allow, or silently drops something it promises).

| Item | PRD says | Code does | Status |
|---|---|---|---|
| `open` gains `asset` | §8 (`PRD.md:555`): `open(lender, borrower, limit, rate_bps, cure_s, agreement)` — no asset | `open` takes `asset: Address` (`contracts/credit-line/src/lib.rs:329`) | intended — a line must know its collateral asset; the §7 data model ties a line to an asset |
| One position per (borrower, asset) | §6.2 (`PRD.md:349`): "One position per (borrower, asset)" | `open` allocates a fresh line id with no check for an existing line for the same (borrower, asset) (`contracts/credit-line/src/lib.rs:325`); vault positions are keyed `(line, asset)` (`contracts/pledge-vault/src/lib.rs:135`), so one borrower can hold two positions for one asset | bug — no tracking issue |
| `liquidate(route)` ignores `route` | §8 (`PRD.md:561`): `liquidate(keeper, line, route)` | the parameter is accepted and discarded (`let _ = route;`, `contracts/credit-line/src/lib.rs:613`) | bug — no tracking issue |
| `cure_s` stored, never enforced | §8 (`PRD.md:555`) passes `cure_s` to `open`; invariant 3 requires an "expired cure window" before liquidation | `cure_s` is stored on the `Line` (`contracts/credit-line/src/lib.rs:143,360`) and never read; the "no quick liquidation" rule is instead enforced by requiring the breach to have been flagged by a `poke` on an earlier ledger | bug — #147 |
| `fee_bps` has no on-chain effect | §7 (`PRD.md:496`): the `credit_line` table has `fee_bps`; §5 says the platform fee "is taken on top" | no `fee_bps` anywhere in `contracts/`; it never reaches `open`, `Line`, or `repay` | planned — #146, #920 |
| No `next accrual` getter | §9 (`PRD.md:606`): `GET /v1/credit-lines/{id}` returns "limit, drawn, LTV, state, next accrual" | no `next_accrual` getter exists; `ltv` returns debt as a single sum and needs a PriceGuard call | planned — #131, #918 |
| `publish_nav` gains `asset_code` | §8 (`PRD.md:545`): `publish_nav(publisher, asset, value, ts, sig)` | `publish_nav` takes an extra `asset_code: Bytes` (`contracts/price-guard/src/lib.rs:989`) for the issuer-signature check | intended — a deliberate breaking change, documented in "price-guard's `publish_nav`" below |
| `unpause` is queue + execute | §8 (`PRD.md:542`): `unpause(admin, scope)` (timelocked) | no `unpause` entry point; instead `queue_unpause` (`contracts/registry/src/lib.rs:286`) + `execute_unpause` (`:323`), implementing the 48h timelock as an explicit two-step flow | intended |
| `propose` flattens `RepoTerms` | §8 (`PRD.md:568`): `propose(cash_lender, terms: RepoTerms)` | `propose` takes the terms as separate parameters — `cash_lender, cash_borrower, asset, units, cash_amount, rate_bps, kind, maturity_at, agreement_hash` (`contracts/repo-dvp/src/lib.rs:597`); no `RepoTerms` type exists, and `cash_borrower` is named up front where the PRD only brings the borrower in at `accept_and_settle` | intended |
| `repay` returns the applied amount | §8 (`PRD.md:558`): `repay(payer, line, amount)` (no return shown) | `repay(...) -> i128`, returning the amount applied (`min(amount, owed)`) (`contracts/credit-line/src/lib.rs:529`) | intended |

One item from the issue's original list is no longer a difference: `release` now requires the
post-release LTV to stay `Healthy`, matching the PRD (fixed in #1116, closing #181).

## Pause scopes

`ballast-common::pause::PauseScope` has four targeted scopes plus an `All` override that `is_paused`
applies to every scope. This is the complete map of what each scope gates, taken from the
`pause::require_not_paused` call sites:

| Scope | Contract | Entry point | Gated |
|---|---|---|---|
| `Pledges` | `pledge-vault` | `pledge` | yes |
| `Draws` | `credit-line` | `draw` | yes |
| `Exits` | `exit-desk` | `exit` | yes |
| `Repos` | `repo-dvp` | `accept_and_settle` | yes |
| `All` | n/a | none; overrides every scope above | n/a |

### Intentionally ungated

These move no new risk, so they stay callable while a scope (or `All`) is paused. PRD §8
invariant 5 ("pausing cannot move funds") requires it.

| Contract | Entry point | Why it is not gated |
|---|---|---|
| `credit-line` | `repay` | Repayment must always work. |
| `credit-line` | `liquidate`, `close_liquidated` | Liquidation must run while paused, or a bad line can never be cleared. |
| `credit-line` | `withdraw_undrawn`, `withdraw_interest` | The lender taking its own capital back out only lowers exposure. |
| `pledge-vault` | `release` | The borrower returning collateral; checked to leave the line healthy when the line still owes something (with zero debt the price and LTV checks are skipped, #182). |
| `pledge-vault` | `liquidate` | The keeper seizing collateral must work while paused. |
| `repo-dvp` | `unwind` | Leg 2 at or after maturity closes the trade and returns collateral. |
| `repo-dvp` | `top_up` | Adds collateral; a borrower must be able to cure a call while paused. |
| `repo-dvp` | `call_margin`, `default_close` | Keeper evaluation and enforcement must keep running. |
| `exit-desk` | `withdraw` | The desk withdrawing its own balance, not a holder's funds. |

Read-only entry points (`quote`, `ltv`, `margin_view` and the other getters) are ungated as well.

### Known gaps

- `repo-dvp::propose` is not gated, although `require_not_paused`'s doc comment treats a new repo as
  new risk. Tracked in #846.
- The gating contracts read pause flags from their own storage and only `Registry::pause` writes a
  flag, so a flag cannot currently be set on the contract that checks it. Tracked in #30 and #32.

## Building

`soroban-sdk` 28.x's build script refuses a plain `cargo build --target wasm32-unknown-unknown`
and requires the Stellar CLI's wrapper instead. From inside a contract's own directory:

```
stellar contract build
```

This produces `../target/wasm32v1-none/release/<crate>.wasm`. `cargo test -p <crate>` (run from
`contracts/`, on the host target) works normally for unit tests and does not need `stellar-cli`.

## Deploying to testnet

See `scripts/README.md`'s "Testnet end-to-end run" section for how to build, deploy, and wire up
all six contracts against the public Stellar testnet.

## `price-guard`'s `publish_nav` — issuer-signature verification (breaking ABI change)

`PriceGuard.publish_nav` now takes an additional `asset_code: Bytes` argument (the asset's ticker,
e.g. `"SPIKO"`, as raw UTF-8 bytes — see the crate's module doc comment) and, when the contract's
`require_nav_signature` flag is `true` (the default), verifies `sig` against the asset's registered
issuer key (`configure_issuer_key`, admin-only) over the canonical message
`"{asset_code}:{ts}:{value}"`, via `env.crypto().ed25519_verify(...)`.

This was a breaking change to `publish_nav`'s call signature. Both `scripts/deploy.sh` and
`scripts/e2e-smoke.sh` have since been updated for it (verified against a real testnet deployment
— see `TESTNET_DEPLOYMENT.md`):

- `scripts/deploy.sh` calls `configure_signature_requirement --admin ... --required false` right
  after `configure_asset` for `price-guard`, since the smoke-test deploy registers no real issuer
  key for its test `RWA1` asset.
- `scripts/e2e-smoke.sh`'s `publish_nav` call now passes `--asset_code` (the hex-encoded UTF-8
  bytes of `"RWA1"`) alongside the existing `ZERO_SIG` placeholder.

`require_nav_signature` defaults to `true` on a fresh deploy (see the crate's module doc comment on
why this flag exists — it's a local-testing/bring-up affordance, not a security control) — a real
testnet/mainnet deploy should call `configure_issuer_key` for every asset before flipping it on if
it was ever turned off, and should leave it at its default `true` otherwise.

## Rotating the price publisher without redeploying

`PriceGuard` stores its roles, so the off-chain publisher can be rotated in place instead of
redeploying the contract. `LastGood`, a `Halted` latch, the configured assets and the registered
issuer keys all survive, and the contract id that consumers store does not change. Use this
instead of `scripts/redeploy-price-guard.sh` when only the publisher key is changing.

Non-admin roles rotate through the same 48h timelock as risk-parameter changes: the admin queues
the change, then anyone may execute it once the delay has elapsed.

```bash
# 1. As admin: queue the new publisher. Prints the change id.
stellar contract invoke --id "$PRICE_GUARD_CID" --network testnet --source admin -- \
  queue_role_change --role '"PricePublisher"' --new_address "$NEW_PUBLISHER"

# 2. After 48h, apply it. Execution is permissionless; `roles` confirms the stored addresses.
stellar contract invoke --id "$PRICE_GUARD_CID" --network testnet --source admin -- \
  execute_role_change --id "$CHANGE_ID"
stellar contract invoke --id "$PRICE_GUARD_CID" --network testnet --source admin -- roles

# 3. If the publisher key is also the NAV attestor (the default wiring — configure-nav-key.sh
#    registers $PRICE_PUBLISHER as the issuer key), register the new raw Ed25519 public key.
#    `publish_nav` verifies `sig` against the registered issuer key, not the price_publisher role,
#    so the new publisher cannot publish NAV until this call lands.
stellar contract invoke --id "$PRICE_GUARD_CID" --network testnet --source admin -- \
  configure_issuer_key --admin "$ADMIN" --asset "$RWA_SAC" --issuer_pubkey "$NEW_PUBLISHER_KEY_HEX"
stellar contract invoke --id "$PRICE_GUARD_CID" --network testnet --source admin -- \
  configure_signature_requirement --admin "$ADMIN" --required true
```

Update `PRICE_PUBLISHER` in `.env.<network>-deploy` before re-running
`scripts/configure-nav-key.sh`, and point the `price-guard` service at the new signing key
(`PRICE_PUBLISHER_SIGNER_MODE` and its KMS/Vault/local key — see `services/price-guard/README.md`).
The admin itself moves with the two-step `propose_admin` / `accept_admin` pair; every other role
uses `queue_role_change` / `execute_role_change`.

## Rotating roles on `Registry`

`Registry` exposes the identical role-rotation interface (`roles`, `propose_admin`, `accept_admin`,
`pending_admin`, `queue_role_change`, `execute_role_change`, `pending_role_change`), so the same
`stellar contract invoke` sequence works against `$REGISTRY_CID`. For example, to rotate the
`pauser` role without redeploying `Registry`:

```bash
# 1. As admin: queue the new pauser. Prints the change id.
stellar contract invoke --id "$REGISTRY_CID" --network testnet --source admin -- \
  queue_role_change --role '"Pauser"' --new_address "$NEW_PAUSER"

# 2. After 48h, apply it and inspect the updated roles.
stellar contract invoke --id "$REGISTRY_CID" --network testnet --source admin -- \
  execute_role_change --id "$CHANGE_ID"
stellar contract invoke --id "$REGISTRY_CID" --network testnet --source admin -- roles
```

To transfer the `Registry` admin role, run `propose_admin --new_admin "$NEW_ADMIN"` signed by the
current admin, then `accept_admin` signed by the proposed successor.

## Timelocked contract upgrades (`Registry` and `PriceGuard`)

`Registry` and `PriceGuard` implement timelocked in-place contract upgrades (`ballast_common::upgrade`) using Soroban's `env.deployer().update_current_contract_wasm(...)`. This enables upgrading contract logic and storage layouts without losing deployed state (`LastGood`, configured assets, latches, haircut configs) and avoids rewiring all six protocol contracts.

### Upgrade Procedure

1. **Upload the new contract Wasm byte code:**
   ```bash
   stellar contract install --wasm target/wasm32v1-none/release/<contract>.wasm --network testnet --source admin
   # Outputs the NEW_WASM_HASH (32-byte hex)
   ```

2. **Admin queues the upgrade:**
   The admin initiates the upgrade proposal. This generates a monotonic upgrade ID, sets `executes_at = now + 48h`, and emits a `queue_upgrade` event.
   ```bash
   stellar contract invoke --id "$CONTRACT_CID" --network testnet --source admin -- \
     queue_upgrade --admin "$ADMIN" --new_wasm_hash "$NEW_WASM_HASH"
   ```

3. **Wait out the 48-hour timelock delay:**
   The PRD §6.2 / §11 mandates a 48-hour timelock window so protocol participants have advance notice to review the incoming code or withdraw capital if they disagree.
   - If an issue or malicious proposal is identified during the delay, the admin can cancel the upgrade:
     ```bash
     stellar contract invoke --id "$CONTRACT_CID" --network testnet --source admin -- \
       cancel_upgrade --admin "$ADMIN" --id "$UPGRADE_ID"
     ```

4. **Execute the upgrade:**
   Once 48 hours have elapsed, any caller can execute the upgrade (execution is permissionless once ready). The contract calls `env.deployer().update_current_contract_wasm(new_wasm_hash)`, clears the pending upgrade, and emits an `execute_upgrade` event. All instance and persistent storage state persists across the upgrade.
   ```bash
   stellar contract invoke --id "$CONTRACT_CID" --network testnet --source admin -- \
     execute_upgrade --id "$UPGRADE_ID"
   ```

### Freeze-after-audit decision

The upgrade entry points are essential during pre-audit development, testnet deployments, and protocol parameter stabilization to safely fix bugs and update storage layouts in place without state loss.

However, once Ballast undergoes external security audit and reaches production maturity, the upgrade capability introduces governance risk if left open indefinitely. The protocol's architectural policy is **freeze-after-audit**:
- After completing the formal security audit and deployment verification on mainnet, upgrade authority will be permanently renounced or burned (e.g. by setting the contract admin to an unspendable burn address or locking the upgrade mechanism).
- Freezing post-audit guarantees immutability, ensuring neither compromised admin keys nor rogue governance actions can replace contract code or drain user collateral, fulfilling Ballast's core security commitments.

