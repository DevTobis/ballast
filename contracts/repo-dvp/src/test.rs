//! Unit tests for `RepoDvP`. Uses minimal in-crate mock tokens (RWA leg and USDC leg) and a
//! minimal in-crate mock `PriceGuard`, per the skeleton scope. The important test here is
//! `accept_and_settle_reverts_atomically_on_insufficient_cash` (invariant 7): leg 1 must be
//! all-or-nothing.

use super::*;
use ballast_common::price::{PriceStatus, PRICE_SCALE};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Env;
use std::panic::{self, AssertUnwindSafe};

mod mock_price_guard {
    use ballast_common::price::{GuardedPrice, PriceStatus};
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    #[derive(Clone)]
    struct StoredPrice {
        value: i128,
        status: PriceStatus,
        ts: u64,
    }

    #[contracttype]
    enum DataKey {
        Price(Address),
    }

    #[contract]
    pub struct MockPriceGuard;

    #[contractimpl]
    impl MockPriceGuard {
        pub fn set_price(env: Env, asset: Address, value: i128, status: PriceStatus, ts: u64) {
            env.storage()
                .instance()
                .set(&DataKey::Price(asset), &StoredPrice { value, status, ts });
        }

        pub fn guarded_price(env: Env, asset: Address) -> GuardedPrice {
            let stored: StoredPrice = env
                .storage()
                .instance()
                .get(&DataKey::Price(asset.clone()))
                .expect("mock-price-guard: price not set");
            GuardedPrice {
                asset,
                value: stored.value,
                status: stored.status,
                ts: stored.ts,
                sources: soroban_sdk::vec![&env],
            }
        }
    }
}

mod mock_token {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, MuxedAddress};

    #[contracttype]
    enum DataKey {
        Balance(Address),
        Allowance(Address, Address),
    }

    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let balance = Self::balance(env.clone(), to.clone());
            env.storage()
                .persistent()
                .set(&DataKey::Balance(to), &(balance + amount));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&DataKey::Balance(id))
                .unwrap_or(0)
        }

        pub fn approve(
            env: Env,
            from: Address,
            spender: Address,
            amount: i128,
            _expiration_ledger: u32,
        ) {
            from.require_auth();
            env.storage()
                .persistent()
                .set(&DataKey::Allowance(from, spender), &amount);
        }

        pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&DataKey::Allowance(from, spender))
                .unwrap_or(0)
        }

        pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
            spender.require_auth();
            let allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
            if allowance < amount {
                panic!("mock-token: insufficient allowance");
            }
            let from_balance = Self::balance(env.clone(), from.clone());
            if from_balance < amount {
                panic!("mock-token: insufficient balance");
            }
            let to_balance = Self::balance(env.clone(), to.clone());
            env.storage().persistent().set(
                &DataKey::Allowance(from.clone(), spender),
                &(allowance - amount),
            );
            env.storage()
                .persistent()
                .set(&DataKey::Balance(from), &(from_balance - amount));
            env.storage()
                .persistent()
                .set(&DataKey::Balance(to), &(to_balance + amount));
        }

        pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
            from.require_auth();
            let to_addr = to.address();
            let from_balance = Self::balance(env.clone(), from.clone());
            if from_balance < amount {
                panic!("mock-token: insufficient balance");
            }
            let to_balance = Self::balance(env.clone(), to_addr.clone());
            env.storage()
                .persistent()
                .set(&DataKey::Balance(from), &(from_balance - amount));
            env.storage()
                .persistent()
                .set(&DataKey::Balance(to_addr), &(to_balance + amount));
        }
    }
}

use mock_price_guard::{MockPriceGuard, MockPriceGuardClient};
use mock_token::{MockToken, MockTokenClient};

#[allow(dead_code)]
struct Harness {
    env: Env,
    repo: Address,
    admin: Address,
    keeper: Address,
    price_guard: Address,
    rwa: Address,
    usdc: Address,
    cash_lender: Address,
    cash_borrower: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    // Strict mocking: only authorizations reachable from the top-level caller count. Every
    // cash leg must therefore work off that caller's signature or a previously granted allowance,
    // exactly as on a real network.
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let keeper = Address::generate(&env);
    let price_publisher = Address::generate(&env);
    let risk = Address::generate(&env);

    let repo = env.register(RepoDvp, ());
    RepoDvpClient::new(&env, &repo).initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

