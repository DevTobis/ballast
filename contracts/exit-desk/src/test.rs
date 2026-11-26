//! Unit tests for `ExitDesk`. Uses a minimal in-crate mock `PriceGuard` (returns a canned
//! `GuardedPrice`) and a minimal in-crate mock token (for both the RWA leg and the USDC leg)
//! rather than deploying real SACs, per the skeleton scope.

use super::*;
use ballast_common::price::PriceStatus;
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _, Temporary as _};
use soroban_sdk::testutils::{Address as _, Ledger as _};
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
    pauser: Address,
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
    ExitDeskClient::new(&env, &desk).initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

    let price_guard = env.register(MockPriceGuard, ());
    let rwa = env.register(MockToken, ());
    let usdc = env.register(MockToken, ());

    ExitDeskClient::new(&env, &desk).set_usdc(&admin, &usdc);

    Harness {
        env,
        desk,
        admin,
        pauser,
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

/// Configures the asset with the desk daily cap set to the inventory cap, so it never binds
/// before the inventory cap does. Tests of the desk daily cap use `configure_with_desk_daily_cap`.
fn configure(h: &Harness, spread_bps: u32, per_holder_daily_cap: i128, desk_inventory_cap: i128) {
    configure_with_desk_daily_cap(
        h,
        spread_bps,
        per_holder_daily_cap,
        desk_inventory_cap,
        desk_inventory_cap,
    );
}

fn configure_with_desk_daily_cap(
    h: &Harness,
    spread_bps: u32,
    per_holder_daily_cap: i128,
    desk_daily_cap: i128,
    desk_inventory_cap: i128,
) {
    ExitDeskClient::new(&h.env, &h.desk).configure_asset(
        &h.admin,
        &h.rwa,
        &h.price_guard,
        &spread_bps,
        &per_holder_daily_cap,
        &desk_daily_cap,
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
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok); // $1.00

    let quote = ExitDeskClient::new(&h.env, &h.desk).quote(&h.rwa, &(100 * PRICE_SCALE));

    // 1% spread on $1.00 -> $0.99 per unit.
    let expected_price = PRICE_SCALE * 9_900 / 10_000;
    assert_eq!(quote.price, expected_price);
    assert_eq!(
        quote.usdc_out,
        100 * PRICE_SCALE * expected_price / PRICE_SCALE
    );
    assert!(quote.usdc_out < 100 * PRICE_SCALE);
    assert_eq!(
        quote.expires_at,
        h.env.ledger().timestamp() + QUOTE_TTL_SECONDS
    );
}

#[test]
fn exit_happy_path_settles_both_legs() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let payout_to = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    let usdc_out =
        ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &payout_to);

    assert!(usdc_out > 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&holder), 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.desk), units);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&payout_to),
        usdc_out
    );
}

#[test]
fn exit_before_at_or_before_deadline_succeeds() {
    let h = setup();
    h.env.ledger().set_timestamp(1_000);
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let payout_to = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    let now = h.env.ledger().timestamp();
    // Exactly at the deadline
    let usdc_out = ExitDeskClient::new(&h.env, &h.desk).exit_before(
        &holder,
        &h.rwa,
        &units,
        &0,
        &payout_to,
        &now,
    );

    assert!(usdc_out > 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&holder), 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&h.desk), units);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&payout_to),
        usdc_out
    );

    // Well before the deadline
    let holder2 = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder2, &units);
    let usdc_out2 = ExitDeskClient::new(&h.env, &h.desk).exit_before(
        &holder2,
        &h.rwa,
        &units,
        &0,
        &holder2,
        &(now + 3_600),
    );
    assert!(usdc_out2 > 0);
}

#[test]
#[should_panic(expected = "exit-desk: deadline has passed")]
fn exit_before_after_deadline_panics() {
    let h = setup();
    h.env.ledger().set_timestamp(1_000);
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    let now = h.env.ledger().timestamp();
    // 1 second past deadline
    ExitDeskClient::new(&h.env, &h.desk).exit_before(
        &holder,
        &h.rwa,
        &units,
        &0,
        &holder,
        &(now - 1),
    );
}

#[test]
#[should_panic(expected = "exit-desk: price is not Ok")]
fn exit_panics_on_degraded_price() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
    configure_with_desk_daily_cap(&h, 100, cap, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
#[should_panic(expected = "exit-desk: exceeds desk daily cap")]
fn exit_panics_on_desk_daily_cap_across_two_holders() {
    let h = setup();
    let per_holder_cap = 100 * PRICE_SCALE;
    let desk_daily_cap = 150 * PRICE_SCALE;
    let desk_inventory_cap = 1_000_000 * PRICE_SCALE;
    configure_with_desk_daily_cap(&h, 100, per_holder_cap, desk_daily_cap, desk_inventory_cap);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder1 = Address::generate(&h.env);
    let holder2 = Address::generate(&h.env);
    let units1 = 90 * PRICE_SCALE;
    let units2 = 70 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder1, &units1);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder2, &units2);

    let desk = ExitDeskClient::new(&h.env, &h.desk);
    // holder1 exits 90 units (under per-holder cap of 100, total desk daily = 90 <= 150)
    desk.exit(&holder1, &h.rwa, &units1, &0, &holder1);

    // holder2 exits 70 units (under per-holder cap of 100, but 90 + 70 = 160 > 150 desk daily cap)
    desk.exit(&holder2, &h.rwa, &units2, &0, &holder2);
}

