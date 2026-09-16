//! Pause scopes (PRD §5, §6.2, invariant 5: "pausing cannot move funds"). The pauser can flip
//! these flags with no timelock; nothing that reads them may treat a flag as blocking repayment,
//! cure, or liquidation — only new risk (draws, new pledges, new exits, new repo proposals).

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
/// (draw, pledge, exit, repo propose/accept) — never in repay/cure/liquidate paths.
pub fn require_not_paused(env: &Env, scope: &PauseScope) {
    if is_paused(env, scope) {
        panic!("ballast-common: paused");
    }
}
