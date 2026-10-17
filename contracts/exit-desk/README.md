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
* **Eligibility**: Enforced via Stellar Asset Contract (SAC) authorization. If the holder is not authorized under SEP-57 / SAC rules, the underlying transfer reverts.

---

## Contract Events

All events are emitted during the transaction that executes the state transition:

| Topic | Topics Tuple | Data Payload | Trigger |
|---|---|---|---|
| `fund` | `(Symbol("fund"), admin_or_keeper: Address)` | `amount: i128` | Emitted when USDC float is topped up |
| `withdraw` | `(Symbol("withdraw"), token: Address)` | `amount: i128` | Emitted when operator withdraws USDC float or RWA inventory |
| `exit` | `(Symbol("exit"), holder: Address, asset: Address)` | `usdc_out: i128` | Emitted upon successful atomic exit |

---

## Panics and Error Conditions

| Condition | Panic Message | Description |
|---|---|---|
| Initialization | `"exit-desk: already initialized"` | Roles have already been set up. |
| Authorization | `"exit-desk: admin argument mismatch"` | Invoked with admin address differing from stored admin. |
| Authorization | Auth check failures | `holder.require_auth()` or `require_admin_or_keeper()` failed. |
| Pause | `"common: paused for scope"` | Contract is paused under `PauseScope::Exits`. |
| Zero/Negative units | `"exit-desk: units must be positive"` | Requested quote or exit with `units <= 0`. |
| Zero/Negative amount | `"exit-desk: amount must be positive"` | `fund` or `withdraw` called with `amount <= 0`. |
| Unconfigured asset | `"exit-desk: asset not configured"` | Asset was not initialized via `configure_asset`. |
| Bad Price Status | `"exit-desk: price is not Ok, refusing to quote"` | PriceGuard returned `Degraded`, `Halted`, or `Stale`. |
| Excessive Spread | `"exit-desk: spread exceeds 100%"` | Configured `spread_bps > 10_000`. |
| Cap validation | `"...cap must be positive"` | Daily or inventory cap configured with value `0`. |
| Token mismatch | `"exit-desk: usdc address mismatch"` | Subsequent `fund` calls used a different USDC token. |
| Unfunded USDC | `"exit-desk: usdc not funded/configured yet"` | `exit` called before `fund` configured the USDC token. |
| Slippage | `"exit-desk: usdc_out below min_usdc_out (slippage)"` | Execution output lower than holder's minimum tolerance. |
| Holder Daily Cap | `"exit-desk: exceeds per-holder daily cap"` | Holder exceeds daily RWA allowance for the UTC day. |
| Desk Inventory Cap| `"exit-desk: exceeds desk inventory cap"` | Total RWA inventory in desk exceeds facility capacity. |

---

## Pause Behavior

`ExitDesk` integrates `ballast_common::pause`:

* The pauser role can pause exits via the common pause mechanism under `PauseScope::Exits`.
* When paused, all calls to `exit(...)` revert immediately with `"common: paused for scope"`.
* `quote(...)` remains operational for informational reads.
