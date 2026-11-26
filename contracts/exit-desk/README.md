# ExitDesk

The `ExitDesk` contract provides instant, atomic conversion of Real World Asset (RWA) tokens to USDC on Stellar via Soroban (PRD §5 Phase 2, §8).

Holders swap their RWA tokens for USDC in a single transaction without multi-day settlement delays or custody risk. The desk calculates quotes using a real-time guarded price minus a configurable spread, drawing USDC liquidity from a managed facility float.

---

## Architecture & Settlement Lifecycle

1. **Atomic Settlement**: An exit swap is executed in a single atomic transaction. The user's RWA tokens are transferred to the desk, and USDC is transferred from the desk float to the designated recipient (`to`). If either transfer fails, the entire transaction reverts.
2. **Zero Custody Invariant**: No user funds are held by the contract across transactions. At rest, the desk holds only its own operating capital: its USDC float and accumulated RWA inventory.
3. **Decoupled Pricing**: The contract queries `PriceGuard` dynamically via cross-contract calls using the asset's configured `price_guard` address. Only `PriceStatus::Ok` prices are accepted for quoting and settlement.

---

## Quote Calculation & Mathematics

Quotes are calculated using 7-decimal fixed-point arithmetic (`PRICE_SCALE = 10_000_000`, 1 stroop = $0.0000001) and basis points (`BPS_DENOMINATOR = 10_000`, 1 bps = 0.01%).

### Formula

1. **Spread-Adjusted Price**:
   $$\text{price} = \left\lfloor \frac{\text{guarded\_price} \times (10{,}000 - \text{spread\_bps})}{10{,}000} \right\rfloor$$

2. **USDC Output**:
   $$\text{usdc\_out} = \left\lfloor \frac{\text{units} \times \text{price}}{\text{PRICE\_SCALE}} \right\rfloor$$

3. **Quote Expiration**:
   $$\text{expires\_at} = \text{ledger\_timestamp} + 60 \quad (\text{TTL} = 60\text{ seconds})$$

### Rounding Direction

Both price adjustment and USDC calculation use integer division (`/`), truncating toward zero (floor for positive integers). This guarantees that fractional stroops never cause the desk to pay out more USDC than the exact mathematical entitlement.

### Worked Numeric Example

Matches `quote_with_ok_price_applies_spread` in `contracts/exit-desk/src/test.rs`:

* **Asset Guarded Price**: $1.00 (`10_000_000` stroops) with `PriceStatus::Ok`
* **Configured Spread**: `spread_bps = 100` (1.00%, or 100 bps)
* **Exit Amount**: `units = 100 * PRICE_SCALE = 1_000_000_000` (100 RWA tokens)

**Calculation**:
1. Compute per-unit price:
   $$\text{price} = \frac{10{,}000{,}000 \times (10{,}000 - 100)}{10{,}000} = \frac{10{,}000{,}000 \times 9{,}900}{10{,}000} = 9{,}900{,}000 \quad (\$0.99)$$
2. Compute total USDC output:
   $$\text{usdc\_out} = \frac{1{,}000{,}000{,}000 \times 9{,}900{,}000}{10{,}000{,}000} = 990{,}000{,}000 \quad (99.0000000\text{ USDC})$$
3. Validity window:
   If generated at ledger timestamp `1_700_000_000`, `expires_at` is `1_700_000_060`.

---

## Caps and Limit Semantics

> **IMPORTANT**: All caps are denominated strictly in **RWA token units** (stroops, 7 decimals), not in USDC or USD value.

### 1. Per-Holder Daily Cap (`per_holder_daily_cap`)

* **Storage Key**: `DataKey::DailyUsed(holder, asset, day_bucket)`
* **Bucket Calculation**:
  $$\text{day\_bucket} = \left\lfloor \frac{\text{ledger\_timestamp}}{86{,}400} \right\rfloor$$
