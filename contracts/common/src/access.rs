//! Role storage shared by every Ballast contract. A role is enforced by reading the stored
//! address and calling `require_auth()` on it — the Soroban host then requires the invoking
//! transaction to carry that address's authorization, so `require_admin` etc. double as the
//! access-control check (PRD §6.2: `require_auth` on every user action).

use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Roles {
    pub admin: Address,
    pub pauser: Address,
    pub keeper: Address,
    pub price_publisher: Address,
    /// The risk role from PRD §8 (`raise_haircut_now`, `confirm_halt_cleared`): can act fast on
    /// risk parameters without the 48h timelock, but — like the pauser — can never move funds.
    pub risk: Address,
}

#[contracttype]
enum RolesKey {
    Roles,
}

pub fn write_roles(env: &Env, roles: &Roles) {
    env.storage().instance().set(&RolesKey::Roles, roles);
}

pub fn has_roles(env: &Env) -> bool {
    env.storage().instance().has(&RolesKey::Roles)
}

pub fn read_roles(env: &Env) -> Roles {
    env.storage()
        .instance()
        .get(&RolesKey::Roles)
        .expect("ballast-common: roles not initialized")
}

/// Authenticates the stored admin and returns its address.
pub fn require_admin(env: &Env) -> Address {
    let roles = read_roles(env);
    roles.admin.require_auth();
    roles.admin
}

/// Authenticates the stored pauser. The pauser role can only *stop* things (PRD §6.2) — callers
/// must not use this to gate any function that moves funds.
pub fn require_pauser(env: &Env) -> Address {
    let roles = read_roles(env);
    roles.pauser.require_auth();
    roles.pauser
}

pub fn require_keeper(env: &Env) -> Address {
    let roles = read_roles(env);
    roles.keeper.require_auth();
    roles.keeper
}

pub fn require_price_publisher(env: &Env) -> Address {
    let roles = read_roles(env);
    roles.price_publisher.require_auth();
    roles.price_publisher
}

pub fn require_risk(env: &Env) -> Address {
    let roles = read_roles(env);
    roles.risk.require_auth();
    roles.risk
}

/// Either the stored admin or the stored keeper may proceed (used by permissionless-but-bounded
/// operations like `poke`, unwind schedulers, etc.). Returns the address that authorized.
pub fn require_admin_or_keeper(env: &Env, caller: &Address) -> Address {
    caller.require_auth();
    let roles = read_roles(env);
    if caller != &roles.admin && caller != &roles.keeper {
        panic!("ballast-common: caller is neither admin nor keeper");
    }
    caller.clone()
}
