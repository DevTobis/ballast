# Notes for an auditor

What the contracts assume, what they trust, and where they are deliberately simple. Written from the
code as it stands; read it alongside the module docs at the top of each `lib.rs`.

## Roles and trust

| Role | Can | Cannot |
|---|---|---|
| `admin` | configure assets, thresholds, price bands; set the NAV attestor key | move any user's funds (no `admin_withdraw`/sweep anywhere); sign for a borrower or lender |
| `pauser` | pause draws/pledges/exits by scope | pause repayment, release or withdrawal paths (invariant 5) |
| `keeper` | `sync_collateral` (supplies `units`), `liquidate` (chooses when), vault `liquidate` (supplies `units`, `to`), repo `call_margin`/`default_close` | choose a price; liquidate without a confirmed breach on a later ledger |
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

The admin is trusted to choose margin thresholds, but not to choose ones that break the state
machine: `configure_asset` in `CreditLine`, `PledgeVault` and `RepoDvP` calls
`MarginThresholds::validate`, which refuses anything but
`0 < warning_bps < margin_call_bps < liquidation_bps <= 10_000`. Equal thresholds were accepted
before #78 and silently removed a state (`Warning` or `MarginCall`). Thresholds stored before that
change are not re-checked; calling `configure_asset` again is the only way to replace them.

## PriceGuard

- The guarded price is the median of fresh sources. Fewer than two fresh sources is `Degraded`;
  disagreement beyond `band_bps` is `Degraded`; a move beyond `daily_move_band_bps` against the last
  good value is a sticky `Halted` that only `risk` clears.
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
- **Vault `liquidate` takes its amount and recipient from the keeper.** `units` and `to` are
  supplied by the caller; on-chain they are checked only against `units > 0` and
  `units <= position.units`. Nothing on-chain verifies that `units` equals the frozen
  `LiquidationRecord.seized_units` or that `to` is the lender — that match is enforced by the
  off-chain keeper job. See "Keeper-supplied values" above.

## ExitDesk

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

## RepoDvP

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

- Real RWAs cannot be held by these contracts unless the issuer allows it (`AUTH_REQUIRED`
  issuers must authorise the vault's trustline). Etherfuse's issuer sets `auth_revocable` and
  `clawback_enabled`, so it can freeze or claw back tokens held in the vault; price that in.
- Events use `env.events().publish`, which soroban-sdk deprecates in favour of `#[contractevent]`;
  moving changes the encoding and needs the indexer and ledger readers updated together.
- No contract has been audited. `cargo test` covers the unit tests in each crate; the end-to-end
  scripts in `scripts/` exercise them on testnet.
