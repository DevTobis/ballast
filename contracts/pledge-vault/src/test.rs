use super::*;
use ballast_common::asset::{AssetConfig, AssetStandard, CustodyMode as CM, YieldType};
use soroban_sdk::{contract, contractimpl, testutils::Address as _, token, Env, Symbol};

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
struct MockCreditLine;

#[contractimpl]
impl MockCreditLine {
    pub fn set_healthy(env: Env, healthy: bool) {
        env.storage().instance().set(&Symbol::new(&env, "healthy"), &healthy);
    }

    pub fn would_stay_healthy(env: Env, _line: u64, _asset: Address, _units_removed: i128) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "healthy"))
            .unwrap_or(false)
    }
}

fn default_config(env: &Env, contract: &Address, custody_mode: CM) -> AssetConfig {
    AssetConfig {
        issuer: Address::generate(env),
        contract: contract.clone(),
        standard: AssetStandard::ClassicSac,
        yield_type: YieldType::Accumulating,
        custody_mode,
        ccy: Symbol::new(env, "USD"),
        redemption_lag_days: 1,
        haircut_base_bps: 300,
        haircut_fx_bps: 0,
        price_band_bps: 50,
        daily_move_band_bps: 100,
        status: Symbol::new(env, "active"),
    }
}

#[allow(dead_code)]
struct Harness {
    env: Env,
    vault: Address,
    registry: Address,
    credit_line: Address,
    token: Address,
    borrower: Address,
    keeper: Address,
    gateway: Address,
}

fn setup(custody_mode: CM) -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let keeper = Address::generate(&env);
    let price_publisher = Address::generate(&env);
    let risk = Address::generate(&env);
    let custody = Address::generate(&env);
    let gateway = Address::generate(&env);
    let borrower = Address::generate(&env);

    let registry = env.register(MockRegistry, ());
    let credit_line = env.register(MockCreditLine, ());
    let vault = env.register(PledgeVault, ());

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token.address();
    token::StellarAssetClient::new(&env, &token_address).mint(&borrower, &1_000_000_000);

    let config = default_config(&env, &token_address, custody_mode);
    MockRegistryClient::new(&env, &registry).set_config(&token_address, &config);

    PledgeVaultClient::new(&env, &vault).initialize(
        &admin,
        &pauser,
        &keeper,
        &price_publisher,
        &risk,
        &registry,
        &credit_line,
        &custody,
        &gateway,
    );

    Harness {
        env,
        vault,
        registry,
        credit_line,
        token: token_address,
        borrower,
        keeper,
        gateway,
    }
}

#[test]
fn pledge_and_release_round_trip_escrow() {
    let h = setup(CM::Escrow);
    let client = PledgeVaultClient::new(&h.env, &h.vault);
    let cl_client = MockCreditLineClient::new(&h.env, &h.credit_line);

    client.pledge(&h.borrower, &1u64, &h.token, &1_000);
    let pos = client.position(&1u64, &h.token);
    assert_eq!(pos.units, 1_000);
    assert_eq!(token::Client::new(&h.env, &h.token).balance(&h.vault), 1_000);

    cl_client.set_healthy(&true);
    client.release(&h.borrower, &1u64, &h.token, &400);
    let pos = client.position(&1u64, &h.token);
    assert_eq!(pos.units, 600);
    assert_eq!(token::Client::new(&h.env, &h.token).balance(&h.borrower), 1_000_000_000 - 600);
}

#[test]
#[should_panic(expected = "release would leave the credit line unhealthy")]
fn release_panics_when_unhealthy() {
    let h = setup(CM::Escrow);
    let client = PledgeVaultClient::new(&h.env, &h.vault);
    let cl_client = MockCreditLineClient::new(&h.env, &h.credit_line);

    client.pledge(&h.borrower, &1u64, &h.token, &1_000);
    cl_client.set_healthy(&false);
    client.release(&h.borrower, &1u64, &h.token, &400);
}

#[test]
#[should_panic(expected = "paused")]
fn pledge_fails_when_paused() {
    let h = setup(CM::Escrow);
    h.env.as_contract(&h.vault, || {
        ballast_common::pause::set_paused(&h.env, &ballast_common::pause::PauseScope::Pledges, true);
    });
    let client = PledgeVaultClient::new(&h.env, &h.vault);
    client.pledge(&h.borrower, &1u64, &h.token, &1_000);
}

#[test]
fn release_still_works_while_paused() {
    let h = setup(CM::Escrow);
    let client = PledgeVaultClient::new(&h.env, &h.vault);
    let cl_client = MockCreditLineClient::new(&h.env, &h.credit_line);

    client.pledge(&h.borrower, &1u64, &h.token, &1_000);
    cl_client.set_healthy(&true);

    h.env.as_contract(&h.vault, || {
        ballast_common::pause::set_paused(&h.env, &ballast_common::pause::PauseScope::Pledges, true);
    });
    client.release(&h.borrower, &1u64, &h.token, &400);

    let pos = client.position(&1u64, &h.token);
    assert_eq!(pos.units, 600);
}

#[test]
fn liquidate_moves_collateral_to_target_bypassing_health_check() {
    let h = setup(CM::Escrow);
    let client = PledgeVaultClient::new(&h.env, &h.vault);
    let cl_client = MockCreditLineClient::new(&h.env, &h.credit_line);
    let lender = Address::generate(&h.env);

    client.pledge(&h.borrower, &1u64, &h.token, &1_000);
    cl_client.set_healthy(&false); // even unhealthy, liquidate must still work

    client.liquidate(&h.keeper, &1u64, &h.token, &1_000, &lender);

    let pos = client.position(&1u64, &h.token);
    assert_eq!(pos.units, 0);
    assert_eq!(token::Client::new(&h.env, &h.token).balance(&lender), 1_000);
}

#[test]
fn lien_mode_records_no_token_movement_and_attaches_lien_ref() {
    let h = setup(CM::IssuerLien);
    let client = PledgeVaultClient::new(&h.env, &h.vault);

    client.pledge(&h.borrower, &2u64, &h.token, &500);
    // No tokens should have moved for a lien-mode pledge.
    assert_eq!(token::Client::new(&h.env, &h.token).balance(&h.vault), 0);

    let lien_ref = soroban_sdk::Bytes::from_slice(&h.env, b"issuer-confirmation-1");
    client.record_lien(&h.gateway, &2u64, &h.token, &500, &lien_ref);

    let pos = client.position(&2u64, &h.token);
    assert_eq!(pos.units, 500);
    assert!(pos.lien_ref.is_some());
}
