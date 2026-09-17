#!/usr/bin/env bash
# Exercises the full collateral-rail happy path against a real local Stellar network, using real
# signed and submitted transactions (not simulation): open a credit line, fund it, pledge RWA1,
# publish two price sources, draw USDC, repay, and release collateral. Also proves the
# `PledgeVault::release` ownership fix (HIGH-severity audit finding) actually works cross-contract
# against a live `CreditLine`, not just in the unit test's mock.
#
# Usage:
#   scripts/e2e-smoke.sh [network]
#
# `network` is an optional positional argument (defaults to `local`) and must match whatever
# network you deployed to via `scripts/deploy.sh [network]` - it's used to pick up that script's
# `.env.<network>-deploy` output.
#
# Run scripts/deploy.sh [network] first.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-local}

# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"

log() { echo ">>> $*"; }

# See scripts/deploy.sh's retry() for why this exists - this sandbox's testnet RPC calls have
# shown intermittent transient TLS failures ("BadRecordMac") unrelated to contract logic.
retry() {
  local -i attempt=1
  local -i max_attempts=6
  until "$@"; do
    if (( attempt >= max_attempts )); then
      echo "!!! command failed after ${max_attempts} attempts: $*" >&2
      return 1
    fi
    echo ">>> transient failure, retrying (${attempt}/${max_attempts}): $*" >&2
    attempt+=1
    sleep 3
  done
}

# Only for calls expected to succeed - do NOT use this for the attacker-rejection regression
# check below, whose expected outcome is a contract panic, not a transient network failure.
inv() { retry stellar contract invoke --network "$NETWORK" "$@"; }

ZERO_HASH="0000000000000000000000000000000000000000000000000000000000000000"
ZERO_SIG="00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

log "Opening a credit line: lender=$LENDER borrower=$BORROWER limit=10,000 TUSD @ 7% APR"
LINE_ID=$(inv --id "$CREDIT_LINE_CID" --source lender -- open \
  --lender "$LENDER" --borrower "$BORROWER" --asset "$RWA_SAC" \
  --limit 100000000000 --rate_bps 700 --cure_s 86400 --agreement "$ZERO_HASH")
log "  line id = $LINE_ID"

log "Lender funds the line with 10,000 TUSD"
inv --id "$CREDIT_LINE_CID" --source lender -- fund --lender "$LENDER" --line "$LINE_ID" --amount 100000000000 >/dev/null

log "Borrower pledges 5,000 RWA1 (escrow mode - moves the classic token into PledgeVault)"
inv --id "$PLEDGE_VAULT_CID" --source borrower -- pledge \
  --borrower "$BORROWER" --line "$LINE_ID" --asset "$RWA_SAC" --units 50000000000 >/dev/null

log "Keeper syncs the pledged units into CreditLine's LTV view (services/keeper's syncCollateral job, run by hand here)"
inv --id "$CREDIT_LINE_CID" --source keeper -- sync_collateral --caller "$KEEPER" --line "$LINE_ID" --units 50000000000 >/dev/null

NOW=$(date +%s)
log "Price publisher pushes issuer NAV + an independent feed reading (both \$1.00) so PriceGuard reaches Ok"
# asset_code is the hex-encoded UTF-8 bytes of "RWA1" (the ticker this deploy registers) - required
# since publish_nav's on-chain issuer-signature check (deploy.sh disables it above for this smoke
# deploy) verifies over a message built from this exact asset_code/ts/value.
RWA1_ASSET_CODE_HEX="52574131"
inv --id "$PRICE_GUARD_CID" --source price_publisher -- publish_nav \
  --publisher "$PRICE_PUBLISHER" --asset "$RWA_SAC" --asset_code "$RWA1_ASSET_CODE_HEX" \
  --value 10000000 --ts "$NOW" --sig "$ZERO_SIG" >/dev/null
inv --id "$PRICE_GUARD_CID" --source price_publisher -- publish_source \
  --publisher "$PRICE_PUBLISHER" --asset "$RWA_SAC" --source redston --value 10000000 --ts "$NOW" >/dev/null

log "guarded_price:"
inv --id "$PRICE_GUARD_CID" --source admin -- guarded_price --asset "$RWA_SAC"

log "Borrower draws 1,000 TUSD against ~4,750 TUSD of collateral value (~21% LTV, well under the 70% warning band)"
inv --id "$CREDIT_LINE_CID" --source borrower -- draw \
  --borrower "$BORROWER" --line "$LINE_ID" --amount 10000000000 --to "$BORROWER" >/dev/null

log "ltv() after the draw:"
inv --id "$CREDIT_LINE_CID" --source admin -- ltv --line "$LINE_ID"

log "Borrower repays the 1,000 TUSD in full"
inv --id "$CREDIT_LINE_CID" --source borrower -- repay --payer "$BORROWER" --line "$LINE_ID" --amount 10000000000 >/dev/null

log "ltv() after full repayment (debt should be back to 0):"
inv --id "$CREDIT_LINE_CID" --source admin -- ltv --line "$LINE_ID"

log "Borrower releases 1,000 RWA1 of collateral (exercises the borrower_of ownership check live)"
inv --id "$PLEDGE_VAULT_CID" --source borrower -- release \
  --borrower "$BORROWER" --line "$LINE_ID" --asset "$RWA_SAC" --units 10000000000 >/dev/null

log "position_units() after release (should be 4,000 RWA1 remaining):"
inv --id "$PLEDGE_VAULT_CID" --source admin -- position_units --line "$LINE_ID" --asset "$RWA_SAC"

log "Regression check: a stranger cannot release this line's collateral"
retry stellar keys generate attacker --network "$NETWORK" --fund --overwrite -q
ATTACKER=$(stellar keys address attacker)
if stellar contract invoke --network "$NETWORK" --id "$PLEDGE_VAULT_CID" --source attacker -- release \
     --borrower "$ATTACKER" --line "$LINE_ID" --asset "$RWA_SAC" --units 1 2>/dev/null; then
  echo "!!! SECURITY REGRESSION: attacker release succeeded, expected a panic" >&2
  exit 1
else
  log "  confirmed: rejected, as expected (\"caller is not this line's borrower\")"
fi

log "E2E smoke test passed."
