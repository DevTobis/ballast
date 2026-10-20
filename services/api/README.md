# services/api

REST API for the console and for institutions. Two ways to authenticate; everything except `/healthz`,
`GET /v1/assets*` and `GET /v1/public/markets` needs one of them.

## Session (SEP-10)

`POST /v1/auth/challenge`, sign the returned transaction with your Stellar key, `POST /v1/auth/token`.
You get an HS256 JWT (12h) to send as `Authorization: Bearer <jwt>`.

## Institution API keys

Create a key while signed in with a session:

```
POST /v1/api-keys   { "label": "ops" }   ->   { "keyId": "bk_…", "secret": "…" }
```

The secret is shown once. Keys can only be created, listed (`GET /v1/api-keys`) and revoked
(`DELETE /v1/api-keys/:keyId`) with a session, never with a key. To rotate, create the new key, move
traffic over, then revoke the old one.

Send these headers on every request:

| header | value |
|---|---|
| `x-api-key` | the `keyId` |
| `x-timestamp` | unix seconds; must be within 5 minutes of the server clock |
| `x-nonce` | 16-64 chars of `[A-Za-z0-9_-]`, never reused |
| `x-signature` | hex HMAC-SHA256 of the string below, keyed with the secret |

```
v1
<x-timestamp>
<x-nonce>
<HTTP METHOD in capitals>
<path and query exactly as sent, e.g. /v1/positions?party=…>
<sha256 hex of the raw request body; of the empty string when there is no body>
```

(joined with `\n`). The body is hashed as the exact bytes you send, so sign the same string you put on
the wire. A request that fails authentication gets `401`; 30 failures a minute from one address get
`429`. Each key is limited to 1,000 requests a minute.

```ts
import { createHash, createHmac, randomBytes } from "node:crypto";

function signed(method: string, path: string, body: string, keyId: string, secret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const canonical = ["v1", timestamp, nonce, method, path, createHash("sha256").update(body).digest("hex")].join("\n");
  return {
    "x-api-key": keyId,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": createHmac("sha256", secret).update(canonical).digest("hex"),
  };
}
```

## Webhooks

`POST /v1/webhooks/subscriptions { "url": "https://…", "events": ["margin.call_issued"] }` returns a
signing secret once. `GET /v1/webhooks/events` lists the events that can be subscribed to (price status changes; margin state changes, calls and cures; liquidation started and completed; exit filled; repo leg 1 settled). A subscriber is sent what happens after it subscribes, not earlier history. Each
delivery is a POST with:

- `x-ballast-event`, `x-ballast-delivery`
- `x-ballast-signature: t=<unix>,v1=<hex>` where `v1` is the HMAC-SHA256 of `<t>.<raw body>` under your
  secret. Recompute it, compare in constant time, and reject if `t` is more than 5 minutes old.

A non-2xx answer is retried after 30s, 2m, 10m, 1h and 6h. After the sixth failed attempt the delivery is
dead-lettered; see it under `GET /v1/webhooks/subscriptions/:id/deliveries` and requeue it with
`POST /v1/webhooks/deliveries/:id/redeliver`. Delivery is at least once, so dedupe on
`x-ballast-delivery`. Redirects are not followed, and URLs that resolve to private addresses are refused.

## Compliance gate

With `COMPLIANCE_ENFORCED=true` (the default in production), these routes refuse a party unless its KYB
status is `approved` and it has a recent clear sanctions screening: opening a line, funding, pledging,
drawing, exit quotes and execution, repo proposals and acceptance. A request that names a counterparty
(the borrower on a new line, the cash borrower on a repo) screens them too. Repaying, releasing,
withdrawing and unwinding are never gated, so a party can always get out.

Screening checks the party's legal name and every Stellar account it uses against the US Treasury OFAC
SDN list (names, aliases and published digital-currency addresses). The list is downloaded from OFAC,
refreshed every 12 hours, and screening fails closed (`503`) if no copy younger than 7 days is available.
A match records a `compliance_check`, writes `sanctions.match` to the audit log and holds the party
until a person reviews it. This is a strict name and address screen, so it will miss spelling variants;
it is a first control, not a substitute for a commercial screening provider.

KYB itself is a person's decision, made outside the API:

```
pnpm --filter @ballast/db compliance kyb <partyId> approved <provider> <reference>
pnpm --filter @ballast/db compliance clear <partyId> <reviewer> "reviewed: different entity, same name"
```

