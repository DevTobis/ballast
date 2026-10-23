//! Unit tests for `ExitDesk`. Uses a minimal in-crate mock `PriceGuard` (returns a canned
//! `GuardedPrice`) and a minimal in-crate mock token (for both the RWA leg and the USDC leg)
//! rather than deploying real SACs, per the skeleton scope.

use super::*;
use ballast_common::price::PriceStatus;
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
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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

#[test]
fn the_admin_can_take_the_usdc_float_back_out() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 100 * PRICE_SCALE);
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
fn disabled_asset_blocks_quote_and_exit_but_allows_withdraw_and_reenable() {
    let h = setup();
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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
    configure(&h, 100, 1_000_000 * PRICE_SCALE, 1_000_000 * PRICE_SCALE);
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