* **Mechanism**:
  - Partitions usage into 86,400-second UTC calendar day buckets (resetting at 00:00:00 UTC).
  - Each exit by a holder increments `daily_used` by `units`.
  - If `new_daily_used > per_holder_daily_cap`, the transaction panics with:
    `"exit-desk: exceeds per-holder daily cap"`.
  - Resets automatically upon rolling into the next UTC day.

### 2. Desk Inventory Cap (`desk_inventory_cap`)

* **Storage Key**: `DataKey::Inventory(asset)`
* **Mechanism**:
  - Tracks total net RWA units accumulated by the desk across all exits.
  - Each exit increments desk inventory by `units`.
  - If `new_inventory > desk_inventory_cap`, the transaction panics with:
    `"exit-desk: exceeds desk inventory cap"`.
  - Withdrawing RWA inventory via `withdraw` decrements this counter by `min(amount, held)`, restoring available capacity under the inventory cap.

---

## Operator Procedures

These steps align directly with the deployment and operations workflow in `scripts/configure-desks.sh`.

### 1. Configure Asset Parameters

Registers an RWA asset with its pricing guard, spread, and risk caps:

```bash
UNIT=10000000 # 7 decimals (1 token)

stellar contract invoke \
  --id "$EXIT_DESK_CID" \
  --source admin \
  --network "$NETWORK" \
  -- configure_asset \
  --admin "$ADMIN" \
  --asset "$RWA_SAC" \
  --price_guard "$PRICE_GUARD_CID" \
  --spread_bps 25 \
  --per_holder_daily_cap $((10000 * UNIT)) \
  --desk_inventory_cap $((1000000 * UNIT))
```

* `--spread_bps 25`: 0.25% exit fee.
* `--per_holder_daily_cap`: Maximum 10,000 RWA units per holder per UTC day.
* `--desk_inventory_cap`: Maximum 1,000,000 RWA units accumulated before operator rebalance is required.

#### Changing an existing asset's configuration (48h timelock)

`configure_asset` applies immediately only when the change cannot make exits pay out more:

| Change | Path |
|---|---|
| First listing of the asset | `configure_asset`, immediate |
| Same values (re-running the script) | `configure_asset`, immediate |
| Wider spread (`spread_bps` up), lower `per_holder_daily_cap` or `desk_inventory_cap` | `configure_asset`, immediate |
| Different `price_guard` | `queue_configure_asset`, then `execute_configure_asset` after 48h |
| Narrower spread (`spread_bps` down) | timelocked, as above |
| Higher `per_holder_daily_cap` or `desk_inventory_cap` | timelocked, as above |

If a call changes several fields and any one of them loosens, the whole change is timelocked.
`configure_asset` refuses it with
`exit-desk: change loosens price_guard, spread or caps; use queue_configure_asset`.

Why: without the delay, an admin key compromise could point `price_guard` at a contract that
returns an inflated price. An accomplice could then exit RWA units for far more USDC than they
are worth and drain the float in one transaction. The delay and the `cfg_q` event give operators
48 hours to notice, `pause` exits and call `cancel_configure_asset`.

```bash
# Queue (admin). Returns the id.
stellar contract invoke --id "$EXIT_DESK_CID" --source admin --network "$NETWORK" \
  -- queue_configure_asset --admin "$ADMIN" --asset "$RWA_SAC" \
  --price_guard "$NEW_PRICE_GUARD_CID" --spread_bps 25 \
  --per_holder_daily_cap $((10000 * UNIT)) --desk_inventory_cap $((1000000 * UNIT))

# Inspect while pending (anyone).
stellar contract invoke --id "$EXIT_DESK_CID" --network "$NETWORK" -- pending_config --id "$ID"

# After 48h (anyone).
stellar contract invoke --id "$EXIT_DESK_CID" --source admin --network "$NETWORK" \
  -- execute_configure_asset --id "$ID"

# Or drop it before it executes (admin).
stellar contract invoke --id "$EXIT_DESK_CID" --source admin --network "$NETWORK" \
  -- cancel_configure_asset --admin "$ADMIN" --id "$ID"
```

