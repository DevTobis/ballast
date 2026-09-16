use super::*;
use ballast_common::{
    asset::{AssetConfig, AssetStandard, CustodyMode},
    price::{GuardedPrice, PriceSource, PriceStatus, PRICE_SCALE},
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token, vec, Env, Symbol,
};

#[contract]
struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn set_config(env: Env, asset: Address, config: AssetConfig) {
        env.storage().instance().set(&asset, &config);
    }
    pub fn asset(env: Env, asset: Address) -> AssetConfig {
        env.storage().instance().get(&asset).unwrap()
    }
}

#[contract]
struct MockPriceGuard;

#[contractimpl]
impl MockPriceGuard {
    pub fn set_price(env: Env, asset: Address, value: i128, status: PriceStatus) {
        let guarded = GuardedPrice {
            asset: asset.clone(),
            value,
            status,
            ts: env.ledger().timestamp(),
            sources: vec![
                &env,
                PriceSource {
                    name: Symbol::new(&env, "issuer"),
                    value,
                    observed_at: env.ledger().timestamp(),
                    stale: false,
                },
            ],
        };
        env.storage().instance().set(&asset, &guarded);
    }
    pub fn guarded_price(env: Env, asset: Address) -> GuardedPrice {
        env.storage().instance().get(&asset).unwrap()
    }
}

#[contract]
struct MockPledgeVault;

#[contractimpl]
impl MockPledgeVault {
    pub fn liquidate(env: Env, _keeper: Address, _line: u64, _asset: Address, units: i128, to: Address) {
        env.storage().instance().set(&Symbol::new(&env, "liq_units"), &units);
        env.storage().instance().set(&Symbol::new(&env, "liq_to"), &to);
    }
    pub fn last_liquidation(env: Env) -> (i128, Address) {
        (
            env.storage().instance().get(&Symbol::new(&env, "liq_units")).unwrap(),
            env.storage().instance().get(&Symbol::new(&env, "liq_to")).unwrap(),
        )
    }
}

#[allow(dead_code)]
struct Harness {
    env: Env,
    line_contract: Address,
    registry: Address,
    price_guard: Address,
    pledge_vault: Address,
    usdc: Address,
    lender: Address,
    borrower: Address,
    asset: Address,
    keeper: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let keeper = Address::generate(&env);
    let price_publisher = Address::generate(&env);
    let risk = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);

    let registry = env.register(MockRegistry, ());
    let price_guard = env.register(MockPriceGuard, ());
    let pledge_vault = env.register(MockPledgeVault, ());
    let line_contract = env.register(CreditLine, ());

    let usdc_admin = Address::generate(&env);
    let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc = usdc_token.address();
    token::StellarAssetClient::new(&env, &usdc).mint(&lender, &(1_000_000 * PRICE_SCALE));

    let asset_admin = Address::generate(&env);
    let asset_token = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = asset_token.address();

    MockRegistryClient::new(&env, &registry).set_config(
        &asset,
        &AssetConfig {
            issuer: Address::generate(&env),
            contract: asset.clone(),
            standard: AssetStandard::ClassicSac,
            yield_type: ballast_common::asset::YieldType::Accumulating,
            custody_mode: CustodyMode::Escrow,
            ccy: Symbol::new(&env, "USD"),
            redemption_lag_days: 1,
            haircut_base_bps: 0,
            haircut_fx_bps: 0,
            price_band_bps: 50,
            daily_move_band_bps: 100,
            status: Symbol::new(&env, "active"),
        },
    );

    // $1.00 guarded price, 7-decimal fixed point, status Ok.
    MockPriceGuardClient::new(&env, &price_guard).set_price(&asset, &PRICE_SCALE, &PriceStatus::Ok);

    CreditLineClient::new(&env, &line_contract).initialize(
        &admin,
        &pauser,
        &keeper,
        &price_publisher,
        &risk,
        &registry,
        &price_guard,
        &pledge_vault,
        &usdc,
    );

    Harness {
        env,
        line_contract,
        registry,
        price_guard,
        pledge_vault,
        usdc,
        lender,
        borrower,
        asset,
        keeper,
    }
}

fn open_funded_line(h: &Harness, limit: i128, collateral_units: i128) -> u64 {
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    let agreement = soroban_sdk::BytesN::from_array(&h.env, &[7u8; 32]);
    let line = client.open(&h.lender, &h.borrower, &h.asset, &limit, &700u32, &86_400u64, &agreement);
    client.fund(&h.lender, &line, &limit);
    client.set_collateral(&h.keeper, &line, &h.asset, &collateral_units);
    line
}

