# Ballast

Five Stellar RWA ideas, and the companies they should become.

Ballast is the weight in a ship's hull that lets it carry a load without tipping over. Stellar
holds about **$4B** of tokenized real-world assets that just sit there. Only about $2M is used
in Blend and about $8.4M in Templar (SDF Dune dashboard; RedStone, 2026-08). These ideas turn
that idle weight into something that moves money.

Two ideas are not here. Idea 4 (compliance-preserving RWA bridging) lives on Xebra's roadmap:
`../xebra/docs/roadmap.md`. Idea 6 (DTCC readiness) is its own company and repo:
`../concord/`.

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
network for anchors), with RWAs as the collateral. It shares anchor customers with Xebra's RWA
bridge and with `stellar-intel`.

### Company 2 — **Concord** (idea 6, stand-alone, now `../concord/`)

**What it is:** reconciliation between on-chain token events and the official books kept by
transfer agents and custodians, starting with DTCC's Stellar connection.

It stands alone because nothing important is shared with Ballast:

| | Ballast | Concord |
|---|---|---|
| Buyer | anchors, fintechs, market makers | transfer agents, custodians, fund administrators |
| Handles money | yes: custody partner, balance sheet | **no**: read-only software |
| Regulatory load | heavy (lending, repo) | light (vendor to regulated firms) |
| Core skill | credit, liquidity, contracts | data, indexing (CAP-67 events), accounting |
| Timing | now | DTCC targets H1 2027: build now, sell then |
| Revenue | spread, fees on volume | SaaS seats and per-asset fees |

Putting it inside Ballast would slow both. The sales cycle, the buyer and the risk profile are
different. Concord can also serve issuers Ballast never touches (BENJI, WisdomTree, Spiko). It
does not depend on RWAs being used in DeFi at all, so it survives if Ballast's core assumption
fails.

## Portfolio

| Company | Ideas | Status |
|---|---|---|
| **Xebra** | 4 — RWA bridging | on Xebra's roadmap, after the USDC corridor goes live |
| **Ballast** | 1, 2, 3, 5 | strongest fit with the corridor thesis; needs a custody partner |
| **Concord** | 6 | stand-alone; timed to DTCC H1 2027 |

## What decides whether Ballast is real

One question from the research is unanswered: **why is $4B of Stellar RWA supply not used in
DeFi?**

- If issuers block transfers, collateral cannot move: Ballast must go through the issuer.
- If the cause is missing oracles and risk settings after the USTRY exploit: Ballast's pricing
  layer is the product.
- If institutions simply do not want it: stop, and put the effort into Concord.

Ask 2–3 anchors and one issuer (Spiko or Etherfuse) before writing code.

Names are working names. Check trademarks and domains before using them publicly.
