# 2 — Intraday DvP repo

**Company:** Ballast (third product, after 1 and 3)

## Problem

Holders of tokenized Treasuries who need USDC for hours must sell and buy back later. Lenders
with idle USDC have nowhere safe to lend against Treasuries on Stellar.

## Evidence

- Broadridge's DLR averaged **$351B/day** of tokenized repo in August 2026, and expanded to G7
  securities with cross-border atomic settlement (press release, 2026-09-02). It is not on
  Stellar.
- No Stellar-native repo found (absence of evidence).

## Product

An atomic delivery-versus-payment contract. Leg 1 swaps Treasury tokens for USDC. Leg 2 reverses
at a set time with interest. Margin calls use the same NAV-and-haircut pricing as idea 1.

## Why not alone

Same escrow, pricing and counterparties as idea 1. A pledge and a repo are two legal wrappers on
one engine. Repo also needs two-sided flow, which idea 1's anchor network supplies.

## Kill criteria

- Legal: title-transfer repo of fund shares is not allowed for the target issuers.
- Counterparties insist on a regulated repo venue (DLR, Kinexys) and won't use a Soroban
  contract.
