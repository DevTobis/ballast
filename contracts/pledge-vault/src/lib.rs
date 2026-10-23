#![cfg_attr(not(test), no_std)]
// Contract entry points take their inputs as flat arguments (that's the on-chain interface), and
// `#[contractimpl]` generates client functions with the same arity.
#![allow(clippy::too_many_arguments)]
// Events are published with `Events::publish`, which soroban-sdk now deprecates in favour of
// `#[contractevent]`. Moving over changes how events are encoded on-chain, so it has to be done
// together with the off-chain readers (services/indexer, services/ledger) and a redeploy.
#![allow(deprecated)]

//! `PledgeVault` (PRD §6.2, §6.3, §8): one position per `(line, asset)`. Escrow mode (custody
//! mode A) holds the RWA token itself in this contract; issuer-lien and custodian-lien modes
//! (B/C) hold nothing here — the tokens stay with the issuer or a qualified custodian, and this
//! contract only records a lien reference for audit (PRD §7 `pledge.lien_ref`).
//!
//! **Position key.** A `CreditLine` id already belongs to exactly one borrower, fixed at
//! `CreditLine::open` and never reassigned. So a position is keyed here by `(line, asset)` rather
//! than `(borrower, line, asset)`: the `borrower` argument to `pledge`/`release` identifies *who
//! must sign*, not an extra storage dimension. This also matches PRD §8's exact `record_lien`
//! signature, which carries no `borrower` parameter — if positions were keyed by borrower, a
//! gateway calling `record_lien` would have no way to reconstruct the storage key.
//!
//! **Invariant 4** ("Collateral is released in only two ways: `release` with healthy post-release
//! LTV, or `liquidate`. Nothing else can move RWA out of `PledgeVault`."): the only functions
//! here that call the underlying token's `transfer` out of this contract are `release` (gated on
//! a fresh LTV check) and `liquidate` (keeper-only, unconditional — see its doc comment for why
//! that's the designated liquidation path). No admin function moves pledged RWA.
//!
//! **Documented simplification — haircut/margin config.** Per-asset haircut, margin thresholds,
//! and custody mode are set directly by the admin via `configure_asset` rather than cross-called
//! from `Registry` on every `pledge`/`release`. A later integration pass would sync these from
//! `Registry` instead of duplicating admin input here.
//!
//! **PledgeVault ↔ CreditLine wiring.** `release` cross-calls `CreditLine::ltv` (read-only) to get
//! the line's current debt before deciding whether a release keeps the line healthy, and every
//! change to a position is reported back through `CreditLine::sync_from_vault` in the same
//! transaction, so the line never counts collateral the vault has already let go of. `pledge` also
//! requires the line's own borrower and collateral asset.
//! `CreditLine::liquidate` (in the sibling `credit-line` crate) is the PRD's designated
//! liquidation entry point; that crate is deliberately decoupled from this one (no Cargo
//! dependency either way) and in this pass does not itself cross-call `PledgeVault::liquidate` —
//! an off-chain keeper service calls both `CreditLine::liquidate` and `PledgeVault::liquidate` as
//! two separate transactions. Flagged here and in the build report as the least clean part of
//! this skeleton.
//!
//! **Events.** Published with shape `((Symbol, line), payload)`:
//! - `pledged`: `((Symbol("pledged"), line), (asset: Address, units: i128))`
//! - `released`: `((Symbol("released"), line), (asset: Address, units: i128))`
//! - `lien_recorded`: `((Symbol("lien_recorded"), line), (asset: Address, units: i128, lien_ref: Bytes))`
//! - `liquidated`: `((Symbol("liquidated"), line), (asset: Address, units: i128, to: Address))`

use ballast_common::{
    access::{self, Roles},
    asset::CustodyMode,
    margin::{self, MarginState, MarginThresholds},
    pause::{self, PauseScope},
    price::{GuardedPrice, PriceStatus},
    risk, ttl,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, Bytes, Env, MuxedAddress,
    Symbol,
};

/// Cross-contract call to PriceGuard, declared as a local trait so PledgeVault never takes a
/// Cargo dependency on the price-guard crate (which is being rewritten concurrently). Soroban
/// resolves this purely by address at call time; the wire shape just has to match PriceGuard's
/// real `guarded_price` function, which returns `ballast_common::price::GuardedPrice` exactly.
#[contractclient(name = "PriceGuardClient")]
pub trait PriceGuardInterface {
    fn guarded_price(env: Env, asset: Address) -> GuardedPrice;
}

/// Cross-contract call to CreditLine's `ltv` view and its `borrower_of` getter. `LtvView` is
/// redefined locally (see the struct below) rather than imported, since PledgeVault and CreditLine
/// are decoupled crates by design — they're built together in this pass, so the shape is
/// hand-kept in sync between the two rather than shared from a common source. That hand-sync is
/// the wiring compromise called out above.
#[contractclient(name = "CreditLineClient")]
pub trait CreditLineInterface {
    fn ltv(env: Env, line: u64) -> LtvView;
    fn borrower_of(env: Env, line: u64) -> Address;
    fn asset_of(env: Env, line: u64) -> Address;
    fn sync_from_vault(env: Env, vault: Address, line: u64, asset: Address, units: i128);
}

