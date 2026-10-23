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

# Token balance in stroops (the SAC prints it as a quoted string).
balance() { inv --id "$1" --source admin -- balance --id "$2" | tr -d '"'; }

THRESHOLDS='{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}'
UNIT=10000000

log "Trustlines: lender can receive RWA1 (liquidated collateral), admin can hold TUSD (exit float)"
retry stellar tx new change-trust --source lender --line "RWA1:$RWA_ISSUER" --network "$NETWORK" >/dev/null
retry stellar tx new change-trust --source admin --line "TUSD:$USDC_ISSUER" --network "$NETWORK" >/dev/null

log "Configuring ExitDesk (TUSD cash leg, RWA1 25bps spread, 10,000/day per holder, 1,000,000 inventory cap)"
inv --id "$EXIT_DESK_CID" --source admin -- set_usdc --admin "$ADMIN" --usdc "$USDC_SAC" >/dev/null
inv --id "$EXIT_DESK_CID" --source admin -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID" --spread_bps 25 \
  --per_holder_daily_cap $((10000 * UNIT)) --desk_inventory_cap $((1000000 * UNIT)) >/dev/null

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
inv --id "$REPO_DVP_CID" --source admin -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID" \
  --haircut_bps 500 --thresholds "$THRESHOLDS" >/dev/null

# A repo's cash borrower repays principal plus interest; give the test borrower enough spare TUSD
# to cover the interest on small test trades.
if (( $(balance "$USDC_SAC" "$BORROWER") < 10 * UNIT )); then
  log "Topping the borrower up with 100 TUSD"
  retry stellar tx new payment --source usdc_issuer --destination "$BORROWER" --asset "TUSD:$USDC_ISSUER" \
    --amount $((100 * UNIT)) --network "$NETWORK" >/dev/null
fi

log "Desks configured."
