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

Real SEP-10 (challenge/response signed by the account's own key) isn't wired up yet - see
`services/api/src/routes/dev-auth.ts`. Logging in here calls `POST /v1/auth/dev-login` with a
Stellar G-address that must already be linked to a `party` via `party_account`, and gets back a
JWT with no proof of key ownership. This is fine for a local/testnet deployment where you already
control the keys in question, and is clearly not acceptable for production - a real deployment
needs an actual SEP-10 flow (and a wallet, e.g. Freighter, in this app) before going live.

## Running

```
cp .env.example .env   # point VITE_API_URL at your running services/api
pnpm dev
```

Needs `services/api` running (which needs Postgres and, for the dev-login/party lookup, at least
one seeded `party` + `party_account` row).
