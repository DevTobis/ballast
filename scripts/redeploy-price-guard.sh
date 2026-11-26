#!/usr/bin/env bash
# Replaces the PriceGuard on an existing testnet/local deployment with the one built from this tree,
# and points everything that reads prices at it. PriceGuard holds no funds and no lines, so unlike
# the other contracts it can be swapped without losing state that matters: the price history it keeps
# is rebuilt from the next publishes.
#
# Usage:
#   scripts/redeploy-price-guard.sh [network]     # network defaults to `testnet`
#
# It deploys and initializes the new contract, configures RWA1 and the NAV attestor key, then
# re-runs the PledgeVault, CreditLine, ExitDesk and RepoDvp asset configuration with the new address
# (each stores the PriceGuard it consults). It rewrites PRICE_GUARD_CID in `.env.<network>-deploy`
# and PRICE_GUARD_CONTRACT_ID in `.env`; restart the services afterwards so they pick it up.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-testnet}
DEPLOY_FILE=".env.${NETWORK}-deploy"
# shellcheck source=/dev/null
source "$DEPLOY_FILE"

log() { echo ">>> $*"; }

retry() {
  local -i attempt=1
  until "$@"; do
    if (( attempt >= 6 )); then echo "!!! command failed after 6 attempts: $*" >&2; return 1; fi
    attempt+=1
    sleep 3
  done
}

# set_var FILE KEY VALUE: sets KEY=VALUE without `sed -i`, whose flags differ between GNU and BSD.
# The old line is kept as a `# previous` comment for rollback, a missing key is appended, and the
# result is checked so a silent no-op cannot pass. Rewrites in place to keep the file's mode (.env).
set_var() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp)
  if grep -q "^${key}=" "$file"; then
    awk -v key="$key" -v value="$value" \
      'index($0, key "=") == 1 { print "# previous " $0; print key "=" value; next } { print }' \
      "$file" > "$tmp"
  else
    { cat "$file"; if [[ -n $(tail -c1 "$file") ]]; then echo; fi; echo "${key}=${value}"; } > "$tmp"
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
  grep -qx "${key}=${value}" "$file" || { echo "!!! could not set ${key} in ${file}" >&2; return 1; }
}

inv() { retry stellar contract invoke --network "$NETWORK" --source admin "$@"; }
THRESHOLDS='{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}'

log "Building price-guard"
(cd contracts/price-guard && stellar contract build -q)

log "Deploying and initializing the new PriceGuard"
NEW=$(retry stellar contract deploy --wasm contracts/target/wasm32v1-none/release/ballast_price_guard.wasm --source admin --network "$NETWORK")
log "  new PriceGuard: $NEW (was $PRICE_GUARD_CID)"
inv --id "$NEW" -- initialize --admin "$ADMIN" --pauser "$PAUSER" --keeper "$KEEPER" \
  --price_publisher "$PRICE_PUBLISHER" --risk "$RISK" >/dev/null
inv --id "$NEW" -- configure_asset --admin "$ADMIN" --asset "$RWA_SAC" \
  --band_bps 50 --daily_move_band_bps 100 \
  --window_seconds 86400 --window_move_band_bps 100 --max_staleness_s "${PRICE_MAX_STALENESS_S:-46800}" >/dev/null

# The deploy file is what configure-nav-key.sh and configure-desks.sh read, so it changes first.
set_var "$DEPLOY_FILE" PRICE_GUARD_CID "$NEW"
if [[ -f .env ]]; then set_var .env PRICE_GUARD_CONTRACT_ID "$NEW"; fi

log "Registering the NAV attestor key and requiring signatures"
scripts/configure-nav-key.sh "$NETWORK"

log "Pointing PledgeVault and CreditLine at it"
inv --id "$PLEDGE_VAULT_CID" -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$NEW" --credit_line "$CREDIT_LINE_CID" \
  --haircut_bps 500 --thresholds "$THRESHOLDS" --custody_mode '"Escrow"' >/dev/null
inv --id "$CREDIT_LINE_CID" -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$NEW" --usdc "$USDC_SAC" \
  --haircut_bps 500 --thresholds "$THRESHOLDS" >/dev/null

log "Pointing ExitDesk and RepoDvp at it"
scripts/configure-desks.sh "$NETWORK"

log "Done. Restart the services so they read the new PRICE_GUARD_CONTRACT_ID."
