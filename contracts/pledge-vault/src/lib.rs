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
//! **Per-asset config.** The admin sets only the custody mode and the `CreditLine` that owns
//! lines against the asset (`configure_asset`). The risk config — haircut, margin thresholds and
//! the PriceGuard address — lives only on `CreditLine` (#180). The vault used to keep its own
//! copy, so a vault haircut lower than the line's (or different thresholds or price source) could
//! approve a release that the very next `poke` showed as MarginCall or Liquidation.
//!
//! **PledgeVault ↔ CreditLine wiring.** When the line owes anything, `release` cross-calls
//! `CreditLine::ltv_after` (read-only) with the units that would remain, so the health check uses
//! exactly the haircut, thresholds, price and debt that `poke`, `draw` and `liquidate` use, and every
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
//! **Events.** Published with shape `(topics, payload)`:
//! - `pledged`: `((Symbol("pledged"), line), (asset: Address, units: i128))`
//! - `released`: `((Symbol("released"), line), (asset: Address, units: i128))`
//! - `lien_recorded`: `((Symbol("lien_recorded"), line), (asset: Address, units: i128, lien_ref: Bytes))`
//! - `lien_rejected`: `((Symbol("lien_rejected"), line), (asset: Address, units: i128, reason: Bytes))`
//! - `pending_cancelled`: `((Symbol("pending_cancelled"), line), (asset: Address, units: i128))`
//! - `liquidated`: `((Symbol("liquidated"), line), (asset: Address, units: i128, to: Address))`
//! - `asset_configured`: `((Symbol("asset_configured"), asset: Address), (credit_line: Address, custody_mode: CustodyMode))`
//! - `gateway_set`: `((Symbol("gateway_set"),), gateway: Address)`

use ballast_common::{
    access::{self, Roles},
    asset::CustodyMode,
    margin::MarginState,
    pause::{self, PauseScope},
    price::PriceStatus,
    ttl,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, Bytes, Env, MuxedAddress,
    Symbol,
};

/// Cross-contract call to CreditLine's `ltv` / `ltv_after` views and its small vault-facing getters. `LtvView`
/// and `LineStatus` are redefined locally (see below) rather than imported, since PledgeVault and
/// CreditLine are decoupled crates by design — they're built together in this pass, so the shapes
/// are hand-kept in sync between the two rather than shared from a common source. That hand-sync
/// is the wiring compromise called out above.
#[contractclient(name = "CreditLineClient")]
pub trait CreditLineInterface {
    fn ltv(env: Env, line: u64) -> LtvView;
    fn ltv_after(env: Env, line: u64, new_units: i128) -> LtvView;
    fn debt_of(env: Env, line: u64) -> i128;
    fn borrower_of(env: Env, line: u64) -> Address;
    fn lender_of(env: Env, line: u64) -> Address;
    fn status_of(env: Env, line: u64) -> LineStatus;
    fn asset_of(env: Env, line: u64) -> Address;
    fn sync_from_vault(env: Env, vault: Address, line: u64, asset: Address, units: i128);
}

/// Mirrors `ballast_credit_line::LineStatus` variant-for-variant. A unit-only `#[contracttype]`
/// enum is encoded on the wire as a symbol, not by Rust type name, so a cross-call into
/// CreditLine's `status_of` decodes correctly into this independently-defined type.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LineStatus {
    Open,
    Liquidating,
    Closed,
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

