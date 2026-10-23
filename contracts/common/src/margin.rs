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

impl MarginThresholds {
    /// Asserts thresholds are strictly positive, ordered, and within 100% (10,000 bps).
    /// Enforces: 0 < warning_bps <= margin_call_bps <= liquidation_bps <= 10_000.
    pub fn validate(&self) {
        assert!(
            self.warning_bps > 0,
            "margin: warning_bps must be greater than zero"
        );
        assert!(
            self.warning_bps <= self.margin_call_bps,
            "margin: warning_bps cannot exceed margin_call_bps"
        );
        assert!(
            self.margin_call_bps <= self.liquidation_bps,
            "margin: margin_call_bps cannot exceed liquidation_bps"
        );
        assert!(
            self.liquidation_bps <= 10_000,
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
    fn validates_healthy_thresholds() {
        thresholds().validate();

        // Edge case: equal boundaries are allowed
        MarginThresholds {
            warning_bps: 8_000,
            margin_call_bps: 8_000,
            liquidation_bps: 8_000,
        }
        .validate();

        // Maximum boundary 10_000 bps
        MarginThresholds {
            warning_bps: 1,
            margin_call_bps: 5_000,
            liquidation_bps: 10_000,
        }
        .validate();
    }

    #[test]
    #[should_panic(expected = "margin: warning_bps must be greater than zero")]
    fn rejects_zero_warning_bps() {
        MarginThresholds {
            warning_bps: 0,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    #[test]
    #[should_panic(expected = "margin: warning_bps cannot exceed margin_call_bps")]
    fn rejects_warning_exceeding_margin_call() {
        MarginThresholds {
            warning_bps: 8_500,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    #[test]
    #[should_panic(expected = "margin: margin_call_bps cannot exceed liquidation_bps")]
    fn rejects_margin_call_exceeding_liquidation() {
        MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 9_500,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    #[test]
    #[should_panic(expected = "margin: liquidation_bps cannot exceed 10000 bps (100%)")]
    fn rejects_liquidation_exceeding_10000() {
        MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 10_001,
        }
        .validate();
    }
}
