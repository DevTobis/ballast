//! Collateral value, haircut, and LTV math (PRD §6.4). Shared so `CreditLine`, `PledgeVault`,
//! `ExitDesk`, and `RepoDvP` can never disagree on what a position is worth.

use crate::price::PRICE_SCALE;

pub const BPS_DENOMINATOR: i128 = 10_000;

/// `collateral_value = units * guarded_price * (1 - haircut)`.
///
/// `units` and `guarded_price` are 7-decimal fixed point (see [`crate::price::PRICE_SCALE`]);
/// `haircut_bps` is basis points out of 10,000 and is the *total* haircut (base + liquidity +
/// FX + concentration add-ons, already summed by the caller per PRD §6.4).
pub fn collateral_value(units: i128, guarded_price: i128, haircut_bps: u32) -> i128 {
    assert!(
        haircut_bps as i128 <= BPS_DENOMINATOR,
        "haircut exceeds 100%"
    );
    let gross = units
        .checked_mul(guarded_price)
        .expect("collateral_value: overflow")
        / PRICE_SCALE;
    gross
        .checked_mul(BPS_DENOMINATOR - haircut_bps as i128)
        .expect("collateral_value: overflow")
        / BPS_DENOMINATOR
}

/// `ltv_bps = debt / collateral_value`, in basis points. A zero or negative collateral value
/// against outstanding debt is always maximally unhealthy, never a divide-by-zero.
pub fn ltv_bps(debt: i128, collateral_value: i128) -> u32 {
    if debt <= 0 {
        return 0;
    }
    if collateral_value <= 0 {
        return u32::MAX;
    }
    let bps = debt
        .checked_mul(BPS_DENOMINATOR)
        .expect("ltv_bps: overflow")
        / collateral_value;
    bps.clamp(0, u32::MAX as i128) as u32
}

#[cfg(test)]
mod test {
    use super::*;
    use proptest::prelude::*;

    const MAX_PROPTEST_UNITS: i128 = 1_000_000_000_000_000_000; // 1e18 (100B units @ 7 decimals)
    const MAX_PROPTEST_PRICE: i128 = 1_000_000_000_000_000; // 1e15 ($100M @ 7 decimals)
    const MAX_LTV_INPUT: i128 = 1_000_000_000_000_000_000_000_000_000_000; // 1e30

    #[test]
    fn collateral_value_applies_haircut() {
        // 1,000 units @ $1.00, 5% haircut -> $950.00
        let v = collateral_value(1_000 * PRICE_SCALE, PRICE_SCALE, 500);
        assert_eq!(v, 950 * PRICE_SCALE);
    }

    #[test]
    fn ltv_bps_computes_ratio() {
        // $500 debt against $950 collateral -> 5263 bps (~52.6%)
        let ltv = ltv_bps(500 * PRICE_SCALE, 950 * PRICE_SCALE);
        assert_eq!(ltv, 5263);
    }

    #[test]
    fn ltv_bps_zero_collateral_is_max() {
        assert_eq!(ltv_bps(1, 0), u32::MAX);
        assert_eq!(ltv_bps(0, 0), 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 256,
            ..ProptestConfig::default()
        })]

        #[test]
        fn prop_collateral_value_monotonic_in_units_and_price(
            u1 in 0i128..=MAX_PROPTEST_UNITS,
            u_delta in 0i128..=MAX_PROPTEST_UNITS,
            p1 in 0i128..=MAX_PROPTEST_PRICE,
            p_delta in 0i128..=MAX_PROPTEST_PRICE,
            haircut_bps in 0u32..=10_000u32,
        ) {
            let u2 = u1.saturating_add(u_delta).min(MAX_PROPTEST_UNITS);
            let p2 = p1.saturating_add(p_delta).min(MAX_PROPTEST_PRICE);

            let v_u1 = collateral_value(u1, p1, haircut_bps);
            let v_u2 = collateral_value(u2, p1, haircut_bps);
            prop_assert!(
                v_u1 <= v_u2,
                "collateral_value must be non-decreasing in units: {} > {} for u1={}, u2={}, p={}, h={}",
                v_u1, v_u2, u1, u2, p1, haircut_bps
            );

            let v_p2 = collateral_value(u1, p2, haircut_bps);
            prop_assert!(
                v_u1 <= v_p2,
                "collateral_value must be non-decreasing in guarded_price: {} > {} for u={}, p1={}, p2={}, h={}",
                v_u1, v_p2, u1, p1, p2, haircut_bps
            );
        }

        #[test]
        fn prop_collateral_value_non_increasing_in_haircut_and_bounded_by_gross(
            units in 0i128..=MAX_PROPTEST_UNITS,
            price in 0i128..=MAX_PROPTEST_PRICE,
            h1 in 0u32..=10_000u32,
            h_delta in 0u32..=10_000u32,
        ) {
            let h2 = h1.saturating_add(h_delta).min(10_000);

            let v1 = collateral_value(units, price, h1);
            let v2 = collateral_value(units, price, h2);
            prop_assert!(
                v1 >= v2,
                "collateral_value must be non-increasing in haircut_bps: {} < {} for h1={}, h2={}",
                v1, v2, h1, h2
            );

            let gross = if units <= 0 || price <= 0 {
                0
            } else {
                (units * price) / PRICE_SCALE
            };
            prop_assert!(
                v1 <= gross,
                "collateral_value({}, {}, {}) = {} exceeds gross {}",
                units, price, h1, v1, gross
            );
        }

        #[test]
        fn prop_ltv_bps_monotonic_and_no_panic_below_1e30(
            d1 in 0i128..MAX_LTV_INPUT,
            d_delta in 0i128..MAX_LTV_INPUT,
            c1 in 0i128..MAX_LTV_INPUT,
            c_delta in 0i128..MAX_LTV_INPUT,
        ) {
            let d2 = d1.saturating_add(d_delta).min(MAX_LTV_INPUT - 1);
            let c2 = c1.saturating_add(c_delta).min(MAX_LTV_INPUT - 1);

            let ltv_d1_c1 = ltv_bps(d1, c1);
            let ltv_d2_c1 = ltv_bps(d2, c1);
            prop_assert!(
                ltv_d1_c1 <= ltv_d2_c1,
                "ltv_bps must be non-decreasing in debt: {} > {} for d1={}, d2={}, c={}",
                ltv_d1_c1, ltv_d2_c1, d1, d2, c1
            );

            let ltv_d1_c2 = ltv_bps(d1, c2);
            prop_assert!(
                ltv_d1_c1 >= ltv_d1_c2,
                "ltv_bps must be non-increasing in collateral_value: {} < {} for d={}, c1={}, c2={}",
                ltv_d1_c1, ltv_d1_c2, d1, c1, c2
            );
        }
    }
}
