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

Choose the setup path matching your contribution:

### Path A: Logic-only work (Recommended for most contributors)

For changes to backend services, shared packages, the web console, or contract unit tests, you do not need to run a live network or deploy contracts. Unit tests run offline against test doubles and recorded fixtures:

```bash
git clone https://github.com/DevTobis/ballast.git
cd ballast
pnpm install
pnpm build
pnpm test                  # runs the Vitest suite across all services and packages
```

If you are working on contracts:

```bash
cd contracts
cargo test --workspace     # tests all contract logic on the host target (no CLI or network needed)
```

### Path B: Full stack (Contracts + Services + Console + E2E)

If you are developing or verifying on-chain behavior end-to-end against a live network:

```bash
git clone https://github.com/DevTobis/ballast.git
cd ballast
pnpm install
scripts/deploy.sh testnet      # builds/deploys contracts, generates & funds your own role keys (~2-3 min)
scripts/dev-setup.sh testnet   # starts Postgres container, generates .env, runs migrations & seeds
pnpm dev                       # starts all services + console at http://localhost:5173
scripts/e2e-services.sh        # optional: drive the full collateral rail, exit desk, and repo flows
```

> [!NOTE]
> **Documented live deployment is read-only for outsiders:** The live testnet deployment documented in [`TESTNET_DEPLOYMENT.md`](TESTNET_DEPLOYMENT.md) is for public reference and audit only. Its role keys reside exclusively in the original deployer's local Stellar CLI identity store. Outside contributors running the full stack must deploy their own contracts using `scripts/deploy.sh testnet` (or `local`), which creates and funds local identities via friendbot.

---

## Toolchain & Prerequisites

Depending on the scope of your changes, ensure the following tools and minimum versions are available on your system:

| Tool | Minimum Version | Required For | Notes |
|---|---|---|---|
| **Node.js** | `>= 22.12` | All TypeScript packages & services | Monorepo root engine requirement |
| **pnpm** | `>= 9.0` (uses `10.22.0`) | Package management | Core workspace package manager |
| **Rust & Cargo** | Stable toolchain | Smart contracts (`contracts/`) | Managed via `rustup` |
| **`wasm32v1-none` target** | Current stable | Building contracts to WASM | Install with `rustup target add wasm32v1-none` |
| **Stellar CLI (`stellar`)** | `>= 25.2` (CI uses `28.1.0`) | Contract builds & deployments | Install from [Stellar CLI docs](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup) |
| **Docker or Podman** | Any modern version | Local Postgres (`ballast-pg`) | Required by `scripts/dev-setup.sh` |
| **Bash** | `>= 4.0` | Deployment & E2E scripts | Scripts use associative arrays (`declare -A`) and `mapfile` |
| **Python 3** | `>= 3.9` | Deployment scripts | Used for JSON parsing and base32/hex key derivations |
| **curl** | Standard | Scripts & network checks | Used for Horizon balance queries and network health checks |
| **OpenSSL** | Standard | Security & scripts | Used for random token and key generation |

If `scripts/doctor.sh` is present in the repository, you can run it to verify your local toolchain setup.

---

## Repo layout

This is a pnpm + Turborepo monorepo:

| Path | What |
|---|---|
| `contracts/` | Soroban (Rust) smart contracts — `common`, `registry`, `price-guard`, `pledge-vault`, `credit-line`, `exit-desk`, `repo-dvp` |
| `services/` | TypeScript backend services (`api`, `keeper`, `price-guard`, `issuer-gateway`, `indexer`, `ledger`, `margin-monitor`, `payout-hop`) |
| `packages/` | Shared TypeScript packages (`db`, `domain-types`, `network-config`, `contract-clients`, `observability`, `operator-signing`) |
| `apps/console/` | Borrower/lender web console (React) |
| `scripts/` | Deploy (`deploy.sh`, `redeploy-price-guard.sh`, `deploy-mainnet-prices.sh`), local setup (`dev-setup.sh`), the e2e drills (`e2e-smoke.sh`, `e2e-services.sh`, `e2e-liquidation.sh`, `e2e-repo-margin.sh`), and the no-mock CI gate (`check-no-mocks.sh`). See `scripts/README.md` |
| `deploy/` | Single-host production compose file and Caddyfile. See `deploy/README.md` |

How the pieces fit together is in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every service and package has
its own `README.md` with its environment variables and tests.

---

## Which kind of contribution is it?

You do not need the whole stack running for most changes.

