#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]

//! `CreditLine` (PRD §6.2, §8): lender commitments, draws, repayments, interest accrual, LTV
//! computation, the margin state machine, and the liquidation entry point. Holds USDC "in transit
//! only" (PRD §6.2): funded-but-undrawn USDC sits here between `fund` and `draw`; nothing else
//! accumulates in this contract.
//!
//! **Documented simplification — haircut/margin config.** Per-asset PriceGuard address, USDC
//! token address, haircut and margin thresholds are set directly by the admin via
//! `configure_asset`, rather than cross-called from `Registry` (being rewritten concurrently by
//! another agent, not stable to depend on in this pass). A later integration pass would sync
//! these from `Registry` instead of duplicating admin input here.
//!
//! **Collateral sync.** `PledgeVault` reports a line's units through `sync_from_vault` in the same
//! transaction as every pledge, release, lien confirmation and liquidation, so `pledged_units`
//! moves with the vault's balance. (It used to change only when the keeper ran `sync_collateral`,
//! which let a borrower release collateral and draw against it inside the window before the next
//! sync.) `sync_collateral` remains, keeper/admin-gated, as a reconciliation path that sets the
//! figure to the vault's own balance; the dependency runs one way only (`PledgeVault` calls this
//! contract; this contract never calls the vault), so there is no circular call.
//!
//! **Documented wiring gap — liquidation.** `liquidate` here only flips the line's status to
//! `Liquidating` after confirming a two-read breach (PRD §8 invariant 3); it does not itself move
//! collateral. That's `PledgeVault::liquidate`, a separate keeper-only call — see that function's
//! doc comment. A fully wired system would have this function call it cross-contract
//! automatically; that dependency isn't set up in this pass (this crate deliberately doesn't take
//! a Cargo dependency on `pledge-vault`), so an off-chain keeper service is expected to call both
//! `CreditLine::liquidate` and `PledgeVault::liquidate`. This is the least clean part of this
//! skeleton.
//!
//! **Invariant 6** ("the admin cannot move user funds"): every function that moves USDC out of
//! this contract (`draw`) or pulls funds in from a specific party (`fund`, `repay`) requires
//! `require_auth` on the actual borrower/lender/payer address named in the call — never the
//! admin's. There is no `admin_withdraw`/`sweep`-style function anywhere in this contract. See
//! the `admin_cannot_substitute_for_borrower_auth` test below.
//!
//! **TTL Management and Archival Prevention**:
//! Instance storage (roles, asset config, next line id, vault address) and persistent storage
//! (`Line`, `Claimable`, `Liquidation`) use shared TTL thresholds and targets from `ballast_common::ttl`:
//! - `INSTANCE_LIFETIME_THRESHOLD_LEDGERS` (~1 day / 17,280 ledgers) & `INSTANCE_EXTEND_TO_LEDGERS` (~30 days / 518,400 ledgers)
//! - `PERSISTENT_LIFETIME_THRESHOLD_LEDGERS` (~1 day / 17,280 ledgers) & `PERSISTENT_EXTEND_TO_LEDGERS` (~30 days / 518,400 ledgers)
//! Every contract entry point calls `ttl::extend_instance(&env)` to ensure the contract instance never expires.
//! Every read and write to `Line`, `Claimable`, and `Liquidation` extends entry persistent TTL.
//! In addition, a public `extend_ttl(line)` entry point allows anyone (including keepers or users) to extend
//! the TTL of a dormant credit line before it archives.
//!
//! **Events.** Like `PledgeVault`, state changes publish one event with the shape
//! `((Symbol, line), payload)`: `line_closed` from `close_liquidated` and `undrawn_withdrawn` from
//! `withdraw_undrawn` (which moves the lender's funded exposure and so needs an on-chain trace for
//! the console and indexer). See `README.md`'s events table for the exact topics and payloads.

use ballast_common::{
    access::{self, Roles},
    margin::{self, LiquidationRoute, MarginState, MarginThresholds},
    pause::{self, PauseScope},
    price::{GuardedPrice, PriceStatus},
    risk, ttl,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, BytesN, Env, MuxedAddress,
    Symbol,
};

const SECONDS_PER_YEAR: i128 = 365 * 24 * 60 * 60;
const BPS_DENOMINATOR: i128 = 10_000;

/// Cross-contract call to PriceGuard, declared as a local trait so CreditLine never takes a
/// Cargo dependency on the price-guard crate (being rewritten concurrently by another agent).
#[contractclient(name = "PriceGuardClient")]
pub trait PriceGuardInterface {
    fn guarded_price(env: Env, asset: Address) -> GuardedPrice;
}

fn muxed(addr: &Address) -> MuxedAddress {
    MuxedAddress::from(addr)
}

/// PRD §8: `fn ltv(e: Env, line: u64) -> LtvView; // { debt, collateral_value, ltv_bps, state,
/// price_status }`. This exact shape is what `PledgeVault::release` cross-calls — kept stable
/// here since both crates are written together in this pass (see PledgeVault's module docs for
/// the corresponding hand-synced copy on that side).
#[contracttype]
#[derive(Clone, Debug)]
pub struct LtvView {
    pub debt: i128,
    pub collateral_value: i128,
    pub ltv_bps: u32,
    pub state: MarginState,
    pub price_status: PriceStatus,
}

/// Per-asset config for lines drawn against `asset` (see module docs on the Registry
/// simplification). Mirrors `pledge-vault`'s `AssetConfig` shape since both crates are owned
/// together in this pass, though the two are never cross-called against each other for config.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfig {
    pub price_guard: Address,
    pub usdc: Address,
    pub haircut_bps: u32,
    pub thresholds: MarginThresholds,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LineStatus {
    Open,
    Liquidating,
    /// A liquidated line whose outcome has been booked by `close_liquidated`. Terminal.
    Closed,
}

/// What a liquidation took and what it was worth, recorded by `liquidate` and completed by
/// `close_liquidated`. `debt` and `price` are frozen at the moment the breach was confirmed, so the
/// outcome cannot be moved by when the lender chooses to close the line.
#[contracttype]
#[derive(Clone, Debug)]
pub struct LiquidationRecord {
    /// The whole pledged position; the keeper must liquidate all of it in `PledgeVault`.
    pub seized_units: i128,
    /// Guarded price (7-decimal) read when the breach was confirmed.
    pub price: i128,
    /// Principal plus interest owed at that moment.
    pub debt: i128,
    pub closed: bool,
    /// `seized_units * price`, no haircut. Zero until the line is closed.
    pub recovered: i128,
    /// Value of the collateral above the debt, paid by the lender to the borrower in USDC.
    pub surplus: i128,
    /// Debt the collateral did not cover: the lender's loss.
    pub shortfall: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Line {
    pub lender: Address,
    pub borrower: Address,
    pub asset: Address,
    pub limit: i128,
    pub funded: i128,
    pub drawn: i128,
    pub pledged_units: i128,
    pub rate_bps: u32,
    pub cure_s: u64,
    pub agreement: BytesN<32>,
    pub status: LineStatus,
    pub last_accrual_ts: u64,
    pub accrued_interest: i128,
    pub margin_state: MarginState,
    /// PRD §8 invariant 3: the ledger sequence at which a `Liquidation`-state breach was first
    /// observed (via `poke`), and the LTV that was observed then. `liquidate` requires a
    /// *second*, later-ledger read to still confirm the breach before it may proceed, so a single
    /// stale/manipulated price read can never trigger a liquidation alone. Flattened into two
    /// `Option<primitive>` fields rather than a nested `Option<BreachFlag>` struct — soroban-sdk's
    /// `#[contracttype]` derive doesn't play well with `Option<CustomStruct>` fields.
    pub breach_ledger: Option<u32>,
    pub breach_ltv_bps: u32,
    /// The ledger timestamp (seconds) when the line first entered an unhealthy margin state
    /// (`MarginCall` or `Liquidation`). Recorded on first unhealthy observation and unchanged while
    /// remaining unhealthy; cleared when the line recovers to `Healthy` or `Warning`.
    pub unhealthy_since: Option<u64>,
}

#[contracttype]
enum DataKey {
    AssetConfig(Address),
    NextLineId,
    Line(u64),
    /// The `PledgeVault` allowed to report a line's collateral directly (see `sync_from_vault`).
    Vault,
    /// Interest repaid on a line that the lender has not withdrawn yet.
    Claimable(u64),
    Liquidation(u64),
}

fn read_claimable(env: &Env, line: u64) -> i128 {
    let key = DataKey::Claimable(line);
    let amount = env.storage().persistent().get(&key).unwrap_or(0);
    if env.storage().persistent().has(&key) {
        ttl::extend_persistent(env, &key);
    }
    amount
}

fn write_claimable(env: &Env, line: u64, amount: i128) {
    let key = DataKey::Claimable(line);
    env.storage().persistent().set(&key, &amount);
    ttl::extend_persistent(env, &key);
}

fn read_line(env: &Env, line: u64) -> Line {
    let key = DataKey::Line(line);
    let state: Line = env
        .storage()
        .persistent()
        .get(&key)
        .expect("credit-line: unknown line");
    ttl::extend_persistent(env, &key);
    state
}

fn write_line(env: &Env, line: u64, state: &Line) {
    let key = DataKey::Line(line);
    env.storage().persistent().set(&key, state);
    ttl::extend_persistent(env, &key);
}

fn read_liquidation(env: &Env, line: u64) -> LiquidationRecord {
    let key = DataKey::Liquidation(line);
    let record: LiquidationRecord = env
        .storage()
        .persistent()
        .get(&key)
        .expect("credit-line: line was not liquidated");
    ttl::extend_persistent(env, &key);
    record
}

fn write_liquidation(env: &Env, line: u64, record: &LiquidationRecord) {
    let key = DataKey::Liquidation(line);
    env.storage().persistent().set(&key, record);
    ttl::extend_persistent(env, &key);
}

fn read_asset_config(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("credit-line: asset not configured")
}

/// Interest accrued between `line.last_accrual_ts` and `now`, on top of whatever is already
/// booked in `line.accrued_interest`. Simple, non-compounding annualized rate, matching PRD §5's
/// "Fixed annual rate per line, accrued per ledger": `drawn * rate_bps * elapsed_s / year_s /
/// 10_000`.
fn interest_delta(line: &Line, now: u64) -> i128 {
    let elapsed = now.saturating_sub(line.last_accrual_ts) as i128;
    (line.drawn * line.rate_bps as i128 * elapsed) / SECONDS_PER_YEAR / BPS_DENOMINATOR
}

/// Recomputes debt, collateral value, and LTV for `line` from a fresh guarded price read. Doesn't
/// persist anything — read-only, used by the `ltv` view, `poke`, `draw`, and `liquidate`.
fn compute_ltv(env: &Env, line: &Line) -> LtvView {
    read_ltv(env, line).0
}

/// Same as `compute_ltv`, also returning the guarded price the view was computed from.
fn read_ltv(env: &Env, line: &Line) -> (LtvView, i128) {
    let config = read_asset_config(env, &line.asset);
    let guarded = PriceGuardClient::new(env, &config.price_guard).guarded_price(&line.asset);

    let debt = line.drawn + line.accrued_interest + interest_delta(line, env.ledger().timestamp());
    let collateral_value =
        risk::collateral_value(line.pledged_units, guarded.value, config.haircut_bps);
    let ltv_bps = risk::ltv_bps(debt, collateral_value);
    let margin_state = margin::classify(ltv_bps, &config.thresholds);

    (
        LtvView {
            debt,
            collateral_value,
            ltv_bps,
            state: margin_state,
            price_status: guarded.status,
        },
        guarded.value,
    )
}

#[contract]
pub struct CreditLine;

#[contractimpl]
impl CreditLine {
    pub fn initialize(
        env: Env,
        admin: Address,
        pauser: Address,
        keeper: Address,
        price_publisher: Address,
        risk: Address,
    ) {
        ttl::extend_instance(&env);
        if access::has_roles(&env) {
            panic!("credit-line: already initialized");
        }
        access::write_roles(
            &env,
            &Roles {
                admin,
                pauser,
                keeper,
                price_publisher,
                risk,
            },
        );
    }

