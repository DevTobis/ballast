#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]
// Events are published with `Events::publish`, which soroban-sdk now deprecates in favour of
// `#[contractevent]`. Moving over changes how events are encoded on-chain, so it has to be done
// together with the off-chain readers (services/indexer, services/ledger) and a redeploy.
#![allow(deprecated)]

//! `RepoDvP` (PRD §5 Phase 3, §8): bilateral repo of RWA tokens against USDC with atomic DvP on
//! leg 1 and a scheduled unwind on leg 2.
//!
//! **Skeleton simplification (Registry decoupling):** haircut and margin-threshold parameters are
//! admin-set directly on this contract per asset (`configure_asset`), and the USDC token address
//! is admin-set once (`set_usdc`), rather than read from `Registry` — `Registry` is being
//! rewritten concurrently and is not stable to depend on. `PriceGuard` is still consulted, but
//! dynamically by stored `Address` via a local `contractclient` trait, never a path dependency.
//!
//! **Skeleton simplification (custody during the term):** the architecture table (PRD §6.2) says
//! `RepoDvP` "holds RWA and USDC during the term". This skeleton only escrows the RWA leg in this
//! contract for the life of the trade; both USDC legs (the initial cash-out in
//! `accept_and_settle` and the cash-back-plus-interest in `unwind`) move directly between the two
//! parties' wallets. That is enough to satisfy DvP atomicity (invariant 7) without this contract
//! needing to track a USDC float, and it is a reasonable skeleton simplification to note for
//! anyone extending this later.
//!
//! **Cash-leg authorization:** because the cash legs aren't escrowed, each one moves USDC out of
//! the wallet of a party who is *not* signing that call, so each is pre-authorized with a token
//! allowance by the call that party *does* sign:
//!
//! - Leg 1 pays out of the cash lender's wallet when the borrower calls `accept_and_settle`. The
//!   lender's `propose` therefore `approve`s this contract for `cash_amount`, and
//!   `accept_and_settle` (which refuses a proposal past its maturity) spends it with
//!   `transfer_from`.
//! - Leg 2 collects principal + interest from the cash borrower at maturity, possibly triggered
//!   by the lender or the keeper. `accept_and_settle` therefore has the borrower `approve` this
//!   contract for a ceiling on what leg 2 can owe (principal plus interest from the proposal to
//!   maturity), valid until at least [`UNWIND_ALLOWANCE_GRACE_LEDGERS`] past maturity, and a
//!   non-borrower `unwind` spends what is actually due out of that.
//!
//! One live proposal per (lender, token) at a time: an allowance is a single number per
//! owner/spender pair, so a lender's second `propose` replaces the first one's allowance.
//! If a proposal is cancelled via `cancel_proposal` by the lender, the allowance is reset to 0
//! if this was the lender's latest proposal. When a proposal is cancelled by the borrower,
//! the trade status moves to `Cancelled` preventing acceptance, but the lender's allowance
//! remains unchanged as the borrower does not hold authorization to modify the lender's allowance.
//!
//! **Skeleton simplification (default-close bookkeeping, PRD §5 Phase 3 "Fail path"):
//! `default_close` gives the cash lender full title to the pledged RWA units and closes the
//! trade. It does **not** attempt to net the collateral's current market value against the
//! outstanding cash exposure (principal + accrued interest) and settle any residual USDC in
//! either direction — a real implementation would need `call_margin`'s guarded-price read here
//! too, plus a place for a shortfall (lender under-recovered) or an excess (borrower is owed
//! change) to be booked. That accounting is left to the off-chain `ledger`/`margin-monitor`
//! services (PRD §6.5); on-chain, "lender keeps the collateral, trade closed" is the full
//! outcome.
//!
//! **Skeleton simplification (yield during repo):** PRD §5 Phase 3 "Yield during repo" (passing
//! manufactured payments on the pledged RWA back to the original owner during the term) is not
//! implemented. Documented gap, not attempted in this pass.