#[test]
fn exit_desk_daily_cap_exact_boundary_and_rollover() {
    let h = setup();
    let per_holder_cap = 100 * PRICE_SCALE;
    let desk_daily_cap = 150 * PRICE_SCALE;
    let desk_inventory_cap = 1_000_000 * PRICE_SCALE;
    configure_with_desk_daily_cap(&h, 100, per_holder_cap, desk_daily_cap, desk_inventory_cap);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder1 = Address::generate(&h.env);
    let holder2 = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder1, &(200 * PRICE_SCALE));
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder2, &(200 * PRICE_SCALE));

    let desk = ExitDeskClient::new(&h.env, &h.desk);

    // Initial timestamp: 100_000 (day bucket 1)
    h.env.ledger().set_timestamp(100_000);

    // holder1 exits 80 units: desk daily = 80
    desk.exit(&holder1, &h.rwa, &(80 * PRICE_SCALE), &0, &holder1);

    // holder2 exits exactly 70 units: desk daily hits exact boundary 80 + 70 = 150 <= 150
    desk.exit(&holder2, &h.rwa, &(70 * PRICE_SCALE), &0, &holder2);

    // One more unit on same day fails
    let refused = desk.try_exit(&holder1, &h.rwa, &PRICE_SCALE, &0, &holder1);
    assert!(refused.is_err(), "exceeding desk daily cap by 1 stroop must fail");

    // Rollover to next UTC day (add 86_400 seconds)
    h.env.ledger().set_timestamp(100_000 + 86_400);

    // On next day, daily cap is reset and exit succeeds
    desk.exit(&holder1, &h.rwa, &(80 * PRICE_SCALE), &0, &holder1);
    desk.exit(&holder2, &h.rwa, &(70 * PRICE_SCALE), &0, &holder2);
}

#[test]
#[should_panic(expected = "exit-desk: exceeds desk inventory cap")]
fn exit_panics_on_desk_inventory_cap() {
    let h = setup();
    let cap = 50 * PRICE_SCALE;
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, cap);
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
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);

    // Demand more USDC than the discounted price can produce.
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &(units + 1), &holder);
}

// --- #213: the USDC float -----------------------------------------------------------------

/// What 100 units pay at $1.00 with a 1% spread.
const PAYOUT_FOR_100_UNITS: i128 = 99 * PRICE_SCALE;

/// A desk that quotes `PAYOUT_FOR_100_UNITS` for 100 units and holds `float` USDC, and a holder
/// with those 100 units. Both caps are exactly 100 units, so one exit of the lot uses them up.
fn desk_with_float(float: i128) -> (Harness, Address, i128) {
    let h = setup();
    let units = 100 * PRICE_SCALE;
    configure_with_desk_daily_cap(&h, 100, units, units, units);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    if float > 0 {
        fund_desk(&h, float);
    }
    let holder = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);
    (h, holder, units)
}

#[test]
#[should_panic(expected = "exit-desk: insufficient USDC float")]
fn exit_panics_when_the_float_is_one_stroop_short_of_the_payout() {
    let (h, holder, units) = desk_with_float(PAYOUT_FOR_100_UNITS - 1);
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &holder);
}

#[test]
#[should_panic(expected = "exit-desk: insufficient USDC float")]
fn exit_panics_with_the_float_message_on_a_desk_that_was_never_funded() {
    let (h, holder, units) = desk_with_float(0);
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &holder);
}

#[test]
fn exit_pays_out_a_float_that_exactly_covers_the_payout() {
    let (h, holder, units) = desk_with_float(PAYOUT_FOR_100_UNITS);
    let desk = ExitDeskClient::new(&h.env, &h.desk);

    let usdc_out = desk.exit(&holder, &h.rwa, &units, &0, &holder);

    assert_eq!(usdc_out, PAYOUT_FOR_100_UNITS);
    assert_eq!(
        MockTokenClient::new(&h.env, &h.usdc).balance(&holder),
        PAYOUT_FOR_100_UNITS
    );
    assert_eq!(desk.available_usdc(), 0);
}

/// A refused exit takes nothing and uses up nothing. The caps here are exactly 100 units, so if
/// the refused call had counted against the holder's daily cap or the desk's inventory, the same
/// exit could not go through once the float is topped up.
#[test]
fn an_exit_refused_for_a_short_float_changes_nothing() {
    let (h, holder, units) = desk_with_float(PAYOUT_FOR_100_UNITS - 1);
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    let rwa = MockTokenClient::new(&h.env, &h.rwa);
    let usdc = MockTokenClient::new(&h.env, &h.usdc);
    let payout_to = Address::generate(&h.env);

    let refused = desk.try_exit(&holder, &h.rwa, &units, &0, &payout_to);

    assert!(refused.is_err(), "a payout the desk cannot make must fail");
    assert_eq!(rwa.balance(&holder), units, "the holder keeps their RWA");
    assert_eq!(rwa.balance(&h.desk), 0, "the desk took no RWA");
    assert_eq!(usdc.balance(&payout_to), 0, "nothing was paid out");
    assert_eq!(desk.available_usdc(), PAYOUT_FOR_100_UNITS - 1);

    fund_desk(&h, 1);
    let usdc_out = desk.exit(&holder, &h.rwa, &units, &0, &payout_to);
    assert_eq!(usdc_out, PAYOUT_FOR_100_UNITS);
    assert_eq!(rwa.balance(&h.desk), units);
    assert_eq!(usdc.balance(&payout_to), PAYOUT_FOR_100_UNITS);
}

