#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]

//! `PriceGuard` (PRD §6.2, §6.4, §8): the median/band/staleness/halt rules that stand between a
//! manipulated or stale price and a draw/exit/repo/liquidation. This is the contract that exists
//! *because* the 2026-02-22 YieldBlox exploit borrowed against a manipulated Reflector DEX price
//! for USTRY — Ballast never lends against a DEX price, and never accepts fewer than two fresh,
//! agreeing sources.
//!
//! **Documented simplification — source ingestion.** PRD §6.2 says PriceGuard "reads independent
//! SEP-40 feeds"; this skeleton does not make a live cross-contract call out to a third-party
//! SEP-40 feed contract (no such contract address exists yet to call). Instead, the off-chain
//! `price-guard` service (PRD §6.5) pulls each source itself — issuer NAV, the RedStone feed, the
//! last observed redemption price — and pushes each one here, tagged by name, via
//! `publish_nav`/`publish_source`. `guarded_price` then runs the real median/band/staleness/halt
//! logic over whatever sources are on hand. A follow-up can add a live cross-contract SEP-40 read
//! once a feed contract exists; the `PriceSource` shape (from `ballast_common::price`) already
//! matches SEP-40's `{ price, timestamp }` closely enough that swapping the ingestion path
//! wouldn't change `guarded_price`'s logic.
//!
//! **`publish_nav`'s `sig` parameter — now verified on-chain.** `Address` in Soroban doesn't
//! expose a raw public key, so this contract adds its own tiny key-registration mechanism:
//! `configure_issuer_key` (admin-only) stores a raw Ed25519 public key per asset
//! (`DataKey::IssuerPubKey`), and `publish_nav` verifies `sig` against it via
//! `env.crypto().ed25519_verify(..)` over the canonical message `"{asset_code}:{ts}:{value}"` —
//! the SAME message the off-chain `price-guard` service verifies before it ever calls
//! `publish_nav` (see `services/price-guard/src/navSignature.ts`). `asset_code` is passed in as
//! raw UTF-8 `Bytes` (rather than derived from `Address`, which has no ASCII/ticker
//! representation this contract can cheaply reconstruct) so both sides build byte-for-byte the
//! same message.
//!
//! An admin-settable `require_nav_signature` flag (default `true`, global — not per-asset; see
//! `configure_signature_requirement`) exists as a local-testing/bring-up affordance: a fresh
//! local/testnet deploy has no issuer keys registered yet, and forcing signature checks on from
//! the very first `publish_nav` call would brick the smoke-test flow before anyone's had a chance
//! to run `configure_issuer_key`. It is NOT a security control — production deploys should leave
//! it at its default `true` once real issuer keys are configured. See `contracts/README.md` for
//! the testnet-smoke-flow implication.
//!
//! The real trust boundary is still `require_price_publisher`'s `require_auth()`: only the
//! configured off-chain publisher may call `publish_nav`/`publish_source` at all. Signature
//! verification adds a second, independent check — the publisher itself must have received a
//! validly-signed reading from the issuer, not just be an authorized caller.
//!
//! **Rotating the publisher without redeploying.** Roles live in this contract's storage, so the
//! admin can queue a `price_publisher` rotation (`queue_role_change`), wait out the same 48h
//! timelock used for risk parameters, and apply it with `execute_role_change`. `LastGood`, a
//! `Halted` latch, configured assets and registered issuer keys all survive the rotation, unlike
//! `scripts/redeploy-price-guard.sh`, which deploys a new contract id and therefore loses them.
//! When the publisher key is also the NAV attestor (the default wiring — see
//! `scripts/configure-nav-key.sh`), call `configure_issuer_key` with the new key in the same
//! operational window: `publish_nav` verifies `sig` against the registered issuer key, not
//! against the `price_publisher` role, so until that call lands the new publisher cannot publish
//! NAV. See `contracts/README.md` for the full sequence.

use ballast_common::{
    access::{self, Roles},
    price::{GuardedPrice, PriceSource, PriceStatus},
    ttl, upgrade,
};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, Symbol, Vec};

const ISSUER_SOURCE: &str = "issuer";

#[contracttype]
#[derive(Clone)]
struct AssetGuardConfig {
    band_bps: u32,
    daily_move_band_bps: u32,
    max_staleness_s: u64,
    window_seconds: u64,
    window_move_band_bps: u32,
}

#[contracttype]
#[derive(Clone)]
struct NavRecord {
    value: i128,
    ts: u64,
    /// Audit-trail only — see the module doc comment on why this isn't verified on-chain.
    sig: BytesN<64>,
}

#[contracttype]
enum DataKey {
    Config(Address),
    /// One raw reading per (asset, source-name) — `publish_nav`/`publish_source` overwrite the
    /// prior reading for that source each time, matching PRD §6.4's "per-source" inputs table.
    Source(Address, Symbol),
    NavRecord(Address),
    /// The last guarded value that reached `Ok` status, returned by `guarded_price` whenever the
    /// live computation comes back `Degraded`/`Halted` (PRD §6.4: "existing positions keep the
    /// last good price").
    LastGood(Address),
    RollingReference(Address),
    RollingReferenceUpdated(Address),
    /// Set once a `Halted` status is observed; cleared only by `confirm_halt_cleared`. While set,
    /// `guarded_price` reports `Halted` regardless of what a fresh read would otherwise say.
    Halted(Address),
    /// The median value that *triggered* the halt, held here until a human confirms it. Confirming
    /// promotes it to `LastGood` — otherwise the very next read would recompute the same
    /// still-too-large move against the stale `LastGood` and immediately re-halt.
    PendingHaltValue(Address),
    /// Raw 32-byte Ed25519 public key for the issuer that signs `asset`'s NAV readings, set via
    /// `configure_issuer_key`. `publish_nav` verifies `sig` against this when
    /// `require_nav_signature` is `true`.
    IssuerPubKey(Address),
    /// Global (not per-asset) admin-settable flag, default `true` when unset — see the module doc
    /// comment on why this exists and why it isn't a security control.
    RequireNavSignature,
    /// Last evaluated PriceStatus for `asset`, tracked to emit `status_changed` events on transitions.
    LastStatus(Address),
}

/// Fixed-capacity (no `alloc`) unsigned/signed-decimal-ASCII encoders for building the canonical
/// NAV message's `ts`/`value` segments on-chain — mirrors `alloc_free_sort` above in spirit
/// (stack-only buffers, no heap).
mod decimal_ascii {
    use soroban_sdk::{Bytes, Env};

    /// u64::MAX is 20 digits.
    pub fn u64_to_bytes(env: &Env, mut n: u64) -> Bytes {
        let mut buf = [0u8; 20];
        let mut i = buf.len();
        if n == 0 {
            i -= 1;
            buf[i] = b'0';
        }
        while n > 0 {
            i -= 1;
            buf[i] = b'0' + (n % 10) as u8;
            n /= 10;
        }
        Bytes::from_slice(env, &buf[i..])
    }

    /// i128::MIN/MAX is 39 digits, plus an optional leading `-`.
    pub fn i128_to_bytes(env: &Env, n: i128) -> Bytes {
        let negative = n < 0;
        let mut magnitude = n.unsigned_abs();
        let mut buf = [0u8; 40];
        let mut i = buf.len();
        if magnitude == 0 {
            i -= 1;
            buf[i] = b'0';
        }
        while magnitude > 0 {
            i -= 1;
            buf[i] = b'0' + (magnitude % 10) as u8;
            magnitude /= 10;
        }
        if negative {
            i -= 1;
            buf[i] = b'-';
        }
        Bytes::from_slice(env, &buf[i..])
    }
}

/// Builds the canonical NAV message `"{asset_code}:{ts}:{value}"` (UTF-8 bytes) that both this
/// contract and the off-chain `price-guard` service (`services/price-guard/src/navSignature.ts`)
/// sign/verify against. Keep these two builders in lockstep — see the module doc comment.
fn build_nav_message(env: &Env, asset_code: &Bytes, ts: u64, value: i128) -> Bytes {
    let colon = Bytes::from_slice(env, b":");
    let mut message = asset_code.clone();
    message.append(&colon);
    message.append(&decimal_ascii::u64_to_bytes(env, ts));
    message.append(&colon);
    message.append(&decimal_ascii::i128_to_bytes(env, value));
    message
}

