# Contributing to Ballast

Thank you for your interest in contributing. This document covers everything you need to
get started.

---

## Before You Begin

- Read the [Code of Conduct](CODE_OF_CONDUCT.md). All contributors are expected to follow it.
- For significant changes (new contract logic, a new service, a new adapter), open an issue first
  to discuss the approach before writing code.
- For bug fixes, doc fixes, and small improvements, a pull request is sufficient.
- This is a lending/collateral protocol. If you find a **security** issue, do not open a public
  issue or PR — see [SECURITY.md](SECURITY.md).

---

## Development Setup

```bash
git clone https://github.com/DevTobis/ballast.git
cd ballast
pnpm install
cp .env.example .env   # fill in for local development
pnpm dev
```

You'll also need [Rust](https://rustup.rs/) and the
[Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup) if
you're touching `contracts/`. See `scripts/README.md` for running the contracts against a local
network or public Stellar testnet, and `TESTNET_DEPLOYMENT.md` for the current live testnet
deployment.

---

## Repo layout

This is a pnpm + Turborepo monorepo:

| Path | What |
|---|---|
| `contracts/` | Soroban (Rust) smart contracts — `common`, `registry`, `price-guard`, `pledge-vault`, `credit-line`, `exit-desk`, `repo-dvp` |
| `services/` | TypeScript backend services (`api`, `keeper`, `price-guard`, `issuer-gateway`, `indexer`, `ledger`, `margin-monitor`, `payout-hop`) |
| `packages/` | Shared TypeScript packages (`db`, `domain-types`, `network-config`, `contract-clients`, `observability`, `operator-signing`) |
| `apps/console/` | Borrower/lender web console (React) |
| `scripts/` | `deploy.sh` and `e2e-smoke.sh` — real signed-transaction deploy and smoke test, local or testnet |

---

## Workflow

1. Fork the repository and create a branch from `main`.
2. Name branches descriptively: `feat/repo-dvp-yield`, `fix/pledge-vault-release`,
   `docs/readme-update`.
3. Make your changes. Keep commits focused — one logical change per commit, with a message that
   explains *why*, not just what.
4. Run the checks for whatever you touched — see [Per-surface checks](#per-surface-checks) below.
   There is no single root command that covers both the TypeScript and Rust sides.
5. Open a pull request against `main`. Describe what changed and why, and note whether you ran the
   contract test suite, the TypeScript test suite, or both.

---

## Code Standards

- **TypeScript**: strict mode is on across the workspace. `pnpm typecheck` must pass with zero
  errors. Prefer explicit types over `any`.
- **Rust / Soroban**: contracts target `no_std`. Don't add a dependency that pulls in `std` (it
  won't compile to `wasm32v1-none`). Follow the existing pattern of documenting any deliberate
  simplification in a module-level doc comment rather than leaving it silent.
- **No mock data on the production path.** Adapters that stand in for a real integration
  (`services/*/adapters/mock*.ts`) are fine for local dev and tests, gated behind an explicit
  `*_MODE=mock` env var — but they must never be the default in a code path that claims to be
  live. If you're adding a new external integration, follow the pattern in
  `services/issuer-gateway/src/registry.ts` or `services/price-guard/src/adapters/registry.ts`
  (an explicit mode flag, fail-fast on missing config, mock/live cleanly separated).
- **Secrets**: never hardcode a key, API key, or webhook secret. Add a new env var to
  `.env.example` (with a comment explaining what it's for) instead.
- **Commits**: write a clear, specific subject line describing the change; add a body when the
  *why* isn't obvious from the diff alone. This repo doesn't enforce a specific prefix convention
  (no `feat:`/`fix:` requirement) — just be clear.

---

## Per-surface checks

Run the block for whatever you touched.

### TypeScript (`services/`, `packages/`, `apps/console/`)

```bash
pnpm build       # turbo run build — tsc -b across the workspace
pnpm typecheck   # turbo run typecheck
pnpm test        # turbo run test — vitest, per package
```

`pnpm lint` exists but isn't wired to anything yet in most packages (`echo 'no lint configured'`)
— don't rely on it catching issues; `typecheck` and `test` are what actually gate correctness
today.

### Rust (`contracts/`)

```bash
cd contracts
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

To confirm a contract actually builds to wasm (needed before any deploy):

```bash
cd contracts/<crate-name>
stellar contract build
```

### Database (`packages/db`)

If you changed `packages/db/src/schema.ts`, generate a migration and commit it alongside the
schema change:

```bash
pnpm --filter @ballast/db migrate
```

### End-to-end (`scripts/`)

If you touched contract logic or its wiring, prove it against a real network before opening a PR
where practical:

```bash
scripts/deploy.sh local        # or `testnet` — see scripts/README.md
scripts/e2e-smoke.sh local
```

This drives the contracts with real signed, submitted transactions — not simulation — and
includes a security regression check (an unrelated account cannot release someone else's
collateral).

### Which surface does my change touch?

| You changed… | Run |
|---|---|
| A service or package under `services/`/`packages/` | TypeScript block |
| `apps/console/` | TypeScript block; if the auth flow changed, also manually verify the Freighter connect flow in a browser |
| Anything under `contracts/` | Rust block, and re-run `scripts/e2e-smoke.sh` if the change affects a call this repo's scripts exercise |
| `packages/db/src/schema.ts` | TypeScript block + generate a migration |
| A deploy or smoke script | Syntax-check with `bash -n`, then run it for real against `local` before opening the PR |

---

## Pull Request Checklist

- [ ] The relevant per-surface checks above pass
- [ ] No new mock/fake data was added to a path that isn't explicitly gated behind a `mock` mode
- [ ] No secret, key, or credential was hardcoded — new config went into `.env.example`
- [ ] Docs were updated if behavior, setup steps, or env vars changed (`README.md`, the relevant
      service/package `README.md`, `TESTNET_DEPLOYMENT.md` if you redeployed)
- [ ] The PR description explains what changed and why

---

## Questions

Open an issue.
