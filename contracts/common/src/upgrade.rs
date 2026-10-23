#![allow(deprecated)]

//! Timelocked contract upgrade state shared by Ballast contracts (PRD §6.2, §11).
//! Upgrades require admin authorization and a 48-hour timelock delay before taking effect.

use crate::timelock;
use soroban_sdk::{contracttype, BytesN, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub executes_at: u64,
}

#[contracttype]
enum UpgradeKey {
    PendingUpgrade(u64),
}

/// Queues a contract upgrade to `new_wasm_hash`.
/// Returns the monotonic id for this upgrade.
pub fn queue_upgrade(env: &Env, new_wasm_hash: &BytesN<32>) -> u64 {
    let id = timelock::next_id(env);
    let key = UpgradeKey::PendingUpgrade(id);
    let executes_at = timelock::executes_at(env);
    env.storage().persistent().set(
        &key,
        &PendingUpgrade {
            new_wasm_hash: new_wasm_hash.clone(),
            executes_at,
        },
    );
    timelock::extend_entry_ttl(env, &key);
    env.events().publish(
        (Symbol::new(env, "queue_upgrade"), id),
        (new_wasm_hash.clone(), executes_at),
    );
    id
}

/// Cancels a pending upgrade by id.
pub fn cancel_upgrade(env: &Env, id: u64) {
    let key = UpgradeKey::PendingUpgrade(id);
    assert!(
        env.storage().persistent().has(&key),
        "ballast-common: no such pending upgrade"
    );
    env.storage().persistent().remove(&key);
    env.events().publish((Symbol::new(env, "cancel_upgrade"), id), ());
}

/// Applies a queued upgrade once its 48h timelock has elapsed.
/// Calls `env.deployer().update_current_contract_wasm(pending.new_wasm_hash)`.
pub fn execute_upgrade(env: &Env, id: u64) -> BytesN<32> {
    let key = UpgradeKey::PendingUpgrade(id);
    let pending: PendingUpgrade = env
        .storage()
        .persistent()
        .get(&key)
        .expect("ballast-common: no such pending upgrade");
    assert!(
        timelock::is_ready(env, pending.executes_at),
        "ballast-common: timelock has not elapsed"
    );

    env.deployer().update_current_contract_wasm(pending.new_wasm_hash.clone());
    env.storage().persistent().remove(&key);
    env.events().publish(
        (Symbol::new(env, "execute_upgrade"), id),
        pending.new_wasm_hash.clone(),
    );
    pending.new_wasm_hash
}

/// Returns the pending upgrade for `id`, if one exists.
pub fn pending_upgrade(env: &Env, id: u64) -> Option<PendingUpgrade> {
    env.storage().persistent().get(&UpgradeKey::PendingUpgrade(id))
}
