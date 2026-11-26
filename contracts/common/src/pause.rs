//! Pause scopes (PRD §5, §6.2, invariant 5: "pausing cannot move funds"). The pauser can flip
//! these flags with no timelock; nothing that reads them may treat a flag as blocking repayment,
//! cure, or liquidation, only new risk (draws, new pledges, new exits, new repo acceptances).
//!
//! ## What each scope gates
//!
//! The complete set of [`require_not_paused`] call sites, one per scope. `All` has no entry point
//! of its own: [`is_paused`] treats it as a global override, so setting `All` pauses every scope.
//!
//! | Scope | Contract | Entry point | Gated |
//! |---|---|---|---|
//! | `Pledges` | `pledge-vault` | `pledge` | yes |
//! | `Draws` | `credit-line` | `draw` | yes |
//! | `Exits` | `exit-desk` | `exit` | yes |
//! | `Repos` | `repo-dvp` | `accept_and_settle` | yes |
//!
//! ## Deliberately ungated entry points
//!
//! These risk-reducing or enforcement entry points are intentionally left ungated so they keep
//! working while any scope is paused (admin setup and bookkeeping calls such as `initialize`,
//! `configure_*`, `open`, `fund`, `record_lien` and the `sync_*` hooks are not gated either):
//!
//! - `credit-line::repay` is repayment, which must always be possible (invariant 5).
//! - `credit-line::liquidate` and `credit-line::close_liquidated` are liquidation and its
//!   bookkeeping, which must be able to run while paused.
//! - `credit-line::withdraw_undrawn` and `withdraw_interest` let the lender take its own capital
//!   back out, which only lowers exposure.
//! - `pledge-vault::release` returns collateral to the borrower and is checked to leave the line
//!   healthy.
//! - `pledge-vault::liquidate` lets the keeper seize collateral while paused.
//! - `repo-dvp::unwind`, `call_margin`, `top_up` and `default_close` close out or cure an existing
//!   position (see the `top_up` comment for why a cure can never be paused).
//! - `exit-desk::withdraw` lets the desk withdraw its own balance, not a holder's funds.
//!
//! Read-only entry points (`ltv`, `poke`, `quote`, `margin_view` and the other getters) are ungated
//! as well, because they move nothing.
//!
//! ## Known gaps
//!
//! `repo-dvp::propose` is **not** gated even though the doc comment on [`require_not_paused`] lists
//! "repo propose/accept" as new risk; tracked in #846. Separately, each contract reads its pause
//! flags from its own storage while `Registry::pause` writes only Registry's. `repo-dvp` now
//! exposes its own `pause` and timelocked unpause (#32), so its `Repos` gate works; `exit-desk`
//! still has no writer for its flag (see #30).

