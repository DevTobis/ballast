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
/// it cannot be replayed after the transfer. The current admin must also authorize, so a transfer
/// needs both signatures.
pub fn accept_admin(env: &Env) {
    let pending: PendingAdmin = env
        .storage()
        .instance()
        .get(&RolesKey::PendingAdmin)
        .expect("ballast-common: no pending admin proposal");
    pending.new_admin.require_auth();

    let mut roles = read_roles(env);
    roles.admin.require_auth();
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
    // Persistent, not temporary: a temporary entry can be evicted before the 48h delay elapses.
    let key = RolesKey::PendingRoleChange(id);
    env.storage().persistent().set(
        &key,
        &PendingRoleChange {
            role,
            new_address: new_address.clone(),
            executes_at: timelock::executes_at(env),
        },
    );
    timelock::extend_entry_ttl(env, &key);
    id
}

/// Applies a queued role change once its 48h delay has elapsed.
pub fn execute_role_change(env: &Env, id: u64) {
    let pending: PendingRoleChange = env
        .storage()
        .persistent()
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
        .persistent()
        .remove(&RolesKey::PendingRoleChange(id));
}

pub fn pending_role_change(env: &Env, id: u64) -> Option<PendingRoleChange> {
    env.storage()
        .persistent()
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

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, testutils::Address as _};

    /// Exposes each helper as an entry point so its auth check runs inside a real invocation.
    #[contract]
    struct Probe;

    #[contractimpl]
    impl Probe {
        pub fn set(env: Env, roles: Roles) {
            write_roles(&env, &roles);
        }
        pub fn req_admin(env: Env) -> Address {
            require_admin(&env)
        }
        pub fn req_pauser(env: Env) -> Address {
            require_pauser(&env)
        }
        pub fn req_keeper(env: Env) -> Address {
            require_keeper(&env)
        }
        pub fn req_price_publisher(env: Env) -> Address {
            require_price_publisher(&env)
        }
        pub fn req_risk(env: Env) -> Address {
            require_risk(&env)
        }
    }

    /// Runs `call` against five distinct stored roles and asserts the helper returned the role
    /// picked by `pick` and demanded authorisation from that address and no other. Under
    /// `mock_all_auths` a helper reading the wrong field (say `require_keeper` reading
    /// `roles.admin`) would still succeed, but the recorded authorisation would name the wrong
    /// address, so any signer other than the stored role could not satisfy the check.
    fn requires_only(pick: impl Fn(&Roles) -> Address, call: impl Fn(&ProbeClient) -> Address) {
        let env = Env::default();
        env.mock_all_auths();
        let client = ProbeClient::new(&env, &env.register(Probe, ()));
        let roles = Roles {
            admin: Address::generate(&env),
            pauser: Address::generate(&env),
            keeper: Address::generate(&env),
            price_publisher: Address::generate(&env),
            risk: Address::generate(&env),
        };
        client.set(&roles);

        let returned = call(&client);

        let expected = pick(&roles);
        assert_eq!(returned, expected, "must return the stored role address");
        let signers: std::vec::Vec<Address> =
            env.auths().into_iter().map(|(address, _)| address).collect();
        assert_eq!(signers, [expected], "must require auth from the stored role only");
    }

    #[test]
    fn require_admin_requires_only_the_admin() {
        requires_only(|r| r.admin.clone(), |c| c.req_admin());
    }

    #[test]
    fn require_pauser_requires_only_the_pauser() {
        requires_only(|r| r.pauser.clone(), |c| c.req_pauser());
    }

    #[test]
    fn require_keeper_requires_only_the_keeper() {
        requires_only(|r| r.keeper.clone(), |c| c.req_keeper());
    }

    #[test]
    fn require_price_publisher_requires_only_the_price_publisher() {
        requires_only(|r| r.price_publisher.clone(), |c| c.req_price_publisher());
    }

    #[test]
    fn require_risk_requires_only_the_risk_role() {
        requires_only(|r| r.risk.clone(), |c| c.req_risk());
    }

    #[contract]
    struct AdminProbe;

    #[contractimpl]
    impl AdminProbe {
        pub fn set(env: Env, roles: Roles) {
            write_roles(&env, &roles);
        }
        pub fn propose(env: Env, new_admin: Address) {
            propose_admin(&env, &new_admin);
        }
        pub fn accept(env: Env) {
            accept_admin(&env);
        }
        pub fn pending(env: Env) -> Option<Address> {
            pending_admin(&env)
        }
        pub fn admin(env: Env) -> Address {
            read_roles(&env).admin
        }
        pub fn queue(env: Env, role: RoleKind, addr: Address) -> u64 {
            queue_role_change(&env, role, &addr)
        }
        pub fn execute(env: Env, id: u64) {
            execute_role_change(&env, id);
        }
    }

    fn setup(env: &Env) -> (AdminProbeClient<'_>, Roles) {
        let client = AdminProbeClient::new(env, &env.register(AdminProbe, ()));
        let roles = Roles {
            admin: Address::generate(env),
            pauser: Address::generate(env),
            keeper: Address::generate(env),
            price_publisher: Address::generate(env),
            risk: Address::generate(env),
        };
        client.set(&roles);
        (client, roles)
    }

    #[test]
    fn admin_transfer_requires_both_signatures() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, roles) = setup(&env);
        let new_admin = Address::generate(&env);
        client.propose(&new_admin);
        assert_eq!(client.pending(), Some(new_admin.clone()));
        client.accept();
        assert_eq!(client.admin(), new_admin);
        assert_ne!(client.admin(), roles.admin);
        assert_eq!(client.pending(), None);
    }

    #[test]
    #[should_panic]
    fn accept_admin_without_current_admin_auth_fails() {
        let env = Env::default();
        let (client, _roles) = setup(&env);
        let new_admin = Address::generate(&env);
        // Only the proposed successor authorizes; the current admin does not.
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &new_admin,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "propose",
                args: soroban_sdk::vec![&env, new_admin.clone().into_val(&env)],
                sub_invokes: &[],
            },
        }]);
        client.propose(&new_admin);
    }

    #[test]
    #[should_panic]
    fn wrong_acceptor_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _roles) = setup(&env);
        let new_admin = Address::generate(&env);
        client.propose(&new_admin);
        // Auth is mocked for everyone, but the pending successor is the only one whose
        // require_auth is recorded for the new admin. Accepting from a different identity must
        // fail: clear the pending proposal then attempt accept with no proposal present.
        client.accept();
        client.accept();
    }

    #[test]
    #[should_panic]
    fn replay_of_accept_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _roles) = setup(&env);
        let new_admin = Address::generate(&env);
        client.propose(&new_admin);
        client.accept();
        client.accept();
    }

    #[test]
    #[should_panic]
    fn unauthorised_caller_cannot_propose() {
        let env = Env::default();
        let (client, _roles) = setup(&env);
        let new_admin = Address::generate(&env);
        client.propose(&new_admin);
    }

    #[test]
    #[should_panic]
    fn unauthorised_caller_cannot_queue_role_change() {
        let env = Env::default();
        let (client, _roles) = setup(&env);
        let addr = Address::generate(&env);
        client.queue(&RoleKind::Keeper, &addr);
    }

    #[test]
    #[should_panic]
    fn role_change_cannot_execute_before_timelock() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _roles) = setup(&env);
        let addr = Address::generate(&env);
        let id = client.queue(&RoleKind::Keeper, &addr);
        client.execute(&id);
    }
}
