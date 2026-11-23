#!/usr/bin/env bash
# End-to-end repo margin drill against the running stack: a repo is margin-called by the keeper, the
# borrower cures it by adding collateral, a second call is left uncured and the keeper defaults the
# trade (see services/api/e2e/repo-margin.ts).
#
# Usage:
#   scripts/e2e-repo-margin.sh [network]     # network defaults to `testnet`
#
# Prerequisites: `scripts/dev-setup.sh [network]` has been run and `pnpm dev` is up, with the
# deployment's RepoDvp built from this tree (it needs `set_cure_grace`, `top_up` and `margin_view`).
#
# The repo thresholds are shared by every repo on the asset, so other open repos see the tightened
# values while the drill runs; the originals and the 24h cure window are put back on exit, pass or fail.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-testnet}

set -a
# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"
# shellcheck source=/dev/null
source .env
set +a

log() { echo ">>> $*"; }

retry() {
  local -i attempt=1
  until "$@"; do
    if (( attempt >= 6 )); then echo "!!! command failed: $*" >&2; return 1; fi
    attempt+=1
    sleep 3
  done
}

restore() {
  log "Restoring RepoDvp's margin thresholds (70% / 80% / 90%) and the 24h cure window"
  retry stellar contract invoke --id "$REPO_DVP_CID" --source admin --network "$NETWORK" -- configure_asset \
    --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID" \
    --haircut_bps 500 --thresholds '{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}' \
    --max_cash_per_trade 1000000000000 --max_term_seconds 2592000 >/dev/null
  retry stellar contract invoke --id "$REPO_DVP_CID" --source admin --network "$NETWORK" -- set_cure_grace \
    --admin "$ADMIN" --seconds 86400 >/dev/null
}
trap restore EXIT

if [[ "${KEEPER_REPO_MARGIN_CRON:-}" != "* * * * *" && "${KEEPER_REPO_MARGIN_CRON:-}" != "*/1 * * * *" ]]; then
  echo "!!! KEEPER_REPO_MARGIN_CRON is '${KEEPER_REPO_MARGIN_CRON:-unset}': the keeper checks repo margin every 5 minutes, so this drill will be slow." >&2
  echo "!!! Set KEEPER_REPO_MARGIN_CRON=\"* * * * *\" in .env (dev-setup.sh does) and restart the keeper." >&2
fi

LENDER_SECRET=$(stellar keys secret lender) \
BORROWER_SECRET=$(stellar keys secret borrower) \
API_URL="http://localhost:${API_PORT:-3000}" \
  pnpm --filter @ballast/service-api exec tsx e2e/repo-margin.ts
