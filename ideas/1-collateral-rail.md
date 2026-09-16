# 1 — Collateral rail for anchors

**Company:** Ballast (core product, build first)

## Problem

Anchors and payment fintechs lock cash in prefunding accounts at every corridor endpoint. That
cash earns nothing. Their treasury often already holds tokenized T-bills or MMF shares on
Stellar (Spiko, BENJI, USDY, CETES, YLDS), but those cannot back a prefunding or FX credit line.

## Evidence

- Stellar RWA supply is $3.996B (2026-08-29). Utilisation in DeFi is about $2M in Blend and
  about $8.4M in Templar.
- The model runs elsewhere. Binance × Franklin Templeton (live, Feb 2026) lets institutions post
  BENJI MMF shares as off-exchange collateral while Ceffu keeps custody.
- No Stellar equivalent was found. That is absence of evidence, not a confirmed gap.

## Product

A Soroban pledge escrow. The anchor locks RWA tokens and receives a USDC credit line (or
prefunding) at a haircut.

- Respects issuer controls: the escrow is an authorised holder, or the pledge is a lien that
  leaves tokens in place with the custodian.
- Pricing: issuer NAV, a haircut, and a circuit breaker if the price moves outside a band.
- Default path: liquidate through issuer redemption, not an AMM.

## Needs

A regulated lender or custodian partner. Issuer consent for escrow authorisation. One anchor as
a design partner.

## Kill criteria

- No issuer will authorise a pledge escrow.
- Anchors cannot use pledged assets under their licence.
- A custodian (Anchorage, Fireblocks, Copper) ships this for Stellar first.
