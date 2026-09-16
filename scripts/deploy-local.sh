#!/usr/bin/env bash
# Deploys all six Ballast contracts to a local Stellar network (`stellar container start local`)
# and wires them together: roles, price-guard config, one test RWA asset, one test USDC-like
# asset, and a registry entry - everything `e2e-smoke.sh` then exercises with real signed,
# submitted transactions.
#
# Prerequisites:
#   - `stellar container start local` running (see README.md's "Local end-to-end run" section)
#   - contracts already built (`stellar contract build` in each contracts/<name>/ directory, or
#     just let this script do it)
#
# CLI flag names below were derived from `stellar contract info interface --wasm <path>` (works
# fully offline, no network needed - see contracts/README.md) but the auto-generated
# `contract invoke` flags weren't hand-verified against a live deployment before this script was
# written (the sandbox this was built in had an extremely slow Docker pull). If a flag name is
# wrong, `stellar contract invoke --id <CID> --source admin --network local -- <fn> --help`
# against your own live deployment will show the real one - fix here and send a PR.
#
# Outputs contract IDs (and everything else needed by e2e-smoke.sh) to .env.local-deploy at the
# repo root.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=local
OUT_FILE=".env.local-deploy"

log() { echo ">>> $*"; }

log "Building contracts"
(
  cd contracts
  for c in common registry price-guard pledge-vault credit-line exit-desk repo-dvp; do
    (cd "$c" && stellar contract build -q)
  done
)

log "Generating and funding identities"
for name in admin pauser keeper price_publisher risk borrower lender rwa_issuer usdc_issuer; do
  stellar keys generate "$name" --network "$NETWORK" --fund --overwrite -q
done

ADMIN=$(stellar keys address admin)
PAUSER=$(stellar keys address pauser)
KEEPER=$(stellar keys address keeper)
PRICE_PUBLISHER=$(stellar keys address price_publisher)
RISK=$(stellar keys address risk)
BORROWER=$(stellar keys address borrower)
LENDER=$(stellar keys address lender)
RWA_ISSUER=$(stellar keys address rwa_issuer)
USDC_ISSUER=$(stellar keys address usdc_issuer)

log "Issuing test assets (RWA1, TUSD) and their SAC wrappers"
stellar contract asset deploy --asset "RWA1:$RWA_ISSUER" --source admin --network "$NETWORK" >/dev/null
RWA_SAC=$(stellar contract id asset --asset "RWA1:$RWA_ISSUER" --network "$NETWORK")

stellar contract asset deploy --asset "TUSD:$USDC_ISSUER" --source admin --network "$NETWORK" >/dev/null
USDC_SAC=$(stellar contract id asset --asset "TUSD:$USDC_ISSUER" --network "$NETWORK")

log "Trustlines and classic balances for the borrower (RWA1) and lender (TUSD)"
stellar tx new change-trust --source borrower --line "RWA1:$RWA_ISSUER" --network "$NETWORK" >/dev/null
stellar tx new payment --source rwa_issuer --destination "$BORROWER" --asset "RWA1:$RWA_ISSUER" \
  --amount 100000000000 --network "$NETWORK" >/dev/null

stellar tx new change-trust --source lender --line "TUSD:$USDC_ISSUER" --network "$NETWORK" >/dev/null
stellar tx new payment --source usdc_issuer --destination "$LENDER" --asset "TUSD:$USDC_ISSUER" \
  --amount 1000000000000 --network "$NETWORK" >/dev/null

log "Deploying contracts"
declare -A CID
for c in registry price-guard pledge-vault credit-line exit-desk repo-dvp; do
  wasm="contracts/target/wasm32v1-none/release/ballast_${c//-/_}.wasm"
  CID[$c]=$(stellar contract deploy --wasm "$wasm" --source admin --network "$NETWORK")
  log "  $c -> ${CID[$c]}"
done

log "Initializing roles on every contract"
for c in registry price-guard pledge-vault credit-line exit-desk repo-dvp; do
  stellar contract invoke --id "${CID[$c]}" --source admin --network "$NETWORK" -- initialize \
    --admin "$ADMIN" --pauser "$PAUSER" --keeper "$KEEPER" \
    --price_publisher "$PRICE_PUBLISHER" --risk "$RISK" >/dev/null
  log "  $c initialized"
done

log "Registering RWA1 in the Registry"
stellar contract invoke --id "${CID[registry]}" --source admin --network "$NETWORK" -- register_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" \
  --config "{\"issuer\":\"$RWA_ISSUER\",\"contract\":\"$RWA_SAC\",\"standard\":\"ClassicSac\",\"yield_type\":\"Accumulating\",\"custody_mode\":\"Escrow\",\"ccy\":\"USD\",\"redemption_lag_days\":1,\"haircut_base_bps\":500,\"haircut_fx_bps\":0,\"price_band_bps\":50,\"daily_move_band_bps\":100,\"status\":\"active\"}" \
  >/dev/null

log "Configuring PriceGuard for RWA1 (50bps band, 100bps daily move, 1h staleness)"
stellar contract invoke --id "${CID[price-guard]}" --source admin --network "$NETWORK" -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --band_bps 50 --daily_move_band_bps 100 --max_staleness_s 3600 >/dev/null

log "Configuring PledgeVault for RWA1 (5% haircut, escrow mode)"
stellar contract invoke --id "${CID[pledge-vault]}" --source admin --network "$NETWORK" -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "${CID[price-guard]}" --credit_line "${CID[credit-line]}" \
  --haircut_bps 500 \
  --thresholds '{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}' \
  --custody_mode '"Escrow"' >/dev/null

log "Configuring CreditLine for RWA1/TUSD"
stellar contract invoke --id "${CID[credit-line]}" --source admin --network "$NETWORK" -- configure_asset \
  --admin "$ADMIN" --asset "$RWA_SAC" --price_guard "${CID[price-guard]}" --usdc "$USDC_SAC" \
  --haircut_bps 500 --thresholds '{"warning_bps":7000,"margin_call_bps":8000,"liquidation_bps":9000}' >/dev/null

cat > "$OUT_FILE" <<EOF
# Generated by scripts/deploy-local.sh - source this before running e2e-smoke.sh
NETWORK=$NETWORK
ADMIN=$ADMIN
PAUSER=$PAUSER
KEEPER=$KEEPER
PRICE_PUBLISHER=$PRICE_PUBLISHER
RISK=$RISK
BORROWER=$BORROWER
LENDER=$LENDER
RWA_ISSUER=$RWA_ISSUER
USDC_ISSUER=$USDC_ISSUER
RWA_SAC=$RWA_SAC
USDC_SAC=$USDC_SAC
REGISTRY_CID=${CID[registry]}
PRICE_GUARD_CID=${CID[price-guard]}
PLEDGE_VAULT_CID=${CID[pledge-vault]}
CREDIT_LINE_CID=${CID[credit-line]}
EXIT_DESK_CID=${CID[exit-desk]}
REPO_DVP_CID=${CID[repo-dvp]}
EOF

log "Wrote $OUT_FILE"
log "Done. Run scripts/e2e-smoke.sh next."