    let price_guard = env.register(MockPriceGuard, ());
    let rwa = env.register(MockToken, ());
    let usdc = env.register(MockToken, ());

    RepoDvpClient::new(&env, &repo).set_usdc(&admin, &usdc);
    RepoDvpClient::new(&env, &repo).configure_asset(
        &admin,
        &rwa,
        &price_guard,
        &500u32, // 5% haircut
        &MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_500,
        },
    );
    MockPriceGuardClient::new(&env, &price_guard).set_price(
        &rwa,
        &PRICE_SCALE,
        &PriceStatus::Ok,
        &env.ledger().timestamp(),
    );

    let cash_lender = Address::generate(&env);
    let cash_borrower = Address::generate(&env);

    Harness {
        env,
        repo,
        admin,
        keeper,
        price_guard,
        rwa,
        usdc,
        cash_lender,
        cash_borrower,
    }
}

fn hash(h: &Harness, b: u8) -> BytesN<32> {
    BytesN::from_array(&h.env, &[b; 32])
}

fn propose(h: &Harness, units: i128, cash_amount: i128, rate_bps: u32, maturity_at: u64) -> u64 {
    RepoDvpClient::new(&h.env, &h.repo).propose(
        &h.cash_lender,
        &h.cash_borrower,
        &h.rwa,
        &units,
        &cash_amount,
        &rate_bps,
        &RepoKind::Intraday,
        &maturity_at,
        &hash(h, 7),
    )
}

#[test]
fn accept_and_settle_reverts_atomically_on_insufficient_cash() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    // The borrower has the RWA to pledge, but the lender does NOT have enough USDC to pay out --
    // leg 2 of accept_and_settle (cash_lender -> cash_borrower) must fail.
    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    // h.cash_lender's USDC balance is left at zero on purpose.

    let repo = h.repo.clone();
    let cash_borrower = h.cash_borrower.clone();
    let env = h.env.clone();
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        RepoDvpClient::new(&env, &repo).accept_and_settle(&cash_borrower, &id);
    }));
    assert!(result.is_err(), "accept_and_settle should have panicked");

    // Invariant 7: neither leg actually applied. The contract holds no RWA for this trade, the
    // borrower still has their units, and the trade is still "proposed", not "settled".
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.repo), 0);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.rwa).balance(&h.cash_borrower),
        units
    );
    let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
    assert_eq!(trade.status, RepoStatus::Proposed);
}

#[test]
fn accept_and_settle_then_unwind_pays_principal_plus_interest() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let rate_bps = 500u32; // 5% annualized
    let term_seconds = 3_600u64;
    let maturity = h.env.ledger().timestamp() + term_seconds;
    let id = propose(&h, units, cash_amount, rate_bps, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.repo), units);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&h.cash_borrower),
        cash_amount
    );

    let expected_interest = accrue_interest(cash_amount, rate_bps, term_seconds);
    assert!(expected_interest > 0);
    // The borrower needs to have earned/sourced the interest from somewhere else by maturity;
    // simulate that external funding here so leg 2 has enough USDC to repay principal + interest.
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &expected_interest);

    h.env.ledger().set_timestamp(maturity);
    RepoDvpClient::new(&h.env, &h.repo).unwind(&h.cash_lender, &id);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&h.cash_lender),
        cash_amount + expected_interest
    );
    assert_eq!(
        MockTokenClient::new(&h.env, &h.rwa).balance(&h.cash_borrower),
        units
    );
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.repo), 0);

    let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
    assert_eq!(trade.status, RepoStatus::Unwound);
}

/// The keeper is neither party, so nobody whose money moves is signing: leg 2 has to run on the
/// allowance the borrower granted at settlement.
#[test]
fn keeper_can_unwind_at_maturity_using_the_borrowers_allowance() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let rate_bps = 500u32;
    let term_seconds = 3_600u64;
    let maturity = h.env.ledger().timestamp() + term_seconds;
    let id = propose(&h, units, cash_amount, rate_bps, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&h.cash_borrower),
        cash_amount
    );

    // The allowance covers what leg 2 will owe (here exactly, as the proposal settled in the
    // ledger it was made in).
    let interest = accrue_interest(cash_amount, rate_bps, term_seconds);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_borrower, &h.repo),
        cash_amount + interest
    );
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &interest);

    h.env.ledger().set_timestamp(maturity);
    RepoDvpClient::new(&h.env, &h.repo).unwind(&h.keeper, &id);

    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&h.cash_lender),
        cash_amount + interest
    );
    assert_eq!(
        MockTokenClient::new(&h.env, &h.rwa).balance(&h.cash_borrower),
        units
    );
    assert_eq!(
        RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
        RepoStatus::Unwound
    );
}