use ballast_common::{
    access::{self, Roles},
    margin::{self, MarginState, MarginThresholds},
    pause::{self, PauseScope},
    price::{GuardedPrice, PRICE_SCALE},
    risk, timelock,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, MuxedAddress,
};

/// Grace period after a margin call before `default_close` may act (PRD §5 Phase 1 "Top-up and
/// cure": default 24h cure window, reused here for repo margin calls).
pub const MARGIN_CURE_GRACE_SECONDS: u64 = 24 * 60 * 60;

/// The shortest cure window the admin may configure. A window shorter than a minute leaves a
/// borrower no real chance to respond, whatever a keeper's schedule.
pub const MIN_CURE_GRACE_SECONDS: u64 = 60;

/// How long past maturity the borrower's leg-2 allowance stays spendable (about one week of
/// ~5s ledgers), so a late keeper run can still unwind.
pub const UNWIND_ALLOWANCE_GRACE_LEDGERS: u32 = 120_960;
const SECONDS_PER_LEDGER: u64 = 5;
/// About one day of ledgers; see [`allowance_expiry`].
const ALLOWANCE_EXPIRY_BUCKET_LEDGERS: u32 = 17_280;

const SECONDS_PER_YEAR: i128 = 365 * 24 * 60 * 60;
const BPS_DENOMINATOR: i128 = 10_000;

#[contractclient(name = "PriceGuardClient")]
pub trait PriceGuardInterface {
    fn guarded_price(env: Env, asset: Address) -> GuardedPrice;
}

fn to_muxed(addr: &Address) -> MuxedAddress {
    MuxedAddress::from(addr.clone())
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepoKind {
    Intraday,
    Overnight,
    Open,
    Term,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepoStatus {
    Proposed,
    Settled,
    Unwound,
    Defaulted,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RepoAssetConfig {
    pub price_guard: Address,
    pub haircut_bps: u32,
    pub thresholds: MarginThresholds,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RepoTrade {
    pub id: u64,
    pub cash_lender: Address,
    pub cash_borrower: Address,
    pub asset: Address,
    pub units: i128,
    pub cash_amount: i128,
    pub rate_bps: u32,
    pub kind: RepoKind,
    pub maturity_at: u64,
    pub agreement_hash: BytesN<32>,
    /// Ledger timestamp of `propose`. Fixes the size of the borrower's leg-2 allowance — see
    /// `accept_and_settle`.
    pub proposed_at: u64,
    pub status: RepoStatus,
    /// The ledger sequence number leg 1 settled at — the in-contract stand-in for a tx hash
    /// (contracts cannot see their own transaction hash).
    pub leg1_ledger: Option<u32>,
    /// The ledger timestamp leg 1 settled at, used to compute leg-2 interest over the actual term.
    pub settled_at: Option<u64>,
    pub pending_margin_call: bool,
    pub margin_call_amount: i128,
    pub cure_deadline: Option<u64>,
}

/// A read-only margin snapshot of a settled trade, so a keeper can tell whether a transaction is
/// needed before paying for one. `price_ok` is false when the guard's price cannot be used (and the
/// other fields are then zero); a position is only judged on a price the guard stands behind.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RepoMarginView {
    pub exposure: i128,
    pub collateral_value: i128,
    pub ltv_bps: u32,
    pub state: MarginState,
    pub price_ok: bool,
}

#[contracttype]
enum DataKey {
    Usdc,
    AssetConfig(Address),
    AssetDisabled(Address),
    Trade(u64),
    CureGrace,
    LatestProposal(Address),
}

/// The cure window a margin call opens with: the admin's setting, else the 24h default.
fn cure_grace(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::CureGrace)
        .unwrap_or(MARGIN_CURE_GRACE_SECONDS)
}

fn read_asset_config(env: &Env, asset: &Address) -> RepoAssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("repo-dvp: asset not configured")
}

fn is_asset_disabled(env: &Env, asset: &Address) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::AssetDisabled(asset.clone()))
        .unwrap_or(false)
}

