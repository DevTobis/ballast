# Ballast

Five Stellar RWA ideas, and the companies they should become.

Ballast is the weight in a ship's hull that lets it carry a load without tipping over. Stellar
holds about **$4B** of tokenized real-world assets that just sit there. Only about $2M is used
in Blend and about $8.4M in Templar (SDF Dune dashboard; RedStone, 2026-08). These ideas turn
that idle weight into something that moves money.

Two ideas are not here: idea 4 (compliance-preserving RWA bridging) and idea 6 (DTCC readiness)
are out of scope for this repo.

The build plan for Ballast is [`PRD.md`](./PRD.md).

Source research: the three Stellar RWA diligence runs dated 2026-09-16. Figures are cited in
each idea file.

## The ideas

| # | Idea | File |
|---|---|---|
| 1 | Collateral rail for anchors: pledge tokenized T-bills / MMFs for corridor prefunding and FX lines | [`ideas/1-collateral-rail.md`](./ideas/1-collateral-rail.md) |
| 2 | Intraday DvP repo: tokenized Treasuries against USDC, one atomic contract | [`ideas/2-intraday-repo.md`](./ideas/2-intraday-repo.md) |
| 3 | Instant exit: RWA token to USDC or local stablecoin at corridor endpoints | [`ideas/3-instant-exit.md`](./ideas/3-instant-exit.md) |
| 5 | LATAM treasury: EM sovereign bonds (TESOURO, CETES) and YLDS as fintech treasury holdings | [`ideas/5-latam-treasury.md`](./ideas/5-latam-treasury.md) |

## Verdict: two companies, not five

### Company 1 — **Ballast** (ideas 1, 2, 3 and 5 combined)

**What it is:** a collateral and liquidity network that lets Stellar anchors and fintechs use
tokenized Treasuries as working capital.

These four are one company because they are **one engine sold four ways**:

| Shared piece | 1 Collateral | 2 Repo | 3 Exit | 5 LATAM |
|---|---|---|---|---|
| Soroban escrow that respects `AUTH_REQUIRED`, clawback and SEP-57 checks | pledge lock | DvP leg | swap leg | holds treasury |
| RWA pricing: NAV plus a haircut and a circuit breaker (the YieldBlox/USTRY exploit is the reason) | haircut | repo margin | exit price | mark-to-market |
| Regulated custody / counterparty partner | needed | needed | needed | needed |
| USDC balance sheet or LP capital | lends it | lends it | pays it out | redeems into it |
| Customer | anchors | anchors, market makers | anchor end users | LATAM fintechs (often the same anchors) |

- **Idea 2 is idea 1 with a clock.** A pledge is a security interest. A repo transfers title
  and buys it back later. Same escrow, same haircut, same counterparties.
- **Idea 3 only exists if someone funds it.** The USDC paid out on instant exit has to come from
  somewhere, and the repo desk (idea 2) is where it comes from. As a company on its own, idea 3
  is an LP with no cheap funding.
- **Idea 5 is the go-to-market, not a product.** TESOURO on Stellar is about $400k and 94
  holders. That is too thin to carry a company. It is, though, the best first market for ideas
  1–3: LATAM fintechs are anchors, they need prefunding, and the assets already sit on Stellar.

**Build order:** 1 (collateral rail with one anchor and one asset) → 3 (exit, funded by the
collateral pool) → 2 (repo, once there are two sides to match) → 5 (sell the bundle to LATAM
fintech treasuries).

**Overlap:** this is the direction chosen on 2026-09-09 (a corridor liquidity + compliance
network for anchors), with RWAs as the collateral.

## Portfolio

Ballast: strongest fit with the corridor thesis; needs a custody partner.

## What decides whether Ballast is real

One question from the research is unanswered: **why is $4B of Stellar RWA supply not used in
DeFi?**

- If issuers block transfers, collateral cannot move: Ballast must go through the issuer.
- If the cause is missing oracles and risk settings after the USTRY exploit: Ballast's pricing
  layer is the product.
- If institutions simply do not want it: stop — this repo's core assumption doesn't hold.

Ask 2–3 anchors and one issuer (Spiko or Etherfuse) before writing code.

Names are working names. Check trademarks and domains before using them publicly.

## Running it

Ideas 1-3 run end to end today: six contracts on Stellar testnet, eight services, Postgres, and a
web console. You need Node >= 22.12, pnpm, the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli), and Docker or Podman.

```bash
pnpm install
scripts/deploy.sh testnet      # deploys your own contracts and creates funded role keys
scripts/dev-setup.sh testnet   # Postgres, .env, migrations, seeded lender/borrower/asset
pnpm dev                       # all services + console on http://localhost:5173
scripts/e2e-services.sh        # collateral rail, exit desk and repo, through the API
scripts/e2e-liquidation.sh     # price falls, the services liquidate a line on their own
```

The documented deployment in [`TESTNET_DEPLOYMENT.md`](TESTNET_DEPLOYMENT.md) is for reference and audit; its admin keys reside in the original deployer's key store, so outside contributors deploy their own contracts via `scripts/deploy.sh testnet`.

How a transaction flows: `services/api` builds unsigned XDR and records what it means
(`tx_intent`); the customer signs it in their own wallet (Freighter in the console); the signed
envelope comes back through `POST /v1/tx/submit`, and once the ledger closes the API updates the
books. A background sweep settles anything submitted another way and writes off transactions that
were never signed.

Around that: `services/price-guard` keeps the on-chain price fresh; `services/keeper` syncs
pledged collateral into the credit line, accrues interest, runs repo margin calls and defaults, unwinds
repos at maturity and runs liquidations;
`services/margin-monitor` records margin-state changes; `services/indexer` mirrors contract
events. [`scripts/README.md`](scripts/README.md) has the details and what is not covered. Prices come
from real sources (Etherfuse and Spiko NAV APIs, RedStone's on-chain feeds); NAV is signed by
Ballast's own publisher key, not by issuers, since no issuer signs it.

## Documentation

| Read | For |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the contracts, services and packages fit together, and where to start for a change |
| [`TESTNET_DEPLOYMENT.md`](TESTNET_DEPLOYMENT.md) | The live testnet deployment and what each drill proved |
| [`contracts/README.md`](contracts/README.md), [`contracts/AUDIT_NOTES.md`](contracts/AUDIT_NOTES.md) | Contract design, trust model and invariants |
| [`scripts/README.md`](scripts/README.md) | Deploying and running the e2e drills |
| [`deploy/README.md`](deploy/README.md) | Single-host production deployment |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | Flaky RPC, port clashes, `Degraded` prices, redeploy traps |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed and when |
| `services/*/README.md`, `packages/*/README.md` | Per-component env vars, endpoints and tests |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development setup, repo layout, and per-surface
checks (TypeScript and Rust/Soroban). All contributors are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue? See
[`SECURITY.md`](SECURITY.md) — please don't open a public issue for it.

Ballast is [MIT licensed](LICENSE).
