#![cfg(test)]

use ballast_common::{
    asset::CustodyMode,
    margin::{LiquidationRoute, MarginState, MarginThresholds},
    price::{PriceStatus, PRICE_SCALE},
};
use ballast_credit_line::{CreditLine, CreditLineClient, LineStatus};
use ballast_pledge_vault::{PledgeVault, PledgeVaultClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

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

struct TestHarness {
    env: Env,
    credit_line: CreditLineClient<'static>,
    pledge_vault: PledgeVaultClient<'static>,
    usdc: mock_token::MockTokenClient<'static>,
    rwa: mock_token::MockTokenClient<'static>,
    price_guard: mock_price_guard::MockPriceGuardClient<'static>,
    #[allow(dead_code)]
    admin: Address,
    keeper: Address,
    lender: Address,
    borrower: Address,
    #[allow(dead_code)]
    usdc_id: Address,
    rwa_id: Address,
}

fn setup_harness() -> TestHarness {
    let env = Env::default();
    env.mock_all_auths();

    let cl_id = env.register(CreditLine, ());
    let credit_line = CreditLineClient::new(&env, &cl_id);

    let pv_id = env.register(PledgeVault, ());
    let pledge_vault = PledgeVaultClient::new(&env, &pv_id);

    let usdc_id = env.register(mock_token::MockToken, ());
    let usdc = mock_token::MockTokenClient::new(&env, &usdc_id);

    let rwa_id = env.register(mock_token::MockToken, ());
    let rwa = mock_token::MockTokenClient::new(&env, &rwa_id);

    let pg_id = env.register(mock_price_guard::MockPriceGuard, ());
    let price_guard = mock_price_guard::MockPriceGuardClient::new(&env, &pg_id);
    price_guard.set_price(&(2 * PRICE_SCALE), &PriceStatus::Ok);

    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let keeper = Address::generate(&env);
    let price_publisher = Address::generate(&env);
    let risk = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);

    // Initialize roles on both real contracts
    credit_line.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);
    pledge_vault.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

    let thresholds = MarginThresholds {
        warning_bps: 7_000,
        margin_call_bps: 8_000,
        liquidation_bps: 9_000,
    };

    // Configure per-asset parameters on both real contracts
    credit_line.configure_asset(&admin, &rwa_id, &pg_id, &usdc_id, &1_000, &thresholds);
    pledge_vault.configure_asset(
        &admin,
        &rwa_id,
        &pg_id,
        &cl_id,
        &1_000,
        &thresholds,
        &CustodyMode::Escrow,
    );

    // Wire CreditLine to accept calls from the real PledgeVault
    credit_line.set_vault(&admin, &pv_id);

    TestHarness {
        env,
        credit_line,
        pledge_vault,
        usdc,
        rwa,
        price_guard,
        admin,
        keeper,
        lender,
        borrower,
        usdc_id,
        rwa_id,
    }
}

