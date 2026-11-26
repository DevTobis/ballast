# Changelog

All notable changes to Ballast. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Ballast is pre-audit, testnet-only software and has no tagged releases yet; entries are grouped by date.

## [Unreleased]

### Added
- Contributor documentation: `ARCHITECTURE.md`, `TROUBLESHOOTING.md`, issue and PR templates,
  `CODEOWNERS`, a label set, per-service and per-package READMEs.

### Changed
- **Breaking (`pledge-vault` ABI, #180):** `PledgeVault::configure_asset` now takes only
  `admin, asset, credit_line, custody_mode`; its `price_guard`, `haircut_bps` and `thresholds`
  arguments are gone, and `asset_configured` carries `(credit_line, custody_mode)`. `release`
  checks post-release health with the new `CreditLine::ltv_after(line, new_units)`, so CreditLine's
  risk config is the only one. `scripts/deploy.sh` and `scripts/redeploy-price-guard.sh` are
  updated; an existing deployment needs PledgeVault redeployed (stored `AssetConfig` changed shape).

## 2026-10-09

### Fixed
- `services/api` honours `X-Forwarded-For` behind a trusted proxy (`TRUST_PROXY`).
- Deploy env template header.

## 2026-10-08

Full testnet redeployment of all six contracts; all four e2e drills pass against it
(see `TESTNET_DEPLOYMENT.md`).

### Added
- `repo-dvp`: borrower cure path, fair default netting, admin-set cure window, keeper margin job.
- `credit-line`: lender withdrawals and a closing step for liquidated lines.
- `services/api`: database-backed institution API keys with signed, single-use requests; webhook
  subscriptions with a retrying outbox and dead-letter queue; webhook events for exit fills, closed
  liquidations and repo leg 1; KYB and OFAC sanctions gate; secrets readable from `NAME_FILE`.
- `services/indexer`: idempotent event ingestion and RPC retries.
- `services/price-guard`: real sources only (Etherfuse and Spiko NAV, RedStone feeds); public
  `GET /v1/public/markets` page in the console.
- `packages/operator-signing`: Vault AppRole with token renewal, timeouts, retries and a signature
  self-check; `signMessage` for raw Ed25519 signatures.
- `packages/observability`: webhook alerts with cooldown and operator-balance watch.
- `scripts/deploy-mainnet-prices.sh`: mainnet price layer only (`registry` + `price-guard`).
- Retry of transient Soroban RPC failures; shared internal-service auth helpers.
- CI: typecheck, tests, `cargo test` and a no-mock gate. Console tests (vitest + testing-library).
- E2E drills: liquidation, repo margin, release-then-draw regression.

### Changed
- `price-guard` evaluates on every publish and refuses future-dated and non-positive readings.
- `pledge-vault` / `credit-line`: collateral is reported to the credit line in the same transaction.
- `network-config` refuses a network name that disagrees with its passphrase.
- Mock adapters removed from `issuer-gateway`; there is no mock mode anywhere in shipped code.
- Session JWT algorithm pinned; `iss`/`aud`/`jti` added; dev-login refused in production.

### Fixed
- `services/api` scopes reads and writes to the parties they belong to.
- `payout-hop` and `issuer-gateway` authenticate, bind to loopback, and `payout-hop` bounds what it can pay.
- One `price_observation` row per distinct reading.

## 2026-09-17

### Added
- Real SEP-10 authentication, KMS signing and a verified testnet deployment, replacing mocked adapters.
- Standard OSS files (`LICENSE`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`).

## 2026-09-16

### Added
- Initial scaffold: Soroban contracts, TypeScript services, Postgres schema, borrower/lender console,
  local deploy and smoke-test scripts, and fixes from a full-repo audit.
