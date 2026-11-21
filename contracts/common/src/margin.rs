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

/// Basis-point thresholds that drive the four-state margin machine.
///
/// All three values must be **strictly increasing** and positive so that every
/// state in the machine (`Healthy` → `Warning` → `MarginCall` → `Liquidation`)
/// is reachable.  Equal boundaries would make the lower state unreachable:
/// e.g. `warning_bps == margin_call_bps` means `Warning` can never be entered
/// because `classify` reaches `MarginCall` first.
///
/// The documented ceiling for `liquidation_bps` is **10 000 bps (100 %)**.
/// Values above 100 % are nonsensical for an LTV ratio.
///
/// Call [`MarginThresholds::validate`] on every admin-supplied instance before
/// persisting it to contract storage.
#[contracttype]
#[derive(Clone, Debug)]
pub struct MarginThresholds {
    pub warning_bps: u32,
    pub margin_call_bps: u32,
    pub liquidation_bps: u32,
}

impl MarginThresholds {
    /// Validates that the thresholds are well-formed.
    ///
    /// Panics with a distinct message for each violation:
    ///
    /// | Condition violated | panic message |
    /// |---|---|
    /// | `warning_bps == 0` | `"margin: warning_bps must be greater than zero"` |
    /// | `warning_bps >= margin_call_bps` | `"margin: warning_bps must be less than margin_call_bps"` |
    /// | `margin_call_bps >= liquidation_bps` | `"margin: margin_call_bps must be less than liquidation_bps"` |
    /// | `liquidation_bps > 10_000` | `"margin: liquidation_bps cannot exceed 10000 bps (100%)"` |
    ///
    /// Enforces: `0 < warning_bps < margin_call_bps < liquidation_bps <= 10_000`.
    pub fn validate(&self) {
        assert!(
            self.warning_bps > 0,
            "margin: warning_bps must be greater than zero"
        );
        assert!(
            self.warning_bps < self.margin_call_bps,
            "margin: warning_bps must be less than margin_call_bps"
        );
        assert!(
            self.margin_call_bps < self.liquidation_bps,
            "margin: margin_call_bps must be less than liquidation_bps"
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

    // ── validate() – valid inputs ────────────────────────────────────────────

    #[test]
    fn validates_healthy_thresholds() {
        // Typical strictly-increasing config.
        thresholds().validate();

        // Minimum boundary: warning_bps = 1.
        MarginThresholds {
            warning_bps: 1,
            margin_call_bps: 2,
            liquidation_bps: 3,
        }
        .validate();

        // Maximum boundary: liquidation_bps = 10_000 bps.
        MarginThresholds {
            warning_bps: 1,
            margin_call_bps: 5_000,
            liquidation_bps: 10_000,
        }
        .validate();
    }

    // ── validate() – zero ────────────────────────────────────────────────────

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

    // ── validate() – equal (each pair) ──────────────────────────────────────

    /// Equal `warning_bps` and `margin_call_bps` make `Warning` unreachable.
    #[test]
    #[should_panic(expected = "margin: warning_bps must be less than margin_call_bps")]
    fn rejects_warning_equal_to_margin_call() {
        MarginThresholds {
            warning_bps: 8_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    /// Equal `margin_call_bps` and `liquidation_bps` make `MarginCall` unreachable.
    #[test]
    #[should_panic(expected = "margin: margin_call_bps must be less than liquidation_bps")]
    fn rejects_margin_call_equal_to_liquidation() {
        MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 9_000,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    /// All three equal – first failing check is warning vs margin_call.
    #[test]
    #[should_panic(expected = "margin: warning_bps must be less than margin_call_bps")]
    fn rejects_all_equal() {
        MarginThresholds {
            warning_bps: 8_000,
            margin_call_bps: 8_000,
            liquidation_bps: 8_000,
        }
        .validate();
    }

    // ── validate() – reversed ────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "margin: warning_bps must be less than margin_call_bps")]
    fn rejects_warning_exceeding_margin_call() {
        MarginThresholds {
            warning_bps: 8_500,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    #[test]
    #[should_panic(expected = "margin: margin_call_bps must be less than liquidation_bps")]
    fn rejects_margin_call_exceeding_liquidation() {
        MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 9_500,
            liquidation_bps: 9_000,
        }
        .validate();
    }

    // ── validate() – ceiling ─────────────────────────────────────────────────

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