#[test]
fn accept_and_settle_refuses_a_proposal_past_its_maturity() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

    h.env.ledger().set_timestamp(maturity);
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
    }));
    assert!(result.is_err());
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&h.cash_lender),
        cash_amount
    );
}

/// The expiry handed to `approve` must not depend on which ledger the call lands in, or a
/// transaction simulated in one ledger and executed in the next would fail authorization.
#[test]
fn allowance_expiry_is_stable_across_neighbouring_ledgers() {
    let h = setup();
    h.env.ledger().set_sequence_number(1_000_000);
    let at = |h: &Harness| {
        h.env
            .as_contract(&h.repo, || allowance_expiry(&h.env, 3_600, 0))
    };
    let first = at(&h);
    h.env.ledger().set_sequence_number(1_000_003);
    assert_eq!(at(&h), first);
    assert!(first >= 1_000_003 + 720);
}

/// Settles a 100-unit / 90-cash trade at $1 (95 collateral after the 5% haircut: LTV ~94.7%, in
/// the MarginCall band) and returns its id. Interest is 0 at the moment of settlement.
fn settled_under_margin(h: &Harness) -> u64 {
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 30 * 24 * 3_600;
    let id = propose(h, units, cash_amount, 500, maturity);
    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &(units * 3));
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
    id
}

fn set_price(h: &Harness, value: i128) {
    MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
        &h.rwa,
        &value,
        &PriceStatus::Ok,
        &h.env.ledger().timestamp(),
    );
}

fn rwa_balance(h: &Harness, who: &Address) -> i128 {
    MockTokenClient::new(&h.env, &h.rwa).balance(who)
}

#[test]
fn default_close_gives_the_lender_only_what_covers_the_exposure() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let borrower_before = rwa_balance(&h, &h.cash_borrower);

    repo.call_margin(&h.keeper, &id);
    let trade = repo.trade(&id);
    assert!(trade.pending_margin_call);
    assert!(trade.margin_call_amount > 0);
    let deadline = trade.cure_deadline.expect("cure deadline should be set");

    h.env.ledger().set_timestamp(deadline);
    repo.default_close(&h.keeper, &id);

    // Exposure is the 90 of cash plus ~1 day of 5% interest; at $1 that many units go to the
    // lender (rounded up) and the rest of the 100 pledged comes back to the borrower.
    let lender_units = rwa_balance(&h, &h.cash_lender);
    let borrower_back = rwa_balance(&h, &h.cash_borrower) - borrower_before;
    assert!(lender_units >= 90 * PRICE_SCALE && lender_units < 91 * PRICE_SCALE, "lender got {lender_units}");
    assert_eq!(lender_units + borrower_back, 100 * PRICE_SCALE);
    assert_eq!(rwa_balance(&h, &h.repo), 0);
    assert_eq!(repo.trade(&id).status, RepoStatus::Defaulted);
}

#[test]
fn default_close_gives_the_lender_everything_when_the_collateral_is_worth_less_than_owed() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let borrower_before = rwa_balance(&h, &h.cash_borrower);

    repo.call_margin(&h.keeper, &id);
    let deadline = repo.trade(&id).cure_deadline.unwrap();
    set_price(&h, 80 * PRICE_SCALE / 100); // 100 units are now worth 80 against 90+ owed
    h.env.ledger().set_timestamp(deadline);
    repo.default_close(&h.keeper, &id);

    assert_eq!(rwa_balance(&h, &h.cash_lender), 100 * PRICE_SCALE);
    assert_eq!(rwa_balance(&h, &h.cash_borrower), borrower_before);
}

#[test]
fn a_price_recovery_cures_the_call_and_blocks_default() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);

    repo.call_margin(&h.keeper, &id);
    let deadline = repo.trade(&id).cure_deadline.unwrap();

    set_price(&h, 2 * PRICE_SCALE);
    h.env.ledger().set_timestamp(deadline);
    let refused = panic::catch_unwind(AssertUnwindSafe(|| repo.default_close(&h.keeper, &id)));
    assert!(refused.is_err(), "default must refuse once the position is healthy again");

    repo.call_margin(&h.keeper, &id); // the keeper's next evaluation clears the call
    let trade = repo.trade(&id);
    assert!(!trade.pending_margin_call);
    assert_eq!((trade.margin_call_amount, trade.cure_deadline), (0, None));
}

