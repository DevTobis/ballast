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
    timelock, ttl,
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

// Per-asset configs live in persistent storage, one entry each, so the instance entry that every
// call loads does not grow with the number of registered assets.
fn read_asset(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .persistent()
        .get(&DataKey::Asset(asset.clone()))
        .expect("registry: asset not registered")
}

fn write_asset(env: &Env, asset: &Address, config: &AssetConfig) {
    let key = DataKey::Asset(asset.clone());
    env.storage().persistent().set(&key, config);
    ttl::extend_persistent(env, &key);
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
        ttl::extend_instance(&env);
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

    /// Current role addresses. Used by scripts and tests to confirm a rotation landed.
    pub fn roles(env: Env) -> Roles {
        access::read_roles(&env)
    }

    /// Step 1 of a two-step admin transfer: the stored admin names its successor. A later proposal
    /// replaces an earlier one, so a mistyped address can be corrected without waiting.
    pub fn propose_admin(env: Env, new_admin: Address) {
        ttl::extend_instance(&env);
        access::propose_admin(&env, &new_admin);
    }

    /// Step 2 of a two-step admin transfer: the proposed successor accepts. Consumes the proposal.
    pub fn accept_admin(env: Env) {
        ttl::extend_instance(&env);
        access::accept_admin(&env);
    }

    /// The proposed successor from `propose_admin`, if a transfer is pending.
    pub fn pending_admin(env: Env) -> Option<Address> {
        access::pending_admin(&env)
    }

    /// Queues a timelocked non-admin role rotation and returns the id to pass to
    /// `execute_role_change` once the 48h delay has elapsed. Only the admin may queue; execution is
    /// permissionless.
    pub fn queue_role_change(env: Env, role: access::RoleKind, new_address: Address) -> u64 {
        ttl::extend_instance(&env);
        access::queue_role_change(&env, role, &new_address)
    }

    /// Applies a `queue_role_change` entry once its 48h timelock has elapsed.
    pub fn execute_role_change(env: Env, id: u64) {
        ttl::extend_instance(&env);
        access::execute_role_change(&env, id)
    }

    /// The outstanding queued change for `id`, including its `executes_at` timestamp.
    pub fn pending_role_change(env: Env, id: u64) -> Option<access::PendingRoleChange> {
        access::pending_role_change(&env, id)
    }

    /// Onboards a new asset (PRD §5 Phase 1 "Asset onboarding": issuer, contract, yield type,
    /// redemption terms, haircut inputs, custody mode). Not timelocked — registering a *new*
    /// asset carries no funds or existing positions to protect; only changes to an *existing*
    /// asset's parameters go through `queue_param`/`execute_param`.
    pub fn register_asset(env: Env, admin: Address, asset: Address, config: AssetConfig) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        assert!(
            !env.storage().persistent().has(&DataKey::Asset(asset.clone())),
            "registry: asset already registered"
        );
        if let Err(message) = config.validate(&env, &asset) {
            panic!("{}", message);
        }
        write_asset(&env, &asset, &config);
    }

    pub fn asset(env: Env, asset: Address) -> AssetConfig {
        let config = read_asset(&env, &asset);
        ttl::extend_persistent(&env, &DataKey::Asset(asset));
        config
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
        ttl::extend_instance(&env);
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
        ttl::extend_instance(&env);
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
        ttl::extend_instance(&env);
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
        match pending.change {
            ParamChange::HaircutBaseBps(v) => {
                config.haircut_base_bps = v;
            }
            ParamChange::HaircutFxBps(v) => {
                config.haircut_fx_bps = v;
            }
            ParamChange::PriceBandBps(v) => {
                config.price_band_bps = v;
            }
            ParamChange::DailyMoveBandBps(v) => {
                config.daily_move_band_bps = v;
            }
            ParamChange::RedemptionLagDays(v) => config.redemption_lag_days = v,
            ParamChange::Status(v) => config.status = v,
        }
        if let Err(message) = config.validate(&env, &pending.asset) {
            panic!("{}", message);
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
        ttl::extend_instance(&env);

        let mut config = read_asset(&env, &asset);
        let new_haircut = config
            .haircut_base_bps
            .checked_add(add_bps)
            .expect("registry: haircut overflow");
        assert!(
            u64::from(new_haircut) + u64::from(config.haircut_fx_bps) <= 10_000,
            "registry: haircut cannot exceed 100%"
        );
        config.haircut_base_bps = new_haircut;
        write_asset(&env, &asset, &config);
    }

    /// Immediate, no timelock — the pauser can only ever *stop* things (PRD §6.2).
    pub fn pause(env: Env, pauser: Address, scope: PauseScope) {
        pauser.require_auth();
        access::require_pauser(&env);
        ttl::extend_instance(&env);
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
        ttl::extend_instance(&env);
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
        ttl::extend_instance(&env);
        let key = DataKey::PendingUnpause(id);
        assert!(
            env.storage().persistent().has(&key),
            "registry: no such pending unpause"
        );
        env.storage().persistent().remove(&key);
    }

    pub fn execute_unpause(env: Env, id: u64) {
        ttl::extend_instance(&env);
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
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{symbol_short, Symbol};

    fn valid_config(env: &Env, asset: &Address) -> AssetConfig {
        AssetConfig {
            issuer: Address::generate(env),
            contract: asset.clone(),
            standard: AssetStandard::ClassicSac,
            yield_type: YieldType::Accumulating,
            custody_mode: CustodyMode::Escrow,
            ccy: Symbol::new(env, "USD"),
            redemption_lag_days: 1,
            haircut_base_bps: 300,
            haircut_fx_bps: 0,
            price_band_bps: 50,
            daily_move_band_bps: 100,
            status: symbol_short!("active"),
        }
    }

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
    fn register_asset_accepts_a_valid_config_and_rejects_each_invalid_field() {
        let (env, client, admin, _risk, _registered_asset) = setup();

        let valid_asset = Address::generate(&env);
        client.register_asset(&admin, &valid_asset, &valid_config(&env, &valid_asset));
        assert_eq!(client.asset(&valid_asset).contract, valid_asset);

        let mut invalid_configs = std::vec::Vec::new();
        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.haircut_base_bps = 10_001;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.haircut_fx_bps = 10_001;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.haircut_base_bps = 6_000;
        config.haircut_fx_bps = 4_001;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.price_band_bps = 0;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.price_band_bps = 10_001;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.daily_move_band_bps = 0;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.daily_move_band_bps = 10_001;
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.contract = Address::generate(&env);
        invalid_configs.push((asset, config));

        let asset = Address::generate(&env);
        let mut config = valid_config(&env, &asset);
        config.status = Symbol::new(&env, "whatever");
        invalid_configs.push((asset, config));

        for (asset, config) in invalid_configs {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.register_asset(&admin, &asset, &config);
            }));
            assert!(result.is_err());
        }
    }

    #[test]
    fn execute_param_reuses_asset_config_validation() {
        let (env, client, admin, _risk, asset) = setup();
        let id = client.queue_param(
            &admin,
            &asset,
            &ParamChange::Status(Symbol::new(&env, "bad")),
        );
        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_param(&id);
        }));
        assert!(result.is_err());
        assert_eq!(client.asset(&asset).status, symbol_short!("active"));
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

    #[test]
    fn pause_rejects_a_stranger_authorising_only_themselves() {
        use soroban_sdk::testutils::MockAuth;
        use soroban_sdk::testutils::MockAuthInvoke;
        use soroban_sdk::IntoVal;

        let (env, client, ..) = setup();
        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "pause",
                args: (&stranger, PauseScope::Draws).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(client.try_pause(&stranger, &PauseScope::Draws).is_err());
        assert!(!client.is_paused(&PauseScope::Draws));
    }

    #[test]
    fn pause_all_pauses_every_scope() {
        let (env, client, ..) = setup();
        for scope in [
            PauseScope::Pledges,
            PauseScope::Draws,
            PauseScope::Exits,
            PauseScope::Repos,
        ] {
            assert!(!client.is_paused(&scope));
        }

        client.pause(&client_pauser(&env, &client), &PauseScope::All);

        for scope in [
            PauseScope::Pledges,
            PauseScope::Draws,
            PauseScope::Exits,
            PauseScope::Repos,
        ] {
            assert!(client.is_paused(&scope));
        }
    }

    #[test]
    fn pausing_twice_is_idempotent() {
        let (env, client, ..) = setup();
        let pauser = client_pauser(&env, &client);

        client.pause(&pauser, &PauseScope::Exits);
        client.pause(&pauser, &PauseScope::Exits);

        assert!(client.is_paused(&PauseScope::Exits));
    }

    #[test]
    fn state_remains_accessible_across_sequence_advancement() {
        let (env, client, admin, _risk, asset) = setup();

        let initial_config = client.asset(&asset);
        assert_eq!(initial_config.haircut_base_bps, 300);

        // Advance sequence number past initial TTL (10,000 ledgers)
        let current_seq = env.ledger().sequence();
        env.ledger().set_sequence_number(current_seq + 10_000);

        // State remains accessible because register_asset extended instance TTL
        let fetched_config = client.asset(&asset);
        assert_eq!(fetched_config.haircut_base_bps, 300);

        // Subsequent state-changing calls succeed and re-extend instance TTL
        let id = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(400));
        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });
        client.execute_param(&id);

        assert_eq!(client.asset(&asset).haircut_base_bps, 400);
    }

    #[test]
    fn asset_config_lives_in_persistent_storage_with_extended_ttl() {
        let (env, client, admin, _risk, asset) = setup();

        env.as_contract(&client.address, || {
            let key = DataKey::Asset(asset.clone());
            assert!(env.storage().persistent().has(&key));
            assert!(!env.storage().instance().has(&key));
            assert_eq!(
                env.storage().persistent().get_ttl(&key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
            assert_eq!(
                env.storage().instance().get_ttl(),
                ballast_common::ttl::INSTANCE_EXTEND_TO_LEDGERS
            );
        });

        // Once less than the threshold remains, a read inside a transaction pushes the TTL back out.
        env.ledger().with_mut(|l| l.sequence_number += 505_000);
        assert_eq!(client.asset(&asset).haircut_base_bps, 300);
        env.as_contract(&client.address, || {
            assert_eq!(
                env.storage().persistent().get_ttl(&DataKey::Asset(asset.clone())),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
        });

        // A queued change still executes after the timelock, and the write keeps the entry alive.
        let id = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(400));
        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
        });
        client.execute_param(&id);
        assert_eq!(client.asset(&asset).haircut_base_bps, 400);
    }

    fn client_pauser(_env: &Env, client: &RegistryClient<'static>) -> Address {
        client.roles().pauser
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

    #[test]
    fn a_stranger_cannot_queue_param() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _risk, asset) = setup();
        let stranger = Address::generate(&env);
        let change = ParamChange::HaircutBaseBps(700);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_param",
                args: (stranger.clone(), asset.clone(), change.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_param(&stranger, &asset, &change);
        }));
        assert!(
            result.is_err(),
            "only the stored admin may queue a param change"
        );

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        let id = client.queue_param(&admin, &asset, &change);
        assert_eq!(id, 0);
    }

    #[test]
    fn a_stranger_cannot_queue_unpause() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _risk, _asset) = setup();
        let stranger = Address::generate(&env);
        let scope = PauseScope::Draws;

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_unpause",
                args: (stranger.clone(), scope.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_unpause(&stranger, &scope);
        }));
        assert!(result.is_err(), "only the stored admin may queue an unpause");

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        let id = client.queue_unpause(&admin, &scope);
        assert_eq!(id, 0);
    }

    #[test]
    #[should_panic(expected = "registry: asset not registered")]
    fn queue_param_rejects_unknown_asset() {
        let (env, client, admin, _risk, _asset) = setup();
        let unknown = Address::generate(&env);
        client.queue_param(&admin, &unknown, &ParamChange::HaircutBaseBps(700));
    }

    #[test]
    fn consecutive_queues_return_increasing_and_different_ids() {
        let (_env, client, admin, _risk, asset) = setup();
        let id1 = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(500));
        let id2 = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(600));
        let id3 = client.queue_unpause(&admin, &PauseScope::Draws);
        assert_ne!(id1, id2);
        assert_ne!(id2, id3);
        assert!(id2 > id1);
        assert!(id3 > id2);
    }

    #[test]
    fn queued_pauser_rotation_rejects_the_old_pauser_and_accepts_the_new_one() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _admin, _risk, _asset) = setup();
        let old_pauser = client.roles().pauser;
        let new_pauser = Address::generate(&env);

        let id = client.queue_role_change(&access::RoleKind::Pauser, &new_pauser);
        assert_eq!(
            client.roles().pauser,
            old_pauser,
            "queueing must not change the pauser role yet"
        );
        assert_eq!(
            client.pending_role_change(&id).map(|p| p.new_address),
            Some(new_pauser.clone())
        );

        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_role_change(&id);
        }));
        assert!(
            early.is_err(),
            "a queued role rotation must wait out the 48h timelock"
        );

        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 34_561;
        });
        client.execute_role_change(&id);
        assert_eq!(client.roles().pauser, new_pauser);
        assert!(client.pending_role_change(&id).is_none());

        env.mock_auths(&[MockAuth {
            address: &old_pauser,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "pause",
                args: (old_pauser.clone(), PauseScope::Draws).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let old_rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause(&old_pauser, &PauseScope::Draws);
        }));
        assert!(old_rejected.is_err(), "the rotated-out pauser must be rejected");
        assert!(!client.is_paused(&PauseScope::Draws));

        let new_auth = MockAuth {
            address: &new_pauser,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "pause",
                args: (new_pauser.clone(), PauseScope::Draws).into_val(&env),
                sub_invokes: &[],
            },
        };
        env.mock_auths(&[new_auth.clone(), new_auth]);
        client.pause(&new_pauser, &PauseScope::Draws);
        assert!(client.is_paused(&PauseScope::Draws));
    }

    #[test]
    fn admin_transfer_requires_the_proposed_admin_to_accept() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _admin, _risk, _asset) = setup();
        let current_admin = client.roles().admin;
        let new_admin = Address::generate(&env);

        client.propose_admin(&new_admin);
        assert_eq!(client.pending_admin(), Some(new_admin.clone()));

        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.accept_admin();
        }));
        assert!(
            rejected.is_err(),
            "only the proposed admin may accept the transfer"
        );
        assert_eq!(client.roles().admin, current_admin);

        env.mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.accept_admin();
        assert_eq!(client.roles().admin, new_admin);
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    fn a_stranger_cannot_queue_a_role_change_or_propose_admin() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _admin, _risk, _asset) = setup();
        let stranger = Address::generate(&env);
        let candidate = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_role_change",
                args: (access::RoleKind::Pauser, candidate.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_role_change(&access::RoleKind::Pauser, &candidate);
        }));
        assert!(
            result.is_err(),
            "only the stored admin may queue a role change"
        );

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "propose_admin",
                args: (candidate.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let propose_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.propose_admin(&candidate);
        }));
        assert!(
            propose_result.is_err(),
            "only the stored admin may propose a new admin"
        );
    }
}