#[test]
fn test_real_credit_line_and_pledge_vault_full_lifecycle() {
    let h = setup_harness();

    // 1. Open credit line
    let agreement = BytesN::from_array(&h.env, &[1u8; 32]);
    let limit = 5_000 * PRICE_SCALE;
    let line_id = h.credit_line.open(
        &h.lender,
        &h.borrower,
        &h.rwa_id,
        &limit,
        &0,
        &86_400,
        &agreement,
    );
    let line_state = h.credit_line.line(&line_id);
    assert_eq!(line_state.status, LineStatus::Open);
    assert_eq!(line_state.limit, limit);
    assert_eq!(line_state.funded, 0);
    assert_eq!(line_state.drawn, 0);
    assert_eq!(line_state.pledged_units, 0);

    // 2. Fund line with USDC
    let fund_amount = 5_000 * PRICE_SCALE;
    h.usdc.mint(&h.lender, &fund_amount);
    h.credit_line.fund(&h.lender, &line_id, &fund_amount);
    assert_eq!(h.credit_line.line(&line_id).funded, fund_amount);
    assert_eq!(h.usdc.balance(&h.credit_line.address), fund_amount);

    // 3. Pledge collateral into PledgeVault (Escrow mode)
    // 1,000 units of RWA at $2.00 price = $2,000 gross. 10% haircut = $1,800 collateral value.
    let pledge_units = 1_000 * PRICE_SCALE;
    h.rwa.mint(&h.borrower, &pledge_units);
    h.pledge_vault
        .pledge(&h.borrower, &line_id, &h.rwa_id, &pledge_units);

    // Verify accounting in both PledgeVault and CreditLine (synced via sync_from_vault)
    assert_eq!(
        h.pledge_vault.position_units(&line_id, &h.rwa_id),
        pledge_units
    );
    assert_eq!(
        h.credit_line.line(&line_id).pledged_units,
        pledge_units
    );
    assert_eq!(h.rwa.balance(&h.pledge_vault.address), pledge_units);
    assert_eq!(h.rwa.balance(&h.borrower), 0);

    // 4. Draw USDC
    // Draw 900 USDC against $1,800 collateral value -> 50% LTV (5,000 bps) <= 7,000 bps (Healthy)
    let draw_amount = 900 * PRICE_SCALE;
    let borrower_wallet = Address::generate(&h.env);
    h.credit_line
        .draw(&h.borrower, &line_id, &draw_amount, &borrower_wallet);
    assert_eq!(h.usdc.balance(&borrower_wallet), draw_amount);
    assert_eq!(h.credit_line.line(&line_id).drawn, draw_amount);

    // 5. Release (allowed)
    // Release 100 units of RWA:
    // Remaining units = 900. Value = 900 * $2.00 * 0.90 = $1,620.
    // LTV = 900 / 1620 = 55.55% (5,555 bps) <= 7,000 bps (Healthy).
    let allowed_release_units = 100 * PRICE_SCALE;
    h.pledge_vault
        .release(&h.borrower, &line_id, &h.rwa_id, &allowed_release_units);

    assert_eq!(
        h.pledge_vault.position_units(&line_id, &h.rwa_id),
        900 * PRICE_SCALE
    );
    assert_eq!(
        h.credit_line.line(&line_id).pledged_units,
        900 * PRICE_SCALE
    );
    assert_eq!(h.rwa.balance(&h.borrower), allowed_release_units);
    assert_eq!(h.rwa.balance(&h.pledge_vault.address), 900 * PRICE_SCALE);

    // 6. Release (refused)
    // Attempting to release 500 units of RWA:
    // Remaining units = 400. Value = 400 * $2.00 * 0.90 = $720.
    // Debt = $900 -> LTV = 125% (> 7,000 bps Warning / 8,000 bps MarginCall).
    // PledgeVault cross-calls CreditLine::ltv and reverts!
    let refused_release_units = 500 * PRICE_SCALE;
    let refused_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.pledge_vault
            .release(&h.borrower, &line_id, &h.rwa_id, &refused_release_units);
    }));
    assert!(
        refused_res.is_err(),
        "release pushing LTV past warning threshold must be refused"
    );

    // Confirm balances and positions are unchanged after refused release
    assert_eq!(
        h.pledge_vault.position_units(&line_id, &h.rwa_id),
        900 * PRICE_SCALE
    );
    assert_eq!(
        h.credit_line.line(&line_id).pledged_units,
        900 * PRICE_SCALE
    );

    // 7. Poke and Liquidate
    // Drop price to $1.00:
    // Collateral value = 900 * $1.00 * 0.90 = $810.
    // Debt = $900 -> LTV = 11,111 bps (> 9,000 bps Liquidation threshold).
    h.price_guard.set_price(&(1 * PRICE_SCALE), &PriceStatus::Ok);

    let state = h.credit_line.poke(&line_id);
    assert_eq!(state, MarginState::Liquidation);

    // Liquidation requires a later ledger than the flagged breach
    let early_liq = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.credit_line
            .liquidate(&h.keeper, &line_id, &LiquidationRoute::Transfer);
    }));
    assert!(
        early_liq.is_err(),
        "liquidation on the same ledger as breach must fail"
    );

    // Advance sequence number to satisfy two-ledger breach confirmation
    let cur_seq = h.env.ledger().sequence();
    h.env.ledger().set_sequence_number(cur_seq + 1);

    h.credit_line
        .liquidate(&h.keeper, &line_id, &LiquidationRoute::Transfer);
    let liq_line = h.credit_line.line(&line_id);
    assert_eq!(liq_line.status, LineStatus::Liquidating);

    let record = h.credit_line.liquidation_record(&line_id);
    assert_eq!(record.seized_units, 900 * PRICE_SCALE);
    assert_eq!(record.price, 1 * PRICE_SCALE);
    assert_eq!(record.debt, 900 * PRICE_SCALE);
    assert!(!record.closed);

    // 8. PledgeVault::liquidate
    // Keeper moves all 900 units of collateral to lender in kind
    h.pledge_vault.liquidate(
        &h.keeper,
        &line_id,
        &h.rwa_id,
        &(900 * PRICE_SCALE),
        &h.lender,
    );
    assert_eq!(h.rwa.balance(&h.lender), 900 * PRICE_SCALE);
    assert_eq!(h.rwa.balance(&h.pledge_vault.address), 0);
    assert_eq!(h.pledge_vault.position_units(&line_id, &h.rwa_id), 0);
    assert_eq!(h.credit_line.line(&line_id).pledged_units, 0);

    // 9. Close liquidated line
    // Recovered = 900 units * $1.00 = $900. Debt = $900. Surplus = 0, Shortfall = 0.
    h.credit_line.close_liquidated(&h.lender, &line_id);

    let closed_line = h.credit_line.line(&line_id);
    assert_eq!(closed_line.status, LineStatus::Closed);
    assert_eq!(closed_line.drawn, 0);

    let final_record = h.credit_line.liquidation_record(&line_id);
    assert!(final_record.closed);
    assert_eq!(final_record.recovered, 900 * PRICE_SCALE);
    assert_eq!(final_record.surplus, 0);
    assert_eq!(final_record.shortfall, 0);
}