#[test]
fn topping_up_cures_the_call_in_the_same_transaction() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.call_margin(&h.keeper, &id);
    assert!(repo.trade(&id).pending_margin_call);

    // 100 more units doubles the collateral: LTV ~47%, well clear of the margin-call band.
    repo.top_up(&h.cash_borrower, &id, &(100 * PRICE_SCALE));

    let trade = repo.trade(&id);
    assert!(!trade.pending_margin_call);
    assert_eq!(trade.units, 200 * PRICE_SCALE);
    assert_eq!(rwa_balance(&h, &h.repo), 200 * PRICE_SCALE);
}

#[test]
fn a_top_up_that_is_not_enough_adds_collateral_but_leaves_the_call_open() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.call_margin(&h.keeper, &id);

    repo.top_up(&h.cash_borrower, &id, &(1 * PRICE_SCALE)); // 101 units: still ~93.6% LTV

    let trade = repo.trade(&id);
    assert!(trade.pending_margin_call);
    assert_eq!(trade.units, 101 * PRICE_SCALE);
}

#[test]
fn only_the_cash_borrower_can_top_up() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let result = panic::catch_unwind(AssertUnwindSafe(|| repo.top_up(&h.cash_lender, &id, &PRICE_SCALE)));
    assert!(result.is_err());
}

#[test]
fn calling_margin_again_does_not_move_the_cure_deadline() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);

    repo.call_margin(&h.keeper, &id);
    let first = repo.trade(&id).cure_deadline.unwrap();

    h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 3_600);
    repo.call_margin(&h.keeper, &id);

    assert_eq!(repo.trade(&id).cure_deadline.unwrap(), first, "a keeper must not extend the borrower's window");
}

#[test]
fn default_before_the_cure_window_ends_is_refused() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.call_margin(&h.keeper, &id);
    let result = panic::catch_unwind(AssertUnwindSafe(|| repo.default_close(&h.keeper, &id)));
    assert!(result.is_err());
}

#[test]
fn margin_view_reports_the_position_without_changing_it() {
    let h = setup();
    let id = settled_under_margin(&h);
    let repo = RepoDvpClient::new(&h.env, &h.repo);

    let view = repo.margin_view(&id);
    assert!(view.price_ok);
    assert_eq!(view.state, MarginState::MarginCall);
    assert!(view.ltv_bps >= 8_000 && view.exposure >= 90 * PRICE_SCALE);
    assert!(!repo.trade(&id).pending_margin_call, "reading must not open a call");

    MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
        &h.rwa, &PRICE_SCALE, &PriceStatus::Degraded, &h.env.ledger().timestamp(),
    );
    assert!(!repo.margin_view(&id).price_ok);
}

#[test]
fn the_admin_can_shorten_the_cure_window_for_new_calls() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    assert_eq!(repo.cure_grace_seconds(), 24 * 60 * 60);

    repo.set_cure_grace(&h.admin, &120);
    let id = settled_under_margin(&h);
    let before = h.env.ledger().timestamp();
    repo.call_margin(&h.keeper, &id);

    assert_eq!(repo.trade(&id).cure_deadline, Some(before + 120));
}

#[test]
fn the_cure_window_has_a_floor_and_only_the_admin_sets_it() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let too_short = panic::catch_unwind(AssertUnwindSafe(|| repo.set_cure_grace(&h.admin, &30)));
    assert!(too_short.is_err(), "a 30s window must be refused");
    let stranger = Address::generate(&h.env);
    let not_admin = panic::catch_unwind(AssertUnwindSafe(|| repo.set_cure_grace(&stranger, &3_600)));
    assert!(not_admin.is_err(), "only the admin may set it");
}

#[test]
fn default_at_maturity_exact_fit() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 100 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

    let borrower_rwa_before = rwa_balance(&h, &h.cash_borrower);
    let lender_rwa_before = rwa_balance(&h, &h.cash_lender);

    let grace = RepoDvpClient::new(&h.env, &h.repo).maturity_grace_seconds();
    h.env.ledger().set_timestamp(maturity + grace);

    RepoDvpClient::new(&h.env, &h.repo).default_at_maturity(&h.cash_lender, &id);

    assert_eq!(rwa_balance(&h, &h.cash_lender) - lender_rwa_before, units);
    assert_eq!(rwa_balance(&h, &h.cash_borrower), borrower_rwa_before);
    assert_eq!(rwa_balance(&h, &h.repo), 0);

    let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
    assert_eq!(trade.status, RepoStatus::Defaulted);
}