| You are changing | What you need |
|---|---|
| A contract | Rust and `cargo test --workspace` in `contracts/`. No network, no Docker |
| A service or package's logic | Node, pnpm and `pnpm test`. Unit tests use test doubles and recorded fixtures |
| The console | Node, pnpm and `pnpm --filter ./apps/console test` |
| Docs | Nothing |
| On-chain behaviour end to end | The full stack: Stellar CLI, Docker or Podman, a funded testnet deployment, `scripts/e2e-*.sh` |

If the full stack misbehaves, check [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) first: testnet RPC is flaky
and several failures are not bugs.

---

## Issues and labels

Use the issue templates. Maintainers apply labels from [`.github/labels.yml`](.github/labels.yml):

- `good first issue`: small, well-scoped, no live network needed.
- `help wanted`: a PR would be welcome.
- `area:*`: `contracts`, `services`, `packages`, `console`, `infra`.
- `needs-testnet`: verifying it needs the deployed stack.
- `security-adjacent`: touches signing, auth, pricing or fund movement and gets extra review. Real
  vulnerabilities go through [SECURITY.md](SECURITY.md), never an issue.

Comment on an issue before starting so two people do not do the same work. A PR should close one issue.

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
- **No mock data anywhere in `src`.** Services read real sources only (see
  `services/price-guard/src/adapters/`); there is no `mock` mode and no fake adapter to fall back
  on (`scripts/check-no-mocks.sh` runs in CI and fails if one comes back). A source that is unavailable or unconfigured must fail loudly or skip the asset, never answer
  with a made-up value. Test doubles belong in `*.test.ts` files, and anything they replay from an
  external API should be a response recorded from the real endpoint (`__fixtures__/`), not
  hand-written. A new integration should fail fast on missing config and alert on a failed fetch,
  as `services/price-guard/src/pipeline.ts` does.
- **Secrets**: never hardcode a key, API key, or webhook secret. Add a new env var to
  `.env.example` (with a comment explaining what it's for) instead.
- **Commits**: write a clear, specific subject line describing the change; add a body when the
  *why* isn't obvious from the diff alone. The history uses Conventional Commit style with a scope,
  e.g. `fix(price-guard): evaluate on every publish`, `feat(api): webhook subscriptions`,
  `docs: …`, `test(e2e): …`. Please match it. It is not enforced by tooling.

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
cargo test --workspace      # this is what CI runs
cargo fmt --check           # not in CI, and currently fails on main (pre-existing diffs)
cargo clippy --all-targets -- -D warnings   # not in CI
```

CI runs the contract tests and separately builds each deployable contract to WASM. The WASM job
fails if a contract does not compile for `wasm32v1-none`, if an expected artifact is missing, or if
an artifact exceeds the shared **100 KiB per-contract budget**. It prints each artifact's size in
the GitHub Actions job summary. The budget is defined once in
[`scripts/check-contract-wasm-size.sh`](scripts/check-contract-wasm-size.sh) as
`WASM_SIZE_BUDGET_BYTES` (default `102400`); adjust that value there if the contracts' size
requirements change.

To run the same check locally, install the Rust `wasm32v1-none` target and Stellar CLI, then run:

```bash
scripts/check-contract-wasm-size.sh
```

You can temporarily override the shared budget for a local run with
`WASM_SIZE_BUDGET_BYTES=120000 scripts/check-contract-wasm-size.sh`.

`cargo fmt --check` already reports differences on `main`, so do not reformat whole files in an
unrelated PR: format only the files you changed (`rustfmt <file>`), or send a formatting-only PR on
its own. Wiring `fmt` and `clippy` into CI is an open task.

To confirm a contract actually builds to wasm (needed before any deploy):

```bash
cd contracts/<crate-name>
stellar contract build
```

### Database (`packages/db`)

If you changed `packages/db/src/schema.ts`, generate a migration and commit it alongside the
schema change:

```bash
pnpm --filter @ballast/db migrate:generate   # writes the SQL migration; commit it
pnpm --filter @ballast/db migrate            # applies migrations to your local database
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
| A service's on-chain behaviour, `services/api` routes, or `@ballast/contract-clients` | TypeScript block, then `scripts/e2e-services.sh` against a running stack |
| A deploy or smoke script | Syntax-check with `bash -n`, then run it for real against `local` before opening the PR |

---

## Pull Request Checklist

- [ ] The relevant per-surface checks above pass
- [ ] No mock/fake data was added outside test files
- [ ] No secret, key, or credential was hardcoded — new config went into `.env.example`
- [ ] Docs were updated if behavior, setup steps, or env vars changed (`README.md`, the relevant
      service/package `README.md`, `TESTNET_DEPLOYMENT.md` if you redeployed)
- [ ] The PR description explains what changed and why

---

## Questions

Open an issue.