A manual clear recorded by an operator persists across periodic screenings (`SCREENING_TTL_MS`, 24 hours): the reviewed entity IDs (`entNum`s) remain cleared so the party is not held again by the same false positive match. If a later screening produces a new match against a different entity ID, the party is held again for review.

## Amount and unit conventions

Request amounts go through `bigintish` (string or number parsed to `BigInt`). Responses that touch
on-chain values serialise `BigInt` fields as plain integer-digit strings via `bigint-json.ts`.
Routes that return raw database rows (positions, reports, webhook payloads) return decimal strings
instead. The two forms look different and must not be mixed without conversion.

### Scale factor

All monetary amounts use a fixed-point integer convention scaled by **10^7** — seven decimal places,
matching the Stellar stroop style used in the Ballast contracts.

```
human-readable value = scaled integer / 10_000_000
```

1 USDC is `10000000`. A scaled value of `1234567890` represents `123.4567890`.

| Scaled integer   | Decimal string (DB) | Human value       |
| ---------------- | ------------------- | ----------------- |
| `"10000000"`     | `"1.0000000"`       | 1 unit            |
| `"1234567890"`   | `"123.4567890"`     | 123.4567890 units |
| `"100000000000"` | `"10000.0000000"`   | 10 000 units      |

### Send amounts as strings, not numbers

**Always send monetary amounts as JSON strings, not bare numbers.** The `bigintish` schema accepts
both, but JSON numbers are IEEE 754 doubles: integers above 2^53 − 1 (roughly 900 trillion scaled
units) lose precision silently when the parser reads them. Use the string form in every request:

```json
{ "amount": "10000000" }
```

### Representations

| Form                 | Example       | Where it appears                                                          |
| -------------------- | ------------- | ------------------------------------------------------------------------- |
| Scaled integer       | `10000000`    | All request bodies; on-chain contract calls                               |
| JavaScript `BigInt`  | `10000000n`   | Internal; never in JSON                                                   |
| JSON string (scaled) | `"10000000"`  | Request bodies; responses where the value was a live `BigInt`             |
| Decimal string       | `"1.0000000"` | Database columns; returned as-is by positions, reports, webhooks          |
| Basis points         | `7500`        | Ratios such as `rateBps`, `ltvBps`, `haircutBps`; never a monetary amount |

### Conversion helpers

`@ballast/domain-types` provides two helpers:

| Helper                     | Input           | Output                                                                              |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `scaledToDecimalString(v)` | Scaled `BigInt` | Decimal string — used before writing to Postgres                                    |
| `decimalStringToScaled(v)` | Decimal string  | Scaled `BigInt` — used before passing a stored value to a contract call or response |

```ts
scaledToDecimalString(10000000n); // "1.0000000"
scaledToDecimalString(1234567890n); // "123.4567890"

decimalStringToScaled("1.0000000"); // 10000000n
decimalStringToScaled("123.4567890"); // 1234567890n
```

### The BigInt JSON serialiser

`bigint-json.ts` installs `BigInt.prototype.toJSON` to emit every `BigInt` as its plain
integer-digit string. This means `10000000n` becomes `"10000000"`, **not** `"1.0000000"`.
Decimal strings appear only where routes return raw database rows without going through a `BigInt`.

### Credit-line endpoints

