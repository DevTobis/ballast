//! The asset configuration shape shared by every contract that reads Registry state
//! (`Registry` writes it, `PledgeVault`/`CreditLine`/`ExitDesk`/`RepoDvP` read it via
//! cross-contract calls). Living in `ballast-common` means a cross-contract `asset()` call
//! decodes into the exact same Rust type on both sides — no risk of two independently-defined
//! structs drifting out of sync at the XDR level. Mirrors the `asset` table (PRD §7).

use soroban_sdk::{contracttype, Address, Env, Symbol};

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
    /// Returns the combined haircut without relying on the registry's storage invariant.
    /// `u64` keeps this safe even for an unvalidated config supplied by a caller.
    pub fn total_haircut_bps(&self) -> u64 {
        u64::from(self.haircut_base_bps) + u64::from(self.haircut_fx_bps)
    }

    /// Validate an asset config against the address under which it will be stored.
    /// Bps limits are kept here so registration and timelocked updates share one policy.
    pub fn validate(&self, env: &Env, asset: &Address) -> Result<(), &'static str> {
        if self.haircut_base_bps > 10_000 {
            return Err("registry: base haircut cannot exceed 100%");
        }
        if self.haircut_fx_bps > 10_000 {
            return Err("registry: FX haircut cannot exceed 100%");
        }
        if self.total_haircut_bps() > 10_000 {
            return Err("registry: total haircut cannot exceed 100%");
        }
        if self.price_band_bps == 0 || self.price_band_bps > 10_000 {
            return Err("registry: price band must be between 1 and 10000 bps");
        }
        if self.daily_move_band_bps == 0 || self.daily_move_band_bps > 10_000 {
            return Err("registry: daily move band must be between 1 and 10000 bps");
        }
        if self.contract != *asset {
            return Err("registry: asset contract must match asset address");
        }

        // Supported lifecycle states: active assets may be used; paused assets are held
        // out of normal operations; retired assets remain readable for existing positions.
        let active = Symbol::new(env, "active");
        let paused = Symbol::new(env, "paused");
        let retired = Symbol::new(env, "retired");
        if self.status != active && self.status != paused && self.status != retired {
            return Err("registry: status must be active, paused, or retired");
        }
        Ok(())
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

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn total_haircut_is_safe_for_unvalidated_values() {
        let env = Env::default();
        let address = Address::generate(&env);
        let config = AssetConfig {
            issuer: address.clone(),
            contract: address,
            standard: AssetStandard::ClassicSac,
            yield_type: YieldType::Accumulating,
            custody_mode: CustodyMode::Escrow,
            ccy: Symbol::new(&env, "USD"),
            redemption_lag_days: 0,
            haircut_base_bps: u32::MAX,
            haircut_fx_bps: 1,
            price_band_bps: 1,
            daily_move_band_bps: 1,
            status: Symbol::new(&env, "active"),
        };

        assert_eq!(config.total_haircut_bps(), u64::from(u32::MAX) + 1);
    }
}
