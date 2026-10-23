# services/issuer-gateway

Internal HTTP front for RWA issuers' back offices: authorisation to hold an asset, SEP-8 transaction
approval, lien freeze and release, and redemption. One adapter per issuer (Spiko, Etherfuse, Franklin)
sits behind a common `IssuerAdapter` interface. Every call is recorded in `audit_log`
(`actor = 'issuer-gateway'`).

## Endpoints

All `POST`, under `/internal/issuers/:code/` where `:code` is `spiko`, `etherfuse` or `franklin`:

| path | body | action logged |
|---|---|---|
| `authorize` | `assetCode`, `holderAddress` | `issuer.authorize` |
| `sep8-approve` | `assetCode`, `txXdr` | `issuer.sep8_approve` |
| `lien-freeze` | `assetCode`, `holderAddress`, `units` (decimal string) | `issuer.lien_freeze` |
| `lien-release` | `assetCode`, `lienRef` | `issuer.lien_release` |
| `redeem` | `assetCode`, `units`, `destination` | `issuer.redeem` |

## Adapters

There is no mock mode. An issuer is served only when `<ISSUER>_API_BASE_URL` and `<ISSUER>_API_KEY` are
both set; otherwise its endpoints fail (HTTP 500) and never return an approval. An unknown code also
returns 500. Adapters are built per request, so issuers can be configured independently.

- SEP-8 follows the Stellar Regulated Assets protocol: the adapter POSTs `{ tx }` to
  `<ISSUER>_SEP8_APPROVAL_SERVER_URL` (default `<base URL>/sep8`) and maps `success`, `revised`,
  `rejected` and `pending` onto the interface.
- Outbound HTTP requests have a 15-second timeout by default, including reading the response body.
  Timeout errors name the issuer and adapter operation. Requests are not automatically retried:
  a timeout does not establish whether the issuer processed the request.
- Authorisation, liens and redemptions call `POST /v1/authorizations`, `POST /v1/liens`,
  `DELETE /v1/liens/:ref` and `POST /v1/redemptions` with a bearer key. **These endpoints are guesses**:
  none of the three issuers publishes such an API. They are marked TODO in the adapters and must be
  replaced with whatever each issuer provides under its integration agreement. Nothing here has run
  against a real issuer.

## Security

Every request needs `x-internal-token` equal to `INTERNAL_API_TOKEN` (at least 32 characters,
constant-time compare); the service will not start without it. It binds to `127.0.0.1` unless
`ISSUER_GATEWAY_HOST` is set. Request bodies are not validated beyond that, and only `units` is parsed
(as a bigint). Keep it on a private network.

## Run

```
pnpm --filter @ballast/service-issuer-gateway dev      # tsx watch, loads the repo-root .env
pnpm --filter @ballast/service-issuer-gateway build && pnpm --filter @ballast/service-issuer-gateway start
```

`pnpm dev` at the root also starts it; only `INTERNAL_API_TOKEN` and `DATABASE_URL` are needed to boot.

## Environment

| variable | purpose |
|---|---|
| `INTERNAL_API_TOKEN` | shared secret for the header above |
| `ISSUER_GATEWAY_PORT` (3001), `ISSUER_GATEWAY_HOST` (127.0.0.1) | listen address |
| `ISSUER_GATEWAY_TIMEOUT_MS` (15000) | per-request issuer API and SEP-8 HTTP timeout in milliseconds, including the response body; integer from 1 to 2147483647 (invalid values fail before the request) |
| `DATABASE_URL` | Postgres, for `audit_log` |
| `SPIKO_`, `ETHERFUSE_`, `FRANKLIN_` + `API_BASE_URL`, `API_KEY`, `SEP8_APPROVAL_SERVER_URL` | per-issuer back office (nine variables) |

## Source map

- `src/index.ts`: Fastify routes and audit logging.
- `src/registry.ts`: `getAdapter`, env-driven selection.
- `src/adapter.ts`: the `IssuerAdapter` interface.
- `src/adapters/`: `spikoAdapter.ts`, `etherfuseAdapter.ts`, `franklinAdapter.ts`, and `liveShared.ts`
  (bearer-auth JSON requests, SEP-8 call and response mapping).

## Tests

`pnpm --filter @ballast/service-issuer-gateway test` (vitest; `fetch` is stubbed, the database is a
fake). `src/index.test.ts` covers all five endpoints through the real adapters, the 500 for an
unconfigured or unknown issuer, and 401 without the token before any issuer is contacted.
`src/__tests__/liveAdapters.test.ts` covers fail-fast config checks, request shapes, error text on
non-2xx, the SEP-8 status mapping and URL override, and `getAdapter`. The stubbed responses are the
shapes the adapters expect, not recordings of a real issuer.
`src/__tests__/liveShared.test.ts` covers stalled fetches and response bodies, timeout configuration,
issuer/operation diagnostics, and the absence of automatic POST retries.

## Known limits

- Nothing calls this service yet (`scripts/README.md` says the same).
- The back-office endpoints above are unverified; only the SEP-8 leg follows a published protocol.
- Failures surface as bare 500s, and the audit row is written after the adapter call returns, so a failed
  issuer call leaves no audit row.