| Endpoint | Request Amount(s) | Internal Handling | Response Amount(s) & Format |
| --- | --- | --- | --- |
| `POST /v1/credit-lines` | `limit` (`bigintish`, scaled) | Passed to contract as `BigInt`; stored via `scaledToDecimalString` as `limitAmount` | `xdr`, `txHash`, `creditLineId` (no monetary fields) |
| `GET /v1/credit-lines/:id` | — | `limitAmount` (decimal string) converted via `decimalStringToScaled`; on-chain values arrive as `BigInt` | `limit` (scaled string via `decimalStringToScaled`); `drawn`, `funded`, `undrawn`, `claimableInterest`, `collateralValue`, `liquidation.*` (scaled strings via serialiser); `ltvBps`, `rateBps`, `feeBps` (bps) |
| `POST /v1/credit-lines/:id/fund` | `amount` (`bigintish`, scaled) | Passed to contract as `BigInt`; `amount.toString()` (scaled digits) in intent payload | `xdr`, `txHash` (no monetary fields) |
| `POST /v1/credit-lines/:id/withdrawals` | `amount` (`bigintish`, scaled), `kind` (enum) | Passed to contract as `BigInt`; `amount.toString()` in intent payload | `xdr`, `txHash` (no monetary fields) |
| `POST /v1/credit-lines/:id/close-liquidation` | — | Calls `closeLiquidated` on contract directly; no amount | `xdr`, `txHash` (no monetary fields) |
| `POST /v1/credit-lines/:id/pledges` | `units` (`bigintish`, scaled) | Passed to contract as `BigInt`; stored via `scaledToDecimalString` in `pledge.units` | `xdr`, `txHash`, `pledgeId` (no monetary fields) |
| `DELETE /v1/credit-lines/:id/pledges/:pledgeId` | — | Stored `pledge.units` (decimal string) converted via `decimalStringToScaled` for contract `release` | `projectedLtvBps` (bps; no monetary fields) |
| `POST /v1/credit-lines/:id/draws` | `amount` (`bigintish`, scaled) | Passed to contract as `BigInt`; `amount.toString()` in audit log & intent payload | `xdr`, `txHash` (no monetary fields) |
| `POST /v1/credit-lines/:id/repayments` | `amount` (`bigintish`, scaled) | Passed to contract as `BigInt`; `amount.toString()` in audit log & intent payload | `xdr`, `txHash` (no monetary fields) |

### Exit endpoints

| Endpoint | Request Amount(s) | Internal Handling | Response Amount(s) & Format |
| --- | --- | --- | --- |
| `POST /v1/exit/quotes` | `units` (`bigintish`, scaled) | Passed to contract quote call; on-chain `price` and `usdcOut` returned as `BigInt`; all stored via `scaledToDecimalString` | `units`, `price`, `usdcOut` (scaled-integer strings via `decimalStringToScaled`); `spreadBps` (bps); `expiresAt` (ISO date) |
| `POST /v1/exit/quotes/:id/execute` | `minUsdcOut` (`bigintish`, scaled), `to` (address) | Passed to contract as `BigInt`; stored `quote.units` converted via `decimalStringToScaled`; `minUsdcOut.toString()` in audit log | `xdr`, `txHash`, `quoteId` (no monetary fields) |

### Repo endpoints

| Endpoint | Request Amount(s) | Internal Handling | Response Amount(s) & Format |
| --- | --- | --- | --- |
| `POST /v1/repo/proposals` | `units`, `cashAmount` (`bigintish`, scaled); `rateBps` (bps); `maturityAt` (ISO date) | `units` and `cashAmount` passed to contract as `BigInt`, stored via `scaledToDecimalString`; `maturityAt` → Unix seconds | `xdr`, `txHash`, `tradeId` (no monetary fields) |
| `POST /v1/repo/proposals/:id/accept` | `contractTradeId` (optional `bigintish`) | Uses supplied or DB trade ID as `BigInt`; no monetary conversion | `xdr`, `txHash`, `tradeId` (no monetary fields) |
| `POST /v1/repo/trades/:id/unwind` | `contractTradeId` (optional `bigintish`) | Same as accept; no monetary conversion | `xdr`, `txHash`, `tradeId` (no monetary fields) |
| `POST /v1/repo/trades/:id/top-ups` | `units` (`bigintish`, scaled) | Passed to contract as `BigInt`; `units.toString()` in intent payload | `xdr`, `txHash`, `tradeId` (no monetary fields) |

### Asset endpoints

| Endpoint | Request Amount(s) | Internal Handling | Response Amount(s) & Format |
| --- | --- | --- | --- |
| `GET /v1/assets` | — | Selects all assets and price snapshots; picks latest snapshot per asset; `haircutBps = haircutBaseBps + haircutFxBps`; no conversion | `price.value` (raw DB column `guardedValue`, a decimal string); `price.status` (enum); `price.asOf` (ISO date); `haircutBps` (bps) |
| `GET /v1/assets/:id/price` | — | Returns latest snapshot and 50 most recent history rows directly from DB; no conversion | `value`, `history[*].guardedValue` (raw DB column `guardedValue`, decimal strings); `status` (enum); `ts` (ISO date) |

> **Note:** `guardedValue` is a decimal string, not a scaled integer: the price-guard service writes it with `scaledToDecimalString` (`services/price-guard/src/pipeline.ts`), e.g. `"0.0657660"`.

### Positions endpoint

