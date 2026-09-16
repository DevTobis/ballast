#![cfg_attr(not(test), no_std)]

//! `ExitDesk` (PRD §5 Phase 2, §8): swaps an RWA token for USDC in one atomic transaction. The
//! quoted price is the guarded price minus an exit spread; the USDC comes from a Ballast Exit
//! Facility that, in this skeleton, is modeled simply as a USDC float the desk holds and that an
//! admin/keeper tops up via `fund` (PRD §5 Phase 2 "Funding": "a credit line from the Phase 1
//! lender" — the real credit-line draw against the facility is out of scope here; `fund` just
//! simulates the facility depositing USDC into the desk).
//!
//! **Skeleton simplification (Registry decoupling):** haircut/spread/cap parameters are admin-set
//! directly on this contract per asset rather than read from `Registry`, because `Registry` is
//! being rewritten concurrently by another agent and is not stable to depend on yet. `PriceGuard`
//! is still consulted, but dynamically by stored `Address` and cross-contract call (via a local
//! `contractclient` trait, not a path dependency on the `ballast-price-guard` crate), so this
//! contract has zero compile-time coupling to either concurrently-changing contract.
//!
//! **Skeleton simplification (anchor payout hop):** `exit`'s `to` parameter lets the caller route
//! the USDC payout anywhere, including an anchor's operator G-account. Attaching the memo that
//! contract accounts cannot carry (PRD §5 Phase 2 "Anchor payout hop", PRD §6.5 `payout-hop`
//! service) happens entirely off-chain, after this contract's transfer lands in `to`'s account —
//! that hop is out of scope for this contract.

use ballast_common::{
    access::{self, Roles},
    pause::{self, PauseScope},
    price::{GuardedPrice, PRICE_SCALE},
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, Env,
    MuxedAddress,
};

/// A quote is only valid for this many seconds after it is computed (PRD §5 Phase 2 "Exit quote").
pub const QUOTE_TTL_SECONDS: u64 = 60;

const BPS_DENOMINATOR: i128 = 10_000;
const SECONDS_PER_DAY: u64 = 86_400;

#[contractclient(name = "PriceGuardClient")]
pub trait PriceGuardInterface {
    fn guarded_price(env: Env, asset: Address) -> GuardedPrice;
}

