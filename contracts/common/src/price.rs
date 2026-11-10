//! Shared price types (PRD §6.2, §6.4, §8). `PriceGuard` returns these; every contract that
//! reads a price (`CreditLine`, `ExitDesk`, `RepoDvP`) decodes the same shape, so "what a guarded
//! price looks like" cannot drift between the publisher and its readers.
//!
//! Fixed-point values (`value`, `units`, collateral amounts) use 7 decimal places, matching the
//! Stellar classic-asset convention, so a SAC balance can be read directly as `i128` stroops.

use soroban_sdk::{contracttype, Address, Symbol, Vec};

pub const PRICE_SCALE: i128 = 10_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PriceStatus {
    /// At least two fresh, agreeing sources. Draws, exits, and repos may proceed.
    Ok,
    /// Fewer than two fresh sources, or sources disagree beyond the asset's band. No new draws,
    /// exits, or repos; existing positions keep the last good price.
    Degraded,
    /// Price moved more than the daily band against its own last value. No liquidations until a
    /// human confirms via `confirm_halt_cleared`. Draws are paused too.
    Halted,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PriceSource {
    pub name: Symbol,
    pub value: i128,
    pub observed_at: u64,
    pub stale: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct GuardedPrice {
    pub asset: Address,
    pub value: i128,
    pub status: PriceStatus,
    pub ts: u64,
    pub sources: Vec<PriceSource>,
}

impl GuardedPrice {
    pub fn is_usable_for_new_risk(&self) -> bool {
        matches!(self.status, PriceStatus::Ok)
    }

    pub fn is_usable_for_liquidation(&self) -> bool {
        matches!(self.status, PriceStatus::Ok)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn sample_price(env: &Env, status: PriceStatus) -> GuardedPrice {
        GuardedPrice {
            asset: Address::generate(env),
            // Use a valid non-zero price so an implementation that mistakenly checks `value > 0`
            // instead of `status` would fail the Degraded / Halted assertions.
            value: PRICE_SCALE,
            status,
            ts: 1_700_000_000,
            sources: Vec::new(env),
        }
    }

    #[test]
    fn guarded_price_usability_matrix_across_all_statuses() {
        let env = Env::default();

        let ok = sample_price(&env, PriceStatus::Ok);
        assert!(ok.is_usable_for_new_risk());
        assert!(ok.is_usable_for_liquidation());

        let degraded = sample_price(&env, PriceStatus::Degraded);
        assert!(!degraded.is_usable_for_new_risk());
        assert!(!degraded.is_usable_for_liquidation());

        let halted = sample_price(&env, PriceStatus::Halted);
        assert!(!halted.is_usable_for_new_risk());
        assert!(!halted.is_usable_for_liquidation());
    }

    #[test]
    fn price_scale_matches_seven_decimal_stellar_stroops() {
        // 1 unit = 10^7 stroops on Stellar classic / SAC tokens, so multiplying a 7-decimal
        // token balance by a 7-decimal price and dividing by PRICE_SCALE yields 7-decimal USD stroops.
        assert_eq!(PRICE_SCALE, 10_000_000);
    }
}