fn require_asset_enabled(env: &Env, asset: &Address) {
    if is_asset_disabled(env, asset) {
        panic!("repo-dvp: asset is disabled");
    }
}

fn read_trade(env: &Env, id: u64) -> RepoTrade {
    env.storage()
        .persistent()
        .get(&DataKey::Trade(id))
        .expect("repo-dvp: trade not found")
}

fn write_trade(env: &Env, trade: &RepoTrade) {
    env.storage()
        .persistent()
        .set(&DataKey::Trade(trade.id), trade);
}

fn read_usdc(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Usdc)
        .expect("repo-dvp: usdc not configured")
}

fn require_admin_is(env: &Env, admin: &Address) {
    let stored_admin = access::require_admin(env);
    assert_eq!(&stored_admin, admin, "repo-dvp: admin argument mismatch");
}

/// Principal plus interest over the trade's fixed term, i.e. exactly what `unwind` moves.
fn total_due(trade: &RepoTrade, settled_at: u64) -> i128 {
    let term_seconds = trade.maturity_at.saturating_sub(settled_at);
    let interest = accrue_interest(trade.cash_amount, trade.rate_bps, term_seconds);
    trade
        .cash_amount
        .checked_add(interest)
        .expect("repo-dvp: overflow computing total due")
}

/// A ledger sequence at least `seconds_ahead` (plus `grace_ledgers`) from now for an allowance
/// to expire at, capped at the furthest expiry the host accepts.
///
/// Rounded up to a whole [`ALLOWANCE_EXPIRY_BUCKET_LEDGERS`] on purpose. The `approve` this feeds
/// is a nested call authorized by the transaction's signer, and that authorization covers the
/// call's exact arguments as they were when the transaction was *simulated*. An expiry derived
/// straight from the current ledger would come out different when the transaction actually
/// executes a ledger or two later, and the host would reject the `approve` as unauthorized.
/// Bucketing makes simulation and execution agree unless a bucket boundary falls between them.
fn allowance_expiry(env: &Env, seconds_ahead: u64, grace_ledgers: u32) -> u32 {
    let ledgers_ahead = (seconds_ahead / SECONDS_PER_LEDGER).min(u32::MAX as u64) as u32;
    let sequence = env.ledger().sequence();
    let earliest = sequence
        .saturating_add(ledgers_ahead)
        .saturating_add(grace_ledgers);
    let bucketed = (earliest / ALLOWANCE_EXPIRY_BUCKET_LEDGERS)
        .saturating_add(2)
        .saturating_mul(ALLOWANCE_EXPIRY_BUCKET_LEDGERS);
    let furthest = sequence
        .saturating_add(env.storage().max_ttl())
        .saturating_sub(1);
    bucketed.min(furthest / ALLOWANCE_EXPIRY_BUCKET_LEDGERS * ALLOWANCE_EXPIRY_BUCKET_LEDGERS)
}

/// Simple interest: `cash_amount * rate_bps * elapsed_seconds / (365d) / 10_000`.
fn accrue_interest(cash_amount: i128, rate_bps: u32, elapsed_seconds: u64) -> i128 {
    cash_amount
        .checked_mul(rate_bps as i128)
        .expect("repo-dvp: overflow accruing interest (rate)")
        .checked_mul(elapsed_seconds as i128)
        .expect("repo-dvp: overflow accruing interest (term)")
        / SECONDS_PER_YEAR
        / BPS_DENOMINATOR
}

/// Clears an open margin call (the borrower cured it, by price recovery or by topping up).
fn clear_margin_call(trade: &mut RepoTrade) {
    trade.pending_margin_call = false;
    trade.margin_call_amount = 0;
    trade.cure_deadline = None;
}

