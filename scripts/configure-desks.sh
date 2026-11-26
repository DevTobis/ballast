#!/usr/bin/env bash
# Second half of a deployment: configures the two contracts `deploy.sh`'s collateral-rail wiring
# doesn't touch - `ExitDesk` (asset config + a USDC float to pay exits from) and `RepoDvp` (cash
# token + asset config) - and sets up the classic-asset plumbing the exit, repo and liquidation
# flows need (trustlines, a little test cash). `deploy.sh` runs this at the end; it can also be
# run on its own against an existing deployment, and re-running it is harmless.
#
# Usage:
#   scripts/configure-desks.sh [network]

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-local}
# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"

log() { echo ">>> $*"; }

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

inv() { retry stellar contract invoke --network "$NETWORK" "$@"; }

# ExitDesk (#214) and RepoDvp (#215) apply an asset's first listing, or a change that only tightens,
# at once, but refuse a loosening change, such as pointing the asset at a different PriceGuard
# (which is what scripts/redeploy-price-guard.sh does). That change has to be queued and executed
# after the 48h timelock. These print the asset's current price guard, or nothing if it is not listed.
current_guard() { inv --id "$1" --source admin -- asset_config --asset "$RWA_SAC" 2>/dev/null | jq -r '.price_guard // empty' || true; }

# Token balance in stroops (the SAC prints it as a quoted string).
balance() { inv --id "$1" --source admin -- balance --id "$2" | tr -d '"'; }

THRESHOLDS='{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}'
UNIT=10000000

log "Trustlines: lender can receive RWA1 (liquidated collateral), admin can hold TUSD (exit float)"
retry stellar tx new change-trust --source lender --line "RWA1:$RWA_ISSUER" --network "$NETWORK" >/dev/null
retry stellar tx new change-trust --source admin --line "TUSD:$USDC_ISSUER" --network "$NETWORK" >/dev/null

log "Configuring ExitDesk (TUSD cash leg, RWA1 25bps spread, 10,000/day per holder, 50,000/day desk cap, 1,000,000 inventory cap)"
inv --id "$EXIT_DESK_CID" --source admin -- set_usdc --admin "$ADMIN" --usdc "$USDC_SAC" >/dev/null
EXIT_DESK_ARGS=(--admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID" --spread_bps 25
  --per_holder_daily_cap $((10000 * UNIT)) --desk_daily_cap $((50000 * UNIT)) --desk_inventory_cap $((1000000 * UNIT)))
EXIT_DESK_GUARD=$(current_guard "$EXIT_DESK_CID")
if [[ -z "$EXIT_DESK_GUARD" || "$EXIT_DESK_GUARD" == "$PRICE_GUARD_CID" ]]; then
  inv --id "$EXIT_DESK_CID" --source admin -- configure_asset "${EXIT_DESK_ARGS[@]}" >/dev/null
else
  ID=$(inv --id "$EXIT_DESK_CID" --source admin -- queue_configure_asset "${EXIT_DESK_ARGS[@]}" | tr -d '"')
  log "ExitDesk still reads PriceGuard $EXIT_DESK_GUARD; the switch to $PRICE_GUARD_CID is queued (id $ID)."
  log "After 48h run: stellar contract invoke --id $EXIT_DESK_CID --source admin --network $NETWORK -- execute_configure_asset --id $ID"
fi

if (( $(balance "$USDC_SAC" "$EXIT_DESK_CID") < 1000 * UNIT )); then
  log "Funding the ExitDesk float with 5,000 TUSD"
  retry stellar tx new payment --source usdc_issuer --destination "$ADMIN" --asset "TUSD:$USDC_ISSUER" \
    --amount $((5000 * UNIT)) --network "$NETWORK" >/dev/null
  inv --id "$EXIT_DESK_CID" --source admin -- fund \
    --admin_or_keeper "$ADMIN" --usdc "$USDC_SAC" --amount $((5000 * UNIT)) >/dev/null
else
  log "ExitDesk float already funded"
fi

log "Configuring RepoDvp (TUSD cash leg, RWA1 at a 5% haircut)"
inv --id "$REPO_DVP_CID" --source admin -- set_usdc --admin "$ADMIN" --usdc "$USDC_SAC" >/dev/null
REPO_ARGS=(--admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID"
  --haircut_bps 500 --thresholds "$THRESHOLDS"
  --max_cash_per_trade 1000000000000 --max_term_seconds 2592000)
REPO_GUARD=$(current_guard "$REPO_DVP_CID")
if [[ -z "$REPO_GUARD" || "$REPO_GUARD" == "$PRICE_GUARD_CID" ]]; then
  inv --id "$REPO_DVP_CID" --source admin -- configure_asset "${REPO_ARGS[@]}" >/dev/null
else
  ID=$(inv --id "$REPO_DVP_CID" --source admin -- queue_asset_config "${REPO_ARGS[@]}" | tr -d '"')
  log "RepoDvp still reads PriceGuard $REPO_GUARD; the switch to $PRICE_GUARD_CID is queued (id $ID)."
  log "After 48h run: stellar contract invoke --id $REPO_DVP_CID --source admin --network $NETWORK -- execute_asset_config --id $ID"
fi

# A repo's cash borrower repays principal plus interest; give the test borrower enough spare TUSD
# to cover the interest on small test trades.
if (( $(balance "$USDC_SAC" "$BORROWER") < 10 * UNIT )); then
  log "Topping the borrower up with 100 TUSD"
  retry stellar tx new payment --source usdc_issuer --destination "$BORROWER" --asset "TUSD:$USDC_ISSUER" \
    --amount $((100 * UNIT)) --network "$NETWORK" >/dev/null
fi

log "Desks configured."