#[test]
fn available_usdc_follows_the_float_through_fund_exit_and_withdraw() {
    let (h, holder, units) = desk_with_float(0);
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    let quote = desk.quote(&h.rwa, &units);

    // A USDC token is set but nothing has been funded: the quote cannot be paid.
    assert_eq!(desk.available_usdc(), 0);
    assert!(quote.usdc_out > desk.available_usdc());

    fund_desk(&h, 1_000 * PRICE_SCALE);
    assert_eq!(desk.available_usdc(), 1_000 * PRICE_SCALE);
    assert!(quote.usdc_out <= desk.available_usdc());

    desk.exit(&holder, &h.rwa, &units, &0, &holder);
    assert_eq!(
        desk.available_usdc(),
        1_000 * PRICE_SCALE - PAYOUT_FOR_100_UNITS
    );

    desk.withdraw(
        &h.admin,
        &h.usdc,
        &(400 * PRICE_SCALE),
        &Address::generate(&h.env),
    );
    assert_eq!(
        desk.available_usdc(),
        600 * PRICE_SCALE - PAYOUT_FOR_100_UNITS
    );
}

/// A desk with roles and an asset configured, but no USDC token set yet.
fn desk_without_a_usdc_token() -> (Env, ExitDeskClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let desk = ExitDeskClient::new(&env, &env.register(ExitDesk, ()));
    desk.initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
    );
    let price_guard = env.register(MockPriceGuard, ());
    let rwa = env.register(MockToken, ());
    desk.configure_asset(
        &admin,
        &rwa,
        &price_guard,
        &100,
        &(1_000 * PRICE_SCALE),
        &(1_000 * PRICE_SCALE),
        &(1_000 * PRICE_SCALE),
    );
    MockPriceGuardClient::new(&env, &price_guard).set_price(
        &rwa,
        &PRICE_SCALE,
        &PriceStatus::Ok,
        &env.ledger().timestamp(),
    );
    (env, desk, rwa)
}

#[test]
fn available_usdc_is_zero_before_a_usdc_token_is_set() {
    let (_env, desk, _rwa) = desk_without_a_usdc_token();
    assert_eq!(desk.available_usdc(), 0);
}

#[test]
#[should_panic(expected = "exit-desk: usdc not configured")]
fn exit_before_a_usdc_token_is_set_still_says_usdc_is_not_configured() {
    let (env, desk, rwa) = desk_without_a_usdc_token();
    let holder = Address::generate(&env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&env, &rwa).mint(&holder, &units);
    desk.exit(&holder, &rwa, &units, &0, &holder);
}

#[test]
#[should_panic(expected = "exit-desk: usdc_out is zero")]
fn exit_rejects_a_dust_amount_that_would_pay_zero() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 25, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let holder = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &1);

    // One stroop at a 25 bps spread floors to a zero payout, and min_usdc_out = 0 allows it.
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &1, &0, &holder);
}

#[test]
fn quote_for_a_dust_amount_still_returns_zero_as_a_read() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 25, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);

    let quote = ExitDeskClient::new(&h.env, &h.desk).quote(&h.rwa, &1);

    assert_eq!(quote.usdc_out, 0);
}

#[test]
#[should_panic(expected = "exit-desk: spread must be below 100%")]
fn configure_asset_rejects_a_full_spread() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 10_000, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
}

#[test]
fn configure_asset_accepts_the_largest_spread_below_100_percent() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 9_999, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
}

#[test]
#[should_panic(expected = "exit-desk: desk_daily_cap must be positive")]
fn configure_asset_rejects_zero_desk_daily_cap() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000 * PRICE_SCALE, 0, 1_000 * PRICE_SCALE);
}

#[test]
#[should_panic(expected = "exit-desk: desk_daily_cap must be positive")]
fn configure_asset_rejects_negative_desk_daily_cap() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000 * PRICE_SCALE, -1, 1_000 * PRICE_SCALE);
}

#[test]
fn the_admin_can_take_the_usdc_float_back_out() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    fund_desk(&h, 1_000 * PRICE_SCALE);

    let treasury = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).withdraw(&h.admin, &h.usdc, &(400 * PRICE_SCALE), &treasury);

    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&treasury), 400 * PRICE_SCALE);
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&h.desk), 600 * PRICE_SCALE);
}

