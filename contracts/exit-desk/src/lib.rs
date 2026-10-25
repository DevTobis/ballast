#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]
// Events are published with `Events::publish`, which soroban-sdk now deprecates in favour of
// `#[contractevent]`. Moving over changes how events are encoded on-chain, so it has to be done
// together with the off-chain readers (services/indexer, services/ledger) and a redeploy.
#![allow(deprecated)]

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
    timelock,
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUnpause {
    pub scope: PauseScope,
    pub executes_at: u64,
}

#[contracttype]
enum DataKey {
    Usdc,
    AssetConfig(Address),
    AssetDisabled(Address),
    /// RWA units this desk currently holds for `asset` (PRD §5 Phase 2 "Limits": total desk
    /// inventory cap tied to facility size). Grows with every exit and shrinks when the operator
    /// takes inventory back out with `withdraw`.
    Inventory(Address),
    /// Units a `holder` has exited for `asset` within a given UTC day bucket
    /// (`timestamp / 86_400`), for the per-holder daily cap.
    DailyUsed(Address, Address, u64),
    PendingUnpause(u64),
}

fn read_asset_config(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("exit-desk: asset not configured")
}

fn read_usdc(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Usdc)
        .expect("exit-desk: usdc not configured")
    }

fn is_asset_disabled(env: &Env, asset: &Address) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::AssetDisabled(asset.clone()))
        .unwrap_or(false)
}

