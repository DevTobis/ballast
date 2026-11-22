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
    pauser: Address,
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
        pauser,
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
    // A trade's kind has to fit its term (#216): intraday up to a day out, a term repo beyond.
    let term_seconds = maturity_at.saturating_sub(h.env.ledger().timestamp());
    let kind = if term_seconds <= MAX_INTRADAY_TERM_SECONDS {
        RepoKind::Intraday
    } else {
        RepoKind::Term
    };
    RepoDvpClient::new(&h.env, &h.repo).propose(
        &h.cash_lender,
        &h.cash_borrower,
        &h.rwa,
        &units,
        &cash_amount,
        &rate_bps,
        &kind,
        &maturity_at,
        &hash(h, 7),
    )
}

// --- #216: a repo's term has to fit its kind, and its rate has a ceiling -------------------

/// Proposes 100 units against 90 cash with the given kind and rate, maturing `term_seconds`
/// from now.
fn propose_kind(h: &Harness, kind: &RepoKind, rate_bps: u32, term_seconds: u64) -> u64 {
    RepoDvpClient::new(&h.env, &h.repo).propose(
        &h.cash_lender,
        &h.cash_borrower,
        &h.rwa,
        &(100 * PRICE_SCALE),
        &(90 * PRICE_SCALE),
        &rate_bps,
        kind,
        &(h.env.ledger().timestamp() + term_seconds),
        &hash(h, 7),
    )
}

/// The same proposal through `try_propose`: whether it was refused.
fn is_refused(h: &Harness, kind: &RepoKind, rate_bps: u32, term_seconds: u64) -> bool {
    RepoDvpClient::new(&h.env, &h.repo)
        .try_propose(
            &h.cash_lender,
            &h.cash_borrower,
            &h.rwa,
            &(100 * PRICE_SCALE),
            &(90 * PRICE_SCALE),
            &rate_bps,
            kind,
            &(h.env.ledger().timestamp() + term_seconds),
            &hash(h, 7),
        )
        .is_err()
}

#[test]
fn the_bounds_are_the_ones_the_prd_names() {
    assert_eq!(MAX_INTRADAY_TERM_SECONDS, 24 * 3_600);
    assert_eq!(MAX_OVERNIGHT_TERM_SECONDS, 48 * 3_600);
    assert_eq!(MAX_TERM_REPO_SECONDS, 30 * 24 * 3_600);
    assert_eq!(MAX_OPEN_TERM_SECONDS, MAX_TERM_REPO_SECONDS);
    assert_eq!(MAX_RATE_BPS, 10_000);
}

#[test]
fn every_kind_accepts_a_term_of_exactly_its_bound() {
    let h = setup();
    for (kind, bound) in [
        (RepoKind::Intraday, MAX_INTRADAY_TERM_SECONDS),
        (RepoKind::Overnight, MAX_OVERNIGHT_TERM_SECONDS),
        (RepoKind::Open, MAX_OPEN_TERM_SECONDS),
        (RepoKind::Term, MAX_TERM_REPO_SECONDS),
    ] {
        let id = propose_kind(&h, &kind, 500, bound);
        let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
        assert_eq!(trade.kind, kind);
        assert_eq!(trade.maturity_at, h.env.ledger().timestamp() + bound);
    }
}

#[test]
#[should_panic(expected = "repo-dvp: an intraday repo must mature within 24 hours")]
fn an_intraday_repo_one_second_over_a_day_is_refused() {
    let h = setup();
    propose_kind(&h, &RepoKind::Intraday, 500, MAX_INTRADAY_TERM_SECONDS + 1);
}

/// The input from the report: `Intraday`, maturing 400 days out.
#[test]
#[should_panic(expected = "repo-dvp: an intraday repo must mature within 24 hours")]
fn an_intraday_repo_400_days_out_is_refused() {
    let h = setup();
    propose_kind(&h, &RepoKind::Intraday, 500, 400 * 24 * 3_600);
}

#[test]
#[should_panic(expected = "repo-dvp: an overnight repo must mature within 48 hours")]
fn an_overnight_repo_one_second_over_two_days_is_refused() {
    let h = setup();
    propose_kind(
        &h,
        &RepoKind::Overnight,
        500,
        MAX_OVERNIGHT_TERM_SECONDS + 1,
    );
}

#[test]
#[should_panic(expected = "repo-dvp: an open repo must mature within 30 days")]
fn an_open_repo_one_second_over_thirty_days_is_refused() {
    let h = setup();
    propose_kind(&h, &RepoKind::Open, 500, MAX_OPEN_TERM_SECONDS + 1);
}

#[test]
#[should_panic(expected = "repo-dvp: a term repo must mature within 30 days")]
fn a_term_repo_one_second_over_thirty_days_is_refused() {
    let h = setup();
    propose_kind(&h, &RepoKind::Term, 500, MAX_TERM_REPO_SECONDS + 1);
}

/// Each kind is held to its own bound, not to a shared one: 36 hours is too long for intraday
/// only, and 3 days is too long for intraday and overnight.
#[test]
fn a_term_one_kind_refuses_is_accepted_under_a_longer_kind() {
    let h = setup();
    let thirty_six_hours = 36 * 3_600;
    let three_days = 3 * 24 * 3_600;

    assert!(is_refused(&h, &RepoKind::Intraday, 500, thirty_six_hours));
    assert!(!is_refused(&h, &RepoKind::Overnight, 500, thirty_six_hours));
    assert!(!is_refused(&h, &RepoKind::Open, 500, thirty_six_hours));
    assert!(!is_refused(&h, &RepoKind::Term, 500, thirty_six_hours));

    assert!(is_refused(&h, &RepoKind::Intraday, 500, three_days));
    assert!(is_refused(&h, &RepoKind::Overnight, 500, three_days));
    assert!(!is_refused(&h, &RepoKind::Open, 500, three_days));
    assert!(!is_refused(&h, &RepoKind::Term, 500, three_days));
}

