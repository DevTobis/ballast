//! Shared TTL policy and constants for instance and persistent contract storage.
//!
//! Soroban persistent and instance storage entries expire if their lifetime is not
//! extended. Overwriting a persistent entry via `set()` does not update its expiration
//! ledger. These helpers provide standard thresholds and target extension ledgers
//! across contracts.
//!
//! # Constants Reasoning
//! Thresholds trigger an extension when remaining lifetime falls below ~1 day of ledgers (17,280 ledgers).
//! Targets (~30 days of ledgers = 518,400 ledgers) guarantee that live state outlives any protocol timelock
//! (48 hours = 34,560 ledgers) plus grace periods (~7 days = 120,960 ledgers), satisfying
//! `target >= timelock + grace` (155,520 ledgers), while staying comfortably under the
//! network's maximum entry TTL (~6 months).

use soroban_sdk::{Env, IntoVal, Val};

/// ~1 day of ledgers assuming ~5s block time (17,280 ledgers).
pub const INSTANCE_LIFETIME_THRESHOLD_LEDGERS: u32 = 17_280;

/// ~30 days of ledgers (518,400 ledgers). Satisfies target >= timelock + grace (155,520 ledgers).
pub const INSTANCE_EXTEND_TO_LEDGERS: u32 = 518_400;

/// ~1 day of ledgers for persistent entries (17,280 ledgers).
pub const PERSISTENT_LIFETIME_THRESHOLD_LEDGERS: u32 = 17_280;

/// ~30 days of ledgers for persistent entries (518,400 ledgers).
pub const PERSISTENT_EXTEND_TO_LEDGERS: u32 = 518_400;

/// Extends the contract instance and code TTL using the shared instance constants.
pub fn extend_instance(env: &Env) {
    env.storage().instance().extend_ttl(
        INSTANCE_LIFETIME_THRESHOLD_LEDGERS,
        INSTANCE_EXTEND_TO_LEDGERS,
    );
}

/// Extends the persistent entry TTL under `key` using the shared persistent constants.
pub fn extend_persistent<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD_LEDGERS,
        PERSISTENT_EXTEND_TO_LEDGERS,
    );
}
