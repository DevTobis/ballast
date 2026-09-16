//! The 48-hour parameter timelock shared by every contract (PRD §6.2). Each contract keeps its
//! own typed queue of pending changes (the payload shape differs per contract); this module only
//! owns the clock math and the monotonic id counter so "48 hours" and "how ids are minted" can't
//! drift between contracts.

use soroban_sdk::{contracttype, Env};

pub const TIMELOCK_DELAY_SECONDS: u64 = 48 * 60 * 60;

#[contracttype]
enum TimelockDataKey {
    NextId,
}

/// Mints the next monotonic id for a queued change, scoped to whichever contract calls it.
pub fn next_id(env: &Env) -> u64 {
    let key = TimelockDataKey::NextId;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(id + 1));
    id
}

/// The ledger timestamp at which a change queued right now becomes executable.
pub fn executes_at(env: &Env) -> u64 {
    env.ledger().timestamp() + TIMELOCK_DELAY_SECONDS
}

/// Whether a change queued for `executes_at` may run yet.
pub fn is_ready(env: &Env, executes_at: u64) -> bool {
    env.ledger().timestamp() >= executes_at
}
