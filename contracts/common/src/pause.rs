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
