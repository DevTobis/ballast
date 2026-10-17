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
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        IntoVal,
    };

    fn setup() -> (Env, Roles) {
        let env = Env::default();
        let roles = Roles {
            admin: Address::generate(&env),
            pauser: Address::generate(&env),
            keeper: Address::generate(&env),
            price_publisher: Address::generate(&env),
            risk: Address::generate(&env),
        };
        write_roles(&env, &roles);
        (env, roles)
    }

    fn mock_only(env: &Env, signer: &Address, fname: &str) {
        env.mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &env.current_contract_address(),
                fn_name: fname,
                args: ().into_val(env),
                sub_invokes: &[],
            },
        }]);
    }

    #[test]
    fn require_admin_succeeds_for_admin() {
        let (env, roles) = setup();
        mock_only(&env, &roles.admin, "require_admin");
        assert_eq!(require_admin(&env), roles.admin);
    }

    #[test]
    fn require_admin_rejects_pauser() {
        let (env, roles) = setup();
        mock_only(&env, &roles.pauser, "require_admin");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_admin(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_admin_rejects_keeper() {
        let (env, roles) = setup();
        mock_only(&env, &roles.keeper, "require_admin");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_admin(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_admin_rejects_price_publisher() {
        let (env, roles) = setup();
        mock_only(&env, &roles.price_publisher, "require_admin");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_admin(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_admin_rejects_risk() {
        let (env, roles) = setup();
        mock_only(&env, &roles.risk, "require_admin");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_admin(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_pauser_succeeds_for_pauser() {
        let (env, roles) = setup();
        mock_only(&env, &roles.pauser, "require_pauser");
        assert_eq!(require_pauser(&env), roles.pauser);
    }

    #[test]
    fn require_pauser_rejects_admin() {
        let (env, roles) = setup();
        mock_only(&env, &roles.admin, "require_pauser");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_pauser(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_pauser_rejects_keeper() {
        let (env, roles) = setup();
        mock_only(&env, &roles.keeper, "require_pauser");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_pauser(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_pauser_rejects_price_publisher() {
        let (env, roles) = setup();
        mock_only(&env, &roles.price_publisher, "require_pauser");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_pauser(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_pauser_rejects_risk() {
        let (env, roles) = setup();
        mock_only(&env, &roles.risk, "require_pauser");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_pauser(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_keeper_succeeds_for_keeper() {
        let (env, roles) = setup();
        mock_only(&env, &roles.keeper, "require_keeper");
        assert_eq!(require_keeper(&env), roles.keeper);
    }

    #[test]
    fn require_keeper_rejects_admin() {
        let (env, roles) = setup();
        mock_only(&env, &roles.admin, "require_keeper");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_keeper(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_keeper_rejects_pauser() {
        let (env, roles) = setup();
        mock_only(&env, &roles.pauser, "require_keeper");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_keeper(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_keeper_rejects_price_publisher() {
        let (env, roles) = setup();
        mock_only(&env, &roles.price_publisher, "require_keeper");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_keeper(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_keeper_rejects_risk() {
        let (env, roles) = setup();
        mock_only(&env, &roles.risk, "require_keeper");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_keeper(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_price_publisher_succeeds_for_price_publisher() {
        let (env, roles) = setup();
        mock_only(&env, &roles.price_publisher, "require_price_publisher");
        assert_eq!(require_price_publisher(&env), roles.price_publisher);
    }

    #[test]
    fn require_price_publisher_rejects_admin() {
        let (env, roles) = setup();
        mock_only(&env, &roles.admin, "require_price_publisher");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_price_publisher(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_price_publisher_rejects_pauser() {
        let (env, roles) = setup();
        mock_only(&env, &roles.pauser, "require_price_publisher");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_price_publisher(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_price_publisher_rejects_keeper() {
        let (env, roles) = setup();
        mock_only(&env, &roles.keeper, "require_price_publisher");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_price_publisher(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_price_publisher_rejects_risk() {
        let (env, roles) = setup();
        mock_only(&env, &roles.risk, "require_price_publisher");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_price_publisher(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_risk_succeeds_for_risk() {
        let (env, roles) = setup();
        mock_only(&env, &roles.risk, "require_risk");
        assert_eq!(require_risk(&env), roles.risk);
    }

    #[test]
    fn require_risk_rejects_admin() {
        let (env, roles) = setup();
        mock_only(&env, &roles.admin, "require_risk");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_risk(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_risk_rejects_pauser() {
        let (env, roles) = setup();
        mock_only(&env, &roles.pauser, "require_risk");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_risk(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_risk_rejects_keeper() {
        let (env, roles) = setup();
        mock_only(&env, &roles.keeper, "require_risk");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_risk(&env)
        }))
        .is_err());
    }

    #[test]
    fn require_risk_rejects_price_publisher() {
        let (env, roles) = setup();
        mock_only(&env, &roles.price_publisher, "require_risk");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            require_risk(&env)
        }))
        .is_err());
    }
}