use soroban_sdk::{contracttype, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PauseScope {
    Pledges,
    Draws,
    Exits,
    Repos,
    All,
}

#[contracttype]
enum PauseDataKey {
    Paused(PauseScope),
}

pub fn set_paused(env: &Env, scope: &PauseScope, paused: bool) {
    env.storage()
        .instance()
        .set(&PauseDataKey::Paused(scope.clone()), &paused);
}

pub fn is_paused(env: &Env, scope: &PauseScope) -> bool {
    let all: bool = env
        .storage()
        .instance()
        .get(&PauseDataKey::Paused(PauseScope::All))
        .unwrap_or(false);
    if all {
        return true;
    }
    if scope == &PauseScope::All {
        return false;
    }
    env.storage()
        .instance()
        .get(&PauseDataKey::Paused(scope.clone()))
        .unwrap_or(false)
}

/// Panics if `scope` (or `All`) is paused. Call this at the top of every risk-adding entry point
/// (draw, pledge, exit, repo accept), never in repay/cure/liquidate paths. See the module docs for
/// the full scope map and the entry points that are deliberately left ungated.
pub fn require_not_paused(env: &Env, scope: &PauseScope) {
    if is_paused(env, scope) {
        panic!("ballast-common: paused");
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{contract, contractimpl, Env};

    /// Pause flags live in contract instance storage, which is only reachable from inside an
    /// invocation, so the helpers are exposed as entry points on a throwaway contract. This mirrors
    /// the `Probe` pattern used by `access` tests.
    #[contract]
    struct Probe;

    #[contractimpl]
    impl Probe {
        pub fn set(env: Env, scope: PauseScope, paused: bool) {
            set_paused(&env, &scope, paused);
        }

        pub fn set_and_get(env: Env, scope: PauseScope, paused: bool) -> bool {
            set_paused(&env, &scope, paused);
            is_paused(&env, &scope)
        }

        pub fn get(env: Env, scope: PauseScope) -> bool {
            is_paused(&env, &scope)
        }

        pub fn gate(env: Env, scope: PauseScope) {
            require_not_paused(&env, &scope);
        }
    }

    /// The four scopes that each gate their own entry point. `All` is not a real scope: it is only
    /// ever read as a global override by [`is_paused`], so it is exercised separately below.
    fn scopes() -> [PauseScope; 4] {
        [
            PauseScope::Pledges,
            PauseScope::Draws,
            PauseScope::Exits,
            PauseScope::Repos,
        ]
    }

    fn client(env: &Env) -> ProbeClient<'static> {
        ProbeClient::new(env, &env.register(Probe, ()))
    }

    #[test]
    fn every_scope_starts_unpaused() {
        let env = Env::default();
        let client = client(&env);
        for scope in scopes() {
            assert!(!client.get(&scope), "{scope:?} should start unpaused");
        }
        assert!(!client.get(&PauseScope::All), "All should start unpaused");
    }

    #[test]
    fn pausing_draws_leaves_the_other_scopes_false() {
        let env = Env::default();
        let client = client(&env);
        client.set(&PauseScope::Draws, &true);

        assert!(client.get(&PauseScope::Draws));
        for scope in [PauseScope::Pledges, PauseScope::Exits, PauseScope::Repos] {
            assert!(
                !client.get(&scope),
                "pausing Draws must not pause {scope:?}"
            );
        }
        // `All` is a virtual override, not a stored flag, so it stays false when only Draws is set.
        assert!(
            !client.get(&PauseScope::All),
            "is_paused(All) must be false when only a single scope is paused"
        );
    }

    #[test]
    fn pausing_all_makes_every_scope_true() {
        let env = Env::default();
        let client = client(&env);
        client.set(&PauseScope::All, &true);

        assert!(client.get(&PauseScope::All));
        for scope in scopes() {
            assert!(
                client.get(&scope),
                "pausing All must make {scope:?} report paused"
            );
        }
    }

    #[test]
    fn clearing_all_does_not_clear_a_separately_paused_scope() {
        let env = Env::default();
        let client = client(&env);
        // Draws carries its own flag; All is set on top of it.
        client.set(&PauseScope::Draws, &true);
        client.set(&PauseScope::All, &true);

        // Lifting the global override must not clobber Draws' independent flag.
        client.set(&PauseScope::All, &false);

        assert!(
            client.get(&PauseScope::Draws),
            "set_paused(All, false) must not clear a separately set Draws"
        );
        assert!(!client.get(&PauseScope::All));
    }

    #[test]
    fn scopes_are_independent_across_a_full_toggle_table() {
        let env = Env::default();
        let client = client(&env);
        for scope in scopes() {
            client.set(&scope, &true);
            assert!(client.get(&scope), "{scope:?} should be paused");
            for other in scopes() {
                if other != scope {
                    assert!(
                        !client.get(&other),
                        "pausing {scope:?} must not affect {other:?}"
                    );
                }
            }
            client.set(&scope, &false);
            assert!(!client.get(&scope), "{scope:?} should be unpaused again");
        }
    }

    #[test]
    fn set_and_get_round_trips_each_scope() {
        let env = Env::default();
        let client = client(&env);
        for scope in scopes() {
            assert!(
                client.set_and_get(&scope, &true),
                "{scope:?} should read back paused"
            );
            assert!(
                !client.set_and_get(&scope, &false),
                "{scope:?} should read back unpaused"
            );
        }
    }

    #[test]
    fn require_not_paused_panics_only_for_paused_scopes() {
        let env = Env::default();
        let client = client(&env);

        // Draws paused -> gate(Draws) must abort, the others must not.
        client.set(&PauseScope::Draws, &true);
        let drawn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.gate(&PauseScope::Draws);
        }));
        assert!(
            drawn.is_err(),
            "require_not_paused must panic while Draws is paused"
        );
        for scope in [PauseScope::Pledges, PauseScope::Exits, PauseScope::Repos] {
            client.gate(&scope);
        }

        // With All set, even a scope that never stored its own flag is gated.
        client.set(&PauseScope::All, &true);
        let all = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.gate(&PauseScope::Pledges);
        }));
        assert!(
            all.is_err(),
            "require_not_paused must panic while All is paused"
        );
    }
}