/// Per-asset config, set directly by the admin. Risk parameters are deliberately not here: they
/// live on `CreditLine` only (see the module docs and #180).
#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetConfig {
    pub credit_line: Address,
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

    /// Admin-set per-asset config: which CreditLine contract owns debt/limit accounting for lines
    /// against this asset, and which custody mode the asset uses. The haircut, margin thresholds
    /// and PriceGuard that `release` checks against are `CreditLine`'s (its own
    /// `configure_asset`, which validates them), read through `CreditLine::ltv_after` (#180).
    /// `admin` is accepted for interface symmetry with the rest of Ballast's admin calls; the
    /// actual check is `access::require_admin`, which authenticates the *stored* admin address
    /// regardless of what's passed here.
    pub fn configure_asset(
        env: Env,
        admin: Address,
        asset: Address,
        credit_line: Address,
        custody_mode: CustodyMode,
    ) {
        let _ = admin;
        access::require_admin(&env);
        ttl::extend_instance(&env);

        env.storage().instance().set(
            &DataKey::AssetConfig(asset.clone()),
            &AssetConfig {
                credit_line: credit_line.clone(),
                custody_mode: custody_mode.clone(),
            },
        );

        env.events().publish(
            (Symbol::new(&env, "asset_configured"), asset),
            (credit_line, custody_mode),
        );
    }

    /// Sets the `issuer-gateway` operator address allowed to call `record_lien`.
    pub fn set_gateway(env: Env, admin: Address, gateway: Address) {
        let _ = admin;
        access::require_admin(&env);
        ttl::extend_instance(&env);
        env.storage().instance().set(&DataKey::Gateway, &gateway);

        env.events().publish((Symbol::new(&env, "gateway_set"),), gateway);
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
    /// `CreditLine` at a healthy LTV, the same bar `CreditLine::draw` sets: a release that would
    /// reach the warning threshold (or beyond) is refused, so releasing collateral can never give
    /// a borrower more leverage than drawing the same amount would (PRD §8: "only if LTV stays
    /// healthy"). This is the only borrower-initiated way RWA leaves the vault (PRD §8 invariant 4).
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

        let remaining_units = position.units - units;

        // With nothing owed there is no risk to price, so a degraded or halted price must not
        // trap collateral (PRD invariant 5: exits that reduce risk cannot depend on conditions the
        // borrower does not control). Any debt keeps the full price and LTV check.
        // Any debt keeps the full check, made with CreditLine's own haircut, thresholds and
        // price (#180): the vault holds no copy of them that could disagree with `poke`.
        let credit_line = CreditLineClient::new(&env, &config.credit_line);
        if credit_line.debt_of(&line) > 0 {
            let after: LtvView = credit_line.ltv_after(&line, &remaining_units);
            assert!(
                matches!(after.price_status, PriceStatus::Ok),
                "pledge-vault: price status is not Ok"
            );
            assert!(
                matches!(after.state, MarginState::Healthy),
                "pledge-vault: release would leave the credit line unhealthy"
            );
        }

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

    /// Cancels unconfirmed pending lien units (`IssuerLien` / `CustodianLien`).
    ///
    /// Signed by `borrower`. Reduces `pending_lien_units` only; never touches confirmed `units`
    /// or moves tokens. Emits a `pending_cancelled` event.
    pub fn cancel_pending(
        env: Env,
        borrower: Address,
        line: u64,
        asset: Address,
        units: i128,
    ) {
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
            units <= position.pending_lien_units,
            "pledge-vault: units exceed pending (unconfirmed) lien units"
        );
        position.pending_lien_units -= units;
        write_position(&env, line, &asset, &position);

        env.events().publish(
            (Symbol::new(&env, "pending_cancelled"), line),
            (asset, units),
        );
    }

    /// Rejects unconfirmed pending lien units (`IssuerLien` / `CustodianLien`) with an audit reason.
    ///
    /// Signed by the configured `gateway`. Reduces `pending_lien_units` only; never touches confirmed
    /// `units` or moves tokens. Emits a `lien_rejected` event with the reason.
    pub fn reject_lien(
        env: Env,
        gateway: Address,
        line: u64,
        asset: Address,
        units: i128,
        reason: Bytes,
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
        write_position(&env, line, &asset, &position);

        env.events().publish(
            (Symbol::new(&env, "lien_rejected"), line),
            (asset, units, reason),
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

    /// Read-only helper for consoles/tests: full position (`units`, `pending_lien_units`, `mode`,
    /// `lien_ref`) for `(line, asset)`.
    ///
    /// For unknown `(line, asset)` keys with no stored entry, returns a default empty `Position`
    /// (`units: 0`, `pending_lien_units: 0`, `mode: CustodyMode::Escrow`, `lien_ref: None`)
    /// without panicking.
    pub fn position(env: Env, line: u64, asset: Address) -> Position {
        ttl::extend_instance(&env);
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

    // A minimal in-crate mock CreditLine exposing just the vault-facing getters
    // (`ltv`/`ltv_after`/`debt_of`/`borrower_of`/`lender_of`/`status_of`/`asset_of`), returning
    // canned values — this crate never depends on the real `ballast-credit-line` crate. It also
    // holds the risk config (haircut, thresholds, price) that the real CreditLine owns, so
    // `ltv_after` computes the post-release standing the same way CreditLine does (#180).
    mod mock_credit_line {
        use crate::{LineStatus, LtvView};
        use ballast_common::{
            margin::{self, MarginState, MarginThresholds},
            price::PriceStatus,
            risk,
        };
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contract]
        pub struct MockCreditLine;

        #[contracttype]
        enum DataKey {
            Debt,
            Borrower,
            Lender,
            Status,
            Asset,
            LineAsset(u64),
            Synced,
            SyncedLine,
            HaircutBps,
            Thresholds,
            Price,
            PriceStatus,
        }

        #[contractimpl]
        impl MockCreditLine {
            /// CreditLine's own risk config for the asset (what its `configure_asset` sets).
            pub fn set_risk(env: Env, haircut_bps: u32, thresholds: MarginThresholds) {
                env.storage().instance().set(&DataKey::HaircutBps, &haircut_bps);
                env.storage().instance().set(&DataKey::Thresholds, &thresholds);
            }

            /// The guarded price CreditLine reads from its PriceGuard.
            pub fn set_price(env: Env, value: i128, status: PriceStatus) {
                env.storage().instance().set(&DataKey::Price, &value);
                env.storage().instance().set(&DataKey::PriceStatus, &status);
            }

            pub fn ltv_after(env: Env, _line: u64, new_units: i128) -> LtvView {
                let st = env.storage().instance();
                let debt: i128 = st.get(&DataKey::Debt).unwrap_or(0);
                let price: i128 = st.get(&DataKey::Price).expect("mock-credit-line: price not set");
                let price_status: PriceStatus =
                    st.get(&DataKey::PriceStatus).unwrap_or(PriceStatus::Ok);
                let haircut_bps: u32 = st.get(&DataKey::HaircutBps).unwrap_or(0);
                let thresholds: MarginThresholds = st
                    .get(&DataKey::Thresholds)
                    .expect("mock-credit-line: thresholds not set");
                let collateral_value = risk::collateral_value(new_units, price, haircut_bps);
                let ltv_bps = risk::ltv_bps(debt, collateral_value);
                LtvView {
                    debt,
                    collateral_value,
                    ltv_bps,
                    state: margin::classify(ltv_bps, &thresholds),
                    price_status,
                }
            }

            pub fn set_debt(env: Env, debt: i128) {
                env.storage().instance().set(&DataKey::Debt, &debt);
            }

            pub fn set_borrower(env: Env, borrower: Address) {
                env.storage().instance().set(&DataKey::Borrower, &borrower);
            }

            pub fn set_lender(env: Env, lender: Address) {
                env.storage().instance().set(&DataKey::Lender, &lender);
            }

            pub fn set_status(env: Env, status: LineStatus) {
                env.storage().instance().set(&DataKey::Status, &status);
            }

            pub fn debt_of(env: Env, _line: u64) -> i128 {
                env.storage().instance().get(&DataKey::Debt).unwrap_or(0)
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

            pub fn lender_of(env: Env, _line: u64) -> Address {
                env.storage()
                    .instance()
                    .get(&DataKey::Lender)
                    .expect("mock-credit-line: lender not set")
            }

            pub fn status_of(env: Env, _line: u64) -> LineStatus {
                env.storage()
                    .instance()
                    .get(&DataKey::Status)
                    .expect("mock-credit-line: status not set")
            }

            pub fn set_asset(env: Env, asset: Address) {
                env.storage().instance().set(&DataKey::Asset, &asset);
            }

            pub fn set_line_asset(env: Env, line: u64, asset: Address) {
                env.storage().instance().set(&DataKey::LineAsset(line), &asset);
            }

            pub fn asset_of(env: Env, line: u64) -> Address {
                if let Some(asset) = env.storage().instance().get(&DataKey::LineAsset(line)) {
                    asset
                } else {
                    env.storage()
                        .instance()
                        .get(&DataKey::Asset)
                        .expect("mock-credit-line: asset not set")
                }
            }

            /// Records the last figure the vault reported, so tests can see that every change to a
            /// position reached the credit line in the same transaction.
            pub fn sync_from_vault(env: Env, vault: Address, line: u64, _asset: Address, units: i128) {
                vault.require_auth();
                env.storage().instance().set(&DataKey::Synced, &units);
                env.storage().instance().set(&DataKey::SyncedLine, &line);
            }

            pub fn synced_units(env: Env) -> i128 {
                env.storage().instance().get(&DataKey::Synced).unwrap_or(-1)
            }

            pub fn synced_line(env: Env) -> u64 {
                env.storage().instance().get(&DataKey::SyncedLine).unwrap_or(0)
            }
        }
    }

    #[allow(dead_code)]
    struct Harness {
        env: Env,
        vault: PledgeVaultClient<'static>,
        token: mock_token::MockTokenClient<'static>,
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
            &cl_id,
            &CustodyMode::Escrow,
        );

        credit_line.set_risk(&haircut_bps, &thresholds);
        credit_line.set_price(&price, &ballast_common::price::PriceStatus::Ok);
        credit_line.set_debt(&debt);
        credit_line.set_borrower(&borrower);
        credit_line.set_asset(&token_id);

        Harness {
            env,
            vault,
            token,
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
    #[should_panic(expected = "pledge-vault: release would leave the credit line unhealthy")]
    fn release_leaving_ltv_exactly_at_the_warning_threshold_panics() {
        // No haircut and a $1.00 price, so collateral value equals the units left. Debt 700 over
        // 1,000 units left is exactly 7,000 bps, the Warning threshold: refused (draw refuses it too).
        let h = setup(0, 700 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(2_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(2_000 * PRICE_SCALE));

        h.vault.release(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
    }

    #[test]
    fn release_leaving_ltv_one_bp_under_the_warning_threshold_works() {
        // Same line, but 0.1 unit more stays behind: 700 / 1,000.1 = 6,999 bps, still Healthy.
        let h = setup(0, 700 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(2_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(2_000 * PRICE_SCALE));

        h.vault.release(&h.borrower, &1, &h.asset, &(9_999 * PRICE_SCALE / 10));

        assert_eq!(h.vault.position_units(&1, &h.asset), 10_001 * PRICE_SCALE / 10);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release would leave the credit line unhealthy")]
    fn release_from_a_line_already_in_warning_panics() {
        // 750 debt over 1,000 units is 7,500 bps (Warning) before anything is released; even a tiny
        // release is refused until the borrower repays.
        let h = setup(0, 750 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        h.vault.release(&h.borrower, &1, &h.asset, &PRICE_SCALE);
    }

    // ── #190: release around the Warning threshold, using the issue's numbers ─────────────
    //
    // `release` only succeeds when the line stays Healthy (#1116 / #181); Warning is never allowed.
    // `main` already covers the same boundary under the default thresholds
    // (`release_leaving_ltv_exactly_at_the_warning_threshold_panics` and its one-bp-under twin).
    // These tests use the issue's 700 debt / 1,000 pledge figures, so they are a worked example
    // of #190 rather than new coverage.

    #[test]
    fn release_passes_at_7990_bps_when_still_healthy() {
        // Issue #190: With haircut 0, price 1.0, debt 700, pledge 1000:
        // Releasing 124 leaves 876 collateral units.
        // Collateral value = 876 * 1.0 = 876 (haircut 0).
        // LTV bps = 700 * 10_000 / 876 = 7,990 bps.
        // With warning_bps moved to 8,000, 7,990 bps is still Healthy (< 8,000 bps), so the
        // release succeeds. It would fail under the default 7,000 warning threshold (see below).
        let h = setup(0, 700 * PRICE_SCALE, PRICE_SCALE);
        reconfigure(&h, 0, &bands(8_000, 8_500, 9_000));
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        h.vault.release(&h.borrower, &1, &h.asset, &(124 * PRICE_SCALE));

        assert_eq!(h.vault.position_units(&1, &h.asset), 876 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release would leave the credit line unhealthy")]
    fn release_panics_at_exactly_8000_bps_at_the_warning_threshold() {
        // Issue #190: With haircut 0, price 1.0, debt 700, pledge 1000:
        // Releasing 125 leaves 875 collateral units.
        // Collateral value = 875 * 1.0 = 875 (haircut 0).
        // LTV bps = 700 * 10_000 / 875 = exactly 8,000 bps.
        // With `bands(8_000, 8_500, 9_000)`, 8,000 bps is exactly the Warning threshold, so the
        // line would no longer be Healthy and the release panics.
        let h = setup(0, 700 * PRICE_SCALE, PRICE_SCALE);
        reconfigure(&h, 0, &bands(8_000, 8_500, 9_000));
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        h.vault.release(&h.borrower, &1, &h.asset, &(125 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release would leave the credit line unhealthy")]
    fn release_at_7990_bps_panics_under_default_warning_threshold_after_rule_update() {
        // Under default thresholds (warning_bps: 7_000, margin_call_bps: 8_000, liquidation_bps: 9_000)
        // and following the rule update in #181 (where release requires MarginState::Healthy),
        // releasing 124 leaves 876 collateral -> 7,990 bps.
        // Because 7,990 bps >= 7,000 bps (Warning band), release panics under the updated rule.
        let h = setup(0, 700 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        h.vault.release(&h.borrower, &1, &h.asset, &(124 * PRICE_SCALE));
    }

    #[test]
    fn release_with_no_debt_works_on_a_degraded_price() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        h.credit_line.set_price(&PRICE_SCALE, &ballast_common::price::PriceStatus::Degraded);

        h.vault.release(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        assert_eq!(h.vault.position_units(&1, &h.asset), 0);
        assert_eq!(h.token.balance(&h.borrower), 1_000 * PRICE_SCALE);
    }

    #[test]
    fn release_with_no_debt_works_on_a_halted_price() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        h.credit_line.set_price(&PRICE_SCALE, &ballast_common::price::PriceStatus::Halted);

        h.vault.release(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        assert_eq!(h.vault.position_units(&1, &h.asset), 0);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: price status is not Ok")]
    fn release_with_debt_still_needs_a_usable_price() {
        let h = setup(500, 100 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        h.credit_line.set_price(&PRICE_SCALE, &ballast_common::price::PriceStatus::Degraded);

        h.vault.release(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
    }

    // ── #192: release validation and price status error paths ────────────────

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn release_of_zero_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        h.vault.release(&h.borrower, &1, &h.asset, &0);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release exceeds pledged units")]
    fn release_exceeding_position_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        h.vault.release(&h.borrower, &1, &h.asset, &(1_001 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: price status is not Ok")]
    fn release_with_debt_on_halted_price_panics() {
        // Zero-debt releases skip the price check (#1110 / PRD §8 invariant 5),
        // but any debt requires a usable price (PriceStatus::Ok).
        let h = setup(500, 100 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        h.credit_line.set_price(&PRICE_SCALE, &ballast_common::price::PriceStatus::Halted);
        h.vault.release(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
    }

    #[test]
    fn release_failure_modes_leave_position_and_token_balances_unchanged() {
        // Zero-debt releases skip price checks (issue #1110), but when debt > 0,
        // price must be Ok. For all failed release attempts, state must remain untouched.
        let h = setup(500, 100 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 1_000 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 1_000 * PRICE_SCALE);

        // 1. Zero units fails
        let res = h.vault.try_release(&h.borrower, &1, &h.asset, &0);
        assert!(res.is_err());
        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 1_000 * PRICE_SCALE);

        // 2. Units exceeding position fails
        let res = h.vault.try_release(&h.borrower, &1, &h.asset, &(1_001 * PRICE_SCALE));
        assert!(res.is_err());
        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 1_000 * PRICE_SCALE);

        // 3. Degraded price fails when debt > 0 (issue #1110)
        h.credit_line.set_price(&PRICE_SCALE, &ballast_common::price::PriceStatus::Degraded);
        let res = h.vault.try_release(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
        assert!(res.is_err());
        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 1_000 * PRICE_SCALE);

        // 4. Halted price fails when debt > 0 (issue #1110)
        h.credit_line.set_price(&PRICE_SCALE, &ballast_common::price::PriceStatus::Halted);
        let res = h.vault.try_release(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
        assert!(res.is_err());
        assert_eq!(h.vault.position_units(&1, &h.asset), 1_000 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 1_000 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 1_000 * PRICE_SCALE);
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
            &h.credit_line.address,
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
    fn release_in_lien_mode_moves_no_tokens_but_still_syncs() {
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};

        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);

        // Re-point this asset's config at issuer-lien mode for this test.
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        let line_id = 2u64;
        let pledge_amount = 100 * PRICE_SCALE;
        h.vault
            .pledge(&h.borrower, &line_id, &h.asset, &pledge_amount);

        // In lien mode, tokens never enter vault and position_units is 0 pending confirmation
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 0);
        assert_eq!(h.vault.position_units(&line_id, &h.asset), 0);

        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-release-test");
        h.vault
            .record_lien(&gateway, &line_id, &h.asset, &pledge_amount, &lien_ref);
        assert_eq!(h.vault.position_units(&line_id, &h.asset), 100 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 100 * PRICE_SCALE);

        // Release 40 units in lien mode
        let release_amount = 40 * PRICE_SCALE;
        h.vault
            .release(&h.borrower, &line_id, &h.asset, &release_amount);

        // Assert released event emitted (read immediately before subsequent calls reset event log)
        let events = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .cloned()
            .collect::<std::vec::Vec<_>>();
        let last_event = events.last().expect("expected released event");
        let expected_t0 = ScVal::Symbol(ScSymbol("released".try_into().unwrap()));
        let expected_t1 = ScVal::U64(line_id);
        let val: soroban_sdk::Val = (h.asset.clone(), release_amount).into_val(&h.env);
        let expected_data = ScVal::try_from_val(&h.env, &val).unwrap();
        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_t0));
                assert_eq!(v0.topics.get(1), Some(&expected_t1));
                assert_eq!(v0.data, expected_data);
            }
        }

        // Assert borrower token balance still 0, vault token balance 0
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 0);
        // position_units == 60
        assert_eq!(h.vault.position_units(&line_id, &h.asset), 60 * PRICE_SCALE);
        // synced_units() == 60
        assert_eq!(h.credit_line.synced_units(), 60 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release exceeds pledged units")]
    fn release_in_lien_mode_cannot_exceed_confirmed_units_when_pending() {
        let h = setup(500, 0, PRICE_SCALE);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        let line_id = 2u64;
        h.vault
            .pledge(&h.borrower, &line_id, &h.asset, &(100 * PRICE_SCALE));
        // Confirmed units is 0, 100 pending. Release cannot exceed confirmed (0)
        h.vault
            .release(&h.borrower, &line_id, &h.asset, &(1 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release exceeds pledged units")]
    fn release_in_lien_mode_cannot_exceed_confirmed_units_after_partial_record() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        let line_id = 2u64;
        h.vault
            .pledge(&h.borrower, &line_id, &h.asset, &(100 * PRICE_SCALE));
        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-partial");
        h.vault
            .record_lien(&gateway, &line_id, &h.asset, &(50 * PRICE_SCALE), &lien_ref);
        // Confirmed is 50, trying to release 51 must panic
        h.vault
            .release(&h.borrower, &line_id, &h.asset, &(51 * PRICE_SCALE));
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
            &h.credit_line.address,
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

    // ── #185: pledge's error paths ──────────────────────────────────────────

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn pledge_of_zero_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(10 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &0);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn pledge_of_negative_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(10 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &-1);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: asset not configured")]
    fn pledge_of_an_unconfigured_asset_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        // A second token that the admin never passed to `configure_asset`. The borrower holds
        // enough of it, so the missing config is the only thing wrong with the pledge.
        let other_id = h.env.register(mock_token::MockToken, ());
        let other = mock_token::MockTokenClient::new(&h.env, &other_id);
        other.mint(&h.borrower, &(10 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &other_id, &(10 * PRICE_SCALE));
    }

    /// The borrower holds fewer units than they pledge, so the token's own `transfer` refuses.
    #[test]
    #[should_panic(expected = "mock-token: insufficient balance")]
    fn pledge_beyond_the_borrowers_balance_panics_in_the_token() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(40 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(40 * PRICE_SCALE + 1));
    }

    /// The same failed transfer, looked at from outside: the whole pledge fails with it. No units
    /// are credited, nothing is reported to the credit line, and no tokens move. Pledging what the
    /// borrower does hold then works, so the amount was the only thing wrong with the first call.
    #[test]
    fn pledge_beyond_the_borrowers_balance_changes_nothing() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(40 * PRICE_SCALE));

        let refused = h
            .vault
            .try_pledge(&h.borrower, &1, &h.asset, &(40 * PRICE_SCALE + 1));

        assert!(
            refused.is_err(),
            "a pledge the borrower cannot fund must fail"
        );
        assert_eq!(h.vault.position_units(&1, &h.asset), 0);
        assert_eq!(
            h.credit_line.synced_units(),
            -1,
            "nothing reported to the credit line"
        );
        assert_eq!(h.token.balance(&h.borrower), 40 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.vault.address), 0);

        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(40 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 40 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 40 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 0);
        assert_eq!(h.token.balance(&h.vault.address), 40 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: asset custody mode changed while this position holds units")]
    fn the_custody_mode_cannot_flip_under_live_units() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(100 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));

        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );
        h.vault.pledge(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
    }

    // ── #180: release uses CreditLine's risk config, never a copy of its own ────────

    fn bands(warning_bps: u32, margin_call_bps: u32, liquidation_bps: u32) -> MarginThresholds {
        MarginThresholds {
            warning_bps,
            margin_call_bps,
            liquidation_bps,
        }
    }

    /// Changes CreditLine's haircut and thresholds for the harness's asset. Since #180 that is the
    /// only copy of them: the vault's `configure_asset` no longer takes either. (Refusing a
    /// haircut above 100% or unordered thresholds, #177, is `CreditLine::configure_asset`'s job
    /// and is tested there.)
    fn reconfigure(h: &Harness, haircut_bps: u32, thresholds: &MarginThresholds) {
        h.credit_line.set_risk(&haircut_bps, thresholds);
    }

    /// The vault config carries only the line contract and custody mode, and `asset_configured`
    /// reports exactly that.
    #[test]
    fn vault_config_holds_no_risk_parameters() {
        let h = setup(500, 0, PRICE_SCALE);
        h.env.as_contract(&h.vault.address, || {
            let cfg = read_asset_config(&h.env, &h.asset);
            assert_eq!(cfg.credit_line, h.credit_line.address);
            assert_eq!(cfg.custody_mode, CustodyMode::Escrow);
        });
    }

    /// The bug #180 describes: the vault approved a release with its own (looser) numbers and the
    /// next `poke` on CreditLine called the line unhealthy. Now the release outcome follows
    /// whatever CreditLine is configured with, including a change made after the pledge.
    #[test]
    fn release_outcome_follows_credit_line_risk_config() {
        // 5% haircut, $500 debt, $1.00 price.
        let h = setup(500, 500 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        // 950 units at a 5% haircut are worth $902.50 against $500 (~5,540 bps): Healthy.
        h.vault
            .release(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 950 * PRICE_SCALE);

        // CreditLine alone moves to a 50% haircut. 900 units are then worth $450 against $500
        // (over 100% LTV), so the same-sized release must now be refused.
        reconfigure(&h, 5_000, &h.thresholds);
        let res = h
            .vault
            .try_release(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
        assert!(res.is_err(), "release must follow CreditLine's updated haircut");
        assert_eq!(h.vault.position_units(&1, &h.asset), 950 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: release would leave the credit line unhealthy")]
    fn release_is_refused_when_credit_line_thresholds_make_it_unhealthy() {
        // $500 debt, 0% haircut, 1,000 units at $1.00: releasing 200 leaves 800 -> 6,250 bps.
        // Healthy under the default 7,000 warning threshold, but CreditLine's thresholds are
        // tightened to warn at 6,000, so the release is refused.
        let h = setup(0, 500 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));
        reconfigure(&h, 0, &bands(6_000, 8_000, 9_000));
        h.vault
            .release(&h.borrower, &1, &h.asset, &(200 * PRICE_SCALE));
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
            &h.credit_line.address,
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

    #[test]
    fn pledge_release_liquidate_and_record_lien_emit_expected_events() {
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};

        let h = setup(500, 0, PRICE_SCALE);
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

        let assert_event = |topic: &str, line: u64, expected_val: soroban_sdk::Val| {
            let evs = contract_events();
            assert_eq!(evs.len(), 1, "expected 1 contract event for {topic}");
            let expected_t0 = ScVal::Symbol(ScSymbol(topic.try_into().unwrap()));
            let expected_t1 = ScVal::U64(line);
            let expected_data = ScVal::try_from_val(&h.env, &expected_val).unwrap();
            match &evs[0].body {
                ContractEventBody::V0(v0) => {
                    assert_eq!(v0.topics.get(0), Some(&expected_t0));
                    assert_eq!(v0.topics.get(1), Some(&expected_t1));
                    assert_eq!(v0.data, expected_data);
                }
            }
        };

        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(600 * PRICE_SCALE));
        assert_event("pledged", 1, (h.asset.clone(), 600 * PRICE_SCALE).into_val(&h.env));

        h.vault.release(&h.borrower, &1, &h.asset, &(200 * PRICE_SCALE));
        assert_event("released", 1, (h.asset.clone(), 200 * PRICE_SCALE).into_val(&h.env));

        let recipient = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(400 * PRICE_SCALE), &recipient);
        assert_event(
            "liquidated",
            1,
            (h.asset.clone(), 400 * PRICE_SCALE, recipient).into_val(&h.env),
        );

        let fail_rel = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault.release(&h.borrower, &1, &h.asset, &(1 * PRICE_SCALE));
        }));
        assert!(fail_rel.is_err());
        assert_eq!(contract_events().len(), 0);

        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );
        h.vault.pledge(&h.borrower, &2, &h.asset, &(300 * PRICE_SCALE));
        assert_event("pledged", 2, (h.asset.clone(), 300 * PRICE_SCALE).into_val(&h.env));

        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-187");
        h.vault
            .record_lien(&gateway, &2, &h.asset, &(300 * PRICE_SCALE), &lien_ref);
        assert_event(
            "lien_recorded",
            2,
            (h.asset.clone(), 300 * PRICE_SCALE, lien_ref).into_val(&h.env),
        );
    }

    #[test]
    #[should_panic(expected = "pledge-vault: already initialized")]
    fn initialize_twice_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        let alt = Address::generate(&h.env);
        h.vault.initialize(&alt, &alt, &alt, &alt, &alt);
    }

    #[test]
    fn configure_asset_and_set_gateway_require_stored_admin() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

        let h = setup(500, 0, PRICE_SCALE);
        let impostor = Address::generate(&h.env);
        let alt_cl = Address::generate(&h.env);

        h.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &h.vault.address,
                fn_name: "configure_asset",
                args: (
                    impostor.clone(),
                    h.asset.clone(),
                    alt_cl.clone(),
                    CustodyMode::IssuerLien,
                )
                    .into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let res_cfg = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault.configure_asset(
                &impostor,
                &h.asset,
                &alt_cl,
                &CustodyMode::IssuerLien,
            );
        }));
        assert!(res_cfg.is_err(), "impostor cannot reconfigure asset");

        h.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &h.vault.address,
                fn_name: "set_gateway",
                args: (impostor.clone(), impostor.clone()).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let res_gw = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault.set_gateway(&impostor, &impostor);
        }));
        assert!(res_gw.is_err(), "impostor cannot set gateway");

        h.env.as_contract(&h.vault.address, || {
            let cfg = read_asset_config(&h.env, &h.asset);
            assert_eq!(cfg.credit_line, h.credit_line.address);
            assert_eq!(cfg.custody_mode, CustodyMode::Escrow);
            let gw: Option<Address> = h.env.storage().instance().get(&DataKey::Gateway);
            assert_eq!(gw, None);
        });

        h.env.mock_all_auths();
        let gateway = Address::generate(&h.env);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &alt_cl,
            &CustodyMode::IssuerLien,
        );
        h.vault.set_gateway(&h.admin, &gateway);

        h.env.as_contract(&h.vault.address, || {
            let cfg = read_asset_config(&h.env, &h.asset);
            assert_eq!(cfg.credit_line, alt_cl);
            assert_eq!(cfg.custody_mode, CustodyMode::IssuerLien);
            let gw: Option<Address> = h.env.storage().instance().get(&DataKey::Gateway);
            assert_eq!(gw, Some(gateway));
        });
    }

    #[test]
    #[should_panic(expected = "pledge-vault: gateway not configured")]
    fn record_lien_fails_before_gateway_configured() {
        let h = setup(500, 0, PRICE_SCALE);
        let caller = Address::generate(&h.env);
        let lien_ref = Bytes::from_slice(&h.env, b"lien-unset");
        h.vault
            .record_lien(&caller, &1, &h.asset, &(10 * PRICE_SCALE), &lien_ref);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: caller is not the configured gateway")]
    fn record_lien_fails_for_non_gateway() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        let impostor = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        let lien_ref = Bytes::from_slice(&h.env, b"lien-impostor");
        h.vault
            .record_lien(&impostor, &1, &h.asset, &(10 * PRICE_SCALE), &lien_ref);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn record_lien_fails_when_units_zero() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        let lien_ref = Bytes::from_slice(&h.env, b"lien-zero");
        h.vault.record_lien(&gateway, &1, &h.asset, &0, &lien_ref);
    }

    #[test]
    fn record_lien_partial_tranches_sum_and_last_lien_ref_wins() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 0);
        assert_eq!(
            h.vault.position(&1, &h.asset).pending_lien_units,
            100 * PRICE_SCALE
        );

        let lien_ref_1 = Bytes::from_slice(&h.env, b"lien-tranche-1");
        h.vault
            .record_lien(&gateway, &1, &h.asset, &(40 * PRICE_SCALE), &lien_ref_1);
        let mid = h.vault.position(&1, &h.asset);
        assert_eq!(mid.units, 40 * PRICE_SCALE);
        assert_eq!(mid.pending_lien_units, 60 * PRICE_SCALE);
        assert_eq!(mid.lien_ref, Some(lien_ref_1));
        assert_eq!(h.credit_line.synced_units(), 40 * PRICE_SCALE);

        let lien_ref_2 = Bytes::from_slice(&h.env, b"lien-tranche-2");
        h.vault
            .record_lien(&gateway, &1, &h.asset, &(60 * PRICE_SCALE), &lien_ref_2);
        let done = h.vault.position(&1, &h.asset);
        assert_eq!(done.units, 100 * PRICE_SCALE);
        assert_eq!(done.pending_lien_units, 0);
        assert_eq!(done.lien_ref, Some(lien_ref_2));
        assert_eq!(h.vault.position_units(&1, &h.asset), 100 * PRICE_SCALE);
        assert_eq!(h.credit_line.synced_units(), 100 * PRICE_SCALE);
    }

    #[test]
    fn position_returns_default_for_unknown_key_and_all_fields_when_populated() {
        let h = setup(500, 0, PRICE_SCALE);

        let empty = h.vault.position(&999, &h.asset);
        assert_eq!(empty.units, 0);
        assert_eq!(empty.pending_lien_units, 0);
        assert_eq!(empty.mode, CustodyMode::Escrow);
        assert_eq!(empty.lien_ref, None);

        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(250 * PRICE_SCALE));
        let pending = h.vault.position(&1, &h.asset);
        assert_eq!(pending.units, 0);
        assert_eq!(pending.pending_lien_units, 250 * PRICE_SCALE);
        assert_eq!(pending.mode, CustodyMode::IssuerLien);
        assert_eq!(pending.lien_ref, None);

        let lien_ref = Bytes::from_slice(&h.env, b"lien-view-176");
        h.vault
            .record_lien(&gateway, &1, &h.asset, &(100 * PRICE_SCALE), &lien_ref);
        let confirmed = h.vault.position(&1, &h.asset);
        assert_eq!(confirmed.units, 100 * PRICE_SCALE);
        assert_eq!(confirmed.pending_lien_units, 150 * PRICE_SCALE);
        assert_eq!(confirmed.mode, CustodyMode::IssuerLien);
        assert_eq!(confirmed.lien_ref, Some(lien_ref));
    }

    #[test]
    fn position_isolation_per_line_and_asset_and_defaults_for_unknown_keys() {
        let h = setup(0, 0, PRICE_SCALE);

        // Unknown key returns 0 units
        assert_eq!(h.vault.position_units(&99, &h.asset), 0);
        let unknown_asset = Address::generate(&h.env);
        assert_eq!(h.vault.position_units(&1, &unknown_asset), 0);

        // Register and configure a second asset
        let token2_id = h.env.register(mock_token::MockToken, ());
        let token2 = mock_token::MockTokenClient::new(&h.env, &token2_id);
        h.vault.configure_asset(
            &h.admin,
            &token2_id,
            &h.credit_line.address,
            &CustodyMode::Escrow,
        );

        // Configure line assets on mock credit line
        h.credit_line.set_line_asset(&1, &h.asset);
        h.credit_line.set_line_asset(&2, &token2_id);
        h.credit_line.set_line_asset(&3, &h.asset);
        h.credit_line.set_line_asset(&4, &token2_id);

        // Mint balances to borrower
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        token2.mint(&h.borrower, &(1_000 * PRICE_SCALE));

        // Pledge on 4 distinct (line, asset) pairs:
        // (Line 1, Asset 1): 100
        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_line(), 1);
        assert_eq!(h.credit_line.synced_units(), 100 * PRICE_SCALE);

        // (Line 2, Asset 2): 200
        h.vault.pledge(&h.borrower, &2, &token2_id, &(200 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_line(), 2);
        assert_eq!(h.credit_line.synced_units(), 200 * PRICE_SCALE);

        // (Line 3, Asset 1): 300
        h.vault.pledge(&h.borrower, &3, &h.asset, &(300 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_line(), 3);
        assert_eq!(h.credit_line.synced_units(), 300 * PRICE_SCALE);

        // (Line 4, Asset 2): 400
        h.vault.pledge(&h.borrower, &4, &token2_id, &(400 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_line(), 4);
        assert_eq!(h.credit_line.synced_units(), 400 * PRICE_SCALE);

        // Verify initial state across all positions
        assert_eq!(h.vault.position_units(&1, &h.asset), 100 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&2, &token2_id), 200 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&3, &h.asset), 300 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&4, &token2_id), 400 * PRICE_SCALE);

        // Release 40 from (Line 1, Asset 1)
        h.vault.release(&h.borrower, &1, &h.asset, &(40 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_line(), 1);
        assert_eq!(h.credit_line.synced_units(), 60 * PRICE_SCALE);

        // Verify (Line 1, Asset 1) is reduced to 60 while all other positions are unchanged
        assert_eq!(h.vault.position_units(&1, &h.asset), 60 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&2, &token2_id), 200 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&3, &h.asset), 300 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&4, &token2_id), 400 * PRICE_SCALE);

        // Release 50 from (Line 4, Asset 2)
        h.vault.release(&h.borrower, &4, &token2_id, &(50 * PRICE_SCALE));
        assert_eq!(h.credit_line.synced_line(), 4);
        assert_eq!(h.credit_line.synced_units(), 350 * PRICE_SCALE);

        // Verify (Line 4, Asset 2) is reduced to 350 while all other positions remain unchanged
        assert_eq!(h.vault.position_units(&1, &h.asset), 60 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&2, &token2_id), 200 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&3, &h.asset), 300 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&4, &token2_id), 350 * PRICE_SCALE);

        // Never-used (line, asset) key remains 0
        assert_eq!(h.vault.position_units(&99, &h.asset), 0);
        assert_eq!(h.vault.position_units(&1, &Address::generate(&h.env)), 0);
    }

    // TODO: set these flags through a real on-chain pause entry point once pause wiring lands.
    // `pledge-vault` has no pause writer today, so the tests set the flag directly via
    // `as_contract`; see the dead-pause-flag entry-point bugs #30/#32 and the open pause-reach
    // tracking issue #210.
    #[test]
    #[should_panic(expected = "ballast-common: paused")]
    fn pledge_panics_while_pledges_scope_paused() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.env.as_contract(&h.vault.address, || {
            pause::set_paused(&h.env, &PauseScope::Pledges, true);
        });
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "ballast-common: paused")]
    fn pledge_panics_while_all_scope_paused() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.env.as_contract(&h.vault.address, || {
            pause::set_paused(&h.env, &PauseScope::All, true);
        });
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
    }

    #[test]
    fn release_and_liquidate_keep_working_while_pledges_paused() {
        let h = setup(500, 500 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        h.env.as_contract(&h.vault.address, || {
            pause::set_paused(&h.env, &PauseScope::Pledges, true);
        });

        // Release is risk-reducing (invariant 4): it must not be pause-gated.
        h.vault
            .release(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 950 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 50 * PRICE_SCALE);

        // Liquidation is enforcement (invariant 5): it must not be pause-gated either.
        let lender = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(400 * PRICE_SCALE), &lender);
        assert_eq!(h.token.balance(&lender), 400 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&1, &h.asset), 550 * PRICE_SCALE);

        // New pledges stay blocked while the flag is set.
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault
                .pledge(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
        }));
        assert!(blocked.is_err(), "pledge must stay paused");
    }

    #[test]
    fn release_and_liquidate_keep_working_while_all_paused() {
        let h = setup(500, 500 * PRICE_SCALE, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(1_000 * PRICE_SCALE));

        h.env.as_contract(&h.vault.address, || {
            pause::set_paused(&h.env, &PauseScope::All, true);
        });

        h.vault
            .release(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 950 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.borrower), 50 * PRICE_SCALE);

        let lender = Address::generate(&h.env);
        h.vault
            .liquidate(&h.keeper, &1, &h.asset, &(400 * PRICE_SCALE), &lender);
        assert_eq!(h.token.balance(&lender), 400 * PRICE_SCALE);
        assert_eq!(h.vault.position_units(&1, &h.asset), 550 * PRICE_SCALE);

        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault
                .pledge(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
        }));
        assert!(blocked.is_err(), "pledge must stay paused under All");
    }

    #[test]
    fn pledge_resumes_after_the_pause_flag_is_cleared() {
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(1_000 * PRICE_SCALE));
        h.env.as_contract(&h.vault.address, || {
            pause::set_paused(&h.env, &PauseScope::Pledges, true);
        });
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault
                .pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        }));
        assert!(blocked.is_err(), "pledge must be refused while paused");

        h.env.as_contract(&h.vault.address, || {
            pause::set_paused(&h.env, &PauseScope::Pledges, false);
        });
        h.vault
            .pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 100 * PRICE_SCALE);
    }

    // ── B-0184: pledge accumulation & custody-mode flip on empty position ────────────────────────

    /// (1) Two escrow pledges must sum into `position_units`.
    ///
    /// A borrower pledges 100 units then 50 units to the same `(line, asset)` position in escrow
    /// mode. After the second pledge `position_units` must equal 150; the vault must hold the
    /// combined balance.
    #[test]
    fn escrow_pledges_accumulate() {
        let h = setup(500, 0, PRICE_SCALE);
        // Mint enough for both pledges.
        h.token.mint(&h.borrower, &(150 * PRICE_SCALE));

        h.vault.pledge(&h.borrower, &10, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(
            h.vault.position_units(&10, &h.asset),
            100 * PRICE_SCALE,
            "after first pledge: 100"
        );

        h.vault.pledge(&h.borrower, &10, &h.asset, &(50 * PRICE_SCALE));
        assert_eq!(
            h.vault.position_units(&10, &h.asset),
            150 * PRICE_SCALE,
            "after second pledge: 150"
        );
        // Vault balance matches.
        assert_eq!(h.token.balance(&h.vault.address), 150 * PRICE_SCALE);
        // Borrower's balance is fully consumed.
        assert_eq!(h.token.balance(&h.borrower), 0);
    }

    /// (2) Two `IssuerLien` pledges must accumulate in `pending_lien_units`; `position_units`
    /// stays zero because no gateway has confirmed either lien yet.
    ///
    /// Reads `position(line, asset).pending_lien_units` rather than reaching into storage with `as_contract`.
    #[test]
    fn lien_pledges_accumulate_in_pending() {
        let h = setup(500, 0, PRICE_SCALE);

        // Switch the asset to issuer-lien mode.
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        // No token transfer expected; no mint needed.
        h.vault.pledge(&h.borrower, &20, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(
            h.vault.position_units(&20, &h.asset),
            0,
            "lien pledge should NOT yet count toward LTV"
        );
        assert_eq!(
            h.vault.position(&20, &h.asset).pending_lien_units,
            100 * PRICE_SCALE,
            "first lien pledge lands in pending"
        );

        h.vault.pledge(&h.borrower, &20, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(
            h.vault.position_units(&20, &h.asset),
            0,
            "still zero — gateway has not confirmed"
        );
        assert_eq!(
            h.vault.position(&20, &h.asset).pending_lien_units,
            200 * PRICE_SCALE,
            "two lien pledges → 200 pending"
        );
        // Vault must hold no tokens in lien mode.
        assert_eq!(h.token.balance(&h.vault.address), 0);
    }

    /// (3) A position that has been fully released (units == 0, pending_lien_units == 0) must
    /// allow the asset's custody mode to be changed, and a subsequent pledge in the new mode
    /// must succeed.
    ///
    /// Flow: pledge 100 in Escrow → release 100 → reconfigure to IssuerLien → pledge 100.
    #[test]
    fn mode_flip_allowed_on_empty_position() {
        // Zero debt so the full release passes the LTV health check.
        let h = setup(500, 0, PRICE_SCALE);
        h.token.mint(&h.borrower, &(100 * PRICE_SCALE));

        // Step 1: pledge in escrow mode.
        h.vault.pledge(&h.borrower, &30, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&30, &h.asset), 100 * PRICE_SCALE);

        // Step 2: fully release — position is now empty.
        h.vault.release(&h.borrower, &30, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&30, &h.asset), 0);
        assert_eq!(
            h.vault.position(&30, &h.asset).pending_lien_units,
            0,
            "pending must also be zero after full escrow release"
        );

        // Step 3: reconfigure to IssuerLien — allowed because position is empty.
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        // Step 4: pledge in the new mode must succeed; units go into pending, not position.units.
        h.vault.pledge(&h.borrower, &30, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(
            h.vault.position_units(&30, &h.asset),
            0,
            "lien pledge: position_units still zero"
        );
        assert_eq!(
            h.vault.position(&30, &h.asset).pending_lien_units,
            100 * PRICE_SCALE,
            "lien pledge after mode flip: 100 pending"
        );
    }

    // ── #179: cancel_pending and reject_lien ────────────────────────────────

    #[test]
    fn borrower_can_cancel_pending_units_and_free_custody_mode_flip() {
        let h = setup(500, 0, PRICE_SCALE);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        // Pledge 100 units in lien mode: 100 pending, 0 confirmed
        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 0);
        assert_eq!(h.vault.position(&1, &h.asset).pending_lien_units, 100 * PRICE_SCALE);
        assert_eq!(h.vault.position(&1, &h.asset).units, 0);

        // Cancel 40 pending units
        h.vault.cancel_pending(&h.borrower, &1, &h.asset, &(40 * PRICE_SCALE));
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};
        let contract_events = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .cloned()
            .collect::<std::vec::Vec<_>>();
        let last_event = contract_events.last().expect("must emit event on cancel_pending");
        let expected_topic0 = ScVal::Symbol(ScSymbol("pending_cancelled".try_into().unwrap()));
        let expected_topic1 = ScVal::U64(1);
        let val: soroban_sdk::Val = (h.asset.clone(), 40 * PRICE_SCALE).into_val(&h.env);
        let expected_data = ScVal::try_from_val(&h.env, &val).unwrap();
        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_topic0));
                assert_eq!(v0.topics.get(1), Some(&expected_topic1));
                assert_eq!(v0.data, expected_data);
            }
        }
        assert_eq!(h.vault.position(&1, &h.asset).pending_lien_units, 60 * PRICE_SCALE);
        assert_eq!(h.vault.position(&1, &h.asset).units, 0);

        // Cancel remaining 60 pending units
        h.vault.cancel_pending(&h.borrower, &1, &h.asset, &(60 * PRICE_SCALE));
        assert_eq!(h.vault.position(&1, &h.asset).pending_lien_units, 0);
        assert_eq!(h.vault.position(&1, &h.asset).units, 0);

        // Tokens never moved
        assert_eq!(h.token.balance(&h.vault.address), 0);

        // Now that pending_lien_units == 0 and units == 0, custody mode flip to Escrow is allowed!
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::Escrow,
        );
        h.token.mint(&h.borrower, &(50 * PRICE_SCALE));
        h.vault.pledge(&h.borrower, &1, &h.asset, &(50 * PRICE_SCALE));
        assert_eq!(h.vault.position_units(&1, &h.asset), 50 * PRICE_SCALE);
        assert_eq!(h.token.balance(&h.vault.address), 50 * PRICE_SCALE);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units exceed pending (unconfirmed) lien units")]
    fn borrower_cannot_cancel_confirmed_units() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        let lien_ref = Bytes::from_slice(&h.env, b"lien-ref-xyz");
        h.vault.record_lien(&gateway, &1, &h.asset, &(100 * PRICE_SCALE), &lien_ref);

        assert_eq!(h.vault.position_units(&1, &h.asset), 100 * PRICE_SCALE);
        assert_eq!(h.vault.position(&1, &h.asset).pending_lien_units, 0);

        // Attempting to cancel when pending is 0 must panic (cannot cancel confirmed units)
        h.vault.cancel_pending(&h.borrower, &1, &h.asset, &(10 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units exceed pending (unconfirmed) lien units")]
    fn cancel_pending_over_cancel_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        h.vault.cancel_pending(&h.borrower, &1, &h.asset, &(101 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: caller is not this line's borrower")]
    fn cancel_pending_wrong_caller_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        let attacker = Address::generate(&h.env);
        h.vault.cancel_pending(&attacker, &1, &h.asset, &(50 * PRICE_SCALE));
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn cancel_pending_zero_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        h.vault.cancel_pending(&h.borrower, &1, &h.asset, &0);
    }

    #[test]
    fn gateway_can_reject_pending_units_with_event() {
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};

        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        let line_id = 1u64;
        h.vault.pledge(&h.borrower, &line_id, &h.asset, &(200 * PRICE_SCALE));
        assert_eq!(h.vault.position(&line_id, &h.asset).pending_lien_units, 200 * PRICE_SCALE);
        assert_eq!(h.vault.position(&line_id, &h.asset).units, 0);

        let reason = Bytes::from_slice(&h.env, b"issuer declined KYC");
        h.vault.reject_lien(&gateway, &line_id, &h.asset, &(150 * PRICE_SCALE), &reason);

        // Verify emitted event immediately before any subsequent contract call
        let contract_events = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .cloned()
            .collect::<std::vec::Vec<_>>();

        let last_event = contract_events.last().expect("must emit event on reject_lien");
        let expected_topic0 = ScVal::Symbol(ScSymbol("lien_rejected".try_into().unwrap()));
        let expected_topic1 = ScVal::U64(line_id);
        let val: soroban_sdk::Val = (h.asset.clone(), 150 * PRICE_SCALE, reason.clone()).into_val(&h.env);
        let expected_data = ScVal::try_from_val(&h.env, &val).unwrap();

        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_topic0));
                assert_eq!(v0.topics.get(1), Some(&expected_topic1));
                assert_eq!(v0.data, expected_data);
            }
        }

        // Position verified: pending reduced to 50, confirmed units still 0
        let pos = h.vault.position(&line_id, &h.asset);
        assert_eq!(pos.pending_lien_units, 50 * PRICE_SCALE);
        assert_eq!(pos.units, 0);
        assert_eq!(h.token.balance(&h.vault.address), 0);

        // Reject remaining 50 units
        let reason2 = Bytes::from_slice(&h.env, b"cancelled by ops");
        h.vault.reject_lien(&gateway, &line_id, &h.asset, &(50 * PRICE_SCALE), &reason2);
        assert_eq!(h.vault.position(&line_id, &h.asset).pending_lien_units, 0);
        assert_eq!(h.vault.position(&line_id, &h.asset).units, 0);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units exceed pending (unconfirmed) lien units")]
    fn reject_lien_over_reject_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        let reason = Bytes::from_slice(&h.env, b"fail");
        h.vault.reject_lien(&gateway, &1, &h.asset, &(101 * PRICE_SCALE), &reason);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: caller is not the configured gateway")]
    fn reject_lien_wrong_caller_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        let stranger = Address::generate(&h.env);
        let reason = Bytes::from_slice(&h.env, b"fail");
        h.vault.reject_lien(&stranger, &1, &h.asset, &(50 * PRICE_SCALE), &reason);
    }

    #[test]
    #[should_panic(expected = "pledge-vault: units must be positive")]
    fn reject_lien_zero_units_panics() {
        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);
        h.vault.set_gateway(&h.admin, &gateway);
        h.vault.configure_asset(
            &h.admin,
            &h.asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        h.vault.pledge(&h.borrower, &1, &h.asset, &(100 * PRICE_SCALE));
        let reason = Bytes::from_slice(&h.env, b"zero");
        h.vault.reject_lien(&gateway, &1, &h.asset, &0, &reason);
    }

    // ── #178: configure_asset and set_gateway events ─────────────────────────

    #[test]
    fn configure_asset_publishes_event_on_success_and_none_on_failure() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};

        let h = setup(500, 0, PRICE_SCALE);
        let fresh_asset = Address::generate(&h.env);

        // 1. Success case
        h.vault.configure_asset(
            &h.admin,
            &fresh_asset,
            &h.credit_line.address,
            &CustodyMode::IssuerLien,
        );

        let contract_events = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .cloned()
            .collect::<std::vec::Vec<_>>();

        let last_event = contract_events
            .last()
            .expect("must emit asset_configured event");
        let expected_topic0 = ScVal::Symbol(ScSymbol("asset_configured".try_into().unwrap()));
        let fresh_asset_val: soroban_sdk::Val = fresh_asset.clone().into_val(&h.env);
        let expected_topic1 =
            ScVal::try_from_val(&h.env, &fresh_asset_val).unwrap();
        let expected_payload_val: soroban_sdk::Val =
            (h.credit_line.address.clone(), CustodyMode::IssuerLien).into_val(&h.env);
        let expected_data = ScVal::try_from_val(&h.env, &expected_payload_val).unwrap();

        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_topic0));
                assert_eq!(v0.topics.get(1), Some(&expected_topic1));
                assert_eq!(v0.data, expected_data);
            }
        }

        // 2. Failure case: non-admin caller
        let stranger = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &h.vault.address,
                fn_name: "configure_asset",
                args: (
                    stranger.clone(),
                    fresh_asset.clone(),
                    h.credit_line.address.clone(),
                    CustodyMode::Escrow,
                )
                    .into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let bad_auth_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault.configure_asset(
                &stranger,
                &fresh_asset,
                &h.credit_line.address,
                &CustodyMode::Escrow,
            );
        }));
        assert!(bad_auth_res.is_err(), "non-admin caller must fail");
        let events_after_auth_fail = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .count();
        assert_eq!(
            events_after_auth_fail, 0,
            "no contract event on unauthorized configure_asset"
        );
    }

    #[test]
    fn set_gateway_publishes_event_on_success_and_none_on_failure() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::xdr::{ContractEventBody, ContractEventType, ScSymbol, ScVal};

        let h = setup(500, 0, PRICE_SCALE);
        let gateway = Address::generate(&h.env);

        // 1. Success case
        h.vault.set_gateway(&h.admin, &gateway);

        let contract_events = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .cloned()
            .collect::<std::vec::Vec<_>>();

        let last_event = contract_events.last().expect("must emit gateway_set event");
        let expected_topic0 = ScVal::Symbol(ScSymbol("gateway_set".try_into().unwrap()));
        let gateway_val: soroban_sdk::Val = gateway.clone().into_val(&h.env);
        let expected_data =
            ScVal::try_from_val(&h.env, &gateway_val).unwrap();

        match &last_event.body {
            ContractEventBody::V0(v0) => {
                assert_eq!(v0.topics.get(0), Some(&expected_topic0));
                assert_eq!(v0.topics.len(), 1);
                assert_eq!(v0.data, expected_data);
            }
        }

        // 2. Failure case: non-admin caller
        let stranger = Address::generate(&h.env);
        let other_gateway = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &h.vault.address,
                fn_name: "set_gateway",
                args: (stranger.clone(), other_gateway.clone()).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        let bad_auth_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.vault.set_gateway(&stranger, &other_gateway);
        }));
        assert!(bad_auth_res.is_err(), "non-admin caller must fail");
        let events_after_auth_fail = h
            .env
            .events()
            .all()
            .events()
            .into_iter()
            .filter(|e| e.type_ == ContractEventType::Contract)
            .count();
        assert_eq!(
            events_after_auth_fail, 0,
            "no contract event on unauthorized set_gateway"
        );
    }
}
