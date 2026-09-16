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
}