#[test]
fn default_at_maturity_surplus() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 60 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

    let borrower_rwa_before = rwa_balance(&h, &h.cash_borrower);
    let lender_rwa_before = rwa_balance(&h, &h.cash_lender);

    let grace = RepoDvpClient::new(&h.env, &h.repo).maturity_grace_seconds();
    h.env.ledger().set_timestamp(maturity + grace);

    RepoDvpClient::new(&h.env, &h.repo).default_at_maturity(&h.cash_lender, &id);

    assert_eq!(rwa_balance(&h, &h.cash_lender) - lender_rwa_before, 60 * PRICE_SCALE);
    assert_eq!(rwa_balance(&h, &h.cash_borrower) - borrower_rwa_before, 40 * PRICE_SCALE);
    assert_eq!(rwa_balance(&h, &h.repo), 0);
    assert_eq!(
        RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
        RepoStatus::Defaulted
    );
}

#[test]
fn default_at_maturity_shortfall() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

    let borrower_rwa_before = rwa_balance(&h, &h.cash_borrower);
    let lender_rwa_before = rwa_balance(&h, &h.cash_lender);

    set_price(&h, 50 * PRICE_SCALE / 100);

    let grace = RepoDvpClient::new(&h.env, &h.repo).maturity_grace_seconds();
    h.env.ledger().set_timestamp(maturity + grace);

    RepoDvpClient::new(&h.env, &h.repo).default_at_maturity(&h.cash_lender, &id);

    assert_eq!(rwa_balance(&h, &h.cash_lender) - lender_rwa_before, units);
    assert_eq!(rwa_balance(&h, &h.cash_borrower), borrower_rwa_before);
    assert_eq!(rwa_balance(&h, &h.repo), 0);
    assert_eq!(
        RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
        RepoStatus::Defaulted
    );
}

#[test]
fn default_at_maturity_timing_checks() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.accept_and_settle(&h.cash_borrower, &id);

    let grace = repo.maturity_grace_seconds();

    h.env.ledger().set_timestamp(maturity - 10);
    let before_mat = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_lender, &id);
    }));
    assert!(before_mat.is_err(), "cannot default before maturity");

    h.env.ledger().set_timestamp(maturity + grace - 1);
    let during_grace = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_lender, &id);
    }));
    assert!(during_grace.is_err(), "cannot default during maturity grace");

    h.env.ledger().set_timestamp(maturity + grace);
    repo.default_at_maturity(&h.cash_lender, &id);
    assert_eq!(repo.trade(&id).status, RepoStatus::Defaulted);
}

#[test]
fn default_at_maturity_auth_and_status_checks() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    let repo = RepoDvpClient::new(&h.env, &h.repo);

    let not_settled = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_lender, &id);
    }));
    assert!(not_settled.is_err(), "cannot default on proposed trade");

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    repo.accept_and_settle(&h.cash_borrower, &id);

    let grace = repo.maturity_grace_seconds();
    h.env.ledger().set_timestamp(maturity + grace);

    let stranger = Address::generate(&h.env);
    let stranger_call = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&stranger, &id);
    }));
    assert!(stranger_call.is_err(), "stranger cannot call default_at_maturity");

    let borrower_call = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_borrower, &id);
    }));
    assert!(borrower_call.is_err(), "borrower cannot call default_at_maturity");

    repo.default_at_maturity(&h.keeper, &id);
    assert_eq!(repo.trade(&id).status, RepoStatus::Defaulted);

    let repeated = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_lender, &id);
    }));
    assert!(repeated.is_err(), "cannot default already defaulted trade");
}

#[test]
fn default_at_maturity_cannot_be_called_after_unwind() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.accept_and_settle(&h.cash_borrower, &id);

    h.env.ledger().set_timestamp(maturity);
    repo.unwind(&h.cash_lender, &id);
    assert_eq!(repo.trade(&id).status, RepoStatus::Unwound);

    let grace = repo.maturity_grace_seconds();
    h.env.ledger().set_timestamp(maturity + grace);

    let after_unwind = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_lender, &id);
    }));
    assert!(after_unwind.is_err(), "cannot default an unwound trade");
}

