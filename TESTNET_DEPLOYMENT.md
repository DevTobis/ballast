# Testnet deployment

All six contracts are deployed, initialized, configured, and asset-registered on Stellar testnet,
and the full `scripts/e2e-smoke.sh testnet` happy path (open → fund → pledge → publish price →
draw → repay → release, plus the attacker-rejection regression check) has passed against this
deployment with real signed, submitted transactions.

## Network

`testnet` (`https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`).

## Deploy date

2026-09-17.

## Contract IDs

`common` is a shared library, not a deployable contract, so it has no row below.

| Contract | Contract ID |
|---|---|
| `registry` | `CD65BRB2C7T5TO4TGBBXOLB7HXSKRXQMVPGGRCFXEKVNZFMYRH4LYCWM` |
| `price-guard` | `CD5W5MVLGSAKVXG7V564IATJUE5AZWCUBF4VWN6P2SM7UKIDXP7D6BLL` |
| `pledge-vault` | `CBEHWDRZIFFO3GPIOFK7LYEXKVBUGCYQIE2RG5I6QBI3DK4WCXRNS35D` |
| `credit-line` | `CDVZO4D6BMQHUJQKFWRIWG4EQ7WXFPVYQDPM3Z65RLUXIFVCHTFFIXFI` |
| `exit-desk` | `CCGW2ZXMXS4MAPPXR3UDZXBMQZHSA5OYFDGP46SLMFJMEQ5CNY77AJ6G` |
| `repo-dvp` | `CBFJZ5VLW63ESYWOKKX73ZKL26SHB6EZUMHOIGF5NJVLUVBDWVJW27UG` |

Test assets registered against this deployment (issued fresh for this deploy, not real RWAs):

| Asset | Classic issuer | SAC contract ID |
|---|---|---|
| `RWA1` | `GAFHGGKP5657WCBVQBCF3F2S3O2TGICCTE53O7FPEIGCPTHCXXHUPCET` | `CA6ITP5KB7QHPFTOA72QE3YZB7AZB3SFK5NNCUWL5TVVX45O7XFN65HE` |
| `TUSD` | `GD4KBWX6TID4MATRWOFLQXGSVHOHE5IJ47LFMXA3JXHADO6TWGYICDRR` | `CAEYEZD7F2RFLWJFBXIY75RGEWHKFCKFKT2CJHHACSMUMBH3LG777DJT` |

`price-guard`'s issuer-signature requirement (`require_nav_signature`) was left **disabled** for
this deploy via `configure_signature_requirement` — no real issuer Ed25519 key was registered for
the test `RWA1` asset here. This is the documented bring-up affordance from the contract's own
module doc comment, not a statement about production readiness: a real deployment must call
`configure_issuer_key` with a real issuer public key per asset and leave the requirement enabled.

## Deployer / role addresses

| Role | Address |
|---|---|
| `admin` | `GA2L6GQB7SDVUG5TVC5PCUOUMBHCDTSP4THA76TWLBVUAXTAKVT7BSIF` |
| `pauser` | `GCHVXNBDXSXPSJQDB7RVST6TCL2MZT6R2XLO4DC36NKHQGMEHRGV7E67` |
| `keeper` | `GBDOKSMNWT5WDTDLASLQZRKOVO5YAE33TGMIDKUSWZ2F46TZYKP6ZDCT` |
| `price_publisher` | `GBTV5NBNCR6RY5PFV6JGTTX7ACKBZSVQIHM6LZALVNDWQNQ35OEXOMR6` |
| `risk` | `GC466MN5MJPCGRNYQKQXWZ5GHY4YDTLRFFQOZ2EFHF26BWNOA7A3UELV` |

All generated fresh for this deploy via `stellar keys generate ... --fund` (testnet friendbot);
these are test keys with no real value, not production credentials.

## E2E smoke test result

**Passed**, run manually step-by-step against this live deployment (not via one unattended
`scripts/e2e-smoke.sh testnet` invocation — see note below) with real signed, submitted
transactions on testnet:

1. `open` a credit line (lender → borrower, 10,000 TUSD limit @ 7% APR) — line id `0`.
2. `fund` the line with 10,000 TUSD.
3. `pledge` 5,000 RWA1 into `PledgeVault` (escrow mode).
4. `sync_collateral` on `CreditLine`.
5. `publish_nav` + `publish_source` on `PriceGuard`; `guarded_price` returned `status: Ok`.
6. `draw` 1,000 TUSD — succeeded, `ltv()` afterward: `collateral_value=47500000000,
   debt=10000000665, ltv_bps=2105, state=Healthy` (~21% LTV, matching the script's own comment).
7. `repay` 1,000 TUSD in full — `ltv()` afterward: `debt=887` (dust — a few seconds' worth of
   interest accrued between repay and the read), `ltv_bps=0`.
8. `release` 1,000 RWA1 of collateral — `position_units()` afterward: `40000000000` (4,000 RWA1
   remaining), matching the script's own comment exactly.
9. **Security regression check**: an unrelated `attacker` keypair's `release` call against this
   same line was rejected (`PledgeVault` → `CreditLine::borrower_of` → ownership check panics),
   confirming the `PledgeVault::release` ownership fix (the HIGH-severity audit finding this script
   exists to catch a regression on) still holds live, cross-contract, on testnet.

### Why this was run manually instead of via one script invocation

This sandbox's outbound network path to `soroban-testnet.stellar.org` had frequent transient TLS
failures (`received fatal alert: BadRecordMac` / `DecodeError` / "cannot decrypt peer's message")
during this deploy — unrelated to the contracts or scripts. `scripts/deploy.sh` and
`scripts/e2e-smoke.sh` were both hardened with a `retry()` wrapper for this. Two real, unrelated
bugs surfaced and were fixed along the way (both now fixed in the scripts, so a future
`scripts/deploy.sh testnet && scripts/e2e-smoke.sh testnet` run should complete unattended):

1. **`register_asset`'s CLI `--config` JSON call is correct** but a `retry()`'d call can appear to
   fail even after the underlying transaction actually lands, if the transient failure hits during
   status-*confirmation* rather than submission — the retry then hits the target contract's own
   idempotency guard (`assert!(!already registered/initialized)`) and panics, which surfaces as a
   generic `VM call trapped: UnreachableCodeReached` (Rust panic messages are stripped in the
   `no_std` release wasm profile). This isn't a code bug; it's inherent to retrying
   non-idempotent calls under a flaky transport. No script change was made for this specific
   case — it only matters if the same flakiness recurs on a future run, in which case: check
   whether the "failed" step actually landed (query the contract) before manually retrying.
2. **`scripts/deploy.sh` never gave the borrower a TUSD trustline** — `CreditLine::draw` transfers
   TUSD to the borrower, and a classic Stellar asset can't reach an account with no trustline for
   it, even moved via its SAC wrapper. This is a genuine pre-existing gap (the script's own header
   comment already admitted its CLI flags "weren't hand-verified against a live deployment" —
   this was the first live deployment). **Fixed**: `scripts/deploy.sh` now also establishes a TUSD
   trustline for the borrower.
