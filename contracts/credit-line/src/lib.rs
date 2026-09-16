#![cfg_attr(not(test), no_std)]

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
//! **Documented simplification — collateral sync.** `sync_collateral` is a keeper/admin-gated
//! entry point that sets `pledged_units` directly, rather than `CreditLine` doing a live
//! cross-contract read of `PledgeVault`'s actual position on every draw/ltv call. In the real
//! system the off-chain `margin-monitor` service (PRD §6.5) keeps this synced from `PledgeVault`'s
//! on-chain balance via the indexer. Keeping it an explicit sync call (rather than a direct
//! `CreditLine -> PledgeVault` read) also avoids a circular contract dependency, since
//! `PledgeVault::release` already cross-calls *this* contract's `ltv` view the other way.
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

use ballast_common::{
    access::{self, Roles},
    margin::{self, LiquidationRoute, MarginState, MarginThresholds},
    pause::{self, PauseScope},
    price::{GuardedPrice, PriceStatus},
    risk,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, BytesN, Env,
    MuxedAddress,
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
}

#[contracttype]
enum DataKey {
    AssetConfig(Address),
    NextLineId,
    Line(u64),
}

fn read_line(env: &Env, line: u64) -> Line {
    env.storage()
        .persistent()
        .get(&DataKey::Line(line))
        .expect("credit-line: unknown line")
}

