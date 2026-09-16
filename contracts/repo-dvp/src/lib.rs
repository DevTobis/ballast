#![cfg_attr(not(test), no_std)]

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
    price::GuardedPrice,
    risk,
    timelock,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, MuxedAddress,
};

/// Grace period after a margin call before `default_close` may act (PRD §5 Phase 1 "Top-up and
/// cure": default 24h cure window, reused here for repo margin calls).
pub const MARGIN_CURE_GRACE_SECONDS: u64 = 24 * 60 * 60;

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

#[contracttype]
enum DataKey {
    Usdc,
    AssetConfig(Address),
    Trade(u64),
}

fn read_asset_config(env: &Env, asset: &Address) -> RepoAssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("repo-dvp: asset not configured")
}

fn read_trade(env: &Env, id: u64) -> RepoTrade {
    env.storage()
        .persistent()
        .get(&DataKey::Trade(id))
        .expect("repo-dvp: trade not found")
}

fn write_trade(env: &Env, trade: &RepoTrade) {
    env.storage().persistent().set(&DataKey::Trade(trade.id), trade);
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

    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        price_guard: Address,
        haircut_bps: u32,
        thresholds: MarginThresholds,
    ) {
        require_admin_is(&env, &admin);
        assert!(haircut_bps as i128 <= BPS_DENOMINATOR, "repo-dvp: haircut exceeds 100%");
        env.storage().instance().set(
            &DataKey::AssetConfig(asset.clone()),
            &RepoAssetConfig {
                price_guard,
                haircut_bps,
                thresholds,
            },
        );
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
        if units <= 0 {
            panic!("repo-dvp: units must be positive");
        }
        if cash_amount <= 0 {
            panic!("repo-dvp: cash_amount must be positive");
        }
        if maturity_at <= env.ledger().timestamp() {
            panic!("repo-dvp: maturity_at must be in the future");
        }

        let id = timelock::next_id(&env);
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

    /// Leg 1, atomic (PRD invariant 7): within this single function, `units` of `asset` move from
    /// `cash_borrower` into this contract, and `cash_amount` USDC moves from `cash_lender`
    /// straight to `cash_borrower`. Both `token::Client::transfer` calls happen unconditionally,
    /// with no early return between them — if either panics, the Soroban host aborts the whole
    /// invocation and neither leg's storage/token effects apply.
    pub fn accept_and_settle(env: Env, cash_borrower: Address, id: u64) {
        cash_borrower.require_auth();
        pause::require_not_paused(&env, &PauseScope::Repos);

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Proposed {
            panic!("repo-dvp: trade is not in proposed status");
        }
        if trade.cash_borrower != cash_borrower {
            panic!("repo-dvp: caller is not the trade's cash borrower");
        }

        let asset_client = token::Client::new(&env, &trade.asset);
        asset_client.transfer(&cash_borrower, &to_muxed(&env.current_contract_address()), &trade.units);

        let usdc_client = token::Client::new(&env, &read_usdc(&env));
        usdc_client.transfer(&trade.cash_lender, &to_muxed(&cash_borrower), &trade.cash_amount);

        trade.status = RepoStatus::Settled;
        trade.leg1_ledger = Some(env.ledger().sequence());
        trade.settled_at = Some(env.ledger().timestamp());
        write_trade(&env, &trade);

        env.events().publish((symbol_short!("settle"), id), trade.units);
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

        let settled_at = trade.settled_at.expect("repo-dvp: trade has no settlement time");
        let term_seconds = trade.maturity_at.saturating_sub(settled_at);
        let interest = accrue_interest(trade.cash_amount, trade.rate_bps, term_seconds);
        let total_due = trade
            .cash_amount
            .checked_add(interest)
            .expect("repo-dvp: overflow computing total due");

        let usdc_client = token::Client::new(&env, &read_usdc(&env));
        usdc_client.transfer(&trade.cash_borrower, &to_muxed(&trade.cash_lender), &total_due);

        let asset_client = token::Client::new(&env, &trade.asset);
        asset_client.transfer(
            &env.current_contract_address(),
            &to_muxed(&trade.cash_borrower),
            &trade.units,
        );

        trade.status = RepoStatus::Unwound;
        write_trade(&env, &trade);

        env.events().publish((symbol_short!("unwind"), id), total_due);
    }

    /// Cross-calls `PriceGuard` for the trade's asset and, if the current LTV of the pledged
    /// collateral against outstanding exposure (principal + accrued interest) classifies as
    /// `MarginCall` or worse, records the call and starts the cure clock. Does not notify anyone
    /// off-chain — that is the `margin-monitor` service's job (PRD §6.5).
    pub fn call_margin(env: Env, keeper: Address, id: u64) {
        access::require_keeper(&env);
        keeper.require_auth();

        let mut trade = read_trade(&env, id);
        if trade.status != RepoStatus::Settled {
            panic!("repo-dvp: trade is not settled");
        }

        let config = read_asset_config(&env, &trade.asset);
        let guarded = PriceGuardClient::new(&env, &config.price_guard).guarded_price(&trade.asset);
        if !guarded.is_usable_for_new_risk() {
            panic!("repo-dvp: price is not Ok, cannot evaluate margin");
        }

        let collateral_value = risk::collateral_value(trade.units, guarded.value, config.haircut_bps);

        let now = env.ledger().timestamp();
        let settled_at = trade.settled_at.unwrap_or(now);
        let elapsed = now.saturating_sub(settled_at);
        let accrued = accrue_interest(trade.cash_amount, trade.rate_bps, elapsed);
        let exposure = trade
            .cash_amount
            .checked_add(accrued)
            .expect("repo-dvp: overflow computing exposure");

        let ltv = risk::ltv_bps(exposure, collateral_value);
        let state = margin::classify(ltv, &config.thresholds);

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
            trade.pending_margin_call = true;
            trade.margin_call_amount = (target_collateral - collateral_value).max(0);
            trade.cure_deadline = Some(now + MARGIN_CURE_GRACE_SECONDS);
            write_trade(&env, &trade);
            env.events().publish((symbol_short!("mcall"), id), trade.margin_call_amount);
        }
    }

    /// If the cash borrower has not cured an outstanding margin call by `cure_deadline`, the cash
    /// lender takes title to the pledged RWA and the trade closes. See the module docs for exactly
    /// what bookkeeping this does and does not do.
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
        let deadline = trade.cure_deadline.expect("repo-dvp: margin call has no cure deadline");
        if env.ledger().timestamp() < deadline {
            panic!("repo-dvp: cure window has not expired yet");
        }

        // Simplified fail-path outcome (PRD §5 Phase 3 "Fail path"): lender keeps the collateral,
        // trade closed. See module docs for what this deliberately does not settle.
        let asset_client = token::Client::new(&env, &trade.asset);
        asset_client.transfer(
            &env.current_contract_address(),
            &to_muxed(&trade.cash_lender),
            &trade.units,
        );

        trade.status = RepoStatus::Defaulted;
        write_trade(&env, &trade);

        env.events().publish((symbol_short!("default"), id), trade.units);
    }

    pub fn trade(env: Env, id: u64) -> RepoTrade {
        read_trade(&env, id)
    }
}

#[cfg(test)]
mod test;
