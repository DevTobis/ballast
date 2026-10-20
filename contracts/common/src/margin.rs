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

#[contracttype]
#[derive(Clone, Debug)]
pub struct MarginThresholds {
    pub warning_bps: u32,
    pub margin_call_bps: u32,
    pub liquidation_bps: u32,
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

pub fn validate_thresholds(thresholds: &MarginThresholds) {
    assert!(
        thresholds.warning_bps > 0
            && thresholds.warning_bps <= thresholds.margin_call_bps
            && thresholds.margin_call_bps <= thresholds.liquidation_bps
            && thresholds.liquidation_bps <= 10_000,
        "margin: invalid thresholds (must satisfy 0 < warning <= margin_call <= liquidation <= 10000)"
    );
}

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
    fn validates_valid_thresholds() {
        let t = thresholds();
        validate_thresholds(&t);

        // Equal thresholds are valid
        validate_thresholds(&MarginThresholds {
            warning_bps: 8_000,
            margin_call_bps: 8_000,
            liquidation_bps: 8_000,
        });

        // Max liquidation 10_000
        validate_thresholds(&MarginThresholds {
            warning_bps: 1,
            margin_call_bps: 5_000,
            liquidation_bps: 10_000,
        });
    }

    #[test]
    #[should_panic(expected = "margin: invalid thresholds")]
    fn validates_zero_warning_panics() {
        validate_thresholds(&MarginThresholds {
            warning_bps: 0,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        });
    }

    #[test]
    #[should_panic(expected = "margin: invalid thresholds")]
    fn validates_warning_greater_than_margin_call_panics() {
        validate_thresholds(&MarginThresholds {
            warning_bps: 8_500,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        });
    }

    #[test]
    #[should_panic(expected = "margin: invalid thresholds")]
    fn validates_margin_call_greater_than_liquidation_panics() {
        validate_thresholds(&MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 9_500,
            liquidation_bps: 9_000,
        });
    }

    #[test]
    #[should_panic(expected = "margin: invalid thresholds")]
    fn validates_liquidation_greater_than_10000_panics() {
        validate_thresholds(&MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 10_001,
        });
    }
}
