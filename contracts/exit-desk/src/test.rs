//! Unit tests for `ExitDesk`. Uses a minimal in-crate mock `PriceGuard` (returns a canned
//! `GuardedPrice`) and a minimal in-crate mock token (for both the RWA leg and the USDC leg)
//! rather than deploying real SACs, per the skeleton scope.

use super::*;
use ballast_common::price::PriceStatus;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Env;

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
    desk: Address,
    admin: Address,
    keeper: Address,
    price_guard: Address,
    rwa: Address,
    usdc: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let keeper = Address::generate(&env);
    let price_publisher = Address::generate(&env);
    let risk = Address::generate(&env);

    let desk = env.register(ExitDesk, ());
    ExitDeskClient::new(&env, &desk).initialize(
        &admin,
        &pauser,
        &keeper,
        &price_publisher,
        &risk,
    );

    let price_guard = env.register(MockPriceGuard, ());
    let rwa = env.register(MockToken, ());
    let usdc = env.register(MockToken, ());

    Harness {
        env,
        desk,
        admin,
        keeper,
        price_guard,
        rwa,
        usdc,
    }
}

fn set_price(h: &Harness, value: i128, status: PriceStatus) {
    MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
        &h.rwa,
        &value,
        &status,
        &h.env.ledger().timestamp(),
    );
}

fn configure(h: &Harness, spread_bps: u32, per_holder_daily_cap: i128, desk_inventory_cap: i128) {
    ExitDeskClient::new(&h.env, &h.desk).configure_asset(
        &h.admin,
        &h.rwa,
        &h.price_guard,
        &spread_bps,
        &per_holder_daily_cap,
        &desk_inventory_cap,
    );
}

fn fund_desk(h: &Harness, amount: i128) {
    MockTokenClient::new(&h.env, &h.usdc).mint(&h.admin, &amount);
    ExitDeskClient::new(&h.env, &h.desk).fund(&h.admin, &h.usdc, &amount);
}

#[test]
fn quote_with_ok_price_applies_spread() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok); // $1.00

    let quote = ExitDeskClient::new(&h.env, &h.desk).quote(&h.rwa, &(100 * PRICE_SCALE));

    // 1% spread on $1.00 -> $0.99 per unit.
    let expected_price = PRICE_SCALE * 9_900 / 10_000;
    assert_eq!(quote.price, expected_price);
    assert_eq!(quote.usdc_out, 100 * PRICE_SCALE * expected_price / PRICE_SCALE);
    assert!(quote.usdc_out < 100 * PRICE_SCALE);
    assert_eq!(quote.expires_at, h.env.ledger().timestamp() + QUOTE_TTL_SECONDS);
}

#[test]
fn exit_happy_path_settles_both_legs() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let payout_to = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    let usdc_out = ExitDeskClient::new(&h.env, &h.desk).exit(
        &holder,
        &h.rwa,
        &units,
        &0,
        &payout_to,
    );

    assert!(usdc_out > 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&holder), 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.desk), units);
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&payout_to), usdc_out);
}

#[test]
#[should_panic(expected = "exit-desk: price is not Ok")]
fn exit_panics_on_degraded_price() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Degraded);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &holder);
}

#[test]
#[should_panic(expected = "exit-desk: price is not Ok")]
fn exit_panics_on_halted_price() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Halted);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &holder);
}

#[test]
#[should_panic(expected = "exit-desk: exceeds per-holder daily cap")]
fn exit_panics_on_per_holder_daily_cap() {
    let h = setup();
    let cap = 150 * PRICE_SCALE;
    configure(&h, 100, cap, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &(units * 2));

    let desk = ExitDeskClient::new(&h.env, &h.desk);
    desk.exit(&holder, &h.rwa, &units, &0, &holder); // 100 used, under 150 cap
    desk.exit(&holder, &h.rwa, &units, &0, &holder); // would bring total to 200 > 150
}

#[test]
#[should_panic(expected = "exit-desk: exceeds desk inventory cap")]
fn exit_panics_on_desk_inventory_cap() {
    let h = setup();
    let cap = 50 * PRICE_SCALE;
    configure(&h, 100, 1_000_000 * PRICE_SCALE, cap);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE; // already exceeds the 50-unit desk cap in one go
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &holder);
}

#[test]
#[should_panic(expected = "slippage")]
fn exit_panics_on_slippage() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    // Demand more USDC than the discounted price can produce.
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &(units + 1), &holder);
}