#[test]
fn withdrawing_rwa_inventory_frees_room_under_the_inventory_cap() {
    let h = setup();
    // The desk may hold at most 100 units.
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 100 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);
    let desk = ExitDeskClient::new(&h.env, &h.desk);

    let holder = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &(200 * PRICE_SCALE));
    desk.exit(&holder, &h.rwa, &(100 * PRICE_SCALE), &0, &holder);

    // Full: one more unit is refused.
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.exit(&holder, &h.rwa, &PRICE_SCALE, &0, &holder);
    }));
    assert!(refused.is_err(), "the desk is at its inventory cap");

    // The operator sells the inventory elsewhere and takes it out; exits resume.
    let treasury = Address::generate(&h.env);
    desk.withdraw(&h.admin, &h.rwa, &(60 * PRICE_SCALE), &treasury);
    assert_eq!(MockTokenClient::new(&h.env, &h.rwa).balance(&treasury), 60 * PRICE_SCALE);
    desk.exit(&holder, &h.rwa, &(50 * PRICE_SCALE), &0, &holder);
}

#[test]
fn only_the_admin_can_withdraw() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;
    let h = setup();
    fund_desk(&h, 1_000 * PRICE_SCALE);
    let stranger = Address::generate(&h.env);
    // Authorize only the stranger, so the call succeeds only if the contract fails to demand the
    // stored admin's own signature.
    h.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &h.desk,
            fn_name: "withdraw",
            args: (stranger.clone(), h.usdc.clone(), PRICE_SCALE, stranger.clone()).into_val(&h.env),
            sub_invokes: &[],
        },
    }]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ExitDeskClient::new(&h.env, &h.desk).withdraw(&stranger, &h.usdc, &PRICE_SCALE, &stranger);
    }));
    assert!(result.is_err(), "a stranger must not be able to drain the desk");
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&h.desk), 1_000 * PRICE_SCALE);
}

#[test]
fn set_usdc_configures_token_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let desk = env.register(ExitDesk, ());
    ExitDeskClient::new(&env, &desk).initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
    );
    let usdc = env.register(MockToken, ());
    let client = ExitDeskClient::new(&env, &desk);
    client.set_usdc(&admin, &usdc);
    assert_eq!(client.usdc(), usdc);
}

#[test]
#[should_panic(expected = "exit-desk: admin argument mismatch")]
fn set_usdc_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let desk = env.register(ExitDesk, ());
    ExitDeskClient::new(&env, &desk).initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
    );
    let stranger = Address::generate(&env);
    let usdc = env.register(MockToken, ());
    ExitDeskClient::new(&env, &desk).set_usdc(&stranger, &usdc);
}

#[test]
#[should_panic(expected = "exit-desk: usdc not configured")]
fn fund_panics_if_usdc_unset() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let desk = env.register(ExitDesk, ());
    ExitDeskClient::new(&env, &desk).initialize(
        &admin,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
    );
    let usdc = env.register(MockToken, ());
    MockTokenClient::new(&env, &usdc).mint(&admin, &(1_000 * PRICE_SCALE));
    ExitDeskClient::new(&env, &desk).fund(&admin, &usdc, &(1_000 * PRICE_SCALE));
}

#[test]
#[should_panic(expected = "exit-desk: usdc address mismatch")]
fn fund_panics_on_mismatched_usdc() {
    let h = setup();
    let wrong_token = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).fund(&h.admin, &wrong_token, &(1_000 * PRICE_SCALE));
}

fn disabled_asset_blocks_quote_and_exit_but_allows_withdraw_and_reenable() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);
    let desk = ExitDeskClient::new(&h.env, &h.desk);

    assert!(desk.is_asset_enabled(&h.rwa));

    // Non-admin cannot disable asset
    let stranger = Address::generate(&h.env);
    let unauthorized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.disable_asset(&stranger, &h.rwa);
    }));
    assert!(unauthorized.is_err(), "only admin may disable asset");

    // Admin disables asset
    desk.disable_asset(&h.admin, &h.rwa);
    assert!(!desk.is_asset_enabled(&h.rwa));

    // Quoting a disabled asset panics
    let quote_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.quote(&h.rwa, &PRICE_SCALE);
    }));
    assert!(quote_res.is_err(), "quoting disabled asset must fail");

    // Exiting a disabled asset panics
    let holder = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &(10 * PRICE_SCALE));
    let exit_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.exit(&holder, &h.rwa, &(10 * PRICE_SCALE), &0, &holder);
    }));
    assert!(exit_res.is_err(), "exiting disabled asset must fail");

    // Operator withdraw of float or inventory still succeeds when an asset is disabled
    let treasury = Address::generate(&h.env);
    desk.withdraw(&h.admin, &h.usdc, &(100 * PRICE_SCALE), &treasury);
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&treasury), 100 * PRICE_SCALE);

    // Re-enabling the asset restores quotes and exits
    desk.enable_asset(&h.admin, &h.rwa);
    assert!(desk.is_asset_enabled(&h.rwa));

    let q = desk.quote(&h.rwa, &PRICE_SCALE);
    assert!(q.usdc_out > 0);

    let out = desk.exit(&holder, &h.rwa, &(10 * PRICE_SCALE), &0, &holder);
    assert!(out > 0);
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&holder), out);
}


