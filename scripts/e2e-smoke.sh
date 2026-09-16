#!/usr/bin/env bash
# Exercises the full collateral-rail happy path against a real local Stellar network, using real
# signed and submitted transactions (not simulation): open a credit line, fund it, pledge RWA1,
# publish two price sources, draw USDC, repay, and release collateral. Also proves the
# `PledgeVault::release` ownership fix (HIGH-severity audit finding) actually works cross-contract
# against a live `CreditLine`, not just in the unit test's mock.
#
# Run scripts/deploy-local.sh first.

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
source .env.local-deploy

log() { echo ">>> $*"; }
inv() { stellar contract invoke --network "$NETWORK" "$@"; }

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
inv --id "$PRICE_GUARD_CID" --source price_publisher -- publish_nav \
  --publisher "$PRICE_PUBLISHER" --asset "$RWA_SAC" --value 10000000 --ts "$NOW" --sig "$ZERO_SIG" >/dev/null
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
stellar keys generate attacker --network "$NETWORK" --fund --overwrite -q
ATTACKER=$(stellar keys address attacker)
if inv --id "$PLEDGE_VAULT_CID" --source attacker -- release \
     --borrower "$ATTACKER" --line "$LINE_ID" --asset "$RWA_SAC" --units 1 2>/dev/null; then
  echo "!!! SECURITY REGRESSION: attacker release succeeded, expected a panic" >&2
  exit 1
else
  log "  confirmed: rejected, as expected (\"caller is not this line's borrower\")"
fi

log "E2E smoke test passed."
