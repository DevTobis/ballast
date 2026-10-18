# Ballast console

Web console for `services/api`, four views:

- **Borrower**: lines, headroom, margin status; draw, repay, pledge, release.
- **Lender**: open a credit line, fund it, watch exposure and margin status.
- **Exit**: quote and execute an instant exit of an RWA position for USDC.
- **Repo**: propose a repo as cash lender, accept one as cash borrower, unwind at maturity.

Visual language: Tactical Telemetry (dark CRT terminal), per the `industrial-brutalist-ui` skill
- this is a risk-monitoring console, not a marketing page, so it deliberately skips that skill's
landing-page rules.

## Signing model

Ballast never holds customer signing keys (PRD §9). Every action here calls `services/api` and
gets back **unsigned XDR** plus the hash that transaction will have. The transaction panel
(`components/XdrOutput.tsx`) then has Freighter sign it in the extension and posts the signed
envelope to `POST /v1/tx/submit`, which sends it, waits for the ledger to close, and updates the
books (see `services/api/src/intents.ts`). The raw XDR stays visible with a copy button for anyone
who would rather sign elsewhere (`stellar tx sign`) - in that case `POST /v1/tx/:hash/settle`
picks the result up afterwards. No secret key is ever entered into this app.

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

## Render-error recovery

If a page fails during rendering, a fallback panel offers **Reload** and **Disconnect**.
Console tabs and the header remain available after a page failure; changing tabs resets
the fallback. A root boundary also covers Login, Markets, and the shell. Disconnect
clears the saved console session and returns to Login. Errors are logged only to the
browser console; no remote error reporting is configured.

## Running

`scripts/dev-setup.sh` (repo root) writes this app's `.env` along with everything else, and
`pnpm dev` at the root starts it on http://localhost:5173 next to the services. To run it alone:

```
cp .env.example .env   # point VITE_API_URL at your running services/api;
                        # VITE_STELLAR_NETWORK_PASSPHRASE must match services/api's
                        # STELLAR_NETWORK_PASSPHRASE, or Freighter's signature won't verify
pnpm dev
```

To log in, Freighter needs an account that is linked to a party. For the seeded testnet parties
that means importing the deploy's `lender` or `borrower` key into Freighter
(`stellar keys secret lender`) and switching Freighter to Testnet.
