# RepoDvP

The `RepoDvP` contract provides bilateral repos of Real World Asset (RWA) tokens against USDC on Stellar via Soroban with atomic Delivery-versus-Payment (DvP) on leg 1 and scheduled unwind on leg 2 (PRD §5 Phase 3, §8).

## Architecture & Settlement Lifecycle

1. **Proposal**: A cash lender calls `propose` with terms (units, cash amount, interest rate in bps, maturity, agreement hash). The lender pre-authorizes the leg-1 cash transfer via an allowance.
2. **Settlement (Leg 1)**: The cash borrower calls `accept_and_settle`. RWA collateral is escrowed into the contract, USDC is transferred directly from lender to borrower, and leg 2 repayment allowance is pre-authorized.
3. **Margin Monitoring & Top-up**: While settled, positions can be monitored against price fluctuations via `call_margin`. If undercollateralized, a margin call opens with a cure grace deadline. Borrowers can cure by topping up collateral via `top_up` or via price recovery.
4. **Unwind (Leg 2)**: At or past maturity, `unwind` transfers total cash due (principal + interest) to the lender and releases escrowed collateral back to the borrower.
5. **Default**:
   - `default_close`: If a margin call expires uncured, the keeper defaults the trade, transferring collateral to the lender up to exposure and returning surplus to the borrower.
   - `default_at_maturity`: If an unpaid trade remains past `maturity_at + maturity_grace`, the lender or keeper defaults the trade.

---

## Contract Events

The trade-lifecycle entry points publish events with the shape `((Symbol, id), payload)`, listed
below. The asset toggles (`disable`, `enable`, keyed by the asset) and the pause events
(`paused`, `unpause_queued`, `unpause_cancelled`, `unpause_executed`) are listed with their exact
shapes in [`../EVENTS.md`](../EVENTS.md). Admin events are in the second table below.

| Event | Topics | Data | Emitted by | Description |
|---|---|---|---|---|
| `propose` | `(Symbol("propose"), id: u64)` | `(cash_lender: Address, cash_borrower: Address, asset: Address, units: i128, cash_amount: i128, maturity_at: u64)` | `propose` | Published when a new repo trade proposal is created. |
| `cancel` | `(Symbol("cancel"), id: u64)` | `caller: Address` | `cancel_proposal` | Published when a pending proposal is cancelled by the lender or borrower. |
| `settle` | `(Symbol("settle"), id: u64)` | `units: i128` | `accept_and_settle` | Published when the borrower accepts and settles leg 1 of the trade. |
| `unwind` | `(Symbol("unwind"), id: u64)` | `total_due: i128` | `unwind` | Published when leg 2 unwinds successfully at or past maturity. |
| `mcall` | `(Symbol("mcall"), id: u64)` | `margin_call_amount: i128` | `call_margin` | Published when a trade's collateral breaches the margin call threshold. |
| `cured` | `(Symbol("cured"), id: u64)` | `0i128` | `call_margin` | Published when an open margin call is cured via price recovery. |
| `topup` | `(Symbol("topup"), id: u64)` | `(units: i128, cured: bool)` | `top_up` | Published when the borrower adds collateral to top up a trade. |
| `release` | `(Symbol("release"), id: u64)` | `units: i128` | `release_excess` | Published when the borrower takes back excess collateral; the LTV after the release stays under `warning_bps`. |
| `default` | `(Symbol("default"), id: u64)` | `(lender_units: i128, borrower_units: i128)` | `default_close` | Published when an uncured margin call is defaulted by the keeper. |
| `mat_def` | `(Symbol("mat_def"), id: u64)` | `(lender_units: i128, borrower_units: i128)` | `default_at_maturity` | Published when an unpaid trade past maturity grace is defaulted. |

### Admin events

Admin changes publish the new value (and the old one where it is cheap to read), so an auditor or
the ledger service can see when a risk parameter changed without diffing storage:

| Event | Topics | Data | Emitted by | Description |
|---|---|---|---|---|
| `usdc` | `(Symbol("usdc"),)` | `(old_usdc: Option<Address>, new_usdc: Address)` | `set_usdc` | Cash-leg token set or changed. `old_usdc` is `None` on the first call. |
| `curegrace` | `(Symbol("curegrace"),)` | `(old_seconds: u64, new_seconds: u64)` | `set_cure_grace` | Margin-call cure window changed (applies to calls opened from then on). |
| `matgrace` | `(Symbol("matgrace"),)` | `(old_seconds: u64, new_seconds: u64)` | `set_maturity_grace` | Grace after maturity before `default_at_maturity` can act. |
| `cfgasset` | `(Symbol("cfgasset"), asset: Address)` | `(price_guard: Address, haircut_bps: u32, thresholds: MarginThresholds, max_cash_per_trade: i128, max_term_seconds: u64)` | `configure_asset` | Asset risk parameters set; the payload is the full new config. |
| `cfg_q` | `(Symbol("cfg_q"), id: u64)` | `(asset: Address, config: RepoAssetConfig, executes_at: u64)` | `queue_asset_config` | A config change queued behind the 48h timelock (#215). |
| `cfg_exec` | `(Symbol("cfg_exec"), id: u64)` | `asset: Address` | `execute_asset_config` | Queued config applied; a `cfgasset` with the new config is published in the same call. |
| `cfg_canc` | `(Symbol("cfg_canc"), id: u64)` | `asset: Address` | `cancel_asset_config` | Queued config dropped. |

`tighten_asset_config` (risk role) publishes the same `cfgasset` event as `configure_asset`.

## Changing an asset's configuration (48h timelock, #215)

| Change | Path |
|---|---|
| First listing of the asset | `configure_asset` (admin), immediate |
| Same values, a higher haircut, lower thresholds, a lower `max_cash_per_trade` or `max_term_seconds` | `configure_asset` (admin), immediate |
| A higher haircut and/or lower thresholds, keeping guard and caps | `tighten_asset_config` (risk), immediate |
| A different `price_guard`, a lower haircut, any higher threshold or cap | `queue_asset_config` (admin), then `execute_asset_config` (anyone) after 48h; `cancel_asset_config` (admin) until then |

If a change touches several fields and any one of them loosens, the whole change is timelocked, and
`configure_asset` refuses it with `repo-dvp: change loosens the asset config; use queue_asset_config`.
The queued config is a full replacement: it overwrites whatever the asset has when it executes,
including tightening applied in the meantime. `scripts/configure-desks.sh` queues the switch when
the asset already reads a different PriceGuard, and `scripts/e2e-repo-margin.sh` queues its threshold
restore.