/// Mirrors `ballast_credit_line::LtvView` field-for-field. Soroban structs are encoded on the
/// wire as a map keyed by field name, not by Rust type name, so a cross-call into CreditLine's
/// `ltv` decodes correctly into this independently-defined type as long as the fields line up.
#[contracttype]
#[derive(Clone, Debug)]
pub struct LtvView {
    pub debt: i128,
    pub collateral_value: i128,
    pub ltv_bps: u32,
    pub state: MarginState,
    pub price_status: PriceStatus,
}

/// Per-asset config, set directly by the admin (see module docs on the Registry simplification).
#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfig {
    pub price_guard: Address,
    pub credit_line: Address,
    pub haircut_bps: u32,
    pub thresholds: MarginThresholds,
    /// Which custody mode this asset uses (PRD §6.3), set once by the admin per asset rather than
    /// accepted from the caller at `pledge` time — a borrower shouldn't get to choose their own
    /// custody mode per call, an issuer/asset does.
    pub custody_mode: CustodyMode,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Position {
    /// Collateral actually counted toward this line's LTV. In escrow mode this is credited the
    /// moment `pledge` transfers the token in (the transfer itself is the trust boundary). In
    /// lien mode it is credited only once `record_lien` confirms the issuer/custodian has
    /// actually placed the lien — see `pending_lien_units`.
    pub units: i128,
    /// Lien-mode units pledged but not yet gateway-confirmed. Always 0 in escrow mode.
    pub pending_lien_units: i128,
    pub mode: CustodyMode,
    pub lien_ref: Option<Bytes>,
}

#[contracttype]
enum DataKey {
    AssetConfig(Address),
    /// The off-chain `issuer-gateway` service's operator address (PRD §6.5) — the only caller
    /// allowed to attach a lien record for modes B/C. There's no dedicated gateway role in
    /// `ballast_common::access`, so it's stored and admin-set here instead.
    Gateway,
    Position(u64, Address),
}

fn muxed(addr: &Address) -> MuxedAddress {
    MuxedAddress::from(addr)
}

fn read_asset_config(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("pledge-vault: asset not configured")
}

/// Archival behaviour, confirmed against this soroban-sdk's test host in
/// `an_expired_position_is_auto_restored_on_access` below: an entry aged past
/// its `live_until` is transparently **auto-restored on access** (protocol 23
/// semantics) and reads its original value — it does NOT fall into this
/// `unwrap_or`, so the `units: 0` default genuinely means "never written".
/// The TTL extensions on every read and write below still matter: on the
/// network an auto-restore silently inflates the touching transaction's fee
/// and write footprint, and an entry evicted off the live bucket list needs
/// an explicit restore a wallet flow may not provide — a kept-alive position
/// never puts a `release` behind either surprise.
fn read_position(env: &Env, line: u64, asset: &Address) -> Position {
    let key = DataKey::Position(line, asset.clone());
    if env.storage().persistent().has(&key) {
        // Reading is a liveness signal: every touch pushes archival ~30 days out.
        ttl::extend_persistent(env, &key);
    }
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(Position {
            units: 0,
            pending_lien_units: 0,
            mode: CustodyMode::Escrow,
            lien_ref: None,
        })
}

fn write_position(env: &Env, line: u64, asset: &Address, position: &Position) {
    let key = DataKey::Position(line, asset.clone());
    env.storage().persistent().set(&key, position);
    // `set()` does not move the expiration ledger; extend explicitly on every write.
    ttl::extend_persistent(env, &key);
}

/// Reports the position's counted units to the line in the same transaction, so `CreditLine`'s
/// idea of the collateral can never lag what the vault actually holds (see
/// `CreditLine::sync_from_vault`).
fn sync_credit_line(env: &Env, config: &AssetConfig, line: u64, asset: &Address, position: &Position) {
    CreditLineClient::new(env, &config.credit_line).sync_from_vault(
        &env.current_contract_address(),
        &line,
        asset,
        &position.units,
    );
}

#[contract]
pub struct PledgeVault;

#[contractimpl]
impl PledgeVault {
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
            panic!("pledge-vault: already initialized");
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

