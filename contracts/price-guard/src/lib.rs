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
//! `env.crypto().ed25519_verify(..)` over the canonical message
//! `"ballast-nav-v1:{contract}:{asset_code}:{ts}:{value}"` — the SAME message the off-chain
//! `price-guard` service signs and verifies before it ever calls `publish_nav` (see
//! `services/price-guard/src/navSignature.ts`). `{contract}` is this PriceGuard's own `C...`
//! strkey and `asset_code` is the asset's ticker as raw UTF-8 bytes, bound on-chain once by
//! `configure_issuer_key` (`DataKey::AssetCode`) rather than passed to `publish_nav` (#90). A
//! signature is therefore valid for exactly one deployment and one asset: it cannot be replayed
//! on a redeployed PriceGuard or against another asset that shares the issuer key. The code
//! cannot be changed once bound; a different ticker means a new asset entry.
//!
//! An admin-settable `require_nav_signature` flag, kept **per asset** (`DataKey::RequireNavSignature`,
//! `true` when never set; see `configure_signature_requirement`), exists as a local-testing/bring-up
//! affordance: a fresh local/testnet asset has no issuer key registered yet, and forcing signature
//! checks on from its very first `publish_nav` call would brick the smoke-test flow before anyone's
//! had a chance to run `configure_issuer_key`. It is NOT a security control — production deploys
//! should leave it at its default `true` once real issuer keys are configured. Because the flag is
//! per asset, turning it off for a test asset leaves every other asset on the same contract
//! signature-checked. Requiring signatures applies at once; disabling them applies at once only
//! while the asset has no stored flag and no published reading (bring-up), and otherwise has to go
//! through `queue_config` and the 48h timelock. See `contracts/README.md` for the
//! testnet-smoke-flow implication.
//!
//! **Storage layout.** All per-asset state (`Config`, `Source`, `SourceNames`, `NavRecord`,
//! `LastGood`, `RollingReference`, `RollingReferenceUpdated`, `Halted`, `PendingHaltValue`,
//! `IssuerPubKey`, `AssetCode`, `RequireNavSignature`, `LastStatus`, `SourceAllowed`,
//! `SourceMaxStaleness`) lives in persistent storage, one entry per
//! key, with the TTL extended (`ttl::extend_persistent`) whenever the entry is read or written.
//! Queued config changes, role changes and upgrades are persistent too. The instance entry holds
//! only the roles, a pending admin transfer and the timelock id counter, so its size does not grow
//! with the number of assets. This layout replaced one that kept the per-asset keys in instance
//! storage: an existing deployment must be redeployed, not upgraded in place (see
//! `contracts/README.md`).
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
    timelock, ttl, upgrade,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val,
    Vec,
};

