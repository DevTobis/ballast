# RepoDvp Events & Storage Reference

## Events Reference

Every state change in `RepoDvp` publishes events with short topics (`symbol_short!`, <= 9 chars) so auditors, indexers, and services can trace contract mutations.

| Event | Topics | Payload / Data | Emitted By | Description |
|---|---|---|---|---|
| `usdc` | `(symbol_short!("usdc"),)` | `(Option<Address>, Address)` | `set_usdc` | USDC settlement token configured: `(old_usdc, new_usdc)` |
| `curegrace` | `(symbol_short!("curegrace"),)` | `(u64, u64)` | `set_cure_grace` | Margin call cure window updated: `(old_grace_seconds, new_grace_seconds)` |
| `cfgasset` | `(symbol_short!("cfgasset"), asset: Address)` | `(Address, u32, MarginThresholds)` | `configure_asset` | Asset risk parameters configured: `(price_guard, haircut_bps, thresholds)` |
| `disable` | `(symbol_short!("disable"), asset: Address)` | `()` | `disable_asset` | Asset disabled for new trades |
| `enable` | `(symbol_short!("enable"), asset: Address)` | `()` | `enable_asset` | Asset re-enabled |
| `propose` | `(symbol_short!("propose"), id: u64)` | `(Address, Address, Address, i128, i128, u64)` | `propose` | New repo trade proposed |
| `cancel` | `(symbol_short!("cancel"), id: u64)` | `Address` | `cancel_proposal` | Proposal cancelled by lender or borrower |
| `settle` | `(symbol_short!("settle"), id: u64)` | `i128` | `accept_and_settle` | Proposal accepted and settled: `units` |
| `unwind` | `(symbol_short!("unwind"), id: u64)` | `i128` | `unwind` | Trade unwound at maturity: `total_due` |
| `mcall` | `(symbol_short!("mcall"), id: u64)` | `i128` | `call_margin` | Margin call opened: `margin_call_amount` |
| `cured` | `(symbol_short!("cured"), id: u64)` | `i128` | `call_margin` | Margin call cured by price recovery |
| `topup` | `(symbol_short!("topup"), id: u64)` | `(i128, bool)` | `top_up` | Collateral topped up: `(extra_units, cured)` |
| `release` | `(symbol_short!("release"), id: u64)` | `i128` | `release_excess` | Excess collateral released by borrower: `units` |
| `default` | `(symbol_short!("default"), id: u64)` | `(i128, i128)` | `default_close` | Margin call default closed: `(lender_units, borrower_units)` |
| `mat_def` | `(symbol_short!("mat_def"), id: u64)` | `(i128, i128)` | `default_at_maturity` | Maturity default closed: `(lender_units, borrower_units)` |
| `paused` | `(Symbol("paused"), scope: PauseScope)` | `bool` | `pause` | Pause state set for scope |
| `unpause_queued` | `(Symbol("unpause_queued"), id: u64)` | `(PauseScope, u64)` | `queue_unpause` | Unpause queued with timelock: `(scope, executes_at)` |
| `unpause_cancelled` | `(Symbol("unpause_cancelled"), id: u64)` | `PauseScope` | `cancel_unpause` | Pending unpause cancelled |
| `unpause_executed` | `(Symbol("unpause_executed"), id: u64)` | `PauseScope` | `execute_unpause` | Unpause executed after timelock |