fn require_nav_signature(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::RequireNavSignature)
        .unwrap_or(true)
}

fn read_config(env: &Env, asset: &Address) -> AssetGuardConfig {
    env.storage()
        .instance()
        .get(&DataKey::Config(asset.clone()))
        .expect("price-guard: asset not configured")
}

fn write_source(env: &Env, asset: &Address, name: &Symbol, value: i128, observed_at: u64) {
    let key = DataKey::Source(asset.clone(), name.clone());
    env.storage().persistent().set(
        &key,
        &PriceSource {
            name: name.clone(),
            value,
            observed_at,
            stale: false,
        },
    );
    ttl::extend_persistent(env, &key);
}

/// Every source name ever published for `asset`. Soroban has no native "list keys matching a
/// prefix", so this skeleton tracks the known source names explicitly per asset rather than
/// scanning storage — a short, explicit list, updated on first publish of a new source name.
fn track_source_name(env: &Env, asset: &Address, name: &Symbol) {
    let names_key = (Symbol::new(env, "src_names"), asset.clone());
    let mut names: Vec<Symbol> = env
        .storage()
        .instance()
        .get(&names_key)
        .unwrap_or_else(|| Vec::new(env));
    if !names.contains(name) {
        names.push_back(name.clone());
        env.storage().instance().set(&names_key, &names);
    }
}

fn read_all_sources(env: &Env, asset: &Address) -> Vec<PriceSource> {
    let names_key = (Symbol::new(env, "src_names"), asset.clone());
    let names: Vec<Symbol> = env
        .storage()
        .instance()
        .get(&names_key)
        .unwrap_or_else(|| Vec::new(env));
    let mut out = Vec::new(env);
    for name in names.iter() {
        if let Some(source) = env
            .storage()
            .persistent()
            .get::<_, PriceSource>(&DataKey::Source(asset.clone(), name.clone()))
        {
            out.push_back(source);
        }
    }
    out
}

fn is_fresh(env: &Env, source: &PriceSource, max_staleness_s: u64) -> bool {
    let now = env.ledger().timestamp();
    // A reading dated in the future is not "zero seconds old": `saturating_sub` would otherwise
    // report it fresh until the clock caught up, letting a bad timestamp (a unit mix-up, a skewed
    // issuer clock, a compromised publisher) pin a value as current for as long as it likes.
    !source.stale
        && source.observed_at <= now.saturating_add(MAX_FUTURE_SKEW_S)
        && now.saturating_sub(source.observed_at) <= max_staleness_s
}

/// How far ahead of the ledger clock a reading's timestamp may be (clock skew between the
/// publisher, the issuer and the network).
pub const MAX_FUTURE_SKEW_S: u64 = 60;

/// Rejects a reading that cannot be a price: non-positive, or dated further ahead than clock skew
/// explains.
fn require_sane_reading(env: &Env, value: i128, ts: u64) {
    assert!(value > 0, "price-guard: price must be positive");
    assert!(
        ts <= env.ledger().timestamp().saturating_add(MAX_FUTURE_SKEW_S),
        "price-guard: reading is dated in the future"
    );
}

/// A tiny fixed-capacity insertion sort over `Vec<i128>` without pulling in `alloc` (this crate is
/// `no_std` without the `alloc` feature). Fine for the small number of price sources this
/// contract ever handles (a handful, not thousands).
mod alloc_free_sort {
    pub struct SortBuf {
        items: [i128; 8],
        len: usize,
    }

    impl SortBuf {
        pub fn from(values: &soroban_sdk::Vec<i128>) -> Self {
            // Fail loudly rather than silently dropping sources past capacity — a median
            // computed from an arbitrary subset of sources (instead of all of them) is exactly
            // the kind of quiet data loss the Price Guard exists to prevent.
            assert!(
                values.len() as usize <= 8,
                "price-guard: more than 8 fresh sources for one asset, raise SortBuf capacity"
            );
            let mut items = [0i128; 8];
            let len = values.len() as usize;
            for (i, item) in items.iter_mut().enumerate().take(len) {
                *item = values.get(i as u32).unwrap();
            }
            SortBuf { items, len }
        }

        pub fn sort(&mut self) {
            for i in 1..self.len {
                let key = self.items[i];
                let mut j = i;
                while j > 0 && self.items[j - 1] > key {
                    self.items[j] = self.items[j - 1];
                    j -= 1;
                }
                self.items[j] = key;
            }
        }

        pub fn len(&self) -> usize {
            self.len
        }

        pub fn get(&self, i: usize) -> i128 {
            self.items[i]
        }
    }
}

fn within_band(values: &[i128], band_bps: u32) -> bool {
    if values.len() < 2 {
        return true;
    }
    let min = *values.iter().min().unwrap();
    let max = *values.iter().max().unwrap();
    if min <= 0 {
        return false;
    }
    let deviation_bps = ((max - min) * 10_000) / min;
    deviation_bps <= band_bps as i128
}

/// Records `to` as `asset`'s latest status and emits `status_changed` when it differs from the
/// previous one (an asset with no recorded status counts as coming from `Degraded`).
fn check_and_emit_status_change(env: &Env, asset: &Address, to: PriceStatus, value: i128) {
    let key = DataKey::LastStatus(asset.clone());
    let prev: Option<PriceStatus> = env.storage().instance().get(&key);
    let changed = match &prev {
        Some(from) => from != &to,
        None => true,
    };
    if changed {
        let from = prev.unwrap_or(PriceStatus::Degraded);
        env.storage().instance().set(&key, &to);
        env.events().publish(
            (Symbol::new(env, "status_changed"), asset.clone()),
            (from, to, value),
        );
    }
}