#[test]
fn pauser_can_pause_exits_and_exit_panics_while_quote_and_withdraw_work() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let desk = ExitDeskClient::new(&h.env, &h.desk);
    desk.pause(&h.pauser, &PauseScope::Exits);
    assert!(desk.is_paused(&PauseScope::Exits));

    // quote still works
    let quote = desk.quote(&h.rwa, &(100 * PRICE_SCALE));
    assert!(quote.usdc_out > 0);

    // withdraw still works
    let treasury = Address::generate(&h.env);
    desk.withdraw(&h.admin, &h.usdc, &(100 * PRICE_SCALE), &treasury);
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&treasury), 100 * PRICE_SCALE);

    // exit panics with ballast-common: paused
    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);
    let exit_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.exit(&holder, &h.rwa, &units, &0, &holder);
    }));
    assert!(exit_res.is_err(), "exit must panic when Exits scope is paused");
}

#[test]
fn pauser_can_pause_all_and_exit_panics_while_quote_and_withdraw_work() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let desk = ExitDeskClient::new(&h.env, &h.desk);
    desk.pause(&h.pauser, &PauseScope::All);
    assert!(desk.is_paused(&PauseScope::All));
    assert!(desk.is_paused(&PauseScope::Exits));

    // quote and withdraw still work
    let quote = desk.quote(&h.rwa, &(100 * PRICE_SCALE));
    assert!(quote.usdc_out > 0);

    let treasury = Address::generate(&h.env);
    desk.withdraw(&h.admin, &h.usdc, &(100 * PRICE_SCALE), &treasury);
    assert_eq!(MockTokenClient::new(&h.env, &h.usdc).balance(&treasury), 100 * PRICE_SCALE);

    // exit panics
    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);
    let exit_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.exit(&holder, &h.rwa, &units, &0, &holder);
    }));
    assert!(exit_res.is_err(), "exit must panic when All scope is paused");
}

#[test]
#[should_panic(expected = "exit-desk: pauser argument mismatch")]
fn pause_rejects_non_pauser() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).pause(&stranger, &PauseScope::Exits);
}

#[test]
fn unpause_enforces_timelock_and_restores_exits() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let desk = ExitDeskClient::new(&h.env, &h.desk);
    desk.pause(&h.pauser, &PauseScope::Exits);
    assert!(desk.is_paused(&PauseScope::Exits));

    let unpause_id = desk.queue_unpause(&h.admin, &PauseScope::Exits);

    // Executing before 48h elapses must fail
    let early_exec = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.execute_unpause(&unpause_id);
    }));
    assert!(early_exec.is_err(), "execute_unpause before timelock elapses must fail");

    // Advance ledger timestamp by 48h
    h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 48 * 3600);
    desk.execute_unpause(&unpause_id);
    assert!(!desk.is_paused(&PauseScope::Exits));

    // exit succeeds again
    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &units);
    let usdc_out = desk.exit(&holder, &h.rwa, &units, &0, &holder);
    assert!(usdc_out > 0);
}

#[test]
fn cancel_unpause_cancels_pending_unpause() {
    let h = setup();
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    desk.pause(&h.pauser, &PauseScope::Exits);

    let unpause_id = desk.queue_unpause(&h.admin, &PauseScope::Exits);
    desk.cancel_unpause(&h.admin, &unpause_id);

    h.env.ledger().set_timestamp(h.env.ledger().timestamp() + 48 * 3600);
    let exec_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.execute_unpause(&unpause_id);
    }));
    assert!(exec_res.is_err(), "executing cancelled unpause must fail");
}

#[test]
fn read_only_getters_and_capacity_track_state() {
    let h = setup();
    let per_holder_cap = 150 * PRICE_SCALE;
    let inventory_cap = 500 * PRICE_SCALE;
    configure(&h, 100, per_holder_cap, inventory_cap);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);

    let desk = ExitDeskClient::new(&h.env, &h.desk);
    let holder = Address::generate(&h.env);

    // Initial state
    assert_eq!(desk.usdc(), h.usdc);
    let cfg = desk.asset_config(&h.rwa);
    assert_eq!(cfg.spread_bps, 100);
    assert_eq!(cfg.per_holder_daily_cap, per_holder_cap);
    assert_eq!(cfg.desk_inventory_cap, inventory_cap);
    assert_eq!(desk.inventory(&h.rwa), 0);
    assert_eq!(desk.daily_used(&holder, &h.rwa), 0);
    assert_eq!(desk.capacity(&holder, &h.rwa), (per_holder_cap, inventory_cap));

    // After exit of 100 units
    let exit_units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &(200 * PRICE_SCALE));
    desk.exit(&holder, &h.rwa, &exit_units, &0, &holder);

    assert_eq!(desk.inventory(&h.rwa), exit_units);
    assert_eq!(desk.daily_used(&holder, &h.rwa), exit_units);
    assert_eq!(
        desk.capacity(&holder, &h.rwa),
        (per_holder_cap - exit_units, inventory_cap - exit_units)
    );

    // After another exit using the rest of holder cap (50 units)
    desk.exit(&holder, &h.rwa, &(50 * PRICE_SCALE), &0, &holder);
    assert_eq!(desk.daily_used(&holder, &h.rwa), per_holder_cap);
    assert_eq!(
        desk.capacity(&holder, &h.rwa),
        (0, inventory_cap - 150 * PRICE_SCALE)
    );
}

