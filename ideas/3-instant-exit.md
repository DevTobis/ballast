# 3 — Instant exit at corridor endpoints

**Company:** Ballast (second product)

## Problem

A holder of a tokenized MMF or bond on Stellar who needs to pay someone must wait for the
issuer's redemption window, then move the cash. Payment corridors can't use the asset directly.

## Evidence

- Instant-redemption facilities exist elsewhere (BlackRock BUIDL ↔ USDC; Ondo instant
  redemptions). Their demand was **not verified** in this research.
- None found on Stellar (absence of evidence).

## Product

Swap an RWA token for USDC or a local stablecoin at a small discount, instantly. Ballast takes
the token and redeems it with the issuer on the normal schedule. Plugs into anchors as a
funding source for a payout.

## Why not alone

The USDC paid out has to be funded. Standing alone, this is a thin-margin liquidity provider
with expensive capital. Inside Ballast it is funded by the collateral pool (1) and the repo desk
(2), and it shares their pricing and issuer relationships.

## Overlap

Octarine (SCF #44, $129.7K) builds RFQ secondary liquidity for Stellar RWAs. Treat it as a
possible LP partner, not a head-on rival: Octarine is trader-facing, this is payment-facing.

## Kill criteria

- Issuers already offer same-day on-chain redemption on Stellar.
- The discount needed to cover funding and redemption lag is too large for payment users.
