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
}
