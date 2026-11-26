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
# values while the drill runs. Tightening applies at once, but putting the original thresholds back
# is a loosening change, which RepoDvp only accepts through `queue_asset_config` and a 48h timelock
# (#215). So on exit, pass or fail, the drill restores the 24h cure window immediately and *queues*
# the threshold restore, writing its id to `.e2e-repo-margin-restore.<network>`. The next run executes
# that queued restore first, and refuses to start (with the time it becomes executable) if the 48h
# have not passed yet, so a run never starts from the previous run's tightened values. To restore by
# hand instead: `stellar contract invoke --id "$REPO_DVP_CID" --network <network> -- execute_asset_config --id <id>`.

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

ORIGINAL_THRESHOLDS='{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}'
RESTORE_FILE=".e2e-repo-margin-restore.${NETWORK}"

repo() { stellar contract invoke --id "$REPO_DVP_CID" --source admin --network "$NETWORK" -- "$@"; }

# A restore queued by the previous run has to be applied before this one starts.
if [[ -f "$RESTORE_FILE" ]]; then
  RESTORE_ID=$(cat "$RESTORE_FILE")
  if PENDING=$(repo pending_asset_config --id "$RESTORE_ID") && [[ -n "$PENDING" && "$PENDING" != "null" ]]; then
    log "Executing the threshold restore queued by the previous run (id $RESTORE_ID)"
    if ! repo execute_asset_config --id "$RESTORE_ID" >/dev/null; then
      EXECUTES_AT=$(jq -r .executes_at <<<"$PENDING")
      echo "!!! The previous run's threshold restore (id $RESTORE_ID) is still in its 48h timelock;" >&2
      echo "!!! it becomes executable at $(date -u -d "@$EXECUTES_AT" 2>/dev/null || echo "unix $EXECUTES_AT"). Re-run then." >&2
      exit 1
    fi
  fi
  rm -f "$RESTORE_FILE"
fi

restore() {
  log "Restoring RepoDvp's 24h cure window"
  retry repo set_cure_grace --admin "$ADMIN" --seconds 86400 >/dev/null
  local current
  current=$(repo asset_config --asset "$RWA_SAC" | jq -cS '.thresholds')
  if [[ "$current" == "$(jq -cS . <<<"$ORIGINAL_THRESHOLDS")" ]]; then
    log "Margin thresholds were not changed; nothing to restore"
    return
  fi
  log "Queuing the margin threshold restore (70% / 80% / 90%) behind the 48h timelock (#215)"
  local id
  id=$(retry repo queue_asset_config \
    --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "$PRICE_GUARD_CID" \
    --haircut_bps 500 --thresholds "$ORIGINAL_THRESHOLDS" \
    --max_cash_per_trade 1000000000000 --max_term_seconds 2592000 | tr -d '"')
  echo "$id" >"$RESTORE_FILE"
  log "Queued restore id $id; the next run of this drill executes it once 48h have passed"
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
