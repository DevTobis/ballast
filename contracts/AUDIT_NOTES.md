# Notes for an auditor

What the contracts assume, what they trust, and where they are deliberately simple. Written from the
code as it stands; read it alongside the module docs at the top of each `lib.rs`.

## Roles and trust

| Role | Can | Cannot |
|---|---|---|
| `admin` | configure assets, thresholds, price bands; set the NAV attestor key | move any user's funds (no `admin_withdraw`/sweep anywhere); sign for a borrower or lender |
| `pauser` | pause draws/pledges/exits by scope | pause repayment, release or withdrawal paths (invariant 5) |
| `keeper` | `sync_collateral`, `liquidate`, vault `liquidate`, repo `call_margin`/`default_close`, `poke` | choose a price; liquidate without a confirmed breach on a later ledger |
| `price_publisher` | publish NAV (signature-checked) and feed readings | set the guarded price; clear a halt |
| `risk` | `confirm_halt_cleared` | publish prices |

### Admin function delays

PRD §6.2 promises a 48-hour timelock on parameter changes. The actual delay depends on the
contract:

**Registry**

| Function | Delay | Notes |
|---|---|---|
| `register_asset` | immediate | New asset only; no existing positions to protect |
| `queue_param` / `execute_param` | **48h timelock** | Changes to an existing asset's haircut/band/other params |
| `cancel_param` | immediate | Removes a pending queued change before it executes |
| `queue_role_change` / `execute_role_change` | **48h timelock** | Rotates `pauser`, `keeper`, `price_publisher`, or `risk` |
| `propose_admin` / `accept_admin` | no delay (two-step) | Admin key transfer; requires both current and new admin to sign; no timelock |

**PriceGuard**

| Function | Delay | Notes |
|---|---|---|
| `configure_asset` | **immediate** | Sets band, daily-move, window, and staleness thresholds — gap vs. PRD §6.2; see Known limits |
| `configure_issuer_key` | **immediate** | Registers the Ed25519 public key used to verify NAV signatures — gap vs. PRD §6.2 |
| `configure_signature_requirement` | **immediate** | Toggles NAV signature enforcement globally — gap vs. PRD §6.2 |
| `queue_role_change` / `execute_role_change` | **48h timelock** | Rotates `price_publisher`, `pauser`, `keeper`, or `risk` |
| `propose_admin` / `accept_admin` | no delay (two-step) | Admin key transfer; requires both current and new admin to sign; no timelock |

The keeper is trusted for **timing and completeness**, not for **value**: every amount a settlement
uses comes from the contract's own state or from the PriceGuard, never from a keeper-supplied number.

## PriceGuard

- The guarded price is the median of fresh sources. Fewer than two fresh sources is `Degraded`;
  disagreement beyond `band_bps` is `Degraded`; a move beyond `daily_move_band_bps` against the last
  good value is a sticky `Halted` that only `risk` clears.
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
- Roles rotate in place: `price_publisher` and the other non-admin roles go through
  `queue_role_change` / `execute_role_change` (48h), while the admin moves with the two-step
  `propose_admin` / `accept_admin` pair. A publisher rotation preserves `LastGood`, a `Halted` latch,
  asset configs and issuer keys; it does not automatically re-register the NAV attestor key, so
  `configure_issuer_key` must be called too when the publisher is the attestor.
- **Admin key has no rotation delay.** The `propose_admin` / `accept_admin` handshake is a
  safety guard against typos — it requires the named successor to accept — but it carries no
  timelock. A compromised admin key can be replaced immediately with no notice period. Non-admin
  roles (`price_publisher`, `pauser`, `keeper`, `risk`) do have the 48h queue before the new
  address takes effect.
- `max_staleness_s` is per asset; RedStone's RWA feeds update every 1-2 hours, so values under that
  make the guard refuse to lend.

## CreditLine

- **Liquidation is in kind.** `liquidate` flips the line to `Liquidating` and *freezes* the seized
  units (the whole synced position), the confirmed guarded price and the debt in a
  `LiquidationRecord`. The keeper then moves the collateral to the lender with
  `PledgeVault::liquidate`. These are two transactions by a trusted keeper; the contracts do not
  link them. The keeper job refuses to liquidate while booked and on-chain pledged units differ
  (`sync_collateral` lag), so the units it seizes equal the units the record uses.
- **`close_liquidated`** (lender-signed) values the collateral at the *frozen* price with no
  haircut, pays any surplus from the lender's USDC to the borrower in the same call, records any
  shortfall, writes unrecovered principal off `funded` and closes the line. The lender cannot
  choose the price or understate the collateral, but **can choose when to close**; until they do
  the line stays `Liquidating` and the borrower's surplus is not paid. There is no borrower-side
  or keeper-side close.
- **Lender withdrawals** exist because without them repaid principal and interest were locked in
  the contract. `withdraw_undrawn` returns committed USDC that is not out on loan (reducing
  `funded`); `withdraw_interest` returns repaid interest, tracked separately in `Claimable(line)`.
  Both are lender-only and not pause-gated.