const ISSUER_SOURCE: &str = "issuer";

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LastGood {
    pub value: i128,
    pub ts: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetGuardConfig {
    pub band_bps: u32,
    pub daily_move_band_bps: u32,
    pub max_staleness_s: u64,
    pub window_seconds: u64,
    pub window_move_band_bps: u32,
}

/// What a risk operator needs to see before calling `confirm_halt_cleared`, returned by
/// `halt_info` while an asset is halted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HaltInfo {
    /// The baseline `guarded_price` keeps returning while halted. `None` if none was ever recorded.
    pub last_good: Option<i128>,
    /// The median that tripped the halt; confirming promotes it to the new `last_good`.
    pub pending: Option<i128>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigChange {
    BandBps(Address, u32),
    DailyMoveBandBps(Address, u32),
    WindowSeconds(Address, u64),
    WindowMoveBandBps(Address, u32),
    MaxStalenessSeconds(Address, u64),
    Asset(Address, u32, u32, u64, u32, u64),
    IssuerPubKey(Address, BytesN<32>),
    RequireNavSignature(Address, bool),
    /// Per-source staleness window (issue #86): `(asset, source name, seconds)`. `0` clears the
    /// override so the source falls back to the asset's `max_staleness_s`. Widening a window or
    /// clearing it must go through `queue_config`; `configure_source_staleness` only tightens.
    SourceMaxStaleness(Address, Symbol, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingConfigChange {
    pub change: ConfigChange,
    pub executes_at: u64,
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
    SourceNames(Address),
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
    /// Per-asset admin-settable flag, default `true` when unset — see the module doc
    /// comment on why this exists and why it isn't a security control.
    RequireNavSignature(Address),
    /// Last evaluated PriceStatus for `asset`, tracked to emit `status_changed` events on transitions.
    LastStatus(Address),
    PendingConfig(u64),
    /// Admin-managed source allowlist flag per (asset, source-name) (issue #84).
    SourceAllowed(Address, Symbol),
    /// The asset's ticker (raw UTF-8 bytes) that its NAV signatures are bound to, set once by
    /// `configure_issuer_key` and never changed (issue #90).
    AssetCode(Address),
    /// Per-source max staleness override in seconds for (asset, source-name) (issue #86). When
    /// absent, the asset's `max_staleness_s` applies.
    SourceMaxStaleness(Address, Symbol),
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

/// Domain tag that starts every NAV message, versioned so a future format can never be confused
/// with this one.
const NAV_MESSAGE_DOMAIN: &[u8] = b"ballast-nav-v1";

/// Builds the canonical NAV message `"ballast-nav-v1:{contract}:{asset_code}:{ts}:{value}"`
/// (UTF-8 bytes) that both this contract and the off-chain `price-guard` service
/// (`services/price-guard/src/navSignature.ts`) sign/verify against. `contract` is the verifying
/// PriceGuard's address, rendered as its `C...` strkey. Keep these two builders in lockstep — see
/// the module doc comment.
fn build_nav_message(
    env: &Env,
    contract: &Address,
    asset_code: &Bytes,
    ts: u64,
    value: i128,
) -> Bytes {
    let colon = Bytes::from_slice(env, b":");
    let mut message = Bytes::from_slice(env, NAV_MESSAGE_DOMAIN);
    message.append(&colon);
    message.append(&contract.to_string().to_bytes());
    message.append(&colon);
    message.append(asset_code);
    message.append(&colon);
    message.append(&decimal_ascii::u64_to_bytes(env, ts));
    message.append(&colon);
    message.append(&decimal_ascii::i128_to_bytes(env, value));
    message
}

fn require_nav_signature(env: &Env, asset: &Address) -> bool {
    let key = DataKey::RequireNavSignature(asset.clone());
    let res: Option<bool> = env.storage().persistent().get(&key);
    if res.is_some() {
        ttl::extend_persistent(env, &key);
    }
    res.unwrap_or(true)
}

/// Whether any reading (NAV or feed) has ever been accepted for `asset`. Before the first one the
/// asset is still being brought up, which is the only time `configure_signature_requirement` may
/// switch an unset signature requirement off without the timelock.
fn has_published_readings(env: &Env, asset: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::SourceNames(asset.clone()))
        || env
            .storage()
            .persistent()
            .has(&DataKey::NavRecord(asset.clone()))
}

fn read_config(env: &Env, asset: &Address) -> AssetGuardConfig {
    let key = DataKey::Config(asset.clone());
    let config: AssetGuardConfig = env
        .storage()
        .persistent()
        .get(&key)
        .expect("price-guard: asset not configured");
    ttl::extend_persistent(env, &key);
    config
}

fn is_source_allowed(env: &Env, asset: &Address, name: &Symbol) -> bool {
    if name == &Symbol::new(env, ISSUER_SOURCE) {
        return true;
    }
    let key = DataKey::SourceAllowed(asset.clone(), name.clone());
    let allowed: Option<bool> = env.storage().persistent().get(&key);
    if allowed.is_some() {
        ttl::extend_persistent(env, &key);
    }
    allowed.unwrap_or(false)
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
    let names_key = DataKey::SourceNames(asset.clone());
    let mut names: Vec<Symbol> = env
        .storage()
        .persistent()
        .get(&names_key)
        .unwrap_or_else(|| Vec::new(env));
    if !names.contains(name) {
        names.push_back(name.clone());
        env.storage().persistent().set(&names_key, &names);
    }
    ttl::extend_persistent(env, &names_key);
}

fn remove_source_internal(env: &Env, asset: &Address, name: &Symbol) {
    let names_key = DataKey::SourceNames(asset.clone());
    let names: Vec<Symbol> = env
        .storage()
        .persistent()
        .get(&names_key)
        .unwrap_or_else(|| Vec::new(env));
    if let Some(idx) = names.first_index_of(name) {
        let mut new_names = Vec::new(env);
        for (i, n) in names.iter().enumerate() {
            if i as u32 != idx {
                new_names.push_back(n);
            }
        }
        env.storage().persistent().set(&names_key, &new_names);
        ttl::extend_persistent(env, &names_key);
    }
    let key = DataKey::Source(asset.clone(), name.clone());
    env.storage().persistent().remove(&key);
}

fn read_all_sources(env: &Env, asset: &Address) -> Vec<PriceSource> {
    let names_key = DataKey::SourceNames(asset.clone());
    let names: Vec<Symbol> = match env.storage().persistent().get(&names_key) {
        Some(names) => {
            ttl::extend_persistent(env, &names_key);
            names
        }
        None => Vec::new(env),
    };
    let mut out = Vec::new(env);
    for name in names.iter() {
        let key = DataKey::Source(asset.clone(), name.clone());
        if let Some(source) = env
            .storage()
            .persistent()
            .get::<_, PriceSource>(&key)
        {
            ttl::extend_persistent(env, &key);
            out.push_back(source);
        }
    }
    out
}

fn read_source_staleness(env: &Env, asset: &Address, name: &Symbol) -> Option<u64> {
    let key = DataKey::SourceMaxStaleness(asset.clone(), name.clone());
    let window: Option<u64> = env.storage().persistent().get(&key);
    if window.is_some() {
        ttl::extend_persistent(env, &key);
    }
    window
}

/// The staleness window `evaluate` applies to `name`: its override if one is set, otherwise the
/// asset's `max_staleness_s` (issue #86).
fn effective_source_staleness(
    env: &Env,
    asset: &Address,
    name: &Symbol,
    config: &AssetGuardConfig,
) -> u64 {
    read_source_staleness(env, asset, name).unwrap_or(config.max_staleness_s)
}

fn write_source_staleness(env: &Env, asset: &Address, name: &Symbol, max_staleness_s: u64) {
    let key = DataKey::SourceMaxStaleness(asset.clone(), name.clone());
    if max_staleness_s > 0 {
        env.storage().persistent().set(&key, &max_staleness_s);
        ttl::extend_persistent(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
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

/// True when the spread between the lowest and highest value, in bps of the lowest, is at most
/// `band_bps` (inclusive). Fewer than two values are trivially within band; a non-positive
/// minimum never is.
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
    let prev: Option<PriceStatus> = env.storage().persistent().get(&key);
    let changed = match &prev {
        Some(from) => from != &to,
        None => true,
    };
    if changed {
        let from = prev.unwrap_or(PriceStatus::Degraded);
        env.storage().persistent().set(&key, &to);
        ttl::extend_persistent(env, &key);
        env.events().publish(
            (Symbol::new(env, "status_changed"), asset.clone()),
            (from, to, value),
        );
    } else {
        ttl::extend_persistent(env, &key);
    }
}

/// Reads the `LastGood` baseline. A value stored by an earlier version as a bare `i128` decodes
/// with `ts = 0` until the next `Ok` evaluation rewrites it.
fn read_last_good(env: &Env, asset: &Address) -> Option<LastGood> {
    let key = DataKey::LastGood(asset.clone());
    let raw: Val = env
        .storage()
        .persistent()
        .get(&key)?;
    ttl::extend_persistent(env, &key);
    if let Ok(value) = i128::try_from_val(env, &raw) {
        return Some(LastGood { value, ts: 0 });
    }
    LastGood::try_from_val(env, &raw).ok()
}

fn write_last_good(env: &Env, asset: &Address, value: i128, ts: u64) {
    let key = DataKey::LastGood(asset.clone());
    env.storage()
        .persistent()
        .set(&key, &LastGood { value, ts });
    ttl::extend_persistent(env, &key);
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
    let config = read_config(env, &asset);
    let all_sources = read_all_sources(env, &asset);

    let mut fresh_values: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(env);
    let mut fresh_sources: soroban_sdk::Vec<PriceSource> = soroban_sdk::Vec::new(env);
    for source in all_sources.iter() {
        if !is_source_allowed(env, &asset, &source.name) {
            continue;
        }
        let max_staleness_s = effective_source_staleness(env, &asset, &source.name, &config);
        if is_fresh(env, &source, max_staleness_s) {
            fresh_values.push_back(source.value);
            fresh_sources.push_back(source.clone());
        }
    }

    let last_good = read_last_good(env, &asset);
    let last_good_val = last_good.as_ref().map(|lg| lg.value);
    let last_good_ts = last_good.as_ref().map_or(0, |lg| lg.ts);
    let halted_key = DataKey::Halted(asset.clone());
    let already_halted: bool = env
        .storage()
        .persistent()
        .get(&halted_key)
        .unwrap_or(false);

    let now = env.ledger().timestamp();

    if already_halted {
        ttl::extend_persistent(env, &halted_key);
        // Keep the value awaiting `confirm_halt_cleared` alive for as long as the latch is.
        let pending_key = DataKey::PendingHaltValue(asset.clone());
        if env.storage().persistent().has(&pending_key) {
            ttl::extend_persistent(env, &pending_key);
        }
        let val = last_good_val.unwrap_or(0);
        check_and_emit_status_change(env, &asset, PriceStatus::Halted, val);
        return GuardedPrice {
            asset,
            value: val,
            status: PriceStatus::Halted,
            ts: last_good_ts,
            sources: fresh_sources,
        };
    }

    if fresh_values.len() < 2 {
        let val = last_good_val.unwrap_or(0);
        check_and_emit_status_change(env, &asset, PriceStatus::Degraded, val);
        return GuardedPrice {
            asset,
            value: val,
            status: PriceStatus::Degraded,
            ts: last_good_ts,
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
        let val = last_good_val.unwrap_or(0);
        check_and_emit_status_change(env, &asset, PriceStatus::Degraded, val);
        return GuardedPrice {
            asset,
            value: val,
            status: PriceStatus::Degraded,
            ts: last_good_ts,
            sources: fresh_sources,
        };
    }

    if let Some(last) = last_good_val {
        if last > 0 {
            let move_bps = (((median_value - last).abs()) * 10_000) / last;
            if move_bps > config.daily_move_band_bps as i128 {
                let halted_key = DataKey::Halted(asset.clone());
                env.storage()
                    .persistent()
                    .set(&halted_key, &true);
                ttl::extend_persistent(env, &halted_key);
                let pending_key = DataKey::PendingHaltValue(asset.clone());
                env.storage()
                    .persistent()
                    .set(&pending_key, &median_value);
                ttl::extend_persistent(env, &pending_key);
                env.events().publish(
                    (Symbol::new(env, "halt_latched"), asset.clone()),
                    (last, median_value),
                );
                check_and_emit_status_change(env, &asset, PriceStatus::Halted, last);
                return GuardedPrice {
                    asset,
                    value: last,
                    status: PriceStatus::Halted,
                    ts: last_good_ts,
                    sources: fresh_sources,
                };
            }
        }
    }

    // Rolling reference: catches slow cumulative drift that stays inside `daily_move_band_bps` on
    // each individual step. The reference is refreshed at most once per `window_seconds`, so a
    // publisher ramping the price a little on every publish eventually trips the window band even
    // though every single step passed the daily band.
    let ref_key = DataKey::RollingReference(asset.clone());
    let rolling_ref: Option<i128> = env
        .storage()
        .persistent()
        .get(&ref_key);
    if rolling_ref.is_some() {
        ttl::extend_persistent(env, &ref_key);
    }
    let ref_ts_key = DataKey::RollingReferenceUpdated(asset.clone());
    let rolling_ref_ts: Option<u64> = env
        .storage()
        .persistent()
        .get(&ref_ts_key);
    if rolling_ref_ts.is_some() {
        ttl::extend_persistent(env, &ref_ts_key);
    }

    if let Some(reference) = rolling_ref {
        if reference > 0 {
            let drift_bps = (((median_value - reference).abs()) * 10_000) / reference;
            if drift_bps > config.window_move_band_bps as i128 {
                let halted_key = DataKey::Halted(asset.clone());
                env.storage()
                    .persistent()
                    .set(&halted_key, &true);
                ttl::extend_persistent(env, &halted_key);
                let pending_key = DataKey::PendingHaltValue(asset.clone());
                env.storage()
                    .persistent()
                    .set(&pending_key, &median_value);
                ttl::extend_persistent(env, &pending_key);
                // Report the last good value, like every other Halted path, not the older reference.
                let held = last_good_val.unwrap_or(reference);
                let held_ts = if last_good_val.is_some() {
                    last_good_ts
                } else {
                    rolling_ref_ts.unwrap_or(0)
                };
                env.events().publish(
                    (Symbol::new(env, "halt_latched"), asset.clone()),
                    (held, median_value),
                );
                check_and_emit_status_change(env, &asset, PriceStatus::Halted, held);
                return GuardedPrice {
                    asset,
                    value: held,
                    status: PriceStatus::Halted,
                    ts: held_ts,
                    sources: fresh_sources,
                };
            }
        }
    }

    // Refresh the rolling reference only once per window. Leaving it in place between refreshes is
    // what makes a slow ramp accumulate against a fixed baseline instead of chasing the price.
    if rolling_ref_ts.map_or(true, |ts| now.saturating_sub(ts) >= config.window_seconds) {
        let ref_key = DataKey::RollingReference(asset.clone());
        env.storage()
            .persistent()
            .set(&ref_key, &median_value);
        ttl::extend_persistent(env, &ref_key);
        let ref_ts_key = DataKey::RollingReferenceUpdated(asset.clone());
        env.storage()
            .persistent()
            .set(&ref_ts_key, &now);
        ttl::extend_persistent(env, &ref_ts_key);
    }

    write_last_good(env, &asset, median_value, now);

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
    ///
    /// Tightening changes (smaller bands, shorter staleness, longer window) apply immediately;
    /// loosening changes must be queued via `queue_config` and wait for the 48h timelock.
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

        let config_key = DataKey::Config(asset.clone());
        let existing: Option<AssetGuardConfig> = env
            .storage()
            .persistent()
            .get(&config_key);
        if let Some(old) = existing {
            let is_loosening = band_bps > old.band_bps
                || daily_move_band_bps > old.daily_move_band_bps
                || window_move_band_bps > old.window_move_band_bps
                || max_staleness_s > old.max_staleness_s
                || window_seconds < old.window_seconds;
            assert!(
                !is_loosening,
                "price-guard: loosening changes must be queued via queue_config"
            );
        }

        env.storage().persistent().set(
            &config_key,
            &AssetGuardConfig {
                band_bps,
                daily_move_band_bps,
                window_seconds,
                window_move_band_bps,
                max_staleness_s,
            },
        );
        ttl::extend_persistent(&env, &config_key);
        let status_key = DataKey::LastStatus(asset.clone());
        env.storage().persistent().set(
            &status_key,
            &PriceStatus::Degraded,
        );
        ttl::extend_persistent(&env, &status_key);
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
    /// readings with. Initial registration applies immediately; rotations must be queued
    /// via `queue_config` with a 48h delay to protect against key compromise.
    pub fn configure_issuer_key(
        env: Env,
        admin: Address,
        asset: Address,
        asset_code: Bytes,
        issuer_pubkey: BytesN<32>,
    ) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        assert!(!asset_code.is_empty(), "price-guard: asset code must not be empty");
        // The code is part of every signed NAV message (#90). Rebinding it would let a signature
        // made for another asset's code verify here, with no timelock, so it is bound once.
        let code_key = DataKey::AssetCode(asset.clone());
        let bound: Option<Bytes> = env.storage().persistent().get(&code_key);
        if let Some(bound) = bound {
            assert!(
                bound == asset_code,
                "price-guard: asset code is already bound for asset and cannot be changed"
            );
        }
        env.storage().persistent().set(&code_key, &asset_code);
        ttl::extend_persistent(&env, &code_key);
        let key = DataKey::IssuerPubKey(asset.clone());
        let existing: Option<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&key);
        if let Some(old) = existing {
            assert!(
                old == issuer_pubkey,
                "price-guard: rotating issuer key must be queued via queue_config"
            );
        }
        env.storage()
            .persistent()
            .set(&key, &issuer_pubkey);
        ttl::extend_persistent(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "configure_issuer_key"), asset),
            (asset_code, issuer_pubkey),
        );
    }

    /// The ticker bound to `asset`'s NAV signatures by `configure_issuer_key`, if any (#90).
    pub fn asset_code(env: Env, asset: Address) -> Option<Bytes> {
        ttl::extend_instance(&env);
        let key = DataKey::AssetCode(asset);
        let code: Option<Bytes> = env.storage().persistent().get(&key);
        if code.is_some() {
            ttl::extend_persistent(&env, &key);
        }
        code
    }

    /// Admin-only. Per-asset toggle for whether `publish_nav` verifies `sig` for `asset` (`true`
    /// when never set). Other assets are unaffected.
    ///
    /// Requiring signatures applies immediately. Disabling them applies immediately only while
    /// `asset` is being brought up: no flag stored for it yet and no reading ever published for it
    /// (the per-asset form of the old global flag's first-call rule). Otherwise, turning a
    /// requirement that is in force off must be queued via
    /// `queue_config(ConfigChange::RequireNavSignature(asset, false))` and wait out the 48h timelock.
    pub fn configure_signature_requirement(env: Env, admin: Address, asset: Address, required: bool) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        let key = DataKey::RequireNavSignature(asset.clone());
        if !required {
            let bringing_up =
                !env.storage().persistent().has(&key) && !has_published_readings(&env, &asset);
            if !bringing_up && require_nav_signature(&env, &asset) {
                panic!("price-guard: disabling signature requirement must be queued via queue_config");
            }
        }
        env.storage()
            .persistent()
            .set(&key, &required);
        ttl::extend_persistent(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "configure_signature_requirement"), asset),
            required,
        );
    }

    /// Admin-only. Allows or disallows an independent price source for an asset.
    /// Reserving `issuer` for `publish_nav`.
    pub fn configure_source(
        env: Env,
        admin: Address,
        asset: Address,
        name: Symbol,
        enabled: bool,
    ) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        read_config(&env, &asset);
        assert!(
            name != Symbol::new(&env, ISSUER_SOURCE),
            "price-guard: source name 'issuer' is reserved for publish_nav"
        );

        let allowed_key = DataKey::SourceAllowed(asset.clone(), name.clone());
        env.storage().persistent().set(&allowed_key, &enabled);
        ttl::extend_persistent(&env, &allowed_key);

        env.events().publish(
            (Symbol::new(&env, "configure_source"), asset.clone()),
            (name, enabled),
        );

        evaluate(&env, asset);
    }

    /// Returns whether a price source name is currently allowlisted for `asset`.
    pub fn is_source_allowed(env: Env, asset: Address, name: Symbol) -> bool {
        is_source_allowed(&env, &asset, &name)
    }

    /// Admin-only. Sets a per-source staleness window for `name` on `asset` (issue #86), e.g. a
    /// daily issuer NAV next to a feed that updates every few minutes. Applies immediately only
    /// when it **tightens**: `max_staleness_s` must be positive and no larger than the window the
    /// source has now (its override, or the asset's `max_staleness_s`). A wider window keeps old
    /// readings counting for longer, which is loosening, so it goes through
    /// `queue_config(ConfigChange::SourceMaxStaleness(..))` and the 48h timelock, the same as
    /// `configure_asset`; so does clearing an override (`0`).
    pub fn configure_source_staleness(
        env: Env,
        admin: Address,
        asset: Address,
        name: Symbol,
        max_staleness_s: u64,
    ) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        let config = read_config(&env, &asset);
        assert!(
            max_staleness_s > 0,
            "price-guard: clearing a source staleness window requires queue_config"
        );
        assert!(
            max_staleness_s <= effective_source_staleness(&env, &asset, &name, &config),
            "price-guard: widening a source staleness window requires queue_config"
        );

        write_source_staleness(&env, &asset, &name, max_staleness_s);
        env.events().publish(
            (Symbol::new(&env, "source_staleness_set"), asset.clone()),
            (name, max_staleness_s),
        );

        evaluate(&env, asset);
    }

    /// The per-source staleness override for `name` on `asset`, or `None` when the asset's
    /// `max_staleness_s` applies (issue #86).
    pub fn source_staleness(env: Env, asset: Address, name: Symbol) -> Option<u64> {
        read_source_staleness(&env, &asset, &name)
    }

    /// Admin-only. Removes a price source entry and deletes its name from the tracked source names
    /// for `asset`. Unknown name removal is a safe no-op.
    pub fn remove_source(env: Env, admin: Address, asset: Address, name: Symbol) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        read_config(&env, &asset);

        env.storage()
            .persistent()
            .remove(&DataKey::SourceAllowed(asset.clone(), name.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::SourceMaxStaleness(asset.clone(), name.clone()));
        remove_source_internal(&env, &asset, &name);

        env.events().publish(
            (Symbol::new(&env, "source_removed"), asset.clone()),
            name,
        );

        evaluate(&env, asset);
    }

    /// Queues a loosening configuration change, subject to a 48h timelock delay.
    /// Admin only. Returns the monotonic ID for `execute_config`.
    pub fn queue_config(env: Env, admin: Address, change: ConfigChange) -> u64 {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);

        let id = timelock::next_id(&env);
        let key = DataKey::PendingConfig(id);
        let executes_at = timelock::executes_at(&env);
        env.storage().persistent().set(
            &key,
            &PendingConfigChange {
                change: change.clone(),
                executes_at,
            },
        );
        timelock::extend_entry_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "config_queued"), id),
            (change, executes_at),
        );
        id
    }

    /// Cancels a pending configuration change. Admin only.
    pub fn cancel_config(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        access::require_admin(&env);
        ttl::extend_instance(&env);
        let key = DataKey::PendingConfig(id);
        let pending: PendingConfigChange = env
            .storage()
            .persistent()
            .get(&key)
            .expect("price-guard: no such pending change");
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "config_cancelled"), id), pending.change);
    }

    /// Applies a queued configuration change once the 48h timelock has elapsed.
    /// Permissionless.
    pub fn execute_config(env: Env, id: u64) {
        ttl::extend_instance(&env);
        let key = DataKey::PendingConfig(id);
        let pending: PendingConfigChange = env
            .storage()
            .persistent()
            .get(&key)
            .expect("price-guard: no such pending change");
        assert!(
            timelock::is_ready(&env, pending.executes_at),
            "price-guard: timelock has not elapsed"
        );

        match pending.change.clone() {
            ConfigChange::BandBps(asset, val) => {
                let key = DataKey::Config(asset.clone());
                let mut config: AssetGuardConfig = env
                    .storage()
                    .persistent()
                    .get(&key)
                    .expect("price-guard: asset not configured");
                config.band_bps = val;
                env.storage()
                    .persistent()
                    .set(&key, &config);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::DailyMoveBandBps(asset, val) => {
                let key = DataKey::Config(asset.clone());
                let mut config: AssetGuardConfig = env
                    .storage()
                    .persistent()
                    .get(&key)
                    .expect("price-guard: asset not configured");
                config.daily_move_band_bps = val;
                env.storage()
                    .persistent()
                    .set(&key, &config);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::WindowSeconds(asset, val) => {
                let key = DataKey::Config(asset.clone());
                let mut config: AssetGuardConfig = env
                    .storage()
                    .persistent()
                    .get(&key)
                    .expect("price-guard: asset not configured");
                config.window_seconds = val;
                env.storage()
                    .persistent()
                    .set(&key, &config);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::WindowMoveBandBps(asset, val) => {
                let key = DataKey::Config(asset.clone());
                let mut config: AssetGuardConfig = env
                    .storage()
                    .persistent()
                    .get(&key)
                    .expect("price-guard: asset not configured");
                config.window_move_band_bps = val;
                env.storage()
                    .persistent()
                    .set(&key, &config);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::MaxStalenessSeconds(asset, val) => {
                let key = DataKey::Config(asset.clone());
                let mut config: AssetGuardConfig = env
                    .storage()
                    .persistent()
                    .get(&key)
                    .expect("price-guard: asset not configured");
                config.max_staleness_s = val;
                env.storage()
                    .persistent()
                    .set(&key, &config);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::Asset(asset, band, daily, win_sec, win_move, staleness) => {
                let key = DataKey::Config(asset.clone());
                let config = AssetGuardConfig {
                    band_bps: band,
                    daily_move_band_bps: daily,
                    window_seconds: win_sec,
                    window_move_band_bps: win_move,
                    max_staleness_s: staleness,
                };
                env.storage()
                    .persistent()
                    .set(&key, &config);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::IssuerPubKey(asset, key_val) => {
                let key = DataKey::IssuerPubKey(asset);
                env.storage()
                    .persistent()
                    .set(&key, &key_val);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::RequireNavSignature(asset, val) => {
                let key = DataKey::RequireNavSignature(asset);
                env.storage()
                    .persistent()
                    .set(&key, &val);
                ttl::extend_persistent(&env, &key);
            }
            ConfigChange::SourceMaxStaleness(asset, name, val) => {
                read_config(&env, &asset);
                write_source_staleness(&env, &asset, &name, val);
            }
        }
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "config_executed"), id), pending.change);
    }

    /// Read-only inspection of a pending config change.
    pub fn pending_config(env: Env, id: u64) -> Option<PendingConfigChange> {
        ttl::extend_instance(&env);
        let key = DataKey::PendingConfig(id);
        let res = env.storage().persistent().get(&key);
        if res.is_some() {
            timelock::extend_entry_ttl(&env, &key);
        }
        res
    }

    /// Read-only inspection of an asset guard config.
    pub fn asset_config(env: Env, asset: Address) -> Option<AssetGuardConfig> {
        ttl::extend_instance(&env);
        let key = DataKey::Config(asset);
        let res = env.storage().persistent().get(&key);
        if res.is_some() {
            ttl::extend_persistent(&env, &key);
        }
        res
    }

    /// Read-only inspection of whether NAV signatures are required for `asset`.
    pub fn require_nav_signature(env: Env, asset: Address) -> bool {
        ttl::extend_instance(&env);
        require_nav_signature(&env, &asset)
    }

    /// Read-only inspection of an asset's issuer public key.
    pub fn issuer_pubkey(env: Env, asset: Address) -> Option<BytesN<32>> {
        ttl::extend_instance(&env);
        let key = DataKey::IssuerPubKey(asset);
        let res = env.storage().persistent().get(&key);
        if res.is_some() {
            ttl::extend_persistent(&env, &key);
        }
        res
    }

    /// Read-only: the halt latch for `asset`. `None` while the asset is not halted. While halted,
    /// shows the baseline `guarded_price` is holding and the value `confirm_halt_cleared` would
    /// promote, so a risk operator can check both before confirming.
    pub fn halt_info(env: Env, asset: Address) -> Option<HaltInfo> {
        ttl::extend_instance(&env);
        let halted_key = DataKey::Halted(asset.clone());
        let halted: bool = env
            .storage()
            .persistent()
            .get(&halted_key)
            .unwrap_or(false);
        if !halted {
            return None;
        }
        ttl::extend_persistent(&env, &halted_key);
        let pending_key = DataKey::PendingHaltValue(asset.clone());
        let pending = env.storage().persistent().get(&pending_key);
        if pending.is_some() {
            ttl::extend_persistent(&env, &pending_key);
        }
        Some(HaltInfo {
            last_good: read_last_good(&env, &asset).map(|lg| lg.value),
            pending,
        })
    }

    /// Read-only: the last guarded value that reached `Ok`, which `guarded_price` falls back to
    /// while `Degraded` or `Halted`. `None` if the asset has never reached `Ok`.
    pub fn last_good(env: Env, asset: Address) -> Option<i128> {
        ttl::extend_instance(&env);
        read_last_good(&env, &asset).map(|lg| lg.value)
    }

    /// PRD §8: issuer-signed NAV. See the module doc comment on `sig` — verified against the
    /// asset's registered issuer key (`configure_issuer_key`) whenever `require_nav_signature` is
    /// `true` (the default), over the canonical message built from `asset_code`/`ts`/`value`.
    pub fn publish_nav(
        env: Env,
        publisher: Address,
        asset: Address,
        value: i128,
        ts: u64,
        sig: BytesN<64>,
    ) {
        publisher.require_auth();
        access::require_price_publisher(&env);
        ttl::extend_instance(&env);
        read_config(&env, &asset); // asserts the asset is configured
        require_sane_reading(&env, value, ts);

        if require_nav_signature(&env, &asset) {
            let key = DataKey::IssuerPubKey(asset.clone());
            let issuer_pubkey: BytesN<32> = env
                .storage()
                .persistent()
                .get(&key)
                .expect("price-guard: no issuer public key configured for asset (call configure_issuer_key)");
            ttl::extend_persistent(&env, &key);
            let code_key = DataKey::AssetCode(asset.clone());
            let asset_code: Bytes = env
                .storage()
                .persistent()
                .get(&code_key)
                .expect("price-guard: no asset code configured for asset (call configure_issuer_key)");
            ttl::extend_persistent(&env, &code_key);
            let message = build_nav_message(
                &env,
                &env.current_contract_address(),
                &asset_code,
                ts,
                value,
            );
            // Panics (traps the whole invocation) if `sig` doesn't verify — see
            // `soroban_sdk::crypto::Crypto::ed25519_verify`'s doc comment.
            env.crypto().ed25519_verify(&issuer_pubkey, &message, &sig);
        }

        let nav_key = DataKey::NavRecord(asset.clone());
        env.storage().persistent().set(
            &nav_key,
            &NavRecord { value, ts, sig },
        );
        ttl::extend_persistent(&env, &nav_key);

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
        assert!(
            source != Symbol::new(&env, ISSUER_SOURCE),
            "price-guard: source name 'issuer' is reserved for publish_nav"
        );
        assert!(
            is_source_allowed(&env, &asset, &source),
            "price-guard: source not allowlisted"
        );
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

        let now = env.ledger().timestamp();
        let mut new_last_good = 0i128;
        let pending_key = DataKey::PendingHaltValue(asset.clone());
        if let Some(pending) = env
            .storage()
            .persistent()
            .get::<_, i128>(&pending_key)
        {
            write_last_good(&env, &asset, pending, now);
            new_last_good = pending;
            let ref_key = DataKey::RollingReference(asset.clone());
            env.storage()
                .persistent()
                .set(&ref_key, &pending);
            ttl::extend_persistent(&env, &ref_key);
            let ref_ts_key = DataKey::RollingReferenceUpdated(asset.clone());
            env.storage()
                .persistent()
                .set(
                    &ref_ts_key,
                    &now,
                );
            ttl::extend_persistent(&env, &ref_ts_key);
            env.storage()
                .persistent()
                .remove(&pending_key);
        } else if let Some(last) = read_last_good(&env, &asset) {
            new_last_good = last.value;
        }
        env.storage().persistent().remove(&DataKey::Halted(asset.clone()));

        env.events().publish(
            (Symbol::new(&env, "halt_cleared"), asset.clone()),
            new_last_good,
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::storage::Persistent as _;
    use soroban_sdk::testutils::{Address as _, Ledger};

    /// Default rolling window used by most tests: 24h, with a 1% (100 bp) window band. A publisher
    /// ramping the price a little on every publish trips this eventually; ordinary yield (a few bp
    /// per day) stays well inside it.
    const DEFAULT_WINDOW_SECONDS: u64 = 86_400;
    const DEFAULT_WINDOW_MOVE_BAND_BPS: u32 = 100;

    fn feed(env: &Env) -> Symbol {
        Symbol::new(env, "redston")
    }

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
        client.configure_signature_requirement(&admin, &asset, &false);

        allowlist_test_sources(&env, &client, &admin, &asset);

        (env, client, admin, price_publisher, risk, asset)
    }

    /// Allowlists (#84) every source name the tests publish under, so tests that are not about
    /// the allowlist itself can call `publish_source` freely.
    fn allowlist_test_sources(
        env: &Env,
        client: &PriceGuardClient<'static>,
        admin: &Address,
        asset: &Address,
    ) {
        let mut names = std::vec![
            std::string::String::from("redston"),
            "redstone".into(),
            "redemp".into(),
            "band3".into(),
            "band4".into(),
        ];
        for i in 1..=8 {
            names.push(std::format!("feed_{}", i));
            names.push(std::format!("src{}", i));
        }
        for name in names {
            client.configure_source(admin, asset, &Symbol::new(env, &name), &true);
        }
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

    /// Setup helper for a fresh deployment that does NOT disable the signature requirement,
    /// leaving `require_nav_signature` in its default state (`true`).
    fn setup_fresh_deployment(
        band_bps: u32,
        daily_move_band_bps: u32,
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
            &DEFAULT_WINDOW_SECONDS,
            &DEFAULT_WINDOW_MOVE_BAND_BPS,
            &max_staleness_s,
        );
        allowlist_test_sources(&env, &client, &admin, &asset);

        (env, client, admin, price_publisher, risk, asset)
    }

    #[test]
    #[should_panic(expected = "price-guard: already initialized")]
    fn second_initialize_panics_already_initialized() {
        let (env, client, admin, _publisher, _risk, _asset) =
            setup_fresh_deployment(50, 100, 3600);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        client.initialize(&admin, &pauser, &keeper, &publisher, &risk);
    }

    #[test]
    fn signature_requirement_defaults_to_true_and_disabling_allows_zero_signature() {
        let (env, client, admin, publisher, _risk, asset) =
            setup_fresh_deployment(50, 100, 3600);
        let code = asset_code(&env);
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        // On a fresh deploy, signature requirement must default to true
        assert_eq!(client.require_nav_signature(&asset), true);

        // Register issuer key so the signature check itself triggers rather than missing key panic
        let (pubkey, _) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);

        // Under default require_nav_signature = true, publish_nav with a zero/invalid signature must fail
        let failed_publish = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_nav(&publisher, &asset, &SCALE, &now, &zero_sig);
        }));
        assert!(
            failed_publish.is_err(),
            "publish_nav with zero signature must fail under default signature requirement"
        );

        // Once configure_signature_requirement(false) is called, publish_nav with a zero signature succeeds
        client.configure_signature_requirement(&admin, &asset, &false);
        assert_eq!(client.require_nav_signature(&asset), false);

        client.publish_nav(&publisher, &asset, &SCALE, &now, &zero_sig);
        let feed_name = feed(&env);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, SCALE);
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
        contract: &Address,
        signing_key: &ed25519_dalek::SigningKey,
        code: &Bytes,
        ts: u64,
        value: i128,
    ) -> BytesN<64> {
        use ed25519_dalek::Signer;
        let message = build_nav_message(env, contract, code, ts, value);
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
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &t0, &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &t0, &sig);
        client.publish_source(&publisher, &asset, &redstone, &SCALE, &t0);
        let first = client.guarded_price(&asset);
        assert_eq!(first.status, PriceStatus::Ok);

        // Now both sources agree on a value 2% higher -> within band (50bps band would actually
        // reject this pair too, so widen band check: use a large jump both sources agree on).
        let moved = SCALE + SCALE / 50; // +2%
        client.publish_nav(&publisher, &asset, &moved, &(t0 + 10), &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &client.address, &signing_key, &code, now, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);

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
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let now = env.ledger().timestamp();
        // Signed over a DIFFERENT value than what's actually published -> verification must fail.
        let sig = sign_nav(&env, &client.address, &signing_key, &code, now, SCALE + 1);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        let source = feed(&env);
        let t0 = env.ledger().timestamp();

        client.publish_nav(&old_publisher, &asset, &SCALE, &t0, &zero_sig);
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
                    SCALE,
                    now,
                    zero_sig.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        };
        env.mock_auths(&[nav_auth.clone(), nav_auth]);
        client.publish_nav(&new_publisher, &asset, &SCALE, &now, &zero_sig);
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

    /// #90: the code is bound on-chain, so a reading signed for another asset's code (same issuer
    /// key) does not verify here.
    #[test]
    fn issuer_signature_for_another_asset_code_is_rejected() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &code, &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);
        assert_eq!(client.asset_code(&asset), Some(code.clone()));

        let now = env.ledger().timestamp();
        let other_code = Bytes::from_slice(&env, b"OTHERASSET");
        let sig_other = sign_nav(&env, &client.address, &signing_key, &other_code, now, SCALE);
        assert!(client
            .try_publish_nav(&publisher, &asset, &SCALE, &now, &sig_other)
            .is_err());

        let sig = sign_nav(&env, &client.address, &signing_key, &code, now, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
    }

    /// #90: a signature made for deployment A verifies on A and is rejected by deployment B, even
    /// though B has the same issuer key, asset and code registered.
    #[test]
    fn signature_for_deployment_a_is_rejected_by_deployment_b() {
        let (env, client, admin, publisher, risk, asset) = setup_with_admin(50, 10_000, 3600);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &code, &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let id_b = env.register(PriceGuard, ());
        let client_b = PriceGuardClient::new(&env, &id_b);
        client_b.initialize(
            &admin,
            &Address::generate(&env),
            &Address::generate(&env),
            &publisher,
            &risk,
        );
        client_b.configure_asset(
            &admin,
            &asset,
            &50,
            &10_000,
            &DEFAULT_WINDOW_SECONDS,
            &DEFAULT_WINDOW_MOVE_BAND_BPS,
            &3600,
        );
        client_b.configure_issuer_key(&admin, &asset, &code, &pubkey);
        client_b.configure_signature_requirement(&admin, &asset, &true);

        let now = env.ledger().timestamp();
        let sig_for_a = sign_nav(&env, &client.address, &signing_key, &code, now, SCALE);

        // Valid on A ...
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig_for_a);
        assert_eq!(client.guarded_price(&asset).sources.len(), 1);

        // ... rejected on B, which keeps no reading from it.
        assert!(client_b
            .try_publish_nav(&publisher, &asset, &SCALE, &now, &sig_for_a)
            .is_err());
        assert_eq!(client_b.guarded_price(&asset).sources.len(), 0);

        // B accepts the same reading signed for B.
        let sig_for_b = sign_nav(&env, &id_b, &signing_key, &code, now, SCALE);
        client_b.publish_nav(&publisher, &asset, &SCALE, &now, &sig_for_b);
    }

    /// #90: re-registering the same code (e.g. re-running configure-nav-key.sh) is fine.
    #[test]
    fn configure_issuer_key_with_the_bound_code_again_is_allowed() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let code = asset_code(&env);
        let (pubkey, _) = test_issuer_keypair(&env);
        assert_eq!(client.asset_code(&asset), None);
        client.configure_issuer_key(&admin, &asset, &code, &pubkey);
        client.configure_issuer_key(&admin, &asset, &code, &pubkey);
        assert_eq!(client.asset_code(&asset), Some(code));
    }

    /// #90: rebinding the code would let a signature made for another asset verify at once, with
    /// no timelock, so it is refused.
    #[test]
    #[should_panic(expected = "price-guard: asset code is already bound for asset and cannot be changed")]
    fn configure_issuer_key_refuses_to_rebind_the_asset_code() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let (pubkey, _) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_issuer_key(&admin, &asset, &Bytes::from_slice(&env, b"OTHERASSET"), &pubkey);
    }

    #[test]
    #[should_panic(expected = "price-guard: asset code must not be empty")]
    fn configure_issuer_key_refuses_an_empty_asset_code() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let (pubkey, _) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &Bytes::new(&env), &pubkey);
    }

    #[test]
    #[should_panic]
    fn issuer_signature_for_another_timestamp_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &client.address, &signing_key, &code, now + 1, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
    }

    #[test]
    #[should_panic]
    fn issuer_signature_from_another_key_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, _signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let other_signing_key = ed25519_dalek::SigningKey::from_bytes(&[10u8; 32]);
        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &client.address, &other_signing_key, &code, now, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
    }

    #[test]
    #[should_panic]
    fn random_issuer_signature_bytes_panics() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let admin = Address::generate(&env);
        let code = asset_code(&env);
        let (pubkey, _signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let now = env.ledger().timestamp();
        let random_sig = BytesN::from_array(&env, &[0x5au8; 64]);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &random_sig);
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
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        env.ledger().set_timestamp(1_000);
        let now = env.ledger().timestamp();
        let historical_ts = now - 1;
        let sig = sign_nav(&env, &client.address, &signing_key, &code, historical_ts, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &historical_ts, &sig);
    }

    // --- adversarial cases -------------------------------------------------------------------

    /// The 2026-02-22 shape: one venue's price is pushed far from reality while the issuer's NAV is
    /// unchanged. The guard must refuse to call that a price, however big the push.
    #[test]
    fn a_manipulated_feed_against_an_unmoved_nav_is_never_ok() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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

        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);

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
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);

        let jumped = SCALE * 13 / 10; // +30%
        client.publish_nav(&publisher, &asset, &jumped, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &value, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &value, &now);

        for _ in 0..24 {
            now += 3_600;
            env.ledger().set_timestamp(now);
            value = value * 10_001 / 10_000; // +1 bp per hour
            client.publish_nav(&publisher, &asset, &value, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &value, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        // +0.9% per publish: inside the 1% daily band on every step, +2.7% by the third publish.
        for _ in 0..3 {
            value = value * 1_009 / 1_000;
            client.publish_nav(&publisher, &asset, &value, &now, &sig);
            client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
        }

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Halted, "slow ramp must trip the window band");
        // The second step (+1.8% against the reference) trips it; the value held is the last good
        // one, the first step's, the same as for a daily-band halt.
        assert_eq!(price.value, SCALE * 1_009 / 1_000);
    }

    /// Establishes an `Ok` baseline of 1.0000000 under a 100 bp daily band, then moves both sources
    /// to `moved` and returns what the guard reports. The window band is opened to 100% so only the
    /// daily check can fire. While the NAV has moved but the feed hasn't yet, the pair is >= 100 bp
    /// apart, outside the 50 bp source band, so that in-between publish is `Degraded` and leaves the
    /// baseline alone.
    fn daily_move_to(moved: i128) -> GuardedPrice {
        let (env, client, _admin, publisher, _risk, asset) =
            setup_with_admin_and_window(50, 100, DEFAULT_WINDOW_SECONDS, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

        client.publish_nav(&publisher, &asset, &moved, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &moved, &now);
        client.guarded_price(&asset)
    }

    #[test]
    fn a_daily_move_equal_to_the_band_is_ok() {
        let moved = SCALE + 100_000; // 1.0100000: exactly 100 bp
        let price = daily_move_to(moved);
        assert_eq!((price.status, price.value), (PriceStatus::Ok, moved));
    }

    #[test]
    fn a_daily_move_one_bp_beyond_the_band_halts_at_the_baseline() {
        let price = daily_move_to(SCALE + 101_000); // 1.0101000: 101 bp
        assert_eq!((price.status, price.value), (PriceStatus::Halted, SCALE));
    }

    #[test]
    fn a_downward_daily_move_hits_the_same_boundary() {
        let moved = SCALE - 100_000; // 0.9900000: exactly 100 bp down
        let price = daily_move_to(moved);
        assert_eq!((price.status, price.value), (PriceStatus::Ok, moved));

        let price = daily_move_to(SCALE - 101_000); // 0.9899000: 101 bp down
        assert_eq!((price.status, price.value), (PriceStatus::Halted, SCALE));
    }

    #[test]
    fn a_future_dated_reading_is_rejected_and_never_counts_as_fresh() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        env.ledger().set_timestamp(10_000);
        let now = env.ledger().timestamp();

        // Within clock skew is fine.
        client.publish_nav(&publisher, &asset, &SCALE, &(now + MAX_FUTURE_SKEW_S), &sig);

        // Beyond it is refused outright (a ms-for-s mix-up lands here).
        let far = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &(now * 1_000));
        }));
        assert!(far.is_err(), "a timestamp in the far future must be refused");
    }

    #[test]
    fn is_fresh_staleness_and_future_skew_boundaries() {
        let env = Env::default();
        let now = 10_000u64;
        env.ledger().set_timestamp(now);
        let max_staleness_s = 3600u64;

        let make_source = |observed_at: u64| PriceSource {
            name: Symbol::new(&env, "testsrc"),
            value: SCALE,
            observed_at,
            stale: false,
        };

        // 1. Age exactly max_staleness_s is fresh
        let at_max_staleness = make_source(now - max_staleness_s);
        assert!(
            is_fresh(&env, &at_max_staleness, max_staleness_s),
            "reading at exactly max_staleness_s must be fresh"
        );

        // 2. Age max_staleness_s + 1 is stale
        let past_max_staleness = make_source(now - max_staleness_s - 1);
        assert!(
            !is_fresh(&env, &past_max_staleness, max_staleness_s),
            "reading at max_staleness_s + 1 must be stale"
        );

        // 3. observed_at = now + MAX_FUTURE_SKEW_S (60s) is fresh
        let at_max_future_skew = make_source(now + MAX_FUTURE_SKEW_S);
        assert!(
            is_fresh(&env, &at_max_future_skew, max_staleness_s),
            "reading at now + MAX_FUTURE_SKEW_S must be fresh"
        );

        // 4. observed_at = now + MAX_FUTURE_SKEW_S + 1 (61s) is not fresh
        let beyond_future_skew = make_source(now + MAX_FUTURE_SKEW_S + 1);
        assert!(
            !is_fresh(&env, &beyond_future_skew, max_staleness_s),
            "reading at now + MAX_FUTURE_SKEW_S + 1 must not be fresh"
        );
    }

    #[test]
    fn publish_source_boundary_at_max_future_skew_and_plus_one() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let now = 10_000u64;
        env.ledger().set_timestamp(now);
        let feed_name = feed(&env);

        // 1. now + MAX_FUTURE_SKEW_S is accepted by publish_source
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &(now + MAX_FUTURE_SKEW_S));

        // 2. now + MAX_FUTURE_SKEW_S + 1 (61s ahead) is refused with panic
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_source(
                &publisher,
                &asset,
                &feed_name,
                &SCALE,
                &(now + MAX_FUTURE_SKEW_S + 1),
            );
        }));
        assert!(
            res.is_err(),
            "publish_source at now + MAX_FUTURE_SKEW_S + 1 must be refused"
        );
    }

    #[test]
    fn a_reading_that_ages_into_staleness_stops_counting() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
                client.publish_nav(&publisher, &asset, &bad, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        let jumped = SCALE * 2;
        client.publish_nav(&publisher, &asset, &jumped, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed, &SCALE, &t0);
        let baseline = client.guarded_price(&asset);
        assert_eq!(baseline.status, PriceStatus::Ok);
        assert_eq!(baseline.value, SCALE);

        // Both sources agree on a jump beyond the daily band -> halt latches at publish time.
        let jumped = SCALE * 13 / 10;
        client.publish_nav(&publisher, &asset, &jumped, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed, &jumped, &t0);
        let halted = client.guarded_price(&asset);
        assert_eq!(halted.status, PriceStatus::Halted);
        assert_eq!(halted.value, SCALE);

        // Post-halt publishes: sources agree on calm values (including the old price). The guard
        // must not move LastGood and must stay Halted.
        for value in [SCALE, SCALE + SCALE / 100, SCALE] {
            client.publish_nav(&publisher, &asset, &value, &t0, &sig);
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
        client.publish_nav(&publisher, &asset, &jumped, &t1, &sig);
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
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        let events = env.events().all();
        assert!(has_event(&events, "configure_issuer_key"), "configure_issuer_key event must be emitted");

        // 3. configure_signature_requirement event
        client.configure_signature_requirement(&admin, &asset, &false);
        let events = env.events().all();
        assert!(has_event(&events, "configure_signature_requirement"), "configure_signature_requirement event must be emitted");

        // 3b. configure_source event
        let feed_name = feed(&env);
        client.configure_source(&admin, &asset, &feed_name, &true);
        let events = env.events().all();
        assert!(has_event(&events, "configure_source"), "configure_source event must be emitted");

        // 4. nav_published event
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&price_publisher, &asset, &SCALE, &now, &sig);
        let events = env.events().all();
        assert!(has_event(&events, "nav_published"), "nav_published event must be emitted");

        // 5. source_published event & status_changed event (from Degraded -> Ok)
        client.publish_source(&price_publisher, &asset, &feed(&env), &SCALE, &now);
        let events = env.events().all();
        assert!(has_event(&events, "source_published"), "source_published event must be emitted");
        assert!(has_event(&events, "status_changed"), "status_changed event must be emitted");

        // 6. halt_latched event & status_changed event (from Ok -> Halted)
        let jumped = SCALE * 2;
        client.publish_nav(&price_publisher, &asset, &jumped, &now, &sig);
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
                args: (stranger.clone(), asset.clone(), asset_code(&env), pubkey.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_issuer_key(&stranger, &asset, &asset_code(&env), &pubkey);
        }));
        assert!(result.is_err(), "only the stored admin may configure issuer key");

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
    }

    #[test]
    fn a_stranger_cannot_configure_signature_requirement() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let stranger = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "configure_signature_requirement",
                args: (stranger.clone(), asset.clone(), true).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_signature_requirement(&stranger, &asset, &true);
        }));
        assert!(result.is_err(), "only the stored admin may configure signature requirement");

        // Scoped auths cannot be built for generated contract addresses, so the real admin's
        // success path runs under mock_all_auths like the rest of this module.
        env.mock_all_auths();
        client.configure_signature_requirement(&admin, &asset, &true);
    }

    #[test]
    fn publish_extends_ttl_and_survives_ledger_advancement() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        let feed_name = feed(&env);

        // Initial publish establishes the persistent source entries and instance state.
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
        client.publish_nav(&publisher, &asset, &SCALE, &next_now, &sig);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &next_now);

        let next_price = client.guarded_price(&asset);
        assert_eq!(next_price.status, PriceStatus::Ok);
        assert_eq!(next_price.value, SCALE);
    }

    /// Golden vectors for the canonical NAV message (#90 format). The same messages live in
    /// `services/price-guard/src/__fixtures__/nav-message-vectors.json`, asserted by
    /// `services/price-guard/src/navSignature.test.ts`, and the signatures are listed in
    /// `docs/nav-signing.md` (seed `[9u8; 32]`). If one side changes, all three change together.
    #[test]
    fn build_nav_message_matches_golden_vectors() {
        let env = Env::default();
        let (pubkey, _) = test_issuer_keypair(&env);

        let contract1 = Address::from_str(
            &env,
            "CA66MNFKUT2SJDXOCZFTUNW6OGE5T5IVGUNZL53QR5PSMFWB4VJIZ4CC",
        );
        let msg1 = build_nav_message(
            &env,
            &contract1,
            &Bytes::from_slice(&env, b"SPIKO"),
            1_700_000_000,
            10_234_567,
        );
        assert_eq!(
            msg1,
            Bytes::from_slice(
                &env,
                b"ballast-nav-v1:CA66MNFKUT2SJDXOCZFTUNW6OGE5T5IVGUNZL53QR5PSMFWB4VJIZ4CC:SPIKO:1700000000:10234567"
            )
        );
        let sig1 = BytesN::from_array(
            &env,
            &[
                0xb8, 0x25, 0xb2, 0x8d, 0xbb, 0xc2, 0x33, 0x29, 0x16, 0x12, 0xd6, 0x73, 0xa6,
                0x24, 0x1e, 0x3d, 0x43, 0x7c, 0xf7, 0x06, 0xff, 0x81, 0x70, 0x57, 0x4e, 0xe2,
                0x9f, 0xfb, 0x46, 0x98, 0xc2, 0xe5, 0x22, 0x87, 0x34, 0x85, 0x66, 0xbb, 0xff,
                0x6f, 0x6f, 0x9a, 0xcd, 0x07, 0x18, 0xf9, 0xa4, 0x8b, 0xa2, 0xba, 0xde, 0xf4,
                0x53, 0xec, 0xca, 0xe3, 0x21, 0x6a, 0xd3, 0x50, 0x85, 0x5e, 0xbb, 0x09,
            ],
        );
        env.crypto().ed25519_verify(&pubkey, &msg1, &sig1);

        let contract2 = Address::from_str(
            &env,
            "CD4TZ6XYKNTBLXJP23XSZFMDMDYEG6WNOCCFM3A757YM6IGLXEQBF2RY",
        );
        let msg2 = build_nav_message(
            &env,
            &contract2,
            &Bytes::from_slice(&env, b"CETES28"),
            4_102_444_800,
            i128::MAX,
        );
        assert_eq!(
            msg2,
            Bytes::from_slice(
                &env,
                b"ballast-nav-v1:CD4TZ6XYKNTBLXJP23XSZFMDMDYEG6WNOCCFM3A757YM6IGLXEQBF2RY:CETES28:4102444800:170141183460469231731687303715884105727"
            )
        );
        let sig2 = BytesN::from_array(
            &env,
            &[
                0xbe, 0x29, 0x08, 0x25, 0x52, 0x96, 0xc8, 0xb8, 0x07, 0x47, 0x76, 0x6c, 0xb7,
                0x44, 0xd6, 0x98, 0x61, 0x65, 0x96, 0xa3, 0x4a, 0x83, 0xc0, 0xc4, 0x1d, 0xb2,
                0x50, 0x37, 0xb5, 0x1f, 0xae, 0xd7, 0x26, 0x05, 0xe1, 0x87, 0x9e, 0xc9, 0x4c,
                0x16, 0x71, 0x04, 0x02, 0x7a, 0x1a, 0xf7, 0x48, 0x4f, 0x82, 0x7d, 0xb3, 0xf4,
                0xb0, 0x69, 0xee, 0xad, 0x38, 0x1c, 0xed, 0xeb, 0xc8, 0xc4, 0xbe, 0x0b,
            ],
        );
        env.crypto().ed25519_verify(&pubkey, &msg2, &sig2);
    }

    #[test]
    fn timelock_tightening_asset_config_is_immediate() {
        let (_env, client, admin, _publisher, _risk, asset) = setup_with_admin(100, 200, 3600);
        client.configure_asset(&admin, &asset, &50, &100, &172_800, &50, &1800);
        let cfg = client.asset_config(&asset).expect("asset config must exist");
        assert_eq!(cfg.band_bps, 50);
        assert_eq!(cfg.daily_move_band_bps, 100);
        assert_eq!(cfg.window_seconds, 172_800);
        assert_eq!(cfg.window_move_band_bps, 50);
        assert_eq!(cfg.max_staleness_s, 1800);
    }

    #[test]
    fn timelock_loosening_asset_config_direct_call_panics() {
        let (_env, client, admin, _publisher, _risk, asset) = setup_with_admin(100, 200, 3600);
        let base = client.asset_config(&asset).unwrap();

        // 1. Wider band_bps
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_asset(
                &admin,
                &asset,
                &(base.band_bps + 1),
                &base.daily_move_band_bps,
                &base.window_seconds,
                &base.window_move_band_bps,
                &base.max_staleness_s,
            );
        }));
        assert!(res.is_err(), "widening band_bps directly must fail");

        // 2. Wider daily_move_band_bps
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_asset(
                &admin,
                &asset,
                &base.band_bps,
                &(base.daily_move_band_bps + 1),
                &base.window_seconds,
                &base.window_move_band_bps,
                &base.max_staleness_s,
            );
        }));
        assert!(res.is_err(), "widening daily_move_band_bps directly must fail");

        // 3. Shorter window_seconds
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_asset(
                &admin,
                &asset,
                &base.band_bps,
                &base.daily_move_band_bps,
                &(base.window_seconds - 1),
                &base.window_move_band_bps,
                &base.max_staleness_s,
            );
        }));
        assert!(res.is_err(), "shortening window_seconds directly must fail");

        // 4. Wider window_move_band_bps
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_asset(
                &admin,
                &asset,
                &base.band_bps,
                &base.daily_move_band_bps,
                &base.window_seconds,
                &(base.window_move_band_bps + 1),
                &base.max_staleness_s,
            );
        }));
        assert!(res.is_err(), "widening window_move_band_bps directly must fail");

        // 5. Longer max_staleness_s
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_asset(
                &admin,
                &asset,
                &base.band_bps,
                &base.daily_move_band_bps,
                &base.window_seconds,
                &base.window_move_band_bps,
                &(base.max_staleness_s + 1),
            );
        }));
        assert!(res.is_err(), "increasing max_staleness_s directly must fail");
    }

    #[test]
    fn timelock_loosening_parameters_via_queue_config() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(100, 200, 3600);
        let t0 = env.ledger().timestamp();

        let id1 = client.queue_config(&admin, &ConfigChange::BandBps(asset.clone(), 150));
        assert!(client.pending_config(&id1).is_some());

        let id2 = client.queue_config(&admin, &ConfigChange::DailyMoveBandBps(asset.clone(), 300));
        let id3 = client.queue_config(&admin, &ConfigChange::WindowSeconds(asset.clone(), 1800));
        let id4 = client.queue_config(&admin, &ConfigChange::WindowMoveBandBps(asset.clone(), 250));
        let id5 = client.queue_config(&admin, &ConfigChange::MaxStalenessSeconds(asset.clone(), 7200));
        let id6 = client.queue_config(&admin, &ConfigChange::Asset(asset.clone(), 200, 400, 900, 350, 10_000));

        for id in [id1, id2, id3, id4, id5, id6] {
            let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.execute_config(&id);
            }));
            assert!(early.is_err(), "early execution must fail");
        }

        env.ledger().with_mut(|l| {
            l.timestamp = t0 + ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 35_000;
        });

        client.execute_config(&id1);
        assert_eq!(client.asset_config(&asset).unwrap().band_bps, 150);
        assert!(client.pending_config(&id1).is_none());

        client.execute_config(&id2);
        assert_eq!(client.asset_config(&asset).unwrap().daily_move_band_bps, 300);

        client.execute_config(&id3);
        assert_eq!(client.asset_config(&asset).unwrap().window_seconds, 1800);

        client.execute_config(&id4);
        assert_eq!(client.asset_config(&asset).unwrap().window_move_band_bps, 250);

        client.execute_config(&id5);
        assert_eq!(client.asset_config(&asset).unwrap().max_staleness_s, 7200);

        client.execute_config(&id6);
        let final_cfg = client.asset_config(&asset).unwrap();
        assert_eq!(final_cfg.band_bps, 200);
        assert_eq!(final_cfg.daily_move_band_bps, 400);
        assert_eq!(final_cfg.window_seconds, 900);
        assert_eq!(final_cfg.window_move_band_bps, 350);
        assert_eq!(final_cfg.max_staleness_s, 10_000);
    }

    #[test]
    fn timelock_issuer_key_initial_and_rotation() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(100, 200, 3600);
        let (pubkey1, _) = test_issuer_keypair(&env);
        let pubkey2 = BytesN::from_array(&env, &[7u8; 32]);

        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey1);
        assert_eq!(client.issuer_pubkey(&asset), Some(pubkey1.clone()));

        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey2);
        }));
        assert!(res.is_err(), "direct rotation of issuer key must fail");

        let t0 = env.ledger().timestamp();
        let id = client.queue_config(&admin, &ConfigChange::IssuerPubKey(asset.clone(), pubkey2.clone()));

        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_config(&id);
        }));
        assert!(early.is_err());

        env.ledger().with_mut(|l| {
            l.timestamp = t0 + ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 35_000;
        });

        client.execute_config(&id);
        assert_eq!(client.issuer_pubkey(&asset), Some(pubkey2));
    }

    #[test]
    fn timelock_signature_requirement_tighten_vs_loosen() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(100, 200, 3600);

        client.configure_signature_requirement(&admin, &asset, &true);
        assert_eq!(client.require_nav_signature(&asset), true);

        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.configure_signature_requirement(&admin, &asset, &false);
        }));
        assert!(res.is_err(), "disabling signature requirement directly must fail");

        let t0 = env.ledger().timestamp();
        let id = client.queue_config(&admin, &ConfigChange::RequireNavSignature(asset.clone(), false));

        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_config(&id);
        }));
        assert!(early.is_err());

        env.ledger().with_mut(|l| {
            l.timestamp = t0 + ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 35_000;
        });

        client.execute_config(&id);
        assert_eq!(client.require_nav_signature(&asset), false);
    }

    #[test]
    fn timelock_cancel_config_and_stranger_checks() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(100, 200, 3600);
        let stranger = Address::generate(&env);

        let change = ConfigChange::BandBps(asset.clone(), 150);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "queue_config",
                args: (stranger.clone(), change.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.queue_config(&stranger, &change);
        }));
        assert!(res.is_err(), "stranger cannot queue_config");

        env.mock_all_auths();
        let id = client.queue_config(&admin, &change);
        assert!(client.pending_config(&id).is_some());

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "cancel_config",
                args: (stranger.clone(), id).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.cancel_config(&stranger, &id);
        }));
        assert!(res.is_err(), "stranger cannot cancel_config");

        env.mock_all_auths();
        client.cancel_config(&admin, &id);
        assert!(client.pending_config(&id).is_none());

        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 35_000;
        });
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_config(&id);
        }));
        assert!(res.is_err(), "cancelled config cannot be executed");
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

        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
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
            let last_good = read_last_good(&env, &asset);
            assert_eq!(last_good.map(|lg| lg.value), Some(SCALE));
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

        client.publish_nav(&publisher, &asset, &val1, &now, &sig);
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

        client.publish_nav(&publisher, &asset, &v1, &now, &sig);
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

        client.publish_nav(&publisher, &asset, &v1, &now, &sig);
        let s2 = Symbol::new(&env, "feed_2");
        let s3 = Symbol::new(&env, "feed_3");
        client.publish_source(&publisher, &asset, &s2, &v2, &now);
        client.publish_source(&publisher, &asset, &s3, &v3, &now);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, v2);
    }

    /// Publishes `values` as sources named `src1`, `src2`, ... all stamped with the current ledger
    /// time, so up to the 8-source limit stay fresh for the whole test.
    fn publish_numbered_sources(
        env: &Env,
        client: &PriceGuardClient<'static>,
        publisher: &Address,
        asset: &Address,
        values: &[i128],
    ) {
        const NAMES: [&str; 5] = ["src1", "src2", "src3", "src4", "src5"];
        let now = env.ledger().timestamp();
        for (name, value) in NAMES.iter().zip(values.iter()) {
            client.publish_source(publisher, asset, &Symbol::new(env, name), value, &now);
        }
    }

    #[test]
    fn three_fresh_sources_within_band_return_the_median_not_the_mean_or_extremes() {
        // 50 bps band. 1.000, 1.002 and 1.004 spread by 40 bps, so all three are in band.
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let low = SCALE;
        let mid = SCALE + 20_000; // 1.002
        let high = SCALE + 40_000; // 1.004

        // Published out of order so the result cannot come from insertion order.
        publish_numbered_sources(&env, &client, &publisher, &asset, &[high, low, mid]);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, mid);
        assert_eq!(price.sources.len(), 3);
    }

    #[test]
    fn three_sources_with_an_outlier_beyond_the_band_degrade_and_keep_the_last_good_value() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let last_good = SCALE + 10_000; // 1.010
        let new_median = SCALE + 20_000; // 1.002

        // Establish a last good value that differs from the next round's median, so the value
        // assertion proves the guard kept the old price rather than returning the new median.
        publish_numbered_sources(
            &env,
            &client,
            &publisher,
            &asset,
            &[last_good, last_good, last_good],
        );
        let good = client.guarded_price(&asset);
        assert_eq!(good.status, PriceStatus::Ok);
        assert_eq!(good.value, last_good);

        // The outlier round's median is 1.002, but the extremes (1.000 and 1.060) are 600 bps
        // apart, well past the 50 bps band. A degraded result must keep 1.010, not 1.002.
        publish_numbered_sources(
            &env,
            &client,
            &publisher,
            &asset,
            &[SCALE, new_median, SCALE + 600_000],
        );

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Degraded);
        assert_eq!(price.value, last_good);
        assert_ne!(price.value, new_median);
    }

    #[test]
    fn five_fresh_sources_within_band_return_the_middle_value() {
        // 100 bps band. The five values span 80 bps. The mean is 1.0038 and the mid-range is
        // 1.0040, so neither would be mistaken for the median, 1.0030.
        let (env, client, publisher, _risk, asset) = setup(100, 10_000, 3600);
        let values = [
            SCALE,          // 1.0000
            SCALE + 10_000, // 1.0010
            SCALE + 30_000, // 1.0030 (median)
            SCALE + 70_000, // 1.0070
            SCALE + 80_000, // 1.0080
        ];
        let mean = values.iter().sum::<i128>() / 5;
        assert_ne!(mean, values[2]);

        publish_numbered_sources(&env, &client, &publisher, &asset, &[
            values[3], values[0], values[4], values[2], values[1],
        ]);

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, values[2]);
        assert_eq!(price.sources.len(), 5);
    }

    #[test]
    fn last_good_is_none_until_the_asset_reaches_ok_then_tracks_the_median() {
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        assert_eq!(client.last_good(&asset), None);

        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        // One source is Degraded, which never records a last good value.
        assert_eq!(client.last_good(&asset), None);

        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);
        assert_eq!(client.last_good(&asset), Some(SCALE));
    }

    #[test]
    fn getters_need_no_auth_and_do_not_change_state() {
        use soroban_sdk::testutils::MockAuth;
        let (env, client, publisher, _risk, asset) = setup(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);

        // Drop every mocked authorisation: a getter that required auth would now panic.
        env.mock_auths(&[] as &[MockAuth]);
        assert_eq!(client.last_good(&asset), Some(SCALE));
        assert_eq!(client.last_good(&asset), Some(SCALE));
        assert_eq!(client.halt_info(&asset), None);
        assert_eq!(client.halt_info(&asset), None);
    }

    #[test]
    fn halt_info_shows_baseline_and_tripping_value_then_clears_on_confirm() {
        let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let t0 = env.ledger().timestamp();
        let feed = feed(&env);
        assert_eq!(client.halt_info(&asset), None);

        client.publish_nav(&publisher, &asset, &SCALE, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed, &SCALE, &t0);
        assert_eq!(client.halt_info(&asset), None);

        // Both sources agree on a jump beyond the daily band, which latches the halt.
        let jumped = SCALE * 13 / 10;
        client.publish_nav(&publisher, &asset, &jumped, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed, &jumped, &t0);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);
        assert_eq!(
            client.halt_info(&asset),
            Some(HaltInfo {
                last_good: Some(SCALE),
                pending: Some(jumped),
            })
        );
        assert_eq!(client.last_good(&asset), Some(SCALE));

        // Confirming promotes the tripping value and lifts the latch.
        client.confirm_halt_cleared(&risk, &asset);
        assert_eq!(client.halt_info(&asset), None);
        assert_eq!(client.last_good(&asset), Some(jumped));
    }

    // `within_band` boundaries. The band is inclusive: a spread of exactly `band_bps` is still
    // within band, one bp more is not.

    #[test]
    fn within_band_spread_equal_to_band_is_inside() {
        // (10_050 - 10_000) * 10_000 / 10_000 = 50 bps.
        assert!(within_band(&[10_000, 10_050], 50));
    }

    #[test]
    fn within_band_spread_one_over_band_is_outside() {
        // 51 bps against a 50 bp band.
        assert!(!within_band(&[10_000, 10_051], 50));
    }

    #[test]
    fn within_band_non_positive_minimum_is_outside() {
        assert!(!within_band(&[0, 5], 50));
    }

    #[test]
    fn within_band_single_value_is_inside() {
        assert!(within_band(&[10_000], 50));
    }

    #[test]
    fn within_band_empty_slice_is_inside() {
        assert!(within_band(&[], 50));
    }

    #[test]
    fn within_band_only_extremes_decide() {
        // The middle value never matters; only min and max, wherever they sit in the slice.
        assert!(within_band(&[10_025, 10_050, 10_000], 50));
        assert!(!within_band(&[10_051, 10_025, 10_000], 50));
    }

    // -------------------------------------------------------------------------
    // SortBuf tests: sorting, duplicates, signed numbers, and capacity limits (#113)
    // -------------------------------------------------------------------------

    #[test]
    fn sortbuf_unsorted_three_elements() {
        let env = Env::default();
        let mut v = soroban_sdk::Vec::new(&env);
        v.push_back(3);
        v.push_back(1);
        v.push_back(2);

        let mut buf = alloc_free_sort::SortBuf::from(&v);
        assert_eq!(buf.len(), 3);
        buf.sort();
        assert_eq!(buf.get(0), 1);
        assert_eq!(buf.get(1), 2);
        assert_eq!(buf.get(2), 3);
    }

    #[test]
    fn sortbuf_already_sorted() {
        let env = Env::default();
        let mut v = soroban_sdk::Vec::new(&env);
        v.push_back(1);
        v.push_back(2);
        v.push_back(3);
        v.push_back(4);
        v.push_back(5);

        let mut buf = alloc_free_sort::SortBuf::from(&v);
        buf.sort();
        assert_eq!(buf.len(), 5);
        for i in 0..5 {
            assert_eq!(buf.get(i), (i as i128) + 1);
        }
    }

    #[test]
    fn sortbuf_all_equal_duplicates() {
        let env = Env::default();
        let mut v = soroban_sdk::Vec::new(&env);
        v.push_back(7);
        v.push_back(7);
        v.push_back(7);
        v.push_back(7);

        let mut buf = alloc_free_sort::SortBuf::from(&v);
        buf.sort();
        assert_eq!(buf.len(), 4);
        for i in 0..4 {
            assert_eq!(buf.get(i), 7);
        }
    }

    #[test]
    fn sortbuf_negative_numbers() {
        let env = Env::default();
        let mut v = soroban_sdk::Vec::new(&env);
        v.push_back(-5);
        v.push_back(10);
        v.push_back(-20);
        v.push_back(0);
        v.push_back(3);

        let mut buf = alloc_free_sort::SortBuf::from(&v);
        buf.sort();
        assert_eq!(buf.len(), 5);
        assert_eq!(buf.get(0), -20);
        assert_eq!(buf.get(1), -5);
        assert_eq!(buf.get(2), 0);
        assert_eq!(buf.get(3), 3);
        assert_eq!(buf.get(4), 10);
    }

    #[test]
    fn sortbuf_exactly_eight_values_capacity_limit() {
        let env = Env::default();
        let mut v = soroban_sdk::Vec::new(&env);
        for val in [8, 7, 6, 5, 4, 3, 2, 1] {
            v.push_back(val);
        }

        let mut buf = alloc_free_sort::SortBuf::from(&v);
        assert_eq!(buf.len(), 8);
        buf.sort();
        for i in 0..8 {
            assert_eq!(buf.get(i), (i as i128) + 1);
        }
    }

    #[test]
    #[should_panic(expected = "more than 8 fresh sources")]
    fn sortbuf_nine_values_panics_capacity_exceeded() {
        let env = Env::default();
        let mut v = soroban_sdk::Vec::new(&env);
        for val in 1..=9 {
            v.push_back(val);
        }

        let _buf = alloc_free_sort::SortBuf::from(&v);
    }

    #[test]
    fn admin_can_remove_source_and_free_slot() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        // Publish NAV (slot 1) + 7 feeds (slots 2..8) -> total 8 sources.
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        for i in 1..=7 {
            let name = Symbol::new(&env, &std::format!("feed_{}", i));
            client.publish_source(&publisher, &asset, &name, &SCALE, &now);
        }

        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.sources.len(), 8);

        // Attempting a 9th publish before removal panics because SortBuf capacity is 8.
        let name_9 = Symbol::new(&env, "feed_9");
        client.configure_source(&admin, &asset, &name_9, &true);
        let res_9 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_source(&publisher, &asset, &name_9, &SCALE, &now);
        }));
        assert!(res_9.is_err(), "publishing 9th source must panic before removal");

        // Admin removes feed_7.
        let name_7 = Symbol::new(&env, "feed_7");
        client.remove_source(&admin, &asset, &name_7);

        let price_after_remove = client.guarded_price(&asset);
        assert_eq!(price_after_remove.status, PriceStatus::Ok);
        assert_eq!(price_after_remove.sources.len(), 7);

        // Now feed_9 can be published successfully in the freed slot.
        client.publish_source(&publisher, &asset, &name_9, &SCALE, &now);
        let price_after_9 = client.guarded_price(&asset);
        assert_eq!(price_after_9.status, PriceStatus::Ok);
        assert_eq!(price_after_9.sources.len(), 8);

        // Removing unknown name is a safe no-op.
        let unknown = Symbol::new(&env, "unknown");
        client.remove_source(&admin, &asset, &unknown);
        let price_after_unknown = client.guarded_price(&asset);
        assert_eq!(price_after_unknown.sources.len(), 8);
    }

    #[test]
    fn a_stranger_cannot_remove_source() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 10_000, 3600);
        let stranger = Address::generate(&env);
        let feed_name = feed(&env);
        let now = env.ledger().timestamp();
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &now);

        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "remove_source",
                args: (stranger.clone(), asset.clone(), feed_name.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.remove_source(&stranger, &asset, &feed_name);
        }));
        assert!(result.is_err(), "only the stored admin may remove a source");

        // Real admin succeeds.
        env.mock_all_auths();
        client.remove_source(&admin, &asset, &feed_name);
    }

    // --- publish_nav / publish_source / guarded_price failure modes (issue #116) -------------
    //
    // These use `setup_fresh_deployment`, not `setup`: `setup` turns the signature requirement
    // off, which would hide the missing-issuer-key panic.

    #[test]
    #[should_panic(expected = "price-guard: asset not configured")]
    fn publish_nav_for_an_unconfigured_asset_panics() {
        let (env, client, _admin, publisher, _risk, _asset) =
            setup_fresh_deployment(50, 100, 3_600);
        let never_configured = Address::generate(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &never_configured, &SCALE, &now, &sig);
    }

    #[test]
    #[should_panic(
        expected = "price-guard: no issuer public key configured for asset (call configure_issuer_key)"
    )]
    fn publish_nav_with_signature_required_and_no_issuer_key_panics() {
        let (env, client, _admin, publisher, _risk, asset) =
            setup_fresh_deployment(50, 100, 3_600);
        // Fresh deployment: the requirement defaults to on and `configure_issuer_key` was never
        // called for `asset`.
        assert!(client.require_nav_signature(&asset));
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
    }

    #[test]
    fn publish_nav_with_signature_requirement_off_succeeds_without_an_issuer_key() {
        let (env, client, admin, publisher, _risk, asset) =
            setup_fresh_deployment(50, 100, 3_600);
        client.configure_signature_requirement(&admin, &asset, &false);

        // Same call as the test above (no issuer key, zero signature), now accepted.
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);

        // The NAV was stored as a fresh source: with one more source the price is Ok at SCALE,
        // which it could not be if the NAV had been dropped (one source alone is Degraded).
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Degraded);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &now);
        let price = client.guarded_price(&asset);
        assert_eq!(price.status, PriceStatus::Ok);
        assert_eq!(price.value, SCALE);
    }

    #[test]
    #[should_panic(expected = "price-guard: asset not configured")]
    fn guarded_price_for_an_unconfigured_asset_panics() {
        let (env, client, _admin, _publisher, _risk, _asset) =
            setup_fresh_deployment(50, 100, 3_600);
        client.guarded_price(&Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "price-guard: asset not configured")]
    fn publish_source_for_an_unconfigured_asset_panics() {
        let (env, client, _admin, publisher, _risk, _asset) =
            setup_fresh_deployment(50, 100, 3_600);
        let now = env.ledger().timestamp();
        client.publish_source(&publisher, &Address::generate(&env), &feed(&env), &SCALE, &now);
    }

    // --- decimal_ascii encoders vs std formatting (issue #121) ---------------------------------
    //
    // These bytes go into the signed NAV message, so one wrong digit makes every valid signature
    // fail to verify. `format!` is the oracle.

    #[test]
    fn decimal_ascii_u64_to_bytes_matches_std_formatting() {
        let env = Env::default();
        for n in [0u64, 9, 10, 1_700_000_000, u64::MAX] {
            let expected = format!("{}", n);
            assert_eq!(
                decimal_ascii::u64_to_bytes(&env, n),
                Bytes::from_slice(&env, expected.as_bytes()),
                "u64_to_bytes({n})"
            );
        }
        // u64::MAX is 20 digits: it fills the 20-byte buffer exactly, no truncation.
        assert_eq!(decimal_ascii::u64_to_bytes(&env, u64::MAX).len(), 20);
    }

    #[test]
    fn decimal_ascii_i128_to_bytes_matches_std_formatting() {
        let env = Env::default();
        for n in [0i128, 1, -1, 10_000_000, i128::MAX, i128::MIN] {
            let expected = format!("{}", n);
            assert_eq!(
                decimal_ascii::i128_to_bytes(&env, n),
                Bytes::from_slice(&env, expected.as_bytes()),
                "i128_to_bytes({n})"
            );
        }
        // i128::MAX is 39 digits; i128::MIN is 39 digits plus `-`, exactly the 40-byte buffer.
        assert_eq!(decimal_ascii::i128_to_bytes(&env, i128::MAX).len(), 39);
        assert_eq!(decimal_ascii::i128_to_bytes(&env, i128::MIN).len(), 40);
    }

    #[test]
    fn degraded_and_halted_return_last_good_timestamp_instead_of_now() {
        let (env, client, publisher, risk, asset) = setup(50, 100, 3_600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);

        // No prior good price yet -> Degraded with ts == 0.
        env.ledger().with_mut(|l| l.timestamp = 500);
        let initial = client.guarded_price(&asset);
        assert_eq!(initial.status, PriceStatus::Degraded);
        assert_eq!(initial.value, 0);
        assert_eq!(initial.ts, 0);

        // Publish an Ok price at t = 1000.
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        client.publish_nav(&publisher, &asset, &SCALE, &1_000, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &1_000);
        let ok_price = client.guarded_price(&asset);
        assert_eq!(ok_price.status, PriceStatus::Ok);
        assert_eq!(ok_price.value, SCALE);
        assert_eq!(ok_price.ts, 1_000);

        // Advance ledger to t = 5000 so readings go stale (max_staleness_s = 3600).
        env.ledger().with_mut(|l| l.timestamp = 5_000);
        let degraded = client.guarded_price(&asset);
        assert_eq!(degraded.status, PriceStatus::Degraded);
        assert_eq!(degraded.value, SCALE);
        assert_eq!(degraded.ts, 1_000);

        // Publish a fresh jump at t = 5500 that exceeds daily_move_band_bps (100 bps) -> Halted
        // still reports ts == 1000 (when the held last_good was recorded).
        env.ledger().with_mut(|l| l.timestamp = 5_500);
        let jumped = SCALE + 500_000; // +5%
        client.publish_nav(&publisher, &asset, &jumped, &5_500, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &jumped, &5_500);
        let halted = client.guarded_price(&asset);
        assert_eq!(halted.status, PriceStatus::Halted);
        assert_eq!(halted.value, SCALE);
        assert_eq!(halted.ts, 1_000);

        // Clearing the halt at t = 6000 accepts `jumped` as LastGood at t = 6000; once readings
        // age out at t = 10_000, Degraded reports the t = 6000 timestamp.
        env.ledger().with_mut(|l| l.timestamp = 6_000);
        client.confirm_halt_cleared(&risk, &asset);
        env.ledger().with_mut(|l| l.timestamp = 10_000);
        let degraded_after_clear = client.guarded_price(&asset);
        assert_eq!(degraded_after_clear.status, PriceStatus::Degraded);
        assert_eq!(degraded_after_clear.value, jumped);
        assert_eq!(degraded_after_clear.ts, 6_000);
    }

    #[test]
    fn legacy_bare_i128_last_good_migrates_with_zero_timestamp() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3_600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);

        // Simulate a pre-migration contract instance that stored a bare i128 under DataKey::LastGood.
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::LastGood(asset.clone()), &SCALE);
        });

        env.ledger().with_mut(|l| l.timestamp = 2_500);
        let degraded = client.guarded_price(&asset);
        assert_eq!(degraded.status, PriceStatus::Degraded);
        assert_eq!(degraded.value, SCALE);
        assert_eq!(degraded.ts, 0);

        // Next Ok publish at t = 3000 upgrades storage to LastGood { value, ts: 3000 }.
        env.ledger().with_mut(|l| l.timestamp = 3_000);
        client.publish_nav(&publisher, &asset, &SCALE, &3_000, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &3_000);
        let ok_price = client.guarded_price(&asset);
        assert_eq!(ok_price.status, PriceStatus::Ok);
        assert_eq!(ok_price.ts, 3_000);

        env.ledger().with_mut(|l| l.timestamp = 7_000);
        let degraded_upgraded = client.guarded_price(&asset);
        assert_eq!(degraded_upgraded.status, PriceStatus::Degraded);
        assert_eq!(degraded_upgraded.value, SCALE);
        assert_eq!(degraded_upgraded.ts, 3_000);
    }

    #[test]
    fn nav_signature_requirement_is_per_asset() {
        let env = Env::default();
        env.mock_all_auths();

        let id = env.register(PriceGuard, ());
        let client = PriceGuardClient::new(&env, &id);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        client.initialize(&admin, &pauser, &keeper, &publisher, &risk);

        let asset_a = Address::generate(&env);
        let asset_b = Address::generate(&env);

        client.configure_asset(&admin, &asset_a, &50, &100, &86_400, &100, &3600);
        client.configure_asset(&admin, &asset_b, &50, &100, &86_400, &100, &3600);

        // Asset B registers an issuer key and keeps the default require_nav_signature == true
        let (pubkey_b, signing_key_b) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset_b, &Bytes::from_slice(&env, b"ASSETB"), &pubkey_b);

        // Asset A has signature requirement disabled
        client.configure_signature_requirement(&admin, &asset_a, &false);

        assert_eq!(client.require_nav_signature(&asset_a), false);
        assert_eq!(client.require_nav_signature(&asset_b), true);

        let code_b = Bytes::from_slice(&env, b"ASSETB");
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        // Asset A: unsigned / zero sig allowed!
        client.publish_nav(&publisher, &asset_a, &SCALE, &now, &zero_sig);

        // Asset B: zero sig panics!
        let invalid_b = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.publish_nav(&publisher, &asset_b, &SCALE, &now, &zero_sig);
        }));
        assert!(invalid_b.is_err(), "asset B must require a valid signature");

        // Asset B: valid sig succeeds!
        let valid_sig_b = sign_nav(&env, &client.address, &signing_key_b, &code_b, now, SCALE);
        client.publish_nav(&publisher, &asset_b, &SCALE, &now, &valid_sig_b);
    }

    /// Disabling an unset requirement skips the timelock only while the asset is being brought up.
    /// Once a signed reading has been accepted under the default `true`, switching it off is a
    /// loosening like any other and has to be queued.
    #[test]
    #[should_panic(expected = "price-guard: disabling signature requirement must be queued via queue_config")]
    fn disabling_an_unset_requirement_after_a_reading_was_published_must_be_queued() {
        let (env, client, admin, publisher, _risk, asset) = setup_fresh_deployment(50, 100, 3600);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        let now = env.ledger().timestamp();
        let sig = sign_nav(&env, &client.address, &signing_key, &code, now, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);

        client.configure_signature_requirement(&admin, &asset, &false);
    }

    /// The timelocked path for the case above, scoped to the one asset it names.
    #[test]
    fn queued_signature_loosening_applies_after_the_timelock_and_only_to_its_asset() {
        let (env, client, admin, publisher, _risk, asset_a) = setup_fresh_deployment(50, 100, 3600);
        let asset_b = Address::generate(&env);
        client.configure_asset(&admin, &asset_b, &50, &100, &86_400, &100, &3600);
        client.configure_signature_requirement(&admin, &asset_b, &true);

        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset_a, &asset_code(&env), &pubkey);
        let t0 = env.ledger().timestamp();
        let sig = sign_nav(&env, &client.address, &signing_key, &code, t0, SCALE);
        client.publish_nav(&publisher, &asset_a, &SCALE, &t0, &sig);

        let id = client.queue_config(&admin, &ConfigChange::RequireNavSignature(asset_a.clone(), false));
        assert_eq!(client.require_nav_signature(&asset_a), true);

        env.ledger().with_mut(|l| {
            l.timestamp = t0 + ballast_common::timelock::TIMELOCK_DELAY_SECONDS;
            l.sequence_number += 35_000;
        });
        client.execute_config(&id);

        assert_eq!(client.require_nav_signature(&asset_a), false);
        assert_eq!(client.require_nav_signature(&asset_b), true);

        // A now takes an unsigned reading; turning it back on needs no timelock.
        let now = env.ledger().timestamp();
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        client.publish_nav(&publisher, &asset_a, &SCALE, &now, &zero_sig);
        client.configure_signature_requirement(&admin, &asset_a, &true);
        assert_eq!(client.require_nav_signature(&asset_a), true);
    }

    /// Setting `false` twice is not a loosening, so it needs no timelock.
    #[test]
    fn repeating_a_disabled_requirement_is_allowed() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let code = asset_code(&env);
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        client.publish_nav(&publisher, &asset, &SCALE, &now, &zero_sig);

        client.configure_signature_requirement(&admin, &asset, &false);
        assert_eq!(client.require_nav_signature(&asset), false);
    }

    /// Builds a contract with `n` assets, each taken through every per-asset write path (config,
    /// issuer key, signature flag, signed NAV, a feed, an `Ok` baseline, rolling reference, a
    /// latched halt with its pending value), and returns the instance entry's (key count, XDR
    /// size in bytes).
    fn instance_footprint_with_assets(n: u32) -> (u32, u32) {
        use soroban_sdk::testutils::storage::Instance as _;
        use soroban_sdk::xdr::ToXdr;

        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(PriceGuard, ());
        let client = PriceGuardClient::new(&env, &id);
        let admin = Address::generate(&env);
        let publisher = Address::generate(&env);
        client.initialize(
            &admin,
            &Address::generate(&env),
            &Address::generate(&env),
            &publisher,
            &Address::generate(&env),
        );

        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        let now = env.ledger().timestamp();
        let jumped = SCALE * 13 / 10;
        for _ in 0..n {
            let asset = Address::generate(&env);
            client.configure_asset(&admin, &asset, &50, &100, &86_400, &100, &3600);
            client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
            client.configure_signature_requirement(&admin, &asset, &true);
            client.configure_source(&admin, &asset, &feed(&env), &true);
            for value in [SCALE, jumped] {
                let sig = sign_nav(&env, &client.address, &signing_key, &code, now, value);
                client.publish_nav(&publisher, &asset, &value, &now, &sig);
                client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
            }
            assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);
        }

        env.as_contract(&id, || {
            let all = env.storage().instance().all();
            (all.len(), all.to_xdr(&env).len())
        })
    }

    /// #96: the instance entry every publish and every `guarded_price` loads must not grow with the
    /// number of assets. Under the old layout each asset added a dozen instance keys.
    #[test]
    fn instance_storage_is_independent_of_asset_count_with_20_assets() {
        let one = instance_footprint_with_assets(1);
        let twenty = instance_footprint_with_assets(20);
        assert_eq!(one, twenty);
        // Nothing but the roles.
        assert_eq!(one.0, 1);
    }

    /// TTL of an entry, read from inside the contract.
    fn ttl_of(env: &Env, contract: &Address, key: &DataKey) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(key))
    }

    /// Advances the ledger far enough that every persistent entry falls under the extension
    /// threshold, and checks that it did.
    fn age_past_extension_threshold(env: &Env, contract: &Address, key: &DataKey) {
        env.ledger().with_mut(|l| l.sequence_number += 505_000);
        assert!(ttl_of(env, contract, key) < ballast_common::ttl::PERSISTENT_LIFETIME_THRESHOLD_LEDGERS);
    }

    #[test]
    fn per_asset_keys_are_persistent_and_ttl_extended_on_access() {
        use soroban_sdk::testutils::storage::Instance as _;
        use soroban_sdk::IntoVal;

        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let code = asset_code(&env);
        let (pubkey, signing_key) = test_issuer_keypair(&env);
        client.configure_issuer_key(&admin, &asset, &asset_code(&env), &pubkey);
        client.configure_signature_requirement(&admin, &asset, &true);

        let t0 = env.ledger().timestamp();
        let sig = sign_nav(&env, &client.address, &signing_key, &code, t0, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &t0, &sig);
        client.publish_source(&publisher, &asset, &feed(&env), &SCALE, &t0);

        let issuer = Symbol::new(&env, ISSUER_SOURCE);
        // Every key `guarded_price` reads.
        let read_by_guarded_price = [
            DataKey::Config(asset.clone()),
            DataKey::SourceNames(asset.clone()),
            DataKey::Source(asset.clone(), issuer),
            DataKey::Source(asset.clone(), feed(&env)),
            DataKey::LastGood(asset.clone()),
            DataKey::RollingReference(asset.clone()),
            DataKey::RollingReferenceUpdated(asset.clone()),
            DataKey::LastStatus(asset.clone()),
            DataKey::SourceAllowed(asset.clone(), feed(&env)),
        ];
        // Keys only `publish_nav` touches.
        let read_by_publish_nav = [
            DataKey::IssuerPubKey(asset.clone()),
            DataKey::AssetCode(asset.clone()),
            DataKey::RequireNavSignature(asset.clone()),
            DataKey::NavRecord(asset.clone()),
        ];

        env.as_contract(&client.address, || {
            let instance = env.storage().instance().all();
            for key in read_by_guarded_price.iter().chain(read_by_publish_nav.iter()) {
                assert!(env.storage().persistent().has(key));
                assert!(!instance.contains_key(key.into_val(&env)));
                assert_eq!(
                    env.storage().persistent().get_ttl(key),
                    ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
                );
            }
        });

        // A read alone (what a consumer's draw or liquidation does) extends what it reads.
        age_past_extension_threshold(&env, &client.address, &read_by_guarded_price[0]);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);
        for key in read_by_guarded_price.iter() {
            assert_eq!(
                ttl_of(&env, &client.address, key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
        }

        // The signature-path keys aged with the rest; the next publish extends them.
        for key in read_by_publish_nav.iter() {
            assert!(
                ttl_of(&env, &client.address, key)
                    < ballast_common::ttl::PERSISTENT_LIFETIME_THRESHOLD_LEDGERS
            );
        }
        let sig = sign_nav(&env, &client.address, &signing_key, &code, t0, SCALE);
        client.publish_nav(&publisher, &asset, &SCALE, &t0, &sig);
        for key in read_by_publish_nav.iter() {
            assert_eq!(
                ttl_of(&env, &client.address, key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
        }
    }

    /// While an asset stays halted, reading it keeps both the latch and the value awaiting
    /// `confirm_halt_cleared` alive, so a long halt cannot archive one without the other.
    #[test]
    fn halt_state_ttl_is_extended_while_the_asset_stays_halted() {
        let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();
        let jumped = SCALE * 13 / 10;
        for value in [SCALE, jumped] {
            client.publish_nav(&publisher, &asset, &value, &now, &sig);
            client.publish_source(&publisher, &asset, &feed(&env), &value, &now);
        }

        let halted = DataKey::Halted(asset.clone());
        let pending = DataKey::PendingHaltValue(asset.clone());
        age_past_extension_threshold(&env, &client.address, &pending);
        assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);
        for key in [&halted, &pending] {
            assert_eq!(
                ttl_of(&env, &client.address, key),
                ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS
            );
        }

        client.confirm_halt_cleared(&risk, &asset);
        assert_eq!(client.guarded_price(&asset).value, jumped);
    }

    // --- source allowlist tests (issue #84) ----------------------------------------------------

    #[test]
    #[should_panic(expected = "price-guard: source not allowlisted")]
    fn publish_source_rejects_unlisted_source() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let unlisted = Symbol::new(&env, "unlisted_feed");
        let now = env.ledger().timestamp();
        client.publish_source(&publisher, &asset, &unlisted, &SCALE, &now);
    }

    #[test]
    #[should_panic(expected = "price-guard: source name 'issuer' is reserved for publish_nav")]
    fn publish_source_rejects_reserved_issuer_name() {
        let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
        let issuer_name = Symbol::new(&env, ISSUER_SOURCE);
        let now = env.ledger().timestamp();
        client.publish_source(&publisher, &asset, &issuer_name, &SCALE, &now);
    }

    #[test]
    #[should_panic(expected = "price-guard: source name 'issuer' is reserved for publish_nav")]
    fn configure_source_rejects_reserved_issuer_name() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let issuer_name = Symbol::new(&env, ISSUER_SOURCE);
        client.configure_source(&admin, &asset, &issuer_name, &true);
    }

    #[test]
    fn a_stranger_cannot_configure_source() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let stranger = Address::generate(&env);
        let custom_feed = Symbol::new(&env, "custom_feed");

        let res = client
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "configure_source",
                    args: (&stranger, &asset, &custom_feed, true).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_configure_source(&stranger, &asset, &custom_feed, &true);

        assert!(res.is_err(), "non-admin must not be allowed to configure sources");
    }

    #[test]
    fn disabling_source_stops_it_counting_immediately() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        let feed_a = Symbol::new(&env, "feed_a");
        let feed_b = Symbol::new(&env, "feed_b");
        client.configure_source(&admin, &asset, &feed_a, &true);
        client.configure_source(&admin, &asset, &feed_b, &true);

        assert!(client.is_source_allowed(&asset, &feed_a));
        assert!(client.is_source_allowed(&asset, &feed_b));

        // Publish NAV + feed_a + feed_b -> 3 fresh sources -> Ok
        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed_a, &SCALE, &now);
        client.publish_source(&publisher, &asset, &feed_b, &SCALE, &now);

        let price_3 = client.guarded_price(&asset);
        assert_eq!(price_3.status, PriceStatus::Ok);
        assert_eq!(price_3.sources.len(), 3);

        // Disable feed_a -> stops counting immediately -> 2 sources remaining -> still Ok
        client.configure_source(&admin, &asset, &feed_a, &false);
        assert!(!client.is_source_allowed(&asset, &feed_a));

        let price_2 = client.guarded_price(&asset);
        assert_eq!(price_2.status, PriceStatus::Ok);
        assert_eq!(price_2.sources.len(), 2);

        // Disable feed_b -> only 1 source remaining (NAV) -> Degraded immediately
        client.configure_source(&admin, &asset, &feed_b, &false);
        assert!(!client.is_source_allowed(&asset, &feed_b));

        let price_1 = client.guarded_price(&asset);
        assert_eq!(price_1.status, PriceStatus::Degraded);
        assert_eq!(price_1.sources.len(), 1);
    }

    #[test]
    fn removing_source_stops_it_counting_immediately() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        let now = env.ledger().timestamp();

        let feed_a = Symbol::new(&env, "feed_a");
        client.configure_source(&admin, &asset, &feed_a, &true);

        client.publish_nav(&publisher, &asset, &SCALE, &now, &sig);
        client.publish_source(&publisher, &asset, &feed_a, &SCALE, &now);

        let price_before = client.guarded_price(&asset);
        assert_eq!(price_before.status, PriceStatus::Ok);
        assert_eq!(price_before.sources.len(), 2);

        // Remove feed_a -> stops counting immediately and drops below quorum (<2) -> Degraded
        client.remove_source(&admin, &asset, &feed_a);
        assert!(!client.is_source_allowed(&asset, &feed_a));

        let price_after = client.guarded_price(&asset);
        assert_eq!(price_after.status, PriceStatus::Degraded);
        assert_eq!(price_after.sources.len(), 1);
    }

    // --- per-source staleness windows (issue #86) --------------------------------------------

    /// Moves the ledger past the 48h config timelock.
    fn pass_timelock(env: &Env) {
        env.ledger().with_mut(|l| {
            l.timestamp += ballast_common::timelock::TIMELOCK_DELAY_SECONDS + 1;
            l.sequence_number += 35_000;
        });
    }

    #[test]
    fn per_source_staleness_long_window_nav_and_short_window_feed() {
        // Asset default 3,600s. The daily NAV gets 24h (a widening, so timelocked); the fast feed
        // gets 30m (a tightening, so immediate).
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let issuer_name = Symbol::new(&env, ISSUER_SOURCE);
        let feed_name = feed(&env);

        let id = client.queue_config(
            &admin,
            &ConfigChange::SourceMaxStaleness(asset.clone(), issuer_name.clone(), 86_400),
        );
        pass_timelock(&env);
        client.execute_config(&id);
        client.configure_source_staleness(&admin, &asset, &feed_name, &1_800);
        assert_eq!(client.source_staleness(&asset, &issuer_name), Some(86_400));
        assert_eq!(client.source_staleness(&asset, &feed_name), Some(1_800));

        let base_ts = env.ledger().timestamp();
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        client.publish_nav(&publisher, &asset, &SCALE, &base_ts, &sig);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &base_ts);

        // Age 1,000s: both fresh -> Ok.
        env.ledger().set_timestamp(base_ts + 1_000);
        let p = client.guarded_price(&asset);
        assert_eq!(p.status, PriceStatus::Ok);
        assert_eq!(p.sources.len(), 2);

        // Age 2,500s: the feed (> 1,800s) is stale, the NAV (<= 86,400s) is not -> Degraded.
        env.ledger().set_timestamp(base_ts + 2_500);
        let p = client.guarded_price(&asset);
        assert_eq!(p.status, PriceStatus::Degraded);
        assert_eq!(p.sources.len(), 1);
        assert_eq!(p.sources.get(0).unwrap().name, issuer_name);

        // Age 90,000s: both stale.
        env.ledger().set_timestamp(base_ts + 90_000);
        let p = client.guarded_price(&asset);
        assert_eq!(p.status, PriceStatus::Degraded);
        assert_eq!(p.sources.len(), 0);
    }

    #[test]
    fn per_source_staleness_tightening_applies_at_once_down_to_the_effective_window() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let feed_name = feed(&env);
        assert_eq!(client.source_staleness(&asset, &feed_name), None);

        // Exactly the asset default is not a widening, so it is accepted immediately.
        client.configure_source_staleness(&admin, &asset, &feed_name, &3_600);
        assert_eq!(client.source_staleness(&asset, &feed_name), Some(3_600));
        client.configure_source_staleness(&admin, &asset, &feed_name, &600);
        assert_eq!(client.source_staleness(&asset, &feed_name), Some(600));
    }

    #[test]
    #[should_panic(expected = "price-guard: widening a source staleness window requires queue_config")]
    fn per_source_staleness_widening_past_the_asset_default_is_refused() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        client.configure_source_staleness(&admin, &asset, &feed(&env), &3_601);
    }

    #[test]
    #[should_panic(expected = "price-guard: widening a source staleness window requires queue_config")]
    fn per_source_staleness_widening_a_tightened_override_is_refused() {
        // Once tightened to 600s, going back up to 1,800s (still under the asset default) is a
        // widening relative to what the source has now, so it is timelocked too.
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let feed_name = feed(&env);
        client.configure_source_staleness(&admin, &asset, &feed_name, &600);
        client.configure_source_staleness(&admin, &asset, &feed_name, &1_800);
    }

    #[test]
    #[should_panic(expected = "price-guard: clearing a source staleness window requires queue_config")]
    fn per_source_staleness_direct_clear_is_refused() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let feed_name = feed(&env);
        client.configure_source_staleness(&admin, &asset, &feed_name, &600);
        client.configure_source_staleness(&admin, &asset, &feed_name, &0);
    }

    #[test]
    fn per_source_staleness_queued_widening_and_clear_apply_after_the_timelock() {
        let (env, client, admin, publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let feed_name = feed(&env);

        let widen = client.queue_config(
            &admin,
            &ConfigChange::SourceMaxStaleness(asset.clone(), feed_name.clone(), 7_200),
        );
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.execute_config(&widen);
        }));
        assert!(early.is_err(), "early execution must fail");
        assert_eq!(client.source_staleness(&asset, &feed_name), None);

        pass_timelock(&env);
        client.execute_config(&widen);
        assert_eq!(client.source_staleness(&asset, &feed_name), Some(7_200));

        // At age 4,000s the feed is fresh under its 7,200s window but the NAV (asset default
        // 3,600s) is stale.
        let base_ts = env.ledger().timestamp();
        let code = asset_code(&env);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        client.publish_nav(&publisher, &asset, &SCALE, &base_ts, &sig);
        client.publish_source(&publisher, &asset, &feed_name, &SCALE, &base_ts);
        env.ledger().set_timestamp(base_ts + 4_000);
        let p = client.guarded_price(&asset);
        assert_eq!(p.sources.len(), 1);
        assert_eq!(p.sources.get(0).unwrap().name, feed_name);

        // Clearing the override (0) is queued too, and drops the feed back to 3,600s.
        let clear = client.queue_config(
            &admin,
            &ConfigChange::SourceMaxStaleness(asset.clone(), feed_name.clone(), 0),
        );
        pass_timelock(&env);
        client.execute_config(&clear);
        assert_eq!(client.source_staleness(&asset, &feed_name), None);
    }

    #[test]
    fn a_stranger_cannot_configure_source_staleness() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let (env, client, _admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let stranger = Address::generate(&env);
        let feed_name = feed(&env);
        let res = client
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "configure_source_staleness",
                    args: (&stranger, &asset, &feed_name, 600u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_configure_source_staleness(&stranger, &asset, &feed_name, &600);
        assert!(res.is_err(), "non-admin must not configure source staleness");
    }

    #[test]
    fn remove_source_clears_its_staleness_override() {
        let (env, client, admin, _publisher, _risk, asset) = setup_with_admin(50, 100, 3600);
        let feed_name = feed(&env);
        client.configure_source_staleness(&admin, &asset, &feed_name, &600);
        client.remove_source(&admin, &asset, &feed_name);
        assert_eq!(client.source_staleness(&asset, &feed_name), None);
    }

    mod invariants;
}
