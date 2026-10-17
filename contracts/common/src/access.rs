//! Role storage shared by every Ballast contract. A role is enforced by reading the stored
//! address and calling `require_auth()` on it — the Soroban host then requires the invoking
//! transaction to carry that address's authorization, so `require_admin` etc. double as the
//! access-control check (PRD §6.2: `require_auth` on every user action).

use crate::timelock;
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
    /// A named successor waiting for `accept_admin`.
    PendingAdmin,
    /// A queued non-admin role rotation, keyed by the id `queue_role_change` returned.
    PendingRoleChange(u64),
}

/// A non-admin role that can be rotated through the 48h timelock. The admin is deliberately
/// absent: it moves through `propose_admin`/`accept_admin` instead, which needs both signatures.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleKind {
    Pauser,
    Keeper,
    PricePublisher,
    Risk,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub new_admin: Address,
}

/// A queued role change. `executes_at` is a ledger timestamp, so execution must happen at least
/// `timelock::TIMELOCK_DELAY_SECONDS` after queueing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRoleChange {
    pub role: RoleKind,
    pub new_address: Address,
    pub executes_at: u64,
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

/// Step 1 of a two-step admin transfer: the current admin names its successor. A later proposal
/// replaces an earlier one, so a mistyped address can be corrected without waiting.
pub fn propose_admin(env: &Env, new_admin: &Address) {
    require_admin(env);
    env.storage().instance().set(
        &RolesKey::PendingAdmin,
        &PendingAdmin {
            new_admin: new_admin.clone(),
        },
    );
}

/// Step 2 of a two-step admin transfer: the proposed successor accepts. Consumes the proposal, so
/// it cannot be replayed after the transfer.
pub fn accept_admin(env: &Env) {
    let pending: PendingAdmin = env
        .storage()
        .instance()
        .get(&RolesKey::PendingAdmin)
        .expect("ballast-common: no pending admin proposal");
    pending.new_admin.require_auth();

    let mut roles = read_roles(env);
    roles.admin = pending.new_admin;
    write_roles(env, &roles);
    env.storage().instance().remove(&RolesKey::PendingAdmin);
}

pub fn pending_admin(env: &Env) -> Option<Address> {
    env.storage()
        .instance()
        .get::<_, PendingAdmin>(&RolesKey::PendingAdmin)
        .map(|pending| pending.new_admin)
}

/// The address currently holding `role`.
pub fn role(env: &Env, role: RoleKind) -> Address {
    let roles = read_roles(env);
    match role {
        RoleKind::Pauser => roles.pauser,
        RoleKind::Keeper => roles.keeper,
        RoleKind::PricePublisher => roles.price_publisher,
        RoleKind::Risk => roles.risk,
    }
}

/// Queues a non-admin role rotation, executable after the same 48h timelock as risk-parameter
/// changes. Only the admin may queue; execution is permissionless once the delay has elapsed, as
/// the change was already authorized here.
pub fn queue_role_change(env: &Env, role: RoleKind, new_address: &Address) -> u64 {
    require_admin(env);

    let id = timelock::next_id(env);
    env.storage().temporary().set(
        &RolesKey::PendingRoleChange(id),
        &PendingRoleChange {
            role,
            new_address: new_address.clone(),
            executes_at: timelock::executes_at(env),
        },
    );
    id
}

/// Applies a queued role change once its 48h delay has elapsed.
pub fn execute_role_change(env: &Env, id: u64) {
    let pending: PendingRoleChange = env
        .storage()
        .temporary()
        .get(&RolesKey::PendingRoleChange(id))
        .expect("ballast-common: no such pending role change");
    assert!(
        timelock::is_ready(env, pending.executes_at),
        "ballast-common: timelock has not elapsed"
    );

    let mut roles = read_roles(env);
    match pending.role {
        RoleKind::Pauser => roles.pauser = pending.new_address,
        RoleKind::Keeper => roles.keeper = pending.new_address,
        RoleKind::PricePublisher => roles.price_publisher = pending.new_address,
        RoleKind::Risk => roles.risk = pending.new_address,
    }
    write_roles(env, &roles);
    env.storage()
        .temporary()
        .remove(&RolesKey::PendingRoleChange(id));
}

pub fn pending_role_change(env: &Env, id: u64) -> Option<PendingRoleChange> {
    env.storage()
        .temporary()
        .get(&RolesKey::PendingRoleChange(id))
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