- `draw` enforces `limit` (it previously only checked `funded`). `fund` is refused on a closed line.
- Interest is simple, non-compounding, accrued on principal per second.
- **Collateral is reported by the vault, in the same transaction.** `PledgeVault` calls
  `sync_from_vault` (vault-only, for the line's own collateral asset) after every pledge, release,
  lien confirmation and liquidation. Before this the figure changed only when the keeper's
  `sync_collateral` ran, so a borrower could `release` and then `draw` against units that had just
  left, in the window before the next sync, leaving the lender funding against collateral that was
  gone. `sync_collateral` remains as a keeper/admin reconciliation path and now sets the vault's own
  balance (the keeper job reads it from the vault, never from Postgres).

## PledgeVault

- `pledge` requires the line's own borrower and collateral asset, and refuses to take units in a
  different custody mode than the position already holds (`release` moves tokens or not according to
  the mode recorded on the position, so flipping it under live units would strand them).
- `release` cross-calls `CreditLine::ltv` and `borrower_of`; ownership is checked there.
- `liquidate` has no LTV check by design: it is the liquidation path, keeper-gated. Its safety
  depends on `CreditLine::liquidate` having confirmed the breach first, enforced off-chain by the
  keeper job, not on-chain.

## ExitDesk

- The desk's USDC float and the RWA inventory it accumulates from exits have an admin-only `withdraw`.
  Without it the inventory only ever grew toward `desk_inventory_cap` and the desk eventually refused
  every exit, with no way to rebalance. Withdrawing an RWA frees the same amount under its cap. This is
  the desk's own balance: an exit is a single atomic swap, so no holder's funds are ever in the
  contract between transactions.
- Quotes are the guarded price less the spread, rounded down (in the desk's favour), and refuse any
  price that is not `Ok`.

## RepoDvP

- Cash legs are not escrowed; each is pre-authorised with a token allowance granted in the call the
  paying party signs (see the module docs). One live proposal per (lender, token): a second
  `propose` replaces the first one's allowance.
- **Borrower leg-2 allowance is additive.** A SEP-41 `approve` replaces the (owner, spender)
  allowance, and a borrower may hold several settled trades, so `accept_and_settle` approves the
  sum of the borrower's outstanding leg-2 due ceilings (tracked in contract storage, added on
  settle, released on `unwind`/`default_close`), with the expiry never shortened below what an
  earlier trade still needs. Consequences an auditor should know: each ceiling is sized at
  `proposed_at`, so a trade settled later than proposed leaves a small unconsumed residue in the
  live allowance until the next settle re-approves the accurate sum or the allowance expires; a
  defaulted trade's whole unconsumed share behaves the same way, because shrinking the live
  allowance would need the borrower's own signature.
- **Margin.** `call_margin` opens a call at `MarginCall` or worse, never moves an open call's
  deadline, and clears the call when the position is back under the band. `top_up` (borrower)
  adds collateral and clears the call in the same transaction if that is enough; it is not
  pause-gated. `margin_view` is a free read.
- **Default.** `default_close` is keeper-only, needs the cure window to have passed, re-evaluates
  the position and refuses a cured one. The lender receives `ceil(exposure / price)` units at the
  guarded price with no haircut, capped at the pledge; any remainder returns to the borrower. If the
  collateral is worth less than the exposure the lender takes all of it and bears the shortfall.
  No USDC moves on default.
- Yield on the pledged RWA during the term is not passed through.

## Known limits

- Real RWAs cannot be held by these contracts unless the issuer allows it (`AUTH_REQUIRED`
  issuers must authorise the vault's trustline). Etherfuse's issuer sets `auth_revocable` and
  `clawback_enabled`, so it can freeze or claw back tokens held in the vault; price that in.
- Events use `env.events().publish`, which soroban-sdk deprecates in favour of `#[contractevent]`;
  moving changes the encoding and needs the indexer and ledger readers updated together.
- No contract has been audited. `cargo test` covers the unit tests in each crate; the end-to-end
  scripts in `scripts/` exercise them on testnet.
- **PriceGuard parameter changes are immediate, not timelocked (gap vs. PRD §6.2).** `configure_asset`,
  `configure_issuer_key`, and `configure_signature_requirement` all take effect in the same
  transaction — there is no `queue_param` / `execute_param` mechanism for PriceGuard the way
  Registry has one. A compromised or mistaken admin can change band thresholds, replace the NAV
  attestor key, or disable signature verification instantly and with no on-chain notice period.
  This section should be updated and this bullet removed when a timelock is added to those
  functions.
- **Admin key rotation has no timelock.** `propose_admin` / `accept_admin` prevents accidents
  (both parties must sign) but carries no delay. A new admin is effective the moment the named
  successor calls `accept_admin`. Non-admin roles (`price_publisher`, `pauser`, `keeper`, `risk`)
  rotate through the 48h `queue_role_change` / `execute_role_change` path and do have a notice
  period. This section should be updated if a timelock is added to `accept_admin`.