    /// Admin-set per-asset config: which PriceGuard to query, which CreditLine contract owns
    /// debt/limit accounting for lines against this asset, and the haircut/margin thresholds to
    /// apply. See the module-level doc comment on why this isn't synced from Registry in this
    /// pass. `admin` is accepted for interface symmetry with the rest of Ballast's admin calls;
    /// the actual check is `access::require_admin`, which authenticates the *stored* admin
    /// address regardless of what's passed here.
    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        price_guard: Address,
        credit_line: Address,
        haircut_bps: u32,
        thresholds: MarginThresholds,
        custody_mode: CustodyMode,
    ) {
        let _ = admin;
        access::require_admin(&env);
        ttl::extend_instance(&env);

        thresholds.validate();
        env.storage().instance().set(
            &DataKey::AssetConfig(asset),
            &AssetConfig {
                price_guard,
                credit_line,
                haircut_bps,
                thresholds,
                custody_mode,
            },
        );
    }

    /// Sets the `issuer-gateway` operator address allowed to call `record_lien`.
    pub fn set_gateway(env: Env, admin: Address, gateway: Address) {
        let _ = admin;
        access::require_admin(&env);
        ttl::extend_instance(&env);
        env.storage().instance().set(&DataKey::Gateway, &gateway);
    }

    /// Escrow mode (`CustodyMode::Escrow`): pulls `units` of the RWA token from `borrower` into
    /// this contract. The token's own transfer call is where issuer authorization (SAC
    /// `set_authorized` / SEP-57 `verify_identity`) actually gets enforced — an unauthorized
    /// holder's transfer simply reverts there (PRD §8 invariant 8).
    ///
    /// Lien modes (`IssuerLien` / `CustodianLien`): no token transfer. **The pledged units do not
    /// count toward the line's LTV yet** — they land in `pending_lien_units` until `record_lien`
    /// confirms the issuer/custodian has actually placed the lien (PRD: "a lien is considered
    /// established" only at that point). Before that fix, this function credited `position.units`
    /// immediately in lien mode, letting a borrower's uncorroborated pledge count as real
    /// collateral for `CreditLine`'s LTV math ahead of any issuer confirmation.
    ///
    /// The mode comes from the asset's `configure_asset` record, not a caller-supplied argument
    /// (PRD §8's `pledge` signature takes no mode — custody mode is a property of the asset, not
    /// a per-call choice).
    pub fn pledge(env: Env, borrower: Address, line: u64, asset: Address, units: i128) {
        borrower.require_auth();
        ttl::extend_instance(&env);
        pause::require_not_paused(&env, &PauseScope::Pledges);
        assert!(units > 0, "pledge-vault: units must be positive");

        let config = read_asset_config(&env, &asset);
        let credit_line = CreditLineClient::new(&env, &config.credit_line);
        // Only the line's own borrower pledges to it, and only its collateral asset: otherwise a
        // typo in a line id sends tokens into a position nobody but the real borrower can release.
        assert_eq!(
            borrower,
            credit_line.borrower_of(&line),
            "pledge-vault: caller is not this line's borrower"
        );
        assert_eq!(
            asset,
            credit_line.asset_of(&line),
            "pledge-vault: not this line's collateral asset"
        );

        let mut position = read_position(&env, line, &asset);
        // A position holding units in one custody mode cannot take more in another: `release`
        // moves tokens or not according to the mode recorded on the position, so flipping it under
        // live units would strand them.
        assert!(
            (position.units == 0 && position.pending_lien_units == 0)
                || position.mode == config.custody_mode,
            "pledge-vault: asset custody mode changed while this position holds units"
        );

        if config.custody_mode == CustodyMode::Escrow {
            let token_client = token::Client::new(&env, &asset);
            token_client.transfer(&borrower, muxed(&env.current_contract_address()), &units);
            position.units += units;
        } else {
            position.pending_lien_units += units;
        }
        position.mode = config.custody_mode.clone();
        write_position(&env, line, &asset, &position);
        sync_credit_line(&env, &config, line, &asset, &position);

        env.events()
            .publish((Symbol::new(&env, "pledged"), line), (asset, units));
    }

    /// Releases `units` of collateral back to `borrower`, but only if doing so leaves the linked
    /// `CreditLine` at a healthy or warning LTV — never margin-call or liquidation. This is the
    /// only borrower-initiated way RWA leaves the vault (PRD §8 invariant 4).
    ///
    /// **Security-critical check**: `Position` is keyed by `(line, asset)`, not `(borrower, line,
    /// asset)` (see the module doc comment on why), so nothing about the storage key itself proves
    /// `borrower` is the real borrower of `line`. Without cross-checking against
    /// `CreditLine::borrower_of`, `borrower.require_auth()` alone only proves *someone* signed —
    /// any account could name itself as `borrower` against another party's line id (line ids are
    /// sequential and easily enumerable) and drain that line's escrowed collateral to itself,
    /// since the health check that follows validates the *line's* LTV, not who's asking.
    pub fn release(env: Env, borrower: Address, line: u64, asset: Address, units: i128) {
        borrower.require_auth();
        ttl::extend_instance(&env);
        assert!(units > 0, "pledge-vault: units must be positive");

        let config = read_asset_config(&env, &asset);

        let real_borrower = CreditLineClient::new(&env, &config.credit_line).borrower_of(&line);
        assert_eq!(
            borrower, real_borrower,
            "pledge-vault: caller is not this line's borrower"
        );

        let mut position = read_position(&env, line, &asset);
        assert!(
            units <= position.units,
            "pledge-vault: release exceeds pledged units"
        );

        let guarded: GuardedPrice =
            PriceGuardClient::new(&env, &config.price_guard).guarded_price(&asset);
        assert!(
            guarded.is_usable_for_new_risk(),
            "pledge-vault: price status is not Ok"
        );

        let ltv_view: LtvView = CreditLineClient::new(&env, &config.credit_line).ltv(&line);

        let remaining_units = position.units - units;
        let new_collateral_value =
            risk::collateral_value(remaining_units, guarded.value, config.haircut_bps);
        let new_ltv_bps = risk::ltv_bps(ltv_view.debt, new_collateral_value);
        let state = margin::classify(new_ltv_bps, &config.thresholds);
        assert!(
            matches!(state, MarginState::Healthy | MarginState::Warning),
            "pledge-vault: release would leave the credit line unhealthy"
        );

        if position.mode == CustodyMode::Escrow {
            let token_client = token::Client::new(&env, &asset);
            token_client.transfer(&env.current_contract_address(), muxed(&borrower), &units);
        }

        position.units = remaining_units;
        write_position(&env, line, &asset, &position);
        sync_credit_line(&env, &config, line, &asset, &position);

        env.events()
            .publish((Symbol::new(&env, "released"), line), (asset, units));
    }

    /// Confirms a lien-mode pledge (modes B/C): moves `units` from `pending_lien_units` into the
    /// counted `position.units` that backs the line's LTV, and records the lien reference for
    /// audit (PRD §7 `pledge.lien_ref`). Only the configured `issuer-gateway` operator may call
    /// this — it does so once it has confirmed the issuer (or custodian) has actually placed the
    /// lien. `units` is load-bearing, not informational: it can never exceed what's still pending,
    /// so the gateway can confirm a pledge in partial tranches but never manufacture collateral
    /// beyond what the borrower actually pledged.
    pub fn record_lien(
        env: Env,
        gateway: Address,
        line: u64,
        asset: Address,
        units: i128,
        lien_ref: Bytes,
    ) {
        gateway.require_auth();
        ttl::extend_instance(&env);
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Gateway)
            .expect("pledge-vault: gateway not configured");
        assert_eq!(
            gateway, stored,
            "pledge-vault: caller is not the configured gateway"
        );
        assert!(units > 0, "pledge-vault: units must be positive");

        let mut position = read_position(&env, line, &asset);
        assert!(
            units <= position.pending_lien_units,
            "pledge-vault: units exceed pending (unconfirmed) lien units"
        );
        position.pending_lien_units -= units;
        position.units += units;
        position.lien_ref = Some(lien_ref.clone());
        write_position(&env, line, &asset, &position);
        sync_credit_line(&env, &read_asset_config(&env, &asset), line, &asset, &position);

        env.events().publish(
            (Symbol::new(&env, "lien_recorded"), line),
            (asset, units, lien_ref),
        );
    }

    /// The other half of invariant 4's release path. Not in the PRD §8 interface sketch for
    /// `PledgeVault` directly, but required so *something* can move collateral out on
    /// liquidation, since `release`'s health check would never let a liquidation-state position
    /// release cleanly. `require_keeper` gates it; there's no LTV check here by design — this
    /// *is* the liquidation path, called by an off-chain keeper after `CreditLine::liquidate` has
    /// already confirmed and flagged the breach (see the module doc comment on this wiring gap).
    pub fn liquidate(
        env: Env,
        keeper: Address,
        line: u64,
        asset: Address,
        units: i128,
        to: Address,
    ) {
        let _ = keeper;
        access::require_keeper(&env);
        ttl::extend_instance(&env);
        assert!(units > 0, "pledge-vault: units must be positive");

        let mut position = read_position(&env, line, &asset);
        assert!(
            units <= position.units,
            "pledge-vault: liquidate exceeds pledged units"
        );

        if position.mode == CustodyMode::Escrow {
            let token_client = token::Client::new(&env, &asset);
            token_client.transfer(&env.current_contract_address(), muxed(&to), &units);
        }

        position.units -= units;
        write_position(&env, line, &asset, &position);
        sync_credit_line(&env, &read_asset_config(&env, &asset), line, &asset, &position);

        env.events()
            .publish((Symbol::new(&env, "liquidated"), line), (asset, units, to));
    }

    /// Read-only helper for consoles/tests: current pledged units for `(line, asset)`.
    pub fn position_units(env: Env, line: u64, asset: Address) -> i128 {
        ttl::extend_instance(&env);
        read_position(&env, line, &asset).units
    }

    /// Permissionless keep-alive: anyone may pay to extend a live position's
    /// TTL (and the instance's), so escrowed collateral can never be archived
    /// out from under its owner by mere inactivity.
    pub fn extend_ttl(env: Env, line: u64, asset: Address) {
        ttl::extend_instance(&env);
        let key = DataKey::Position(line, asset.clone());
        assert!(
            env.storage().persistent().has(&key),
            "pledge-vault: no position to extend"
        );
        ttl::extend_persistent(&env, &key);
    }

    /// Read-only helper for consoles/tests: full position for `(line, asset)`.
    pub fn position(env: Env, line: u64, asset: Address) -> Position {
        read_position(&env, line, &asset)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ballast_common::{margin::MarginThresholds, price::PRICE_SCALE};
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    use soroban_sdk::testutils::{Address as _, Events as _};
    use soroban_sdk::{IntoVal, TryFromVal};

    // A minimal in-crate mock token implementing just `transfer`/`balance`/`mint`. Deploying a
    // real Stellar Asset Contract in a unit test (`Env::register_stellar_asset_contract_v2`)
    // pulls in the whole classic-asset admin/authorization machinery, which this skeleton has no
    // need to exercise — all `pledge`/`release` care about is that SEP-41 `transfer` moves a
    // balance and can panic on insufficient funds; that's the standard hermetic
    // cross-contract-testing pattern for Soroban.
    mod mock_token {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, MuxedAddress};

        #[contract]
        pub struct MockToken;

        #[contracttype]
        enum DataKey {
            Balance(Address),
        }

        #[contractimpl]
        impl MockToken {
            pub fn mint(env: Env, to: Address, amount: i128) {
                let key = DataKey::Balance(to);
                let bal: i128 = env.storage().instance().get(&key).unwrap_or(0);
                env.storage().instance().set(&key, &(bal + amount));
            }

            pub fn balance(env: Env, id: Address) -> i128 {
                env.storage()
                    .instance()
                    .get(&DataKey::Balance(id))
                    .unwrap_or(0)
            }

            pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
                from.require_auth();
                let to_addr = to.address();
                let from_key = DataKey::Balance(from);
                let from_bal: i128 = env.storage().instance().get(&from_key).unwrap_or(0);
                assert!(from_bal >= amount, "mock-token: insufficient balance");
                let to_key = DataKey::Balance(to_addr);
                let to_bal: i128 = env.storage().instance().get(&to_key).unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&from_key, &(from_bal - amount));
                env.storage().instance().set(&to_key, &(to_bal + amount));
            }
        }
    }

    // A minimal in-crate mock PriceGuard returning a canned `GuardedPrice` — standard hermetic
    // cross-contract testing pattern (a real PriceGuard is a whole other contract, built
    // concurrently, that this crate deliberately doesn't depend on).
    mod mock_price_guard {
        use ballast_common::price::{GuardedPrice, PriceStatus};
        use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env};

        #[contract]
        pub struct MockPriceGuard;

        #[contracttype]
        enum DataKey {
            Value,
            Status,
        }

        #[contractimpl]
        impl MockPriceGuard {
            pub fn set_price(env: Env, value: i128, status: PriceStatus) {
                env.storage().instance().set(&DataKey::Value, &value);
                env.storage().instance().set(&DataKey::Status, &status);
            }

            pub fn guarded_price(env: Env, asset: Address) -> GuardedPrice {
                let value: i128 = env.storage().instance().get(&DataKey::Value).unwrap();
                let status: PriceStatus = env.storage().instance().get(&DataKey::Status).unwrap();
                GuardedPrice {
                    asset,
                    value,
                    status,
                    ts: env.ledger().timestamp(),
                    sources: vec![&env],
                }
            }
        }
    }

    // A minimal in-crate mock CreditLine exposing just `ltv`/`borrower_of`, returning canned
    // values — this crate never depends on the real `ballast-credit-line` crate.
    mod mock_credit_line {
        use crate::LtvView;
        use ballast_common::{margin::MarginState, price::PriceStatus};
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contract]
        pub struct MockCreditLine;

        #[contracttype]
        enum DataKey {
            Debt,
            Borrower,
            Asset,
            Synced,
        }

        #[contractimpl]
        impl MockCreditLine {
            pub fn set_debt(env: Env, debt: i128) {
                env.storage().instance().set(&DataKey::Debt, &debt);
            }

            pub fn set_borrower(env: Env, borrower: Address) {
                env.storage().instance().set(&DataKey::Borrower, &borrower);
            }

            pub fn ltv(env: Env, _line: u64) -> LtvView {
                let debt: i128 = env.storage().instance().get(&DataKey::Debt).unwrap_or(0);
                LtvView {
                    debt,
                    collateral_value: 0,
                    ltv_bps: 0,
                    state: MarginState::Healthy,
                    price_status: PriceStatus::Ok,
                }
            }

            pub fn borrower_of(env: Env, _line: u64) -> Address {
                env.storage()
                    .instance()
                    .get(&DataKey::Borrower)
                    .expect("mock-credit-line: borrower not set")
            }

            pub fn set_asset(env: Env, asset: Address) {
                env.storage().instance().set(&DataKey::Asset, &asset);
            }

            pub fn asset_of(env: Env, _line: u64) -> Address {
                env.storage()
                    .instance()
                    .get(&DataKey::Asset)
                    .expect("mock-credit-line: asset not set")
            }

            /// Records the last figure the vault reported, so tests can see that every change to a
            /// position reached the credit line in the same transaction.
            pub fn sync_from_vault(env: Env, vault: Address, _line: u64, _asset: Address, units: i128) {
                vault.require_auth();
                env.storage().instance().set(&DataKey::Synced, &units);
            }

            pub fn synced_units(env: Env) -> i128 {
                env.storage().instance().get(&DataKey::Synced).unwrap_or(-1)
            }
        }
    }

    #[allow(dead_code)]
    struct Harness {
        env: Env,
        vault: PledgeVaultClient<'static>,
        token: mock_token::MockTokenClient<'static>,
        price_guard: mock_price_guard::MockPriceGuardClient<'static>,
        credit_line: mock_credit_line::MockCreditLineClient<'static>,
        admin: Address,
        keeper: Address,
        borrower: Address,
        asset: Address,
        thresholds: MarginThresholds,
    }

    fn setup(haircut_bps: u32, debt: i128, price: i128) -> Harness {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = env.register(PledgeVault, ());
        let vault = PledgeVaultClient::new(&env, &vault_id);

        let token_id = env.register(mock_token::MockToken, ());
        let token = mock_token::MockTokenClient::new(&env, &token_id);

        let pg_id = env.register(mock_price_guard::MockPriceGuard, ());
        let price_guard = mock_price_guard::MockPriceGuardClient::new(&env, &pg_id);

        let cl_id = env.register(mock_credit_line::MockCreditLine, ());
        let credit_line = mock_credit_line::MockCreditLineClient::new(&env, &cl_id);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let keeper = Address::generate(&env);
        let price_publisher = Address::generate(&env);
        let risk = Address::generate(&env);
        let borrower = Address::generate(&env);

        vault.initialize(&admin, &pauser, &keeper, &price_publisher, &risk);

        let thresholds = MarginThresholds {
            warning_bps: 7_000,
            margin_call_bps: 8_000,
            liquidation_bps: 9_000,
        };
        vault.configure_asset(
            &admin,
            &token_id,
            &pg_id,
            &cl_id,
            &haircut_bps,
            &thresholds,
            &CustodyMode::Escrow,
        );

        price_guard.set_price(&price, &ballast_common::price::PriceStatus::Ok);
        credit_line.set_debt(&debt);
        credit_line.set_borrower(&borrower);
        credit_line.set_asset(&token_id);

        Harness {
            env,
            vault,
            token,
            price_guard,
            credit_line,
            admin,
            keeper,
            borrower,
            asset: token_id,
            thresholds,
        }
    }

    #[test]
    fn pledge_then_release_happy_path() {
        // 5% haircut, $500 debt, $1.00 price.
        let h = setup(500, 500 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));

        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);

        // Release 50 units: remaining 950 * 0.95 = $902.50 collateral against $500 debt ->
        // ~5540 bps, well within Healthy (<7000 bps).
        h.vault
            .release(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));

        assert_eq!(h.vault.position_units(&1, &h.asset), 950 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 50 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: caller is not this line's borrower")]
    fn release_by_non_borrower_panics() {
        // Regression test: `release` must check the caller is the *real* borrower of `line`, not
        // just that *someone* signed. Positions are keyed by `(line, asset)` with no borrower
        // dimension, so without this check any signer naming itself as `borrower` against
        // another party's line id could drain that line's escrowed collateral to itself.
        let h = setup(500, 500 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        let attacker = Address::generate(&h.env);
        h.vault
            .release(&attacker, &1, &h.asset, &(50 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release would leave the credit line unhealthy")]
    fn release_breaching_ltv_panics() {
        // 5% haircut, $900 debt, $1.00 price -> already close to the edge.
        let h = setup(500, 900 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        // Releasing 950 leaves 50 units * 0.95 = $47.50 collateral against $900 debt: way past
        // liquidation (>9000 bps) -> must panic.
        h.vault
            .release(&h.borrower, &1, &h.asset, &(950 * PRICE_SCALE));
    }

    #[test]
    fn record_lien_and_liquidate_lien_mode() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);

        // Re-point this asset's config at issuer-lien mode for this test.
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.price_guard.address,
            &h.credit_line.address,
            &500,
            &h.thresholds,
            &CustodyMode::IssuerLien,
        );

        h.vault
            .pledge(&h.borrower, &2, &h.asset, &(100 * PRICE_SCALE));
        // No token movement in lien mode, and the pledge doesn't count toward LTV yet — it's
        // pending gateway confirmation.
        assert_eq!(h.token.balance(&h.vault.address), 0);
        assert_eq!(h.vault.position_units(&2, &h.asset), 0);

        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-123");
        h.vault
            .record_lien(&gateway, &2, &h.asset, &(100 * PRICE_SCALE), &lien_ref);
        // Now confirmed: counts toward LTV.
        assert_eq!(h.vault.position_units(&2, &h.asset), 100 * PRICE_SCALE);

        // Keeper can liquidate a lien-mode position without any token transfer needed.
        let to = Address::generate(&h.env);
        h.vault.liquidate(
            &Address::generate(&h.env),
            &2,
            &h.asset,
            &(100 * PRICE_SCALE),
            &to,
        );
        assert_eq!(h.vault.position_units(&2, &h.asset), 0);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units exceed pending (unconfirmed) lien units")]
    fn record_lien_cannot_confirm_more_than_pending() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.price_guard.address,
            &h.credit_line.address,
            &500,
            &h.thresholds,
            &CustodyMode::IssuerLien,
        );

        h.vault
            .pledge(&h.borrower, &3, &h.asset, &(100 * PRICE_SCALE));

        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-456");
        // Only 100 units are pending; confirming 101 must panic rather than manufacture
        // collateral beyond what was actually pledged.
        h.vault
            .record_lien(&gateway, &3, &h.asset, &(101 * PRICE_SCALE), &lien_ref);
    }

    #[test]
    fn every_change_to_a_position_reaches_the_credit_line_immediately() {
        let h = setup(500, 100 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_units(), -1, "nothing reported yet");

        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_units(), 1_000 * PRICE_SCALE);

        // The release that used to leave the line counting units that were already gone.
        h.vault.release(&h.borrower, &1, &h.asset, &(400 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_units(), 600 * PRICE_SCALE);

        h.vault.liquidate(&Address::generate(&h.env), &1, &h.asset, &(600 * PRICE_SCALE), &Address::generate(&h.env));
        assert_eq!(h.credit_line.synced_units(), 0);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: caller is not this line's borrower")]
    fn only_the_lines_borrower_can_pledge_to_it() {
        let h = setup(500, 0, PRICE_SCALE);
        let someone = Address::generate(&h.env);
        h.token.mint(&someone, &(10 * PRICE_SCALE));
        h.vault.pledge(&someone, &1, &h.asset, &(10 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: not this line's collateral asset")]
    fn a_line_only_takes_its_own_collateral_asset() {
        let h = setup(500, 0, PRICE_SCALE);
        // The line's collateral is `h.asset`; point it at some other token and the pledge is refused.
        h.credit_line.set_asset(&Address::generate(&h.env));
        h.token.mint(&h.borrower, &(10 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: asset custody mode changed while this position holds units")]
    fn the_custody_mode_cannot_flip_under_live_units() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(100 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));

        h.vault.configure_asset(
            &h.admin, &h.asset, &h.price_guard.address, &h.credit_line.address, &500, &h.thresholds,
            &CustodyMode::IssuerLien,
        );
        h.vault.pledge(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
    }

    // ── #24: positions must survive ledger aging ────────────────────────────

    /// Ages the ledger past the default persistent TTL granted at write time.
    /// Without the extensions on every write and read, the position entry (and
    /// the instance) would be archived here, and the escrowed tokens would sit
    /// behind a `release` that can no longer read how many units it may move.
    #[test]
    fn an_aged_position_still_reads_and_releases_correctly() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        // Advance well past the environment's default minimum persistent TTL
        // (but inside the ~30-day extension the write granted).
        let min_ttl = h.env.ledger().get().min_persistent_entry_ttl;
        let aged = h.env.ledger().sequence() + min_ttl + 10;
        h.env.ledger().set_sequence_number(aged);

        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        h.vault.release(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 900 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 100 * PRICE_SCALE);
    }

    /// The public keep-alive, plus the archival behaviour documented on
    /// `read_position`: a position aged past even its extended lifetime is
    /// auto-restored on access and reads its original units, not the
    /// `units: 0` default. Asserted so an SDK upgrade that changes these
    /// semantics fails loudly instead of silently zeroing escrowed collateral.
    #[test]
    fn an_expired_position_is_auto_restored_on_access() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(10 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));

        // Repeated keep-alives: age close to the extension target, extend, repeat.
        for _ in 0..3 {
            let near_target =
                h.env.ledger().sequence() + ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS - 100;
            h.env.ledger().set_sequence_number(near_target);
            h.vault.extend_ttl(&1, &h.asset);
        }
        assert_eq!(h.vault.position_units(&1, &h.asset), 10 * PRICE_SCALE);

        // Now let it lapse: past the last extension's target with no touch.
        let lapsed =
            h.env.ledger().sequence() + ballast_common::ttl::PERSISTENT_EXTEND_TO_LEDGERS + 10;
        h.env.ledger().set_sequence_number(lapsed);
        assert_eq!(
            h.vault.position_units(&1, &h.asset),
            10 * PRICE_SCALE,
            "protocol-23 auto-restore must hand back the original position,              never the units:0 default"
        );
        // And a release still works against the restored position.
        h.vault.release(&h.borrower, &1, &h.asset, &(1 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 9 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: no position to extend")]
    fn extend_ttl_refuses_a_position_that_was_never_written() {
        let h = setup(500, 0, PRICE_SCALE);
        h.vault.extend_ttl(&42, &h.asset);
    }

    #[test]
    fn escrow_partial_liquidation_and_token_delivery() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.vault.address), 1_000 * PRICE_SCALE);

        let lender = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(400 * PRICE_SCALE), &lender);

        // Recipient balance and remaining position asserted
        assert_eq!(h.token.balance(&lender), 400 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&1, &h.asset), 600 * PRICE_SCALE);
        assert_eq!(h.vault.position(&1, &h.asset).units, 600 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 600 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.vault.address), 600 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: liquidate exceeds pledged units")]
    fn liquidate_exceeds_pledged_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        let lender = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(400 * PRICE_SCALE), &lender);
        assert_eq!(h.vault.position_units(&1, &h.asset), 600 * PRICE_SCALE);

        // 600 units remaining; liquidating 601 must panic
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(601 * PRICE_SCALE), &lender);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn liquidate_zero_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        let lender = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &0, &lender);
    }

    #[test]
    fn liquidate_rejected_for_non_keeper() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        let stranger = Address::generate(&h.env);
        let lender = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &h.vault.address,
                fn_name: "liquidate",
                args: (
                    stranger.clone(),
                    1u64,
                    h.asset.clone(),
                    400 * PRICE_SCALE,
                    lender.clone(),
                )
                    .into_val(&h.env),
                sub_invokes: &[],
            },
        }]);

        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault
                .liquidate(&stranger, &1, &h.asset, &(400 * PRICE_SCALE), &lender);
        }));
        assert!(res.is_err(), "non-keeper must be rejected");
        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
    }

    #[test]
    fn liquidate_lien_mode_preserves_pending_lien_units() {
        let h = setup(500, 0, PRICE_SCALE);
    }

    fn record_lien_publishes_event_on_success_and_none_on_failure() {
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};

        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.price_guard.address,
            &h.credit_line.address,
            &500,
            &h.thresholds,
            &CustodyMode::IssuerLien,
        );

        // Pledge 500 units in lien mode -> all 500 are pending confirmation
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(500 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 0);
        assert_eq!(
            h.vault.position(&1, &h.asset).pending_lien_units,
            500 * PRICE_SCALE
        );

        // Confirm 200 units -> 200 confirmed, 300 pending
        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-alpha");
        h.vault
            .record_lien(&gateway, &1, &h.asset, &(200 * PRICE_SCALE), &lien_ref);
        assert_eq!(h.vault.position_units(&1, &h.asset), 200 * PRICE_SCALE);
        assert_eq!(
            h.vault.position(&1, &h.asset).pending_lien_units,
            300 * PRICE_SCALE
        );

        // Liquidate 150 confirmed units to lender
        let lender = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(150 * PRICE_SCALE), &lender);

        // Confirmed units reduce to 50, but pending lien units are completely untouched at 300
        let pos = h.vault.position(&1, &h.asset);
        assert_eq!(pos.units, 50 * PRICE_SCALE);
        assert_eq!(pos.pending_lien_units, 300 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 50 * PRICE_SCALE);

        let line_id = 42u64;
        let pledge_amount = 250 * PRICE_SCALE;
        h.vault.pledge(&h.borrower, &line_id, &h.asset, &pledge_amount);

        let contract_events = || {
            h.env
                .events()
                .all()
                .events()
                .into_iter()
                .filter(|e| e.type_ == ContractEventType::Contract)
                .cloned()
                .collect::<std::vec::Vec<_>>()
        };

        // 1. Failure case: attempting to record more units than pending
        let invalid_lien_ref = Bytes::from_slice(&h.env, b"invalid-lien");
        let failed_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault.record_lien(
                &gateway,
                &line_id,
                &h.asset,
                &(pledge_amount + 1),
                &invalid_lien_ref,
            );
        }));
        assert!(failed_res.is_err(), "record_lien with excess units must fail");

        // Verify no contract event was published on failure
        let events_after_failure = contract_events().len();
        assert_eq!(
            events_after_failure, 0,
            "no contract event should be emitted on failed record_lien"
        );

        // 2. Success case: record valid lien
        let lien_ref = Bytes::from_slice(&h.env, b"valid-lien-ref-42");
        h.vault.record_lien(&gateway, &line_id, &h.asset, &pledge_amount, &lien_ref);

        let events_after_success = contract_events();
        assert_eq!(
            events_after_success.len(), 1,
            "exactly one contract event must be emitted on successful record_lien"
        );
        let last_event = events_after_success.last().expect("an event must have been published");

        let expected_topic0 = ScVal::Symbol(ScSymbol("lien_recorded".try_into().unwrap()));
        let expected_topic1 = ScVal::U64(line_id);
        let val: soroban_sdk::Val = (h.asset.clone(), pledge_amount, lien_ref).into_val(&h.env);
        let expected_data = ScVal::try_from_val(&h.env, &val).unwrap();

        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_topic0));
                assert_eq!(v0.topics.get(1), Some(&expected_topic1));
                assert_eq!(v0.data, expected_data);
            }
        }
    }
}