| Endpoint | Request Field(s) | Internal Handling | Response Fields & Format |
| --- | --- | --- | --- |
| `GET /v1/positions` | `party` (UUID query param, required) | Verifies `party` matches authenticated caller; queries `creditLine`, `pledge`, `exitQuote`, and `repoTrade` tables; returns raw DB rows with no conversion | `creditLines.limitAmount`, `pledges.units`, `exitQuotes.{units, price, usdcOut}`, `repoTrades.{units, cashAmount}` — **all raw DB decimal strings** (e.g. `"10.0000000"`) |

### Reports endpoint

| Endpoint | Request Field(s) | Internal Handling | Response Fields & Format |
| --- | --- | --- | --- |
| `GET /v1/reports/daily` | `date` (`YYYY-MM-DD`, required), `format` (`"json"` \| `"csv"`, optional) | Queries caller's `marginEvent`, `liquidation`, `draw`, `repayment`, and public `priceSnapshot` for UTC day; returns raw DB rows with no conversion; CSV flattens with leading `kind` column | `draws.amount`, `repayments.amount`, `liquidations.{units, proceeds, shortfall}` (**decimal strings**); `priceSnapshots.guardedValue` (raw DB); `marginEvents.ltvBps` (bps) |

### Webhook event payloads

The management endpoints (`POST|GET /v1/webhooks/subscriptions`, `DELETE /v1/webhooks/subscriptions/:id`, etc.) contain no monetary amounts. Webhook event deliveries carry payloads with the envelope `{ event, occurredAt, data }`.

| Event | Direction | Internal Handling | `data` Amount Field(s) & Format |
| --- | --- | --- | --- |
| `liquidation.completed` | Outbound POST | `data` copied verbatim from `liquidation` table; no conversion | `units`, `proceeds`, `shortfall` (**decimal strings**) |
| `exit.filled` | Outbound POST | `data` copied verbatim from `exit_quote` table; no conversion | `units`, `usdcOut` (**decimal strings**) |
| `repo.leg1_settled` | Outbound POST | `data` copied verbatim from `repo_trade` table; no conversion | `units`, `cashAmount` (**decimal strings**) |
| `price.status_changed` | Outbound POST | `data` copied verbatim from `price_snapshot` table; no conversion | `value` (**decimal string**) |
| `margin.state_changed`, `.call_issued`, `.cured`, `liquidation.started` | Outbound POST | `data` copied verbatim from `margin_event` table; no conversion | `ltvBps` (basis points — not monetary) |

All monetary fields in webhook `data` are decimal strings copied as-is from the database.

### Markets endpoint

| Endpoint | Request Field(s) | Internal Handling | Response Fields & Format |
| --- | --- | --- | --- |
| `GET /v1/public/markets` | — (public, unauthenticated) | Pairs active assets with latest snapshot (`guardedValue`) and observations (`issuer_nav`, `redstone`); computes `ageS` (seconds) and `divergenceBps` (basis points); returns raw DB values with no conversion | `guarded.value`, `sources.issuerNav.value`, `sources.redstone.value` (raw DB values); `divergenceBps`, `priceBandBps` (bps); `ageS` (seconds); `guarded.status` (enum) |

### Known format mismatches (Issue #313)

Routes that return raw database rows bypass `decimalStringToScaled`, producing decimal strings instead of the scaled-integer strings returned by entity and contract-touching routes:

| Mismatch | Route A (Scaled Integer) | Route B (Raw DB Decimal) | Affected Fields |
| --- | --- | --- | --- |
| **Credit lines** | `GET /v1/credit-lines/:id` (`"100000000"`) | `GET /v1/positions` (`"10.0000000"`) | `limit` vs `limitAmount` |
| **Exit quotes** | `POST /v1/exit/quotes` (`"10000000"`) | `GET /v1/positions` (`"1.0000000"`) | `units`, `price`, `usdcOut` |
| **Draws & Repayments** | Intent payloads in `POST .../draws`, `repayments` (`"100000000"`) | `GET /v1/reports/daily` (`"10.0000000"`) | `amount` |
| **Repo & Pledges** | `POST .../proposals`, `pledges` (`"100000000"`) | `GET /v1/positions` (`"10.0000000"`) | `units`, `cashAmount` |

Before passing values from `GET /v1/positions` or `GET /v1/reports/daily` into contract calls or request bodies, convert them:

```ts
import { decimalStringToScaled } from "@ballast/domain-types";
const scaled = decimalStringToScaled(position.creditLines[0].limitAmount);
```

