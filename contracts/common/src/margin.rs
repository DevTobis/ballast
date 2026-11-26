//! The margin state machine shared by `CreditLine` and `RepoDvP` (PRD §5 Phase 1: "healthy /
//! warning / margin call / liquidation").

use soroban_sdk::contracttype;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MarginState {
    Healthy,
    Warning,
    MarginCall,
    Liquidation,
}

/// Highest accepted `liquidation_bps`: an LTV of 100%, where the debt equals the haircut value
/// of the collateral. A higher liquidation threshold would only trigger once the position is
/// already under water, so `validate` refuses it.
pub const MAX_LIQUIDATION_BPS: u32 = 10_000;

// The ceiling panic message below spells the value out because Soroban contracts cannot format
// panic messages; keep the two in step.
const _: () = assert!(MAX_LIQUIDATION_BPS == 10_000);

/// LTV thresholds, in basis points, for the margin state machine (see [`classify`]).
///
/// Valid thresholds satisfy `0 < warning_bps < margin_call_bps < liquidation_bps <=
/// MAX_LIQUIDATION_BPS`, which [`MarginThresholds::validate`] enforces. `CreditLine`,
/// `PledgeVault` and `RepoDvP` each call it in `configure_asset` before storing an asset's
/// thresholds.
#[contracttype]
#[derive(Clone, Debug)]
pub struct MarginThresholds {
    pub warning_bps: u32,
    pub margin_call_bps: u32,
    pub liquidation_bps: u32,
}

impl MarginThresholds {
    /// Panics unless `0 < warning_bps < margin_call_bps < liquidation_bps <= MAX_LIQUIDATION_BPS`.
    ///
    /// Each rule has its own message, checked in this order:
    ///
    /// | Violation | Message |
    /// |---|---|
    /// | `warning_bps == 0` | `margin: warning_bps must be greater than zero` |
    /// | `margin_call_bps == 0` | `margin: margin_call_bps must be greater than zero` |
    /// | `liquidation_bps == 0` | `margin: liquidation_bps must be greater than zero` |
    /// | `warning_bps >= margin_call_bps` | `margin: warning_bps must be below margin_call_bps` |
    /// | `margin_call_bps >= liquidation_bps` | `margin: margin_call_bps must be below liquidation_bps` |
    /// | `liquidation_bps > MAX_LIQUIDATION_BPS` | `margin: liquidation_bps cannot exceed 10000 bps (100%)` |
    ///
    /// Why strict: [`classify`] checks the highest band first, so if `warning_bps` equals
    /// `margin_call_bps` a position goes straight from `Healthy` to `MarginCall` and `Warning` is
    /// never reported, and equal `margin_call_bps` and `liquidation_bps` skip `MarginCall` the same
    /// way. A zero `margin_call_bps` would also trap `RepoDvP::call_margin`, which divides by it
    /// to size the margin call.
    pub fn validate(&self) {
        assert!(
            self.warning_bps > 0,
            "margin: warning_bps must be greater than zero"
        );
        assert!(
            self.margin_call_bps > 0,
            "margin: margin_call_bps must be greater than zero"
        );
        assert!(
            self.liquidation_bps > 0,
            "margin: liquidation_bps must be greater than zero"
        );
        assert!(
            self.warning_bps < self.margin_call_bps,
            "margin: warning_bps must be below margin_call_bps"
        );
        assert!(
            self.margin_call_bps < self.liquidation_bps,
            "margin: margin_call_bps must be below liquidation_bps"
        );
        assert!(
            self.liquidation_bps <= MAX_LIQUIDATION_BPS,
            "margin: liquidation_bps cannot exceed 10000 bps (100%)"
        );
    }
}

/// PRD §8 `LiquidationRoute`: issuer redemption or transfer in kind first, RFQ sale second, AMM
/// never (PRD §6.6 key decision table).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiquidationRoute {
    Redeem,
    Transfer,
    Rfq,
}