#[test]
fn default_at_maturity_refuses_when_price_not_usable() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 0, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.accept_and_settle(&h.cash_borrower, &id);

    let grace = repo.maturity_grace_seconds();
    h.env.ledger().set_timestamp(maturity + grace);

    MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
        &h.rwa,
        &PRICE_SCALE,
        &PriceStatus::Degraded,
        &h.env.ledger().timestamp(),
    );

    let degraded = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.default_at_maturity(&h.cash_lender, &id);
    }));
    assert!(degraded.is_err(), "cannot default on degraded price");
}

#[test]
fn maturity_grace_configuration() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    assert_eq!(repo.maturity_grace_seconds(), 24 * 60 * 60);

    let too_short = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.set_maturity_grace(&h.admin, &30);
    }));
    assert!(too_short.is_err(), "a 30s maturity grace must be refused");

    let stranger = Address::generate(&h.env);
    let not_admin = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.set_maturity_grace(&stranger, &3_600);
    }));
    assert!(not_admin.is_err(), "only the admin may set maturity grace");

    repo.set_maturity_grace(&h.admin, &120);
    assert_eq!(repo.maturity_grace_seconds(), 120);
}

mod sac {
    use super::*;

    fn setup_sac() -> Harness {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        env.ledger().set_sequence_number(100);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);

        let repo = env.register(RepoDvp, ());
        RepoDvpClient::new(&env, &repo).initialize(
            &admin,
            &pauser,
            &keeper,
            &price_publisher,
            &risk,
        );

        let price_guard = env.register(MockPriceGuard, ());

        let rwa_admin = Address::generate(&env);
        let usdc_admin = Address::generate(&env);
        let rwa = env.register_stellar_asset_contract_v2(rwa_admin).address();
        let usdc = env.register_stellar_asset_contract_v2(usdc_admin).address();

        RepoDvpClient::new(&env, &repo).set_usdc(&admin, &usdc);
        RepoDvpClient::new(&env, &repo).configure_asset(
            &admin,
            &rwa,
            &price_guard,
            &500u32, // 5% haircut
            &MarginThresholds {
                warning_bps: 7_000,
                margin_call_bps: 8_000,
                liquidation_bps: 9_500,
            },
        );
        MockPriceGuardClient::new(&env, &price_guard).set_price(
            &rwa,
            &PRICE_SCALE,
            &PriceStatus::Ok,
            &env.ledger().timestamp(),
        );

        let cash_lender = Address::generate(&env);
        let cash_borrower = Address::generate(&env);

