#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]

//! `Registry` (PRD §6.2, §8): asset configs, haircut parameters, role addresses, timelocked
//! changes. Holds no funds — every other contract reads its `AssetConfig` (via a cross-contract
//! `asset()` call, or an admin-configured local copy, depending on how each contract chose to
//! wire itself in this pass) rather than duplicating registration logic.

use ballast_common::{
    access::{self, Roles},
    asset::{AssetConfig, ParamChange},
    pause::{self, PauseScope},
    timelock,
};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
struct PendingParamChange {
    asset: Address,
    change: ParamChange,
    executes_at: u64,
}

#[contracttype]
struct PendingUnpause {
    scope: PauseScope,
    executes_at: u64,
}

#[contracttype]
enum DataKey {
    Asset(Address),
    PendingParam(u64),
    PendingUnpause(u64),
}

fn read_asset(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::Asset(asset.clone()))
        .expect("registry: asset not registered")
}

fn write_asset(env: &Env, asset: &Address, config: &AssetConfig) {
    env.storage()
        .instance()
        .set(&DataKey::Asset(asset.clone()), config);
}

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn initialize(
        env: Env,
        admin: Address,
        pauser: Address,
        keeper: Address,
        price_publisher: Address,
        risk: Address,
    ) {
        if access::has_roles(&env) {
            panic!("registry: already initialized");
        }
        access::write_roles(
            &env,
            &Roles {
                admin,
                pauser,
                keeper,
                price_publisher,
                risk,
            },
        );
    }

    /// Onboards a new asset (PRD §5 Phase 1 "Asset onboarding": issuer, contract, yield type,
    /// redemption terms, haircut inputs, custody mode). Not timelocked — registering a *new*
    /// asset carries no funds or existing positions to protect; only changes to an *existing*
    /// asset's parameters go through `queue_param`/`execute_param`.
    pub fn register_asset(env: Env, admin: Address, asset: Address, config: AssetConfig) {
        admin.require_auth();
        access::require_admin(&env);
        assert!(
            !env.storage().instance().has(&DataKey::Asset(asset.clone())),
            "registry: asset already registered"
        );
        write_asset(&env, &asset, &config);
    }

    pub fn asset(env: Env, asset: Address) -> AssetConfig {
        read_asset(&env, &asset)
    }

    /// Queues a change to an already-registered asset's parameters, executable after the 48h
    /// timelock (PRD §6.2). Returns the change id to pass to `execute_param`.
    ///
    /// Changes are stored in persistent storage with an initial TTL extended to cover the 48h
    /// delay plus a 7-day grace window (~155,520 ledgers). If unexecuted after the grace period,
    /// the entry expires per Soroban state archival rules unless refreshed or cancelled.
    pub fn queue_param(env: Env, admin: Address, asset: Address, change: ParamChange) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        // Fail fast if the asset doesn't exist yet, rather than queuing a change for nothing.
        read_asset(&env, &asset);

        let id = timelock::next_id(&env);
        let key = DataKey::PendingParam(id);
        env.storage().persistent().set(
            &key,
            &PendingParamChange {
                asset,
                change,
                executes_at: timelock::executes_at(&env),
            },
        );
        timelock::extend_entry_ttl(&env, &key);
        id
    }

    /// Cancels a pending parameter change and removes its persistent storage entry.
    /// Admin only.
    pub fn cancel_param(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        let key = DataKey::PendingParam(id);
        assert!(
            env.storage().persistent().has(&key),
            "registry: no such pending change"
        );
        env.storage().persistent().remove(&key);
    }

    /// Permissionless: anyone may trigger execution once the 48h delay has elapsed — this is the
    /// standard timelock pattern, the *queueing* is what's access-controlled, not the execution.
    pub fn execute_param(env: Env, id: u64) {
        let key = DataKey::PendingParam(id);
        let pending: PendingParamChange = env
            .storage()
            .persistent()
            .get(&key)
            .expect("registry: no such pending change");
        assert!(
            timelock::is_ready(&env, pending.executes_at),
            "registry: timelock has not elapsed"
        );

        let mut config = read_asset(&env, &pending.asset);
        // `raise_haircut_now` enforces `<= 10_000` bps on its own write path; this path must
        // enforce the same bound (and a sane bound on the other bps-denominated fields) so a
        // queued change can't silently push a field past 100% after the timelock elapses.
        match pending.change {
            ParamChange::HaircutBaseBps(v) => {
                assert!(v <= 10_000, "registry: haircut cannot exceed 100%");
                config.haircut_base_bps = v;
            }
            ParamChange::HaircutFxBps(v) => {
                assert!(v <= 10_000, "registry: haircut cannot exceed 100%");
                config.haircut_fx_bps = v;
            }
            ParamChange::PriceBandBps(v) => {
                assert!(v <= 10_000, "registry: band cannot exceed 100%");
                config.price_band_bps = v;
            }
            ParamChange::DailyMoveBandBps(v) => {
                assert!(v <= 10_000, "registry: band cannot exceed 100%");
                config.daily_move_band_bps = v;
            }
            ParamChange::RedemptionLagDays(v) => config.redemption_lag_days = v,
            ParamChange::Status(v) => config.status = v,
        }
        write_asset(&env, &pending.asset, &config);
        env.storage().persistent().remove(&key);
    }

    /// The emergency brake (PRD §6.4/§8): raises `haircut_base_bps` immediately, with no
    /// timelock. Increase-only — a decrease (loosening risk) must go through the timelocked path,
    /// only tightening risk gets to skip it.
    pub fn raise_haircut_now(env: Env, risk: Address, asset: Address, add_bps: u32) {
        risk.require_auth();
        access::require_risk(&env);

        let mut config = read_asset(&env, &asset);
        let new_haircut = config
            .haircut_base_bps
            .checked_add(add_bps)
            .expect("registry: haircut overflow");
        assert!(
            new_haircut <= 10_000,
            "registry: haircut cannot exceed 100%"
        );
        config.haircut_base_bps = new_haircut;
        write_asset(&env, &asset, &config);
    }

    /// Immediate, no timelock — the pauser can only ever *stop* things (PRD §6.2).
    pub fn pause(env: Env, pauser: Address, scope: PauseScope) {
        pauser.require_auth();
        access::require_pauser(&env);
        pause::set_paused(&env, &scope, true);
    }

    /// Queues an unpause, executable after the 48h timelock — unlike `pause`, lifting a stop is
    /// not urgent and deserves the same notice period as any other risk-loosening change.
    ///
    /// Stored in persistent storage with an initial TTL extended to cover 48h plus the 7-day
    /// grace period (~155,520 ledgers).
    pub fn queue_unpause(env: Env, admin: Address, scope: PauseScope) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        let id = timelock::next_id(&env);
        let key = DataKey::PendingUnpause(id);
        env.storage().persistent().set(
            &key,
            &PendingUnpause {
                scope,
                executes_at: timelock::executes_at(&env),
            },
        );
        timelock::extend_entry_ttl(&env, &key);
        id
    }

    /// Cancels a pending unpause and removes its persistent storage entry.
    /// Admin only.
    pub fn cancel_unpause(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        let key = DataKey::PendingUnpause(id);
        assert!(
            env.storage().persistent().has(&key),
            "registry: no such pending unpause"
        );
        env.storage().persistent().remove(&key);
    }

    pub fn execute_unpause(env: Env, id: u64) {
        let key = DataKey::PendingUnpause(id);
        let pending: PendingUnpause = env
            .storage()
            .persistent()
            .get(&key)
            .expect("registry: no such pending unpause");
        assert!(
            timelock::is_ready(&env, pending.executes_at),
            "registry: timelock has not elapsed"
        );
        pause::set_paused(&env, &pending.scope, false);
        env.storage().persistent().remove(&key);
    }

    pub fn is_paused(env: Env, scope: PauseScope) -> bool {
        pause::is_paused(&env, &scope)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ballast_common::asset::{AssetStandard, CustodyMode, YieldType};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{symbol_short, Symbol};

    fn setup() -> (Env, RegistryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let id = env.register(Registry, ());
        let client = RegistryClient::new(&env, &id);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        client.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

        let asset = Address::generate(&env);
        let issuer = Address::generate(&env);
        client.register_asset(
            &admin,
            &asset,
            &AssetConfig {
                issuer,
                contract: asset.clone(),
                standard: AssetStandard::ClassicSac,
                yield_type: YieldType::Accumulating,
                custody_mode: CustodyMode::Escrow,
                ccy: Symbol::new(&env, "USD"),
                redemption_lag_days: 1,
                haircut_base_bps: 300,
                haircut_fx_bps: 0,
                price_band_bps: 50,
                daily_move_band_bps: 100,
                status: symbol_short!("active"),
            },
        );

        (env, client, admin, risk, asset)
    }

    #[test]
    fn execute_param_requires_the_timelock_to_elapse() {
        let (env, client, admin, _risk, asset) = setup();

        let id = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(700));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_param(&id);
        }));
        assert!(
            result.is_err(),
            "registry: execute_param should fail before 48h"
        );

        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });
        client.execute_param(&id);

        let updated = client.asset(&asset);
        assert_eq!(updated.haircut_base_bps, 700);
    }

    #[test]
    fn raise_haircut_now_is_immediate_and_increase_only() {
        let (_env, client, _admin, risk, asset) = setup();

        client.raise_haircut_now(&risk, &asset, &200);
        let updated = client.asset(&asset);
        assert_eq!(updated.haircut_base_bps, 500);
    }

    #[test]
    #[should_panic(expected = "registry: haircut cannot exceed 100%")]
    fn raise_haircut_now_rejects_overflow_past_100_percent() {
        let (_env, client, _admin, risk, asset) = setup();
        client.raise_haircut_now(&risk, &asset, &10_000);
    }

    #[test]
    fn pause_is_immediate_unpause_is_timelocked() {
        let (env, client, admin, _risk, asset) = setup();
        let _ = asset;

        let pauser = Address::generate(&env);
        // Re-initialize isn't possible; instead call pause with the actual configured pauser by
        // reading it back out is not exposed, so this test exercises the read-your-writes path
        // via `is_paused` using the pauser captured at setup time instead.
        let _ = pauser;

        client.pause(&client_pauser(&env, &client), &PauseScope::Draws);
        assert!(client.is_paused(&PauseScope::Draws));

        let id = client.queue_unpause(&admin, &PauseScope::Draws);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_unpause(&id);
        }));
        assert!(
            result.is_err(),
            "registry: execute_unpause should fail before 48h"
        );
        assert!(client.is_paused(&PauseScope::Draws));

        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });
        client.execute_unpause(&id);
        assert!(!client.is_paused(&PauseScope::Draws));
    }

    // Test-only helper: there's no public getter for the stored pauser address, so this reaches
    // into the contract's own storage the same way `access::read_roles` would, purely so this
    // test can call `pause` with a validly-authorized address under `mock_all_auths`.
    fn client_pauser(env: &Env, client: &RegistryClient<'static>) -> Address {
        env.as_contract(&client.address, || {
            ballast_common::access::read_roles(env).pauser
        })
    }

    #[test]
    fn execute_param_survives_advancing_sequence_number_past_48h() {
        let (env, client, admin, _risk, asset) = setup();

        let id = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(850));

        // Advance both timestamp past 48h AND sequence_number by 34,561 ledgers.
        // With temporary storage, 34,561 ledgers would expire the entry; with persistent
        // storage and extend_entry_ttl, the change survives and executes cleanly.
        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 34_561;
        });

        client.execute_param(&id);

        let updated = client.asset(&asset);
        assert_eq!(updated.haircut_base_bps, 850);
    }

    #[test]
    fn cancel_param_removes_pending_change_and_prevents_execution() {
        let (env, client, admin, _risk, asset) = setup();

        let id = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(900));

        // Admin cancels the pending change
        client.cancel_param(&admin, &id);

        // Advance time past 48h
        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });

        // Execution must fail because the pending entry was removed
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_param(&id);
        }));
        assert!(result.is_err(), "execute_param should fail after cancellation");
    }

    #[test]
    fn cancel_unpause_removes_pending_unpause_and_prevents_execution() {
        let (env, client, admin, _risk, _asset) = setup();

        client.pause(&client_pauser(&env, &client), &PauseScope::Draws);
        assert!(client.is_paused(&PauseScope::Draws));

        let id = client.queue_unpause(&admin, &PauseScope::Draws);

        // Admin cancels the pending unpause
        client.cancel_unpause(&admin, &id);

        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_unpause(&id);
        }));
        assert!(result.is_err(), "execute_unpause should fail after cancellation");
        assert!(client.is_paused(&PauseScope::Draws));
    }
}