// --- configure_asset timelock (issue #214) ---

const CAP: i128 = 1_000 * PRICE_SCALE;

fn reconfigure(h: &Harness, price_guard: &Address, spread_bps: u32, holder_cap: i128, desk_cap: i128) {
    ExitDeskClient::new(&h.env, &h.desk).configure_asset(
        &h.admin,
        &h.rwa,
        price_guard,
        &spread_bps,
        &holder_cap,
        &desk_cap,
        &desk_cap,
    );
}

fn queue(h: &Harness, price_guard: &Address, spread_bps: u32, holder_cap: i128, desk_cap: i128) -> u64 {
    ExitDeskClient::new(&h.env, &h.desk).queue_configure_asset(
        &h.admin,
        &h.rwa,
        price_guard,
        &spread_bps,
        &holder_cap,
        &desk_cap,
        &desk_cap,
    )
}

fn advance(h: &Harness, seconds: u64) {
    h.env.ledger().set_timestamp(h.env.ledger().timestamp() + seconds);
}

#[test]
fn configure_asset_applies_tightening_changes_immediately() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    // Wider spread and lower caps, same price guard: no delay.
    reconfigure(&h, &h.price_guard, 250, CAP / 2, CAP / 4);
    let cfg = ExitDeskClient::new(&h.env, &h.desk).asset_config(&h.rwa);
    assert_eq!(cfg.spread_bps, 250);
    assert_eq!(cfg.per_holder_daily_cap, CAP / 2);
    assert_eq!(cfg.desk_inventory_cap, CAP / 4);
}

#[test]
fn configure_asset_accepts_an_unchanged_config() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    // Re-running the deploy script with the same values must not fail.
    configure(&h, 100, CAP, CAP);
}

#[test]
#[should_panic(expected = "use queue_configure_asset")]
fn configure_asset_refuses_a_new_price_guard() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let attacker_guard = h.env.register(MockPriceGuard, ());
    reconfigure(&h, &attacker_guard, 100, CAP, CAP);
}

#[test]
#[should_panic(expected = "use queue_configure_asset")]
fn configure_asset_refuses_a_lower_spread() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    reconfigure(&h, &h.price_guard, 99, CAP, CAP);
}

#[test]
#[should_panic(expected = "use queue_configure_asset")]
fn configure_asset_refuses_a_higher_holder_cap() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    reconfigure(&h, &h.price_guard, 100, CAP + 1, CAP);
}

#[test]
#[should_panic(expected = "use queue_configure_asset")]
fn configure_asset_refuses_a_higher_inventory_cap() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    reconfigure(&h, &h.price_guard, 100, CAP, CAP + 1);
}

#[test]
#[should_panic(expected = "use queue_configure_asset")]
fn configure_asset_refuses_a_mixed_change_that_loosens_anything() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    // Wider spread (tightening) but a higher cap (loosening): the whole change is timelocked.
    reconfigure(&h, &h.price_guard, 500, CAP * 2, CAP);
}

#[test]
fn queued_price_guard_change_applies_only_after_48h() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    let desk = ExitDeskClient::new(&h.env, &h.desk);

    // The new guard reports 10x the price.
    let new_guard = h.env.register(MockPriceGuard, ());
    MockPriceGuardClient::new(&h.env, &new_guard).set_price(
        &h.rwa,
        &(10 * PRICE_SCALE),
        &PriceStatus::Ok,
        &h.env.ledger().timestamp(),
    );

    let id = queue(&h, &new_guard, 100, CAP, CAP);
    let pending = desk.pending_config(&id).expect("queued");
    assert_eq!(pending.asset, h.rwa);
    assert_eq!(pending.config.price_guard, new_guard);
    assert_eq!(
        pending.executes_at,
        h.env.ledger().timestamp() + timelock::TIMELOCK_DELAY_SECONDS
    );

    // Nothing changes while queued: quotes still use the old guard.
    assert_eq!(desk.asset_config(&h.rwa).price_guard, h.price_guard);
    assert_eq!(desk.quote(&h.rwa, &PRICE_SCALE).price, 9_900_000);

    // One second short of 48h: still refused.
    advance(&h, timelock::TIMELOCK_DELAY_SECONDS - 1);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.execute_configure_asset(&id);
    }));
    assert!(early.is_err(), "execute before the timelock elapses must fail");
    assert_eq!(desk.asset_config(&h.rwa).price_guard, h.price_guard);

    advance(&h, 1);
    desk.execute_configure_asset(&id);
    assert_eq!(desk.asset_config(&h.rwa).price_guard, new_guard);
    assert_eq!(desk.quote(&h.rwa, &PRICE_SCALE).price, 99_000_000);
    assert!(desk.pending_config(&id).is_none());
}