        Harness {
            env,
            repo,
            admin,
            keeper,
            price_guard,
            rwa,
            usdc,
            cash_lender,
            cash_borrower,
        }
    }

    #[test]
    fn sac_propose_settle_unwind_end_to_end() {
        let h = setup_sac();
        let units = 100 * PRICE_SCALE;
        let cash_amount = 90 * PRICE_SCALE;
        let rate_bps = 500u32;
        let term_seconds = 3_600u64;
        let maturity = h.env.ledger().timestamp() + term_seconds;
        let id = propose(&h, units, cash_amount, rate_bps, maturity);

        token::StellarAssetClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
        token::StellarAssetClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

        let token_rwa = token::Client::new(&h.env, &h.rwa);
        let token_usdc = token::Client::new(&h.env, &h.usdc);

        assert_eq!(token_rwa.balance(&h.repo), units);
        assert_eq!(token_usdc.balance(&h.cash_borrower), cash_amount);

        let interest = accrue_interest(cash_amount, rate_bps, term_seconds);
        token::StellarAssetClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &interest);

        h.env.ledger().set_timestamp(maturity);
        RepoDvpClient::new(&h.env, &h.repo).unwind(&h.cash_lender, &id);

        assert_eq!(token_usdc.balance(&h.cash_lender), cash_amount + interest);
        assert_eq!(token_rwa.balance(&h.cash_borrower), units);
        assert_eq!(token_rwa.balance(&h.repo), 0);
        assert_eq!(
            RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
            RepoStatus::Unwound
        );
    }

    #[test]
    fn expired_allowance_unwind_by_keeper_fails_while_borrower_succeeds() {
        let h = setup_sac();
        let units = 100 * PRICE_SCALE;
        let cash_amount = 90 * PRICE_SCALE;
        let rate_bps = 500u32;
        let term_seconds = 3_600u64;
        let maturity = h.env.ledger().timestamp() + term_seconds;
        let id = propose(&h, units, cash_amount, rate_bps, maturity);

        token::StellarAssetClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
        token::StellarAssetClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

        let interest = accrue_interest(cash_amount, rate_bps, term_seconds);
        token::StellarAssetClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &interest);

        let token_usdc = token::Client::new(&h.env, &h.usdc);
        let token_rwa = token::Client::new(&h.env, &h.rwa);

        // Advance timestamp to maturity so unwind is allowed by time.
        h.env.ledger().set_timestamp(maturity);

        // Advance ledger sequence past the leg-2 allowance expiry bucket.
        // At settlement, seq was 100. Allowance was bucketed to 155_520.
        // Advancing past 155_520 expires the SAC allowance.
        let expiry = allowance_expiry(&h.env, term_seconds, UNWIND_ALLOWANCE_GRACE_LEDGERS);
        h.env.ledger().set_sequence_number(expiry + 1);

        // Allowance read back from SAC is now 0 because it has expired.
        assert_eq!(token_usdc.allowance(&h.cash_borrower, &h.repo), 0);

        // Keeper unwind uses transfer_from which must fail because the allowance has expired.
        let keeper = h.keeper.clone();
        let repo = h.repo.clone();
        let env = h.env.clone();
        let keeper_result = panic::catch_unwind(AssertUnwindSafe(|| {
            RepoDvpClient::new(&env, &repo).unwind(&keeper, &id);
        }));
        assert!(
            keeper_result.is_err(),
            "keeper unwind must fail when allowance is expired"
        );

        // Borrower-signed unwind uses direct transfer, which succeeds even after allowance expiry.
        RepoDvpClient::new(&h.env, &h.repo).unwind(&h.cash_borrower, &id);

        assert_eq!(token_usdc.balance(&h.cash_lender), cash_amount + interest);
        assert_eq!(token_rwa.balance(&h.cash_borrower), units);
        assert_eq!(token_rwa.balance(&h.repo), 0);
        assert_eq!(
            RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
            RepoStatus::Unwound
        );
    }

    #[test]
    fn sac_allowance_expiry_is_not_before_maturity_plus_grace() {
        let h = setup_sac();
        let units = 100 * PRICE_SCALE;
        let cash_amount = 90 * PRICE_SCALE;
        let rate_bps = 500u32;
        let term_seconds = 3_600u64;
        let maturity = h.env.ledger().timestamp() + term_seconds;
        let id = propose(&h, units, cash_amount, rate_bps, maturity);

        token::StellarAssetClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
        token::StellarAssetClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

        let settlement_seq = h.env.ledger().sequence();
        let expected_expiry =
            allowance_expiry(&h.env, term_seconds, UNWIND_ALLOWANCE_GRACE_LEDGERS);
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

        let token_usdc = token::Client::new(&h.env, &h.usdc);

        // Maturity in ledgers from settlement
        let maturity_ledger = settlement_seq + (term_seconds / SECONDS_PER_LEDGER) as u32;
        let min_required_expiry = maturity_ledger + UNWIND_ALLOWANCE_GRACE_LEDGERS;

        assert!(
            expected_expiry >= min_required_expiry,
            "allowance expiry ({expected_expiry}) must be >= maturity + grace ({min_required_expiry})"
        );

        // Verify that at maturity + UNWIND_ALLOWANCE_GRACE_LEDGERS, the allowance read back from SAC is still valid.
        h.env.ledger().set_sequence_number(min_required_expiry);
        assert!(
            token_usdc.allowance(&h.cash_borrower, &h.repo) > 0,
            "allowance read back from SAC must not expire before maturity plus grace"
        );

        // Advance to the exact computed bucketed expiry and verify allowance is still accessible.
        h.env.ledger().set_sequence_number(expected_expiry);
        assert!(
            token_usdc.allowance(&h.cash_borrower, &h.repo) > 0,
            "allowance must still be active at expected expiry"
        );

        // One ledger past expiry, SAC treats it as 0.
        h.env.ledger().set_sequence_number(expected_expiry + 1);
        assert_eq!(token_usdc.allowance(&h.cash_borrower, &h.repo), 0);
    }
}