/// The PRD §6.4 rules, evaluated against the sources as they stand, writing back what the result
/// implies: a `Halted` latch (with the value that caused it) or the new `LastGood` baseline.
///
/// For an odd source count, the median is the middle value. For an even source count, the median
/// is the average of the two middle values rounded down (conservative collateral valuation).
///
/// Run on **every publish** as well as on every `guarded_price` call. A Soroban read is a
/// simulation and persists nothing, so if only reads evaluated the guard, the latch would never
/// stick and the baseline would never move until some unrelated transaction happened to call it;
/// the daily-move check would then compare against a baseline days old and halt on ordinary yield
/// drift. Evaluating at publish time keeps the baseline current and makes a jump latch at once.
fn evaluate(env: &Env, asset: Address) -> GuardedPrice {
    let config = read_config(&env, &asset);
    let all_sources = read_all_sources(&env, &asset);

    let mut fresh_values: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    let mut fresh_sources: soroban_sdk::Vec<PriceSource> = soroban_sdk::Vec::new(&env);
    for source in all_sources.iter() {
        if is_fresh(&env, &source, config.max_staleness_s) {
            fresh_values.push_back(source.value);
            fresh_sources.push_back(source.clone());
        }
    }

    let last_good: Option<i128> = env
        .storage()
        .instance()
        .get(&DataKey::LastGood(asset.clone()));
    let already_halted: bool = env
        .storage()
        .instance()
        .get(&DataKey::Halted(asset.clone()))
        .unwrap_or(false);

    let now = env.ledger().timestamp();

    if already_halted {
        let val = last_good.unwrap_or(0);
        check_and_emit_status_change(env, &asset, PriceStatus::Halted, val);
        return GuardedPrice {
            asset,
            value: val,
            status: PriceStatus::Halted,
            ts: now,
            sources: fresh_sources,
        };
    }

    if fresh_values.len() < 2 {
        let val = last_good.unwrap_or(0);
        check_and_emit_status_change(env, &asset, PriceStatus::Degraded, val);
        return GuardedPrice {
            asset,
            value: val,
            status: PriceStatus::Degraded,
            ts: now,
            sources: fresh_sources,
        };
    }

    let mut plain_values: alloc_free_sort::SortBuf =
        alloc_free_sort::SortBuf::from(&fresh_values);
    plain_values.sort();
    let len = plain_values.len();
    let median_value = if len % 2 == 1 {
        plain_values.get(len / 2)
    } else {
        (plain_values.get(len / 2 - 1) + plain_values.get(len / 2)) / 2
    };

    let mut as_array: [i128; 8] = [0; 8];
    for (i, slot) in as_array.iter_mut().enumerate().take(len) {
        *slot = plain_values.get(i);
    }
    if !within_band(&as_array[..len], config.band_bps) {
        let val = last_good.unwrap_or(0);
        check_and_emit_status_change(env, &asset, PriceStatus::Degraded, val);
        return GuardedPrice {
            asset,
            value: val,
            status: PriceStatus::Degraded,
            ts: now,
            sources: fresh_sources,
        };
    }

    if let Some(last) = last_good {
        if last > 0 {
            let move_bps = (((median_value - last).abs()) * 10_000) / last;
            if move_bps > config.daily_move_band_bps as i128 {
                env.storage()
                    .instance()
                    .set(&DataKey::Halted(asset.clone()), &true);
                env.storage()
                    .instance()
                    .set(&DataKey::PendingHaltValue(asset.clone()), &median_value);
                env.events().publish(
                    (Symbol::new(env, "halt_latched"), asset.clone()),
                    (last, median_value),
                );
                check_and_emit_status_change(env, &asset, PriceStatus::Halted, last);
                return GuardedPrice {
                    asset,
                    value: last,
                    status: PriceStatus::Halted,
                    ts: now,
                    sources: fresh_sources,
                };
            }
        }
    }

    // Rolling reference: catches slow cumulative drift that stays inside `daily_move_band_bps` on
    // each individual step. The reference is refreshed at most once per `window_seconds`, so a
    // publisher ramping the price a little on every publish eventually trips the window band even
    // though every single step passed the daily band.
    let rolling_ref: Option<i128> = env
        .storage()
        .instance()
        .get(&DataKey::RollingReference(asset.clone()));
    let rolling_ref_ts: Option<u64> = env
        .storage()
        .instance()
        .get(&DataKey::RollingReferenceUpdated(asset.clone()));

    if let Some(reference) = rolling_ref {
        if reference > 0 {
            let drift_bps = (((median_value - reference).abs()) * 10_000) / reference;
            if drift_bps > config.window_move_band_bps as i128 {
                env.storage()
                    .instance()
                    .set(&DataKey::Halted(asset.clone()), &true);
                env.storage()
                    .instance()
                    .set(&DataKey::PendingHaltValue(asset.clone()), &median_value);
                // Report the last good value, like every other Halted path, not the older reference.
                let held = last_good.unwrap_or(reference);
                env.events().publish(
                    (Symbol::new(env, "halt_latched"), asset.clone()),
                    (held, median_value),
                );
                check_and_emit_status_change(env, &asset, PriceStatus::Halted, held);
                return GuardedPrice {
                    asset,
                    value: held,
                    status: PriceStatus::Halted,
                    ts: now,
                    sources: fresh_sources,
                };
            }
        }
    }

    // Refresh the rolling reference only once per window. Leaving it in place between refreshes is
    // what makes a slow ramp accumulate against a fixed baseline instead of chasing the price.
    if rolling_ref_ts.map_or(true, |ts| now.saturating_sub(ts) >= config.window_seconds) {
        env.storage()
            .instance()
            .set(&DataKey::RollingReference(asset.clone()), &median_value);
        env.storage()
            .instance()
            .set(&DataKey::RollingReferenceUpdated(asset.clone()), &now);
    }

    env.storage()
        .instance()
        .set(&DataKey::LastGood(asset.clone()), &median_value);

    check_and_emit_status_change(env, &asset, PriceStatus::Ok, median_value);

    GuardedPrice {
        asset,
        value: median_value,
        status: PriceStatus::Ok,
        ts: now,
        sources: fresh_sources,
    }
}

#[contract]
pub struct PriceGuard;