fn require_asset_enabled(env: &Env, asset: &Address) {
    if is_asset_disabled(env, asset) {
        panic!("exit-desk: asset is disabled");
    }
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
    require_asset_enabled(env, asset);
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
        // A 100% spread makes every exit pay nothing, which is a misconfiguration, not a price.
        assert!(
            (spread_bps as i128) < BPS_DENOMINATOR,
            "exit-desk: spread must be below 100%"
        );
        assert!(
            per_holder_daily_cap > 0,
            "exit-desk: per_holder_daily_cap must be positive"
        );
        assert!(
            desk_inventory_cap > 0,
            "exit-desk: desk_inventory_cap must be positive"
        );

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

    /// Admin-set once; exit swaps pay out this token. See module docs for why this isn't
    /// read from `Registry`.
    pub fn set_usdc(env: Env, admin: Address, usdc: Address) {
        require_admin_is(&env, &admin);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.events()
            .publish((symbol_short!("set_usdc"), admin), usdc);
    }

    pub fn usdc(env: Env) -> Address {
        read_usdc(&env)
    }

    /// Disables an asset so that new quotes and exits are refused. Admin only.
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

    /// Simulates the Exit Facility topping up the desk: pulls `amount` of `usdc` from the caller
    /// (admin or keeper) into this contract's float. Requires `set_usdc` to have been called first,
    /// and the token argument must match the configured USDC token address.
    pub fn fund(env: Env, admin_or_keeper: Address, usdc: Address, amount: i128) {
        access::require_admin_or_keeper(&env, &admin_or_keeper);
        if amount <= 0 {
            panic!("exit-desk: amount must be positive");
        }

        let configured = read_usdc(&env);
        assert_eq!(configured, usdc, "exit-desk: usdc address mismatch");

        let usdc_client = token::Client::new(&env, &usdc);
        usdc_client.transfer(
            &admin_or_keeper,
            to_muxed(&env.current_contract_address()),
            &amount,
        );

        env.events()
            .publish((symbol_short!("fund"), admin_or_keeper), amount);
    }

    /// The operator takes the desk's own assets back out: USDC float it no longer wants to deploy,
    /// or the RWA inventory the desk has accumulated from exits (which would otherwise sit against
    /// the inventory cap for good, eventually refusing every exit). Admin only.
    ///
    /// This is the desk's own balance, not user money: an exit is a single atomic swap, so nothing
    /// belonging to a holder is ever in this contract between transactions (PRD §8 invariant 6
    /// concerns user funds and is unaffected).
    pub fn withdraw(env: Env, admin: Address, token: Address, amount: i128, to: Address) {
        require_admin_is(&env, &admin);
        assert!(amount > 0, "exit-desk: amount must be positive");

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            to_muxed(&to),
            &amount,
        );

        // Taking an RWA out frees the same amount of room under its inventory cap.
        if env
            .storage()
            .instance()
            .has(&DataKey::AssetConfig(token.clone()))
        {
            let key = DataKey::Inventory(token.clone());
            let held: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&key, &(held - amount.min(held)));
        }

        env.events().publish((symbol_short!("withdraw"), token), amount);
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
        // Rounding is a floor, so a dust amount quotes (as a read) to zero. Taking the holder's
        // RWA for nothing, while using up their daily cap and the desk's inventory room, is never
        // what a caller meant, whatever `min_usdc_out` they passed.
        assert!(
            quote.usdc_out > 0,
            "exit-desk: usdc_out is zero, amount too small to exit"
        );
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
        rwa_client.transfer(&holder, to_muxed(&env.current_contract_address()), &units);

        let usdc = read_usdc(&env);
        let usdc_client = token::Client::new(&env, &usdc);
        usdc_client.transfer(
            &env.current_contract_address(),
            to_muxed(&to),
            &quote.usdc_out,
        );

        env.storage().persistent().set(&daily_key, &new_daily_used);
        env.storage()
            .persistent()
            .set(&inventory_key, &new_inventory);

        env.events()
            .publish((symbol_short!("exit"), holder, asset), quote.usdc_out);

        quote.usdc_out
    }

    /// Immediate, no timelock — the pauser can only ever *stop* things (PRD §6.2).
    pub fn pause(env: Env, pauser: Address, scope: PauseScope) {
        let stored_pauser = access::require_pauser(&env);
        assert_eq!(&stored_pauser, &pauser, "exit-desk: pauser argument mismatch");
        pause::set_paused(&env, &scope, true);
        env.events()
            .publish((symbol_short!("paused"), pauser), scope);
    }

    /// Queues an unpause, executable after the 48h timelock — unlike `pause`, lifting a stop is
    /// not urgent and deserves the same notice period as any other risk-loosening change.
    pub fn queue_unpause(env: Env, admin: Address, scope: PauseScope) -> u64 {
        require_admin_is(&env, &admin);
        let id = timelock::next_id(&env);
        let key = DataKey::PendingUnpause(id);
        let executes_at = timelock::executes_at(&env);
        env.storage().persistent().set(
            &key,
            &PendingUnpause {
                scope: scope.clone(),
                executes_at,
            },
        );
        timelock::extend_entry_ttl(&env, &key);
        env.events()
            .publish((symbol_short!("unp_q"), id), (scope, executes_at));
        id
    }

    pub fn execute_unpause(env: Env, id: u64) {
        let key = DataKey::PendingUnpause(id);
        let pending: PendingUnpause = env
            .storage()
            .persistent()
            .get(&key)
            .expect("exit-desk: no such pending unpause");
        assert!(
            timelock::is_ready(&env, pending.executes_at),
            "exit-desk: timelock has not elapsed"
        );
        pause::set_paused(&env, &pending.scope, false);
        env.storage().persistent().remove(&key);
        env.events()
            .publish((symbol_short!("unp_exec"), id), pending.scope);
    }

    pub fn cancel_unpause(env: Env, admin: Address, id: u64) {
        require_admin_is(&env, &admin);
        let key = DataKey::PendingUnpause(id);
        let pending: PendingUnpause = env
            .storage()
            .persistent()
            .get(&key)
            .expect("exit-desk: no such pending unpause");
        env.storage().persistent().remove(&key);
        env.events()
            .publish((symbol_short!("unp_canc"), id), pending.scope);
    }

    pub fn is_paused(env: Env, scope: PauseScope) -> bool {
        pause::is_paused(&env, &scope)
    }
}

#[cfg(test)]
mod test;