#[test]
fn open_fund_draw_repay_round_trip() {
    let h = setup();
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    // 1,000 units @ $1 collateral, no haircut -> $1,000 collateral value.
    let line = open_funded_line(&h, 900 * PRICE_SCALE, 1_000 * PRICE_SCALE);

    client.draw(&h.borrower, &line, &(100 * PRICE_SCALE), &h.borrower);
    assert_eq!(token::Client::new(&h.env, &h.usdc).balance(&h.borrower), 100 * PRICE_SCALE);

    let view = client.ltv(&line);
    assert_eq!(view.debt, 100 * PRICE_SCALE);
    assert_eq!(view.state, MarginState::Healthy);

    client.repay(&h.borrower, &line, &(50 * PRICE_SCALE));
    let view = client.ltv(&line);
    assert!(view.debt < 100 * PRICE_SCALE);
}

#[test]
#[should_panic(expected = "draw would push LTV past the healthy threshold")]
fn draw_rejected_when_it_would_breach_healthy_threshold() {
    let h = setup();
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    // Collateral worth $1,000; warning threshold defaults to 70% LTV -> max healthy debt $700.
    let line = open_funded_line(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    client.draw(&h.borrower, &line, &(800 * PRICE_SCALE), &h.borrower);
}

#[test]
fn draw_succeeds_under_healthy_threshold() {
    let h = setup();
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    let line = open_funded_line(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    client.draw(&h.borrower, &line, &(600 * PRICE_SCALE), &h.borrower);
    let view = client.ltv(&line);
    assert_eq!(view.state, MarginState::Healthy);
}

#[test]
#[should_panic(expected = "price is not Ok, draws are blocked")]
fn draw_blocked_on_degraded_price() {
    let h = setup();
    MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
        &h.asset,
        &PRICE_SCALE,
        &PriceStatus::Degraded,
    );
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    let line = open_funded_line(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    client.draw(&h.borrower, &line, &(100 * PRICE_SCALE), &h.borrower);
}

#[test]
#[should_panic(expected = "paused")]
fn draw_blocked_when_paused() {
    let h = setup();
    let line = open_funded_line(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    h.env.as_contract(&h.line_contract, || {
        ballast_common::pause::set_paused(&h.env, &ballast_common::pause::PauseScope::Draws, true);
    });
    CreditLineClient::new(&h.env, &h.line_contract).draw(&h.borrower, &line, &(100 * PRICE_SCALE), &h.borrower);
}

#[test]
fn repay_still_works_when_paused() {
    let h = setup();
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    let line = open_funded_line(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    client.draw(&h.borrower, &line, &(100 * PRICE_SCALE), &h.borrower);

    h.env.as_contract(&h.line_contract, || {
        ballast_common::pause::set_paused(&h.env, &ballast_common::pause::PauseScope::Draws, true);
    });
    client.repay(&h.borrower, &line, &(50 * PRICE_SCALE));
    let view = client.ltv(&line);
    assert!(view.debt < 100 * PRICE_SCALE);
}

#[test]
fn liquidate_requires_two_reads_at_least_one_ledger_apart() {
    let h = setup();
    let client = CreditLineClient::new(&h.env, &h.line_contract);
    let line = open_funded_line(&h, 1_000 * PRICE_SCALE, 1_000 * PRICE_SCALE);
    client.draw(&h.borrower, &line, &(600 * PRICE_SCALE), &h.borrower);

    // Crash the price so LTV blows past the liquidation threshold.
    MockPriceGuardClient::new(&h.env, &h.price_guard).set_price(
        &h.asset,
        &(500_000), // $0.05, collateral value collapses
        &PriceStatus::Ok,
    );

    client.poke(&h.borrower, &line);
    let view = client.ltv(&line);
    assert_eq!(view.state, MarginState::Liquidation);

    // Same ledger: must fail.
    let seq = h.env.ledger().sequence();
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.liquidate(&h.keeper, &line, &LiquidationRoute::Transfer);
    }));
    assert!(panicked.is_err(), "liquidation must not succeed in the same ledger as the breach");

    // Advance the ledger; a confirming poke + liquidate should now succeed.
    h.env.ledger().set_sequence_number(seq + 2);
    client.poke(&h.borrower, &line);
    client.liquidate(&h.keeper, &line, &LiquidationRoute::Transfer);

    let (units, to) = MockPledgeVaultClient::new(&h.env, &h.pledge_vault).last_liquidation();
    assert_eq!(units, 1_000 * PRICE_SCALE);
    assert_eq!(to, h.lender);
}