#[test]
fn a_rate_of_zero_and_of_exactly_the_maximum_are_accepted() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);

    let free = propose_kind(&h, &RepoKind::Intraday, 0, 3_600);
    assert_eq!(repo.trade(&free).rate_bps, 0);

    let dearest = propose_kind(&h, &RepoKind::Intraday, MAX_RATE_BPS, 3_600);
    assert_eq!(repo.trade(&dearest).rate_bps, MAX_RATE_BPS);
}

#[test]
#[should_panic(expected = "repo-dvp: rate_bps exceeds the maximum rate")]
fn a_rate_one_bp_over_the_maximum_is_refused() {
    let h = setup();
    propose_kind(&h, &RepoKind::Intraday, MAX_RATE_BPS + 1, 3_600);
}

/// The rate from the report: 4,000,000,000 bps, forty million percent.
#[test]
#[should_panic(expected = "repo-dvp: rate_bps exceeds the maximum rate")]
fn a_rate_of_four_billion_bps_is_refused() {
    let h = setup();
    propose_kind(&h, &RepoKind::Intraday, 4_000_000_000, 3_600);
}

/// A proposal refused for its term or its rate leaves the lender's allowance at zero, and a
/// proposal that fits then goes through as usual.
#[test]
fn a_proposal_refused_for_its_term_or_rate_grants_no_leg1_allowance() {
    let h = setup();
    let usdc = MockTokenClient::new(&h.env, &h.usdc);

    assert!(is_refused(&h, &RepoKind::Intraday, 500, 400 * 24 * 3_600));
    assert!(is_refused(&h, &RepoKind::Intraday, MAX_RATE_BPS + 1, 3_600));
    assert_eq!(usdc.allowance(&h.cash_lender, &h.repo), 0);

    propose_kind(&h, &RepoKind::Intraday, 500, 3_600);
    assert!(usdc.allowance(&h.cash_lender, &h.repo) >= 90 * PRICE_SCALE);
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

#[test]
fn lender_can_cancel_proposal_and_zeroes_allowance() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    let usdc = MockTokenClient::new(&h.env, &h.usdc);
    assert_eq!(usdc.allowance(&h.cash_lender, &h.repo), cash_amount);

    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.cancel_proposal(&h.cash_lender, &id);

    let trade = repo.trade(&id);
    assert_eq!(trade.status, RepoStatus::Cancelled);
    assert_eq!(usdc.allowance(&h.cash_lender, &h.repo), 0);

    // Cancelled proposal cannot be accepted
    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    let accept_res = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.accept_and_settle(&h.cash_borrower, &id);
    }));
    assert!(accept_res.is_err(), "cancelled proposal cannot be accepted");
}

#[test]
fn borrower_can_cancel_proposal() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.cancel_proposal(&h.cash_borrower, &id);

    let trade = repo.trade(&id);
    assert_eq!(trade.status, RepoStatus::Cancelled);

    // Cancelled proposal cannot be accepted
    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    let accept_res = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.accept_and_settle(&h.cash_borrower, &id);
    }));
    assert!(accept_res.is_err(), "cancelled proposal cannot be accepted");
}

#[test]
fn stranger_cannot_cancel_proposal() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    let stranger = Address::generate(&h.env);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.cancel_proposal(&stranger, &id);
    }));
    assert!(result.is_err(), "stranger cannot cancel proposal");
}

#[test]
fn double_cancel_is_rejected() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.cancel_proposal(&h.cash_lender, &id);

    let second_cancel = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.cancel_proposal(&h.cash_lender, &id);
    }));
    assert!(second_cancel.is_err(), "cannot cancel already cancelled proposal");
}

#[test]
fn cancel_after_settle_is_rejected() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.accept_and_settle(&h.cash_borrower, &id);

    let cancel_res = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.cancel_proposal(&h.cash_lender, &id);
    }));
    assert!(cancel_res.is_err(), "cannot cancel settled trade");
}

#[test]
fn cancelling_older_proposal_does_not_zero_latest_allowance() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_1 = 50 * PRICE_SCALE;
    let cash_2 = 100 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;

    let id1 = propose(&h, units, cash_1, 500, maturity);
    let id2 = propose(&h, units, cash_2, 500, maturity);

    let usdc = MockTokenClient::new(&h.env, &h.usdc);
    assert_eq!(usdc.allowance(&h.cash_lender, &h.repo), cash_2);

    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.cancel_proposal(&h.cash_lender, &id1);

    assert_eq!(repo.trade(&id1).status, RepoStatus::Cancelled);
    // Since id1 was not the latest proposal, the allowance for id2 was NOT zeroed
    assert_eq!(usdc.allowance(&h.cash_lender, &h.repo), cash_2);

    // Trade 2 can still be settled
    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_2);
    repo.accept_and_settle(&h.cash_borrower, &id2);
    assert_eq!(repo.trade(&id2).status, RepoStatus::Settled);
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

#[test]

fn configure_asset_accepts_valid_thresholds() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let new_asset = Address::generate(&h.env);

    // Standard thresholds from configure-desks.sh
    repo.configure_asset(
        &h.admin,
        &new_asset,
        &h.price_guard,
        &500u32,
        &MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        },
    );

    // Tightest strictly increasing thresholds, with liquidation at the 100% ceiling
    repo.configure_asset(
        &h.admin,
        &new_asset,
        &h.price_guard,
        &500u32,
        &MarginThresholds {
            warning_bps: 9_998,
            margin_call_bps: 9_999,
            liquidation_bps: 10_000,
        },
    );
}