#[test]
fn test_real_credit_line_and_pledge_vault_liquidation_with_surplus() {
    let h = setup_harness();

    let agreement = BytesN::from_array(&h.env, &[2u8; 32]);
    let limit = 5_000 * PRICE_SCALE;
    let line_id = h.credit_line.open(
        &h.lender,
        &h.borrower,
        &h.rwa_id,
        &limit,
        &0,
        &86_400,
        &agreement,
    );

    let fund_amount = 5_000 * PRICE_SCALE;
    h.usdc.mint(&h.lender, &fund_amount);
    h.credit_line.fund(&h.lender, &line_id, &fund_amount);

    let pledge_units = 1_000 * PRICE_SCALE;
    h.rwa.mint(&h.borrower, &pledge_units);
    h.pledge_vault
        .pledge(&h.borrower, &line_id, &h.rwa_id, &pledge_units);

    // Draw 900 USDC
    let borrower_wallet = Address::generate(&h.env);
    h.credit_line
        .draw(&h.borrower, &line_id, &(900 * PRICE_SCALE), &borrower_wallet);

    // Price drops to $0.95:
    // Collateral value = 1,000 * $0.95 * 0.90 = $855.
    // Debt = $900 -> LTV = 900 / 855 = 105% (> 9,000 bps Liquidation threshold).
    let breach_price = (95 * PRICE_SCALE) / 100;
    h.price_guard.set_price(&breach_price, &PriceStatus::Ok);

    h.credit_line.poke(&line_id);
    let cur_seq = h.env.ledger().sequence();
    h.env.ledger().set_sequence_number(cur_seq + 1);

    h.credit_line
        .liquidate(&h.keeper, &line_id, &LiquidationRoute::Transfer);

    // Deliver all collateral to lender
    h.pledge_vault.liquidate(
        &h.keeper,
        &line_id,
        &h.rwa_id,
        &pledge_units,
        &h.lender,
    );

    // Close liquidated:
    // Recovered = 1,000 units * $0.95 = $950.
    // Debt = $900.
    // Surplus = $50 ($950 - $900), which lender pays to borrower in USDC!
    let borrower_usdc_before = h.usdc.balance(&h.borrower);
    h.usdc.mint(&h.lender, &(50 * PRICE_SCALE)); // Ensure lender has USDC for surplus payout
    h.credit_line.close_liquidated(&h.lender, &line_id);

    let borrower_usdc_after = h.usdc.balance(&h.borrower);
    assert_eq!(
        borrower_usdc_after - borrower_usdc_before,
        50 * PRICE_SCALE,
        "lender must pay surplus to borrower in USDC upon close_liquidated"
    );

    let record = h.credit_line.liquidation_record(&line_id);
    assert!(record.closed);
    assert_eq!(record.surplus, 50 * PRICE_SCALE);
    assert_eq!(record.shortfall, 0);
}
