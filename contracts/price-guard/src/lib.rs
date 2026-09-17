#![cfg_attr(not(test), no_std)]

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

use ballast_common::{
    access::{self, Roles},
    price::{GuardedPrice, PriceSource, PriceStatus},
};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, Symbol, Vec};

const ISSUER_SOURCE: &str = "issuer";

#[contracttype]
#[derive(Clone)]
struct AssetGuardConfig {
    band_bps: u32,
    daily_move_band_bps: u32,
    max_staleness_s: u64,
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
    env.storage().persistent().set(
        &DataKey::Source(asset.clone(), name.clone()),
        &PriceSource {
            name: name.clone(),
            value,
            observed_at,
            stale: false,
        },
    );
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
    !source.stale && env.ledger().timestamp().saturating_sub(source.observed_at) <= max_staleness_s
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
            for i in 0..len {
                items[i] = values.get(i as u32).unwrap();
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
    let deviation_bps = ((max - min) as i128 * 10_000) / min as i128;
    deviation_bps <= band_bps as i128
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

    /// Admin-set per-asset thresholds. Kept local to this contract rather than cross-called from
    /// `Registry` — see the module docs on the general Registry-decoupling simplification used
    /// across this pass's contracts.
    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        band_bps: u32,
        daily_move_band_bps: u32,
        max_staleness_s: u64,
    ) {
        admin.require_auth();
        access::require_admin(&env);
        env.storage().instance().set(
            &DataKey::Config(asset),
            &AssetGuardConfig {
                band_bps,
                daily_move_band_bps,
                max_staleness_s,
            },
        );
    }

    /// Admin-only. Registers/rotates the raw Ed25519 public key `asset`'s issuer signs NAV
    /// readings with — see the module doc comment. Required before `publish_nav` can succeed for
    /// `asset` while `require_nav_signature` is `true`.
    pub fn configure_issuer_key(env: Env, admin: Address, asset: Address, issuer_pubkey: BytesN<32>) {
        admin.require_auth();
        access::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::IssuerPubKey(asset), &issuer_pubkey);
    }

    /// Admin-only. Global (not per-asset) toggle for whether `publish_nav` verifies `sig` at all —
    /// see the module doc comment on why this exists and why it defaults to `true`.
    pub fn configure_signature_requirement(env: Env, admin: Address, required: bool) {
        admin.require_auth();
        access::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::RequireNavSignature, &required);
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
        read_config(&env, &asset); // asserts the asset is configured

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

        env.storage()
            .instance()
            .set(&DataKey::NavRecord(asset.clone()), &NavRecord { value, ts, sig });

        let name = Symbol::new(&env, ISSUER_SOURCE);
        track_source_name(&env, &asset, &name);
        write_source(&env, &asset, &name, value, ts);
    }

    /// PRD §6.4's other inputs: the independent SEP-40 feed and the last observed redemption
    /// price (see the module doc comment on why these are pushed rather than cross-called).
    /// `source` is a caller-chosen tag, e.g. `redston` or `redemp`.
    pub fn publish_source(env: Env, publisher: Address, asset: Address, source: Symbol, value: i128, ts: u64) {
        publisher.require_auth();
        access::require_price_publisher(&env);
        read_config(&env, &asset);

        track_source_name(&env, &asset, &source);
        write_source(&env, &asset, &source, value, ts);
    }

    /// The core PRD §6.4 rules, run fresh on every call:
    /// 1. Fewer than 2 fresh sources -> `Degraded`, value = last good.
    /// 2. Fresh sources disagree beyond `band_bps` -> `Degraded`, value = last good.
    /// 3. Otherwise, if the new median moved more than `daily_move_band_bps` against the last
    ///    good value -> `Halted` (sticky, until `confirm_halt_cleared`), value = last good.
    /// 4. Otherwise -> `Ok`, value = the new median, and this becomes the new "last good".
    pub fn guarded_price(env: Env, asset: Address) -> GuardedPrice {
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
            return GuardedPrice {
                asset,
                value: last_good.unwrap_or(0),
                status: PriceStatus::Halted,
                ts: now,
                sources: fresh_sources,
            };
        }

        if fresh_values.len() < 2 {
            return GuardedPrice {
                asset,
                value: last_good.unwrap_or(0),
                status: PriceStatus::Degraded,
                ts: now,
                sources: fresh_sources,
            };
        }

        let mut plain_values: alloc_free_sort::SortBuf = alloc_free_sort::SortBuf::from(&fresh_values);
        plain_values.sort();
        let len = plain_values.len();
        let median_value = plain_values.get(len / 2);

        let mut as_array: [i128; 8] = [0; 8];
        for i in 0..len {
            as_array[i] = plain_values.get(i);
        }
        if !within_band(&as_array[..len], config.band_bps) {
            return GuardedPrice {
                asset,
                value: last_good.unwrap_or(0),
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

        env.storage()
            .instance()
            .set(&DataKey::LastGood(asset.clone()), &median_value);

        GuardedPrice {
            asset,
            value: median_value,
            status: PriceStatus::Ok,
            ts: now,
            sources: fresh_sources,
        }
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

        if let Some(pending) = env
            .storage()
            .instance()
            .get::<_, i128>(&DataKey::PendingHaltValue(asset.clone()))
        {
            env.storage()
                .instance()
                .set(&DataKey::LastGood(asset.clone()), &pending);
            env.storage()
                .instance()
                .remove(&DataKey::PendingHaltValue(asset.clone()));
        }
        env.storage().instance().remove(&DataKey::Halted(asset));
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup(band_bps: u32, daily_move_band_bps: u32, max_staleness_s: u64) -> (Env, PriceGuardClient<'static>, Address, Address, Address) {
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
        client.configure_asset(&admin, &asset, &band_bps, &daily_move_band_bps, &max_staleness_s);

        // These tests exercise the median/band/staleness/halt logic, not signature verification
        // (which has its own dedicated tests below) — turn the check off so a zero-filled `sig`
        // doesn't panic every call here.
        client.configure_signature_requirement(&admin, &false);

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

    fn sign_nav(env: &Env, signing_key: &ed25519_dalek::SigningKey, code: &Bytes, ts: u64, value: i128) -> BytesN<64> {
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
        client.publish_nav(&publisher, &asset, &code, &SCALE, &env.ledger().timestamp(), &sig);

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
}
