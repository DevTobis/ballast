//! The asset configuration shape shared by every contract that reads Registry state
//! (`Registry` writes it, `PledgeVault`/`CreditLine`/`ExitDesk`/`RepoDvP` read it via
//! cross-contract calls). Living in `ballast-common` means a cross-contract `asset()` call
//! decodes into the exact same Rust type on both sides — no risk of two independently-defined
//! structs drifting out of sync at the XDR level. Mirrors the `asset` table (PRD §7).

use soroban_sdk::{contracttype, Address, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssetStandard {
    ClassicSac,
    Sep57,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum YieldType {
    Accumulating,
    Distributing,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CustodyMode {
    Escrow,
    IssuerLien,
    CustodianLien,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfig {
    pub issuer: Address,
    pub contract: Address,
    pub standard: AssetStandard,
    pub yield_type: YieldType,
    pub custody_mode: CustodyMode,
    pub ccy: Symbol,
    pub redemption_lag_days: u32,
    pub haircut_base_bps: u32,
    pub haircut_fx_bps: u32,
    pub price_band_bps: u32,
    pub daily_move_band_bps: u32,
    pub status: Symbol,
}

impl AssetConfig {
    pub fn total_haircut_bps(&self) -> u32 {
        self.haircut_base_bps + self.haircut_fx_bps
    }
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum ParamChange {
    HaircutBaseBps(u32),
    HaircutFxBps(u32),
    PriceBandBps(u32),
    DailyMoveBandBps(u32),
    RedemptionLagDays(u32),
    Status(Symbol),
}
