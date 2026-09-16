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
