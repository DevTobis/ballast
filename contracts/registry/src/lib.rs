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
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

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
        env.events()
            .publish((Symbol::new(&env, "asset_registered"), asset.clone()), config);
    }

    pub fn asset(env: Env, asset: Address) -> AssetConfig {
        read_asset(&env, &asset)
    }

    /// Queues a change to an already-registered asset's parameters, executable after the 48h
    /// timelock (PRD §6.2). Returns the change id to pass to `execute_param`.
    pub fn queue_param(env: Env, admin: Address, asset: Address, change: ParamChange) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        // Fail fast if the asset doesn't exist yet, rather than queuing a change for nothing.
        read_asset(&env, &asset);

        let id = timelock::next_id(&env);
        let executes_at = timelock::executes_at(&env);
        let pending = PendingParamChange {
            asset: asset.clone(),
            change,
            executes_at,
        };
        env.storage().temporary().set(&DataKey::PendingParam(id), &pending);
        env.events().publish(
            (Symbol::new(&env, "param_queued"), id),
            (pending.asset.clone(), pending.change.clone(), pending.executes_at),
        );
        id
    }

    /// Permissionless: anyone may trigger execution once the 48h delay has elapsed — this is the
    /// standard timelock pattern, the *queueing* is what's access-controlled, not the execution.
    pub fn execute_param(env: Env, id: u64) {
        let pending: PendingParamChange = env
            .storage()
            .temporary()
            .get(&DataKey::PendingParam(id))
            .expect("registry: no such pending change");
        assert!(
            timelock::is_ready(&env, pending.executes_at),
            "registry: timelock has not elapsed"
        );

        let mut config = read_asset(&env, &pending.asset);
        // `raise_haircut_now` enforces `<= 10_000` bps on its own write path; this path must
        // enforce the same bound (and a sane bound on the other bps-denominated fields) so a
        // queued change can't silently push a field past 100% after the timelock elapses.
        match &pending.change {
            ParamChange::HaircutBaseBps(v) => {
                assert!(*v <= 10_000, "registry: haircut cannot exceed 100%");
                config.haircut_base_bps = *v;
            }
            ParamChange::HaircutFxBps(v) => {
                assert!(*v <= 10_000, "registry: haircut cannot exceed 100%");
                config.haircut_fx_bps = *v;
            }
            ParamChange::PriceBandBps(v) => {
                assert!(*v <= 10_000, "registry: band cannot exceed 100%");
                config.price_band_bps = *v;
            }
            ParamChange::DailyMoveBandBps(v) => {
                assert!(*v <= 10_000, "registry: band cannot exceed 100%");
                config.daily_move_band_bps = *v;
            }
            ParamChange::RedemptionLagDays(v) => config.redemption_lag_days = *v,
            ParamChange::Status(v) => config.status = v.clone(),
        }
        write_asset(&env, &pending.asset, &config);
        env.storage().temporary().remove(&DataKey::PendingParam(id));
        // Emit param_executed: the queued change and the config it produced.
        env.events().publish(
            (Symbol::new(&env, "param_executed"), id),
            (pending.asset.clone(), pending.change.clone(), config.clone()),
        );
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
        env.events()
            .publish((Symbol::new(&env, "haircut_raised"), asset.clone()), (add_bps, new_haircut));
    }

    /// Immediate, no timelock — the pauser can only ever *stop* things (PRD §6.2).
    pub fn pause(env: Env, pauser: Address, scope: PauseScope) {
        pauser.require_auth();
        access::require_pauser(&env);
        pause::set_paused(&env, &scope, true);
        env.events()
            .publish((Symbol::new(&env, "paused"), scope.clone()), true);
    }

    /// Queues an unpause, executable after the 48h timelock — unlike `pause`, lifting a stop is
    /// not urgent and deserves the same notice period as any other risk-loosening change.
    pub fn queue_unpause(env: Env, admin: Address, scope: PauseScope) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        let id = timelock::next_id(&env);
        let executes_at = timelock::executes_at(&env);
        let pending = PendingUnpause {
            scope: scope.clone(),
            executes_at,
        };
        env.storage().temporary().set(&DataKey::PendingUnpause(id), &pending);
        env.events().publish(
            (Symbol::new(&env, "unpause_queued"), id),
            (scope.clone(), executes_at),
        );
        id
    }

    pub fn execute_unpause(env: Env, id: u64) {
        let pending: PendingUnpause = env
            .storage()
            .temporary()
            .get(&DataKey::PendingUnpause(id))
            .expect("registry: no such pending unpause");
        assert!(
            timelock::is_ready(&env, pending.executes_at),
            "registry: timelock has not elapsed"
        );
        pause::set_paused(&env, &pending.scope, false);
        env.events().publish(
            (Symbol::new(&env, "unpause_executed"), id),
            pending.scope.clone(),
        );
        env.storage()
            .temporary()
            .remove(&DataKey::PendingUnpause(id));
    }

    pub fn is_paused(env: Env, scope: PauseScope) -> bool {
        pause::is_paused(&env, &scope)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ballast_common::asset::{AssetStandard, CustodyMode, YieldType};
    use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
    use soroban_sdk::{symbol_short, Symbol, TryFromVal};

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

    // Builds the XDR form of an expected event so it can be compared against what the contract
    // published. Mirrors the conversion `testutils::ContractEvents` uses internally.
    fn expected_event(
        env: &Env,
        addr: &Address,
        topics: soroban_sdk::Vec<soroban_sdk::Val>,
        data: soroban_sdk::Val,
    ) -> soroban_sdk::xdr::ContractEvent {
        let contract_id = match soroban_sdk::xdr::ScVal::try_from_val(env, &addr.to_val()) {
            Ok(soroban_sdk::xdr::ScVal::Address(soroban_sdk::xdr::ScAddress::Contract(cid))) => {
                Some(cid)
            }
            _ => None,
        };
        soroban_sdk::xdr::ContractEvent {
            ext: soroban_sdk::xdr::ExtensionPoint::V0,
            type_: soroban_sdk::xdr::ContractEventType::Contract,
            contract_id,
            body: soroban_sdk::xdr::ContractEventBody::V0(soroban_sdk::xdr::ContractEventV0 {
                topics: topics.into(),
                data: soroban_sdk::xdr::ScVal::try_from_val(env, &data).unwrap(),
            }),
        }
    }

    // The event published by the most recent contract call, so assertions hold regardless of
    // whether the test env keeps events across calls or only for the latest invocation.
    fn last_event(env: &Env) -> Option<soroban_sdk::xdr::ContractEvent> {
        env.events().all().events().last().cloned()
    }

    #[test]
    fn every_state_change_emits_an_event() {
        use soroban_sdk::{vec, IntoVal};

        let (env, client, admin, risk, asset) = setup();
        // Reading the config is itself a contract call, and a call resets the observable event
        // buffer, so `setup`'s own `asset_registered` can no longer be seen here. Register a
        // fresh asset and assert on that call instead.
        let config = client.asset(&asset);
        let addr = client.address.clone();
        let fresh = Address::generate(&env);

        client.register_asset(&admin, &fresh, &config);
        let registered = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "asset_registered").into_val(&env),
                fresh.clone().into_val(&env),
            ],
            config.clone().into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(registered),
            "register_asset must emit asset_registered"
        );

        let change = ParamChange::HaircutBaseBps(700);
        let param_id = client.queue_param(&admin, &fresh, &change);
        let executes_at =
            env.ledger().timestamp() + ballast_common::timelock::TIMELOCK_DELAY_SECONDS;
        let queued = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "param_queued").into_val(&env),
                param_id.into_val(&env),
            ],
            (fresh.clone(), change.clone(), executes_at).into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(queued),
            "queue_param must emit param_queued"
        );

        client.raise_haircut_now(&risk, &fresh, &200);
        let raised = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "haircut_raised").into_val(&env),
                fresh.clone().into_val(&env),
            ],
            (200u32, 500u32).into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(raised),
            "raise_haircut_now must emit haircut_raised"
        );

        client.pause(&client_pauser(&env, &client), &PauseScope::Draws);
        let paused = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "paused").into_val(&env),
                PauseScope::Draws.into_val(&env),
            ],
            true.into_val(&env),
        );
        assert_eq!(last_event(&env), Some(paused), "pause must emit paused");

        let unpause_id = client.queue_unpause(&admin, &PauseScope::Draws);
        let unpause_queued = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "unpause_queued").into_val(&env),
                unpause_id.into_val(&env),
            ],
            (PauseScope::Draws, executes_at).into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(unpause_queued),
            "queue_unpause must emit unpause_queued"
        );

        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });
        client.execute_param(&param_id);
        let mut updated = config.clone();
        updated.haircut_base_bps = 700;
        let executed = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "param_executed").into_val(&env),
                param_id.into_val(&env),
            ],
            (fresh.clone(), change.clone(), updated.clone()).into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(executed),
            "execute_param must emit param_executed"
        );

        client.execute_unpause(&unpause_id);
        let unpaused = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "unpause_executed").into_val(&env),
                unpause_id.into_val(&env),
            ],
            PauseScope::Draws.into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(unpaused),
            "execute_unpause must emit unpause_executed"
        );
    }

    // Test-only helper: there's no public getter for the stored pauser address, so this reaches
    // into the contract's own storage the same way `access::read_roles` would, purely so this
    // test can call `pause` with a validly-authorized address under `mock_all_auths`.
    fn client_pauser(env: &Env, client: &RegistryClient<'static>) -> Address {
        env.as_contract(&client.address, || {
            ballast_common::access::read_roles(env).pauser
        })
    }
}
