# Security Policy

Ballast is a Soroban-based collateral and lending protocol. A vulnerability here can mean real
funds are at risk once this reaches mainnet, so please report security issues privately rather
than through a public GitHub issue or pull request.

## Current status

**Ballast is pre-audit, testnet-only software.** The contracts and services in this repo have not
been through a third-party security audit, and no funds beyond testnet lumens are ever at risk in
the current deployment (see [`TESTNET_DEPLOYMENT.md`](TESTNET_DEPLOYMENT.md) for what's live and
where). Treat everything here as unaudited until that changes.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Instead, report it privately via a
[GitHub Security Advisory](https://github.com/DevTobis/ballast/security/advisories/new).

Include, as applicable:

- The affected contract, service, or file (with a commit hash or contract ID if it's already
  deployed to testnet).
- A clear description of the issue and its impact — for a contract, whether it's a fund-loss
  path, an access-control bypass, a price-manipulation vector, or a denial-of-service.
- Steps to reproduce, or a proof-of-concept transaction/test if you have one.
- Whether you believe this is exploitable against the current testnet deployment specifically, or
  is a design-level issue that would matter at mainnet.

You should get an initial response within a few days. Please give us a reasonable window to
investigate and fix an issue before any public disclosure.

## Scope

In scope:

- `contracts/` — the Soroban contracts (`registry`, `price-guard`, `pledge-vault`, `credit-line`,
  `exit-desk`, `repo-dvp`, and the shared `common` crate): fund-safety, access-control, and
  price-manipulation issues are the highest priority.
- `services/` and `packages/` — the off-chain services and shared TypeScript packages,
  particularly anything on the signing path (`packages/operator-signing`), the auth path
  (`services/api/src/auth.ts`, `services/api/src/routes/auth.ts`), and the price-publishing
  pipeline (`services/price-guard`).
- `apps/console` — the borrower/lender web console, particularly anything around the SEP-10 login
  flow or transaction-signing UI.

Out of scope:

- Findings that require access to a maintainer's local machine, private keys, or CI secrets that
  weren't otherwise exposed by this codebase.
- Issues in third-party dependencies — report those upstream (though we'd still like to know, so
  we can update).
- The mock/local-dev-only code paths (`*/adapters/mock*.ts`, the `local` operator-signer mode,
  `ENABLE_DEV_LOGIN`) when explicitly gated and not reachable in a production configuration —
  these are documented, intentional local-development affordances, not vulnerabilities. If you
  believe one of these gates can be bypassed in a real deployment, that *is* in scope.

## What "production-ready" means here

The project's own build plan ([`PRD.md`](PRD.md) §11 "Security") lays out what has to be true
before real funds are at risk on mainnet:

- Two independent audits (contracts, and the Price Guard pricing/economics logic), with a
  re-audit on any change to `CreditLine`, `PledgeVault`, or `RepoDvP`.
- A 3-of-5 multisig admin account with a 48h timelock on parameter/upgrade changes, and a separate
  pauser key with no other privileges. (This needs no contract code change — Soroban contracts
  authorize a plain `Address`; making that address a multisig Stellar account is a deployment/ops
  step, done via the account's own signer thresholds.)
- Operator keys (keeper, price publisher, payout-hop) held in a real KMS, never a raw secret in an
  environment variable — see `packages/operator-signing`, which already supports HashiCorp Vault
  Transit and AWS/GCP KMS envelope encryption for this; the `local` mode (raw secret) is gated to
  never run when `NODE_ENV=production`.
- Real per-asset issuer-signature verification on price publishes, on-chain
  (`PriceGuard::publish_nav`'s `ed25519_verify`, `require_nav_signature` left at its default
  `true`) and off-chain (`services/price-guard/src/navSignature.ts`).
- Mainnet draw caps, fork/adversarial-fuzz testing against the Price Guard logic (including a
  replay of the 2026-02-22 USTRY-style manipulation this contract exists to prevent — see
  `contracts/price-guard/src/lib.rs`'s module doc comment), monthly incident drills, and a funded
  bug bounty from mainnet launch, scoped to the contracts and Price Guard.

None of that is in place yet — this repo is at the "real code, real testnet deployment, unaudited"
stage, not the "ready for real funds" stage. If you're evaluating whether to rely on this in
production: don't, yet.

## Supported versions

There are no tagged releases yet; `main` is the only supported branch. This will be revisited once
the project reaches its first audited mainnet release.
