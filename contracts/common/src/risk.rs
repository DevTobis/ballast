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