/// Maps an LTV to its margin state. Assumes `thresholds` passed [`MarginThresholds::validate`]:
/// with unordered or equal thresholds some states can never be returned.
pub fn classify(ltv_bps: u32, thresholds: &MarginThresholds) -> MarginState {
    if ltv_bps >= thresholds.liquidation_bps {
        MarginState::Liquidation
    } else if ltv_bps >= thresholds.margin_call_bps {
        MarginState::MarginCall
    } else if ltv_bps >= thresholds.warning_bps {
        MarginState::Warning
    } else {
        MarginState::Healthy
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn thresholds() -> MarginThresholds {
        MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        }
    }

    #[test]
    fn classifies_each_band() {
        let t = thresholds();
        assert_eq!(classify(1_000, &t), MarginState::Healthy);
        assert_eq!(classify(7_500, &t), MarginState::Warning);
        assert_eq!(classify(8_500, &t), MarginState::MarginCall);
        assert_eq!(classify(9_500, &t), MarginState::Liquidation);
    }

    #[test]
    fn classifies_at_every_threshold_boundary() {
        let t = thresholds();
        // Thresholds are inclusive on the upper state (`classify` uses `>=`): an LTV exactly at a
        // threshold is already in the higher state, one bp below it is still in the lower one.
        assert_eq!(classify(0, &t), MarginState::Healthy);
        assert_eq!(classify(6_999, &t), MarginState::Healthy);
        assert_eq!(classify(7_000, &t), MarginState::Warning);
        assert_eq!(classify(7_999, &t), MarginState::Warning);
        assert_eq!(classify(8_000, &t), MarginState::MarginCall);
        assert_eq!(classify(8_999, &t), MarginState::MarginCall);
        assert_eq!(classify(9_000, &t), MarginState::Liquidation);
    }

    const WARNING_ZERO: &str = "margin: warning_bps must be greater than zero";
    const MARGIN_CALL_ZERO: &str = "margin: margin_call_bps must be greater than zero";
    const LIQUIDATION_ZERO: &str = "margin: liquidation_bps must be greater than zero";
    const WARNING_NOT_BELOW: &str = "margin: warning_bps must be below margin_call_bps";
    const MARGIN_CALL_NOT_BELOW: &str = "margin: margin_call_bps must be below liquidation_bps";
    const ABOVE_CEILING: &str = "margin: liquidation_bps cannot exceed 10000 bps (100%)";

    fn t(warning_bps: u32, margin_call_bps: u32, liquidation_bps: u32) -> MarginThresholds {
        MarginThresholds {
            warning_bps,
            margin_call_bps,
            liquidation_bps,
        }
    }

    /// Runs `validate` and returns its panic message, or `None` when it accepts the thresholds.
    fn validation_error(thresholds: &MarginThresholds) -> Option<String> {
        let thresholds = thresholds.clone();
        let payload = std::panic::catch_unwind(move || thresholds.validate()).err()?;
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| message.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .expect("validate panicked with a non-string payload");
        Some(message)
    }

    fn valid_cases() -> [(&'static str, MarginThresholds); 4] {
        [
            ("desk default from configure-desks.sh", thresholds()),
            ("smallest strictly increasing", t(1, 2, 3)),
            (
                "liquidation exactly at the ceiling",
                t(9_998, 9_999, MAX_LIQUIDATION_BPS),
            ),
            (
                "wide bands up to the ceiling",
                t(1, 5_000, MAX_LIQUIDATION_BPS),
            ),
        ]
    }

    #[test]
    fn validate_accepts_or_rejects_each_case_with_its_message() {
        let mut cases: Vec<(&str, MarginThresholds, Option<&str>)> = valid_cases()
            .into_iter()
            .map(|(name, thresholds)| (name, thresholds, None))
            .collect();
        cases.extend([
            // zero
            ("warning zero", t(0, 8_000, 9_000), Some(WARNING_ZERO)),
            (
                "margin call zero",
                t(7_000, 0, 9_000),
                Some(MARGIN_CALL_ZERO),
            ),
            (
                "liquidation zero",
                t(7_000, 8_000, 0),
                Some(LIQUIDATION_ZERO),
            ),
            ("all zero", t(0, 0, 0), Some(WARNING_ZERO)),
            // equal
            (
                "warning equals margin call",
                t(8_000, 8_000, 9_000),
                Some(WARNING_NOT_BELOW),
            ),
            (
                "margin call equals liquidation",
                t(7_000, 9_000, 9_000),
                Some(MARGIN_CALL_NOT_BELOW),
            ),
            (
                "all three equal",
                t(8_000, 8_000, 8_000),
                Some(WARNING_NOT_BELOW),
            ),
            // reversed
            (
                "warning above margin call",
                t(9_000, 8_000, 9_500),
                Some(WARNING_NOT_BELOW),
            ),
            (
                "margin call above liquidation",
                t(7_000, 9_500, 9_000),
                Some(MARGIN_CALL_NOT_BELOW),
            ),
            (
                "fully reversed",
                t(9_000, 8_000, 7_000),
                Some(WARNING_NOT_BELOW),
            ),
            // ceiling
            (
                "liquidation one above the ceiling",
                t(7_000, 8_000, 10_001),
                Some(ABOVE_CEILING),
            ),
            (
                "liquidation at u32::MAX",
                t(7_000, 8_000, u32::MAX),
                Some(ABOVE_CEILING),
            ),
        ]);

        for (name, thresholds, expected) in cases {
            assert_eq!(
                validation_error(&thresholds).as_deref(),
                expected,
                "{name}: {thresholds:?}"
            );
        }
    }

    #[test]
    fn each_rule_fails_with_a_distinct_message() {
        let messages: Vec<String> = [
            t(0, 8_000, 9_000),
            t(7_000, 0, 9_000),
            t(7_000, 8_000, 0),
            t(8_000, 8_000, 9_000),
            t(7_000, 9_000, 9_000),
            t(7_000, 8_000, 10_001),
        ]
        .iter()
        .map(|thresholds| validation_error(thresholds).expect("each case breaks one rule"))
        .collect();

        for (i, a) in messages.iter().enumerate() {
            for b in &messages[i + 1..] {
                assert_ne!(a, b, "two rules share a panic message");
            }
        }
    }

    /// The reason for strict ordering: every threshold set that `validate` accepts lets
    /// `classify` report all four states.
    #[test]
    fn accepted_thresholds_reach_every_state() {
        for (name, th) in valid_cases() {
            th.validate();
            assert_eq!(
                classify(th.warning_bps - 1, &th),
                MarginState::Healthy,
                "{name}"
            );
            assert_eq!(
                classify(th.warning_bps, &th),
                MarginState::Warning,
                "{name}"
            );
            assert_eq!(
                classify(th.margin_call_bps, &th),
                MarginState::MarginCall,
                "{name}"
            );
            assert_eq!(
                classify(th.liquidation_bps, &th),
                MarginState::Liquidation,
                "{name}"
            );
        }
    }
}