#[test]
fn queued_spread_decrease_and_cap_increase_apply_after_48h() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let desk = ExitDeskClient::new(&h.env, &h.desk);

    let id = queue(&h, &h.price_guard, 10, CAP * 2, CAP * 3);
    assert_eq!(desk.asset_config(&h.rwa).spread_bps, 100);

    advance(&h, timelock::TIMELOCK_DELAY_SECONDS);
    desk.execute_configure_asset(&id);

    let cfg = desk.asset_config(&h.rwa);
    assert_eq!(cfg.spread_bps, 10);
    assert_eq!(cfg.per_holder_daily_cap, CAP * 2);
    assert_eq!(cfg.desk_inventory_cap, CAP * 3);
}

#[test]
#[should_panic(expected = "exit-desk: no such pending config")]
fn a_queued_config_executes_only_once() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    let id = queue(&h, &h.price_guard, 50, CAP, CAP);
    advance(&h, timelock::TIMELOCK_DELAY_SECONDS);
    desk.execute_configure_asset(&id);
    desk.execute_configure_asset(&id);
}

#[test]
fn cancelled_config_never_applies() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    let attacker_guard = h.env.register(MockPriceGuard, ());

    let id = queue(&h, &attacker_guard, 100, CAP, CAP);
    desk.cancel_configure_asset(&h.admin, &id);
    assert!(desk.pending_config(&id).is_none());

    advance(&h, timelock::TIMELOCK_DELAY_SECONDS);
    let exec = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        desk.execute_configure_asset(&id);
    }));
    assert!(exec.is_err(), "executing a cancelled config must fail");
    assert_eq!(desk.asset_config(&h.rwa).price_guard, h.price_guard);
}

#[test]
#[should_panic(expected = "exit-desk: spread must be below 100%")]
fn queue_configure_asset_validates_at_queue_time() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    queue(&h, &h.price_guard, 10_000, CAP, CAP);
}

#[test]
#[should_panic]
fn queue_configure_asset_rejects_non_admin() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let stranger = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).queue_configure_asset(
        &stranger,
        &h.rwa,
        &h.price_guard,
        &50,
        &CAP,
        &CAP,
        &CAP,
    );
}

#[test]
#[should_panic]
fn cancel_configure_asset_rejects_non_admin() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let id = queue(&h, &h.price_guard, 50, CAP, CAP);
    let stranger = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).cancel_configure_asset(&stranger, &id);
}

#[test]
fn a_queued_config_replaces_a_later_tightening_on_execute() {
    let h = setup();
    configure(&h, 100, CAP, CAP);
    let desk = ExitDeskClient::new(&h.env, &h.desk);

    let id = queue(&h, &h.price_guard, 50, CAP, CAP);
    // The operator tightens meanwhile; the queued config is a full replacement and wins on execute.
    reconfigure(&h, &h.price_guard, 300, CAP / 2, CAP / 2);
    advance(&h, timelock::TIMELOCK_DELAY_SECONDS);
    desk.execute_configure_asset(&id);

    let cfg = desk.asset_config(&h.rwa);
    assert_eq!(cfg.spread_bps, 50);
    assert_eq!(cfg.per_holder_daily_cap, CAP);
}

// --- Storage lifetime (#208) ---

fn exited_desk() -> (Harness, Address, i128) {
    let h = setup();
    configure(&h, 100, 150 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);
    let holder = Address::generate(&h.env);
    let units = 100 * PRICE_SCALE;
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder, &(units * 4));
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &units, &0, &holder);
    (h, holder, units)
}

fn daily_key(h: &Harness, holder: &Address) -> DataKey {
    DataKey::DailyUsed(
        holder.clone(),
        h.rwa.clone(),
        h.env.ledger().timestamp() / SECONDS_PER_DAY,
    )
}

#[test]
fn exit_extends_the_instance_and_inventory_and_keeps_daily_used_temporary() {
    let (h, holder, units) = exited_desk();
    let key = daily_key(&h, &holder);
    h.env.as_contract(&h.desk, || {
        let inventory = DataKey::Inventory(h.rwa.clone());
        assert_eq!(h.env.storage().instance().get_ttl(), ttl::INSTANCE_EXTEND_TO_LEDGERS);
        assert_eq!(
            h.env.storage().persistent().get_ttl(&inventory),
            ttl::PERSISTENT_EXTEND_TO_LEDGERS
        );
        assert!(!h.env.storage().persistent().has(&key));
        assert_eq!(h.env.storage().temporary().get::<_, i128>(&key), Some(units));
        assert_eq!(h.env.storage().temporary().get_ttl(&key), DAILY_USED_TTL_LEDGERS);
    });
}

#[test]
fn a_second_exit_the_same_day_refreshes_the_daily_used_lifetime() {
    let (h, holder, units) = exited_desk();
    h.env.ledger().with_mut(|l| {
        l.sequence_number += 10_000;
        l.timestamp += 60;
    });
    ExitDeskClient::new(&h.env, &h.desk).exit(&holder, &h.rwa, &(units / 2), &0, &holder);
    let key = daily_key(&h, &holder);
    h.env.as_contract(&h.desk, || {
        assert_eq!(h.env.storage().temporary().get_ttl(&key), DAILY_USED_TTL_LEDGERS);
    });
}

