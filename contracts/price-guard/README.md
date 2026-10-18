# PriceGuard

The `PriceGuard` contract protects Ballast lending, credit lines, repos, and exit desks against oracle manipulation, stale feeds, and extreme market moves (PRD §6.2, §6.4, §8).

The guard enforces median, band, staleness, and halt latch rules across at least two fresh, agreeing independent sources before any draw, exit, repo, or liquidation can proceed.

---

## Contract Events

To support real-time monitoring (PRD §11 alerts for `Degraded` and `Halted` states) and off-chain indexing (`services/indexer` populating `price_snapshot.ledger`), `PriceGuard` emits granular events in the same transaction as each state transition or configuration update.

### Events Catalog

| Event Name | Topics Tuple | Data Payload | Emitted By | Description |
|---|---|---|---|---|
| `configure_asset` | `(Symbol("configure_asset"), asset: Address)` | `(band_bps: u32, daily_move_band_bps: u32, max_staleness_s: u64)` | `configure_asset` | Emitted when an asset's guard thresholds and staleness bounds are configured or updated. |
| `configure_issuer_key` | `(Symbol("configure_issuer_key"), asset: Address)` | `issuer_pubkey: BytesN<32>` | `configure_issuer_key` | Emitted when an asset's Ed25519 issuer public key is registered or rotated. |
| `configure_signature_requirement` | `(Symbol("configure_signature_requirement"),)` | `required: bool` | `configure_signature_requirement` | Emitted when the global signature verification toggle is flipped. |
| `nav_published` | `(Symbol("nav_published"), asset: Address)` | `(source: Symbol, value: i128, ts: u64)` | `publish_nav` | Emitted when an issuer-signed NAV reading is published. |
| `source_published` | `(Symbol("source_published"), asset: Address)` | `(source: Symbol, value: i128, ts: u64)` | `publish_source` | Emitted when a secondary oracle feed (e.g., RedStone, redemption price) is published. |
| `status_changed` | `(Symbol("status_changed"), asset: Address)` | `(from: PriceStatus, to: PriceStatus, value: i128)` | `evaluate` | Emitted whenever evaluation produces a `PriceStatus` differing from the previous status (`Ok`, `Degraded`, or `Halted`). |
| `halt_latched` | `(Symbol("halt_latched"), asset: Address)` | `(last_good: i128, pending: i128)` | `evaluate` | Emitted when a sudden price move exceeds `daily_move_band_bps`, latching a sticky halt. |
| `halt_cleared` | `(Symbol("halt_cleared"), asset: Address)` | `new_last_good: i128` | `confirm_halt_cleared` | Emitted when risk operators confirm a legitimate market move and clear the halt. |

---

## Topic Indexing & Off-Chain Ingestion

- **Asset Filtering**: All asset-scoped events place `asset: Address` as the second topic element `(topic[1])`, allowing indexers and RPC subscribers to filter events per asset without decoding data payloads.
- **Status State Machine**:
  - `PriceStatus::Ok`: Sufficient fresh sources agreeing within `band_bps` and within `daily_move_band_bps`.
  - `PriceStatus::Degraded`: Fewer than 2 fresh sources, or sources disagree beyond `band_bps`.
  - `PriceStatus::Halted`: Daily move exceeds `daily_move_band_bps`. Requires human risk confirmation via `confirm_halt_cleared`.
- **Halt Cycle**:
  1. `evaluate` identifies a jump $> \text{daily\_move\_band\_bps}$ against `LastGood`.
  2. Emits `halt_latched(asset)` with `(last_good, pending)`.
  3. Emits `status_changed(asset)` with `(from: Ok, to: Halted, value: last_good)`.
  4. Operator verifies off-chain and calls `confirm_halt_cleared(risk, asset)`.
  5. Emits `halt_cleared(asset)` with `new_last_good`.
  6. `confirm_halt_cleared` only clears the latch; the next publish re-evaluates and emits `status_changed(asset)` with `(from: Halted, to: Ok, ...)`.
