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
/// Rounding: both fixed-point divisions (`/ PRICE_SCALE` and `/ BPS_DENOMINATOR`) truncate
/// toward zero (rounding down for non-negative inputs), so `collateral_value` never rounds up
/// and never overstates collateral value.
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

    #[test]
    fn collateral_value_applies_haircut() {
        // 1,000 units @ $1.00, 5% haircut -> $950.00
        let v = collateral_value(1_000 * PRICE_SCALE, PRICE_SCALE, 500);
        assert_eq!(v, 950 * PRICE_SCALE);
    }

    #[test]
    fn collateral_value_rounds_down_on_non_round_inputs() {
        // Hand-computed table of (units, price, haircut_bps, expected):
        // 1. Zero units: 0 * 10_000_000 / 10_000_000 = 0 -> 0.
        // 2. Zero price: (1_000 * 10_000_000) * 0 / 10_000_000 = 0 -> 0.
        // 3. Sub-unit gross truncation: units = 1, price = PRICE_SCALE - 1 (9_999_999), haircut = 0:
        //    gross = 9_999_999 / 10_000_000 = 0 (exact rational 0.9999999 rounds down to 0).
        // 4. Non-round gross product: units = PRICE_SCALE + 1 (10_000_001), price = PRICE_SCALE - 1 (9_999_999), haircut = 0:
        //    gross = 99_999_999_999_999 / 10_000_000 = 9_999_999 (exact 9_999_999.9999999 rounds down).
        // 5. Odd haircut 333 bps on 1 unit (PRICE_SCALE) @ $1.00 (PRICE_SCALE):
        //    gross = 10_000_000; 10_000_000 * (10_000 - 333) / 10_000 = 9_667_000.
        // 6. Odd haircut 333 bps on 3 stroops @ $1.00:
        //    gross = 3; 3 * 9_667 / 10_000 = 29_001 / 10_000 = 2 (exact rational 2.9001 rounds down to 2).
        // 7. Two-stage truncation: units = 7, price = PRICE_SCALE + 3 (10_000_003), haircut = 333 bps:
        //    gross = 70_000_021 / 10_000_000 = 7; 7 * 9_667 / 10_000 = 67_669 / 10_000 = 6.
        let cases: [(i128, i128, u32, i128); 7] = [
            (0, PRICE_SCALE, 500, 0),
            (1_000 * PRICE_SCALE, 0, 500, 0),
            (1, PRICE_SCALE - 1, 0, 0),
            (PRICE_SCALE + 1, PRICE_SCALE - 1, 0, 9_999_999),
            (PRICE_SCALE, PRICE_SCALE, 333, 9_667_000),
            (3, PRICE_SCALE, 333, 2),
            (7, PRICE_SCALE + 3, 333, 6),
        ];

        for (units, price, haircut, expected) in cases {
            let result = collateral_value(units, price, haircut);
            assert_eq!(result, expected);
            assert!(
                result * PRICE_SCALE * 10_000 <= units * price * (10_000 - haircut as i128),
                "collateral_value must never exceed exact rational value"
            );
        }

        // Strict inequality check proving truncation never rounds up on 2.9001 -> 2:
        let non_round = collateral_value(3, PRICE_SCALE, 333);
        assert!(non_round * PRICE_SCALE * 10_000 < 3 * PRICE_SCALE * (10_000 - 333));
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
}
