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
    /// Dual-meaning timestamp depending on `status`:
    /// - When `status` is [`PriceStatus::Ok`], `ts` is the ledger timestamp (`now`) at which the
    ///   fresh sources were evaluated and `value` was recorded as `LastGood`.
    /// - When `status` is [`PriceStatus::Degraded`] or [`PriceStatus::Halted`], `ts` is the
    ///   ledger timestamp at which the returned `last_good` price was originally recorded
    ///   (`0` if there was no prior good price or if `LastGood` was migrated from a bare `i128`),
    ///   allowing callers and off-chain monitors to measure how old the fallback price is.
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
    use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

    #[test]
    fn price_scale_is_ten_million() {
        // Fixed-point values use 7 decimal places (1.0000000 = 10_000_000), matching the
        // Stellar classic SAC convention where 1 unit = 10^7 stroops.
        // Conversion example: a $100.50 NAV reading converts to 100.50 * 10^7 = 1_005_000_000 stroops.
        assert_eq!(PRICE_SCALE, 10_000_000);
        assert_eq!(10_050 * PRICE_SCALE / 100, 1_005_000_000);
    }

    #[test]
    fn guarded_price_usability_predicates_3x2_matrix() {
        let env = Env::default();
        let asset = Address::generate(&env);

        let ok_price = GuardedPrice {
            asset: asset.clone(),
            value: PRICE_SCALE,
            status: PriceStatus::Ok,
            ts: 1_000,
            sources: Vec::new(&env),
        };
        assert!(ok_price.is_usable_for_new_risk());
        assert!(ok_price.is_usable_for_liquidation());

        let degraded_price = GuardedPrice {
            asset: asset.clone(),
            value: PRICE_SCALE,
            status: PriceStatus::Degraded,
            ts: 1_000,
            sources: Vec::new(&env),
        };
        assert!(!degraded_price.is_usable_for_new_risk());
        assert!(!degraded_price.is_usable_for_liquidation());

        let halted_price = GuardedPrice {
            asset,
            value: PRICE_SCALE, // Non-zero price while halted must still be unusable
            status: PriceStatus::Halted,
            ts: 1_000,
            sources: Vec::new(&env),
        };
        assert!(!halted_price.is_usable_for_new_risk());
        assert!(!halted_price.is_usable_for_liquidation());
    }
}