The queued config is a full replacement. On execution it overwrites whatever the asset has at that
point, including any tightening applied with `configure_asset` in the meantime. Validation (spread
below 100%, positive caps) runs when the change is queued.

Residual risk: the **first** listing of an asset is still immediate. There is no previous config to
compare against, and `scripts/configure-desks.sh` needs the listing to apply at deploy time. The
float is shared across assets, so a compromised admin key could still list a new asset with a
hostile `price_guard`. Watch for unexpected first-time `configure_asset` calls.

### 2. Fund the USDC Float

Supplies USDC liquidity to satisfy exits. The first `fund` call records the canonical USDC token address for the contract:

```bash
stellar contract invoke \
  --id "$EXIT_DESK_CID" \
  --source admin \
  --network "$NETWORK" \
  -- fund \
  --admin_or_keeper "$ADMIN" \
  --usdc "$USDC_SAC" \
  --amount $((5000 * UNIT))
```

* Authorized caller: `admin` or `keeper`.
* Transfers USDC from caller into `ExitDesk`.

### 3. Rebalance Inventory and Withdraw Funds

The operator can withdraw either excess USDC float or accumulated RWA inventory. Admin only:

```bash
stellar contract invoke \
  --id "$EXIT_DESK_CID" \
  --source admin \
  --network "$NETWORK" \
  -- withdraw \
  --admin "$ADMIN" \
  --token "$RWA_SAC" \
  --amount $((10000 * UNIT)) \
  --to "$ADMIN"
```

* When `token` is an RWA asset with an active `AssetConfig`, withdrawing automatically reduces `Inventory(token)`, freeing up headroom under `desk_inventory_cap`.
* Withdrawing USDC float does not affect RWA inventory caps.

---

## User & Integrator Flow

### 1. Requesting a Quote (`quote`)

Read-only entry point (no auth or transaction signature required):

```rust
pub fn quote(env: Env, asset: Address, units: i128) -> ExitQuote
```

Returns:
* `asset`: Address of the RWA token.
* `units`: Exited token amount.
* `price`: Effective price after spread deduction (7 decimals).
* `spread_bps`: Applied spread in basis points.
* `usdc_out`: Estimated USDC payout.
* `expires_at`: Expiration timestamp (`ledger_timestamp + 60`).

### 2. Executing an Exit (`exit`)

Atomic execution entry point:

```rust
pub fn exit(
    env: Env,
    holder: Address,
    asset: Address,
    units: i128,
    min_usdc_out: i128,
    to: Address,
) -> i128
```

* **Authentication**: Requires `holder.require_auth()`.
* **Slippage Protection**: Panics if recomputed `quote.usdc_out < min_usdc_out`.
* **Flexible Destination (`to`)**: Allows routing the USDC proceeds to any address (e.g., an anchor operator account for fiat offramping).
* **Eligibility**: Enforced via Stellar Asset Contract (SAC) authorization. If the issuer's own controls (SAC authorization or the SEP-57 token's rules) reject the holder, the underlying transfer reverts.
* **Float check**: Before the holder's RWA is transferred, the desk's own USDC balance is compared with the payout. If it is smaller, the call panics with `"exit-desk: insufficient USDC float"` and nothing moves.

### 3. Checking the Float (`available_usdc`)

Read-only entry point (no auth or transaction signature required):

```rust
pub fn available_usdc(env: Env) -> i128
```

Returns the USDC the desk can pay exits from right now: its balance of the configured USDC token, or `0` while no USDC token has been set. A quote can be paid if `quote.usdc_out <= available_usdc()`. Like a quote, it is a read: the float can change before an exit lands, and `exit` checks it again.

---

## Contract Events

All events are emitted during the transaction that executes the state transition:

