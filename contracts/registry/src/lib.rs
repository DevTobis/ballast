#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]
// Events are published with `Events::publish`, which soroban-sdk now deprecates in favour of
// `#[contractevent]`; the other contracts do the same until that migration is decided.
#![allow(deprecated)]

//! `Registry` (PRD §6.2, §8): asset configs, haircut parameters, role addresses, timelocked
//! changes. Holds no funds — every other contract reads its `AssetConfig` (via a cross-contract
//! `asset()` call, or an admin-configured local copy, depending on how each contract chose to
//! wire itself in this pass) rather than duplicating registration logic.

use ballast_common::{
    access::{self, Roles},
    asset::{AssetConfig, ParamChange},
    pause::{self, PauseScope},
    timelock, ttl, upgrade,
};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Symbol};

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
        env.events()
            .publish((Symbol::new(&env, "asset_registered"), asset), config);
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
        let executes_at = timelock::executes_at(&env);
        env.storage().persistent().set(
            &key,
            &PendingParamChange {
                asset: asset.clone(),
                change: change.clone(),
                executes_at,
            },
        );
        timelock::extend_entry_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "param_queued"), id),
            (asset, change, executes_at),
        );
        id
    }

    /// Cancels a pending parameter change and removes its persistent storage entry.
    /// Admin only.
    pub fn cancel_param(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        let key = DataKey::PendingParam(id);
        let pending: PendingParamChange = env
            .storage()
            .persistent()
            .get(&key)
            .expect("registry: no such pending change");
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "param_cancelled"), id), pending.asset);
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
        let change = pending.change.clone();
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
        env.events().publish(
            (Symbol::new(&env, "param_executed"), id),
            (pending.asset, change, config),
        );
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
        env.events().publish(
            (Symbol::new(&env, "haircut_raised"), asset),
            (add_bps, new_haircut),
        );
    }

    /// Immediate, no timelock — the pauser can only ever *stop* things (PRD §6.2).
    pub fn pause(env: Env, pauser: Address, scope: PauseScope) {
        pauser.require_auth();
        access::require_pauser(&env);
        ttl::extend_instance(&env);
        pause::set_paused(&env, &scope, true);
        env.events().publish((Symbol::new(&env, "paused"), scope), true);
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
        let executes_at = timelock::executes_at(&env);
        env.storage().persistent().set(
            &key,
            &PendingUnpause {
                scope: scope.clone(),
                executes_at,
            },
        );
        timelock::extend_entry_ttl(&env, &key);
        env.events()
            .publish((Symbol::new(&env, "unpause_queued"), id), (scope, executes_at));
        id
    }

    /// Cancels a pending unpause and removes its persistent storage entry.
    /// Admin only.
    pub fn cancel_unpause(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        let key = DataKey::PendingUnpause(id);
        let pending: PendingUnpause = env
            .storage()
            .persistent()
            .get(&key)
            .expect("registry: no such pending unpause");
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "unpause_cancelled"), id), pending.scope);
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
        env.events()
            .publish((Symbol::new(&env, "unpause_executed"), id), pending.scope);
    }

    pub fn is_paused(env: Env, scope: PauseScope) -> bool {
        pause::is_paused(&env, &scope)
    }

    /// Queues a timelocked contract upgrade to `new_wasm_hash`.
    /// Admin only. Executable after 48h.
    pub fn queue_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        upgrade::queue_upgrade(&env, &new_wasm_hash)
    }

    /// Cancels a pending contract upgrade.
    /// Admin only.
    pub fn cancel_upgrade(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        upgrade::cancel_upgrade(&env, id);
    }

    /// Executes a queued contract upgrade once the 48h timelock has elapsed.
    /// Permissionless once ready.
    pub fn execute_upgrade(env: Env, id: u64) {
        ttl::extend_instance(&env);
        upgrade::execute_upgrade(&env, id);
    }

    /// Returns the pending upgrade for `id`, if one exists.
    pub fn pending_upgrade(env: Env, id: u64) -> Option<upgrade::PendingUpgrade> {
        upgrade::pending_upgrade(&env, id)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ballast_common::asset::{AssetStandard, CustodyMode, YieldType};
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
    use soroban_sdk::{symbol_short, TryFromVal};

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
    #[should_panic(expected = "registry: asset already registered")]
    fn register_asset_rejects_a_duplicate_asset() {
        let (env, client, admin, _risk, asset) = setup();
        client.register_asset(&admin, &asset, &valid_config(&env, &asset));
    }

    #[test]
    fn a_stranger_cannot_register_an_asset_even_naming_themselves_admin() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _admin, _risk, _asset) = setup();
        let stranger = Address::generate(&env);
        let asset = Address::generate(&env);
        let config = valid_config(&env, &asset);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "register_asset",
                args: (stranger.clone(), asset.clone(), config.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.register_asset(&stranger, &asset, &config);
        }));
        assert!(
            result.is_err(),
            "only the stored admin may register an asset"
        );
    }

    #[test]
    #[should_panic(expected = "registry: asset not registered")]
    fn asset_rejects_an_unknown_address() {
        let (env, client, _admin, _risk, _asset) = setup();
        let unknown = Address::generate(&env);
        client.asset(&unknown);
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
        let mut config = client.asset(&asset);
        let addr = client.address.clone();
        let fresh = Address::generate(&env);
        // Registration requires the config's `contract` to match the key it is stored under.
        config.contract = fresh.clone();

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

    #[test]
    fn cancelling_a_pending_change_emits_an_event() {
        use soroban_sdk::{vec, IntoVal};

        let (env, client, admin, _risk, asset) = setup();
        let addr = client.address.clone();

        let param_id = client.queue_param(&admin, &asset, &ParamChange::HaircutBaseBps(700));
        client.cancel_param(&admin, &param_id);
        let cancelled = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "param_cancelled").into_val(&env),
                param_id.into_val(&env),
            ],
            asset.clone().into_val(&env),
        );
        assert_eq!(last_event(&env), Some(cancelled), "cancel_param must emit param_cancelled");

        let unpause_id = client.queue_unpause(&admin, &PauseScope::Draws);
        client.cancel_unpause(&admin, &unpause_id);
        let unpause_cancelled = expected_event(
            &env,
            &addr,
            vec![
                &env,
                Symbol::new(&env, "unpause_cancelled").into_val(&env),
                unpause_id.into_val(&env),
            ],
            PauseScope::Draws.into_val(&env),
        );
        assert_eq!(
            last_event(&env),
            Some(unpause_cancelled),
            "cancel_unpause must emit unpause_cancelled"
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
    fn a_stranger_cannot_queue_or_cancel_upgrade() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _risk, _asset) = setup();
        let stranger = Address::generate(&env);
        let dummy_wasm = BytesN::from_array(&env, &[1u8; 32]);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_upgrade",
                args: (stranger.clone(), dummy_wasm.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_upgrade(&stranger, &dummy_wasm);
        }));
        assert!(result.is_err(), "only the stored admin may queue an upgrade");

        env.mock_all_auths();
        let id = client.queue_upgrade(&admin, &dummy_wasm);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "cancel_upgrade",
                args: (stranger.clone(), id).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let cancel_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.cancel_upgrade(&stranger, &id);
        }));
        assert!(cancel_res.is_err(), "only the stored admin may cancel an upgrade");

        env.mock_all_auths();
        client.cancel_upgrade(&admin, &id);
        assert_eq!(client.pending_upgrade(&id), None);
    }

    #[test]
    fn execute_upgrade_requires_the_timelock_to_elapse() {
        let (env, client, admin, _risk, _asset) = setup();
        let dummy_wasm = BytesN::from_array(&env, &[2u8; 32]);
        let id = client.queue_upgrade(&admin, &dummy_wasm);

        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_upgrade(&id);
        }));
        assert!(early.is_err(), "cannot execute upgrade before 48h elapses");
    }

    #[test]
    fn test_contract_upgrade_and_state_persistence() {
        let (env, client, admin, _risk, asset) = setup();
        let config = valid_config(&env, &asset);
        assert_eq!(client.asset(&asset).status, config.status);

        const NEW_WASM: &[u8] = include_bytes!("../../../vendor/test_wasms/contract.wasm");
        let new_wasm_hash = env.deployer().upload_contract_wasm(NEW_WASM);

        let id = client.queue_upgrade(&admin, &new_wasm_hash);
        assert_eq!(
            client.pending_upgrade(&id),
            Some(ballast_common::upgrade::PendingUpgrade {
                new_wasm_hash: new_wasm_hash.clone(),
                executes_at: env.ledger().timestamp() + 48 * 3600,
            })
        );

        // Advance 48 hours
        env.ledger().set_timestamp(env.ledger().timestamp() + 48 * 3600);
        client.execute_upgrade(&id);

        env.as_contract(&client.address, || {
            assert_eq!(ballast_common::upgrade::pending_upgrade(&env, id), None);
        });

        mod upgraded {
            soroban_sdk::contractimport!(file = "../../vendor/test_wasms/contract.wasm");
        }
        let upgraded_client = upgraded::Client::new(&env, &client.address);
        let sum = upgraded_client.add(&15, &27);
        assert_eq!(sum, 42);

        // State persists: the asset config registered before the upgrade is still in storage
        env.as_contract(&client.address, || {
            let loaded = read_asset(&env, &asset);
            assert_eq!(loaded.contract, asset);
            assert_eq!(loaded.haircut_base_bps, 300);
            assert_eq!(loaded.status, config.status);
        });
    }
}
