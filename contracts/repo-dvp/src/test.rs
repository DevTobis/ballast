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
    // `accept_and_settle` needs `cash_lender.require_auth()` for a USDC transfer even though
    // `cash_borrower` is the top-level caller (in production, `cash_lender` pre-authorizes this
    // specific transfer as part of accepting the repo terms). Plain `mock_all_auths()` only mocks
    // auths tied to the root invocation, so this test harness needs the non-root variant.
    env.mock_all_auths_allowing_non_root_auth();
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
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.cash_borrower), units);
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
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&h.cash_borrower), cash_amount);

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
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.cash_borrower), units);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.repo), 0);

    let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
    assert_eq!(trade.status, RepoStatus::Unwound);
}

#[test]
fn call_margin_and_default_close_gives_lender_the_collateral() {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    // 95% collateral value (5% haircut) against 90 cash -> ~94.7% LTV -> MarginCall band.
    let cash_amount = 90 * PRICE_SCALE;
    let maturity = h.env.ledger().timestamp() + 30 * 24 * 3_600;
    let id = propose(&h, units, cash_amount, 500, maturity);

    MockTokenClient::new(&h.env, &h.rwa).mint(&h.cash_borrower, &units);
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.cash_lender, &cash_amount);
    RepoDvpClient::new(&h.env, &h.repo).accept_and_settle(&h.cash_borrower, &id);

    RepoDvpClient::new(&h.env, &h.repo).call_margin(&h.keeper, &id);
    let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
    assert!(trade.pending_margin_call);
    assert!(trade.margin_call_amount > 0);
    let deadline = trade.cure_deadline.expect("cure deadline should be set");

    h.env.ledger().set_timestamp(deadline);
    RepoDvpClient::new(&h.env, &h.repo).default_close(&h.keeper, &id);

    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.cash_lender), units);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.repo), 0);
    let trade = RepoDvpClient::new(&h.env, &h.repo).trade(&id);
    assert_eq!(trade.status, RepoStatus::Defaulted);
}