fn write_line(env: &Env, line: u64, state: &Line) {
    env.storage().persistent().set(&DataKey::Line(line), state);
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
    let config = read_asset_config(env, &line.asset);
    let guarded = PriceGuardClient::new(env, &config.price_guard).guarded_price(&line.asset);

    let debt =
        line.drawn + line.accrued_interest + interest_delta(line, env.ledger().timestamp());
    let collateral_value =
        risk::collateral_value(line.pledged_units, guarded.value, config.haircut_bps);
    let ltv_bps = risk::ltv_bps(debt, collateral_value);
    let margin_state = margin::classify(ltv_bps, &config.thresholds);

    LtvView {
        debt,
        collateral_value,
        ltv_bps,
        state: margin_state,
        price_status: guarded.status,
    }
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
        let _ = admin;
        access::require_admin(&env);
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
        lender.require_auth();
        assert!(limit > 0, "credit-line: limit must be positive");

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextLineId)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::NextLineId, &(id + 1));

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
            },
        );
        id
    }

    /// Funds the line with USDC that sits here, undrawn, until `draw` pulls it out (PRD §6.2:
    /// "USDC in transit only").
    pub fn fund(env: Env, lender: Address, line: u64, amount: i128) {
        lender.require_auth();
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);
        assert_eq!(state.lender, lender, "credit-line: not this line's lender");

        let config = read_asset_config(&env, &state.asset);
        token::Client::new(&env, &config.usdc).transfer(
            &lender,
            &muxed(&env.current_contract_address()),
            &amount,
        );

        state.funded += amount;
        write_line(&env, line, &state);
    }

    /// Sets the line's locally-tracked collateral figure. See module docs: in the real system
    /// the off-chain `margin-monitor` service keeps this synced from `PledgeVault`'s actual
    /// on-chain balance; this skeleton exposes the sync point as a keeper/admin-gated call
    /// instead of a live cross-contract read, to avoid a circular `CreditLine <-> PledgeVault`
    /// dependency (`PledgeVault::release` already reads `CreditLine::ltv` the other way).
    pub fn sync_collateral(env: Env, caller: Address, line: u64, units: i128) {
        access::require_admin_or_keeper(&env, &caller);
        assert!(units >= 0, "credit-line: units cannot be negative");

        let mut state = read_line(&env, line);
        state.pledged_units = units;
        write_line(&env, line, &state);
    }

    /// PRD §8 invariant 1 ("never over-lent") and invariant 2 ("no draws on a bad price"). Both
    /// are enforced here before a single stroop of USDC moves.
    pub fn draw(env: Env, borrower: Address, line: u64, amount: i128, to: Address) {
        borrower.require_auth();
        pause::require_not_paused(&env, &PauseScope::Draws);
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);
        assert_eq!(
            state.borrower, borrower,
            "credit-line: not this line's borrower"
        );
        assert_eq!(state.status, LineStatus::Open, "credit-line: line is not open");

        let now = env.ledger().timestamp();
        state.accrued_interest += interest_delta(&state, now);
        state.last_accrual_ts = now;

        assert!(
            amount <= state.funded - state.drawn,
            "credit-line: draw exceeds funded-but-undrawn balance"
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
            &muxed(&to),
            &amount,
        );

        state.drawn += amount;
        state.margin_state = margin_state;
        write_line(&env, line, &state);
    }

    /// PRD §8 invariant 5 ("pausing cannot move funds"): deliberately *not* gated by
    /// `require_not_paused` — repayment must always work while `Draws` (or any scope) is paused.
    pub fn repay(env: Env, payer: Address, line: u64, amount: i128) {
        payer.require_auth();
        assert!(amount > 0, "credit-line: amount must be positive");

        let mut state = read_line(&env, line);

        let now = env.ledger().timestamp();
        state.accrued_interest += interest_delta(&state, now);
        state.last_accrual_ts = now;

        let mut remaining = amount;
        let pay_interest = remaining.min(state.accrued_interest);
        state.accrued_interest -= pay_interest;
        remaining -= pay_interest;

        let pay_principal = remaining.min(state.drawn);
        state.drawn -= pay_principal;
        remaining -= pay_principal;

        assert_eq!(remaining, 0, "credit-line: repayment exceeds amount owed");

        let config = read_asset_config(&env, &state.asset);
        token::Client::new(&env, &config.usdc).transfer(
            &payer,
            &muxed(&env.current_contract_address()),
            &amount,
        );

        write_line(&env, line, &state);
    }

    /// Pure read (no auth): PRD §8 `{ debt, collateral_value, ltv_bps, state, price_status }`.
    /// This is what `PledgeVault::release` cross-calls.
    pub fn ltv(env: Env, line: u64) -> LtvView {
        let state = read_line(&env, line);
        compute_ltv(&env, &state)
    }

    /// Permissionless: recomputes the margin state via a fresh price read and persists it, also
    /// arming (or clearing) the breach flag `liquidate` needs. Anyone may call this — it can only
    /// ever make on-chain state match a fresh price read, never move funds.
    pub fn poke(env: Env, line: u64) -> MarginState {
        let mut state = read_line(&env, line);
        let view = compute_ltv(&env, &state);
        state.margin_state = view.state.clone();

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
        let _ = keeper;
        access::require_keeper(&env);
        let _ = route;

        let mut state = read_line(&env, line);
        let breach_ledger = state
            .breach_ledger
            .expect("credit-line: no confirmed breach flagged; call poke(line) first");
        assert!(
            env.ledger().sequence() > breach_ledger,
            "credit-line: liquidation needs a later ledger than the flagged breach"
        );

        let view = compute_ltv(&env, &state);
        assert!(
            matches!(view.price_status, PriceStatus::Ok),
            "credit-line: price status is not Ok"
        );
        assert!(
            matches!(view.state, MarginState::Liquidation),
            "credit-line: breach is no longer confirmed"
        );

        state.status = LineStatus::Liquidating;
        state.margin_state = MarginState::Liquidation;
        write_line(&env, line, &state);
    }

    /// Read-only helper for consoles/tests.
    pub fn line(env: Env, line: u64) -> Line {
        read_line(&env, line)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ballast_common::price::PRICE_SCALE;
    use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
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
                env.storage().instance().set(&from_key, &(from_bal - amount));
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

    #[test]
    fn draw_and_repay_happy_path() {
        // 5% haircut, $1.00 price, 1000 units pledged -> $950 collateral value.
        let h = setup(500, PRICE_SCALE, PriceStatus::Ok);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        // $500 draw against $950 collateral -> 5263 bps, Healthy (<7000).
        let to = Address::generate(&h.env);
        h.credit_line.draw(&h.borrower, &id, &(500 * PRICE_SCALE), &to);
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
        h.credit_line.draw(&h.borrower, &id, &(900 * PRICE_SCALE), &to);
    }

    #[test]
    #[should_panic(expected = "credit-line: price status is not Ok")]
    fn no_draw_on_bad_price() {
        let h = setup(500, PRICE_SCALE, PriceStatus::Degraded);
        let id = open_and_fund(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
        h.credit_line
            .sync_collateral(&h.admin, &id, &(1_000 * PRICE_SCALE));

        let to = Address::generate(&h.env);
        h.credit_line.draw(&h.borrower, &id, &(10 * PRICE_SCALE), &to);
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
            h.credit_line.draw(&h.borrower, &id, &(1 * PRICE_SCALE), &to);
        }));
        assert!(
            result.is_err(),
            "credit-line: draw should have panicked while Draws is paused"
        );
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
}
