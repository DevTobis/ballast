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
| `credit-line` | Credit lines, draws, repayments, the margin state machine |
| `exit-desk` | [RWA → USDC instant exit](exit-desk/README.md) |
| `repo-dvp` | Bilateral repo, atomic DvP |

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
| `pledge-vault` | `release` | The borrower returning collateral, checked to leave the line healthy. |
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

## Timelocked vs. Immediate Admin, Risk & Pauser Functions (`Registry` and `PriceGuard`)

The tables below document every privileged (`admin`, `risk`, `pauser`, `price_publisher`) and timelock-execution entry point on `Registry` and `PriceGuard`, its required delay (`TIMELOCK_DELAY_SECONDS = 48h`), whether that behaviour is intended or tracked by an open issue, and why each immediate entry point is safe.

### `Registry`

| Function | Who | Delay | Status (Intended / Open) | Rationale & Notes |
|---|---|---|---|---|
| `initialize` | Deployer (one-shot) | Immediate | Intended | Bootstraps initial `Roles` once on a fresh contract instance; panics with `"registry: already initialized"` on any second call. |
| `register_asset` | `admin` | Immediate | Intended | First-time onboarding of a new collateral asset only; panics with `"registry: asset already registered"` if the address already exists, so it cannot overwrite live risk parameters. |
| `queue_param` / `execute_param` | `admin` queues; anyone executes | 48h timelock | Intended | All changes to an existing asset's `haircut_base_bps`, `haircut_fx_bps`, `price_band_bps`, `daily_move_band_bps`, `redemption_lag_days`, or `status` wait 48h so lenders and borrowers can exit before new parameters take effect. |
| `cancel_param` | `admin` | Immediate | Intended | Cancels a pending `ParamChange` before execution, preserving the current live configuration (protective no-op on live state). |
| `raise_haircut_now` | `risk` | Immediate | Intended | Tightening-only emergency control (PRD §6.2): `add_bps` is unsigned (`u32`) and only increases `haircut_base_bps` (capped at `10_000` combined with `haircut_fx_bps`). Reducing a haircut requires the 48h `queue_param` / `execute_param` path. |
| `pause` | `pauser` | Immediate | Intended | Emergency stop only (PRD §6.2): halts `Pledges`, `Draws`, `Exits`, `Repos`, or `All`, while repayments, collateral top-ups, and healthy releases remain open. |
| `queue_unpause` / `execute_unpause` | `admin` queues; anyone executes | 48h timelock | Intended | Lifting a pause re-enables risk-taking operations and therefore requires the 48h notice period. |
| `cancel_unpause` | `admin` | Immediate | Intended | Cancels a queued unpause before execution so the scope remains paused (protective). |
| `queue_role_change` / `execute_role_change` | `admin` queues; anyone executes | 48h timelock | Intended | Rotates non-admin roles (`Pauser`, `Keeper`, `PricePublisher`, `Risk`) after a 48h review window. |
| `propose_admin` / `accept_admin` | `admin` proposes; `new_admin` accepts | Immediate (two-step) | Intended | Two-step ownership handshake prevents accidental transfer to a mistyped or unowned address. |
| `queue_upgrade` / `execute_upgrade` | `admin` queues; anyone executes | 48h timelock | Intended | In-place Wasm upgrade gated by a 48h timelock (and subject to the post-audit freeze policy above). |
| `cancel_upgrade` | `admin` | Immediate | Intended | Allows `admin` to abort a pending Wasm upgrade during the 48h review window. |

### `PriceGuard`

| Function | Who | Delay | Status (Intended / Open) | Rationale & Notes |
|---|---|---|---|---|
| `initialize` | Deployer (one-shot) | Immediate | Intended | Bootstraps initial `Roles` once on a fresh contract instance; panics with `"price-guard: already initialized"` on any second call. |
| `configure_asset` | `admin` | Immediate (initial or tightening only) | Intended (loosening moved to 48h timelock in #99) | Initial per-asset threshold setup and strictly tightening updates (smaller `band_bps` / `daily_move_band_bps` / `window_move_band_bps`, shorter `max_staleness_s`, or longer `window_seconds`) apply immediately; any loosening update panics and must go through `queue_config` / `execute_config`. |
| `configure_issuer_key` | `admin` | Immediate (first registration only) | Intended (key rotation moved to 48h timelock in #99) | First-time registration of an asset's Ed25519 NAV attestor key applies immediately; rotating an existing key to a different `BytesN<32>` panics and must go through `queue_config` / `execute_config`. |
| `configure_signature_requirement` | `admin` | Immediate (initial setup or enabling `true` only) | Intended (disabling moved to 48h timelock in #99) | Enabling `require_nav_signature = true` (tightening) or setting the initial value is immediate; flipping an existing `true` to `false` (loosening) panics and must go through `queue_config` / `execute_config`. |
| `queue_config` / `execute_config` | `admin` queues; anyone executes | 48h timelock | Intended (#99) | Applies loosening `ConfigChange` variants (`BandBps`, `DailyMoveBandBps`, `WindowSeconds`, `WindowMoveBandBps`, `MaxStalenessSeconds`, `Asset`, `IssuerPubKey` rotation, `RequireNavSignature(false)`) after the 48h timelock. |
| `cancel_config` | `admin` | Immediate | Intended (#99) | Cancels a queued loosening `ConfigChange` before execution, keeping the stricter live configuration intact. |
| `remove_source` | `admin` | Immediate | Intended | Evicts a dead or decommissioned feed slot (bounded by the 8-source `SortBuf` cap) and immediately re-evaluates `guarded_price`; if fewer than two fresh sources remain, the asset transitions to `Degraded`. |
| `confirm_halt_cleared` | `risk` | Immediate | Intended | Human-in-the-loop circuit-breaker reset (PRD §6.4): after a move beyond `daily_move_band_bps` or `window_move_band_bps` latches `Halted`, `risk` confirms the move was real market motion and promotes `PendingHaltValue` to `LastGood`. |
| `publish_nav` / `publish_source` | `price_publisher` | Immediate | Intended | Routine oracle feed ingestion; bounded on every call by future-skew checks, `band_bps`, `daily_move_band_bps`, and `window_move_band_bps`. |
| `queue_role_change` / `execute_role_change` | `admin` queues; anyone executes | 48h timelock | Intended | Rotates non-admin roles (`Pauser`, `Keeper`, `PricePublisher`, `Risk`) after a 48h timelock. |
| `propose_admin` / `accept_admin` | `admin` proposes; `new_admin` accepts | Immediate (two-step) | Intended | Two-step admin transfer handshake matching `Registry`. |
| `queue_upgrade` / `execute_upgrade` | `admin` queues; anyone executes | 48h timelock | Intended | In-place Wasm upgrade gated by a 48h timelock. |
| `cancel_upgrade` | `admin` | Immediate | Intended | Aborts a queued Wasm upgrade before execution. |