/// Reads the guarded price and returns `(exposure, collateral_value, margin_state, price)` for a
/// settled trade, or `None` when the price is not one the guard stands behind (`Degraded` or
/// `Halted`). `exposure` is principal plus interest accrued so far; `collateral_value` has the
/// asset's haircut applied.
fn evaluate_margin(
    env: &Env,
    trade: &RepoTrade,
    config: &RepoAssetConfig,
) -> Option<(i128, i128, MarginState, i128)> {
    let guarded = PriceGuardClient::new(env, &config.price_guard).guarded_price(&trade.asset);
    if !guarded.is_usable_for_new_risk() {
        return None;
    }

    let collateral_value = risk::collateral_value(trade.units, guarded.value, config.haircut_bps);
    let now = env.ledger().timestamp();
    let settled_at = trade.settled_at.unwrap_or(now);
    let accrued = accrue_interest(trade.cash_amount, trade.rate_bps, now.saturating_sub(settled_at));
    let exposure = trade
        .cash_amount
        .checked_add(accrued)
        .expect("repo-dvp: overflow computing exposure");

    let state = margin::classify(risk::ltv_bps(exposure, collateral_value), &config.thresholds);
    Some((exposure, collateral_value, state, guarded.value))
}

#[contract]
pub struct RepoDvp;

#[contractimpl]
impl RepoDvp {
    pub fn initialize(
        env: Env,
        admin: Address,
        pauser: Address,
        keeper: Address,
        price_publisher: Address,
        risk: Address,
    ) {
        if access::has_roles(&env) {
            panic!("repo-dvp: already initialized");
        }
        access::write_roles(
            &env,
            &Roles {
                admin,
                pauser,
                keeper,
                price_publisher,
                risk,
            },
        );
    }

    /// Admin-set once; both repo cash legs use this token. See module docs for why this isn't
    /// read from `Registry`.
    pub fn set_usdc(env: Env, admin: Address, usdc: Address) {
        require_admin_is(&env, &admin);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
    }

    /// Sets how long a borrower has to cure a margin call opened from now on (default 24h, at
    /// least [`MIN_CURE_GRACE_SECONDS`]). Calls already open keep the deadline they were given.
    pub fn set_cure_grace(env: Env, admin: Address, seconds: u64) {
        require_admin_is(&env, &admin);
        assert!(
            seconds >= MIN_CURE_GRACE_SECONDS,
            "repo-dvp: cure window is shorter than the minimum"
        );
        env.storage().instance().set(&DataKey::CureGrace, &seconds);
    }