#[contractimpl]
impl PriceGuard {
    pub fn initialize(
        env: Env,
        admin: Address,
        pauser: Address,
        keeper: Address,
        price_publisher: Address,
        risk: Address,
    ) {
        ttl::extend_instance(&env);
        if access::has_roles(&env) {
            panic!("price-guard: already initialized");
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

    /// Current role addresses. Used by scripts and tests to confirm a rotation landed.
    pub fn roles(env: Env) -> Roles {
        access::read_roles(&env)
    }

    /// Step 1 of a two-step admin transfer: the stored admin names its successor. A later proposal
    /// replaces an earlier one, so a mistyped address can be corrected without waiting.
    pub fn propose_admin(env: Env, new_admin: Address) {
        ttl::extend_instance(&env);
        access::propose_admin(&env, &new_admin);
    }

    /// Step 2 of a two-step admin transfer: the proposed successor accepts. Consumes the proposal.
    pub fn accept_admin(env: Env) {
        ttl::extend_instance(&env);
        access::accept_admin(&env);
    }

    /// The proposed successor from `propose_admin`, if a transfer is pending.
    pub fn pending_admin(env: Env) -> Option<Address> {
        access::pending_admin(&env)
    }

    /// Queues a timelocked non-admin role rotation and returns the id to pass to
    /// `execute_role_change` once the 48h delay has elapsed. Only the admin may queue; execution is
    /// permissionless. Rotating `price_publisher` this way preserves all contract state — see the
    /// module doc comment and `contracts/README.md` for the accompanying `configure_issuer_key`
    /// step.
    pub fn queue_role_change(env: Env, role: access::RoleKind, new_address: Address) -> u64 {
        ttl::extend_instance(&env);
        access::queue_role_change(&env, role, &new_address)
    }

    /// Applies a `queue_role_change` entry once its 48h timelock has elapsed.
    pub fn execute_role_change(env: Env, id: u64) {
        ttl::extend_instance(&env);
        access::execute_role_change(&env, id)
    }

    /// The outstanding queued change for `id`, including its `executes_at` timestamp.
    pub fn pending_role_change(env: Env, id: u64) -> Option<access::PendingRoleChange> {
        access::pending_role_change(&env, id)
    }

    /// Queues a timelocked contract upgrade to `new_wasm_hash`.
    /// Admin only. Executable after 48h.
    pub fn queue_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        upgrade::queue_upgrade(&env, &new_wasm_hash)
    }

    /// Cancels a pending contract upgrade.
    /// Admin only.
    pub fn cancel_upgrade(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        upgrade::cancel_upgrade(&env, id);
    }

    /// Executes a queued contract upgrade once the 48h timelock has elapsed.
    /// Permissionless once ready.
    pub fn execute_upgrade(env: Env, id: u64) {
        ttl::extend_instance(&env);
        upgrade::execute_upgrade(&env, id);
    }

    /// Returns the pending upgrade for `id`, if one exists.
    pub fn pending_upgrade(env: Env, id: u64) -> Option<upgrade::PendingUpgrade> {
        upgrade::pending_upgrade(&env, id)
    }

    /// Admin-set per-asset thresholds. Kept local to this contract rather than cross-called from
    /// `Registry` — see the module docs on the general Registry-decoupling simplification used
    /// across this pass's contracts.
    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        band_bps: u32,
        daily_move_band_bps: u32,
        window_seconds: u64,
        window_move_band_bps: u32,
        max_staleness_s: u64,
    ) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        env.storage().instance().set(
            &DataKey::Config(asset.clone()),
            &AssetGuardConfig {
                band_bps,
                daily_move_band_bps,
                window_seconds,
                window_move_band_bps,
                max_staleness_s,
            },
        );
        env.storage().instance().set(
            &DataKey::LastStatus(asset.clone()),
            &PriceStatus::Degraded,
        );
        env.events().publish(
            (Symbol::new(&env, "configure_asset"), asset),
            (
                band_bps,
                daily_move_band_bps,
                window_seconds,
                window_move_band_bps,
                max_staleness_s,
            ),
        );
    }

    /// Admin-only. Registers/rotates the raw Ed25519 public key `asset`'s issuer signs NAV
    /// readings with — see the module doc comment. Required before `publish_nav` can succeed for
    /// `asset` while `require_nav_signature` is `true`. Call this with the new publisher's raw
    /// public key when rotating `price_publisher` and the publisher is also the NAV attestor.
    pub fn configure_issuer_key(
        env: Env,
        admin: Address,
        asset: Address,
        issuer_pubkey: BytesN<32>,
    ) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::IssuerPubKey(asset.clone()), &issuer_pubkey);
        env.events().publish(
            (Symbol::new(&env, "configure_issuer_key"), asset),
            issuer_pubkey,
        );
    }

    /// Admin-only. Global (not per-asset) toggle for whether `publish_nav` verifies `sig` at all —
    /// see the module doc comment on why this exists and why it defaults to `true`.
    pub fn configure_signature_requirement(env: Env, admin: Address, required: bool) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::RequireNavSignature, &required);
        env.events().publish(
            (Symbol::new(&env, "configure_signature_requirement"),),
            required,
        );
    }

    /// PRD §8: issuer-signed NAV. See the module doc comment on `sig` — verified against the
    /// asset's registered issuer key (`configure_issuer_key`) whenever `require_nav_signature` is
    /// `true` (the default), over the canonical message built from `asset_code`/`ts`/`value`.
    pub fn publish_nav(
        env: Env,
        publisher: Address,
        asset: Address,
        asset_code: Bytes,
        value: i128,
        ts: u64,
        sig: BytesN<64>,
    ) {
        publisher.require_auth();
        access::require_price_publisher(&env);
        ttl::extend_instance(&env);
        read_config(&env, &asset); // asserts the asset is configured
        require_sane_reading(&env, value, ts);

        if require_nav_signature(&env) {
            let issuer_pubkey: BytesN<32> = env
                .storage()
                .instance()
                .get(&DataKey::IssuerPubKey(asset.clone()))
                .expect("price-guard: no issuer public key configured for asset (call configure_issuer_key)");
            let message = build_nav_message(&env, &asset_code, ts, value);
            // Panics (traps the whole invocation) if `sig` doesn't verify — see
            // `soroban_sdk::crypto::Crypto::ed25519_verify`'s doc comment.
            env.crypto().ed25519_verify(&issuer_pubkey, &message, &sig);
        }

        env.storage().instance().set(
            &DataKey::NavRecord(asset.clone()),
            &NavRecord { value, ts, sig },
        );

        let name = Symbol::new(&env, ISSUER_SOURCE);
        track_source_name(&env, &asset, &name);
        write_source(&env, &asset, &name, value, ts);

        env.events().publish(
            (Symbol::new(&env, "nav_published"), asset.clone()),
            (Symbol::new(&env, ISSUER_SOURCE), value, ts),
        );

        evaluate(&env, asset);
    }

    /// PRD §6.4's other inputs: the independent SEP-40 feed and the last observed redemption
    /// price (see the module doc comment on why these are pushed rather than cross-called).
    /// `source` is a caller-chosen tag, e.g. `redston` or `redemp`.
    pub fn publish_source(
        env: Env,
        publisher: Address,
        asset: Address,
        source: Symbol,
        value: i128,
        ts: u64,
    ) {
        publisher.require_auth();
        access::require_price_publisher(&env);
        ttl::extend_instance(&env);
        read_config(&env, &asset);
        require_sane_reading(&env, value, ts);

        track_source_name(&env, &asset, &source);
        write_source(&env, &asset, &source, value, ts);

        env.events().publish(
            (Symbol::new(&env, "source_published"), asset.clone()),
            (source.clone(), value, ts),
        );

        evaluate(&env, asset);
    }

    /// The core PRD §6.4 rules, run fresh on every call:
    /// 1. Fewer than 2 fresh sources -> `Degraded`, value = last good.
    /// 2. Fresh sources disagree beyond `band_bps` -> `Degraded`, value = last good.
    /// 3. Otherwise, if the new median moved more than `daily_move_band_bps` against the last
    ///    good value -> `Halted` (sticky, until `confirm_halt_cleared`), value = last good.
    /// 4. Otherwise -> `Ok`, value = the new median, and this becomes the new "last good".
    ///
    /// Median rule:
    /// - For an odd number of fresh sources: middle value after sorting (`len / 2`).
    /// - For an even number of fresh sources: average of the two middle values rounded down
    ///   (`(plain_values.get(len / 2 - 1) + plain_values.get(len / 2)) / 2`), providing conservative
    ///   valuation for collateral.
    pub fn guarded_price(env: Env, asset: Address) -> GuardedPrice {
        evaluate(&env, asset)
    }

    /// SEP-40-shaped alias, so other protocols (Blend, Templar — PRD §14) could eventually consume
    /// this contract as a price feed. Same data as `guarded_price`.
    pub fn lastprice(env: Env, asset: Address) -> GuardedPrice {
        Self::guarded_price(env, asset)
    }

    /// Clears a sticky halt (PRD §6.4: "no liquidations until a human confirms"). A human calling
    /// this is asserting the large move was real, not manipulation — so the value that triggered
    /// the halt is promoted to `LastGood` as the new baseline. Without this, the very next
    /// `guarded_price` call would recompute the same still-large move against the stale baseline
    /// and immediately re-halt.
    pub fn confirm_halt_cleared(env: Env, risk: Address, asset: Address) {
        risk.require_auth();
        access::require_risk(&env);
        ttl::extend_instance(&env);

        let mut new_last_good = 0i128;
        if let Some(pending) = env
            .storage()
            .instance()
            .get::<_, i128>(&DataKey::PendingHaltValue(asset.clone()))
        {
            env.storage()
                .instance()
                .set(&DataKey::LastGood(asset.clone()), &pending);
            new_last_good = pending;
            env.storage()
                .instance()
                .set(&DataKey::RollingReference(asset.clone()), &pending);
            env.storage()
                .instance()
                .set(
                    &DataKey::RollingReferenceUpdated(asset.clone()),
                    &env.ledger().timestamp(),
                );
            env.storage()
                .instance()
                .remove(&DataKey::PendingHaltValue(asset.clone()));
        } else if let Some(last) = env
            .storage()
            .instance()
            .get::<_, i128>(&DataKey::LastGood(asset.clone()))
        {
            new_last_good = last;
        }
        env.storage().instance().remove(&DataKey::Halted(asset.clone()));

        env.events().publish(
            (Symbol::new(&env, "halt_cleared"), asset.clone()),
            new_last_good,
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    /// Default rolling window used by most tests: 24h, with a 1% (100 bp) window band. A publisher
    /// ramping the price a little on every publish trips this eventually; ordinary yield (a few bp
    /// per day) stays well inside it.
    const DEFAULT_WINDOW_SECONDS: u64 = 86_400;
    const DEFAULT_WINDOW_MOVE_BAND_BPS: u32 = 100;

    fn setup_with_admin(
        band_bps: u32,
        daily_move_band_bps: u32,
        max_staleness_s: u64,
    ) -> (Env, PriceGuardClient<'static>, Address, Address, Address, Address) {
        setup_with_admin_and_window(
            band_bps,
            daily_move_band_bps,
            DEFAULT_WINDOW_SECONDS,
            DEFAULT_WINDOW_MOVE_BAND_BPS,
            max_staleness_s,
        )
    }

    fn setup_with_admin_and_window(
        band_bps: u32,
        daily_move_band_bps: u32,
        window_seconds: u64,
        window_move_band_bps: u32,
        max_staleness_s: u64,
    ) -> (Env, PriceGuardClient<'static>, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let id = env.register(PriceGuard, ());
        let client = PriceGuardClient::new(&env, &id);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        client.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

        let asset = Address::generate(&env);
        client.configure_asset(
            &admin,
            &asset,
            &band_bps,
            &daily_move_band_bps,
            &window_seconds,
            &window_move_band_bps,
            &max_staleness_s,
        );

        // These tests exercise the median/band/staleness/halt logic, not signature verification
        // (which has its own dedicated tests below) — turn the check off so a zero-filled `sig`
        // doesn't panic every call here.
        client.configure_signature_requirement(&admin, &false);

        (env, client, admin, price_publisher, risk, asset)
    }

    fn setup(
        band_bps: u32,
        daily_move_band_bps: u32,
        max_staleness_s: u64,
    ) -> (Env, PriceGuardClient<'static>, Address, Address, Address) {
        let (env, client, _admin, price_publisher, risk, asset) =
            setup_with_admin(band_bps, daily_move_band_bps, max_staleness_s);
        (env, client, price_publisher, risk, asset)
    }

    const SCALE: i128 = ballast_common::price::PRICE_SCALE;

    fn asset_code(env: &Env) -> Bytes {
        Bytes::from_slice(env, b"TESTASSET")
    }

    /// A real (but fixed/deterministic, test-only) Ed25519 keypair via `ed25519-dalek`, plus a
    /// helper to sign the exact canonical message `publish_nav` verifies
    /// (`build_nav_message` above) — so the signature tests below exercise real crypto, not a
    /// stub.
    fn test_issuer_keypair(env: &Env) -> (BytesN<32>, ed25519_dalek::SigningKey) {
        let seed = [9u8; 32];
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let pubkey_bytes = signing_key.verifying_key().to_bytes();
        (BytesN::from_array(env, &pubkey_bytes), signing_key)
    }

    fn sign_nav(
        env: &Env,
        signing_key: &ed25519_dalek::SigningKey,
        code: &Bytes,
        ts: u64,
        value: i128,
    ) -> BytesN<64> {
        use ed25519_dalek::Signer;
        let message = build_nav_message(env, code, ts, value);
        let mut message_bytes = [0u8; 256];
        let len = message.len() as usize;
        message.copy_into_slice(&mut message_bytes[..len]);
        let sig = signing_key.sign(&message_bytes[..len]);
        BytesN::from_array(env, &sig.to_bytes())
    }

    #[test]
    fn fewer_than_two_fresh_sources_is_degraded() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        client.publish_nav(
            &publisher,
            &asset,
            &code,
            &SCALE,
            &env.ledger().timestamp(),
            &sig,
        );

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Degraded);
    }

    #[test]
    fn disagreeing_fresh_sources_beyond_band_is_degraded() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        // 5% off from SCALE -> 500 bps, well beyond a 50 bps band.
        let redstone = Symbol::new(&env, "redston");
        client.publish_source(&publisher, &asset, &redstone, &(SCALE + SCALE / 20), &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Degraded);
    }

    #[test]
    fn stale_source_is_excluded_and_can_drop_below_threshold() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 100);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let t0 = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &t0, &sig);
        let redstone = Symbol::new(&env, "redston");
        client.publish_source(&publisher, &asset, &redstone, &SCALE, &t0);

        // Advance time past max_staleness_s for both sources.
        env.ledger().with_mut(|l| l.timestamp = t0 + 200);
        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Degraded);
    }

    #[test]
    fn big_daily_move_halts_and_stays_halted_until_cleared() {
        let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let t0 = env.ledger().timestamp();
        let redstone = Symbol::new(&env, "redston");

        // First establish a good median at SCALE.
        client.publish_nav(&publisher, &asset, &code, &SCALE, &t0, &sig);
        client.publish_source(&publisher, &asset, &redstone, &SCALE, &t0);
        let first = client.guarded_price(&asset);
        assert_eq!(first.status, PriceStatus::Ok);

        // Now both sources agree on a value 2% higher -> within band (50bps band would actually
        // reject this pair too, so widen band check: use a large jump both sources agree on).
        let moved = SCALE + SCALE / 50; // +2%
        client.publish_nav(&publisher, &asset, &code, &moved, &(t0 + 10), &sig);
        client.publish_source(&publisher, &asset, &redstone, &moved, &(t0 + 10));

        let second = client.guarded_price(&asset);
        assert_eq!(second.status, PriceStatus::Halted);

        // Stays halted on a subsequent read even though sources still agree.
        let third = client.guarded_price(&asset);
        assert_eq!(third.status, PriceStatus::Halted);

        client.confirm_halt_cleared(&risk, &asset);
        let fourth = client.guarded_price(&asset);
        assert_eq!(fourth.status, PriceStatus::Ok);
    }

    #[test]
    fn agreeing_fresh_sources_within_band_is_ok() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        let redstone = Symbol::new(&env, "redston");
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &redstone, &SCALE, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, SCALE);
    }

    #[test]
    fn valid_issuer_signature_is_accepted() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env); // note: distinct from setup()'s internal admin —
                                             // configure_issuer_key/configure_signature_requirement mock_all_auths() so any address
                                             // passes require_auth() in this test env; what matters here is the pubkey/signature match.
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &signing_key, &code, now, SCALE);
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);

        let redstone = Symbol::new(&env, "redston");
        client.publish_source(&publisher, &asset, &redstone, &SCALE, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, SCALE);
    }

    #[test]
    #[should_panic]
    fn invalid_issuer_signature_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        let now = env.ledger().timestamp();
        // Signed over a DIFFERENT value than what's actually published -> verification must fail.
        let sig = sign_nav(&env, &signing_key, &code, now, SCALE + 1);
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    }

    // --- publisher rotation ------------------------------------------------------------------

    /// A publisher rotation is queued, waits out the 48h timelock, and then applies in place: the
    /// old publisher is rejected, the new one is accepted, and the state a redeploy would have lost
    /// (`LastGood`, the published sources) is still there.
    #[test]
    fn queued_publisher_rotation_rejects_the_old_publisher_and_accepts_the_new_one() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        // A week of staleness so the 48h wait does not age the readings out: this test is about
        // the rotation preserving them, not about freshness.
        let (env, client, old_publisher, _risk, asset) = setup(50, 10_000, 7 * 24 * 3600);
        let code = asset_code(&env);
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        let source = feed(&env);
        let t0 = env.ledger().timestamp();

        client.publish_nav(&old_publisher, &asset, &code, &SCALE, &t0, &zero_sig);
        client.publish_source(&old_publisher, &asset, &source, &SCALE, &t0);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        let new_publisher = Address::generate(&env);
        let id = client.queue_role_change(&access::RoleKind::PricePublisher, &new_publisher);
        assert_eq!(
            client.roles().price_publisher,
            old_publisher,
            "queueing must not change the role yet"
        );

        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_role_change(&id);
        }));
        assert!(
            early.is_err(),
            "a queued rotation must wait out the timelock"
        );

        // Advance the ledger sequence too (48h of ledgers), so a queued entry that could be
        // evicted before the delay elapsed would be gone by now.
        env.ledger().with_mut(|l| {
            l.timestamp = t0 + ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 34_561;
        });
        client.execute_role_change(&id);
        assert_eq!(client.roles().price_publisher, new_publisher);

        // Neither the guarded price nor its baseline was reset by the rotation.
        let price = client.guarded_price(&asset);
        assert_eq!((price.status, price.value), (PriceStatus::Ok, SCALE));

        let now = env.ledger().timestamp();
        env.mock_auths(&[MockAuth {
            address: &old_publisher,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "publish_source",
                args: (
                    old_publisher.clone(),
                    asset.clone(),
                    source.clone(),
                    SCALE,
                    now,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let old = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_source(&old_publisher, &asset, &source, &SCALE, &now);
        }));
        assert!(old.is_err(), "the rotated-out publisher must be rejected");

        // `publish_source` authenticates the caller and then the stored publisher role; when those
        // are the same address, both checks need a mock entry (real auth is one signature covering
        // both).
        let new_auth = MockAuth {
            address: &new_publisher,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "publish_source",
                args: (
                    new_publisher.clone(),
                    asset.clone(),
                    source.clone(),
                    SCALE,
                    now,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        };
        env.mock_auths(&[new_auth.clone(), new_auth]);
        client.publish_source(&new_publisher, &asset, &source, &SCALE, &now);

        // The role also gates `publish_nav`, which is the key that signs every NAV.
        let nav_auth = MockAuth {
            address: &new_publisher,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "publish_nav",
                args: (
                    new_publisher.clone(),
                    asset.clone(),
                    code.clone(),
                    SCALE,
                    now,
                    zero_sig.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        };
        env.mock_auths(&[nav_auth.clone(), nav_auth]);
        client.publish_nav(&new_publisher, &asset, &code, &SCALE, &now, &zero_sig);
    }

    #[test]
    fn admin_transfer_requires_the_proposed_admin_to_accept() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _publisher, _risk, _asset) = setup(50, 10_000, 3600);
        let current_admin = client.roles().admin;
        let new_admin = Address::generate(&env);

        client.propose_admin(&new_admin);

        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.accept_admin();
        }));
        assert!(
            rejected.is_err(),
            "only the proposed admin may accept the transfer"
        );
        assert_eq!(client.roles().admin, current_admin);

        env.mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.accept_admin();
        assert_eq!(client.roles().admin, new_admin);
    }

    #[test]
    fn a_stranger_cannot_queue_a_role_change() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _publisher, _risk, _asset) = setup(50, 10_000, 3600);
        let stranger = Address::generate(&env);
        let new_publisher = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_role_change",
                args: (access::RoleKind::PricePublisher, new_publisher.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_role_change(&access::RoleKind::PricePublisher, &new_publisher);
        }));
        assert!(
            result.is_err(),
            "only the stored admin may queue a role change"
        );
    }

    #[test]
    #[should_panic]
    fn issuer_signature_for_another_asset_code_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &signing_key, &code, now, SCALE);
        let other_code = Bytes::from_slice(&env, b"OTHERASSET");
        client.publish_nav(&publisher, &asset, &other_code, &SCALE, &now, &sig);
    }

    #[test]
    #[should_panic]
    fn issuer_signature_for_another_timestamp_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &signing_key, &code, now + 1, SCALE);
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    }

    #[test]
    #[should_panic]
    fn issuer_signature_from_another_key_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, _signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        let other_signing_key = ed25519_dalek::SigningKey::from_bytes(&[10u8; 32]);
        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &other_signing_key, &code, now, SCALE);
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    }

    #[test]
    #[should_panic]
    fn random_issuer_signature_bytes_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, _signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        let now = env.ledger().timestamp();
        let random_sig = BytesN::from_array(&env, &[0x5au8; 64]);
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &random_sig);
    }

    /// Records current behaviour (issue #16), not a guarantee: a signature over an older
    /// (ts, value) pair still verifies, so a captured signed reading can be replayed. Nothing
    /// ties the message to a deployment or orders readings; see #90 for the message binding.
    #[test]
    fn valid_historical_issuer_signature_is_accepted() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        client.configure_signature_requirement(&admin, &true);

        env.ledger().set_timestamp(1_000);
        let now = env.ledger().timestamp();
        let historical_ts = now - 1;
        let sig = sign_nav(&env, &signing_key, &code, historical_ts, SCALE);
        client.publish_nav(&publisher, &asset, &code, &SCALE, &historical_ts, &sig);
    }

    // --- adversarial cases -------------------------------------------------------------------

    fn feed(env: &Env) -> Symbol {
        Symbol::new(env, "redston")
    }

    /// The 2026-02-22 shape: one venue's price is pushed far from reality while the issuer's NAV is
    /// unchanged. The guard must refuse to call that a price, however big the push.
    #[test]
    fn a_manipulated_feed_against_an_unmoved_nav_is_never_ok() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        for multiple in [2i128, 10, 100] {
            client.publish_source(&publisher, &asset, &feed(&env), &(SCALE * multiple), &now);
            let price = client.guarded_price(&asset);
            assert_eq!(price.status, PriceStatus::Degraded, "{multiple}x must not be Ok");
            assert_eq!(price.value, SCALE, "the value stays at the last good price, not the pushed one");
        }
    }

    /// Replay of the 2026-02-22 YieldBlox / USTRY manipulation path (PRD §11, Backlog B-0082).
    /// NAV remains fixed at 1.0, while an independent feed steps up +0.1% per publish to +5%, then
    /// drops back down. With a 50 bps band, no step beyond +0.5% may be Ok, the published value
    /// must never exceed the NAV by more than the band, and the guard must not Halt on the way back down.
    /// With the NAV and this one feed as the only sources, an Ok price is their average, so it
    /// moves at half the feed's step; Degraded steps hold the last good price.
    #[test]
    fn scripted_replay_ustry_manipulation_2026_02_22() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let mut now = env.ledger().timestamp();
        let feed_name = feed(&env);

        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);

        struct Step {
            step: u32,
            feed_value: i128,
            expected_status: PriceStatus,
            expected_value: i128,
        }

        let max_allowed = SCALE + (SCALE * 50) / 10_000;

        let steps = [
            Step { step: 0, feed_value: SCALE, expected_status: PriceStatus::Ok, expected_value: SCALE },
            Step { step: 1, feed_value: SCALE + 10_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 5_000 },
            Step { step: 2, feed_value: SCALE + 20_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 10_000 },
            Step { step: 3, feed_value: SCALE + 30_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 15_000 },
            Step { step: 4, feed_value: SCALE + 40_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 20_000 },
            Step { step: 5, feed_value: SCALE + 50_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 25_000 },
            Step { step: 6, feed_value: SCALE + 60_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 7, feed_value: SCALE + 100_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 8, feed_value: SCALE + 200_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 9, feed_value: SCALE + 300_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 10, feed_value: SCALE + 400_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 11, feed_value: SCALE + 500_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 12, feed_value: SCALE + 400_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 13, feed_value: SCALE + 250_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 14, feed_value: SCALE + 100_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 15, feed_value: SCALE + 60_000, expected_status: PriceStatus::Degraded, expected_value: SCALE + 25_000 },
            Step { step: 16, feed_value: SCALE + 50_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 25_000 },
            Step { step: 17, feed_value: SCALE + 40_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 20_000 },
            Step { step: 18, feed_value: SCALE + 20_000, expected_status: PriceStatus::Ok, expected_value: SCALE + 10_000 },
            Step { step: 19, feed_value: SCALE, expected_status: PriceStatus::Ok, expected_value: SCALE },
        ];

        assert!(steps.len() >= 15, "table must cover at least 15 steps");

        for s in steps.iter() {
            now += 10;
            env.ledger().set_timestamp(now);
            client.publish_source(&publisher, &asset, &feed_name, &s.feed_value, &now);

            let price = client.guarded_price(&asset);
            assert_eq!(
                price.status, s.expected_status,
                "step {}: feed {} expected status {:?}, got {:?}",
                s.step, s.feed_value, s.expected_status, price.status
            );
            assert_eq!(
                price.value, s.expected_value,
                "step {}: feed {} expected value {}, got {}",
                s.step, s.feed_value, s.expected_value, price.value
            );
            assert!(
                price.value <= max_allowed,
                "step {}: price {} must never exceed NAV by more than band ({})",
                s.step, price.value, max_allowed
            );
            assert_ne!(
                price.status,
                PriceStatus::Halted,
                "step {}: guard must not Halt on the way back down",
                s.step
            );
        }
    }

    #[test]
    fn one_fresh_source_can_never_set_a_price_however_large_the_move() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        // The NAV goes stale; the attacker keeps pushing the feed. One fresh source is not enough.
        env.ledger().set_timestamp(now + 7_200);
        client.publish_source(&publisher, &asset, &feed(&env), &(SCALE * 3), &(now + 7_200));
        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Degraded);
        assert_eq!(price.value, SCALE);
    }

    #[test]
    fn a_jump_both_sources_agree_on_latches_a_halt_at_publish_time() {
        let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);

        let jumped = SCALE * 13 / 10; // +30%
        client.publish_nav(&publisher, &asset, &code, &jumped, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &jumped, &now);

        // Nobody has asked for the price yet: the publish itself latched the halt, so a draw that
        // reads it next sees Halted at the old value.
        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Halted);
        assert_eq!(price.value, SCALE);

        // A human confirming it was real promotes the new value to the baseline.
        client.confirm_halt_cleared(&risk, &asset);
        let price = client.guarded_price(&asset);
        assert_eq!((price.status, price.value), (PriceStatus::Ok, jumped));
    }

    /// Ordinary yield must never trip the guard. One basis point an hour for a full day is 24 bp in
    /// total: every step is under the daily band, and the total stays inside the 100 bp window band.
    #[test]
    fn steady_drift_in_small_steps_never_halts() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let mut now = env.ledger().timestamp();
        let mut value = SCALE;
        client.publish_nav(&publisher, &asset, &code, &value, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &value, &now);

        for _ in 0..24 {
            now += 3_600;
            env.ledger().set_timestamp(now);
            value = value * 10_001 / 10_000; // +1 bp per hour
            client.publish_nav(&publisher, &asset, &code, &value, &now, &sig);
            client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
        }

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok, "realistic yield drift must not halt");
        assert_eq!(price.value, value);
    }

    /// The other side of the same coin: a publisher ramping the price a little on every publish.
    /// Each step passes the daily band (so the old consecutive check alone would never fire), but
    /// the cumulative move against the rolling reference trips the window band and halts.
    #[test]
    fn a_slow_ramp_beyond_the_window_band_halts() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        let mut value = SCALE;
        client.publish_nav(&publisher, &asset, &code, &value, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        // +0.9% per publish: inside the 1% daily band on every step, +2.7% by the third publish.
        for _ in 0..3 {
            value = value * 1_009 / 1_000;
            client.publish_nav(&publisher, &asset, &code, &value, &now, &sig);
            client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
        }

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Halted, "slow ramp must trip the window band");
        // The second step (+1.8% against the reference) trips it; the value held is the last good
        // one, the first step's, the same as for a daily-band halt.
        assert_eq!(price.value, SCALE * 1_009 / 1_000);
    }

    #[test]
    fn a_future_dated_reading_is_rejected_and_never_counts_as_fresh() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        env.ledger().set_timestamp(10_000);
        let now = env.ledger().timestamp();

        // Within clock skew is fine.
        client.publish_nav(&publisher, &asset, &code, &SCALE, &(now + MAX_FUTURE_SKEW_S), &sig);

        // Beyond it is refused outright (a ms-for-s mix-up lands here).
        let far = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &(now * 1_000));
        }));
        assert!(far.is_err(), "a timestamp in the far future must be refused");
    }

    #[test]
    fn a_reading_that_ages_into_staleness_stops_counting() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        env.ledger().set_timestamp(now + 3_601);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Degraded);
    }

    #[test]
    fn a_zero_or_negative_price_is_refused() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        for bad in [0i128, -SCALE] {
            let nav = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.publish_nav(&publisher, &asset, &code, &bad, &now, &sig);
            }));
            let src = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.publish_source(&publisher, &asset, &feed(&env), &bad, &now);
            }));
            assert!(nav.is_err() && src.is_err(), "{bad} must be refused");
        }
    }

    /// With `mock_all_auths` anyone's signature counts, which would hide a missing role check. These
    /// two tests authorize *only* the stranger, so a call succeeds only if the contract fails to
    /// demand the stored role's own signature.
    #[test]
    fn a_stranger_cannot_publish_a_price_even_naming_themselves_publisher() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, _publisher, _risk, asset) = setup(50, 100, 3600);
        let stranger = Address::generate(&env);
        let now = env.ledger().timestamp();
        let source = feed(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "publish_source",
                args: (stranger.clone(), asset.clone(), source.clone(), SCALE, now).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_source(&stranger, &asset, &source, &SCALE, &now);
        }));
        assert!(result.is_err(), "only the stored price publisher may publish");
    }

    #[test]
    fn a_stranger_cannot_clear_a_halt() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        let jumped = SCALE * 2;
        client.publish_nav(&publisher, &asset, &code, &jumped, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &jumped, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);

        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "confirm_halt_cleared",
                args: (stranger.clone(), asset.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.confirm_halt_cleared(&stranger, &asset);
        }));
        assert!(result.is_err(), "only the risk role may clear a halt");
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);
    }

    #[test]
    fn halted_guard_stays_halted_across_further_publishes_and_keeps_last_good() {
        let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let t0 = env.ledger().timestamp();
        let feed = feed(&env);

        // Establish a good baseline at SCALE.
        client.publish_nav(&publisher, &asset, &code, &SCALE, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed, &SCALE, &t0);
        let baseline = client.guarded_price(&asset);
        assert_eq!(baseline.status, PriceStatus::Ok);
        assert_eq!(baseline.value, SCALE);

        // Both sources agree on a jump beyond the daily band -> halt latches at publish time.
        let jumped = SCALE * 13 / 10;
        client.publish_nav(&publisher, &asset, &code, &jumped, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed, &jumped, &t0);
        let halted = client.guarded_price(&asset);
        assert_eq!(halted.status, PriceStatus::Halted);
        assert_eq!(halted.value, SCALE);

        // Post-halt publishes: sources agree on calm values (including the old price). The guard
        // must not move LastGood and must stay Halted.
        for value in [SCALE, SCALE + SCALE / 100, SCALE] {
            client.publish_nav(&publisher, &asset, &code, &value, &t0, &sig);
            client.publish_source(&publisher, &asset, &feed, &value, &t0);
            let price = client.guarded_price(&asset);
            assert_eq!(price.status, PriceStatus::Halted);
            assert_eq!(price.value, SCALE);
        }

        // Sources going stale while halted still report Halted, not Degraded.
        env.ledger().set_timestamp(t0 + 3_601);
        let stale = client.guarded_price(&asset);
        assert_eq!(stale.status, PriceStatus::Halted);
        assert_eq!(stale.value, SCALE);

        // Confirm clears the latch and promotes the value that tripped it (`jumped`) to the new
        // baseline. The sources are stale, so the guard is not Ok until a fresh publish arrives.
        client.confirm_halt_cleared(&risk, &asset);
        assert_ne!(client.guarded_price(&asset).status, PriceStatus::Ok);

        // A fresh publish at the confirmed value then evaluates normally. (Publishing the old calm
        // price instead would move 30% against the new baseline and halt again.)
        let t1 = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &jumped, &t1, &sig);
        client.publish_source(&publisher, &asset, &feed, &jumped, &t1);
        let after = client.guarded_price(&asset);
        assert_eq!(after.status, PriceStatus::Ok);
        assert_eq!(after.value, jumped);
    }

    #[test]
    fn events_emitted_for_all_state_changes_and_configurations() {
        use soroban_sdk::testutils::Events as _;
        use soroban_sdk::xdr::{ContractEventBody, ScSymbol, ScVal};

        let env = Env::default();
        env.mock_all_auths();

        let id = env.register(PriceGuard, ());
        let client = PriceGuardClient::new(&env, &id);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        client.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

        let asset = Address::generate(&env);

        let has_event = |events: &soroban_sdk::testutils::ContractEvents, topic0: &str| -> bool {
            let target = ScVal::Symbol(ScSymbol(topic0.try_into().unwrap()));
            events
                .filter_by_contract(&client.address)
                .events()
                .iter()
                .any(|e| match &e.body {
                    ContractEventBody::V0(b) => b.topics.first() == Some(&target),
                })
        };

        // 1. configure_asset event
        client.configure_asset(&admin, &asset, &50, &100, &86_400, &100, &3600);
        let events = env.events().all();
        assert!(has_event(&events, "configure_asset"), "configure_asset event must be emitted");

        // 2. configure_issuer_key event
        let (pubkey, _) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &pubkey);
        let events = env.events().all();
        assert!(has_event(&events, "configure_issuer_key"), "configure_issuer_key event must be emitted");

        // 3. configure_signature_requirement event
        client.configure_signature_requirement(&admin, &false);
        let events = env.events().all();
        assert!(has_event(&events, "configure_signature_requirement"), "configure_signature_requirement event must be emitted");

        // 4. nav_published event
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&price_publisher, &asset, &code, &SCALE, &now, &sig);
        let events = env.events().all();
        assert!(has_event(&events, "nav_published"), "nav_published event must be emitted");

        // 5. source_published event & status_changed event (from Degraded -> Ok)
        client.publish_source(&price_publisher, &asset, &feed(&env), &SCALE, &now);
        let events = env.events().all();
        assert!(has_event(&events, "source_published"), "source_published event must be emitted");
        assert!(has_event(&events, "status_changed"), "status_changed event must be emitted");

        // 6. halt_latched event & status_changed event (from Ok -> Halted)
        let jumped = SCALE * 2;
        client.publish_nav(&price_publisher, &asset, &code, &jumped, &now, &sig);
        client.publish_source(&price_publisher, &asset, &feed(&env), &jumped, &now);
        let events = env.events().all();
        assert!(has_event(&events, "halt_latched"), "halt_latched event must be emitted");

        // 7. halt_cleared event & status_changed event (from Halted -> Ok)
        client.confirm_halt_cleared(&risk, &asset);
        let events = env.events().all();
        assert!(has_event(&events, "halt_cleared"), "halt_cleared event must be emitted");
    }

    #[test]
    fn a_stranger_cannot_configure_an_asset() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _publisher, _risk, _asset) = setup_with_admin(50, 100, 3600);
        let stranger = Address::generate(&env);
        let new_asset = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "configure_asset",
                args: (stranger.clone(), new_asset.clone(), 60u32, 120u32, 86_400u64, 100u32, 1800u64)
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_asset(&stranger, &new_asset, &60, &120, &86_400, &100, &1800);
        }));
        assert!(result.is_err(), "only the stored admin may configure an asset");

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        client.configure_asset(&admin, &new_asset, &60, &120, &86_400, &100, &1800);
    }

    #[test]
    fn a_stranger_cannot_configure_issuer_key() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let stranger = Address::generate(&env);
        let (pubkey, _) = test_issuer_keypair(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "configure_issuer_key",
                args: (stranger.clone(), asset.clone(), pubkey.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_issuer_key(&stranger, &asset, &pubkey);
        }));
        assert!(result.is_err(), "only the stored admin may configure issuer key");

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        client.configure_issuer_key(&admin, &asset, &pubkey);
    }

    #[test]
    fn a_stranger_cannot_configure_signature_requirement() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _publisher, _risk, _asset) = setup_with_admin(50, 100, 3600);
        let stranger = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "configure_signature_requirement",
                args: (stranger.clone(), true).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_signature_requirement(&stranger, &true);
        }));
        assert!(result.is_err(), "only the stored admin may configure signature requirement");

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        client.configure_signature_requirement(&admin, &true);
    }

    #[test]
    fn publish_extends_ttl_and_survives_ledger_advancement() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        let feed_name = feed(&env);

        // Initial publish establishes the persistent source entries and instance state.
        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &now);

        let initial_price = client.guarded_price(&asset);
        assert_eq!(initial_price.status, PriceStatus::Ok);
        assert_eq!(initial_price.value, SCALE);

        // Advance sequence number past initial TTL (10,000 ledgers).
        let current_seq = env.ledger().sequence();
        env.ledger().set_sequence_number(current_seq + 10_000);
        env.ledger().set_timestamp(now + 60);

        // State remains accessible because publish extended instance and persistent TTL.
        // A subsequent publish and read both succeed.
        let next_now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &code, &SCALE, &next_now, &sig);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &next_now);

        let next_price = client.guarded_price(&asset);
        assert_eq!(next_price.status, PriceStatus::Ok);
        assert_eq!(next_price.value, SCALE);
    }

    #[test]
    fn a_stranger_cannot_queue_or_cancel_upgrade() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _publisher, _risk, _asset) = setup_with_admin(50, 10_000, 3600);
        let stranger = Address::generate(&env);
        let dummy_wasm = BytesN::from_array(&env, &[1u8; 32]);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_upgrade",
                args: (stranger.clone(), dummy_wasm.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_upgrade(&stranger, &dummy_wasm);
        }));
        assert!(result.is_err(), "only the stored admin may queue an upgrade");

        env.mock_all_auths();
        let id = client.queue_upgrade(&admin, &dummy_wasm);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "cancel_upgrade",
                args: (stranger.clone(), id).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let cancel_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.cancel_upgrade(&stranger, &id);
        }));
        assert!(cancel_res.is_err(), "only the stored admin may cancel an upgrade");

        env.mock_all_auths();
        client.cancel_upgrade(&admin, &id);
        assert_eq!(client.pending_upgrade(&id), None);
    }

    #[test]
    fn execute_upgrade_requires_the_timelock_to_elapse() {
        let (env, client, admin, _publisher, _risk, _asset) = setup_with_admin(50, 10_000, 3600);
        let dummy_wasm = BytesN::from_array(&env, &[2u8; 32]);
        let id = client.queue_upgrade(&admin, &dummy_wasm);

        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_upgrade(&id);
        }));
        assert!(early.is_err(), "cannot execute upgrade before 48h elapses");
    }

    #[test]
    fn test_price_guard_upgrade_and_state_persistence() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        let feed_name = feed(&env);

        client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        const NEW_WASM: &[u8] = include_bytes!("../../../vendor/test_wasms/contract.wasm");
        let new_wasm_hash = env.deployer().upload_contract_wasm(NEW_WASM);

        let id = client.queue_upgrade(&admin, &new_wasm_hash);
        assert_eq!(
            client.pending_upgrade(&id),
            Some(ballast_common::upgrade::PendingUpgrade {
                new_wasm_hash: new_wasm_hash.clone(),
                executes_at: env.ledger().timestamp() + 48 * 3600,
            })
        );

        // Advance 48 hours
        env.ledger().set_timestamp(env.ledger().timestamp() + 48 * 3600);
        client.execute_upgrade(&id);

        env.as_contract(&client.address, || {
            assert_eq!(ballast_common::upgrade::pending_upgrade(&env, id), None);
        });

        mod upgraded {
            soroban_sdk::contractimport!(file = "../../vendor/test_wasms/contract.wasm");
        }
        let upgraded_client = upgraded::Client::new(&env, &client.address);
        let sum = upgraded_client.add(&15, &27);
        assert_eq!(sum, 42);

        // State persists: the last good price and config established before upgrade are still in storage
        env.as_contract(&client.address, || {
            let last_good: Option<i128> = env.storage().instance().get(&DataKey::LastGood(asset.clone()));
            assert_eq!(last_good, Some(SCALE));
            let config = read_config(&env, &asset);
            assert_eq!(config.band_bps, 50);
            assert_eq!(config.daily_move_band_bps, 10_000);
        });
    }

    #[test]
    fn median_of_two_sources_averages_middle_rounded_down() {
        // Band of 100 bps (1%), daily move band 10,000 bps (100%).
        let (env, client, publisher, _risk, asset) = setup(100, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        // 1.0000000 and 1.0050000 (diff is 50 bps, within 100 bps band).
        let val1 = SCALE; // 10_000_000
        let val2 = SCALE + 50_000; // 10_050_000 (1.005)
        let expected = (val1 + val2) / 2; // 10_025_000 (1.0025)

        client.publish_nav(&publisher, &asset, &code, &val1, &now, &sig);
        let feed_name = feed(&env);
        client.publish_source(&publisher, &asset, &feed_name, &val2, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, expected);
    }

    #[test]
    fn median_of_four_sources_averages_middle_two_rounded_down() {
        // Band of 100 bps, daily move band 10,000 bps.
        let (env, client, publisher, _risk, asset) = setup(100, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        // Four sorted values: 10_000_000, 10_020_000, 10_040_001, 10_050_000.
        // Middle two: 10_020_000 and 10_040_001.
        // Sum = 20_060_001. Average rounded down = 10_030_000.
        let v1 = SCALE; // 10_000_000
        let v2 = SCALE + 20_000; // 10_020_000
        let v3 = SCALE + 40_001; // 10_040_001
        let v4 = SCALE + 50_000; // 10_050_000
        let expected = (v2 + v3) / 2;

        client.publish_nav(&publisher, &asset, &code, &v1, &now, &sig);
        let s2 = Symbol::new(&env, "feed_2");
        let s3 = Symbol::new(&env, "feed_3");
        let s4 = Symbol::new(&env, "feed_4");
        client.publish_source(&publisher, &asset, &s2, &v2, &now);
        client.publish_source(&publisher, &asset, &s3, &v3, &now);
        client.publish_source(&publisher, &asset, &s4, &v4, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, expected);
        assert_eq!(price.value, 10_030_000);
    }

    #[test]
    fn median_of_odd_sources_returns_middle_value() {
        // Band of 100 bps.
        let (env, client, publisher, _risk, asset) = setup(100, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        // Three sorted values: 10_000_000, 10_030_000, 10_060_000.
        // Middle is 10_030_000.
        let v1 = SCALE;
        let v2 = SCALE + 30_000;
        let v3 = SCALE + 60_000;

        client.publish_nav(&publisher, &asset, &code, &v1, &now, &sig);
        let s2 = Symbol::new(&env, "feed_2");
        let s3 = Symbol::new(&env, "feed_3");
        client.publish_source(&publisher, &asset, &s2, &v2, &now);
        client.publish_source(&publisher, &asset, &s3, &v3, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, v2);
    }

    mod invariants;
}