fn to_muxed(addr: &Address) -> MuxedAddress {
    MuxedAddress::from(addr.clone())
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfig {
    pub price_guard: Address,
    pub spread_bps: u32,
    pub per_holder_daily_cap: i128,
    pub desk_inventory_cap: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ExitQuote {
    pub asset: Address,
    pub units: i128,
    /// The per-unit price actually used (guarded price minus spread), 7-decimal fixed point.
    pub price: i128,
    pub spread_bps: u32,
    pub usdc_out: i128,
    pub expires_at: u64,
}

#[contracttype]
enum DataKey {
    Usdc,
    AssetConfig(Address),
    /// Cumulative RWA units this desk currently holds for `asset` (PRD §5 Phase 2 "Limits": total
    /// desk inventory cap tied to facility size). This skeleton never rebalances/withdraws, so it
    /// only ever grows.
    Inventory(Address),
    /// Units a `holder` has exited for `asset` within a given UTC day bucket
    /// (`timestamp / 86_400`), for the per-holder daily cap.
    DailyUsed(Address, Address, u64),
}

fn read_asset_config(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("exit-desk: asset not configured")
}

fn require_admin_is(env: &Env, admin: &Address) {
    let stored_admin = access::require_admin(env);
    assert_eq!(&stored_admin, admin, "exit-desk: admin argument mismatch");
}

/// Computes the guarded, spread-adjusted quote for `units` of `asset`. Shared by `quote` (a
/// read) and `exit` (which must recompute fresh rather than trust a stale client-supplied quote).
/// Panics if the price is not `Ok` — PRD invariant 2 ("no draws/exits/repos on a bad price"); we
/// panic rather than returning a `Degraded`/`Halted` quote so a caller can never accidentally
/// build a transaction against a bad price.
fn compute_quote(env: &Env, asset: &Address, units: i128) -> ExitQuote {
    if units <= 0 {
        panic!("exit-desk: units must be positive");
    }
    let config = read_asset_config(env, asset);
    let guarded = PriceGuardClient::new(env, &config.price_guard).guarded_price(asset);
    if !guarded.is_usable_for_new_risk() {
        panic!("exit-desk: price is not Ok, refusing to quote");
    }

    let price = guarded
        .value
        .checked_mul(BPS_DENOMINATOR - config.spread_bps as i128)
        .expect("exit-desk: overflow computing price")
        / BPS_DENOMINATOR;
    let usdc_out = units
        .checked_mul(price)
        .expect("exit-desk: overflow computing usdc_out")
        / PRICE_SCALE;

    ExitQuote {
        asset: asset.clone(),
        units,
        price,
        spread_bps: config.spread_bps,
        usdc_out,
        expires_at: env.ledger().timestamp() + QUOTE_TTL_SECONDS,
    }
}

#[contract]
pub struct ExitDesk;

#[contractimpl]
impl ExitDesk {
    pub fn initialize(
        env: Env,
        admin: Address,
        pauser: Address,
        keeper: Address,
        price_publisher: Address,
        risk: Address,
    ) {
        if access::has_roles(&env) {
            panic!("exit-desk: already initialized");
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

    /// Admin-only per-asset configuration (PRD §5 Phase 2 "Limits" row: per-holder and per-day
    /// caps, total desk inventory cap tied to facility size). See the module docs for why this is
    /// stored locally instead of read from `Registry`.
    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        price_guard: Address,
        spread_bps: u32,
        per_holder_daily_cap: i128,
        desk_inventory_cap: i128,
    ) {
        require_admin_is(&env, &admin);
        assert!(spread_bps as i128 <= BPS_DENOMINATOR, "exit-desk: spread exceeds 100%");
        assert!(per_holder_daily_cap > 0, "exit-desk: per_holder_daily_cap must be positive");
        assert!(desk_inventory_cap > 0, "exit-desk: desk_inventory_cap must be positive");

        env.storage().instance().set(
            &DataKey::AssetConfig(asset.clone()),
            &AssetConfig {
                price_guard,
                spread_bps,
                per_holder_daily_cap,
                desk_inventory_cap,
            },
        );
    }

    /// Simulates the Exit Facility topping up the desk: pulls `amount` of `usdc` from the caller
    /// (admin or keeper) into this contract's float. Stores `usdc`'s address the first time it is
    /// called; later calls must agree on the same token.
    pub fn fund(env: Env, admin_or_keeper: Address, usdc: Address, amount: i128) {
        access::require_admin_or_keeper(&env, &admin_or_keeper);
        if amount <= 0 {
            panic!("exit-desk: amount must be positive");
        }

        match env.storage().instance().get::<_, Address>(&DataKey::Usdc) {
            Some(existing) => assert_eq!(existing, usdc, "exit-desk: usdc address mismatch"),
            None => env.storage().instance().set(&DataKey::Usdc, &usdc),
        }

        let usdc_client = token::Client::new(&env, &usdc);
        usdc_client.transfer(
            &admin_or_keeper,
            &to_muxed(&env.current_contract_address()),
            &amount,
        );

        env.events()
            .publish((symbol_short!("fund"), admin_or_keeper), amount);
    }

    /// A pure(-ish) read: no auth required to get a quote, but it still refuses to quote on a
    /// non-`Ok` price (PRD invariant 2).
    pub fn quote(env: Env, asset: Address, units: i128) -> ExitQuote {
        compute_quote(&env, &asset, units)
    }

    /// Swaps `units` of `asset` from `holder` into USDC paid to `to` (PRD §5 Phase 2
    /// "Settlement", "Anchor payout hop"). Always re-quotes fresh; never trusts a stale
    /// client-supplied price.
    ///
    /// PRD §5 Phase 2 "Eligibility": the holder must already be authorised for `asset`. This is
    /// enforced entirely by the asset's own SAC/SEP-57 authorization checks inside
    /// `token::Client::transfer` below — an unauthorized holder's transfer simply reverts there,
    /// so no extra eligibility check is needed in this contract.
    pub fn exit(
        env: Env,
        holder: Address,
        asset: Address,
        units: i128,
        min_usdc_out: i128,
        to: Address,
    ) -> i128 {
        holder.require_auth();
        pause::require_not_paused(&env, &PauseScope::Exits);

        let quote = compute_quote(&env, &asset, units);
        if quote.usdc_out < min_usdc_out {
            panic!("exit-desk: usdc_out below min_usdc_out (slippage)");
        }

        let config = read_asset_config(&env, &asset);

        let day_bucket = env.ledger().timestamp() / SECONDS_PER_DAY;
        let daily_key = DataKey::DailyUsed(holder.clone(), asset.clone(), day_bucket);
        let daily_used: i128 = env.storage().persistent().get(&daily_key).unwrap_or(0);
        let new_daily_used = daily_used
            .checked_add(units)
            .expect("exit-desk: overflow in daily-used counter");
        if new_daily_used > config.per_holder_daily_cap {
            panic!("exit-desk: exceeds per-holder daily cap");
        }

        let inventory_key = DataKey::Inventory(asset.clone());
        let inventory: i128 = env.storage().persistent().get(&inventory_key).unwrap_or(0);
        let new_inventory = inventory
            .checked_add(units)
            .expect("exit-desk: overflow in desk inventory");
        if new_inventory > config.desk_inventory_cap {
            panic!("exit-desk: exceeds desk inventory cap");
        }

        // Atomic settlement: RWA in from the holder, USDC out to `to`. Both transfers happen
        // unconditionally in this one call; a panic in either aborts the whole invocation and
        // neither leg applies.
        let rwa_client = token::Client::new(&env, &asset);
        rwa_client.transfer(&holder, &to_muxed(&env.current_contract_address()), &units);

        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::Usdc)
            .expect("exit-desk: usdc not funded/configured yet");
        let usdc_client = token::Client::new(&env, &usdc);
        usdc_client.transfer(
            &env.current_contract_address(),
            &to_muxed(&to),
            &quote.usdc_out,
        );

        env.storage().persistent().set(&daily_key, &new_daily_used);
        env.storage().persistent().set(&inventory_key, &new_inventory);

        env.events()
            .publish((symbol_short!("exit"), holder, asset), quote.usdc_out);

        quote.usdc_out
    }
}

#[cfg(test)]
mod test;