#[test]
fn configure_asset_rejects_equal_thresholds() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let new_asset = Address::generate(&h.env);

    // warning == margin_call: Warning could never be reported (#78)
    let res1 = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 8_000,
                margin_call_bps: 8_000,
                liquidation_bps: 9_000,
            },
        );
    }));
    assert!(res1.is_err(), "warning == margin_call must be rejected");

    // margin_call == liquidation: MarginCall could never be reported (#78)
    let res2 = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 7_000,
                margin_call_bps: 9_000,
                liquidation_bps: 9_000,
            },
        );
    }));
    assert!(res2.is_err(), "margin_call == liquidation must be rejected");
}

#[test]
fn configure_asset_rejects_zero_thresholds() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let new_asset = Address::generate(&h.env);

    let res = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 0,
                margin_call_bps: 0,
                liquidation_bps: 0,
            },
        );
    }));
    assert!(res.is_err(), "zero thresholds must be rejected");

    // A zero margin_call_bps alone: call_margin divides by it, so it must never be stored (#78)
    let res2 = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 7_000,
                margin_call_bps: 0,
                liquidation_bps: 9_000,
            },
        );
    }));
    assert!(res2.is_err(), "zero margin_call_bps must be rejected");
}

#[test]
fn configure_asset_rejects_out_of_order_thresholds() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let new_asset = Address::generate(&h.env);

    // warning > margin_call
    let res1 = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 9_000,
                margin_call_bps: 8_000,
                liquidation_bps: 9_500,
            },
        );
    }));
    assert!(res1.is_err(), "warning > margin_call must be rejected");

    // margin_call > liquidation
    let res2 = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 7_000,
                margin_call_bps: 9_500,
                liquidation_bps: 9_000,
            },
        );
    }));
    assert!(res2.is_err(), "margin_call > liquidation must be rejected");
}

#[test]
fn configure_asset_rejects_liquidation_exceeding_10000() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    let new_asset = Address::generate(&h.env);

    let res = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.configure_asset(
            &h.admin,
            &new_asset,
            &h.price_guard,
            &500u32,
            &MarginThresholds {
                warning_bps: 7_000,
                margin_call_bps: 8_000,
                liquidation_bps: 10_001,
            },
        );
    }));
    assert!(res.is_err(), "liquidation > 10000 must be rejected");
    }

fn disabled_asset_blocks_propose_and_accept_and_settle() {
    let h = setup();
    let repo = RepoDvpClient::new(&h.env, &h.repo);

    assert!(repo.is_asset_enabled(&h.rwa));

    // Stranger cannot disable asset
    let stranger = Address::generate(&h.env);
    let unauthorized = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.disable_asset(&stranger, &h.rwa);
    }));
    assert!(unauthorized.is_err(), "only admin can disable asset");

    // Admin disables asset
    repo.disable_asset(&h.admin, &h.rwa);
    assert!(!repo.is_asset_enabled(&h.rwa));

    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;

    // Proposing on disabled asset panics
    let propose_res = panic::catch_unwind(AssertUnwindSafe(|| {
        propose(&h, units, cash_amount, 500, maturity);
    }));
    assert!(propose_res.is_err(), "propose on disabled asset must fail");

    // Re-enable asset allows proposing
    repo.enable_asset(&h.admin, &h.rwa);
    assert!(repo.is_asset_enabled(&h.rwa));
    let id = propose(&h, units, cash_amount, 500, maturity);

    // Disable asset after proposing: accept_and_settle must fail
    repo.disable_asset(&h.admin, &h.rwa);
    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);

    let settle_res = panic::catch_unwind(AssertUnwindSafe(|| {
        repo.accept_and_settle(&h.cash_borrower, &id);
    }));
    assert!(settle_res.is_err(), "accept_and_settle on disabled asset must fail");
}