    /// See module docs on the Registry simplification. `admin` is accepted for interface
    /// symmetry; the actual check is `access::require_admin`, which authenticates the *stored*
    /// admin regardless of what's passed here.
    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        price_guard: Address,
        usdc: Address,
        haircut_bps: u32,
        thresholds: MarginThresholds,
    ) {
        ttl::extend_instance(&env);
        let _ = admin;
        access::require_admin(&env);
        risk::validate_haircut_bps(haircut_bps);
        thresholds.validate();
        env.storage().instance().set(
            &DataKey::AssetConfig(asset),
            &AssetConfig {
                price_guard,
                usdc,
                haircut_bps,
                thresholds,
            },
        );
    }

    pub fn open(
        env: Env,
        lender: Address,
        borrower: Address,
        asset: Address,
        limit: i128,
        rate_bps: u32,
        cure_s: u64,
        agreement: BytesN<32>,
    ) -> u64 {
        ttl::extend_instance(&env);
        lender.require_auth();
        assert!(limit > 0, "credit-line: limit must be positive");

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextLineId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextLineId, &(id + 1));

        write_line(
            &env,
            id,
            &Line {
                lender,
                borrower,
                asset,
                limit,
                funded: 0,
                drawn: 0,
                pledged_units: 0,
                rate_bps,
                cure_s,
                agreement,
                status: LineStatus::Open,
                last_accrual_ts: env.ledger().timestamp(),
                accrued_interest: 0,
                margin_state: MarginState::Healthy,
                breach_ledger: None,
                breach_ltv_bps: 0,
                unhealthy_since: None,
            },
        );
        id
    }

    /// Funds the line with USDC that sits here, undrawn, until `draw` pulls it out (PRD §6.2:
    /// "USDC in transit only").
    pub fn fund(env: Env, lender: Address, line: u64, amount: i128) {
        ttl::extend_instance(&env);
        lender.require_auth();
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);
        assert_eq!(state.lender, lender, "credit-line: not this line's lender");
        assert!(
            state.status != LineStatus::Closed,
            "credit-line: line is closed"
        );

        let config = read_asset_config(&env, &state.asset);
        token::Client::new(&env, &config.usdc).transfer(
            &lender,
            muxed(&env.current_contract_address()),
            &amount,
        );

        state.funded += amount;
        write_line(&env, line, &state);
    }

    /// Names the `PledgeVault` allowed to report collateral through `sync_from_vault`. Admin only.
    ///
    /// The `admin` argument is intentionally unused: authorization is enforced against the *stored*
    /// admin via `access::require_admin`, so passing a different address (or an address with no
    /// stored role) cannot bypass or substitute for the real admin's signature. This mirrors the
    /// `let _ = admin;` pattern used by the other admin-gated setters in this contract.
    pub fn set_vault(env: Env, admin: Address, vault: Address) {
        ttl::extend_instance(&env);
        let _ = admin;
        access::require_admin(&env);
        env.storage().instance().set(&DataKey::Vault, &vault);
    }

    /// The collateral asset of `line`, so the vault can refuse a pledge of the wrong token.
    pub fn asset_of(env: Env, line: u64) -> Address {
        ttl::extend_instance(&env);
        read_line(&env, line).asset
    }

    /// Called by the configured `PledgeVault` in the same transaction as every pledge, release,
    /// lien confirmation and liquidation, so the line's collateral figure moves with the vault's
    /// balance instead of lagging it.
    ///
    /// The lag was exploitable: the figure used to change only when the keeper's periodic
    /// `sync_collateral` ran, so a borrower could `release` collateral and then `draw` against the
    /// units that had just left, inside the window before the next sync, leaving a line the lender
    /// funded against collateral that was no longer there. `sync_collateral` stays as the keeper's
    /// reconciliation path; this is the path that closes the window.
    pub fn sync_from_vault(env: Env, vault: Address, line: u64, asset: Address, units: i128) {
        ttl::extend_instance(&env);
        vault.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Vault)
            .expect("credit-line: vault not configured");
        assert_eq!(vault, stored, "credit-line: caller is not the configured vault");
        assert!(units >= 0, "credit-line: units cannot be negative");

        let mut state = read_line(&env, line);
        assert_eq!(
            state.asset, asset,
            "credit-line: not this line's collateral asset"
        );
        state.pledged_units = units;
        write_line(&env, line, &state);
    }

    /// Sets the line's locally-tracked collateral figure. See module docs: in the real system
    /// the off-chain `margin-monitor` service keeps this synced from `PledgeVault`'s actual
    /// on-chain balance; this skeleton exposes the sync point as a keeper/admin-gated call
    /// instead of a live cross-contract read, to avoid a circular `CreditLine <-> PledgeVault`
    /// dependency (`PledgeVault::release` already reads `CreditLine::ltv` the other way).
    pub fn sync_collateral(env: Env, caller: Address, line: u64, units: i128) {
        ttl::extend_instance(&env);
        access::require_admin_or_keeper(&env, &caller);
        assert!(units >= 0, "credit-line: units cannot be negative");

        let mut state = read_line(&env, line);
        state.pledged_units = units;
        write_line(&env, line, &state);
    }

    /// PRD §8 invariant 1 ("never over-lent") and invariant 2 ("no draws on a bad price"). Both
    /// are enforced here before a single stroop of USDC moves.
    pub fn draw(env: Env, borrower: Address, line: u64, amount: i128, to: Address) {
        ttl::extend_instance(&env);
        borrower.require_auth();
        pause::require_not_paused(&env, &PauseScope::Draws);
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);
        assert_eq!(
            state.borrower, borrower,
            "credit-line: not this line's borrower"
        );
        assert_eq!(
            state.status,
            LineStatus::Open,
            "credit-line: line is not open"
        );

        let now = env.ledger().timestamp();
        state.accrued_interest += interest_delta(&state, now);
        state.last_accrual_ts = now;

        assert!(
            amount <= state.funded - state.drawn,
            "credit-line: draw exceeds funded-but-undrawn balance"
        );
        assert!(
            state.drawn + amount <= state.limit,
            "credit-line: draw exceeds the line's limit"
        );

        let config = read_asset_config(&env, &state.asset);
        let guarded = PriceGuardClient::new(&env, &config.price_guard).guarded_price(&state.asset);
        assert!(
            matches!(guarded.status, PriceStatus::Ok),
            "credit-line: price status is not Ok"
        );

        let collateral_value =
            risk::collateral_value(state.pledged_units, guarded.value, config.haircut_bps);
        let post_draw_debt = state.drawn + state.accrued_interest + amount;
        let ltv_bps = risk::ltv_bps(post_draw_debt, collateral_value);
        let margin_state = margin::classify(ltv_bps, &config.thresholds);
        assert!(
            matches!(margin_state, MarginState::Healthy),
            "credit-line: draw would push the line past a healthy LTV"
        );

        token::Client::new(&env, &config.usdc).transfer(
            &env.current_contract_address(),
            muxed(&to),
            &amount,
        );

        state.drawn += amount;
        state.margin_state = margin_state;
        write_line(&env, line, &state);
    }

    /// PRD §8 invariant 5 ("pausing cannot move funds"): deliberately *not* gated by
    /// `require_not_paused` — repayment must always work while `Draws` (or any scope) is paused.
    ///
    /// `amount` is a cap: `min(amount, owed)` is applied (interest first, then principal) and
    /// only that is transferred. It returns the amount applied. A borrower who wants to clear the
    /// line signs a figure at or above the debt and interest accrued before inclusion cannot strand
    /// dust or make the call panic.
    pub fn repay(env: Env, payer: Address, line: u64, amount: i128) -> i128 {
        ttl::extend_instance(&env);
        payer.require_auth();
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);

        let now = env.ledger().timestamp();
        state.accrued_interest += interest_delta(&state, now);
        state.last_accrual_ts = now;

        // `amount` is a cap, not an exact figure: the borrower signs it some time before the
        // ledger closes, and interest keeps accruing in between. Applying `min(amount, owed)`
        // lets "pay everything, up to X" clear a line instead of leaving dust or panicking.
        let owed = state.accrued_interest + state.drawn;
        assert!(owed > 0, "credit-line: nothing owed");
        let applied = amount.min(owed);

        let mut remaining = applied;
        let pay_interest = remaining.min(state.accrued_interest);
        state.accrued_interest -= pay_interest;
        remaining -= pay_interest;
        // Interest belongs to the lender, who takes it out with `withdraw_interest`.
        write_claimable(&env, line, read_claimable(&env, line) + pay_interest);

        let pay_principal = remaining.min(state.drawn);
        state.drawn -= pay_principal;
        remaining -= pay_principal;

        assert_eq!(remaining, 0, "credit-line: repayment bookkeeping mismatch");

        let config = read_asset_config(&env, &state.asset);
        token::Client::new(&env, &config.usdc).transfer(
            &payer,
            muxed(&env.current_contract_address()),
            &applied,
        );

        write_line(&env, line, &state);
        applied
    }

    pub fn ltv(env: Env, line: u64) -> LtvView {
        ttl::extend_instance(&env);
        let state = read_line(&env, line);
        compute_ltv(&env, &state)
    }

    /// Permissionless: recomputes the margin state via a fresh price read and persists it, also
    /// arming (or clearing) the breach flag `liquidate` needs. Anyone may call this — it can only
    /// ever make on-chain state match a fresh price read, never move funds.
    pub fn poke(env: Env, line: u64) -> MarginState {
        ttl::extend_instance(&env);
        let mut state = read_line(&env, line);
        let view = compute_ltv(&env, &state);
        state.margin_state = view.state.clone();

        if matches!(view.state, MarginState::MarginCall | MarginState::Liquidation) {
            if state.unhealthy_since.is_none() {
                state.unhealthy_since = Some(env.ledger().timestamp());
            }
        } else {
            state.unhealthy_since = None;
        }

        if matches!(view.state, MarginState::Liquidation)
            && matches!(view.price_status, PriceStatus::Ok)
        {
            if state.breach_ledger.is_none() {
                state.breach_ledger = Some(env.ledger().sequence());
                state.breach_ltv_bps = view.ltv_bps;
            }
        } else {
            state.breach_ledger = None;
            state.breach_ltv_bps = 0;
        }

        write_line(&env, line, &state);
        view.state
    }

    /// PRD §8 invariant 3: liquidation needs an `Ok` price **and** a second read, taken at least
    /// one ledger after the breach was first flagged (via `poke`), that still confirms the
    /// breach. This function does not itself move collateral — see the module doc comment.
    pub fn liquidate(env: Env, keeper: Address, line: u64, route: LiquidationRoute) {
        ttl::extend_instance(&env);
        let _ = keeper;
        access::require_keeper(&env);

        let mut state = read_line(&env, line);
        let breach_ledger = state
            .breach_ledger
            .expect("credit-line: no confirmed breach flagged; call poke(line) first");
        assert!(
            env.ledger().sequence() > breach_ledger,
            "credit-line: liquidation needs a later ledger than the flagged breach"
        );

        assert!(
            state.status == LineStatus::Open,
            "credit-line: line is not open"
        );

        let (view, price) = read_ltv(&env, &state);
        assert!(
            matches!(view.price_status, PriceStatus::Ok),
            "credit-line: price status is not Ok"
        );
        assert!(
            matches!(view.state, MarginState::Liquidation),
            "credit-line: breach is no longer confirmed"
        );

        // Freeze what the outcome will be measured against: the whole position, the confirmed
        // price and the debt at this moment (see `LiquidationRecord`).
        write_liquidation(
            &env,
            line,
            &LiquidationRecord {
                seized_units: state.pledged_units,
                price,
                debt: view.debt,
                closed: false,
                recovered: 0,
                surplus: 0,
                shortfall: 0,
            },
        );

        state.status = LineStatus::Liquidating;
        state.margin_state = MarginState::Liquidation;
        write_line(&env, line, &state);

        env.events().publish(
            (Symbol::new(&env, "liquidation_started"), line),
            (route, state.pledged_units, price, view.debt),
        );
    }

    /// Books the outcome of a liquidation and closes the line. Called by the lender once the
    /// keeper has moved the collateral to them in kind (`PledgeVault::liquidate`).
    ///
    /// The collateral is valued at the guarded price confirmed when the breach was flagged
    /// (`LiquidationRecord`), not at a price the lender supplies, so the lender cannot understate
    /// what they received. If it is worth more than the debt the lender pays the difference to the
    /// borrower in USDC in this same call (that is why it needs the lender's auth); if it is worth
    /// less, the gap is recorded as the lender's shortfall. Principal that was lent out and not
    /// repaid is written off the line's funded balance, so what is left in `funded` is exactly the
    /// USDC still held here and withdrawable with `withdraw_undrawn`.
    pub fn close_liquidated(env: Env, lender: Address, line: u64) {
        ttl::extend_instance(&env);
        lender.require_auth();

        let mut state = read_line(&env, line);
        assert_eq!(state.lender, lender, "credit-line: not this line's lender");
        assert!(
            state.status == LineStatus::Liquidating,
            "credit-line: line is not being liquidated"
        );

        let mut record = read_liquidation(&env, line);

        let recovered = risk::collateral_value(record.seized_units, record.price, 0);
        let surplus = (recovered - record.debt).max(0);
        let shortfall = (record.debt - recovered).max(0);

        if surplus > 0 {
            let config = read_asset_config(&env, &state.asset);
            token::Client::new(&env, &config.usdc).transfer(
                &lender,
                muxed(&state.borrower),
                &surplus,
            );
        }

        state.funded -= state.drawn;
        state.drawn = 0;
        state.accrued_interest = 0;
        state.pledged_units = 0;
        state.margin_state = MarginState::Healthy;
        state.breach_ledger = None;
        state.breach_ltv_bps = 0;
        state.unhealthy_since = None;
        state.status = LineStatus::Closed;
        write_line(&env, line, &state);

        record.closed = true;
        record.recovered = recovered;
        record.surplus = surplus;
        record.shortfall = shortfall;
        write_liquidation(&env, line, &record);

        env.events().publish(
            (Symbol::new(&env, "line_closed"), line),
            (record.debt, recovered, surplus, shortfall),
        );
    }

    /// Takes undrawn USDC back out of the line (reducing the commitment). Repaid principal returns
    /// to the undrawn balance, so this is also how a lender gets principal back.
    ///
    /// Publishes `(Symbol("undrawn_withdrawn"), line)` with `(lender, amount, funded_after)`, so a
    /// lender's falling funded exposure is explained on chain (see the crate README's events table).
    pub fn withdraw_undrawn(env: Env, lender: Address, line: u64, amount: i128) {
        ttl::extend_instance(&env);
        lender.require_auth();
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);
        assert_eq!(state.lender, lender, "credit-line: not this line's lender");
        assert!(
            amount <= state.funded - state.drawn,
            "credit-line: withdrawal exceeds the undrawn balance"
        );

        state.funded -= amount;
        write_line(&env, line, &state);

        let config = read_asset_config(&env, &state.asset);
        token::Client::new(&env, &config.usdc).transfer(
            &env.current_contract_address(),
            muxed(&lender),
            &amount,
        );

        env.events().publish(
            (Symbol::new(&env, "undrawn_withdrawn"), line),
            (lender, amount, state.funded),
        );
    }

    /// Takes repaid interest out of the contract. Interest is tracked separately from principal
    /// (it never counts as undrawn funding) so it can be withdrawn without touching the commitment.
    pub fn withdraw_interest(env: Env, lender: Address, line: u64, amount: i128) {
        ttl::extend_instance(&env);
        lender.require_auth();
        assert!(amount > 0, "credit-line: amount must be positive");

        let state = read_line(&env, line);
        assert_eq!(state.lender, lender, "credit-line: not this line's lender");
        let claimable = read_claimable(&env, line);
        assert!(
            amount <= claimable,
            "credit-line: withdrawal exceeds the interest repaid"
        );

        let claimable_after = claimable - amount;
        write_claimable(&env, line, claimable_after);

        let config = read_asset_config(&env, &state.asset);
        token::Client::new(&env, &config.usdc).transfer(
            &env.current_contract_address(),
            muxed(&lender),
            &amount,
        );

        env.events().publish(
            (Symbol::new(&env, "interest_withdrawn"), line),
            (lender, amount, claimable_after),
        );
    }

    /// Interest repaid on `line` and not yet withdrawn.
    pub fn claimable_interest(env: Env, line: u64) -> i128 {
        ttl::extend_instance(&env);
        read_claimable(&env, line)
    }

    /// The recorded liquidation outcome for `line`, if it was liquidated.
    pub fn liquidation_record(env: Env, line: u64) -> LiquidationRecord {
        ttl::extend_instance(&env);
        read_liquidation(&env, line)
    }

    /// Read-only helper for consoles/tests.
    pub fn line(env: Env, line: u64) -> Line {
        ttl::extend_instance(&env);
        read_line(&env, line)
    }

    /// What the borrower owes right now: principal plus interest accrued to this ledger. Unlike
    /// `ltv` it reads no price, so a caller that only needs to know whether anything is owed (the
    /// vault, deciding whether a release puts anything at risk) cannot be blocked by a degraded or
    /// halted price feed.
    pub fn debt_of(env: Env, line: u64) -> i128 {
        ttl::extend_instance(&env);
        let state = read_line(&env, line);
        state.drawn + state.accrued_interest + interest_delta(&state, env.ledger().timestamp())
    }

    /// A minimal, dedicated getter so `PledgeVault::release` can verify a caller actually owns
    /// the line they're claiming to release collateral from, without decoding this contract's
    /// full `Line` struct on the other side.
    pub fn borrower_of(env: Env, line: u64) -> Address {
        ttl::extend_instance(&env);
        read_line(&env, line).borrower
    }

    /// Extends instance TTL and persistent storage TTL for `line` (and its claimable and
    /// liquidation entries if present). Anyone (e.g. borrower, lender, or keeper) can call
    /// this to keep a dormant line from archiving.
    pub fn extend_ttl(env: Env, line: u64) {
        ttl::extend_instance(&env);
        let key = DataKey::Line(line);
        assert!(
            env.storage().persistent().has(&key),
            "credit-line: unknown line"
        );
        ttl::extend_persistent(&env, &key);
        let claimable_key = DataKey::Claimable(line);
        if env.storage().persistent().has(&claimable_key) {
            ttl::extend_persistent(&env, &claimable_key);
        }
        let liq_key = DataKey::Liquidation(line);
        if env.storage().persistent().has(&liq_key) {
            ttl::extend_persistent(&env, &liq_key);
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ballast_common::price::PRICE_SCALE;
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    use soroban_sdk::testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    // A minimal in-crate mock token implementing just `transfer`/`balance`/`mint` — same
    // hermetic cross-contract-testing pattern as `pledge-vault`'s mock token; a real Stellar
    // Asset Contract pulls in admin/authorization machinery this skeleton doesn't need.
    mod mock_token {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, MuxedAddress};

        #[contract]
        pub struct MockToken;

        #[contracttype]
        enum DataKey {
            Balance(Address),
        }

        #[contractimpl]
        impl MockToken {
            pub fn mint(env: Env, to: Address, amount: i128) {
                let key = DataKey::Balance(to);
                let bal: i128 = env.storage().instance().get(&key).unwrap_or(0);
                env.storage().instance().set(&key, &(bal + amount));
            }

            pub fn balance(env: Env, id: Address) -> i128 {
                env.storage()
                    .instance()
                    .get(&DataKey::Balance(id))
                    .unwrap_or(0)
            }

            pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
                from.require_auth();
                let to_addr = to.address();
                let from_key = DataKey::Balance(from);
                let from_bal: i128 = env.storage().instance().get(&from_key).unwrap_or(0);
                assert!(from_bal >= amount, "mock-token: insufficient balance");
                let to_key = DataKey::Balance(to_addr);
                let to_bal: i128 = env.storage().instance().get(&to_key).unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&from_key, &(from_bal - amount));
                env.storage().instance().set(&to_key, &(to_bal + amount));
            }
        }
    }

    // A minimal in-crate mock PriceGuard returning a canned `GuardedPrice` (`Ok`/`Degraded`/
    // `Halted` as needed per test) — this crate never depends on the real `ballast-price-guard`
    // crate, which is being built concurrently by another agent.
    mod mock_price_guard {
        use ballast_common::price::{GuardedPrice, PriceStatus};
        use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env};

        #[contract]
        pub struct MockPriceGuard;

        #[contracttype]
        enum DataKey {
            Value,
            Status,
        }

        #[contractimpl]
        impl MockPriceGuard {
            pub fn set_price(env: Env, value: i128, status: PriceStatus) {
                env.storage().instance().set(&DataKey::Value, &value);
                env.storage().instance().set(&DataKey::Status, &status);
            }

            pub fn guarded_price(env: Env, asset: Address) -> GuardedPrice {
                let value: i128 = env.storage().instance().get(&DataKey::Value).unwrap();
                let status: PriceStatus = env.storage().instance().get(&DataKey::Status).unwrap();
                GuardedPrice {
                    asset,
                    value,
                    status,
                    ts: env.ledger().timestamp(),
                    sources: vec![&env],
                }
            }
        }
    }

    struct Harness {
        env: Env,
        credit_line: CreditLineClient<'static>,
        token: mock_token::MockTokenClient<'static>,
        #[allow(dead_code)]
        price_guard: mock_price_guard::MockPriceGuardClient<'static>,
        admin: Address,
        keeper: Address,
        lender: Address,
        borrower: Address,
        asset: Address,
    }

    fn setup(haircut_bps: u32, price: i128, status: PriceStatus) -> Harness {
        let env = Env::default();
        env.mock_all_auths();

        let cl_id = env.register(CreditLine, ());
        let credit_line = CreditLineClient::new(&env, &cl_id);

        let token_id = env.register(mock_token::MockToken, ());
        let token = mock_token::MockTokenClient::new(&env, &token_id);

        let pg_id = env.register(mock_price_guard::MockPriceGuard, ());
        let price_guard = mock_price_guard::MockPriceGuardClient::new(&env, &pg_id);
        price_guard.set_price(&price, &status);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        let lender = Address::generate(&env);
        let borrower = Address::generate(&env);
        let asset = Address::generate(&env);

        credit_line.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

        let thresholds = MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        };
        credit_line.configure_asset(&admin, &asset, &pg_id, &token_id, &haircut_bps, &thresholds);

        Harness {
            env,
            credit_line,
            token,
            price_guard,
            admin,
            keeper,
            lender,
            borrower,
            asset,
        }
    }

    fn open_and_fund(h: &Harness, limit: i128, fund_amount: i128) -> u64 {
        let agreement = BytesN::from_array(&h.env, &[7u8; 32]);
        let id = h.credit_line.open(
            &h.lender,
            &h.borrower,
            &h.asset,
            &limit,
            &1_000,
            &86_400,
            &agreement,
        );
        h.token.mint(&h.lender, &fund_amount);
        h.credit_line.fund(&h.lender, &id, &fund_amount);
        id
    }

    /// `configure_asset` runs `MarginThresholds::validate` (#78): equal warning and margin-call
    /// thresholds would make `Warning` unreachable, so they are refused before anything is stored.
    #[test]
    #[should_panic(expected = "margin: warning_bps must be below margin_call_bps")]
    fn configure_asset_rejects_equal_warning_and_margin_call_thresholds() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        h.credit_line.configure_asset(
            &h.admin,
            &Address::generate(&h.env),
            &h.price_guard.address,
            &h.token.address,
            &500,
            &MarginThresholds {
                warning_bps: 8_000,
                margin_call_bps: 8_000,
                liquidation_bps: 9_000,
            },
        );
    }

    #[test]
    fn draw_and_repay_happy_path() {
        // 5% haircut, $1.00 price, 1000 units pledged -> $950 collateral value.
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        // $500 draw against $950 collateral -> 5263 bps, Healthy (<7000).
        let to = Address::generate(&h.env);
        h.credit_line
            .draw(&h.borrower, &id, &(500 * PRICE_SCALE), &to);
        assert_eq!(h.token.balance(&to), 500 * PRICE_SCALE);

        let line = h.credit_line.line(&id);
        assert_eq!(line.drawn, 500 * PRICE_SCALE);

        // Repay in full.
        h.token.mint(&h.borrower, &(500 * PRICE_SCALE));
        h.credit_line.repay(&h.borrower, &id, &(500 * PRICE_SCALE));
        let line = h.credit_line.line(&id);
        assert_eq!(line.drawn, 0);
    }

    #[test]
    #[should_panic(expected = "credit-line: draw would push the line past a healthy LTV")]
    fn never_over_lent() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        // $950 collateral value; drawing $900 -> ~9474 bps, past liquidation (>9000) -> panic.
        let to = Address::generate(&h.env);
        h.credit_line
            .draw(&h.borrower, &id, &(900 * PRICE_SCALE), &to);
    }

    #[test]
    #[should_panic(expected = "credit-line: price status is not Ok")]
    fn no_draw_on_bad_price() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Degraded);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        let to = Address::generate(&h.env);
        h.credit_line
            .draw(&h.borrower, &id, &(10 * PRICE_SCALE), &to);
    }

    #[test]
    fn repay_works_while_draws_paused_but_draw_does_not() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        h.credit_line
            .draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());

        // Pause draws directly via ballast_common storage from within the contract's context.
        h.env.as_contract(&h.credit_line.address, || {
            pause::set_paused(&h.env, &PauseScope::Draws, true);
        });

        // Repay must still work while Draws is paused.
        h.token.mint(&h.borrower, &(500 * PRICE_SCALE));
        h.credit_line.repay(&h.borrower, &id, &(500 * PRICE_SCALE));
        let line = h.credit_line.line(&id);
        assert_eq!(line.drawn, 0);

        // But a further draw must not.
        let to = Address::generate(&h.env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.draw(&h.borrower, &id, &PRICE_SCALE, &to);
        }));
        let msg = *result
            .expect_err("credit-line: draw should have panicked while Draws is paused")
            .downcast::<String>()
            .expect("panic carries its message");
        assert!(msg.contains("ballast-common: paused"), "unexpected message: {msg}");
    }

    #[test]
    fn admin_cannot_substitute_for_borrower_auth() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        // Only mock an authorization for `admin`, not for the real `borrower` on this line.
        // `draw`'s first line is `borrower.require_auth()`, so admin's auth cannot substitute.
        let to = Address::generate(&h.env);
        let amount = 10 * PRICE_SCALE;
        h.env.mock_auths(&[MockAuth {
            address: &h.admin,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "draw",
                args: (h.borrower.clone(), id, amount, to.clone()).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.draw(&h.borrower, &id, &amount, &to);
        }));
        assert!(
            result.is_err(),
            "credit-line: draw must not succeed on admin's authorization alone"
        );

        // Same for `fund` (lender-gated): mocking only admin's auth must not let admin move the
        // lender's funds either.
        h.env.mock_auths(&[MockAuth {
            address: &h.admin,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "fund",
                args: (id, amount).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.fund(&h.lender, &id, &amount);
        }));
        assert!(
            result.is_err(),
            "credit-line: fund must not succeed on admin's authorization alone"
        );
    }

    // --- lender withdrawals -------------------------------------------------------------

    #[test]
    fn lender_gets_repaid_principal_back_through_withdraw_undrawn() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        h.credit_line.draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());
        // Only the 500 still sitting in the contract can be taken out.
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.withdraw_undrawn(&h.lender, &id, &(600 * PRICE_SCALE));
        }));
        assert!(over.is_err(), "cannot withdraw USDC that is out on loan");

        h.token.mint(&h.borrower, &0);
        h.credit_line.repay(&h.borrower, &id, &(500 * PRICE_SCALE));
        h.credit_line.withdraw_undrawn(&h.lender, &id, &(1_000 * PRICE_SCALE));

        assert_eq!(h.token.balance(&h.lender), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.credit_line.address), 0);
        assert_eq!(h.credit_line.line(&id).funded, 0);
    }

    #[test]
    fn withdraw_undrawn_publishes_event_on_success_and_none_on_failure() {
        use soroban_sdk::testutils::Events as _;
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};
        use soroban_sdk::TryFromVal;

        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);

        let contract_events = || {
            h.env
                .events()
                .all()
                .events()
                .into_iter()
                .filter(|e| e.type_ == ContractEventType::Contract)
                .cloned()
                .collect::<std::vec::Vec<_>>()
        };

        // Failure: the withdrawal reverts, so nothing is published.
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line
                .withdraw_undrawn(&h.lender, &id, &(1_001 * PRICE_SCALE));
        }));
        assert!(over.is_err(), "cannot withdraw more than the undrawn balance");
        assert_eq!(
            contract_events().len(),
            0,
            "no event may be emitted by a reverted withdraw_undrawn"
        );

        let amount = 400 * PRICE_SCALE;
        h.credit_line.withdraw_undrawn(&h.lender, &id, &amount);

        // Read the events before any further invocation, which would reset the recorded log.
        let events = contract_events();
        assert_eq!(events.len(), 1, "exactly one event on a successful withdrawal");
        let last_event = events.last().expect("an event must have been published");

        let expected_topic0 = ScVal::Symbol(ScSymbol("undrawn_withdrawn".try_into().unwrap()));
        let expected_topic1 = ScVal::U64(id);
        let val: soroban_sdk::Val = (h.lender.clone(), amount, 600 * PRICE_SCALE).into_val(&h.env);
        let expected_data = ScVal::try_from_val(&h.env, &val).unwrap();

        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_topic0));
                assert_eq!(v0.topics.get(1), Some(&expected_topic1));
                assert_eq!(v0.data, expected_data);
            }
        }
        assert_eq!(h.credit_line.line(&id).funded, 600 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "credit-line: not this line's lender")]
    fn only_the_lender_can_withdraw() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.withdraw_undrawn(&h.borrower, &id, &(1 * PRICE_SCALE));
    }

    #[test]
    fn repaid_interest_is_withdrawable_and_separate_from_the_commitment() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());

        // One year at 10% (1_000 bps) on 500 is 50 of interest.
        h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        h.token.mint(&h.borrower, &(50 * PRICE_SCALE));
        h.credit_line.repay(&h.borrower, &id, &(550 * PRICE_SCALE));

        assert_eq!(h.credit_line.claimable_interest(&id), 50 * PRICE_SCALE);
        let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.withdraw_interest(&h.lender, &id, &(51 * PRICE_SCALE));
        }));
        assert!(over.is_err(), "cannot withdraw more interest than was repaid");

        h.credit_line.withdraw_interest(&h.lender, &id, &(50 * PRICE_SCALE));
        assert_eq!(h.token.balance(&h.lender), 50 * PRICE_SCALE);
        assert_eq!(h.credit_line.claimable_interest(&id), 0);
        // Principal is untouched: the full 1,000 is still undrawn and withdrawable.
        h.credit_line.withdraw_undrawn(&h.lender, &id, &(1_000 * PRICE_SCALE));
        assert_eq!(h.token.balance(&h.credit_line.address), 0);
    }

    #[test]
    fn repay_applies_only_what_is_owed_when_amount_is_larger() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());

        // One year at 10% on 500 is 50 of interest, so 550 is owed.
        h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        h.token.mint(&h.borrower, &(100 * PRICE_SCALE));
        let before = h.token.balance(&h.borrower);

        let applied = h.credit_line.repay(&h.borrower, &id, &(1_000 * PRICE_SCALE));

        assert_eq!(applied, 550 * PRICE_SCALE);
        assert_eq!(before - h.token.balance(&h.borrower), 550 * PRICE_SCALE);
        let after = h.credit_line.line(&id);
        assert_eq!(after.drawn, 0);
        assert_eq!(after.accrued_interest, 0);
        assert_eq!(h.credit_line.claimable_interest(&id), 50 * PRICE_SCALE);
    }

    #[test]
    fn repay_of_an_exact_amount_still_applies_in_full() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());

        let applied = h.credit_line.repay(&h.borrower, &id, &(200 * PRICE_SCALE));

        assert_eq!(applied, 200 * PRICE_SCALE);
        assert_eq!(h.credit_line.line(&id).drawn, 300 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "credit-line: nothing owed")]
    fn repay_on_a_cleared_line_is_rejected() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.repay(&h.borrower, &id, &(1 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "credit-line: draw exceeds the line's limit")]
    fn draw_cannot_exceed_the_limit_even_if_overfunded() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 500 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(10_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());
    }

    /// `configure_asset` refuses a haircut above 100% with `risk::validate_haircut_bps`, the check
    /// `PledgeVault::configure_asset` runs too (#177). Stored, such a haircut made every draw, poke
    /// and liquidation for the asset panic as soon as the collateral was valued.
    #[test]
    #[should_panic(expected = "haircut_bps")]
    fn configure_asset_rejects_a_haircut_above_one_hundred_percent() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        h.credit_line.configure_asset(
            &h.admin,
            &h.asset,
            &h.price_guard.address,
            &h.token.address,
            &10_001,
            &MarginThresholds {
                warning_bps: 7_000,
                margin_call_bps: 8_000,
                liquidation_bps: 9_000,
            },
        );
    }

    // --- liquidation ----------------------------------------------------------------------

    /// Draws 600 against 1,000 units at $1, crashes the price to `crash`, and walks the line
    /// through poke -> later ledger -> poke -> liquidate.
    fn liquidated_line(h: &Harness, crash: i128) -> u64 {
        let id = open_and_fund(h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());

        h.price_guard.set_price(&crash, &PriceStatus::Ok);
        h.credit_line.poke(&id);
        h.env.ledger().set_sequence_number(h.env.ledger().sequence() + 2);
        h.credit_line.poke(&id);
        h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
        id
    }

    #[test]
    fn liquidation_needs_a_later_ledger_than_the_flagged_breach() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());
        h.price_guard.set_price(&(PRICE_SCALE / 2), &PriceStatus::Ok);

        h.credit_line.poke(&id);
        let same_ledger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
        }));
        assert!(same_ledger.is_err(), "a single read must not be enough to liquidate");

        h.env.ledger().set_sequence_number(h.env.ledger().sequence() + 2);
        h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Liquidating);
    }

    /// Every field of a `LiquidationRecord`, in one tuple so a test compares all seven at once.
    fn record_fields(record: &LiquidationRecord) -> (i128, i128, i128, bool, i128, i128, i128) {
        (
            record.seized_units,
            record.price,
            record.debt,
            record.closed,
            record.recovered,
            record.surplus,
            record.shortfall,
        )
    }

    /// #164: what `liquidate` writes into the record, and that it stays as written. The line has
    /// a year of interest that was never booked, so `debt` cannot be the principal alone, and the
    /// crash price differs from the price before and after it, so `price` cannot be a later read.
    #[test]
    fn liquidate_freezes_every_field_of_the_liquidation_record() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());

        // One year at 10% (1_000 bps) on 600 is 60 of interest. Nothing has touched the line
        // since the draw, so all of it is still pending rather than booked on the line.
        let year = 365 * 24 * 60 * 60;
        h.env
            .ledger()
            .set_timestamp(h.env.ledger().timestamp() + year);
        assert_eq!(h.credit_line.line(&id).accrued_interest, 0);

        // $0.70: 1,000 units are worth 700 against 660 owed (LTV 94.28%, past liquidation).
        let crash = 70 * PRICE_SCALE / 100;
        h.price_guard.set_price(&crash, &PriceStatus::Ok);
        h.credit_line.poke(&id);
        h.env
            .ledger()
            .set_sequence_number(h.env.ledger().sequence() + 2);
        h.credit_line.poke(&id);
        h.credit_line
            .liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);

        let frozen = (
            1_000 * PRICE_SCALE, // seized_units: the whole pledged position
            crash,               // price: the one the breach was confirmed at
            660 * PRICE_SCALE,   // debt: principal plus the pending interest
            false,               // closed
            0,                   // recovered
            0,                   // surplus
            0,                   // shortfall
        );
        assert_eq!(
            record_fields(&h.credit_line.liquidation_record(&id)),
            frozen
        );

        // The price recovers and another year passes. Neither reaches the record.
        h.price_guard
            .set_price(&(2 * PRICE_SCALE), &PriceStatus::Ok);
        h.env
            .ledger()
            .set_timestamp(h.env.ledger().timestamp() + year);
        assert_eq!(
            record_fields(&h.credit_line.liquidation_record(&id)),
            frozen
        );
    }

    #[test]
    #[should_panic(expected = "credit-line: line was not liquidated")]
    fn liquidation_record_of_a_line_that_was_never_liquidated_panics() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());

        h.credit_line.liquidation_record(&id);
    }

    #[test]
    fn unhealthy_since_records_timestamp_on_unhealthy_and_clears_on_recovery() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        // Debt = 600 against 1,000 collateral -> 6,000 bps (Healthy: <7000).
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());

        // At t=1000, price drops to $0.80 -> Debt = 600 against 800 collateral -> 7,500 bps (Warning: 7000-8000).
        // unhealthy_since remains None.
        h.env.ledger().set_timestamp(1_000);
        h.price_guard.set_price(&(80 * PRICE_SCALE / 100), &PriceStatus::Ok);
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::Warning);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, None);

        // Price drops to $0.72 -> Debt = 600 against 720 collateral -> 8,333 bps (MarginCall: 8000-9000).
        // At t=2000, first time unhealthy -> unhealthy_since set to Some(2000).
        h.env.ledger().set_timestamp(2_000);
        h.price_guard.set_price(&(72 * PRICE_SCALE / 100), &PriceStatus::Ok);
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::MarginCall);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, Some(2_000));

        // At t=3000, still in MarginCall -> unhealthy_since stays unchanged at 2000.
        h.env.ledger().set_timestamp(3_000);
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::MarginCall);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, Some(2_000));

        // Price drops further to $0.64 -> 600 / 640 = 9,375 bps (Liquidation: >=9000).
        // At t=4000, in Liquidation -> unhealthy_since still anchored at original 2000.
        h.env.ledger().set_timestamp(4_000);
        h.price_guard.set_price(&(64 * PRICE_SCALE / 100), &PriceStatus::Ok);
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::Liquidation);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, Some(2_000));

        // Partial repayment brings debt down to 400 against 640 collateral -> 6,250 bps (Healthy: <7000).
        // At t=5000, healthy recovery -> unhealthy_since cleared to None.
        h.env.ledger().set_timestamp(5_000);
        h.token.mint(&h.borrower, &(200 * PRICE_SCALE));
        h.credit_line.repay(&h.borrower, &id, &(200 * PRICE_SCALE));
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::Healthy);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, None);

        // Price drops again to $0.40 -> 400 / 400 = 10,000 bps (Liquidation).
        // At t=6000, new breach -> unhealthy_since recorded anew as Some(6000).
        h.env.ledger().set_timestamp(6_000);
        h.price_guard.set_price(&(40 * PRICE_SCALE / 100), &PriceStatus::Ok);
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::Liquidation);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, Some(6_000));

        // Price recovers to $0.55 -> 400 / 550 = 7,272 bps (Warning).
        // Warning is also healthy enough to clear the cure clock.
        h.env.ledger().set_timestamp(7_000);
        h.price_guard.set_price(&(55 * PRICE_SCALE / 100), &PriceStatus::Ok);
        let state = h.credit_line.poke(&id);
        assert_eq!(state, MarginState::Warning);
        assert_eq!(h.credit_line.line(&id).unhealthy_since, None);
    }

    #[test]
    fn closing_a_shortfall_books_the_loss_and_frees_the_rest_of_the_funding() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        // $0.50: 1,000 units are worth 500 against 600 of debt.
        let id = liquidated_line(&h, PRICE_SCALE / 2);

        h.credit_line.close_liquidated(&h.lender, &id);

        let record = h.credit_line.liquidation_record(&id);
        assert!(record.closed);
        assert_eq!(record.debt, 600 * PRICE_SCALE);
        assert_eq!(record.recovered, 500 * PRICE_SCALE);
        assert_eq!(record.shortfall, 100 * PRICE_SCALE);
        assert_eq!(record.surplus, 0);

        let line = h.credit_line.line(&id);
        assert_eq!(line.status, LineStatus::Closed);
        assert_eq!((line.drawn, line.accrued_interest, line.pledged_units), (0, 0, 0));
        // 1,000 funded, 600 went out and is not coming back: 400 is still here and withdrawable.
        assert_eq!(line.funded, 400 * PRICE_SCALE);
        h.credit_line.withdraw_undrawn(&h.lender, &id, &(400 * PRICE_SCALE));
        assert_eq!(h.token.balance(&h.credit_line.address), 0);
    }

    #[test]
    fn closing_with_a_surplus_pays_the_borrower_from_the_lender() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        // $0.64: 1,000 units are worth 640 against 600 of debt (LTV 93.75%, past liquidation).
        let id = liquidated_line(&h, 64 * PRICE_SCALE / 100);
        let borrower_before = h.token.balance(&h.borrower);
        h.token.mint(&h.lender, &(40 * PRICE_SCALE)); // the lender needs USDC to pay the surplus

        // The price recovering afterwards must not change the outcome: it is frozen at liquidation.
        h.price_guard.set_price(&(2 * PRICE_SCALE), &PriceStatus::Ok);
        h.credit_line.close_liquidated(&h.lender, &id);

        let record = h.credit_line.liquidation_record(&id);
        assert_eq!(record.recovered, 640 * PRICE_SCALE);
        assert_eq!(record.surplus, 40 * PRICE_SCALE);
        assert_eq!(record.shortfall, 0);
        assert_eq!(h.token.balance(&h.borrower) - borrower_before, 40 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.lender), 0);
    }

    #[test]
    #[should_panic(expected = "credit-line: line is not being liquidated")]
    fn an_open_line_cannot_be_closed_as_liquidated() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.close_liquidated(&h.lender, &id);
    }

    #[test]
    #[should_panic(expected = "credit-line: not this line's lender")]
    fn only_the_lender_can_close_a_liquidated_line() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, PRICE_SCALE / 2);
        h.credit_line.close_liquidated(&h.borrower, &id);
    }

    #[test]
    #[should_panic(expected = "credit-line: line is not being liquidated")]
    fn a_line_cannot_be_closed_twice() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, PRICE_SCALE / 2);
        h.credit_line.close_liquidated(&h.lender, &id);
        h.credit_line.close_liquidated(&h.lender, &id);
    }

    #[test]
    fn a_closed_line_accepts_no_more_draws_or_funding() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, PRICE_SCALE / 2);
        h.credit_line.close_liquidated(&h.lender, &id);

        let draw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.draw(&h.borrower, &id, &PRICE_SCALE, &h.borrower.clone());
        }));
        assert!(draw.is_err(), "draw on a closed line must fail");
        h.token.mint(&h.lender, &PRICE_SCALE);
        let fund = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.fund(&h.lender, &id, &PRICE_SCALE);
        }));
        assert!(fund.is_err(), "fund on a closed line must fail");
    }

    // --- vault-reported collateral -----------------------------------------------------------

    /// The vault is an address like any other here (the real one is a contract that authorizes
    /// itself when it calls); `mock_all_auths` stands in for that.
    fn with_vault(h: &Harness) -> Address {
        let vault = Address::generate(&h.env);
        h.credit_line.set_vault(&h.admin, &vault);
        vault
    }

    #[test]
    fn a_release_reported_by_the_vault_stops_the_borrower_drawing_against_it() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let vault = with_vault(&h);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_from_vault(&vault, &id, &h.asset, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(100 * PRICE_SCALE), &h.borrower.clone());

        // The borrower releases 900 of the 1,000 units; the vault reports it in the same
        // transaction. Collateral is now worth 100, so another 100 of debt would put the line at
        // 200% of its collateral.
        h.credit_line.sync_from_vault(&vault, &id, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.credit_line.line(&id).pledged_units, 100 * PRICE_SCALE);

        let draw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.draw(&h.borrower, &id, &(100 * PRICE_SCALE), &h.borrower.clone());
        }));
        assert!(draw.is_err(), "a draw must see the collateral as it is now, not as the keeper last synced it");
    }

    #[test]
    #[should_panic(expected = "credit-line: not this line's collateral asset")]
    fn the_vault_cannot_report_a_different_asset_against_a_line() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let vault = with_vault(&h);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_from_vault(&vault, &id, &Address::generate(&h.env), &(1_000 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "credit-line: vault not configured")]
    fn nothing_can_report_collateral_before_a_vault_is_configured() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_from_vault(&Address::generate(&h.env), &id, &h.asset, &PRICE_SCALE);
    }

    #[test]
    fn only_the_configured_vault_can_report_collateral() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        with_vault(&h);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);

        // Authorize only the impostor, so this passes only if the contract fails to check the
        // stored vault.
        let impostor = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "sync_from_vault",
                args: (impostor.clone(), id, h.asset.clone(), 5_000 * PRICE_SCALE).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.sync_from_vault(&impostor, &id, &h.asset, &(5_000 * PRICE_SCALE));
        }));
        assert!(result.is_err(), "only the configured vault may report collateral");
        assert_eq!(h.credit_line.line(&id).pledged_units, 0);
    }

    // ── #22: liquidate error paths, one exact message each ──────────────────

    /// A line in confirmed-breach state: crashed price, double poke, later ledger —
    /// everything `liquidate` requires except the call itself.
    fn breached_line(h: &Harness, crash: i128) -> u64 {
        let id = open_and_fund(h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());
        h.price_guard.set_price(&crash, &PriceStatus::Ok);
        h.credit_line.poke(&id);
        h.env.ledger().set_sequence_number(h.env.ledger().sequence() + 2);
        id
    }

    #[test]
    #[should_panic(expected = "credit-line: no confirmed breach flagged")]
    fn liquidate_without_a_poke_panics() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());
        // The price has crashed, but nobody ever flagged it on the line.
        h.price_guard.set_price(&(PRICE_SCALE / 2), &PriceStatus::Ok);
        h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
    }

    #[test]
    fn liquidate_after_the_price_recovers_panics_and_leaves_the_line_open() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = breached_line(&h, PRICE_SCALE / 2);
        // The breach was flagged, but the price recovered before anyone liquidated.
        h.price_guard.set_price(&PRICE_SCALE, &PriceStatus::Ok);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
        }));
        let message = *result.expect_err("recovered price must refuse liquidation")
            .downcast::<String>()
            .expect("panic carries its message");
        assert!(
            message.contains("credit-line: breach is no longer confirmed"),
            "unexpected message: {message}"
        );
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Open);
    }

    #[test]
    fn liquidate_with_a_degraded_price_panics_and_leaves_the_line_open() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = breached_line(&h, PRICE_SCALE / 2);
        // Same crashed value, but the guard now reports it Degraded.
        h.price_guard.set_price(&(PRICE_SCALE / 2), &PriceStatus::Degraded);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
        }));
        let message = *result.expect_err("a degraded price must refuse liquidation")
            .downcast::<String>()
            .expect("panic carries its message");
        assert!(
            message.contains("credit-line: price status is not Ok"),
            "unexpected message: {message}"
        );
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Open);
    }

    #[test]
    fn liquidating_twice_panics_and_keeps_the_first_liquidation() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, PRICE_SCALE / 2);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.liquidate(&Address::generate(&h.env), &id, &LiquidationRoute::Transfer);
        }));
        let message = *result.expect_err("a second liquidation must be refused")
            .downcast::<String>()
            .expect("panic carries its message");
        assert!(
            message.contains("credit-line: line is not open"),
            "unexpected message: {message}"
        );
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Liquidating);
    }

    #[test]
    fn a_non_keeper_cannot_liquidate_while_the_real_keeper_can() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = breached_line(&h, PRICE_SCALE / 2);

        // Mock only an outsider's authorization: `liquidate` authenticates the
        // stored keeper, so this must not suffice.
        let outsider = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &outsider,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "liquidate",
                args: (outsider.clone(), id, LiquidationRoute::Transfer).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.liquidate(&outsider, &id, &LiquidationRoute::Transfer);
        }));
        assert!(result.is_err(), "an outsider's own auth must not liquidate");
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Open);

        // The stored keeper's authorization does suffice.
        h.env.mock_auths(&[MockAuth {
            address: &h.keeper,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "liquidate",
                args: (h.keeper.clone(), id, LiquidationRoute::Transfer).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        h.credit_line.liquidate(&h.keeper, &id, &LiquidationRoute::Transfer);
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Liquidating);
    }

    #[test]
    fn credit_line_persistent_and_instance_storage_extended_ttl() {
        let h = setup(2_000, 100 * PRICE_SCALE, PriceStatus::Ok);
        let agreement = BytesN::from_array(&h.env, &[7u8; 32]);
        let line = h.credit_line.open(
            &h.lender,
            &h.borrower,
            &h.asset,
            &100_000,
            &500,
            &86_400,
            &agreement,
        );

        h.env.as_contract(&h.credit_line.address, || {
            let key = DataKey::Line(line);
            assert!(h.env.storage().persistent().has(&key));
            assert_eq!(
                h.env.storage().persistent().get_ttl(&key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
            assert_eq!(
                h.env.storage().instance().get_ttl(),
                ballast_common::ttl::INSTANCE_EXTEND_TO_LEDGERS
            );
        });

        // Advance ledger sequence past the default threshold (~1 day = 17,280 ledgers)
        h.env.ledger().with_mut(|l| l.sequence_number += 505_000);

        // Reading the line extends the TTL back out
        assert_eq!(h.credit_line.borrower_of(&line), h.borrower);

        h.env.as_contract(&h.credit_line.address, || {
            let key = DataKey::Line(line);
            assert_eq!(
                h.env.storage().persistent().get_ttl(&key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
            assert_eq!(
                h.env.storage().instance().get_ttl(),
                ballast_common::ttl::INSTANCE_EXTEND_TO_LEDGERS
            );
        });

        // Advance ledger again, test explicit extend_ttl entry point
        h.env.ledger().with_mut(|l| l.sequence_number += 505_000);
        h.credit_line.extend_ttl(&line);

        h.env.as_contract(&h.credit_line.address, || {
            let key = DataKey::Line(line);
            assert_eq!(
                h.env.storage().persistent().get_ttl(&key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
            assert_eq!(
                h.env.storage().instance().get_ttl(),
                ballast_common::ttl::INSTANCE_EXTEND_TO_LEDGERS
            );
        });
    }

    #[test]
    fn interest_delta_table_driven_cases() {
        let env = Env::default();
        let addr = Address::generate(&env);
        let agreement = BytesN::from_array(&env, &[7u8; 32]);

        let make_line = |drawn: i128, rate_bps: u32, last_accrual_ts: u64| Line {
            lender: addr.clone(),
            borrower: addr.clone(),
            asset: addr.clone(),
            limit: drawn.max(1),
            funded: drawn,
            drawn,
            pledged_units: 0,
            rate_bps,
            cure_s: 86_400,
            agreement: agreement.clone(),
            status: LineStatus::Open,
            last_accrual_ts,
            accrued_interest: 0,
            margin_state: MarginState::Healthy,
            breach_ledger: None,
            breach_ltv_bps: 0,
            unhealthy_since: None,
        };

        let one_day_expected =
            (500 * PRICE_SCALE * 1_000 * 86_400) / SECONDS_PER_YEAR / BPS_DENOMINATOR;
        let large_drawn = 10_i128.pow(20);

        let cases: [(&str, i128, u32, u64, u64, i128); 7] = [
            ("full_year_10pct", 500 * PRICE_SCALE, 1_000, 1_000, 1_000 + 365 * 86_400, 50 * PRICE_SCALE),
            ("one_day_10pct", 500 * PRICE_SCALE, 1_000, 1_000, 1_000 + 86_400, one_day_expected),
            ("zero_rate", 500 * PRICE_SCALE, 0, 1_000, 1_000 + 365 * 86_400, 0),
            ("zero_drawn", 0, 1_000, 1_000, 1_000 + 365 * 86_400, 0),
            ("tiny_balance_truncates_to_zero", PRICE_SCALE, 1_000, 1_000, 1_005, 0),
            ("now_before_last_accrual_saturates_to_zero", 500 * PRICE_SCALE, 1_000, 1_000, 500, 0),
            ("large_drawn_1e20_no_overflow", large_drawn, 10_000, 0, SECONDS_PER_YEAR as u64, large_drawn),
        ];

        for (label, drawn, rate_bps, last_ts, now, expected) in cases {
            let line = make_line(drawn, rate_bps, last_ts);
            assert_eq!(interest_delta(&line, now), expected, "case {label} failed");
        }
    }

    #[test]
    fn close_liquidated_at_break_even_leaves_surplus_and_shortfall_zero() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, 60 * PRICE_SCALE / 100);
        let lender_before = h.token.balance(&h.lender);
        let borrower_before = h.token.balance(&h.borrower);

        h.credit_line.close_liquidated(&h.lender, &id);

        let record = h.credit_line.liquidation_record(&id);
        assert!(record.closed);
        assert_eq!(record.debt, 600 * PRICE_SCALE);
        assert_eq!(record.recovered, 600 * PRICE_SCALE);
        assert_eq!(record.surplus, 0);
        assert_eq!(record.shortfall, 0);
        assert_eq!(h.token.balance(&h.lender), lender_before);
        assert_eq!(h.token.balance(&h.borrower), borrower_before);
    }

    #[test]
    fn close_liquidated_clears_accrued_interest_and_writes_down_drawn_from_funded() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());

        h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        h.price_guard.set_price(&(50 * PRICE_SCALE / 100), &PriceStatus::Ok);
        h.credit_line.poke(&id);
        h.env.ledger().set_sequence_number(h.env.ledger().sequence() + 2);
        h.credit_line.liquidate(&h.keeper, &id, &LiquidationRoute::Transfer);
        h.credit_line.close_liquidated(&h.lender, &id);

        let record = h.credit_line.liquidation_record(&id);
        assert_eq!(record.debt, 550 * PRICE_SCALE);
        assert_eq!(record.recovered, 500 * PRICE_SCALE);
        assert_eq!(record.shortfall, 50 * PRICE_SCALE);
        assert_eq!(record.surplus, 0);

        let line = h.credit_line.line(&id);
        assert_eq!(line.status, LineStatus::Closed);
        assert_eq!(line.drawn, 0);
        assert_eq!(line.accrued_interest, 0);
        assert_eq!(line.funded, 500 * PRICE_SCALE);
    }

    #[test]
    fn pre_liquidation_repaid_interest_remains_withdrawable_after_close() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &(600 * PRICE_SCALE), &h.borrower.clone());

        h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        let interest = 60 * PRICE_SCALE;
        h.token.mint(&h.borrower, &interest);
        let applied = h.credit_line.repay(&h.borrower, &id, &interest);
        assert_eq!(applied, interest);
        assert_eq!(h.credit_line.claimable_interest(&id), interest);

        h.price_guard.set_price(&(50 * PRICE_SCALE / 100), &PriceStatus::Ok);
        h.credit_line.poke(&id);
        h.env.ledger().set_sequence_number(h.env.ledger().sequence() + 2);
        h.credit_line.liquidate(&h.keeper, &id, &LiquidationRoute::Transfer);
        h.credit_line.close_liquidated(&h.lender, &id);

        assert_eq!(h.credit_line.claimable_interest(&id), interest);
        assert_eq!(h.credit_line.line(&id).funded, 400 * PRICE_SCALE);

        h.credit_line.withdraw_interest(&h.lender, &id, &interest);
        h.credit_line.withdraw_undrawn(&h.lender, &id, &(400 * PRICE_SCALE));
        assert_eq!(h.credit_line.claimable_interest(&id), 0);
        assert_eq!(h.token.balance(&h.lender), 460 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.credit_line.address), 0);
    }

    #[test]
    #[should_panic(expected = "credit-line: not this line's borrower")]
    fn draw_rejects_wrong_borrower() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        let impostor = Address::generate(&h.env);
        h.credit_line.draw(&impostor, &id, &(10 * PRICE_SCALE), &impostor);
    }

    #[test]
    #[should_panic(expected = "credit-line: draw exceeds funded-but-undrawn balance")]
    fn draw_rejects_overdraw_beyond_funded_balance() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 100 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(10_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id, &(101 * PRICE_SCALE), &h.borrower.clone());
    }

    #[test]
    #[should_panic(expected = "credit-line: line is not open")]
    fn draw_rejects_non_open_line() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, PRICE_SCALE / 2);
        h.credit_line
            .draw(&h.borrower, &id, &(1 * PRICE_SCALE), &h.borrower.clone());
    }

    #[test]
    #[should_panic(expected = "credit-line: amount must be positive")]
    fn draw_rejects_non_positive_amount() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line.draw(&h.borrower, &id, &0, &h.borrower.clone());
    }

    #[test]
    fn draw_rejections_leave_line_state_and_balances_unchanged() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 100 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(10_000 * PRICE_SCALE));

        let impostor = Address::generate(&h.env);
        for res in [
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                h.credit_line.draw(&impostor, &id, &(10 * PRICE_SCALE), &impostor);
            })),
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                h.credit_line.draw(&h.borrower, &id, &(101 * PRICE_SCALE), &h.borrower.clone());
            })),
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                h.credit_line.draw(&h.borrower, &id, &0, &h.borrower.clone());
            })),
        ] {
            assert!(res.is_err());
        }

        let line = h.credit_line.line(&id);
        assert_eq!(line.drawn, 0);
        assert_eq!(line.funded, 100 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.credit_line.address), 100 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
    }

    #[test]
    fn configure_asset_and_set_vault_require_stored_admin() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let impostor = Address::generate(&h.env);
        let alt_pg = Address::generate(&h.env);
        let alt_usdc = Address::generate(&h.env);
        let thresholds = MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        };

        h.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "configure_asset",
                args: (
                    impostor.clone(),
                    h.asset.clone(),
                    alt_pg.clone(),
                    alt_usdc.clone(),
                    2_500u32,
                    thresholds.clone(),
                )
                    .into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let res_cfg = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line
                .configure_asset(&impostor, &h.asset, &alt_pg, &alt_usdc, &2_500, &thresholds);
        }));
        assert!(res_cfg.is_err(), "impostor cannot reconfigure asset");

        let impostor_vault = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &h.credit_line.address,
                fn_name: "set_vault",
                args: (impostor.clone(), impostor_vault.clone()).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let res_vault = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.credit_line.set_vault(&impostor, &impostor_vault);
        }));
        assert!(res_vault.is_err(), "impostor cannot set vault");

        h.env.as_contract(&h.credit_line.address, || {
            let cfg = read_asset_config(&h.env, &h.asset);
            assert_eq!(cfg.haircut_bps, 500);
            assert_eq!(cfg.usdc, h.token.address);
            let v: Option<Address> = h.env.storage().instance().get(&DataKey::Vault);
            assert_eq!(v, None);
        });

        h.env.mock_all_auths();
        let new_vault = Address::generate(&h.env);
        h.credit_line
            .configure_asset(&h.admin, &h.asset, &alt_pg, &h.token.address, &2_500, &thresholds);
        h.credit_line.set_vault(&h.admin, &new_vault);

        h.env.as_contract(&h.credit_line.address, || {
            let cfg = read_asset_config(&h.env, &h.asset);
            assert_eq!(cfg.haircut_bps, 2_500);
            assert_eq!(cfg.price_guard, alt_pg);
        });

        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_from_vault(&new_vault, &id, &h.asset, &(500 * PRICE_SCALE));
        assert_eq!(h.credit_line.line(&id).pledged_units, 500 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "credit-line: already initialized")]
    fn initialize_twice_panics_with_exact_message() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let alt = Address::generate(&h.env);
        h.credit_line.initialize(&alt, &alt, &alt, &alt, &alt);
    }

    #[test]
    fn initialize_stores_all_five_roles_and_preserves_first_admin_after_reinit_failure() {
        let env = Env::default();
        let cl_id = env.register(CreditLine, ());
        let cl = CreditLineClient::new(&env, &cl_id);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);

        cl.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

        env.as_contract(&cl_id, || {
            let stored = access::read_roles(&env);
            assert_eq!(stored.admin, admin);
            assert_eq!(stored.pauser, pauser);
            assert_eq!(stored.keeper, keeper);
            assert_eq!(stored.price_publisher, price_publisher);
            assert_eq!(stored.risk, risk);
        });

        let alt = Address::generate(&env);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cl.initialize(&alt, &alt, &alt, &alt, &alt);
        }));
        assert!(res.is_err(), "second initialize must fail");

        env.as_contract(&cl_id, || {
            let stored = access::read_roles(&env);
            assert_eq!(stored.admin, admin);
            assert_eq!(stored.pauser, pauser);
            assert_eq!(stored.keeper, keeper);
            assert_eq!(stored.price_publisher, price_publisher);
            assert_eq!(stored.risk, risk);
        });
    }

    #[test]
    #[should_panic(expected = "ballast-common: paused")]
    fn draw_panics_when_draws_scope_paused() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        // TODO: switch from `as_contract(set_paused)` once on-chain pause forwarding (#30/#32) lands.
        h.env.as_contract(&h.credit_line.address, || {
            pause::set_paused(&h.env, &PauseScope::Draws, true);
        });
        h.credit_line
            .draw(&h.borrower, &id, &(10 * PRICE_SCALE), &h.borrower.clone());
    }

    #[test]
    #[should_panic(expected = "ballast-common: paused")]
    fn draw_panics_when_all_scope_paused() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.env.as_contract(&h.credit_line.address, || {
            pause::set_paused(&h.env, &PauseScope::All, true);
        });
        h.credit_line
            .draw(&h.borrower, &id, &(10 * PRICE_SCALE), &h.borrower.clone());
    }

    #[test]
    fn ungated_exit_and_liquidation_paths_succeed_under_all_pause() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);

        let id_repay = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id_repay, &(1_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id_repay, &(500 * PRICE_SCALE), &h.borrower.clone());
        h.env
            .ledger()
            .set_timestamp(h.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        h.token.mint(&h.borrower, &(50 * PRICE_SCALE));

        let id_liq = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id_liq, &(1_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id_liq, &(600 * PRICE_SCALE), &h.borrower.clone());

        h.price_guard.set_price(&(50 * PRICE_SCALE / 100), &PriceStatus::Ok);

        h.env.as_contract(&h.credit_line.address, || {
            pause::set_paused(&h.env, &PauseScope::All, true);
        });

        let applied = h.credit_line.repay(&h.borrower, &id_repay, &(550 * PRICE_SCALE));
        assert_eq!(applied, 550 * PRICE_SCALE);
        h.credit_line.withdraw_interest(&h.lender, &id_repay, &(50 * PRICE_SCALE));
        h.credit_line.withdraw_undrawn(&h.lender, &id_repay, &(1_000 * PRICE_SCALE));

        let state = h.credit_line.poke(&id_liq);
        assert_eq!(state, MarginState::Liquidation);
        h.env
            .ledger()
            .set_sequence_number(h.env.ledger().sequence() + 2);
        h.credit_line
            .liquidate(&h.keeper, &id_liq, &LiquidationRoute::Transfer);
        h.credit_line.close_liquidated(&h.lender, &id_liq);
        assert_eq!(h.credit_line.line(&id_liq).status, LineStatus::Closed);
    }

    #[test]
    fn ltv_view_reflects_accrued_interest_zero_collateral_and_degraded_price() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id, &(500 * PRICE_SCALE), &h.borrower.clone());

        h.env
            .ledger()
            .set_timestamp(h.env.ledger().timestamp() + 365 * 24 * 60 * 60);
        let view1 = h.credit_line.ltv(&id);
        assert_eq!(view1.debt, 550 * PRICE_SCALE);
        assert_eq!(view1.collateral_value, 1_000 * PRICE_SCALE);
        assert_eq!(view1.ltv_bps, 5_500);
        assert_eq!(view1.state, MarginState::Healthy);
        assert_eq!(view1.price_status, PriceStatus::Ok);

        h.price_guard.set_price(&PRICE_SCALE, &PriceStatus::Degraded);
        let view_deg = h.credit_line.ltv(&id);
        assert_eq!(view_deg.debt, 550 * PRICE_SCALE);
        assert_eq!(view_deg.collateral_value, 1_000 * PRICE_SCALE);
        assert_eq!(view_deg.ltv_bps, 5_500);
        assert_eq!(view_deg.state, MarginState::Healthy);
        assert_eq!(view_deg.price_status, PriceStatus::Degraded);

        h.price_guard.set_price(&PRICE_SCALE, &PriceStatus::Ok);
        h.credit_line.sync_collateral(&h.admin, &id, &0);
        let view_zero = h.credit_line.ltv(&id);
        assert_eq!(view_zero.debt, 550 * PRICE_SCALE);
        assert_eq!(view_zero.collateral_value, 0);
        assert_eq!(view_zero.ltv_bps, u32::MAX);
        assert_eq!(view_zero.state, MarginState::Liquidation);
        assert_eq!(view_zero.price_status, PriceStatus::Ok);
    }

    #[test]
    #[should_panic(expected = "credit-line: unknown line")]
    fn ltv_panics_for_unknown_line() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        h.credit_line.ltv(&999);
    }

    #[test]
    #[should_panic(expected = "credit-line: amount must be positive")]
    fn withdraw_undrawn_zero_amount_panics() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.withdraw_undrawn(&h.lender, &id, &0);
    }

    #[test]
    #[should_panic(expected = "credit-line: amount must be positive")]
    fn withdraw_interest_zero_amount_panics() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.withdraw_interest(&h.lender, &id, &0);
    }

    #[test]
    #[should_panic(expected = "credit-line: withdrawal exceeds the interest repaid")]
    fn withdraw_interest_with_none_repaid_panics() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.withdraw_interest(&h.lender, &id, &(1 * PRICE_SCALE));
    }

    #[test]
    fn withdraw_undrawn_exact_remaining_leaves_funded_equal_drawn() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line.sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        h.credit_line
            .draw(&h.borrower, &id, &(400 * PRICE_SCALE), &h.borrower.clone());

        h.credit_line
            .withdraw_undrawn(&h.lender, &id, &(600 * PRICE_SCALE));
        let line = h.credit_line.line(&id);
        assert_eq!(line.funded, 400 * PRICE_SCALE);
        assert_eq!(line.funded, line.drawn);
        assert_eq!(h.token.balance(&h.credit_line.address), 0);
        assert_eq!(h.token.balance(&h.lender), 600 * PRICE_SCALE);
    }

    #[test]
    fn withdraw_undrawn_succeeds_on_closed_line_after_shortfall_close() {
        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let id = liquidated_line(&h, PRICE_SCALE / 2);
        h.credit_line.close_liquidated(&h.lender, &id);
        assert_eq!(h.credit_line.line(&id).status, LineStatus::Closed);
        assert_eq!(h.credit_line.line(&id).funded, 400 * PRICE_SCALE);

        h.credit_line
            .withdraw_undrawn(&h.lender, &id, &(400 * PRICE_SCALE));
        let after = h.credit_line.line(&id);
        assert_eq!(after.status, LineStatus::Closed);
        assert_eq!(after.funded, 0);
        assert_eq!(h.token.balance(&h.lender), 400 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.credit_line.address), 0);
    }

    #[test]
    fn property_contract_usdc_always_equals_funded_minus_drawn_plus_claimable() {
        const SEED: u64 = 0xB411_A570_0000_0148;
        struct Lcg(u64);
        impl Lcg {
            fn next_u64(&mut self) -> u64 {
                self.0 = self
                    .0
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                self.0
            }
            fn range_i128(&mut self, lo: i128, hi: i128) -> i128 {
                let span = (hi - lo + 1) as u64;
                lo + (self.next_u64() % span) as i128
            }
        }

        let h = setup(0, PRICE_SCALE, PriceStatus::Ok);
        let limit = 10_000 * PRICE_SCALE;
        let collateral_units = 20_000 * PRICE_SCALE;
        let ids = [
            open_and_fund(&h, limit, 1_000 * PRICE_SCALE),
            open_and_fund(&h, limit, 1_000 * PRICE_SCALE),
            open_and_fund(&h, limit, 1_000 * PRICE_SCALE),
        ];
        for id in ids {
            h.credit_line.sync_collateral(&h.admin, &id, &collateral_units);
        }

        let check_invariant = |step: usize, op: &str| {
            let mut expected = 0i128;
            for id in ids {
                let line = h.credit_line.line(&id);
                let claimable = h.credit_line.claimable_interest(&id);
                expected += line.funded - line.drawn + claimable;
            }
            let actual = h.token.balance(&h.credit_line.address);
            assert_eq!(
                actual, expected,
                "USDC conservation invariant violated (seed={SEED:#x}, step={step}, op={op})"
            );
        };

        check_invariant(0, "init");

        let mut rng = Lcg(SEED);
        for step in 1..=240usize {
            let dt = (rng.next_u64() % 20) * 86_400;
            if dt > 0 {
                h.env.ledger().set_timestamp(h.env.ledger().timestamp() + dt);
            }

            let id = ids[(rng.next_u64() % ids.len() as u64) as usize];
            let op_idx = rng.next_u64() % 5;
            let op_name = match op_idx {
                0 => {
                    let amt = rng.range_i128(1, 500) * PRICE_SCALE;
                    h.token.mint(&h.lender, &amt);
                    h.credit_line.fund(&h.lender, &id, &amt);
                    "fund"
                }
                1 => {
                    let line = h.credit_line.line(&id);
                    let owed = h.credit_line.debt_of(&id);
                    let healthy_debt_cap = (collateral_units * 6_900) / 10_000;
                    let max_draw = (line.funded - line.drawn)
                        .min(line.limit - line.drawn)
                        .min(healthy_debt_cap - owed);
                    if max_draw >= PRICE_SCALE {
                        let max_whole = (max_draw / PRICE_SCALE).min(500);
                        let amt = rng.range_i128(1, max_whole) * PRICE_SCALE;
                        h.credit_line.draw(&h.borrower, &id, &amt, &h.borrower.clone());
                    }
                    "draw"
                }
                2 => {
                    let owed = h.credit_line.debt_of(&id);
                    if owed > 0 {
                        let amt = if rng.next_u64() % 4 == 0 {
                            owed + 25 * PRICE_SCALE
                        } else {
                            let half = (owed / 2).max(1);
                            rng.range_i128(1, half).min(owed)
                        };
                        h.token.mint(&h.borrower, &amt);
                        h.credit_line.repay(&h.borrower, &id, &amt);
                    }
                    "repay"
                }
                3 => {
                    let line = h.credit_line.line(&id);
                    let avail = line.funded - line.drawn;
                    if avail >= PRICE_SCALE {
                        let max_whole = (avail / PRICE_SCALE).min(400);
                        let amt = rng.range_i128(1, max_whole) * PRICE_SCALE;
                        h.credit_line.withdraw_undrawn(&h.lender, &id, &amt);
                    }
                    "withdraw_undrawn"
                }
                _ => {
                    let claimable = h.credit_line.claimable_interest(&id);
                    if claimable > 0 {
                        let amt = rng.range_i128(1, claimable);
                        h.credit_line.withdraw_interest(&h.lender, &id, &amt);
                    }
                    "withdraw_interest"
                }
            };

            check_invariant(step, op_name);
        }
    }

    #[test]
    fn liquidate_publishes_liquidation_started_event_and_none_on_failure() {
        use soroban_sdk::testutils::Events as _;
        use soroban_sdk::TryFromVal;

        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        let to = Address::generate(&h.env);
        h.credit_line
            .draw(&h.borrower, &id, &(500 * PRICE_SCALE), &to);

        // No event when liquidate fails before a flagged breach.
        assert!(h
            .credit_line
            .try_liquidate(&h.keeper, &id, &LiquidationRoute::Transfer)
            .is_err());
        assert!(h.env.events().all().filter_by_contract(&h.credit_line.address).events().is_empty());

        // Drop price to $0.50 -> breach LTV, flag via poke, advance ledger, liquidate.
        h.price_guard.set_price(&(PRICE_SCALE / 2), &PriceStatus::Ok);
        h.credit_line.poke(&id);
        h.env.ledger().with_mut(|l| l.sequence_number += 1);

        h.credit_line
            .liquidate(&h.keeper, &id, &LiquidationRoute::Transfer);

        let events = h.env.events().all().filter_by_contract(&h.credit_line.address);
        let items = events.events();
        assert_eq!(items.len(), 1);
        let body = match &items[0].body {
            soroban_sdk::xdr::ContractEventBody::V0(b) => b,
        };
        let topic0 = Symbol::try_from_val(
            &h.env,
            &soroban_sdk::Val::try_from_val(&h.env, &body.topics[0]).unwrap(),
        )
        .unwrap();
        let topic1 = u64::try_from_val(
            &h.env,
            &soroban_sdk::Val::try_from_val(&h.env, &body.topics[1]).unwrap(),
        )
        .unwrap();
        assert_eq!(topic0, Symbol::new(&h.env, "liquidation_started"));
        assert_eq!(topic1, id);

        let data: (LiquidationRoute, i128, i128, i128) = TryFromVal::try_from_val(
            &h.env,
            &soroban_sdk::Val::try_from_val(&h.env, &body.data).unwrap(),
        )
        .unwrap();
        assert_eq!(data.0, LiquidationRoute::Transfer);
        assert_eq!(data.1, 1_000 * PRICE_SCALE);
        assert_eq!(data.2, PRICE_SCALE / 2);
        assert_eq!(data.3, 500 * PRICE_SCALE);
    }

    #[test]
    fn withdraw_interest_publishes_event_and_none_on_failure() {
        use soroban_sdk::testutils::Events as _;
        use soroban_sdk::TryFromVal;

        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));
        let to = Address::generate(&h.env);
        h.credit_line
            .draw(&h.borrower, &id, &(500 * PRICE_SCALE), &to);

        h.env.ledger().with_mut(|l| l.timestamp += 365 * 24 * 60 * 60);
        let repay_amount = 50 * PRICE_SCALE;
        h.token.mint(&h.borrower, &repay_amount);
        h.credit_line.repay(&h.borrower, &id, &repay_amount);

        // Over-withdrawal fails without emitting an event.
        assert!(h
            .credit_line
            .try_withdraw_interest(&h.lender, &id, &(51 * PRICE_SCALE))
            .is_err());
        assert!(h.env.events().all().filter_by_contract(&h.credit_line.address).events().is_empty());

        let withdraw_amount = 30 * PRICE_SCALE;
        h.credit_line
            .withdraw_interest(&h.lender, &id, &withdraw_amount);

        let events = h.env.events().all().filter_by_contract(&h.credit_line.address);
        let items = events.events();
        assert_eq!(items.len(), 1);
        let body = match &items[0].body {
            soroban_sdk::xdr::ContractEventBody::V0(b) => b,
        };
        let topic0 = Symbol::try_from_val(
            &h.env,
            &soroban_sdk::Val::try_from_val(&h.env, &body.topics[0]).unwrap(),
        )
        .unwrap();
        let topic1 = u64::try_from_val(
            &h.env,
            &soroban_sdk::Val::try_from_val(&h.env, &body.topics[1]).unwrap(),
        )
        .unwrap();
        assert_eq!(topic0, Symbol::new(&h.env, "interest_withdrawn"));
        assert_eq!(topic1, id);

        let data: (Address, i128, i128) = TryFromVal::try_from_val(
            &h.env,
            &soroban_sdk::Val::try_from_val(&h.env, &body.data).unwrap(),
        )
        .unwrap();
        assert_eq!(data, (h.lender.clone(), withdraw_amount, 20 * PRICE_SCALE));
    }
}
