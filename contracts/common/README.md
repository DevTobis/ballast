# ballast-common

`ballast-common` is the shared core library for the Ballast smart contract suite. It is **not itself a deployable contract**, but an internal Rust crate containing access control, asset definitions, margin classification, circuit-breaker pause scopes, price structures, risk mathematics, timelock mechanics, storage TTL policies, and contract upgrade logic shared across all contracts.

---

## Cross-Contract ABI Stability Rule

> [!IMPORTANT]
> **Everything in `ballast-common` is part of the cross-contract ABI.**
> Soroban smart contracts interact using serialized XDR representations of data types. All types marked `#[contracttype]` (`Roles`, `RoleKind`, `AssetConfig`, `CustodyMode`, `MarginState`, `MarginThresholds`, `LiquidationRoute`, `PauseScope`, `PriceStatus`, `GuardedPrice`, etc.) define the wire format between contracts (e.g. `PriceGuardClient` returning `GuardedPrice` to `CreditLine`, `ExitDesk`, and `RepoDvP`, or `PledgeVault` reporting collateral to `CreditLine`).
> 
> Struct field order and enum variant order in `ballast-common` **must never be reordered, inserted into the middle, or deleted** without coordinating a protocol-wide migration. Modifying these definitions will cause cross-contract calls or existing persistent storage reads to fail to decode or decode into corrupted values.

---

## Module Overview and Consumer Matrix

The table below summarizes each module in `ballast-common` and which protocol contracts import and execute its functionality:

