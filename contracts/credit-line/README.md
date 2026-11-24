# CreditLine

The `CreditLine` contract holds lender commitments, draws, repayments, interest accrual, LTV and
margin state, and the liquidation entry points (PRD §6.2, §8). USDC is held in transit only:
funded-but-undrawn between `fund` and `draw`, plus repaid interest waiting for
`withdraw_interest`. See the module doc comment in `src/lib.rs` for what is intentionally
simplified in this pass.

## Storage layout

The tables below list the contract's `DataKey` variants and the shared role/pause keys stored by
`ballast-common`. `instance` entries share the contract instance TTL and one instance-size limit;
`persistent` entries have a separate TTL and scale independently.

### Instance storage

| Key | Tier | Written by | Read by | Growth | TTL handling | `#[contracttype]` layout note and value type |
|---|---|---|---|---|---|---|
| `AssetConfig(Address)` | Instance | `configure_asset` | `read_asset_config` (internal helper), used by `draw`, `close_liquidated`, `withdraw_*`, and repayment/price paths | Per asset: constant-size entry per configured asset | Every entry point calls `ttl::extend_instance`; threshold 17,280 ledgers, target 518,400 ledgers | `AssetConfig` struct in field order: `price_guard: Address`, `usdc: Address`, `haircut_bps: u32`, `thresholds: MarginThresholds`; `thresholds` has `warning_bps`, `margin_call_bps`, `liquidation_bps` |
| `NextLineId` | Instance | `open` | `open` | Constant: one monotonic ID counter | Every entry point calls `ttl::extend_instance` | Plain `u64` |
| `Vault` | Instance | `set_vault` | `sync_from_vault` | Constant: one configured address | Every entry point calls `ttl::extend_instance` | Plain `Address` |

No credit-line user or line record is stored in the shared instance entry. `AssetConfig(Address)` entries
do grow with the number of configured assets, and `NextLineId` plus all role/config entries share the
same instance entry TTL. Keeping asset or role state in instance storage is therefore a growth and
shared-lifetime concern even though the credit-line keys themselves do not contain borrower data.

### Persistent storage

| Key | Tier | Written by | Read by | Growth | TTL handling | `#[contracttype]` layout note and value type |
|---|---|---|---|---|---|---|
| `Line(u64)` | Persistent | `open`; `write_line` helper used by `fund`, `sync_from_vault`, `sync_collateral`, `draw`, `repay`, `poke`, `liquidate`, `close_liquidated`, and `withdraw_undrawn` | `read_line` helper used by `asset_of`, `sync_*`, `draw`, `repay`, `ltv`, `poke`, `liquidate`, `close_liquidated`, `withdraw_*`, `claimable_interest`, `liquidation_record`, `line`, `debt_of`, `borrower_of`, and `fund` | Per line | Read/write helpers call `ttl::extend_persistent`; permissionless `extend_ttl(line)` also extends it and the line's optional entries | `Line` struct in field order: `lender`, `borrower`, `asset`, `limit`, `funded`, `drawn`, `pledged_units`, `rate_bps`, `cure_s`, `agreement`, `status`, `last_accrual_ts`, `accrued_interest`, `margin_state`, `breach_ledger`, `breach_ltv_bps`, `unhealthy_since`; `status` is `LineStatus`, `margin_state` is `MarginState` |
| `Claimable(u64)` | Persistent | `repay` and `withdraw_interest`, through `write_claimable` | `read_claimable` through `repay`, `withdraw_interest`, and `claimable_interest` | Per line, only as repayment interest accrues | Read/write helpers extend TTL; `extend_ttl(line)` extends it when present | Plain `i128` |
| `Liquidation(u64)` | Persistent | `liquidate` and `close_liquidated`, through `write_liquidation` | `close_liquidated` and `liquidation_record`, through `read_liquidation` | Per liquidated line | Read/write helpers extend TTL; `extend_ttl(line)` extends it when present | `LiquidationRecord` struct in field order: `seized_units: i128`, `price: i128`, `debt: i128`, `closed: bool`, `recovered: i128`, `surplus: i128`, `shortfall: i128` |

### Shared instance and persistent storage

These keys are owned by `ballast-common` and are also present in each initialized credit-line contract:

| Key | Tier | Written by | Read by | Growth | TTL handling | `#[contracttype]` layout note and value type |
|---|---|---|---|---|---|---|
| `RolesKey::Roles` | Instance | `initialize` / `access::write_roles`; `accept_admin` and `execute_role_change` are shared helpers that update it | `access::read_roles` and role checks used by every role-gated entry point | Constant: five role addresses | Contract entry points call `ttl::extend_instance`; `NextId` and role/timelock keys share the instance or persistent TTL policy | `Roles` struct in field order: `admin`, `pauser`, `keeper`, `price_publisher`, `risk` |
| `RolesKey::PendingAdmin` | Instance | Shared `access::propose_admin`; no pending-admin wrapper is exposed by `CreditLine` itself | Shared `accept_admin` / `pending_admin` helpers; no pending-admin getter is exposed by `CreditLine` itself | Constant: one pending proposal | Contract entry points call `ttl::extend_instance` | `PendingAdmin` struct: `new_admin: Address` |
| `RolesKey::PendingRoleChange(u64)` | Persistent | Shared `access::queue_role_change`; no role-change wrapper is exposed by `CreditLine` itself | Shared `execute_role_change` / `pending_role_change` helpers; no role-change getter is exposed by `CreditLine` itself | Per queued role change | Timelock-specific TTL: threshold 34,560 ledgers and target 155,520 ledgers | `PendingRoleChange` struct in field order: `role: RoleKind`, `new_address: Address`, `executes_at: u64` |
| `TimelockDataKey::NextId` | Instance | Shared `timelock::next_id`; no role-change wrapper invokes it from `CreditLine` itself | Shared `timelock::next_id` | Constant: one monotonic counter | Contract entry points call `ttl::extend_instance` | Plain `u64` |
| `PauseDataKey::Paused(PauseScope)` | Instance | No public pause writer is exposed by `CreditLine`; `pause::set_paused` is shared code used by contracts that expose pause entry points | `pause::is_paused` and `pause::require_not_paused`, including `draw` | Constant per configured `PauseScope`: `Pledges`, `Draws`, `Exits`, `Repos`, `All` | Contract entry points call `ttl::extend_instance` | Plain `bool`; key enum variants are `Pledges`, `Draws`, `Exits`, `Repos`, `All` |

This credit-line instance storage does not contain line state or line-specific data: `Line`,
`Claimable`, and `Liquidation` are per-line persistent entries.

## TTL handling

TTL extension is implemented in current code, contrary to the original text of
[#20](https://github.com/DevTobis/ballast/issues/20). All contract entry points extend instance
TTL; persistent line, claimable, and liquidation reads/writes extend their own entry TTL, and
`extend_ttl(line)` keeps dormant line data alive. Instance and persistent entries use shared
constants of 17,280 ledgers as the threshold and 518,400 ledgers as the target, approximately
one day and 30 days respectively. Timelock entries use a shorter-specific 34,560-ledger threshold
and 155,520-ledger target.

## Upgrade compatibility

Stored types marked `#[contracttype]` use Soroban's typed encoding. Their field and enum variant
order must not be reordered or removed without a migration: existing persistent entries can be
decoded incorrectly or fail to decode after an incompatible upgrade. This applies to `AssetConfig`,
`Line`, `LineStatus`, `MarginState`, `LiquidationRecord`, `Roles`, `PendingAdmin`,
`PendingRoleChange`, `RoleKind`, and `PauseScope`.

## Contract Events

Events follow the same convention as `PledgeVault`: one event per state change, with the shape
`((Symbol, line), payload)`.

| Event | Topics | Data | Emitted by |
|---|---|---|---|
| `undrawn_withdrawn` | `(Symbol("undrawn_withdrawn"), line: u64)` | `(lender: Address, amount: i128, funded_after: i128)` | `withdraw_undrawn` |
| `line_closed` | `(Symbol("line_closed"), line: u64)` | `(debt: i128, recovered: i128, surplus: i128, shortfall: i128)` | `close_liquidated` |
| `liquidation_started` | `(Symbol("liquidation_started"), line: u64)` | `(route: LiquidationRoute, seized_units: i128, price: i128, debt: i128)` | `liquidate` |
| `interest_withdrawn` | `(Symbol("interest_withdrawn"), line: u64)` | `(lender: Address, amount: i128, claimable_after: i128)` | `withdraw_interest` |
| `collateral_synced` | `(Symbol("collateral_synced"), line: u64)` | `(asset: Address, units: i128, source: Symbol)` (`vault` / `keeper` / `admin`) | `sync_from_vault`, `sync_collateral` |
| `margin_state_changed` | `(Symbol("margin_state_changed"), line: u64)` | `(from: MarginState, to: MarginState, ltv_bps: u32, price: i128)` | `poke` |
| `asset_configured` | `(Symbol("asset_configured"), asset: Address)` | `(price_guard: Address, usdc: Address, haircut_bps: u32, thresholds: MarginThresholds)` | `configure_asset` |
| `vault_set` | `(Symbol("vault_set"),)` | `vault: Address` | `set_vault` |

`undrawn_withdrawn` is published after the state write, so `funded_after` is the line's `funded`
figure once the withdrawal has been applied (`funded_before - amount`). A reverted withdrawal
publishes nothing.

## Building and testing

`cargo test -p ballast-credit-line` from `contracts/` runs the unit tests on the host target.
Building the WASM needs `stellar contract build` — see [`../README.md`](../README.md).
