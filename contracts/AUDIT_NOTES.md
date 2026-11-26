# Notes for an auditor

What the contracts assume, what they trust, and where they are deliberately simple. Written from the
code as it stands; read it alongside the module docs at the top of each `lib.rs`.

## Roles and trust

| Role | Can | Cannot |
|---|---|---|
| `admin` | configure assets, thresholds, price bands; set the NAV attestor key; withdraw ExitDesk's **own** USDC float and RWA inventory (see [ExitDesk](#exitdesk)); change the parameters listed in [Admin-set parameters that change settlement value](#admin-set-parameters-that-change-settlement-value), most of them immediately | transfer a borrower's pledged collateral, a lender's committed USDC or a repo party's cash or collateral (see [RepoDvP](#repodvp)) directly: CreditLine, PledgeVault and RepoDvp have no `admin_withdraw`/sweep, and every transfer of those funds needs the owning party's auth or a keeper path; sign for a borrower or lender |
| `pauser` | pause exits on ExitDesk and new repo activity on RepoDvp, each through that contract's own `pause`; set Registry's own flags (not read by any other contract, see #210) | pause repayment, release or withdrawal paths (invariant 5); pause draws or pledges (CreditLine and PledgeVault have no `pause`, #210) |
| `keeper` | `sync_collateral` (supplies `units`), `liquidate` (chooses when), vault `liquidate` (supplies `units`, `to`), repo `call_margin`/`default_close`/`default_at_maturity` | choose a price; liquidate without a confirmed breach on a later ledger |
| `price_publisher` | publish NAV (signature-checked) and feed readings | set the guarded price; clear a halt |
| `risk` | `confirm_halt_cleared` | publish prices |

The keeper is trusted for **timing and completeness**, and for three **values** it supplies (see
"Keeper-supplied values" below). Every other amount a settlement uses comes from the contract's
own state or from the PriceGuard. The three supplied values are checked only lightly on-chain;
that they match reality is enforced by the off-chain keeper job, not by the contracts.

### Keeper-supplied values (enforced off-chain only)

Three values a settlement uses are supplied by the keeper (or admin) rather than read from
contract state or the PriceGuard. On-chain each is checked only for a range or a bound; that it
matches the real world is the off-chain keeper job's responsibility, not the contracts'.

| Value | Supplied to | What it decides | On-chain check | Enforcement |
|---|---|---|---|---|
| `units` | `CreditLine::sync_collateral` (`contracts/credit-line/src/lib.rs:452`) | the line's booked `pledged_units`, which feeds LTV, draws, and the seized units in a `LiquidationRecord` | `units >= 0` only; no check against the vault's actual balance | Off-chain only: the keeper job reads the balance from the vault (see #162, #815) |
| `units`, `to` | `PledgeVault::liquidate` (`contracts/pledge-vault/src/lib.rs:447`) | how many units move, and to whom, on liquidation | `units > 0` and `units <= position.units` only; no check that `units` equals the frozen `LiquidationRecord.seized_units` or that `to` is the lender | Off-chain only: the keeper job moves the frozen amount to the lender after `CreditLine::liquidate` confirms the breach |
| timing of `liquidate` | `CreditLine::liquidate` (`contracts/credit-line/src/lib.rs:613`) | when a confirmed breach becomes a liquidation | the breach must have been flagged by a `poke` on an earlier ledger and still confirm at an `Ok` price; the keeper chooses the moment | Off-chain only: the keeper job decides when to submit it |

`poke` (and the `ltv` read) are permissionless — anyone may call them, not only the keeper — so
their timing is not a keeper-supplied value either. They only make stored state match a fresh
price, which is why that is safe (see #211).

### Admin-set parameters that change settlement value

PRD invariant 6 says the admin cannot move user funds. That holds, **with these exceptions**: the
admin can withdraw the ExitDesk's own float and inventory (not holder funds, see
[ExitDesk](#exitdesk)), and the admin sets the parameters below. None of them transfers funds, but
each changes how much a settlement pays, in which token, to whom, or when a position can be
liquidated or defaulted. Unless the table says otherwise, a change takes effect immediately, with
no timelock, and applies to positions that are already open.

| Contract | Entry point | Parameter | What it changes | Timelock |
|---|---|---|---|---|
| CreditLine | `configure_asset` | `price_guard` | the price behind LTV, `draw`, `liquidate` and the price frozen in a `LiquidationRecord` | none |
| CreditLine | `configure_asset` | `haircut_bps`, `thresholds` | collateral value, LTV and the point where a line can be liquidated (thresholds must be ordered, see below) | none |
| CreditLine | `configure_asset` | `usdc` | the token every draw, repayment, lender withdrawal, surplus payment and fee claim uses on lines for that asset, existing ones included | none |
| CreditLine | `set_vault` | vault address | the only contract trusted to report collateral through `sync_from_vault` | none |
| CreditLine | `set_treasury` | treasury address | who can claim repaid platform fees (`claim_fee`) | none |
| PledgeVault | `configure_asset` | `price_guard`, `haircut_bps`, `thresholds` | the price and LTV check `release` applies while a line owes something | none |
| PledgeVault | `configure_asset` | `credit_line` | the contract the vault asks for debt, borrower and LTV before `release`, and reports collateral to | none |
| PledgeVault | `configure_asset` | `custody_mode` | escrow or issuer-lien custody for new pledges; a position that still holds units keeps its mode and refuses pledges in the other one | none |
| PledgeVault | `set_gateway` | gateway address | who can confirm lien-mode pledges | none |
| ExitDesk | `configure_asset` | `price_guard`, `spread_bps`, `per_holder_daily_cap`, `desk_daily_cap`, `desk_inventory_cap` | the exit price and how much can be exited | tightening immediate; a new `price_guard`, a lower spread or a higher cap 48h via `queue_configure_asset`; an asset's first listing is immediate |
| ExitDesk | `set_usdc` | USDC address | the token exits pay out in | none |
| RepoDvp | `configure_asset` | `price_guard`, `haircut_bps`, `thresholds` | margin evaluation, so when `call_margin` and `default_close` can run, and the price `default_close` uses for the lender's units | none (#215) |
| RepoDvp | `configure_asset` | `max_cash_per_trade`, `max_term_seconds` | which new proposals are accepted | none (#215) |
| RepoDvp | `set_usdc` | USDC address | the cash token for leg 1, leg 2 and the allowances; it can be re-called, and `accept_and_settle` and `unwind` read it at call time, so a change applies to live trades | none; no tracking issue yet |
| RepoDvp | `set_cure_grace`, `set_maturity_grace` | seconds (at least 60) | how long a borrower has to cure a margin call before `default_close`, and how long an unpaid trade waits past maturity before `default_at_maturity` can act | none |
| PriceGuard | `configure_asset`, `queue_config` | bands, window, staleness | when a price is `Ok`, `Degraded` or `Halted` | tightening immediate; loosening 48h via `queue_config` |
| PriceGuard | `remove_source` | a source name | which sources the median uses | none |
| PriceGuard | `configure_source` | a source name and `enabled` | which names `publish_source` accepts and the median counts (the allowlist, #84); `issuer` is reserved for `publish_nav` | none |
| PriceGuard | `configure_source_staleness`, `queue_config` | per-source staleness window | how long a source's reading keeps counting in the median (#86) | tightening immediate; widening or clearing 48h via `queue_config` |
| PriceGuard | `configure_signature_requirement` | per-asset NAV signature on/off (#95) | whether unsigned NAV is accepted for that asset | turning it on immediate; turning it off 48h via `queue_config`, except while the asset is being brought up |
| Registry | `queue_param` | haircuts and other asset params | Registry's own asset parameters (the contracts above read their own config, not Registry's) | 48h |

The timelock column should be updated as #215 lands, along with any RepoDvp `set_usdc`
change. #103 covers the full Registry and PriceGuard timelocked-or-immediate breakdown.

The admin is trusted to choose margin thresholds, but not to choose ones that break the state
machine: `configure_asset` in `CreditLine`, `PledgeVault` and `RepoDvP` calls
`MarginThresholds::validate`, which refuses anything but
`0 < warning_bps < margin_call_bps < liquidation_bps <= 10_000`. Equal thresholds were accepted
before #78 and silently removed a state (`Warning` or `MarginCall`). Thresholds stored before that
change are not re-checked; calling `configure_asset` again is the only way to replace them.

## Admin and operational timelocks (Registry and PriceGuard)

Protocol parameter changes, role rotations, and code upgrades are governed by an explicit 48-hour timelock (`ballast_common::timelock::TIMELOCK_DELAY_SECONDS = 172_800`). However, certain emergency and onboarding operations are intentionally immediate.

The table below catalogs every admin, risk, and pauser entry point in `Registry` and `PriceGuard`, documenting caller permissions, execution delay, whether an immediate delay is intended or an open gap, and the security rationale.

### Registry admin functions

| Function | Caller | Delay | Status | Rationale |
|---|---|---|---|---|
| `initialize` | Anyone (first caller) | Immediate | Open gap | One-time bootstrap; later calls panic (`registry: already initialized`). There is **no auth check**, so whoever calls it first sets every role. Deploy and `initialize` must run back to back in the same script, and the script must read `roles` back to confirm (see Missing hardening in `AUDIT_NOTES.md`). |
| `propose_admin` | Current Admin | Immediate | Intended | Leg 1 of two-step admin transfer; sets pending admin without transferring authority until accepted. |
| `accept_admin` | Nominated Admin | Immediate | Intended | Leg 2 of two-step admin transfer; completes transfer upon recipient confirmation, preventing loss of admin access from typos. |
| `queue_role_change` | Admin | 48h timelock | Intended | Enforces 48h advance notice before changing operational role addresses (`Pauser`, `Keeper`, `PricePublisher`, `Risk`). |
| `execute_role_change` | Anyone | 48h after queue | Intended | Permissionless execution once the 48h timelock has elapsed. |
| `register_asset` | Admin | Immediate | Intended | Onboarding a new asset does not modify existing risk parameters, haircuts, or active borrower positions; users opt in to new assets. |
| `queue_param` | Admin | 48h timelock | Intended | Changes one `ParamChange` variant: `HaircutBaseBps`, `HaircutFxBps`, `PriceBandBps`, `DailyMoveBandBps`, `RedemptionLagDays` or `Status`. These are Registry's own asset parameters; the other contracts read their own config, not Registry's. 48h notice gives operators and users time to react. |
| `cancel_param` | Admin | Immediate | Intended | Safely cancels a pending parameter change before execution if market conditions shift or an error is caught. |
| `execute_param` | Anyone | 48h after queue | Intended | Applies queued parameter changes once the 48h timelock has elapsed. |
| `raise_haircut_now` | Risk | Immediate | Intended | Emergency solvency defense: if an RWA depegs or shows market stress, risk can immediately raise haircuts (tighten risk) to protect the protocol. Can only increase, never decrease. |
| `pause` | Pauser | Immediate | Intended / Open gap (#210) | Immediate by design, so an incident can be stopped at once. But it sets only Registry's own flag: no other contract reads Registry's pause storage, so it does not freeze draws, pledges, exits or repos today. ExitDesk and RepoDvp have their own `pause`; CreditLine and PledgeVault have none (#210). |
| `queue_unpause` | Admin | 48h timelock | Intended | Resuming protocol operations after an incident requires 48h notice so users can review the post-incident state before normal activity resumes. |
| `cancel_unpause` | Admin | Immediate | Intended | Cancels a queued unpause if investigation reveals an ongoing vulnerability. |
| `execute_unpause` | Anyone | 48h after queue | Intended | Unpauses the target scope once the 48h timelock has elapsed. |
| `queue_upgrade` | Admin | 48h timelock | Intended | In-place WASM bytecode upgrade changes contract logic; 48h delay provides an opt-out window for capital providers. |
| `cancel_upgrade` | Admin | Immediate | Intended | Safely aborts a proposed contract upgrade during the review delay. |
| `execute_upgrade` | Anyone | 48h after queue | Intended | Deploys new WASM bytecode once the 48h delay has elapsed. |

### PriceGuard admin functions

| Function | Caller | Delay | Status | Rationale |
|---|---|---|---|---|
| `initialize` | Anyone (first caller) | Immediate | Open gap | One-time bootstrap; later calls panic (`price-guard: already initialized`). There is **no auth check**, so whoever calls it first becomes admin. Deploy and `initialize` must run back to back, and the deploy script must read the roles back to confirm. |
| `propose_admin` | Current Admin | Immediate | Intended | Two-step admin transfer nomination without immediate privilege transfer. |
| `accept_admin` | Nominated Admin | Immediate | Intended | Finalizes admin role transfer upon explicit recipient confirmation. |
| `queue_role_change` | Admin | 48h timelock | Intended | 48h delay before changing operational roles (`Pauser`, `Keeper`, `PricePublisher`, `Risk`). |
| `execute_role_change` | Anyone | 48h after queue | Intended | Permissionless execution after the 48h delay has elapsed. |
| `queue_upgrade` | Admin | 48h timelock | Intended | In-place bytecode upgrades change pricing and circuit breaker logic; requires 48h notice. |
| `cancel_upgrade` | Admin | Immediate | Intended | Aborts a proposed contract bytecode upgrade. |
| `execute_upgrade` | Anyone | 48h after queue | Intended | Applies bytecode upgrade after the 48h delay has elapsed. |
| `configure_asset` | Admin | Dynamic | Intended | Initial asset onboarding and tightening safety bands (narrower price band, shorter max staleness) take effect immediately to enhance security. Loosening bands requires 48h timelock via `queue_config` to prevent stealth weakening of outlier defenses. |
| `configure_issuer_key` | Admin | Dynamic | Intended | Initial attestor key registration is immediate for onboarding. Rotating an existing attestor key requires 48h timelock via `queue_config` to prevent immediate hijacking of the NAV signer. |
| `configure_signature_requirement` | Admin | Dynamic | Intended | Per asset since #95 (`configure_signature_requirement(admin, asset, required)`), so one transaction cannot switch checks off for every asset; an asset never configured defaults to `true`. Requiring signatures (`required = true`) takes effect immediately. Turning a requirement off relaxes security and must go through the 48h timelock via `queue_config(RequireNavSignature(asset, false))`. Exception: while an asset is being brought up (flag never set and no reading published yet), `required = false` applies immediately. |
| `configure_source` | Admin | Immediate | Intended | Source allowlist (#84): `publish_source` rejects any name not enabled for the asset, so one feed cannot be counted twice under two spellings. Enabling or disabling a name applies at once and re-evaluates the price; `issuer` is reserved for `publish_nav`. |
| `remove_source` | Admin | Immediate | Intended | Drops a source's reading, its allowlist entry and any staleness override at once, so an exploited, manipulated or failing feed stops counting in the median immediately. |
| `configure_source_staleness` | Admin | Dynamic | Intended | Per-source staleness window (#86). Tightening (a positive window no larger than the source's current one) applies immediately. Widening a window or clearing an override keeps old readings counting for longer, so it requires the 48h timelock via `queue_config(SourceMaxStaleness)`. |
| `queue_config` | Admin | 48h timelock | Intended | Queues loosening configuration changes (`Asset` and its fields, `IssuerPubKey`, `RequireNavSignature`, `SourceMaxStaleness`) with 48h delay. |
| `cancel_config` | Admin | Immediate | Intended | Safely cancels an unexecuted queued config change. |
| `execute_config` | Anyone | 48h after queue | Intended | Applies queued loosening configurations once the 48h delay has elapsed. |
| `confirm_halt_cleared` | Risk | Immediate | Intended / Open Gap (#807) | Circuit breaker unlatch. When a large price jump trips the circuit breaker, the price locks at `LastGood`. Once human risk operators verify off-chain conditions, unlatching must be immediate to restore trading. Open issue [#807](https://github.com/DevTobis/ballast/issues/807) tracks missing validations when asset is not halted or not configured. |

### Related open gaps in other protocol contracts
- `ExitDesk.configure_asset`: since #214, a new `price_guard`, a lower spread or a higher cap must go through `queue_configure_asset` (48h); tightening and an asset's first listing stay immediate.
- `RepoDvP.configure_asset`: Currently immediate for all changes; open issue [#215](https://github.com/DevTobis/ballast/issues/215) tracks placing margin and haircut loosening behind the 48h timelock.
## Registry

- **Holds no funds.** Registry stores role addresses, per-asset `AssetConfig`s and timelocked pending
  changes; settlements read their own local config copy or the PriceGuard, never a Registry balance
  (`contracts/registry/src/lib.rs:9`).
- **`register_asset` is admin-only and not timelocked** (`contracts/registry/src/lib.rs:132`):
  onboarding a *new* asset carries no existing positions to protect. It is not unvalidated — the
  config goes through `AssetConfig::validate` before it is stored
  (`contracts/registry/src/lib.rs:140`) — and a duplicate asset is refused
  (`contracts/registry/src/lib.rs:136`).
- **Pending changes live in persistent storage, not temporary.** `queue_param`
  (`contracts/registry/src/lib.rs:160`) and `queue_unpause` (`contracts/registry/src/lib.rs:301`)
  write `DataKey::PendingParam` / `PendingUnpause` entries and extend their TTL to cover the 48h delay
  plus a 7-day grace window (`TIMELOCK_EXTEND_TTL_LEDGERS`, `contracts/common/src/timelock.rs:23`). An
  entry left unexecuted past that window expires under Soroban state archival unless refreshed or
  cancelled; `cancel_param` / `cancel_unpause` (admin-only) remove it early
  (`contracts/registry/src/lib.rs:203`, `contracts/registry/src/lib.rs:323`).
- **Execution is permissionless, queueing is not.** `execute_param`
  (`contracts/registry/src/lib.rs:220`) and `execute_unpause` (`contracts/registry/src/lib.rs:338`)
  may be called by anyone once `executes_at` has passed; only the admin may queue or cancel.
  Executing deletes the entry, so an id cannot be replayed.
- **`raise_haircut_now` is the risk role's immediate, increase-only brake**
  (`contracts/registry/src/lib.rs:265`). It overflow-checks the base increase and caps the *combined*
  base + FX haircut at 10,000 bps (`contracts/registry/src/lib.rs:275`); loosening risk must go
  through the timelocked `queue_param` path instead.
- **Pause is immediate, unpause is timelocked.** `pause` (pauser-only,
  `contracts/registry/src/lib.rs:288`) sets a scope flag with no delay; lifting it goes through
  `queue_unpause` / `execute_unpause` (48h). `All` is a stored flag of its own
  (`PauseDataKey::Paused(All)`, written by `set_paused`), and `is_paused` checks it before the
  scope's own flag (`contracts/common/src/pause.rs:62-75`).
- **Registry's pause flags and asset parameters are not read at runtime by the other contracts.**
  Each contract keeps an admin-configured local copy of its asset config (`configure_asset`) and
  reads pause flags from its *own* instance storage; `Registry::pause` writes only Registry's
  (`contracts/registry/src/lib.rs:292`). `exit-desk` and `repo-dvp` expose their own pause/unpause
  (`contracts/exit-desk/src/lib.rs:433`, `contracts/repo-dvp/src/lib.rs:612`), but `credit-line` and
  `pledge-vault` only read their flag (`contracts/credit-line/src/lib.rs:497`,
  `contracts/pledge-vault/src/lib.rs:291`) and have no on-chain writer, so those two scopes cannot
  currently be paused on chain. Cross-contract pause reach is tracked in #210, and `repo-dvp::propose`
  is additionally not pause-gated (#846). Because configs are local copies, `credit-line` and
  `pledge-vault` can hold separate haircut/threshold values (#180).
- **Roles and pending changes are readable.** `roles()` (`contracts/registry/src/lib.rs:87`),
  `pending_admin()` (`contracts/registry/src/lib.rs:105`), `pending_role_change(id)`
  (`contracts/registry/src/lib.rs:124`) and `pending_upgrade(id)`
  (`contracts/registry/src/lib.rs:386`) expose the stored roles and outstanding timelock entries.
  Non-admin roles rotate through `queue_role_change` / `execute_role_change` (48h); the admin moves
  with the two-step `propose_admin` / `accept_admin` pair.

## ballast-common

- **Shared math and guards, no funds.** `risk`, `margin`, `pause`, `access`, `asset`, `price`,
  `timelock`, `ttl` and `upgrade` are helpers the contracts call so they cannot disagree on
  valuation, margin bands, pause semantics or role checks.
- **It trusts the caller for non-negative amounts.** `risk::collateral_value`
  (`contracts/common/src/risk.rs:13`) checks only that the haircut is <= 100%
  (`contracts/common/src/risk.rs:14`) and that the fixed-point products do not overflow
  (`contracts/common/src/risk.rs:18`); it does not reject negative `units` or `guarded_price`, so a
  negative input yields a negative collateral value (#808). `risk::ltv_bps`
  (`contracts/common/src/risk.rs:30`) floors the ratio, reading up to 1 bp healthier than reality
  (#809), and returns `u32::MAX` for zero/negative collateral against debt
  (`contracts/common/src/risk.rs:34`).
- **Thresholds are validated where they are configured, not where they are used.**
  `MarginThresholds::validate` (`contracts/common/src/margin.rs:57`) panics unless
  `0 < warning_bps < margin_call_bps < liquidation_bps <= 10_000`; `classify` trusts that the stored
  thresholds already passed it (each contract calls `validate` in `configure_asset`).
- **Pause helpers read the calling contract's own storage.** `pause::is_paused`
  (`contracts/common/src/pause.rs:69`) and `require_not_paused` (`contracts/common/src/pause.rs:90`)
  operate on the instance storage of whichever contract invokes them; `require_not_paused` panics
  with `ballast-common: paused` and is meant only for risk-adding entry points, never
  repay/cure/liquidate (invariant 5).
- **Role checks panic on mismatch.** `access::require_admin` / `require_pauser` / `require_risk`
  (`contracts/common/src/access.rs:73`, `contracts/common/src/access.rs:81`,
  `contracts/common/src/access.rs:99`) return the stored address or panic; roles live in instance
  storage (`access::write_roles`, `contracts/common/src/access.rs:57`).
- **Every guard is a panic, and a panic traps.** The `assert!` / `expect!` / `panic!` paths above
  abort the whole Soroban transaction — no partial state is committed — rather than returning a
  recoverable error. The 48h delay and 7-day grace constants live in `timelock`
  (`contracts/common/src/timelock.rs:8`, `contracts/common/src/timelock.rs:17`); callers assert
  `is_ready` and panic on a missing pending entry.

## PriceGuard

- The guarded price is the median of fresh sources. Fewer than two fresh sources is `Degraded`;
  disagreement beyond `band_bps` is `Degraded`; a move beyond `daily_move_band_bps` against the last
  good value is a sticky `Halted` that only `risk` clears. The on-call procedure for a halt —
  detection, independent-source checks, the `risk`-signed `confirm_halt_cleared` command,
  verification and escalation — is [`docs/runbooks/price-halt.md`](../docs/runbooks/price-halt.md).
  Confirming promotes the value that tripped the halt, so re-check it has not reverted first.
- **`LastGood` carries its own timestamp.** `DataKey::LastGood` stores `LastGood { value, ts }`.
  When `guarded_price` returns `Ok`, `GuardedPrice::ts` is the current evaluation timestamp (`now`);
  when it returns `Degraded` or `Halted`, `GuardedPrice::ts` is `last_good.ts` (`0` if there was no
  prior good price or if `LastGood` was read from a pre-upgrade bare `i128` entry before the next
  `Ok` evaluation or `confirm_halt_cleared`), so callers and monitors can tell how old the held
  fallback price is.
- **A rolling reference bounds slow drift over a window.** `daily_move_band_bps` only compares a
  publish against the immediately preceding one, so a publisher (or a bug) moving the price a little
  on every publish could walk it anywhere over an hour without ever tripping a single-step check. The
  contract also keeps a `RollingReference` per asset, refreshed at most once per `window_seconds`
  (default 24h), and halts when the median differs from it by more than `window_move_band_bps`. Both
  are per-asset settings on `configure_asset`. The defaults (24h, 100 bp) leave ordinary yield drift,
  a few bp per day, well inside the band while still catching a ramp of the kind described here.
- **The guard is evaluated and persisted on every publish**, not only when something reads it. A
  Soroban read is a simulation and stores nothing, so evaluating only on reads meant the halt latch
  and the `LastGood` baseline moved only when an unrelated transaction happened to call
  `guarded_price`: the baseline went days stale and ordinary yield drift eventually looked like a
  jump. Now each publish re-runs the rules, so a jump latches at once and the baseline follows slow
  drift. Consequence: `daily_move_band_bps` bounds the change **between consecutive evaluations**
  (minutes apart with the default publisher), a stricter reading than "per day". After a long outage
  a real move larger than the band halts on the first publish and needs `confirm_halt_cleared`.
- A reading is rejected at publish if its price is not positive or its timestamp is more than
  `MAX_FUTURE_SKEW_S` (60s) ahead of the ledger, and a future-dated reading is never "fresh". Before
  this, `now.saturating_sub(observed_at)` made any future timestamp look zero seconds old, so a unit
  mix-up (milliseconds for seconds) or a skewed clock could pin a value as current indefinitely.
- NAV is signed by the **price publisher's** key (`configure_issuer_key` registers it), because
  issuers publish unsigned data. The attestor key is the same key that is authorised to publish, so
  on-chain the signature adds no protection against a compromised publisher: it records who relayed
  the value. Do not describe it as issuer attestation.
- **The NAV signature requirement is per asset** (`DataKey::RequireNavSignature(asset)`, `true`
  when unset). Turning it off for one asset leaves the others checked. Turning it on is immediate;
  turning it off is immediate only during an asset's bring-up (no flag stored and no reading ever
  published for it), and otherwise must go through `queue_config` and the 48h timelock. The deploy
  scripts set it to `true` explicitly for every asset they configure.
- **Per-asset state is in persistent storage**, one entry per key with its TTL extended on every
  read and write; the instance entry holds only the roles, a pending admin transfer and the
  timelock id counter, so it does not grow with the asset count. This moved the keys out of
  instance storage and **requires a fresh PriceGuard deploy**: an in-place `execute_upgrade` would
  leave every asset unconfigured and, once reconfigured, without its `LastGood` baseline, `Halted`
  latch or issuer key. See `contracts/README.md`.
- Roles rotate in place: `price_publisher` and the other non-admin roles go through
  `queue_role_change` / `execute_role_change` (48h), while the admin moves with the two-step
  `propose_admin` / `accept_admin` pair. A publisher rotation preserves `LastGood`, a `Halted` latch,
  asset configs and issuer keys; it does not automatically re-register the NAV attestor key, so
  `configure_issuer_key` must be called too when the publisher is the attestor.
- `max_staleness_s` is per asset; RedStone's RWA feeds update every 1-2 hours, so values under that
  make the guard refuse to lend.

## CreditLine

- **Liquidation is in kind.** `liquidate` flips the line to `Liquidating` and *freezes* the seized
  units (the whole synced position), the confirmed guarded price and the debt in a
  `LiquidationRecord`. The keeper then moves the collateral to the lender with
  `PledgeVault::liquidate`. `close_liquidated` verifies cross-contract that collateral has actually
  left the vault (`PledgeVault::position_units(line, asset) == 0`) before permitting the line to
  close. If no vault is configured, `close_liquidated` refuses if any collateral was pledged or
  seized (`record.seized_units > 0 || state.pledged_units > 0`), and succeeds only for uncollateralized
  lines with zero seized units.
- **`close_liquidated`** (lender-signed) verifies that collateral has cleared the vault, values the
  collateral at the *frozen* price with no haircut, pays any surplus from the lender's USDC to the
  borrower in the same call, records any shortfall, writes unrecovered principal off `funded` and
  closes the line. The lender cannot choose the price, understate the collateral, or close while
  collateral remains in the vault, but **can choose when to close**; until they do the line stays
  `Liquidating` and the borrower's surplus is not paid. There is no borrower-side or keeper-side close of a *liquidated* line. A fully repaid `Open` line
  (no principal, interest, fee or funding left) can be closed by its lender or borrower with
  `close`; `close` refuses a `Liquidating` line, so it cannot bypass `close_liquidated` (#130).
- **Lender withdrawals** exist because without them repaid principal and interest were locked in
  the contract. `withdraw_undrawn` returns committed USDC that is not out on loan (reducing
  `funded`); `withdraw_interest` returns repaid interest, tracked separately in `Claimable(line)`.
  Both are lender-only and not pause-gated.
- **Platform fees & invariant 6 (`fee_bps`)**: `open` takes `fee_bps <= 10_000` (simple
  non-compounding annual rate on `drawn`, included in `debt_of` and LTV). `repay` allocates
  `fee -> interest -> principal`; repaid fees accumulate in `FeeClaimable(line)` and can only be
  withdrawn by the configured `Treasury` address via `claim_fee` (not pause-gated). On
  liquidation, unpaid platform fees are left out of `LiquidationRecord.debt` and waived in
  `close_liquidated` so the lender never pockets protocol fees or shrinks the borrower's surplus
  (any fees already repaid before liquidation remain in `FeeClaimable`). Adding `fee_bps` and
  `accrued_fee` changes the `Line` storage layout and requires a fresh contract redeploy.
- `draw` enforces `limit` (it previously only checked `funded`). `fund` is refused on a closed line.
- Interest is simple, non-compounding, accrued on principal per second.
- **Collateral is reported by the vault, in the same transaction.** `PledgeVault` calls
  `sync_from_vault` (vault-only, for the line's own collateral asset) after every pledge, release,
  lien confirmation and liquidation. Before this the figure changed only when the keeper's
  `sync_collateral` ran, so a borrower could `release` and then `draw` against units that had just
  left, in the window before the next sync, leaving the lender funding against collateral that was
  gone. `sync_collateral` remains as a keeper/admin reconciliation path and now sets the vault's own
  balance (the keeper job reads it from the vault, never from Postgres).
- **`sync_collateral` takes its figure from the caller.** The keeper (or admin) supplies `units`
  and the contract writes it straight into the line's `pledged_units` with only a `units >= 0`
  check — it does not verify the figure against the vault's actual balance. The vault-driven
  `sync_from_vault` path does carry the vault's real balance (vault-authenticated), but the keeper
  path's match to reality is enforced by the off-chain keeper job, not on-chain. See
  "Keeper-supplied values" above; the auth/validation tests are tracked in #162, and the
  oversized-figure risk in #815.

## PledgeVault

- `pledge` requires the line's own borrower and collateral asset, and refuses to take units in a
  different custody mode than the position already holds (`release` moves tokens or not according to
  the mode recorded on the position, so flipping it under live units would strand them).
- `release` cross-calls `CreditLine::debt_of` and `borrower_of`; it only cross-calls `CreditLine::ltv` (and the price guard) when the line still owes something — with zero debt there is no price or LTV check, so a degraded or halted price cannot trap collateral (#182). Ownership is checked there.
- `liquidate` has no LTV check by design: it is the liquidation path, keeper-gated. Its safety
  depends on `CreditLine::liquidate` having confirmed the breach first, enforced off-chain by the
  keeper job, not on-chain.
- `configure_asset` refuses a `haircut_bps` above 10,000 (`risk::validate_haircut_bps`) as well as
  thresholds that `MarginThresholds::validate` rejects. A haircut above 100% used to be stored, and
  every `release` against debt then panicked when it valued the remaining collateral.
  `CreditLine::configure_asset` runs the same two checks, so the two contracts cannot disagree
  about which configs are usable.
- **Pending lien cancellations and rejections:** Unconfirmed pending units in lien modes (`IssuerLien` / `CustodianLien`) can be cancelled by the borrower via `cancel_pending` (borrower-signed) or rejected by the gateway via `reject_lien` (gateway-signed, with reason). Both only decrement `pending_lien_units` and never affect counted `position.units` or move tokens.
- **Vault `liquidate` takes its amount and recipient from the keeper.** `units` and `to` are
  supplied by the caller; on-chain they are checked only against `units > 0` and
  `units <= position.units`. Nothing on-chain verifies that `units` equals the frozen
  `LiquidationRecord.seized_units` or that `to` is the lender — that match is enforced by the
  off-chain keeper job. See "Keeper-supplied values" above.

## ExitDesk

- `configure_asset` applies at once only for the first listing of an asset, or for changes that
  cannot raise payouts (same `price_guard`, spread not lower, caps not higher). A new `price_guard`,
  a lower spread or a higher cap must be queued with `queue_configure_asset` and executed after the
  48h timelock (`ballast_common::timelock`). The admin can cancel it in the meantime. The first
  listing is still immediate, so a compromised admin could list a new asset with a hostile
  `price_guard` against the shared float; that path is not timelocked.
- The desk's USDC float and the RWA inventory it accumulates from exits have an admin-only `withdraw`.
  Without it the inventory only ever grew toward `desk_inventory_cap` and the desk eventually refused
  every exit, with no way to rebalance. Withdrawing an RWA frees the same amount under its cap. This is
  the desk's own balance: an exit is a single atomic swap, so no holder's funds are ever in the
  contract between transactions.
- Quotes are the guarded price less the spread, rounded down (in the desk's favour), and refuse any
  price that is not `Ok`.
- `exit` compares the desk's own USDC balance with the payout before it takes the holder's RWA, and
  refuses with `exit-desk: insufficient USDC float` when the balance is smaller. This is for a
  readable error, not for safety: the swap was already atomic, and a short float used to fail in the
  USDC token's own transfer. `available_usdc` is the same balance as a free read; like a quote, it
  can be out of date by the time an exit lands.
- **Storage lifetime.** Every entry point extends the instance (asset configs, the USDC address,
  roles and pause flags) to about 30 days, and every write of an asset's `Inventory` extends that
  entry to about 30 days. `extend_ttl(asset)` is a permissionless keep-alive for a desk that sees no
  traffic for longer. Before this nothing was extended, so an idle desk's instance or inventory
  could be archived and `exit` and `withdraw` fail until someone restored it (#208).
- **The per-holder daily counter is temporary storage.** `DailyUsed(holder, asset, day)` is only
  read for the current UTC day, so it lives in temporary storage with about 2 days of ledgers from
  its last write and then expires. It used to be persistent, which left one entry per holder, asset
  and day on the ledger for good. The 2 days assume ledgers close in about 5 seconds; if they closed
  at under half that, an entry written early in a day could expire before the day ended and that
  holder's cap would reset early.

## RepoDvP

- **Admin `set_usdc` applies to live trades.** The cash token is read from instance storage each
  time `accept_and_settle` and `unwind` run, not stored on the trade, and `set_usdc` can be called
  again at any time. If it changes after a trade settles, `unwind` pays leg 2 in the new token,
  while the leg-2 allowance the borrower granted at settlement is in the old one. See
  [Admin-set parameters that change settlement value](#admin-set-parameters-that-change-settlement-value).
- Cash legs are not escrowed; each is pre-authorised with a token allowance granted in the call the
  paying party signs (see the module docs). One live proposal per (lender, token): a second
  `propose` replaces the first one's allowance.
- **Terms.** `propose` holds a trade's term, counted from the proposal to `maturity_at`, to its
  `kind`: 24h for intraday, 48h for overnight, 30 days for term and for open. It also refuses a
  `rate_bps` above 10,000 (100% a year). Both are checked before the lender's allowance is granted.
  An open repo still carries a `maturity_at`, the date it must be unwound by; calling it earlier is
  not implemented, so on chain an open repo behaves like a term repo of up to 30 days.
- **Margin.** `call_margin` opens a call at `MarginCall` or worse, never moves an open call's
  deadline, and clears the call when the position is back under the band. `top_up` (borrower)
  adds collateral and clears the call in the same transaction if that is enough; it is not
  pause-gated. `margin_view` is a free read. Accrued interest in `evaluate_margin` is capped at
  `maturity_at`, ensuring post-maturity exposure matches what `unwind` collects and what `default_close` covers (#218).
- **Default.** `default_close` is keeper-only, needs the cure window to have passed, re-evaluates
  the position and refuses a cured one. The lender receives `ceil(exposure / price)` units at the
  guarded price with no haircut, capped at the pledge; any remainder returns to the borrower. If the
  collateral is worth less than the exposure the lender takes all of it and bears the shortfall.
  No USDC moves on default.
- Yield on the pledged RWA during the term is not passed through.
- **Storage lifetime.** Every entry point extends the contract instance. Every write of a trade
  extends that trade's entry, and the instance with it, to outlast `maturity_at` plus the unwind
  grace, and never to less than about 30 days. The borrower's outstanding leg-2 sum is extended to
  outlast the allowance it describes. Before this only the pause calls extended anything, so a
  trade lived for the network's minimum persistent TTL from its last write: about 7 days on testnet
  and about 120 on mainnet (their state-archival settings on 2026-11-22). `extend_ttl` is a
  permissionless keep-alive for a trade longer than one extension can reach (about 180 days).

## Known limits

- **Emergency pause wiring across contracts.** There is no central pause: each contract reads
  pause flags from its own instance storage, and `Registry::pause` writes only Registry's, which no
  other contract reads. ExitDesk (`pause`, #30) and RepoDvp (`pause`, #32) can each be paused
  directly, with a timelocked unpause, so an emergency stop means calling `pause` on each of them
  separately. CreditLine (`Draws`) and PledgeVault (`Pledges`) have no `pause` entry point at all,
  so those two scopes can never be set on a deployment (#210).
  - [ ] Follow-up: update this note once CreditLine and PledgeVault get a pause writer or a central
    pause lands.
- Real RWAs cannot be held by these contracts unless the issuer allows it (`AUTH_REQUIRED`
  issuers must authorise the vault's trustline). Etherfuse's issuer sets `auth_revocable` and
  `clawback_enabled`, so it can freeze or claw back tokens held in the vault; price that in.
- Events use `env.events().publish`, which soroban-sdk deprecates in favour of `#[contractevent]`;
  moving changes the encoding and needs the indexer and ledger readers updated together.
- No contract has been audited. `cargo test` covers the unit tests in each crate; the end-to-end
  scripts in `scripts/` exercise them on testnet.

## PRD Invariants Traceability (RepoDvP & ExitDesk)

Traceability matrix mapping core PRD invariants (§8) to unit and integration test coverage across `RepoDvP` and `ExitDesk`.

| Invariant | Description | Contract | Status | Covering Test(s) / Gap Issue |
|---|---|---|---|---|
| **2** | No draws/exits/repos on a bad price (must be `Ok`) | `ExitDesk` | Covered | `test::exit_panics_on_degraded_price`<br>`test::exit_panics_on_halted_price` |
| **2** | No draws/exits/repos on a bad price (must be `Ok`) | `RepoDvP` | NOT COVERED | Gap: `propose` and `accept_and_settle` never read `PriceGuard` (see [#1278](https://github.com/DevTobis/ballast/issues/1278)) |
| **5** | Pausing cannot move funds; blocks new risk only | `ExitDesk` | Covered | `test::pauser_can_pause_exits_and_exit_panics_while_quote_and_withdraw_work`<br>`test::pauser_can_pause_all_and_exit_panics_while_quote_and_withdraw_work` |
| **5** | Pausing cannot move funds; blocks new risk only | `RepoDvP` | Covered | `test::sac::pausing_repos_stops_accept_and_settle`<br>`test::sac::pausing_all_stops_accept_and_settle_too`<br>`test::sac::unwind_still_works_while_paused`<br>`test::sac::margin_cure_and_default_paths_still_work_while_paused`<br>`test::sac::default_close_still_works_while_paused` |
| **6** | Admin cannot move user funds | `ExitDesk` | Partial | By design the admin **can** withdraw the desk's own USDC float and RWA inventory (`test::the_admin_can_take_the_usdc_float_back_out`, `test::withdrawing_rwa_inventory_frees_room_under_the_inventory_cap`); `test::only_the_admin_can_withdraw` shows nobody else can. This exception is documented under [Admin-set parameters that change settlement value](#admin-set-parameters-that-change-settlement-value) (#209). Holder funds never sit in the desk between calls, since `exit` is atomic. |
| **6** | Admin cannot move user funds | `RepoDvP` | NOT COVERED | Gap: No admin fund sweep function exists, but no explicit negative unit test asserts immobility of pledged user funds against admin keys (see [#1279](https://github.com/DevTobis/ballast/issues/1279)) |
| **7** | Repo / swap legs are atomic (both settle or neither) | `ExitDesk` | Covered | `test::exit_happy_path_settles_both_legs`<br>`test::an_exit_refused_for_a_short_float_changes_nothing`<br>`test::exit_panics_when_the_float_is_one_stroop_short_of_the_payout` |
| **7** | Repo / swap legs are atomic (both settle or neither) | `RepoDvP` | Covered | `test::accept_and_settle_reverts_atomically_on_insufficient_cash` |
| **8** | Issuer controls stay intact (unauthorized recipient reverts) | `ExitDesk` | NOT COVERED | Gap: In-crate unit tests use mock tokens without Stellar Asset Contract (SAC) `AUTH_REQUIRED` verification (see [#1280](https://github.com/DevTobis/ballast/issues/1280)) |
| **8** | Issuer controls stay intact (unauthorized recipient reverts) | `RepoDvP` | NOT COVERED | Gap: In-crate unit tests use mock tokens without SAC authorization revocation checks (see [#1280](https://github.com/DevTobis/ballast/issues/1280)) |
### Missing hardening

Each item below is a gap in the current code, not a finding about exploitability. Remove a bullet
when its fix lands (#175).

- **`initialize` is open to the first caller.** No contract checks who calls `initialize`, and
  deploy and `initialize` are separate transactions, so whoever initializes first sets every role;
  the deploy scripts detect this only by reading `roles` back afterwards. No tracking issue yet.
- **No upgrade path outside Registry and PriceGuard.** CreditLine, PledgeVault, ExitDesk and
  RepoDvp have no upgrade entry point, so a fix to any of them means a new deployment and moving
  live state across. RepoDvp and ExitDesk are tracked in #837; CreditLine and PledgeVault have no
  tracking issue yet.
- **No role setter outside Registry and PriceGuard.** CreditLine, PledgeVault, ExitDesk and
  RepoDvp fix their admin and other roles at `initialize` and expose no rotation, so a lost or
  compromised role key can only be replaced by redeploying. Registry and PriceGuard rotate roles
  through #93 and #94. No tracking issue yet for the other four.
- **CreditLine and PledgeVault pause flags have no writer.** `draw` and `pledge` check flags in
  their own contract's storage, but `pause::set_paused` is reached only through `Registry::pause`,
  which writes Registry's storage, so those scopes cannot be set on a deployment. ExitDesk and
  RepoDvp now have their own `pause` (#30, #32). Tracked in #210.

## close_liquidated: dust pledged after liquidation

`CreditLine::close_liquidated` calls `PledgeVault::position_units` cross-contract and panics
(`"credit-line: collateral has not left the vault"`) if the result is non-zero.  This means that
any collateral dust pledged to the vault **after** `liquidate` has flipped the line to `Liquidating`
(e.g. a keeper or borrower pledges a hairline amount) will block `close_liquidated` until the
keeper sweeps all units out of the vault.  Lenders should be aware that the keeper must drain the
vault position to zero before the line can be closed.
