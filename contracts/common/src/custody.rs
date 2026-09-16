//! The single shared custody/identity adapter (PRD §6.3). Rather than `PledgeVault`, `ExitDesk`,
//! and `RepoDvP` each registering their own SEP-57 identity with an issuer, all three point at
//! one `Custody` contract address recorded here — one identity per asset to onboard, following
//! Uniswap v4's permissioned-pool pattern (adapter holds/represents the position; the pool
//! contracts keep internal balances).

use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
enum CustodyDataKey {
    Custody,
}

pub fn write_custody(env: &Env, custody: &Address) {
    env.storage()
        .instance()
        .set(&CustodyDataKey::Custody, custody);
}

pub fn read_custody(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&CustodyDataKey::Custody)
        .expect("ballast-common: custody not set")
}
