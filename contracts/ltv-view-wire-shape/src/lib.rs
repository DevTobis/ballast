//! Wire-shape verification test suite for `LtvView`.
//!
//! Asserts that `ballast_credit_line::LtvView` and `ballast_pledge_vault::LtvView`
//! serialize to identical `ScVal` wire representations across all `MarginState` and
//! `PriceStatus` enum variant combinations.

#[doc(hidden)]
pub use ballast_credit_line as _credit_line;
#[doc(hidden)]
pub use ballast_pledge_vault as _pledge_vault;

#[cfg(test)]
mod tests {
    use ballast_common::{margin::MarginState, price::PriceStatus};
    use soroban_sdk::{xdr::ScVal, Env, IntoVal, TryFromVal, Val};

    fn assert_wire_shape_eq(env: &Env, state: MarginState, status: PriceStatus) {
        let cl = ballast_credit_line::LtvView {
            debt: 123_456_789,
            collateral_value: 987_654_321,
            ltv_bps: 1250,
            state: state.clone(),
            price_status: status.clone(),
        };
        let pv = ballast_pledge_vault::LtvView {
            debt: 123_456_789,
            collateral_value: 987_654_321,
            ltv_bps: 1250,
            state: state.clone(),
            price_status: status.clone(),
        };

        let cl_raw: Val = cl.into_val(env);
        let pv_raw: Val = pv.into_val(env);

        let cl_val =
            ScVal::try_from_val(env, &cl_raw).expect("valid ScVal for credit_line LtvView");
        let pv_val =
            ScVal::try_from_val(env, &pv_raw).expect("valid ScVal for pledge_vault LtvView");

        assert_eq!(
            cl_val, pv_val,
            "LtvView wire shape mismatch between \
            ballast_credit_line::LtvView (credit-line/src/lib.rs:72) and \
            ballast_pledge_vault::LtvView (pledge-vault/src/lib.rs:85) \
            for state={:?} status={:?}",
            state, status
        );
    }

    macro_rules! generate_wire_shape_test {
        ($test_name:ident, $state:expr, $status:expr) => {
            #[test]
            fn $test_name() {
                let env = Env::default();
                assert_wire_shape_eq(&env, $state, $status);
            }
        };
    }

    // 4 MarginState variants × 3 PriceStatus variants = 12 total test cases:
    generate_wire_shape_test!(
        test_wire_shape_healthy_ok,
        MarginState::Healthy,
        PriceStatus::Ok
    );
    generate_wire_shape_test!(
        test_wire_shape_healthy_degraded,
        MarginState::Healthy,
        PriceStatus::Degraded
    );
    generate_wire_shape_test!(
        test_wire_shape_healthy_halted,
        MarginState::Healthy,
        PriceStatus::Halted
    );

    generate_wire_shape_test!(
        test_wire_shape_warning_ok,
        MarginState::Warning,
        PriceStatus::Ok
    );
    generate_wire_shape_test!(
        test_wire_shape_warning_degraded,
        MarginState::Warning,
        PriceStatus::Degraded
    );
    generate_wire_shape_test!(
        test_wire_shape_warning_halted,
        MarginState::Warning,
        PriceStatus::Halted
    );

    generate_wire_shape_test!(
        test_wire_shape_margin_call_ok,
        MarginState::MarginCall,
        PriceStatus::Ok
    );
    generate_wire_shape_test!(
        test_wire_shape_margin_call_degraded,
        MarginState::MarginCall,
        PriceStatus::Degraded
    );
    generate_wire_shape_test!(
        test_wire_shape_margin_call_halted,
        MarginState::MarginCall,
        PriceStatus::Halted
    );

    generate_wire_shape_test!(
        test_wire_shape_liquidation_ok,
        MarginState::Liquidation,
        PriceStatus::Ok
    );
    generate_wire_shape_test!(
        test_wire_shape_liquidation_degraded,
        MarginState::Liquidation,
        PriceStatus::Degraded
    );
    generate_wire_shape_test!(
        test_wire_shape_liquidation_halted,
        MarginState::Liquidation,
        PriceStatus::Halted
    );

    /// Deliberately mismatched field test demonstrating what a future wire shape
    /// mismatch would look like when the assertion fails.
    ///
    /// Guarded by `#[cfg(feature = "test-mismatch-demo")]` so it does not run in normal CI.
    ///
    /// Running this test with:
    /// `cargo test -p ltv-view-wire-shape --features test-mismatch-demo`
    /// produces the following panic message:
    /// ```text
    /// assertion `left == right` failed: LtvView wire shape mismatch between ballast_credit_line::LtvView (credit-line/src/lib.rs:72) and ballast_pledge_vault::LtvView (pledge-vault/src/lib.rs:85) for state=Healthy status=Ok
    /// ```
    #[test]
    #[cfg(feature = "test-mismatch-demo")]
    fn test_deliberate_mismatched_field_demo() {
        let env = Env::default();
        let state = MarginState::Healthy;
        let status = PriceStatus::Ok;

        let cl = ballast_credit_line::LtvView {
            debt: 100,
            collateral_value: 200,
            ltv_bps: 5000,
            state: state.clone(),
            price_status: status.clone(),
        };
        // Deliberately mismatched debt value (999 vs 100)
        let pv = ballast_pledge_vault::LtvView {
            debt: 999,
            collateral_value: 200,
            ltv_bps: 5000,
            state: state.clone(),
            price_status: status.clone(),
        };

        let cl_raw: Val = cl.into_val(&env);
        let pv_raw: Val = pv.into_val(&env);

        let cl_val =
            ScVal::try_from_val(&env, &cl_raw).expect("valid ScVal for credit_line LtvView");
        let pv_val =
            ScVal::try_from_val(&env, &pv_raw).expect("valid ScVal for pledge_vault LtvView");

        assert_eq!(
            cl_val, pv_val,
            "LtvView wire shape mismatch between \
            ballast_credit_line::LtvView (credit-line/src/lib.rs:72) and \
            ballast_pledge_vault::LtvView (pledge-vault/src/lib.rs:85) \
            for state={:?} status={:?}",
            state, status
        );
    }
}
