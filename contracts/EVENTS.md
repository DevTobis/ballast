# Contract events reference

This is the reference for every event that `CreditLine` and `PledgeVault` publish, with the exact
payload order and types. It also lists the events that open feature issues propose, marked
**planned**.

## Payload order is a compatibility contract

Off-chain services do not decode these events against a schema. `services/indexer` stores each
event in `chain_event` like this:

- `topic`: the first topic, decoded to a string (the event name)
- `data.topics`: the remaining topics, decoded with `scValToNative`
- `data.value`: the payload, decoded with `scValToNative`. A tuple payload becomes a plain JSON
  array, and `i128`/`u64` values become decimal strings.

Consumers then read fields **by name match on `topic` and by position in `data.value`**. For
example, `services/ledger/src/reconcile.ts` takes the asset from `data.value[0]` and the units from
`data.value[1]` for `pledged`, `released` and `liquidated`.

So the following are breaking changes, even though the contract still compiles and its own tests
still pass:

- renaming a topic symbol
- reordering, removing or inserting a field in a payload tuple
- changing a field's type (for example `i128` to `u64`, or a tuple to a struct)
- changing what a field means (for example from "units moved" to "units after")

Appending a new field at the **end** of a tuple is safe for the consumers listed here, because they
read by index and ignore extra fields. Any other change needs the consumer updated in the same PR,
a row in this file, and a note in [`../CHANGELOG.md`](../CHANGELOG.md). The `#[contractevent]`
migration (issue #821) must keep the field order shown here or ship with consumer changes.

## Conventions

- Shape: `((Symbol(name), key), payload)`. The key is the line id (`u64`) for per-line events.
  Contract-wide config events use a different key, noted per row.
- Each event is published after the state write, so "after" values (`funded_after`,
  `claimable_after`) already include the change.
- A call that panics publishes nothing. Read-only calls publish nothing.
- Enums (`MarginState`, `LiquidationRoute`) are `#[contracttype]` unit variants. `scValToNative`
  decodes them as a one-element array holding the variant name, for example `["Liquidation"]`.

## CreditLine (`contracts/credit-line`)

| Topic | Topic arguments | Payload (in order) | Emitted by | Consumers |
|---|---|---|---|---|
| `asset_configured` | `asset: Address` | `(price_guard: Address, usdc: Address, haircut_bps: u32, thresholds: MarginThresholds)` | `configure_asset` (admin) | indexer (stored only) |
| `vault_set` | none (topic is the 1-tuple `(Symbol,)`) | `vault: Address` (bare value, not a tuple) | `set_vault` (admin) | indexer (stored only) |
| `collateral_synced` | `line: u64` | `(asset: Address, units: i128, source: Symbol)` | `sync_from_vault` (`source = "vault"`), `sync_collateral` (`source = "keeper"` or `"admin"`) | indexer (stored only) |
| `drawn` | `line: u64` | `(amount: i128, to: Address, drawn_total: i128, ltv_bps: u32)` | `draw` (borrower) | indexer (stored only) |
| `repaid` | `line: u64` | `(payer: Address, interest_paid: i128, principal_paid: i128, drawn_after: i128)` | `repay` (any payer) | indexer (stored only) |
| `margin_state_changed` | `line: u64` | `(from: MarginState, to: MarginState, ltv_bps: u32, price: i128)` | `poke`, only when the state changes | indexer (stored only) |
| `liquidation_started` | `line: u64` | `(route: LiquidationRoute, seized_units: i128, price: i128, debt: i128)` | `liquidate` (keeper) | indexer (stored only) |
| `line_closed` | `line: u64` | `(debt: i128, recovered: i128, surplus: i128, shortfall: i128)` | `close_liquidated` (lender) | indexer (stored only) |
| `undrawn_withdrawn` | `line: u64` | `(lender: Address, amount: i128, funded_after: i128)` | `withdraw_undrawn` (lender) | indexer (stored only) |
| `interest_withdrawn` | `line: u64` | `(lender: Address, amount: i128, claimable_after: i128)` | `withdraw_interest` (lender) | indexer (stored only) |

Field notes:

- `MarginThresholds` is the struct `{ warning_bps: u32, margin_call_bps: u32, liquidation_bps: u32 }`
  from `ballast-common`. It decodes as an object keyed by field name, not by position.
- `margin_state_changed.price` and `liquidation_started.price` are the guarded price that
  `read_ltv` used for that call.
- `liquidation_started.debt` is `LtvView.debt` at the moment of seizure. The lender's debt
  recorded in `LiquidationRecord` (and later reported as `line_closed.debt`) leaves out unpaid
  platform fees, so the two values can differ.
- `line_closed`: `recovered = seized_units * price` with no haircut. Then either `surplus > 0` or
  `shortfall > 0`, or both are zero.

`open` and `fund` publish no events today (see planned events below).

## PledgeVault (`contracts/pledge-vault`)

| Topic | Topic arguments | Payload (in order) | Emitted by | Consumers |
|---|---|---|---|---|
| `pledged` | `line: u64` | `(asset: Address, units: i128)` | `pledge` (borrower) | indexer; **ledger reconciler** (`+units`) |
| `lien_recorded` | `line: u64` | `(asset: Address, units: i128, lien_ref: Bytes)` | `record_lien` (gateway) | indexer (stored only) |
| `released` | `line: u64` | `(asset: Address, units: i128)` | `release` (borrower) | indexer; **ledger reconciler** (`-units`) |
| `liquidated` | `line: u64` | `(asset: Address, units: i128, to: Address)` | `liquidate` (keeper) | indexer; **ledger reconciler** (`-units`); off-chain custodian/issuer delivery in lien modes (see the crate README) |

Field notes:

- `units` is the amount moved by this call, not the position total.
- In `IssuerLien` and `CustodianLien` modes, `pledge` adds to `pending_lien_units` rather than
  `units`, but `pledged` is still published with the requested amount. The confirmation shows up
  later as one or more `lien_recorded` events. The reconciler currently counts `pledged` units
  straight away in every mode.
- `lien_ref` is the gateway's opaque reference. `position.lien_ref` keeps only the latest one
  (issue #824), so earlier tranche references can only be recovered from these events.
- `pledge` and `record_lien` also call `CreditLine::sync_from_vault`. As a result, the same
  transaction also contains a `collateral_synced` event from `CreditLine` with `source = "vault"`.

The ledger reconciler (`services/ledger/src/reconcile.ts`) filters `chain_event` on these three
topic names, matches `data.value[0]` against `asset.contract_c`, and parses `data.value[1]` as the
unit delta. If `asset` or `units` moves to another index, every active pledge will show up as a
reconciliation break, and nothing fails at compile time.

## Other consumers

- `services/indexer` (`poller.ts`, `backfill.ts`) stores every event from the configured contracts
  without filtering on topic. It is the source of every `chain_event` row.
- `services/margin-monitor` and `services/keeper` do not read `chain_event` today. They recompute
  margin state from contract reads and Postgres.
- `services/api` webhooks (`webhooks/outbox.ts`) come from Postgres rows (`margin_event`,
  `price_snapshot`, `liquidation`, `tx_intent` and similar), not from on-chain events.

If you add a consumer that reads a payload by index, add it to the Consumers column above.

## Planned events

These come from open feature issues. They are **not emitted yet**. The shapes below are the ones
the issues propose and may change during review. When one lands, move it into the table for its
contract.

| Contract | Topic | Topic arguments | Proposed payload | Emitter | Issue |
|---|---|---|---|---|---|
| CreditLine | `line_opened` | `line: u64` | `(lender: Address, borrower: Address, asset: Address, limit: i128, rate_bps: u32, cure_s: u64)` | `open` | #138 |
| CreditLine | `line_funded` | `line: u64` | `(lender: Address, amount: i128, funded_total: i128)` | `fund` | #137 |
| CreditLine | not named yet | `line: u64` | not specified | `reduce_limit` (new) | #813 |
| PledgeVault | `asset_configured` | per issue (see note) | `(price_guard: Address, credit_line: Address, haircut_bps: u32, thresholds: MarginThresholds, custody_mode: CustodyMode)` | `configure_asset` | #178 |
| PledgeVault | `gateway_set` | none | `gateway: Address` (expected, by analogy with `vault_set`) | `set_gateway` | #178 |
| PledgeVault | not named yet | `line: u64` | includes `reason: Bytes` | `reject_lien` (new) | #179 |

Note on #178: the issue text keys `asset_configured` by `line`, but `configure_asset` takes no line.
`CreditLine`'s `asset_configured` uses `asset: Address` as the key, and the vault event should
probably do the same.

Also tracked: #821 moves `PledgeVault` events to `#[contractevent]` with a documented schema.