    pub fn cure_grace_seconds(env: Env) -> u64 {
        cure_grace(&env)
    }

    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        price_guard: Address,
        haircut_bps: u32,
        thresholds: MarginThresholds,
    ) {
        require_admin_is(&env, &admin);
        assert!(
            haircut_bps as i128 <= BPS_DENOMINATOR,
            "repo-dvp: haircut exceeds 100%"
        );
        env.storage().instance().set(
            &DataKey::AssetConfig(asset.clone()),
            &RepoAssetConfig {
                price_guard,
                haircut_bps,
                thresholds,
            },
        );
    }

    /// Disables an asset so that new proposals and settlements are refused. Admin only.
    pub fn disable_asset(env: Env, admin: Address, asset: Address) {
        require_admin_is(&env, &admin);
        let _ = read_asset_config(&env, &asset);
        env.storage()
            .instance()
            .set(&DataKey::AssetDisabled(asset.clone()), &true);
        env.events()
            .publish((symbol_short!("disable"), asset), ());
    }

    /// Re-enables a disabled asset. Admin only.
    pub fn enable_asset(env: Env, admin: Address, asset: Address) {
        require_admin_is(&env, &admin);
        let _ = read_asset_config(&env, &asset);
        env.storage()
            .instance()
            .remove(&DataKey::AssetDisabled(asset.clone()));
        env.events()
            .publish((symbol_short!("enable"), asset), ());
    }

    /// Checks whether an asset is currently enabled.
    pub fn is_asset_enabled(env: Env, asset: Address) -> bool {
        let _ = read_asset_config(&env, &asset);
        !is_asset_disabled(&env, &asset)
    }

    /// Mints a trade id and stores the proposed terms (PRD §8 `propose(cash_lender, terms) -> id`,
    /// flattened into explicit params here for clarity).
    pub fn propose(
        env: Env,
        cash_lender: Address,
        cash_borrower: Address,
        asset: Address,
        units: i128,
        cash_amount: i128,
        rate_bps: u32,
        kind: RepoKind,
        maturity_at: u64,
        agreement_hash: BytesN<32>,
    ) -> u64 {
        cash_lender.require_auth();
        require_asset_enabled(&env, &asset);
        if units <= 0 {
            panic!("repo-dvp: units must be positive");
        }
        if cash_amount <= 0 {
            panic!("repo-dvp: cash_amount must be positive");
        }
        if maturity_at <= env.ledger().timestamp() {
            panic!("repo-dvp: maturity_at must be in the future");
        }
        // Refuse before any allowance is granted: a trade in an asset that was never
        // passed to `configure_asset` would settle leg 1 and then strand the lender
        // with no margin protection — `call_margin` and `default_close` read this
        // config and would revert until maturity.
        read_asset_config(&env, &asset);

        // Pre-authorize leg 1 (see the module docs): the lender signs this call, not the
        // borrower's later `accept_and_settle`.
        token::Client::new(&env, &read_usdc(&env)).approve(
            &cash_lender,
            &env.current_contract_address(),
            &cash_amount,
            &allowance_expiry(&env, maturity_at - env.ledger().timestamp(), 0),
        );

        let id = timelock::next_id(&env);
        env.storage()
            .instance()
            .set(&DataKey::LatestProposal(cash_lender.clone()), &id);
        let trade = RepoTrade {
            id,
            cash_lender,
            cash_borrower,
            asset,
            units,
            cash_amount,
            rate_bps,
            kind,
            maturity_at,
            agreement_hash,
            proposed_at: env.ledger().timestamp(),
            status: RepoStatus::Proposed,
            leg1_ledger: None,
            settled_at: None,
            pending_margin_call: false,
            margin_call_amount: 0,
            cure_deadline: None,
        };
        write_trade(&env, &trade);
        id
    }

    /// Cancels a proposal that is still in `Proposed` status. Callable by either the cash lender
    /// or the cash borrower.
    ///
    /// If cancelled by the cash lender, the contract's leg-1 USDC allowance is reset to 0 if this
    /// was the lender's latest proposal. If cancelled by the cash borrower, the trade status moves
    /// to `Cancelled` (blocking settlement) without modifying the lender's token allowance, as the
    /// borrower is not authorized to sign for the lender.
    pub fn cancel_proposal(env: Env, caller: Address, id: u64) {
        caller.require_auth();

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Proposed {
            panic!("repo-dvp: trade is not in proposed status");
        }
        if caller != trade.cash_lender && caller != trade.cash_borrower {
            panic!("repo-dvp: caller is neither lender nor borrower");
        }

        if caller == trade.cash_lender {
            let latest: Option<u64> = env
                .storage()
                .instance()
                .get(&DataKey::LatestProposal(trade.cash_lender.clone()));
            if latest == Some(id) {
                let usdc = read_usdc(&env);
                token::Client::new(&env, &usdc).approve(
                    &trade.cash_lender,
                    &env.current_contract_address(),
                    &0,
                    &allowance_expiry(&env, 0, 0),
                );
            }
        }

        trade.status = RepoStatus::Cancelled;
        write_trade(&env, &trade);

        env.events()
            .publish((symbol_short!("cancel"), id), caller);
    }

    /// Leg 1, atomic (PRD invariant 7): within this single function, `units` of `asset` move from
    /// `cash_borrower` into this contract, and `cash_amount` USDC moves from `cash_lender`
    /// straight to `cash_borrower` (out of the allowance `propose` granted). Both token calls happen unconditionally,
    /// with no early return between them — if either panics, the Soroban host aborts the whole
    /// invocation and neither leg's storage/token effects apply.
    pub fn accept_and_settle(env: Env, cash_borrower: Address, id: u64) {
        cash_borrower.require_auth();
        pause::require_not_paused(&env, &PauseScope::Repos);

        let mut trade = read_trade(&env, id);
        require_asset_enabled(&env, &trade.asset);
        if trade.status != RepoStatus::Proposed {
            panic!("repo-dvp: trade is not in proposed status");
        }
        if trade.cash_borrower != cash_borrower {
            panic!("repo-dvp: caller is not the trade's cash borrower");
        }
        // The lender's leg-1 allowance outlives maturity by up to a couple of days (its expiry is
        // bucketed), so a stale proposal has to be refused here rather than by the token.
        if env.ledger().timestamp() >= trade.maturity_at {
            panic!("repo-dvp: proposal is past its maturity");
        }
        // Belt and braces for proposals that predate the check in `propose`: never
        // move either leg for an asset with no margin parameters.
        read_asset_config(&env, &trade.asset);

        let asset_client = token::Client::new(&env, &trade.asset);
        asset_client.transfer(
            &cash_borrower,
            to_muxed(&env.current_contract_address()),
            &trade.units,
        );

        let usdc_client = token::Client::new(&env, &read_usdc(&env));
        usdc_client.transfer_from(
            &env.current_contract_address(),
            &trade.cash_lender,
            &cash_borrower,
            &trade.cash_amount,
        );

        // Pre-authorize leg 2 (see the module docs): the borrower signs this call, so this is
        // the one moment the contract can be granted the right to collect at maturity.
        //
        // Sized as if the trade had settled the moment it was proposed: a ceiling on what leg 2
        // can owe (settlement is never earlier than the proposal) that, unlike the exact figure,
        // doesn't depend on which ledger this call executes in. It's an argument to a nested
        // authorized call, so it has to come out the same at simulation and at execution — see
        // `allowance_expiry`.
        let now = env.ledger().timestamp();
        usdc_client.approve(
            &cash_borrower,
            &env.current_contract_address(),
            &total_due(&trade, trade.proposed_at),
            &allowance_expiry(
                &env,
                trade.maturity_at.saturating_sub(now),
                UNWIND_ALLOWANCE_GRACE_LEDGERS,
            ),
        );

        trade.status = RepoStatus::Settled;
        trade.leg1_ledger = Some(env.ledger().sequence());
        trade.settled_at = Some(now);
        write_trade(&env, &trade);

        env.events()
            .publish((symbol_short!("settle"), id), trade.units);
    }

    /// Leg 2: either party may unwind at or after maturity; a keeper may do so as the fallback
    /// "someone triggers it if both are absent" path (PRD §5 Phase 3 "Leg 2").
    pub fn unwind(env: Env, caller: Address, id: u64) {
        caller.require_auth();

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Settled {
            panic!("repo-dvp: trade is not settled");
        }
        let is_party = caller == trade.cash_lender || caller == trade.cash_borrower;
        if !is_party {
            let roles = access::read_roles(&env);
            if caller != roles.keeper {
                panic!("repo-dvp: caller is neither party nor keeper");
            }
        }
        if env.ledger().timestamp() < trade.maturity_at {
            panic!("repo-dvp: not yet at maturity");
        }

        let settled_at = trade
            .settled_at
            .expect("repo-dvp: trade has no settlement time");
        let total_due = total_due(&trade, settled_at);

        let usdc_client = token::Client::new(&env, &read_usdc(&env));
        if caller == trade.cash_borrower {
            usdc_client.transfer(
                &trade.cash_borrower,
                to_muxed(&trade.cash_lender),
                &total_due,
            );
        } else {
            // The borrower didn't sign this call; spend the allowance they granted at settlement.
            usdc_client.transfer_from(
                &env.current_contract_address(),
                &trade.cash_borrower,
                &trade.cash_lender,
                &total_due,
            );
        }

        let asset_client = token::Client::new(&env, &trade.asset);
        asset_client.transfer(
            &env.current_contract_address(),
            to_muxed(&trade.cash_borrower),
            &trade.units,
        );

        trade.status = RepoStatus::Unwound;
        write_trade(&env, &trade);

        env.events()
            .publish((symbol_short!("unwind"), id), total_due);
    }

    /// Cross-calls `PriceGuard` for the trade's asset and re-evaluates the margin on the pledged
    /// collateral against the outstanding exposure (principal + accrued interest).
    ///
    /// - At `MarginCall` or worse it records a call and starts the cure clock. Calling it again
    ///   while a call is open updates the amount owed but does **not** move the deadline, so the
    ///   keeper can neither extend nor restart a borrower's cure window.
    /// - If a call is open and the position is back under the margin-call threshold (the price
    ///   recovered), it clears the call: the borrower has cured and `default_close` is no longer
    ///   available.
    ///
    /// Does not notify anyone off-chain — that is the `margin-monitor` service's job (PRD §6.5).
    pub fn call_margin(env: Env, keeper: Address, id: u64) {
        access::require_keeper(&env);
        keeper.require_auth();

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Settled {
            panic!("repo-dvp: trade is not settled");
        }

        let config = read_asset_config(&env, &trade.asset);
        let (exposure, collateral_value, state, _price) = evaluate_margin(&env, &trade, &config)
            .expect("repo-dvp: price is not Ok, cannot evaluate margin");

        let now = env.ledger().timestamp();
        if matches!(state, MarginState::MarginCall | MarginState::Liquidation) {
            // The collateral value needed to bring the LTV back down to exactly the
            // margin-call threshold, minus what's actually there. This is guaranteed
            // non-negative whenever `classify` returns `MarginCall`/`Liquidation`, since that
            // only happens when `ltv_bps >= margin_call_bps`, i.e. `collateral_value` is already
            // at or below this target.
            let target_collateral = exposure
                .checked_mul(BPS_DENOMINATOR)
                .expect("repo-dvp: overflow computing margin target")
                / config.thresholds.margin_call_bps as i128;
            trade.margin_call_amount = (target_collateral - collateral_value).max(0);
            if !trade.pending_margin_call {
                trade.pending_margin_call = true;
                trade.cure_deadline = Some(now + cure_grace(&env));
            }
            write_trade(&env, &trade);
            env.events()
                .publish((symbol_short!("mcall"), id), trade.margin_call_amount);
        } else if trade.pending_margin_call {
            clear_margin_call(&mut trade);
            write_trade(&env, &trade);
            env.events().publish((symbol_short!("cured"), id), 0i128);
        }
    }

    /// The cash borrower adds collateral to a settled trade, which is how a margin call is cured
    /// by the borrower. The RWA moves into this contract's escrow and counts toward the trade
    /// immediately; if the position is then back under the margin-call threshold the call is
    /// cleared in the same transaction.
    pub fn top_up(env: Env, cash_borrower: Address, id: u64, extra_units: i128) {
        // Deliberately not pause-gated: adding collateral only reduces risk, and a borrower must
        // be able to cure a call even while the contract is paused.
        cash_borrower.require_auth();
        assert!(extra_units > 0, "repo-dvp: top-up must be positive");

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Settled {
            panic!("repo-dvp: trade is not settled");
        }
        assert_eq!(
            trade.cash_borrower, cash_borrower,
            "repo-dvp: only the cash borrower can top up"
        );

        token::Client::new(&env, &trade.asset).transfer(
            &cash_borrower,
            to_muxed(&env.current_contract_address()),
            &extra_units,
        );
        trade.units = trade
            .units
            .checked_add(extra_units)
            .expect("repo-dvp: overflow adding collateral");

        let mut cured = false;
        if trade.pending_margin_call {
            let config = read_asset_config(&env, &trade.asset);
            // Without a usable price the call stays open: the keeper clears it on its next
            // evaluation. Never clear a call on a price the guard does not stand behind.
            if let Some((_, _, state, _)) = evaluate_margin(&env, &trade, &config) {
                if !matches!(state, MarginState::MarginCall | MarginState::Liquidation) {
                    clear_margin_call(&mut trade);
                    cured = true;
                }
            }
        }
        write_trade(&env, &trade);
        env.events()
            .publish((symbol_short!("topup"), id), (extra_units, cured));
    }

    /// If the cash borrower has not cured an outstanding margin call by `cure_deadline`, the cash
    /// lender takes title to as much of the pledged RWA as covers what is owed and the trade
    /// closes. See the module docs for exactly what bookkeeping this does and does not do.
    ///
    /// The position is re-evaluated at default time: if the price has recovered since the call, the
    /// borrower has cured and this refuses (the keeper's `call_margin` then clears the call). The
    /// collateral is valued at the guarded price with no haircut; the lender receives
    /// `ceil(exposure / price)` units, capped at what is pledged, and any units above that go back
    /// to the borrower. If the collateral is worth less than the exposure the lender takes all of
    /// it and bears the shortfall.
    pub fn default_close(env: Env, keeper: Address, id: u64) {
        access::require_keeper(&env);
        keeper.require_auth();

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Settled {
            panic!("repo-dvp: trade is not settled");
        }
        if !trade.pending_margin_call {
            panic!("repo-dvp: no active margin call to default on");
        }
        let deadline = trade
            .cure_deadline
            .expect("repo-dvp: margin call has no cure deadline");
        if env.ledger().timestamp() < deadline {
            panic!("repo-dvp: cure window has not expired yet");
        }

        let config = read_asset_config(&env, &trade.asset);
        let (exposure, _collateral_value, state, price) = evaluate_margin(&env, &trade, &config)
            .expect("repo-dvp: price is not Ok, cannot default");
        if !matches!(state, MarginState::MarginCall | MarginState::Liquidation) {
            panic!("repo-dvp: margin call has been cured");
        }

        assert!(price > 0, "repo-dvp: guarded price is not positive");
        // Units worth `exposure` at the guarded price, rounded up so the lender is never short by
        // rounding; ceil(a / b) = (a + b - 1) / b.
        let owed_units = exposure
            .checked_mul(PRICE_SCALE)
            .expect("repo-dvp: overflow valuing the exposure")
            .checked_add(price - 1)
            .expect("repo-dvp: overflow valuing the exposure")
            / price;
        let lender_units = owed_units.min(trade.units);
        let borrower_units = trade.units - lender_units;

        let asset_client = token::Client::new(&env, &trade.asset);
        asset_client.transfer(
            &env.current_contract_address(),
            to_muxed(&trade.cash_lender),
            &lender_units,
        );
        if borrower_units > 0 {
            asset_client.transfer(
                &env.current_contract_address(),
                to_muxed(&trade.cash_borrower),
                &borrower_units,
            );
        }

        trade.status = RepoStatus::Defaulted;
        write_trade(&env, &trade);

        env.events()
            .publish((symbol_short!("default"), id), (lender_units, borrower_units));
    }

    /// Pure read: where the trade's margin stands right now. Changes nothing.
    pub fn margin_view(env: Env, id: u64) -> RepoMarginView {
        let trade = read_trade(&env, id);
        let config = read_asset_config(&env, &trade.asset);
        match evaluate_margin(&env, &trade, &config) {
            Some((exposure, collateral_value, state, _)) => RepoMarginView {
                exposure,
                collateral_value,
                ltv_bps: risk::ltv_bps(exposure, collateral_value),
                state,
                price_ok: true,
            },
            None => RepoMarginView {
                exposure: 0,
                collateral_value: 0,
                ltv_bps: 0,
                state: MarginState::Healthy,
                price_ok: false,
            },
        }
    }

    pub fn trade(env: Env, id: u64) -> RepoTrade {
        read_trade(&env, id)
    }
}

#[cfg(test)]
mod test;
