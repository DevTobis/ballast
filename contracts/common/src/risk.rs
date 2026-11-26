//! Collateral value, haircut, and LTV math (PRD §6.4). Shared so `CreditLine`, `PledgeVault`,
//! `ExitDesk`, and `RepoDvP` can never disagree on what a position is worth.

use crate::price::PRICE_SCALE;

pub const BPS_DENOMINATOR: i128 = 10_000;

/// `collateral_value = units * guarded_price * (1 - haircut)`.
///
/// `units` and `guarded_price` are 7-decimal fixed point (see [`crate::price::PRICE_SCALE`]);
/// `haircut_bps` is basis points out of 10,000 and is the *total* haircut (base + liquidity +
/// FX + concentration add-ons, already summed by the caller per PRD §6.4).
///
/// Rounding: always down, never up. The value is computed in two steps, each an integer division
/// that truncates toward zero: `gross = units * guarded_price / PRICE_SCALE`, then
/// `gross * (10_000 - haircut_bps) / 10_000`. For non-negative inputs each truncation can only
/// lower the result, so it is never above the exact rational value
/// `units * guarded_price * (10_000 - haircut_bps) / (PRICE_SCALE * 10_000)`, and collateral is
/// never over-valued (`CreditLine`, `PledgeVault` and `RepoDvP` all value positions with this).
pub fn collateral_value(units: i128, guarded_price: i128, haircut_bps: u32) -> i128 {
    // configure_asset validates this upfront; this assert is defence-in-depth.
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

/// Panics unless `haircut_bps` is at most 100% ([`BPS_DENOMINATOR`]).
///
/// [`collateral_value`] makes the same check, but only when a position is valued, which is after
/// the asset's config has been stored: a haircut above 100% would be accepted and would then make
/// every later valuation of that asset panic. A contract calls this where the haircut is
/// configured, so a value that cannot be used is refused up front, and every contract that takes
/// a haircut refuses the same inputs with the same message.
pub fn validate_haircut_bps(haircut_bps: u32) {
    assert!(
        haircut_bps as i128 <= BPS_DENOMINATOR,
        "risk: haircut_bps cannot exceed 10000 bps (100%)"
    );
}

#[cfg(test)]
mod test {
    use super::*;

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

    // --- collateral_value haircut boundaries (issue #118) --------------------------------------
    // The 10_000 bps -> 0 boundary is asserted in
    // `a_validated_haircut_never_makes_collateral_value_panic` below.

    #[test]
    fn collateral_value_haircut_zero_returns_gross() {
        let units = 1_000 * PRICE_SCALE;
        let price = PRICE_SCALE;
        let v = collateral_value(units, price, 0);
        assert_eq!(v, 1_000 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "haircut exceeds 100%")]
    fn collateral_value_haircut_10_001_panics() {
        let units = 1_000 * PRICE_SCALE;
        let price = PRICE_SCALE;
        collateral_value(units, price, 10_001);
    }

    // --- collateral_value rounding (issue #119) -----------------------------------------------
    #[test]
    fn collateral_value_rounding_with_non_round_inputs() {
        // Table of (units, price, haircut_bps, expected)
        // Hand calculations:
        // Formula: gross = (units * price) / PRICE_SCALE; result = (gross * (10_000 - haircut_bps)) / 10_000
        // PRICE_SCALE = 10_000_000
        //
        // Row 1: zero units
        // units = 0, price = PRICE_SCALE, haircut = 500
        // gross = 0 / 10_000_000 = 0; result = 0 * 9500 / 10_000 = 0
        //
        // Row 2: zero price
        // units = 1_000 * PRICE_SCALE, price = 0, haircut = 500
        // gross = 0 / 10_000_000 = 0; result = 0 * 9500 / 10_000 = 0
        //
        // Row 3: minimal unit with price just below 1 scale
        // units = 1, price = PRICE_SCALE - 1 (9_999_999), haircut = 0
        // gross = (1 * 9_999_999) / 10_000_000 = 0; result = 0 * 10_000 / 10_000 = 0
        // Exact rational: 9_999_999 / 10_000_000 = 0.9999999. Result 0 <= exact.
        //
        // Row 4: minimal unit with 1 scale and odd haircut (333 bps)
        // units = 1, price = PRICE_SCALE, haircut = 333
        // gross = 10_000_000 / 10_000_000 = 1; result = (1 * 9667) / 10_000 = 0
        // Exact rational: 0.9667. Result 0 <= exact.
        //
        // Row 5: 3 units with odd haircut (333 bps)
        // units = 3, price = PRICE_SCALE, haircut = 333
        // gross = 30_000_000 / 10_000_000 = 3; result = (3 * 9667) / 10_000 = 29001 / 10_000 = 2
        // Exact rational: 2.9001. Result 2 <= exact.
        //
        // Row 6: 10_000 units with non-round price (PRICE_SCALE - 1) and odd haircut (333 bps)
        // units = 10_000, price = 9_999_999, haircut = 333
        // gross = (10_000 * 9_999_999) / 10_000_000 = 99_999_990_000 / 10_000_000 = 9999
        // result = (9999 * 9667) / 10_000 = 96_660_333 / 10_000 = 9666
        // Exact rational: (10_000 * 9_999_999 / 10_000_000) * (9667 / 10_000) = 9999.999 * 0.9667 = 9666.9990333
        // Result 9666 <= 9666.9990333, proving result never exceeds exact rational value.
        //
        // Row 7: larger volume with odd haircut
        // units = 100 * PRICE_SCALE, price = PRICE_SCALE, haircut = 333
        // gross = 1_000_000_000; result = (1_000_000_000 * 9667) / 10_000 = 966_700_000
        let test_cases = [
            (0i128, PRICE_SCALE, 500u32, 0i128),
            (1_000 * PRICE_SCALE, 0i128, 500u32, 0i128),
            (1i128, PRICE_SCALE - 1, 0u32, 0i128),
            (1i128, PRICE_SCALE, 333u32, 0i128),
            (3i128, PRICE_SCALE, 333u32, 2i128),
            (10_000i128, PRICE_SCALE - 1, 333u32, 9_666i128),
            (100 * PRICE_SCALE, PRICE_SCALE, 333u32, 966_700_000i128),
        ];

        for (units, price, haircut_bps, expected) in test_cases {
            let result = collateral_value(units, price, haircut_bps);
            assert_eq!(
                result, expected,
                "Mismatch for units={units}, price={price}, haircut={haircut_bps}"
            );

            // Property assertion: result * PRICE_SCALE * 10_000 <= units * price * (10_000 - haircut)
            // Proves result never exceeds the exact rational value.
            let lhs = result * PRICE_SCALE * BPS_DENOMINATOR;
            let rhs = units * price * (BPS_DENOMINATOR - haircut_bps as i128);
            assert!(
                lhs <= rhs,
                "Result exceeds exact rational value: {lhs} > {rhs} for units={units}, price={price}, haircut={haircut_bps}"
            );
        }
    }

    #[test]
    fn validate_haircut_bps_accepts_zero_up_to_exactly_one_hundred_percent() {
        validate_haircut_bps(0);
        validate_haircut_bps(500);
        validate_haircut_bps(10_000);
    }

    #[test]
    #[should_panic(expected = "risk: haircut_bps cannot exceed 10000 bps (100%)")]
    fn validate_haircut_bps_rejects_one_bp_over_one_hundred_percent() {
        validate_haircut_bps(10_001);
    }

    #[test]
    #[should_panic(expected = "risk: haircut_bps cannot exceed 10000 bps (100%)")]
    fn validate_haircut_bps_rejects_the_largest_u32() {
        validate_haircut_bps(u32::MAX);
    }

    /// The point of validating up front: whatever passes can always be valued later.
    #[test]
    fn a_validated_haircut_never_makes_collateral_value_panic() {
        for haircut_bps in [0, 1, 5_000, 9_999, 10_000] {
            validate_haircut_bps(haircut_bps);
            assert!(collateral_value(1_000 * PRICE_SCALE, PRICE_SCALE, haircut_bps) >= 0);
        }
        // A 100% haircut is the edge of what is usable: the position is worth nothing.
        assert_eq!(
            collateral_value(1_000 * PRICE_SCALE, PRICE_SCALE, 10_000),
            0
        );
    }

    // --- property tests (issue #87) -----------------------------------------------------------

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        #[test]
        fn prop_collateral_value_monotonicity(
            u1 in 0i128..=10_000_000_000_000_000i128,
            u2 in 0i128..=10_000_000_000_000_000i128,
            p1 in 0i128..=10_000_000_000_000_000i128,
            p2 in 0i128..=10_000_000_000_000_000i128,
            h1 in 0u32..=10_000u32,
            h2 in 0u32..=10_000u32,
        ) {
            let (min_u, max_u) = if u1 <= u2 { (u1, u2) } else { (u2, u1) };
            let (min_p, max_p) = if p1 <= p2 { (p1, p2) } else { (p2, p1) };
            let (min_h, max_h) = if h1 <= h2 { (h1, h2) } else { (h2, h1) };

            // Non-decreasing in units: u1 <= u2 => cv(u1, p, h) <= cv(u2, p, h)
            prop_assert!(collateral_value(min_u, p1, h1) <= collateral_value(max_u, p1, h1));

            // Non-decreasing in price: p1 <= p2 => cv(u, p1, h) <= cv(u, p2, h)
            prop_assert!(collateral_value(u1, min_p, h1) <= collateral_value(u1, max_p, h1));

            // Non-increasing in haircut: h1 <= h2 => cv(u, p, h1) >= cv(u, p, h2)
            prop_assert!(collateral_value(u1, p1, min_h) >= collateral_value(u1, p1, max_h));
        }

        #[test]
        fn prop_ltv_bps_monotonicity(
            d1 in 0i128..=10_000_000_000_000_000i128,
            d2 in 0i128..=10_000_000_000_000_000i128,
            c1 in 0i128..=10_000_000_000_000_000i128,
            c2 in 0i128..=10_000_000_000_000_000i128,
        ) {
            let (min_d, max_d) = if d1 <= d2 { (d1, d2) } else { (d2, d1) };
            let (min_c, max_c) = if c1 <= c2 { (c1, c2) } else { (c2, c1) };

            // Non-decreasing in debt: d1 <= d2 => ltv(d1, c) <= ltv(d2, c)
            prop_assert!(ltv_bps(min_d, c1) <= ltv_bps(max_d, c1));

            // Non-increasing in collateral value: c1 <= c2 => ltv(d, c1) >= ltv(d, c2)
            prop_assert!(ltv_bps(d1, min_c) >= ltv_bps(d1, max_c));
        }

        #[test]
        fn prop_collateral_value_upper_bounded_by_gross(
            units in 0i128..=10_000_000_000_000_000i128,
            guarded_price in 0i128..=10_000_000_000_000_000i128,
            haircut_bps in 0u32..=10_000u32,
        ) {
            let gross = (units * guarded_price) / PRICE_SCALE;
            let cv = collateral_value(units, guarded_price, haircut_bps);
            prop_assert!(cv <= gross);
        }

        #[test]
        fn prop_ltv_bps_never_panics_below_1e30(
            debt in 0i128..=1_000_000_000_000_000_000_000_000_000_000i128,
            collateral_value in 0i128..=1_000_000_000_000_000_000_000_000_000_000i128,
        ) {
            let ltv = ltv_bps(debt, collateral_value);
            prop_assert!(ltv <= u32::MAX);
        }
    }
}