| Module | Primary Responsibility | Consuming Contracts |
|---|---|---|
| [`access`](#access) | Role storage, role authentication (`require_auth`), two-step admin transfer, and 48h role rotation | `credit-line`, `exit-desk`, `pledge-vault`, `price-guard`, `registry`, `repo-dvp` (all 6 contracts) |
| [`asset`](#asset) | Shared asset configurations, haircut validation, and parameter change types | `registry`, `pledge-vault`, `integration-tests` |
| [`custody`](#custody) | Shared custody adapter contract address storage (PRD §6.3) | **Unused** (see [Custody note](#custody)) |
| [`margin`](#margin) | Margin state machine (`Healthy`, `Warning`, `MarginCall`, `Liquidation`), thresholds, and route types | `credit-line`, `pledge-vault`, `repo-dvp`, `ltv-view-wire-shape`, `integration-tests` |
| [`pause`](#pause) | Emergency circuit breaker scopes (`Pledges`, `Draws`, `Exits`, `Repos`, `All`) and enforcement gates | `credit-line`, `exit-desk`, `pledge-vault`, `registry`, `repo-dvp` |
| [`price`](#price) | Fixed-point scale (`PRICE_SCALE`), price status enum, and `GuardedPrice` structure | `price-guard`, `credit-line`, `exit-desk`, `pledge-vault`, `repo-dvp`, `ltv-view-wire-shape`, `integration-tests` |
| [`risk`](#risk) | Collateral valuation math, haircut application, and LTV calculation | `credit-line`, `repo-dvp`, `asset` (internal) |
| [`timelock`](#timelock) | 48-hour timelock delay math, monotonic ID generation, and entry TTL extensions | `registry`, `price-guard`, `exit-desk`, `repo-dvp`, `access` (internal), `upgrade` (internal) |
| [`ttl`](#ttl) | Standardized instance (~30 days) and persistent (~30 days) storage TTL extension helpers | `credit-line`, `pledge-vault`, `price-guard`, `registry`, `repo-dvp` |
| [`upgrade`](#upgrade) | 48-hour timelocked in-place contract upgrades via `update_current_contract_wasm` | `price-guard`, `registry` |

---

## Module Details

### `access`

Provides role-based access control and role rotation primitives. A role is enforced by loading its stored address and calling `require_auth()` on it, allowing Soroban's native host authentication framework to enforce caller authorization.

- **Public Items:**
  - `struct Roles { pub admin: Address, pub pauser: Address, pub keeper: Address, pub price_publisher: Address, pub risk: Address }`
  - `enum RoleKind { Pauser, Keeper, PricePublisher, Risk }`
  - `struct PendingAdmin { pub new_admin: Address }`
  - `struct PendingRoleChange { pub role: RoleKind, pub new_address: Address, pub executes_at: u64 }`
  - Functions: `write_roles`, `has_roles`, `read_roles`, `require_admin`, `require_pauser`, `require_keeper`, `require_price_publisher`, `require_risk`, `require_admin_or_keeper`, `propose_admin`, `accept_admin`, `pending_admin`, `role`, `queue_role_change`, `execute_role_change`, `pending_role_change`.
- **Storage Keys Used:**
  - Instance: `RolesKey::Roles`, `RolesKey::PendingAdmin`
  - Persistent: `RolesKey::PendingRoleChange(u64)` (extended with timelock TTL)
- **Panics:**
  - `read_roles`: `"ballast-common: roles not initialized"` if roles have not been set.
  - `accept_admin`: `"ballast-common: no pending admin proposal"` if called without an active proposal.
  - `execute_role_change`: `"ballast-common: no such pending role change"` if the ID does not exist; `"ballast-common: timelock has not elapsed"` if invoked before `executes_at`.
  - `require_admin_or_keeper`: `"ballast-common: caller is neither admin nor keeper"` if caller is neither stored admin nor keeper.
  - Host authorization failure panics on any failed `require_auth()` call.
- **Consuming Contracts:**
  - `contracts/credit-line`
  - `contracts/exit-desk`
  - `contracts/pledge-vault`
  - `contracts/price-guard`
  - `contracts/registry`
  - `contracts/repo-dvp`

---

### `asset`

Defines the canonical asset configuration records, custody modes, and parameter mutation variants representing assets onboarded to the protocol.

- **Public Items:**
  - `enum AssetStandard { ClassicSac, Sep57 }`
  - `enum YieldType { Accumulating, Distributing }`
  - `enum CustodyMode { Escrow, IssuerLien, CustodianLien }`
  - `struct AssetConfig { pub issuer: Address, pub contract: Address, pub standard: AssetStandard, pub yield_type: YieldType, pub custody_mode: CustodyMode, pub ccy: Symbol, pub redemption_lag_days: u32, pub haircut_base_bps: u32, pub haircut_fx_bps: u32, pub price_band_bps: u32, pub daily_move_band_bps: u32, pub status: Symbol }`
  - `enum ParamChange { HaircutBaseBps(u32), HaircutFxBps(u32), PriceBandBps(u32), DailyMoveBandBps(u32), RedemptionLagDays(u32), Status(Symbol) }`
  - `AssetConfig::total_haircut_bps(&self) -> u64` (saturating sum clamped to `10_000` bps)
  - `AssetConfig::validate(&self, env: &Env, asset: &Address) -> Result<(), &'static str>`
- **Storage Keys Used:**
  - None directly defined in `asset`; stored by consuming contracts (e.g., `Registry` stores `AssetConfig` under `DataKey::Asset(Address)`).
- **Validation Errors:**
  - Returns string error slices on validation violations:
    - `"registry: base haircut cannot exceed 100%"`
    - `"registry: FX haircut cannot exceed 100%"`
    - `"registry: total haircut cannot exceed 100%"`
    - `"registry: price band must be between 1 and 10000 bps"`
    - `"registry: daily move band must be between 1 and 10000 bps"`
    - `"registry: asset contract must match asset address"`
    - `"registry: status must be active, paused, or retired"`
- **Consuming Contracts:**
  - `contracts/registry`
  - `contracts/pledge-vault`
  - `contracts/integration-tests`

---

### `custody`

Intended to manage a single shared custody adapter address (PRD §6.3) so that `PledgeVault`, `ExitDesk`, and `RepoDvP` could share a single SEP-57 identity rather than each registering separately with an issuer.

> [!NOTE]
> **Currently Unused:**
> While `custody` defines instance storage helpers, **no contract in the repository currently imports or calls this module**. Contracts currently manage their token interactions and liens directly through their own storage and the Soroban token interface.

- **Public Items:**
  - `write_custody(env: &Env, custody: &Address)`
  - `read_custody(env: &Env) -> Address`
- **Storage Keys Used:**
  - Instance: `CustodyDataKey::Custody`
- **Panics:**
  - `read_custody`: `"ballast-common: custody not set"` if custody has not been written.
- **Consuming Contracts:**
  - *None (currently unused)*

---

### `margin`

Implements the four-state margin classification state machine (`Healthy`, `Warning`, `MarginCall`, `Liquidation`), liquidation route variants, and margin threshold validation.

- **Public Items:**
  - `enum MarginState { Healthy, Warning, MarginCall, Liquidation }`
  - `enum LiquidationRoute { Redeem, Transfer, Rfq }`
  - `struct MarginThresholds { pub warning_bps: u32, pub margin_call_bps: u32, pub liquidation_bps: u32 }`
  - `const MAX_LIQUIDATION_BPS: u32 = 10_000` (100% LTV)
  - `classify(ltv_bps: u32, thresholds: &MarginThresholds) -> MarginState`
  - `MarginThresholds::validate(&self)`
- **Storage Keys Used:**
  - None directly; stored by consuming contracts within their asset or contract configurations.
- **Panics:**
  - `MarginThresholds::validate()` panics if thresholds are zero, unordered, or exceed the maximum:
    - `"margin: warning_bps must be greater than zero"`
    - `"margin: margin_call_bps must be greater than zero"`
    - `"margin: liquidation_bps must be greater than zero"`
    - `"margin: warning_bps must be below margin_call_bps"`
    - `"margin: margin_call_bps must be below liquidation_bps"`
    - `"margin: liquidation_bps cannot exceed 10000 bps (100%)"`
- **Consuming Contracts:**
  - `contracts/credit-line`
  - `contracts/pledge-vault`
  - `contracts/repo-dvp`
  - `contracts/ltv-view-wire-shape`
  - `contracts/integration-tests`

---

### `pause`

Implements circuit-breaker pause flags to immediately stop new risk (PRD §5, §6.2) while guaranteeing that risk-reducing operations (repayment, margin top-ups, liquidations, collateral releases) cannot be blocked (PRD invariant 5).

- **Public Items:**
  - `enum PauseScope { Pledges, Draws, Exits, Repos, All }`
  - `set_paused(env: &Env, scope: &PauseScope, paused: bool)`
  - `is_paused(env: &Env, scope: &PauseScope) -> bool` (`true` if specific scope or `All` is paused)
  - `require_not_paused(env: &Env, scope: &PauseScope)`
- **Storage Keys Used:**
  - Instance: `PauseDataKey::Paused(PauseScope)`
- **Panics:**
  - `require_not_paused`: `"ballast-common: paused"` if the scope or `PauseScope::All` is paused.
- **Consuming Contracts:**
  - `contracts/credit-line` (gates `draw`)
  - `contracts/exit-desk` (gates `exit`)
  - `contracts/pledge-vault` (gates `pledge`)
  - `contracts/registry` (manages global pause flags)
  - `contracts/repo-dvp` (gates `accept_and_settle`)

---

### `price`

Defines the shared fixed-point 7-decimal price format (`PRICE_SCALE`), price freshness and volatility status, and the `GuardedPrice` structure returned by `PriceGuard`.

- **Public Items:**
  - `const PRICE_SCALE: i128 = 10_000_000` (7 decimals, matching Stellar stroop precision)
  - `enum PriceStatus { Ok, Degraded, Halted }`
  - `struct PriceSource { pub name: Symbol, pub value: i128, pub observed_at: u64, pub stale: bool }`
  - `struct GuardedPrice { pub asset: Address, pub value: i128, pub status: PriceStatus, pub ts: u64, pub sources: Vec<PriceSource> }`
  - `GuardedPrice::is_usable_for_new_risk(&self) -> bool` (only `PriceStatus::Ok`)
  - `GuardedPrice::is_usable_for_liquidation(&self) -> bool` (only `PriceStatus::Ok`)
- **Storage Keys Used:**
  - None.
- **Panics:**
  - None.
- **Consuming Contracts:**
  - `contracts/price-guard`
  - `contracts/credit-line`
  - `contracts/exit-desk`
  - `contracts/pledge-vault`
  - `contracts/repo-dvp`
  - `contracts/ltv-view-wire-shape`
  - `contracts/integration-tests`

---

### `risk`

Provides core mathematical risk calculations: collateral haircut deduction and loan-to-value (LTV) calculation.

- **Public Items:**
  - `const BPS_DENOMINATOR: i128 = 10_000`
  - `collateral_value(units: i128, guarded_price: i128, haircut_bps: u32) -> i128`
  - `ltv_bps(debt: i128, collateral_value: i128) -> u32` (returns `0` if debt <= 0; returns `u32::MAX` if collateral <= 0 with positive debt)
  - `validate_haircut_bps(haircut_bps: u32)`
- **Storage Keys Used:**
  - None.
- **Panics:**
  - `collateral_value`: `"haircut exceeds 100%"` if `haircut_bps > 10_000`; `"collateral_value: overflow"` on math overflow.
  - `ltv_bps`: `"ltv_bps: overflow"` on math overflow.
  - `validate_haircut_bps`: `"risk: haircut_bps cannot exceed 10000 bps (100%)"`.
- **Consuming Contracts:**
  - `contracts/credit-line`
  - `contracts/repo-dvp`
  - (`contracts/pledge-vault` no longer values collateral itself; its `release` asks
    `CreditLine::ltv_after`, #180)

---

### `timelock`

Provides standardized 48-hour timelock delay arithmetic, monotonic change identifier allocation, and entry TTL extension logic across protocol contracts.

- **Public Items:**
  - Constants:
    - `TIMELOCK_DELAY_SECONDS: u64 = 172_800` (48 hours)
    - `LEDGER_CLOSE_TIME_SECONDS: u64 = 5`
    - `TIMELOCK_DELAY_LEDGERS: u32 = 34_560` (~48h delay in ledgers)
    - `GRACE_PERIOD_SECONDS: u64 = 604_800` (7 days)
    - `GRACE_PERIOD_LEDGERS: u32 = 120_960` (~7 days in ledgers)
    - `TIMELOCK_EXTEND_TTL_LEDGERS: u32 = 155_520` (delay + grace period target)
    - `TIMELOCK_THRESHOLD_TTL_LEDGERS: u32 = 34_560` (minimum lifetime threshold)
  - Functions:
    - `next_id(env: &Env) -> u64` (increments and returns instance counter)
    - `executes_at(env: &Env) -> u64` (`now + TIMELOCK_DELAY_SECONDS`)
    - `is_ready(env: &Env, executes_at: u64) -> bool` (`now >= executes_at`)
    - `extend_entry_ttl<K>(env: &Env, key: &K)`
- **Storage Keys Used:**
  - Instance: `TimelockDataKey::NextId`
- **Panics:**
  - None.
- **Consuming Contracts:**
  - `contracts/registry`
  - `contracts/price-guard`
  - `contracts/exit-desk`
  - `contracts/repo-dvp`
  - `contracts/common/src/access` (internal)
  - `contracts/common/src/upgrade` (internal)

---

### `ttl`

Provides standardized TTL thresholds and extension targets for instance storage and persistent storage entries across all contracts, preventing state archival on Soroban.

- **Public Items:**
  - Constants:
    - `INSTANCE_LIFETIME_THRESHOLD_LEDGERS: u32 = 17_280` (~1 day threshold)
    - `INSTANCE_EXTEND_TO_LEDGERS: u32 = 518_400` (~30 days extension target)
    - `PERSISTENT_LIFETIME_THRESHOLD_LEDGERS: u32 = 17_280` (~1 day threshold)
    - `PERSISTENT_EXTEND_TO_LEDGERS: u32 = 518_400` (~30 days extension target)
  - Functions:
    - `extend_instance(env: &Env)`
    - `extend_persistent<K>(env: &Env, key: &K)`
- **Storage Keys Used:**
  - None (invokes Soroban `extend_ttl` on instance storage or specified persistent storage keys).
- **Panics:**
  - None.
- **Consuming Contracts:**
  - `contracts/credit-line`
  - `contracts/pledge-vault`
  - `contracts/price-guard`
  - `contracts/registry`
  - `contracts/repo-dvp`

---

### `upgrade`

Provides shared 48-hour timelocked in-place contract upgrade mechanics via Soroban's `update_current_contract_wasm` API.

- **Public Items:**
  - `struct PendingUpgrade { pub new_wasm_hash: BytesN<32>, pub executes_at: u64 }`
  - `queue_upgrade(env: &Env, new_wasm_hash: &BytesN<32>) -> u64`
  - `cancel_upgrade(env: &Env, id: u64)`
  - `execute_upgrade(env: &Env, id: u64) -> BytesN<32>`
  - `pending_upgrade(env: &Env, id: u64) -> Option<PendingUpgrade>`
- **Storage Keys Used:**
  - Persistent: `UpgradeKey::PendingUpgrade(u64)` (extended with timelock TTL)
- **Panics:**
  - `cancel_upgrade`: `"ballast-common: no such pending upgrade"` if ID not found.
  - `execute_upgrade`: `"ballast-common: no such pending upgrade"` if ID not found; `"ballast-common: timelock has not elapsed"` if invoked before `executes_at`.
- **Consuming Contracts:**
  - `contracts/price-guard`
  - `contracts/registry`