| Topic | Topics Tuple | Data Payload | Trigger |
|---|---|---|---|
| `fund` | `(Symbol("fund"), admin_or_keeper: Address)` | `amount: i128` | Emitted when USDC float is topped up |
| `withdraw` | `(Symbol("withdraw"), token: Address)` | `amount: i128` | Emitted when operator withdraws USDC float or RWA inventory |
| `exit` | `(Symbol("exit"), holder: Address, asset: Address)` | `usdc_out: i128` | Emitted upon successful atomic exit |
| `cfg_q` | `(Symbol("cfg_q"), id: u64)` | `(asset: Address, config: AssetConfig, executes_at: u64)` | `queue_configure_asset` |
| `cfg_exec` | `(Symbol("cfg_exec"), id: u64)` | `(asset: Address, config: AssetConfig)` | `execute_configure_asset` |
| `cfg_canc` | `(Symbol("cfg_canc"), id: u64)` | `asset: Address` | `cancel_configure_asset` |

---

## Panics and Error Conditions

| Condition | Panic Message | Description |
|---|---|---|
| Initialization | `"exit-desk: already initialized"` | Roles have already been set up. |
| Authorization | `"exit-desk: admin argument mismatch"` | Invoked with admin address differing from stored admin. |
| Authorization | Auth check failures | `holder.require_auth()` or `require_admin_or_keeper()` failed. |
| Pause | `"ballast-common: paused"` | Contract is paused under `PauseScope::Exits`. |
| Zero/Negative units | `"exit-desk: units must be positive"` | Requested quote or exit with `units <= 0`. |
| Zero/Negative amount | `"exit-desk: amount must be positive"` | `fund` or `withdraw` called with `amount <= 0`. |
| Unconfigured asset | `"exit-desk: asset not configured"` | Asset was not initialized via `configure_asset`. |
| Bad Price Status | `"exit-desk: price is not Ok, refusing to quote"` | PriceGuard returned `Degraded` or `Halted`. |
| Excessive Spread | `"exit-desk: spread must be below 100%"` | Configured `spread_bps >= 10_000`. |
| Zero payout | `"exit-desk: usdc_out is zero, amount too small to exit"` | `exit` for an amount whose floored payout is `0`. `quote` still returns, with `usdc_out = 0`. |
| Cap validation | `"...cap must be positive"` | Daily or inventory cap configured with value `0`. |
| Loosening change | `"exit-desk: change loosens price_guard, spread or caps; use queue_configure_asset"` | `configure_asset` on an already-configured asset with a new `price_guard`, a lower spread or a higher cap. |
| Unknown queued config | `"exit-desk: no such pending config"` | `execute_configure_asset` / `cancel_configure_asset` with an id that was never queued, already ran or was cancelled. |
| Early execution | `"exit-desk: timelock has not elapsed"` | `execute_configure_asset` (or `execute_unpause`) before 48h. |
| Token mismatch | `"exit-desk: usdc address mismatch"` | Subsequent `fund` calls used a different USDC token. |
| USDC not set | `"exit-desk: usdc not configured"` | `exit` or `fund` called before `set_usdc` recorded the USDC token. |
| Insufficient float | `"exit-desk: insufficient USDC float"` | `exit` whose payout is larger than the desk's USDC balance. Checked before the holder's RWA moves. |
| Slippage | `"exit-desk: usdc_out below min_usdc_out (slippage)"` | Execution output lower than holder's minimum tolerance. |
| Holder Daily Cap | `"exit-desk: exceeds per-holder daily cap"` | Holder exceeds daily RWA allowance for the UTC day. |
| Desk Inventory Cap| `"exit-desk: exceeds desk inventory cap"` | Total RWA inventory in desk exceeds facility capacity. |

---

## Pause Behavior

`ExitDesk` integrates `ballast_common::pause`:

* The pauser role can pause exits via the common pause mechanism under `PauseScope::Exits`.
* When paused, all calls to `exit(...)` revert immediately with `"ballast-common: paused"`.
* `quote(...)` remains operational for informational reads.