#[test]
fn existing_trades_can_be_unwound_topped_up_and_defaulted_when_asset_is_disabled() {
    // 1. Unwind works on disabled asset
    let h = setup();
    let units = 100 * PRICE_SCALE;
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    let repo = RepoDvpClient::new(&h.env, &h.repo);
    repo.accept_and_settle(&h.cash_borrower, &id);

    // Admin disables asset after trade is settled
    repo.disable_asset(&h.admin, &h.rwa);
    assert!(!repo.is_asset_enabled(&h.rwa));

    // Fast-forward to maturity and unwind
    h.env.ledger().set_timestamp(maturity);
    let interest = accrue_interest(cash_amount, 500, 3_600);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &(cash_amount + interest));

    repo.unwind(&h.cash_borrower, &id);
    assert_eq!(repo.trade(&id).status, RepoStatus::Unwound);

    // 2. Margin call and top_up work on disabled asset
    let h2 = setup();
    let id2 = settled_under_margin(&h2);
    let repo2 = RepoDvpClient::new(&h2.env, &h2.repo);
    repo2.disable_asset(&h2.admin, &h2.rwa);

    repo2.call_margin(&h2.keeper, &id2);
    assert!(repo2.trade(&id2).pending_margin_call);

    repo2.top_up(&h2.cash_borrower, &id2, &(100 * PRICE_SCALE));
    assert!(!repo2.trade(&id2).pending_margin_call);
    assert_eq!(repo2.trade(&id2).units, 200 * PRICE_SCALE);

    // 3. Default close works on disabled asset
    let h3 = setup();
    let id3 = settled_under_margin(&h3);
    let repo3 = RepoDvpClient::new(&h3.env, &h3.repo);
    repo3.disable_asset(&h3.admin, &h3.rwa);

    repo3.call_margin(&h3.keeper, &id3);
    let deadline = repo3.trade(&id3).cure_deadline.unwrap();
    h3.env.ledger().set_timestamp(deadline);

    repo3.default_close(&h3.keeper, &id3);
    assert_eq!(repo3.trade(&id3).status, RepoStatus::Defaulted);
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
            pauser,
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

    // ── #29: the borrower's leg-2 allowance must survive a second settle ────

    fn settle_new_trade(h: &Harness, cash_amount: i128, maturity: u64) -> u64 {
        let units = 100 * PRICE_SCALE;
        let id = propose(h, units, cash_amount, 500, maturity);
        MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
        MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
        id
    }

    /// The reproduction from the issue: before the additive allowance, trade 2's
    /// settle replaced the borrower's allowance with its own smaller due, and the
    /// keeper's `unwind(1)` failed on `transfer_from`.
    #[test]
    fn two_settled_trades_by_one_borrower_both_unwind_by_the_keeper() {
        let h = setup();
        let maturity = h.env.ledger().timestamp() + 3_600;
        let first = settle_new_trade(&h, 90 * PRICE_SCALE, maturity);
        let second = settle_new_trade(&h, 50 * PRICE_SCALE, maturity);

        let repo = RepoDvpClient::new(&h.env, &h.repo);
        let due_first = total_due(&repo.trade(&first), repo.trade(&first).settled_at.unwrap());
        let due_second = total_due(&repo.trade(&second), repo.trade(&second).settled_at.unwrap());
        // Both settles happened in the same ledger as their proposals, so the
        // approved ceilings equal the actual dues and the sum is exact.
        assert_eq!(
            MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_borrower, &h.repo),
            due_first + due_second
        );

        // Fund the interest the borrower owes on top of the returned principal.
        MockTokenClient::new(&h.env, &h.usdc).mint(
            &h.cash_borrower,
            &(due_first + due_second - 90 * PRICE_SCALE - 50 * PRICE_SCALE),
        );
        h.env.ledger().set_timestamp(maturity);

        // The keeper, not the borrower, unwinds both — each spends its own share
        // of the summed allowance.
        repo.unwind(&h.keeper, &first);
        repo.unwind(&h.keeper, &second);
        assert_eq!(repo.trade(&first).status, RepoStatus::Unwound);
        assert_eq!(repo.trade(&second).status, RepoStatus::Unwound);

        // Residual allowance after the last close is zero.
        assert_eq!(
            MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_borrower, &h.repo),
            0
        );
    }

    #[test]
    fn later_unwind_order_also_works_when_the_later_trade_has_the_smaller_due() {
        let h = setup();
        let maturity = h.env.ledger().timestamp() + 3_600;
        // Reverse sizes relative to the test above, and unwind in reverse order.
        let big = settle_new_trade(&h, 50 * PRICE_SCALE, maturity);
        let small = settle_new_trade(&h, 90 * PRICE_SCALE, maturity);

        let repo = RepoDvpClient::new(&h.env, &h.repo);
        let due_total = total_due(&repo.trade(&big), repo.trade(&big).settled_at.unwrap())
            + total_due(&repo.trade(&small), repo.trade(&small).settled_at.unwrap());
        MockTokenClient::new(&h.env, &h.usdc)
            .mint(&h.cash_borrower, &(due_total - 140 * PRICE_SCALE));
        h.env.ledger().set_timestamp(maturity);

        repo.unwind(&h.keeper, &small);
        repo.unwind(&h.keeper, &big);
        assert_eq!(
            MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_borrower, &h.repo),
            0
        );
    }

    #[test]
    fn a_default_releases_its_share_so_the_next_settle_approves_the_accurate_sum() {
        let h = setup();
        let maturity = h.env.ledger().timestamp() + 7 * 86_400;
        let defaulted = settle_new_trade(&h, 90 * PRICE_SCALE, maturity);

        // Crash the price, open the call, let the cure window lapse, default.
        let repo = RepoDvpClient::new(&h.env, &h.repo);
        MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
            &h.rwa,
            &(PRICE_SCALE / 2),
            &PriceStatus::Ok,
            &h.env.ledger().timestamp(),
        );
        repo.call_margin(&h.keeper, &defaulted);
        let deadline = repo.trade(&defaulted).cure_deadline.unwrap();
        h.env.ledger().set_timestamp(deadline + 1);
        MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
            &h.rwa,
            &(PRICE_SCALE / 2),
            &PriceStatus::Ok,
            &h.env.ledger().timestamp(),
        );
        repo.default_close(&h.keeper, &defaulted);
        assert_eq!(repo.trade(&defaulted).status, RepoStatus::Defaulted);

        // The defaulted trade's share left the tracked sum, so the next settle
        // approves exactly its own due — not the stale sum.
        MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
            &h.rwa,
            &PRICE_SCALE,
            &PriceStatus::Ok,
            &h.env.ledger().timestamp(),
        );
        let next_maturity = h.env.ledger().timestamp() + 3_600;
        let next = settle_new_trade(&h, 40 * PRICE_SCALE, next_maturity);
        let next_trade = repo.trade(&next);
        assert_eq!(
            MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_borrower, &h.repo),
            total_due(&next_trade, next_trade.settled_at.unwrap())
        );
    }

    // ── #32: the Repos pause scope has a writer and a timelocked unpause ────

    fn settled_trade(h: &Harness) -> u64 {
        let units = 100 * PRICE_SCALE;
        let cash_amount = 90 * PRICE_SCALE;
        let maturity = h.env.ledger().timestamp() + 3_600;
        let id = propose(h, units, cash_amount, 500, maturity);
        MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
        MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
        id
    }

    #[test]
    #[should_panic(expected = "ballast-common: paused")]
    fn pausing_repos_stops_accept_and_settle() {
        let h = setup();
        let maturity = h.env.ledger().timestamp() + 3_600;
        let id = propose(&h, 100, 1_000, 500, maturity);
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::Repos);
        assert!(RepoDvpClient::new(&h.env, &h.repo).is_paused(&PauseScope::Repos));
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
    }

    #[test]
    #[should_panic(expected = "ballast-common: paused")]
    fn pausing_all_stops_accept_and_settle_too() {
        let h = setup();
        let maturity = h.env.ledger().timestamp() + 3_600;
        let id = propose(&h, 100, 1_000, 500, maturity);
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::All);
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
    }

    #[test]
    fn unwind_still_works_while_paused() {
        let h = setup();
        let id = settled_trade(&h);
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::All);

        let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
        let due = total_due(&trade, trade.settled_at.unwrap());
        MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &(due - trade.cash_amount));
        h.env.ledger().set_timestamp(trade.maturity_at);
        RepoDvpClient::new(&h.env, &h.repo).unwind(&h.cash_lender, &id);
        assert_eq!(
            RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
            RepoStatus::Unwound
        );
    }

    #[test]
    fn margin_cure_and_default_paths_still_work_while_paused() {
        let h = setup();
        let id = settled_trade(&h);
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::All);

        // Drop the price so the trade is in margin-call territory, then walk the
        // whole enforcement path under a full pause: call, top up, and - after
        // letting a second call's cure window lapse - default-close.
        MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
            &h.rwa,
            &(PRICE_SCALE / 2),
            &PriceStatus::Ok,
            &h.env.ledger().timestamp(),
        );
        RepoDvpClient::new(&h.env, &h.repo).call_margin(&h.keeper, &id);
        let called = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
        assert!(called.pending_margin_call);

        let extra_units = 500 * PRICE_SCALE;
        MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &extra_units);
        RepoDvpClient::new(&h.env, &h.repo).top_up(&h.cash_borrower, &id, &extra_units);
        assert!(!RepoDvpClient::new(&h.env, &h.repo).trade(&id).pending_margin_call);
    }

    #[test]
    fn default_close_still_works_while_paused() {
        let h = setup();
        let id = settled_trade(&h);
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::All);

        MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
            &h.rwa,
            &(PRICE_SCALE / 2),
            &PriceStatus::Ok,
            &h.env.ledger().timestamp(),
        );
        RepoDvpClient::new(&h.env, &h.repo).call_margin(&h.keeper, &id);
        let called = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
        let deadline = called.cure_deadline.expect("margin call opens a cure window");

        h.env.ledger().set_timestamp(deadline + 1);
        MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
            &h.rwa,
            &(PRICE_SCALE / 2),
            &PriceStatus::Ok,
            &h.env.ledger().timestamp(),
        );
        RepoDvpClient::new(&h.env, &h.repo).default_close(&h.keeper, &id);
        assert_eq!(
            RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
            RepoStatus::Defaulted
        );
    }

    #[test]
    #[should_panic(expected = "repo-dvp: timelock has not elapsed")]
    fn unpause_cannot_execute_before_the_timelock() {
        let h = setup();
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::Repos);
        let id = RepoDvpClient::new(&h.env, &h.repo).queue_unpause(&h.admin, &PauseScope::Repos);
        RepoDvpClient::new(&h.env, &h.repo).execute_unpause(&id);
    }

    #[test]
    fn executed_unpause_reopens_accept_and_settle_after_48h() {
        let h = setup();
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::Repos);
        let unpause = RepoDvpClient::new(&h.env, &h.repo).queue_unpause(&h.admin, &PauseScope::Repos);

        h.env
            .ledger()
            .set_timestamp(h.env.ledger().timestamp() + timelock::TIMELOCK_DELAY_SECONDS);
        RepoDvpClient::new(&h.env, &h.repo).execute_unpause(&unpause);
        assert!(!RepoDvpClient::new(&h.env, &h.repo).is_paused(&PauseScope::Repos));

        let id = settled_trade(&h);
        assert_eq!(
            RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
            RepoStatus::Settled
        );
    }

    #[test]
    #[should_panic(expected = "repo-dvp: no such pending unpause")]
    fn a_cancelled_unpause_cannot_execute() {
        let h = setup();
        RepoDvpClient::new(&h.env, &h.repo).pause(&h.pauser, &PauseScope::Repos);
        let id = RepoDvpClient::new(&h.env, &h.repo).queue_unpause(&h.admin, &PauseScope::Repos);
        RepoDvpClient::new(&h.env, &h.repo).cancel_unpause(&h.admin, &id);
        RepoDvpClient::new(&h.env, &h.repo).execute_unpause(&id);
    }

    // ── #31: no trade for an asset without margin parameters ────────────────

    #[test]
    #[should_panic(expected = "repo-dvp: asset not configured")]
    fn propose_panics_for_an_unconfigured_asset() {
        let h = setup();
        let unconfigured = h.env.register(MockToken, ());
        RepoDvpClient::new(&h.env, &h.repo).propose(
            &h.cash_lender,
            &h.cash_borrower,
            &unconfigured,
            &100,
            &1_000,
            &500u32,
            &RepoKind::Intraday,
            &(h.env.ledger().timestamp() + 3_600),
            &hash(&h, 9),
        );
    }

    #[test]
    fn a_failed_propose_grants_no_leg1_allowance() {
        let h = setup();
        let unconfigured = h.env.register(MockToken, ());
        let maturity = h.env.ledger().timestamp() + 3_600;
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            RepoDvpClient::new(&h.env, &h.repo).propose(
                &h.cash_lender,
                &h.cash_borrower,
                &unconfigured,
                &100,
                &1_000,
                &500u32,
                &RepoKind::Intraday,
                &maturity,
                &hash(&h, 9),
            );
        }));
        assert!(result.is_err(), "propose must refuse the unconfigured asset");
        // The config check runs before the leg-1 approve, so the lender's USDC
        // allowance to the contract must still be zero.
        assert_eq!(
            MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_lender, &h.repo),
            0
        );
    }

    #[test]
    fn propose_still_works_for_a_configured_asset() {
        let h = setup();
        let id = propose(&h, 100, 1_000, 500, h.env.ledger().timestamp() + 3_600);
        assert!(MockTokenClient::new(&h.env, &h.usdc).allowance(&h.cash_lender, &h.repo) >= 1_000);
        assert_eq!(RepoDvpClient::new(&h.env, &h.repo).trade(&id).status, RepoStatus::Proposed);
    }
}

