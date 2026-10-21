# services/payout-hop

Pays an anchor from the operator's own Stellar account. A Soroban contract cannot attach the memo an
anchor needs, so the money goes in two legs: contract -> operator G-account (done elsewhere), then this
service sends operator G-account -> anchor G-account as a classic USDC payment with the memo.

It moves real funds, so treat it as the most sensitive service in the repo.

## Endpoint

`POST /internal/payout-hop/forward`, JSON body:

| field | meaning |
|---|---|
| `fromContractPayoutTxHash` | hash of the first leg; the idempotency key |
| `toAnchorAccount` | anchor G-address |
| `amount` | whole number as a string, in 7-decimal fixed point (`"10000000"` = 1 USDC) |
| `memo` | 1-64 chars in the schema; the policy then requires a text memo of at most 28 bytes, or digits fitting a `MEMO_ID` |
| `usdcAssetAddress` | the USDC issuer's **G-address** (not the SAC `C...` id); must equal `PAYOUT_HOP_USDC_ISSUER` |
| `quoteId` | optional `exit_quote` uuid |

Answers `200 { hash, status, booked }`, `400` bad body, `401` no or wrong token, `403` refused by policy,
`409` this first-leg hash was already requested, `502` submission failed (nothing was paid).

Once the network has accepted the payment the answer is always `200` with its hash, because the anchor
has been paid. `booked: false` means recording it failed: the row is left `bookkeeping_pending`, a
`payout_unbooked` alert fires, and the repair below books it. Callers must not retry on `booked: false`.

## Security

- Every request needs `x-internal-token` equal to `INTERNAL_API_TOKEN` (at least 32 characters, compared
  in constant time). The service will not start without it.
- It binds to `127.0.0.1` unless `PAYOUT_HOP_HOST` is set.
- The caller does not decide where money goes. A payout is refused unless the destination is in
  `PAYOUT_HOP_ALLOWED_DESTINATIONS`, the asset is `PAYOUT_HOP_USDC_ISSUER`'s USDC, the amount is positive
  and at most `PAYOUT_HOP_MAX_AMOUNT` whole USDC (default 5000), and the memo fits. Startup fails if the
  issuer or destination list is missing or contains an invalid G-address.
- Each first-leg hash is claimed in `payout_forward` before anything is sent, so retries and duplicates
  pay once. A payout marked `failed` can be requested again.
- The key comes from `@ballast/operator-signing`. `PAYOUT_HOP_SIGNER_MODE` is `local` (default; reads
  `PAYOUT_HOP_SECRET_KEY`, and is refused when `NODE_ENV=production`), `vault` or `kms-envelope`.

## Run

```
pnpm --filter @ballast/service-payout-hop dev      # tsx watch, loads the repo-root .env
pnpm --filter @ballast/service-payout-hop build && pnpm --filter @ballast/service-payout-hop start
```

`pnpm dev` at the root also starts it, and it exits at startup if the variables below are missing.
`scripts/dev-setup.sh` fills them in, using the test lender and borrower as the "anchors".

## Environment

| variable | purpose |
|---|---|
| `INTERNAL_API_TOKEN` | shared secret for the header above |
| `PAYOUT_HOP_PORT` (3002), `PAYOUT_HOP_HOST` (127.0.0.1) | listen address |
| `PAYOUT_HOP_USDC_ISSUER` | USDC issuer G-address |
| `PAYOUT_HOP_ALLOWED_DESTINATIONS` | comma-separated anchor G-addresses |
| `PAYOUT_HOP_MAX_AMOUNT` | per-payout cap, whole USDC (default 5000) |
| `PAYOUT_HOP_REPAIR_INTERVAL_S` | how often unbooked payouts are swept (default 300; also runs at startup) |
| `ALERT_WEBHOOK_URL`, `ALERT_COOLDOWN_S` | where `payout_unbooked` alerts are posted (console only when unset) |
| `PAYOUT_HOP_SIGNER_MODE`, `PAYOUT_HOP_SECRET_KEY`, `VAULT_*`, `PAYOUT_HOP_VAULT_KEY_NAME`, `AWS_REGION`, `PAYOUT_HOP_KMS_KEY_ID`, `PAYOUT_HOP_WRAPPED_SECRET` | operator signer |
| `DATABASE_URL`, `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE` | database and network |

## Source map

- `src/index.ts`: Fastify server, request schema, status mapping.
- `src/hop.ts`: `PayoutPolicy`, `forwardPayout` (claim, build payment, submit, record), `bookPayout`.
- `src/repair.ts`: `bookPendingPayouts`, which books `bookkeeping_pending` rows.
- `src/signer.ts`: `PayoutSigner` seam and the RPC-backed `OperatorPayoutSigner`.

## What it writes

`payout_forward` (claim, then `sent` with the tx hash, `bookkeeping_pending` if sent but not booked, or
`failed`); `exit_fill` (only when `quoteId` is given); and two balanced `journal_entry` rows (`usdc_cash`
debit, `operator:payout_hop` credit).

The claim row stores the journal `ref_id` (the `quoteId` when there is one, otherwise a fresh uuid) and
the `quote_id`, before anything is sent. Marking the row `sent` and writing `exit_fill` plus the journal
pair happen in one transaction, so `sent` always means booked, and everything needed to book a payout
later is already on its row.

## Repairing unbooked payouts

`bookPendingPayouts(db, alerter)` books every `bookkeeping_pending` row under its stored `ref_id` and
marks it `sent`. It runs at startup and every `PAYOUT_HOP_REPAIR_INTERVAL_S`. It is idempotent and safe
to run from several processes: each row is taken by a conditional update in its own transaction, and a row
whose journal pair already exists (the original commit landed but its acknowledgement was lost) is only
marked `sent`. A row it still cannot book stays pending and alerts `payout_unbooked` again.

## Tests

`pnpm --filter @ballast/service-payout-hop test` (vitest; fake signer and database, no network). Covers
401 without the token, 400 on malformed bodies, 403 on a refused destination, each policy rule including
the cap boundary, text and numeric memos, pay-once on repeats, retry after failure, an `ERROR` status
treated as failed, and `loadPayoutPolicy` validation. The fake database keeps real rows, honours the
`eq`/`and` filters used here and rolls back a transaction that throws. With it: a booking transaction
that throws after sending still returns the hash with `booked: false`, leaves the row
`bookkeeping_pending` with nothing half-written, alerts, and refuses a retry with `409`; a database that
is gone entirely still returns the hash and alerts that the row could not be flagged. The repair books
under the claim's `ref_id` (quote or generated), writes `exit_fill`, is idempotent, only marks `sent` a row
already booked, retries a row it failed on, and leaves other statuses alone.

## Known limits

- **Not wired in.** Nothing in `services/api` or elsewhere calls this endpoint; the exit-execute flow
  does not use it, and `TESTNET_DEPLOYMENT.md` says the same. A real forward has not been run on a network.
- Only `ERROR` from `sendTransaction` is treated as failure. `PENDING` is recorded as `sent` without
  waiting for the ledger to confirm it.
- If the process dies after claiming but before finishing, or the database is unreachable when the
  booking fails (so the row cannot be flagged), the row stays `claimed` and later requests get `409`
  until someone resolves it by hand. In the second case the `payout_unbooked` alert carries the tx hash.
- The hop does not check that the first leg actually landed; it trusts the caller.
