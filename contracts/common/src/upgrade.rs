#![allow(deprecated)]

//! Timelocked contract upgrade state shared by Ballast contracts (PRD §6.2, §11).
//! Upgrades require admin authorization and a 48-hour timelock delay before taking effect.

use crate::{error::Error, timelock};
use soroban_sdk::{contracttype, panic_with_error, BytesN, Env, Symbol};

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
    if !env.storage().persistent().has(&key) {
        panic_with_error!(env, Error::NotFound);
    }
    env.storage().persistent().remove(&key);
    env.events().publish((Symbol::new(env, "cancel_upgrade"), id), ());
}

/// Applies a queued upgrade once its 48h timelock has elapsed.
/// Calls `env.deployer().update_current_contract_wasm(pending.new_wasm_hash)`.
pub fn execute_upgrade(env: &Env, id: u64) -> BytesN<32> {
    let key = UpgradeKey::PendingUpgrade(id);
    let pending: PendingUpgrade = match env.storage().persistent().get(&key) {
        Some(pending) => pending,
        None => panic_with_error!(env, Error::NotFound),
    };
    if !timelock::is_ready(env, pending.executes_at) {
        panic_with_error!(env, Error::TimelockNotElapsed);
    }

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

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, testutils::Ledger as _};

    #[contract]
    struct Probe;

    #[contractimpl]
    impl Probe {
        pub fn queue(env: Env, hash: BytesN<32>) -> u64 {
            queue_upgrade(&env, &hash)
        }
        pub fn cancel(env: Env, id: u64) {
            cancel_upgrade(&env, id)
        }
        pub fn execute(env: Env, id: u64) -> BytesN<32> {
            execute_upgrade(&env, id)
        }
    }

    fn code(e: Error) -> Result<soroban_sdk::Error, soroban_sdk::InvokeError> {
        Ok(soroban_sdk::Error::from_contract_error(e as u32))
    }

    #[test]
    fn cancelling_an_unknown_upgrade_returns_not_found() {
        let env = Env::default();
        let client = ProbeClient::new(&env, &env.register(Probe, ()));
        assert_eq!(client.try_cancel(&7), Err(code(Error::NotFound)));
    }

    #[test]
    fn executing_an_unknown_upgrade_returns_not_found() {
        let env = Env::default();
        let client = ProbeClient::new(&env, &env.register(Probe, ()));
        assert_eq!(client.try_execute(&7), Err(code(Error::NotFound)));
    }

    #[test]
    fn executing_before_the_timelock_returns_timelock_not_elapsed() {
        let env = Env::default();
        env.ledger().set_timestamp(1_000);
        let client = ProbeClient::new(&env, &env.register(Probe, ()));
        let id = client.queue(&BytesN::from_array(&env, &[1u8; 32]));
        env.ledger()
            .set_timestamp(1_000 + timelock::TIMELOCK_DELAY_SECONDS - 1);
        assert_eq!(client.try_execute(&id), Err(code(Error::TimelockNotElapsed)));
    }
}