// --- #219: storage lifetime ------------------------------------------------------------------

mod storage_lifetime {
    use super::*;
    use ballast_common::ttl::{INSTANCE_EXTEND_TO_LEDGERS, PERSISTENT_EXTEND_TO_LEDGERS};
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};

    const DAY_LEDGERS: u32 = 17_280;
    const THIRTY_DAYS: u64 = 30 * 24 * 3_600;
    const THIRTY_DAYS_LEDGERS: u32 = 30 * DAY_LEDGERS;
    const UNITS: i128 = 100 * PRICE_SCALE;
    const CASH: i128 = 50 * PRICE_SCALE;

    /// Ledgers a persistent entry of the repo contract has left.
    fn entry_ttl(h: &Harness, key: &DataKey) -> u32 {
        h.env
            .as_contract(&h.repo, || h.env.storage().persistent().get_ttl(key))
    }

    fn trade_ttl(h: &Harness, id: u64) -> u32 {
        entry_ttl(h, &DataKey::Trade(id))
    }

    fn instance_ttl(h: &Harness) -> u32 {
        h.env
            .as_contract(&h.repo, || h.env.storage().instance().get_ttl())
    }

    /// Moves the ledger on by `ledgers`, and the clock by the same stretch of time.
    fn age(h: &Harness, ledgers: u32) {
        h.env.ledger().with_mut(|li| {
            li.sequence_number += ledgers;
            li.timestamp += ledgers as u64 * SECONDS_PER_LEDGER;
        });
    }

    /// Proposes a trade maturing `term_seconds` from now, without settling it.
    fn proposed(h: &Harness, term_seconds: u64) -> u64 {
        propose(
            h,
            UNITS,
            CASH,
            500,
            h.env.ledger().timestamp() + term_seconds,
        )
    }

    /// Funds both parties and settles `id`. The borrower is left with enough USDC to unwind.
    fn settle(h: &Harness, id: u64) {
        MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &UNITS);
        MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &CASH);
        MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_borrower, &CASH);
        RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);
    }

    #[test]
    fn propose_gives_a_trade_a_lifetime_past_its_maturity_and_the_unwind_grace() {
        let h = setup();
        let id = proposed(&h, THIRTY_DAYS);

        let needed = THIRTY_DAYS_LEDGERS + UNWIND_ALLOWANCE_GRACE_LEDGERS;
        assert!(trade_ttl(&h, id) >= needed, "trade: {}", trade_ttl(&h, id));
        assert!(instance_ttl(&h) >= needed, "instance: {}", instance_ttl(&h));
    }

    #[test]
    fn accept_and_settle_keeps_the_trade_and_the_borrowers_due_sum_alive_past_maturity() {
        let h = setup();
        let id = proposed(&h, THIRTY_DAYS);
        age(&h, DAY_LEDGERS);
        settle(&h, id);

        let needed = THIRTY_DAYS_LEDGERS - DAY_LEDGERS + UNWIND_ALLOWANCE_GRACE_LEDGERS;
        assert!(trade_ttl(&h, id) >= needed, "trade: {}", trade_ttl(&h, id));
        assert!(instance_ttl(&h) >= needed, "instance: {}", instance_ttl(&h));
        let due = DataKey::BorrowerDue(h.cash_borrower.clone());
        let expiry = DataKey::BorrowerDueExpiry(h.cash_borrower.clone());
        assert!(
            entry_ttl(&h, &due) >= needed,
            "due: {}",
            entry_ttl(&h, &due)
        );
        assert!(
            entry_ttl(&h, &expiry) >= needed,
            "due expiry: {}",
            entry_ttl(&h, &expiry)
        );
    }

    /// A trade that matures within the hour is still kept for the shared ~30 days, so its
    /// outcome stays readable after it closes.
    #[test]
    fn a_short_trade_is_still_kept_for_the_shared_thirty_days() {
        let h = setup();
        let id = proposed(&h, 3_600);

        assert!(trade_ttl(&h, id) >= PERSISTENT_EXTEND_TO_LEDGERS - 1);
        assert!(instance_ttl(&h) >= INSTANCE_EXTEND_TO_LEDGERS - 1);
    }

    /// The case from the report: a 30-day repo that nothing touches between settlement and
    /// maturity. The ledger moves on by the whole term, far past the lifetime a new entry starts
    /// with, and the trade, the instance and the borrower's due sum are all still live, with the
    /// unwind grace still ahead of them. The keeper then unwinds out of the borrower's allowance.
    #[test]
    fn a_thirty_day_trade_left_alone_is_still_live_at_maturity_and_unwinds() {
        let h = setup();
        let id = proposed(&h, THIRTY_DAYS);
        settle(&h, id);
        let starts_with = h.env.ledger().get().min_persistent_entry_ttl;

        age(&h, THIRTY_DAYS_LEDGERS);
        assert!(THIRTY_DAYS_LEDGERS > starts_with);

        assert!(trade_ttl(&h, id) >= UNWIND_ALLOWANCE_GRACE_LEDGERS);
        assert!(instance_ttl(&h) >= UNWIND_ALLOWANCE_GRACE_LEDGERS);
        let due = DataKey::BorrowerDue(h.cash_borrower.clone());
        assert!(entry_ttl(&h, &due) >= UNWIND_ALLOWANCE_GRACE_LEDGERS);

        RepoDvpClient::new(&h.env, &h.repo).unwind(&h.keeper, &id);
        assert_eq!(
            RepoDvpClient::new(&h.env, &h.repo).trade(&id).status,
            RepoStatus::Unwound
        );
    }

    /// The same proposal on a ledger with testnet's own minimum lifetime for a new entry, 120,960
    /// ledgers (about 7 days), instead of the test default of a few thousand. This is the gap in
    /// the report: seven days is well short of a 30-day trade, and it is also well above the
    /// one-day threshold at which the shared `ttl::extend_persistent` starts to act, so that
    /// helper would leave the new entry exactly as it found it.
    #[test]
    fn a_trade_is_given_its_whole_lifetime_even_when_a_new_entry_already_has_a_week() {
        let h = setup();
        h.env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = UNWIND_ALLOWANCE_GRACE_LEDGERS;
        });
        let id = proposed(&h, THIRTY_DAYS);
        settle(&h, id);

        let needed = THIRTY_DAYS_LEDGERS + UNWIND_ALLOWANCE_GRACE_LEDGERS;
        assert!(trade_ttl(&h, id) >= needed, "trade: {}", trade_ttl(&h, id));
        assert!(instance_ttl(&h) >= needed, "instance: {}", instance_ttl(&h));
        let due = DataKey::BorrowerDue(h.cash_borrower.clone());
        assert!(
            entry_ttl(&h, &due) >= needed,
            "due: {}",
            entry_ttl(&h, &due)
        );
    }

    /// `trade_ttl_ledgers` on hand-built trades, so the arithmetic is pinned without going
    /// through `propose`.
    #[test]
    fn a_trades_lifetime_runs_to_maturity_plus_the_grace_plus_the_margin() {
        let h = setup();
        let now = h.env.ledger().timestamp();
        let lifetime = |maturity_at: u64| {
            let trade = RepoTrade {
                id: 1,
                cash_lender: h.cash_lender.clone(),
                cash_borrower: h.cash_borrower.clone(),
                asset: h.rwa.clone(),
                units: UNITS,
                cash_amount: CASH,
                rate_bps: 500,
                kind: RepoKind::Term,
                maturity_at,
                agreement_hash: hash(&h, 7),
                proposed_at: now,
                status: RepoStatus::Proposed,
                leg1_ledger: None,
                settled_at: None,
                pending_margin_call: false,
                margin_call_amount: 0,
                cure_deadline: None,
            };
            h.env
                .as_contract(&h.repo, || trade_ttl_ledgers(&h.env, &trade))
        };
        let grace_and_margin = UNWIND_ALLOWANCE_GRACE_LEDGERS + 2 * DAY_LEDGERS;
        let max_ttl = h.env.as_contract(&h.repo, || h.env.storage().max_ttl());

        // 60 days out: the 60 days, the week of unwind grace and the two-day margin.
        assert_eq!(
            lifetime(now + 2 * THIRTY_DAYS),
            2 * THIRTY_DAYS_LEDGERS + grace_and_margin
        );
        // A part of a ledger is rounded up: 60 days and one second is one ledger more.
        assert_eq!(
            lifetime(now + 2 * THIRTY_DAYS + 1),
            2 * THIRTY_DAYS_LEDGERS + 1 + grace_and_margin
        );
        // Already at or past maturity: the grace and margin alone are under 30 days, so the
        // shared 30-day floor applies.
        assert_eq!(lifetime(now), PERSISTENT_EXTEND_TO_LEDGERS);
        assert_eq!(lifetime(now - 500), PERSISTENT_EXTEND_TO_LEDGERS);
        // Further out than an entry may live: capped at the network's maximum.
        assert_eq!(lifetime(now + 20 * 365 * 24 * 3_600), max_ttl);
        assert_eq!(lifetime(u64::MAX), max_ttl);
    }

    #[test]
    #[should_panic(expected = "repo-dvp: trade not found")]
    fn extend_ttl_refuses_a_trade_that_does_not_exist() {
        let h = setup();
        RepoDvpClient::new(&h.env, &h.repo).extend_ttl(&42);
    }

    /// The keep-alive on a trade that closed 29 days ago: nothing has touched it since, so it
    /// and the instance are a day from expiring, and anyone can push them out again.
    #[test]
    fn extend_ttl_tops_up_a_trade_and_the_instance_that_are_about_to_lapse() {
        let h = setup();
        let repo = RepoDvpClient::new(&h.env, &h.repo);
        let id = proposed(&h, 3_600);
        repo.cancel_proposal(&h.cash_lender, &id);

        age(&h, THIRTY_DAYS_LEDGERS - DAY_LEDGERS);
        assert!(trade_ttl(&h, id) <= DAY_LEDGERS);
        assert!(instance_ttl(&h) <= DAY_LEDGERS);

        repo.extend_ttl(&id);
        assert!(trade_ttl(&h, id) >= PERSISTENT_EXTEND_TO_LEDGERS - 1);
        assert!(instance_ttl(&h) >= INSTANCE_EXTEND_TO_LEDGERS - 1);
    }

    /// For a settled trade the keep-alive also covers the borrower's due sum.
    #[test]
    fn extend_ttl_also_tops_up_a_settled_trades_due_sum() {
        let h = setup();
        let id = proposed(&h, 3_600);
        settle(&h, id);
        let due = DataKey::BorrowerDue(h.cash_borrower.clone());
        let expiry = DataKey::BorrowerDueExpiry(h.cash_borrower.clone());

        age(&h, THIRTY_DAYS_LEDGERS - DAY_LEDGERS);
        assert!(entry_ttl(&h, &due) <= DAY_LEDGERS);

        RepoDvpClient::new(&h.env, &h.repo).extend_ttl(&id);
        assert!(entry_ttl(&h, &due) >= PERSISTENT_EXTEND_TO_LEDGERS - 1);
        assert!(entry_ttl(&h, &expiry) >= PERSISTENT_EXTEND_TO_LEDGERS - 1);
    }

    /// Runs the instance down to its last hundred ledgers, makes one call, and checks the call
    /// pushed the instance back out to the shared target.
    fn extends_the_instance(h: &Harness, call: impl FnOnce(&RepoDvpClient)) {
        age(h, instance_ttl(h) - 100);
        call(&RepoDvpClient::new(&h.env, &h.repo));
        assert!(
            instance_ttl(h) >= INSTANCE_EXTEND_TO_LEDGERS - 1,
            "instance left with {} ledgers",
            instance_ttl(h)
        );
    }

    #[test]
    fn initialize_extends_the_instance() {
        let env = Env::default();
        env.mock_all_auths();
        let repo = env.register(RepoDvp, ());
        let ttl = || env.as_contract(&repo, || env.storage().instance().get_ttl());
        assert!(ttl() < INSTANCE_EXTEND_TO_LEDGERS - 1);

        RepoDvpClient::new(&env, &repo).initialize(
            &Address::generate(&env),
            &Address::generate(&env),
            &Address::generate(&env),
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert!(ttl() >= INSTANCE_EXTEND_TO_LEDGERS - 1);
    }

    #[test]
    fn the_admin_entry_points_extend_the_instance() {
        let h = setup();
        let thresholds = MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_500,
        };
        extends_the_instance(&h, |repo| repo.set_usdc(&h.admin, &h.usdc));
        extends_the_instance(&h, |repo| repo.set_cure_grace(&h.admin, &3_600));
        extends_the_instance(&h, |repo| repo.set_maturity_grace(&h.admin, &3_600));
        extends_the_instance(&h, |repo| {
            repo.configure_asset(&h.admin, &h.rwa, &h.price_guard, &500, &thresholds)
        });
        extends_the_instance(&h, |repo| repo.disable_asset(&h.admin, &h.rwa));
        extends_the_instance(&h, |repo| repo.enable_asset(&h.admin, &h.rwa));
    }

    #[test]
    fn the_pause_entry_points_extend_the_instance() {
        let h = setup();
        extends_the_instance(&h, |repo| repo.pause(&h.pauser, &PauseScope::Repos));
        let id = std::cell::Cell::new(0);
        extends_the_instance(&h, |repo| {
            id.set(repo.queue_unpause(&h.admin, &PauseScope::Repos))
        });
        extends_the_instance(&h, |repo| repo.execute_unpause(&id.get()));
        extends_the_instance(&h, |repo| {
            id.set(repo.queue_unpause(&h.admin, &PauseScope::Repos))
        });
        extends_the_instance(&h, |repo| repo.cancel_unpause(&h.admin, &id.get()));
    }

    #[test]
    fn the_read_only_entry_points_extend_the_instance() {
        let h = setup();
        let id = proposed(&h, 3_600);
        settle(&h, id);
        extends_the_instance(&h, |repo| {
            repo.cure_grace_seconds();
        });
        extends_the_instance(&h, |repo| {
            repo.maturity_grace_seconds();
        });
        extends_the_instance(&h, |repo| {
            repo.is_paused(&PauseScope::Repos);
        });
        extends_the_instance(&h, |repo| {
            repo.is_asset_enabled(&h.rwa);
        });
        extends_the_instance(&h, |repo| {
            repo.margin_view(&id);
        });
        extends_the_instance(&h, |repo| {
            repo.trade(&id);
        });
    }

    #[test]
    fn the_trade_entry_points_extend_the_instance() {
        let h = setup();
        let cancelled = std::cell::Cell::new(0);
        extends_the_instance(&h, |_| cancelled.set(proposed(&h, 3_600)));
        extends_the_instance(&h, |repo| {
            repo.cancel_proposal(&h.cash_lender, &cancelled.get())
        });

        // Settled, then left until long after maturity and its grace: the borrower can still
        // unwind, and a second trade left the same way can still be defaulted.
        let unwound = proposed(&h, 3_600);
        settle(&h, unwound);
        extends_the_instance(&h, |repo| repo.unwind(&h.cash_borrower, &unwound));

        let defaulted = proposed(&h, 3_600);
        settle(&h, defaulted);
        extends_the_instance(&h, |repo| {
            repo.default_at_maturity(&h.cash_lender, &defaulted)
        });
    }

    /// Why each entry point extends the instance itself, even those that go on to write a
    /// trade (which extends it too): not every path through them writes one. `call_margin` on a
    /// healthy position with no call open changes nothing and writes nothing.
    #[test]
    fn call_margin_extends_the_instance_even_when_it_has_nothing_to_write() {
        let h = setup();
        // 50 cash against 100 units at $1 with a 5% haircut: about 53% LTV, healthy.
        let id = proposed(&h, 3_600);
        settle(&h, id);

        extends_the_instance(&h, |repo| repo.call_margin(&h.keeper, &id));
        let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
        assert!(!trade.pending_margin_call);
    }
}
