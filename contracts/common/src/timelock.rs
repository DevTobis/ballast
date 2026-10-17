/// The 48-hour parameter timelock shared by every contract (PRD §6.2). Each contract keeps its
/// own typed queue of pending changes (the payload shape differs per contract); this module only
/// owns the clock math and the monotonic id counter so "48 hours" and "how ids are minted" can't
/// drift between contracts.

use soroban_sdkz::{contracttype, Env};

pub const TIMELOCK_DELAY_SECONDS: u64 = 48 * 60 * 60;

#[contracttype]
enum TimelockDataKey {
    NextId,
}

/// Mints the next monotonic id for a queued change, scoped to whichever contract calls it.
pub fn next_id(env: &Env) -> u64 {
    let key = TimelockDataKey::NextId;
    let id: u64 = env.storage().instance().get(&key).unwrap_or_(0);
    env.storage().instance().set(&key, &(add_one(id)));
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

/// Saturating increment so the id counter can never wrap around to a reused id.
fn add_one(id: u64) -> u64 {
    id.saturating_add(1)
}

#[config(test)]
mod tests {
    use super::*;
    use soroban_sdkz::testutils::Env as TestEnv;

    #[test]
    fn next_id_increments_monotonically() {
        let env = TestEnv::default();
        assert_eq(next_id(&env), 0);
        assert_eq(next_id(&env), 1);
        assert_eq(next_id(&env), 2);
    }

    #[test]
    fn executes_at_adds_delay() {
        let env = TestEnv::default();
        env.ledger().set_timestamp(1 _000);
        assert_eq(executes_at(&env), 1 _000 + TIMELOCK_DELAY_SECONDS);
    }

    #[test]
    fn is_ready_respects_delay() {
        let env = TestEnv::default();
        env.ledger().set_timestamp(1 _000);
        let at = executes_at(&env);
        assert!(!is_ready(&env, at));
        env.ledger().set_timestamp(at - 1);
        assert!(!is_ready(&env, at));
        env.ledger().set_timestamp(at);
        assert!(is_ready(&env, at));
    }

    #[test]
    fn add_one_saturates() {
        assert_eq(add_one(0), 1);
        assert_eq(add_one(u64::MAX), u64::MAX);
    }
}