#[test]
fn withdraw_extends_the_inventory_entry() {
    let (h, _, _) = exited_desk();
    h.env.ledger().with_mut(|l| l.sequence_number += 505_000);
    let to = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).withdraw(&h.admin, &h.rwa, &PRICE_SCALE, &to);
    h.env.as_contract(&h.desk, || {
        assert_eq!(
            h.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Inventory(h.rwa.clone())),
            ttl::PERSISTENT_EXTEND_TO_LEDGERS
        );
        assert_eq!(h.env.storage().instance().get_ttl(), ttl::INSTANCE_EXTEND_TO_LEDGERS);
    });
}

#[test]
fn extend_ttl_keeps_an_idle_desk_alive() {
    let (h, _, _) = exited_desk();
    h.env.ledger().with_mut(|l| l.sequence_number += 505_000);
    ExitDeskClient::new(&h.env, &h.desk).extend_ttl(&h.rwa);
    h.env.as_contract(&h.desk, || {
        assert_eq!(h.env.storage().instance().get_ttl(), ttl::INSTANCE_EXTEND_TO_LEDGERS);
        assert_eq!(
            h.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Inventory(h.rwa.clone())),
            ttl::PERSISTENT_EXTEND_TO_LEDGERS
        );
    });
}

#[test]
fn extend_ttl_for_an_asset_with_no_inventory_does_not_create_an_entry() {
    let h = setup();
    let other = Address::generate(&h.env);
    ExitDeskClient::new(&h.env, &h.desk).extend_ttl(&other);
    h.env.as_contract(&h.desk, || {
        assert!(!h.env.storage().persistent().has(&DataKey::Inventory(other.clone())));
    });
}

#[test]
fn the_daily_cap_resets_at_the_next_utc_day() {
    let (h, holder, units) = exited_desk();
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    // 100 of the 150 cap used; a further 100 today is refused (covered by
    // exit_panics_on_per_holder_daily_cap). Move to the first second of the next day.
    let now = h.env.ledger().timestamp();
    let next_day = (now / SECONDS_PER_DAY + 1) * SECONDS_PER_DAY;
    h.env.ledger().with_mut(|l| {
        l.timestamp = next_day;
        l.sequence_number += 17_280;
    });
    // The price must still be fresh at the new timestamp.
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);

    assert_eq!(desk.daily_used(&holder, &h.rwa), 0);
    assert_eq!(desk.capacity(&holder, &h.rwa).0, 150 * PRICE_SCALE);
    desk.exit(&holder, &h.rwa, &units, &0, &holder);
    assert_eq!(desk.daily_used(&holder, &h.rwa), units);
    assert_eq!(desk.inventory(&h.rwa), units * 2);
}

// --- Desk daily cap integration (#195 with #208 and #214) ---

#[test]
#[should_panic(expected = "use queue_configure_asset")]
fn configure_asset_refuses_a_higher_desk_daily_cap() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, CAP, CAP, CAP * 2);
    configure_with_desk_daily_cap(&h, 100, CAP, CAP + 1, CAP * 2);
}

#[test]
fn configure_asset_lowers_the_desk_daily_cap_immediately() {
    let h = setup();
    configure_with_desk_daily_cap(&h, 100, CAP, CAP, CAP * 2);
    configure_with_desk_daily_cap(&h, 100, CAP, CAP / 2, CAP * 2);
    assert_eq!(
        ExitDeskClient::new(&h.env, &h.desk)
            .asset_config(&h.rwa)
            .desk_daily_cap,
        CAP / 2
    );
}

#[test]
fn capacity_reports_the_desk_daily_cap_when_it_binds() {
    let h = setup();
    let per_holder_cap = 100 * PRICE_SCALE;
    let desk_daily_cap = 150 * PRICE_SCALE;
    configure_with_desk_daily_cap(&h, 100, per_holder_cap, desk_daily_cap, 1_000_000 * PRICE_SCALE);
    set_price(&h, PRICE_SCALE, PriceStatus::Ok);
    fund_desk(&h, 10_000 * PRICE_SCALE);
    let holder1 = Address::generate(&h.env);
    let holder2 = Address::generate(&h.env);
    MockTokenClient::new(&h.env, &h.rwa).mint(&holder1, &(100 * PRICE_SCALE));
    let desk = ExitDeskClient::new(&h.env, &h.desk);
    desk.exit(&holder1, &h.rwa, &(90 * PRICE_SCALE), &0, &holder1);

    // holder2 has their full 100 of holder room, but the desk has only 60 left today.
    assert_eq!(desk.desk_daily_used(&h.rwa), 90 * PRICE_SCALE);
    assert_eq!(
        desk.capacity(&holder2, &h.rwa),
        (per_holder_cap, 60 * PRICE_SCALE)
    );
}

#[test]
fn desk_daily_used_lives_in_temporary_storage() {
    let (h, holder, units) = exited_desk();
    let day = h.env.ledger().timestamp() / SECONDS_PER_DAY;
    let key = DataKey::DeskDailyUsed(h.rwa.clone(), day);
    h.env.as_contract(&h.desk, || {
        assert!(!h.env.storage().persistent().has(&key));
        assert_eq!(h.env.storage().temporary().get::<_, i128>(&key), Some(units));
        assert_eq!(h.env.storage().temporary().get_ttl(&key), DAILY_USED_TTL_LEDGERS);
    });
    let _ = holder;
}
