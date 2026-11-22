# CreditLine

The `CreditLine` contract holds lender commitments, draws, repayments, interest accrual, LTV and
margin state, and the liquidation entry points (PRD §6.2, §8). USDC is held in transit only:
funded-but-undrawn between `fund` and `draw`, plus repaid interest waiting for
`withdraw_interest`. See the module doc comment in `src/lib.rs` for what is intentionally
simplified in this pass.

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
