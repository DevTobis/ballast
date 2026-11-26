# Runbook: handling a PriceGuard halt

Audience: the on-call risk operator. This is the checklist for a `Halted` guarded price
(PRD §6.4: "no liquidations until a human confirms"). The one write in this runbook is
`confirm_halt_cleared`; everything before it is read-only.

A halt is a **sticky latch**. While it is set, `guarded_price` returns `Halted` and keeps
returning the last good value regardless of a fresh read. Draws, exits, repos and
liquidations are blocked; repayment, release and withdrawal are not. Only the `risk` role can
clear it, and clearing it asserts that the large move was real, not manipulation.

> [!WARNING]
> `confirm_halt_cleared` promotes the value that **tripped** the halt
> (`PendingHaltValue`) to the new baseline, not the price at the moment you confirm. If the
> spike has reverted since the halt, confirming sets the baseline to the spike. The next
> ordinary price then looks like a large drop against that baseline and can halt again, and
> collateral is valued at the spike in the meantime. Always re-read the values immediately
> before confirming (step 4). This is known behaviour of the current contract, not a
> documentation mistake: see [#127](https://github.com/DevTobis/ballast/issues/127).

---

## 1. Detect the halt

The `price-guard` service and `services/indexer` alert on `status_changed` to `Halted` and on
the `halt_latched` event. Confirm it on-chain rather than trusting the alert alone. Reads are
simulations: they persist nothing and are safe to repeat.

```bash
source .env.testnet-deploy        # PRICE_GUARD_CID, RWA_SAC, RISK
export NETWORK=testnet

stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- guarded_price --asset "$RWA_SAC"

stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- halt_info --asset "$RWA_SAC"
```

On a deployment whose `PriceGuard` predates #1160 the `halt_info` and `last_good` entry points do
not exist yet (see [Verification status](#verification-status)); redeploy first with
`scripts/redeploy-price-guard.sh`.

`guarded_price` returns `{ value, status, ts, sources }`. `halt_info` returns `None` when the
asset is not halted, otherwise `{ last_good, pending }`:

- `last_good` is the baseline `guarded_price` is holding while halted.
- `pending` is the median that tripped the halt, and the value `confirm_halt_cleared` will
  promote to `LastGood`.

Also read the configured thresholds, so you know what "too large" means for this asset:

```bash
stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- asset_config --asset "$RWA_SAC"
```

## 2. Check the move against independent sources

The guard's median is built from pushed readings: the issuer NAV (`issuer`), an independent
SEP-40 feed such as RedStone, and the last observed redemption price. Verify the move against
each of them **outside** the contract before doing anything else:

| Check | Where | What you are looking for |
|---|---|---|
| Issuer NAV | Issuer's NAV page or verified endpoint; `nav_published` event for the same `ts`/value | The signed NAV moved by a similar amount, and the reading is inside `max_staleness_s` |
| Independent feed | RedStone (or the configured SEP-40 feed) dashboard and its `source_published` event | The feed moved too, and agrees with the NAV within `band_bps` |
| Redemption price | Issuer redemption records, or the `redemp` source the indexer publishes | Actual redemptions cleared at or near the new value |
| DEX / RFQ price | Classic DEX, Octarine | **Monitoring only.** A move here that the other three do not share is a manipulation signal, not a reason to confirm |

Useful read-only follow-ups:

```bash
# Current baseline, independent of the latch.
stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- last_good --asset "$RWA_SAC"

# Pending configuration changes (e.g. a band change) already in the 48h timelock.
stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- pending_config --id <CONFIG_ID>
```

Two common false alarms are documented in [`TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md):
the RedStone feed updates every 1–2 hours, and a long publication outage makes an ordinary
move look like a jump on the first publish afterwards.

## 3. Decide — do not confirm unless every line is true

- [ ] `pending` is within `band_bps` of **two** independent, fresh sources (not just one).
- [ ] The issuing source is the issuer's verified NAV page/endpoint or a reading you have
      verified the signature on — not a screenshot or a forwarded number.
- [ ] The redemption price is consistent with the new value, or redemptions are explicitly
      suspended with a documented reason.
- [ ] The size and timing of the move are explained by a real event (rate decision, NAV
      publication, credit event), not by a feed outage or a single-source jump.
- [ ] There is no sign of publisher or issuer-key compromise: check who published the
      reading (`nav_published` / `source_published` events) and that the publishing account
      is the expected `price_publisher`.
- [ ] You re-read `halt_info` and `guarded_price` **now**, and `pending` still matches the
      current median (see the warning above).

If any line is false, **do not confirm**. Keep the halt in place (that is the safe state),
record what failed, and escalate (step 6).

## 4. Confirm the halt

Both `risk` and `asset` are explicit arguments; `--source risk` is the identity that signs.
Replace the values with the ones from `.env.<network>-deploy`.

```bash
export NETWORK=testnet
source ".env.${NETWORK}-deploy"

# Final check: halt_info.pending must equal the current guarded_price.value (the median).
stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- halt_info --asset "$RWA_SAC"

stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- confirm_halt_cleared --risk "$RISK" --asset "$RWA_SAC"
```

What the call changes:

1. `LastGood` becomes `pending` (with the current ledger timestamp).
2. `RollingReference` is reset to `pending`, so the slow-drift check starts from the new
   level instead of the old one.
3. `PendingHaltValue` is deleted and the `Halted` latch is removed.
4. A `halt_cleared` event is emitted with the new `LastGood`.

It does **not** publish a price and does not change the current status by itself. The next
publish (or `guarded_price` call) re-evaluates the sources; if they still agree within the
bands, the status becomes `Ok` and collateral is valued at the new baseline. Expect that
transition to appear as `status_changed (Halted → Ok)` in the indexer.

## 5. Verify

```bash
stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- halt_info --asset "$RWA_SAC"          # must return null/None

stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- guarded_price --asset "$RWA_SAC"       # expect status Ok, value == the promoted pending

stellar contract invoke \
  --id "$PRICE_GUARD_CID" --network "$NETWORK" --source risk \
  -- last_good --asset "$RWA_SAC"           # must equal the promoted pending
```

Then check that the monitoring alert has cleared, and note the new baseline in the incident
record so the next on-call knows why the value moved.

## 6. Escalate

Escalate instead of confirming when:

- the sources disagree, any of them is stale, or only the DEX price moved;
- the pending value keeps changing between reads (a live/rolling spike);
- you suspect the publisher or issuer key is compromised — **do not confirm**; involve the
  admin. A publisher rotation is the 48h `queue_role_change` path plus `configure_issuer_key`
  (see [`contracts/README.md`](../../contracts/README.md)); the halt stays in place while that
  runs;
- a liquidation is already overdue: it remains blocked until the halt is cleared, so the
  lender and the keeper job need to know the timeline;
- the move is real but you believe the asset's bands are wrong. Bands can only be **tightened**
  immediately; loosening one goes through the 48h `queue_config` timelock, so do not widen a
  band just to make an alert go away.

Record in the incident: the asset, the `halt_latched` transaction/ledger, `last_good`,
`pending`, the independent values you checked with links/timestamps, the decision, the
`confirm_halt_cleared` transaction hash if you called it, and the resulting baseline.

---

## References

- PRD §6.4 (price-guard rules) and §11 (monitoring alerts).
- [`contracts/price-guard/src/lib.rs`](../../contracts/price-guard/src/lib.rs) —
  `guarded_price`, `halt_info`, `last_good`, `confirm_halt_cleared`.
- [`contracts/price-guard/README.md`](../../contracts/price-guard/README.md) — events and the
  halt cycle.
- [`contracts/AUDIT_NOTES.md`](../../contracts/AUDIT_NOTES.md) — what `LastGood` carries and
  what the guard assumes.

## Verification status

Exercised against the testnet deployment recorded in
[`TESTNET_DEPLOYMENT.md`](../../TESTNET_DEPLOYMENT.md) (`price-guard`
`CCSIO64AJEN3ITER7QXLTETSG5LZ2EIQWO5ON2TEVPOOKHBFR2ZVYUOP`, deployed 2026-10-26) on 2026-11-24
with `stellar` 28.1.0, asset `RWA1` (`CBUHRZ2D5EDPEY36Z4QHHAXV3XRKGLRYK7Y7HCD77YPL5G6IUNBCA7BZ`).

| Command | Outcome |
|---|---|
| `guarded_price` | **Run, works.** Returned `{"status":"Degraded","value":"10782785","sources":[],"ts":1795564187}`. |
| `asset_config` | **Run, works.** Returned `{"band_bps":50,"daily_move_band_bps":100,"max_staleness_s":46800,"window_seconds":86400,"window_move_band_bps":100}`. |
| `pending_config` | **Run, works.** `--id 0` returns `null` on this deployment (nothing queued). |
| `halt_info` | **Cannot run on this deployment.** The deployed wasm has no `halt_info` entry point — the getters landed in #1160 on 2026-11-22, after the 2026-10-26 deploy — so the CLI rejects the call with `error: unrecognized subcommand 'halt_info'`. Run `scripts/redeploy-price-guard.sh` before relying on step 1 or step 4. |
| `last_good` | **Cannot run on this deployment**, same cause and the same `unrecognized subcommand` error. |
| `confirm_halt_cleared` | **Still untested.** It is the one write in this runbook, so it needs the `risk` signing key (only that role's public address is committed here) and an actually halted asset; this deployment had no halt to clear and no identity was available. It *is* present in the deployed contract's spec, so the entry point itself exists. |

Read-only runs used `--source-account "$RISK" --send=no` instead of `--source risk`: a public key
cannot sign, and `--send=no` keeps the call a pure simulation. Without `--send=no` the same call
fails with `No sign with key provided`. Note that `guarded_price` is not a pure storage read — the
simulation emitted `status_changed (Ok → Degraded)` — so the flag is what keeps it non-mutating.

`Degraded` is the correct reading on this deployment today, not a fault: the push-based sources
were last written on deploy day, well past `max_staleness_s`, so until the publisher runs the guard
refuses to quote `Ok` and holds the last good value. A halt cannot latch from stale data, so the
`Halted` paths in steps 1–5 need fresh publishes first.
