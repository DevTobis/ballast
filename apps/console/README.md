# Ballast console

Borrower and lender web consoles (PRD §5 Phase 1 "Consoles" row): positions, headroom, margin
status, and the draw/repay/pledge/fund actions, talking to `services/api`.

Visual language: Tactical Telemetry (dark CRT terminal), per the `industrial-brutalist-ui` skill
- this is a risk-monitoring console, not a marketing page, so it deliberately skips that skill's
landing-page rules.

## Signing model

Ballast never holds customer signing keys (PRD §9). Every action here calls `services/api`, gets
back **unsigned XDR**, and displays it in a copy-able panel with instructions to sign externally
(`stellar tx sign`, a wallet, etc.) and submit. No secret key is ever entered into this app.

## Auth

Real SEP-10 (challenge/response signed by the account's own key): logging in here connects
[Freighter](https://www.freighter.app/) (`@stellar/freighter-api`), requests the connected
account, fetches a challenge transaction from `POST /v1/auth/challenge`, signs it in the
extension, and submits it to `POST /v1/auth/token` (`services/api/src/routes/auth.ts`, using
`@stellar/stellar-sdk`'s `webauth` module) - real proof of key ownership, no secret key ever
entered into this app. The account must already be linked to a `party` via `party_account`. If
Freighter isn't installed or connected, `Login.tsx` shows an install/connect prompt instead of the
login button.

The old raw-G-address `POST /v1/auth/dev-login` path (`services/api/src/routes/dev-auth.ts`) still
exists for scripted/local testing, but only when `services/api` is started with
`ENABLE_DEV_LOGIN=true`, and this app's UI no longer exposes it - it's reachable only by calling
the API directly (curl, a script).

## Running

```
cp .env.example .env   # point VITE_API_URL at your running services/api;
                        # VITE_STELLAR_NETWORK_PASSPHRASE must match services/api's
                        # STELLAR_NETWORK_PASSPHRASE, or Freighter's signature won't verify
pnpm dev
```

Needs `services/api` running (which needs Postgres and at least one seeded `party` +
`party_account` row linking a real Stellar account you control in Freighter), and the
[Freighter](https://www.freighter.app/) browser extension installed for login.
