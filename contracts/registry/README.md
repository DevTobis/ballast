# Registry

The `Registry` contract holds each asset's `AssetConfig`, the timelocked parameter changes, and the
pause switches. It holds no funds.

## Contract Events

Every state-changing entry point publishes one event in the same transaction, so parameter changes,
haircut raises and pauses can be followed without diffing `asset()` snapshots. Topics are stable
names; the second topic is the key to filter on.

| Event | Topics | Data | Emitted by |
|---|---|---|---|
| `asset_registered` | `(Symbol("asset_registered"), asset: Address)` | `config: AssetConfig` | `register_asset` |
| `param_queued` | `(Symbol("param_queued"), id: u64)` | `(asset: Address, change: ParamChange, executes_at: u64)` | `queue_param` |
| `param_executed` | `(Symbol("param_executed"), id: u64)` | `(asset: Address, change: ParamChange, config: AssetConfig)` (the config after the change) | `execute_param` |
| `param_cancelled` | `(Symbol("param_cancelled"), id: u64)` | `asset: Address` | `cancel_param` |
| `haircut_raised` | `(Symbol("haircut_raised"), asset: Address)` | `(add_bps: u32, new_haircut_base_bps: u32)` | `raise_haircut_now` |
| `paused` | `(Symbol("paused"), scope: PauseScope)` | `true` | `pause` |
| `unpause_queued` | `(Symbol("unpause_queued"), id: u64)` | `(scope: PauseScope, executes_at: u64)` | `queue_unpause` |
| `unpause_executed` | `(Symbol("unpause_executed"), id: u64)` | `scope: PauseScope` | `execute_unpause` |
| `unpause_cancelled` | `(Symbol("unpause_cancelled"), id: u64)` | `scope: PauseScope` | `cancel_unpause` |

`executes_at` is a ledger timestamp in seconds. Indexers should subscribe to these topic names.

## Timelock Cancellation

Queued parameter changes (`queue_param`) and unpauses (`queue_unpause`) can be cancelled by the stored `admin` before execution via `cancel_param(admin, id)` and `cancel_unpause(admin, id)`. Cancellation removes the persistent storage entry immediately so that subsequent calls to `execute_param(id)`, `execute_unpause(id)`, or a second cancel fail with `"registry: no such pending change"` / `"registry: no such pending unpause"`.
