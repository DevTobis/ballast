#!/usr/bin/env bash
# Deploys ONLY the price layer to Stellar mainnet: `registry` and `price-guard`. Neither holds
# funds, so this is the low-risk first mainnet step (the public live-price page reads from it).
# Lending contracts (pledge-vault, credit-line, exit-desk, repo-dvp) are NOT deployed here.
#
# It registers every asset in scripts/shadow-assets.json, derives each asset's SAC id from the
# real classic issuer, configures the PriceGuard bands, registers the price publisher's key as the
# NAV attestor and turns signature checking on.
#
# Usage:
#   scripts/deploy-mainnet-prices.sh --dry-run     # print every command, send nothing
#   scripts/deploy-mainnet-prices.sh --help        # print usage
#   CONFIRM_MAINNET=deploy-prices scripts/deploy-mainnet-prices.sh
#
# Prerequisites (this script refuses to create keys on mainnet):
#   - `stellar` CLI identities already exist and are FUNDED with real XLM:
#       mainnet_admin, mainnet_pauser, mainnet_keeper, mainnet_price_publisher, mainnet_risk
#     Use hardware/KMS-backed or multisig accounts for admin and pauser. The price publisher key
#     is the NAV attestor: keep it in Vault/KMS for the running service (the CLI identity is only
#     used here to derive its public key; the service signs through packages/operator-signing).
#   - Override the defaults below with PRICE_BAND_BPS, DAILY_MOVE_BAND_BPS, WINDOW_SECONDS,
#     WINDOW_MOVE_BAND_BPS, MAX_STALENESS_S.
#
# Output: .env.mainnet-deploy at the repo root (contract ids and role addresses, no secrets).
#
# Interrupted runs: every contract id is appended to .env.mainnet-deploy.partial (git-ignored) the
# moment it is deployed, together with a STEP_ marker after each completed on-chain step. If the
# script dies, it prints that file. A re-run refuses to start while it exists; once you have read
# it, either resume with RESUME_PARTIAL=1 (reuses the recorded ids and skips the marked steps), or
# delete the file to deploy afresh, which orphans the contracts it lists. `deploy` and `initialize`
# are sent once, never retried, and `initialize` is checked against the contract's `roles` on chain
# (so one that landed before its marker was written is recognised, and one made by someone else is
# refused). The other steps are re-run on resume if they were killed before their marker was written.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=mainnet
OUT_FILE=".env.${NETWORK}-deploy"
PARTIAL_FILE="${OUT_FILE}.partial"
ASSETS_FILE=${ASSETS_FILE:-scripts/shadow-assets.json}
PRICE_BAND_BPS=${PRICE_BAND_BPS:-50}
DAILY_MOVE_BAND_BPS=${DAILY_MOVE_BAND_BPS:-100}
# Rolling reference: a cumulative move beyond WINDOW_MOVE_BAND_BPS within WINDOW_SECONDS halts.
WINDOW_SECONDS=${WINDOW_SECONDS:-86400}
WINDOW_MOVE_BAND_BPS=${WINDOW_MOVE_BAND_BPS:-100}
# RedStone's RWA feeds update every 1-2h; the issuer NAV every few minutes.
MAX_STALENESS_S=${MAX_STALENESS_S:-21600}
HAIRCUT_BASE_BPS=${HAIRCUT_BASE_BPS:-500}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-mainnet-prices.sh [OPTIONS]

Deploys only the price layer (`registry` and `price-guard`) to Stellar mainnet.

Options:
  --dry-run       Print every command without submitting transactions
  -h, --help      Show this help message and exit

Environment:
  CONFIRM_MAINNET=deploy-prices  Required for live deployment
  RESUME_PARTIAL=1               Resume from .env.mainnet-deploy.partial left by an interrupted run
EOF
}

DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "!!! Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$DRY_RUN" == false && "${CONFIRM_MAINNET:-}" == "deploy-prices" ]]; then
  if [[ "${DRYRUN:-}" =~ ^(1|true|yes)$ || "${DRY_RUN:-}" =~ ^(1|true|yes)$ ]]; then
    echo "!!! Refusing live deployment: dry-run environment variable detected but --dry-run flag was not passed." >&2
    exit 2
  fi
fi

log() { echo ">>> $*"; }

if [[ "$DRY_RUN" == false && "${CONFIRM_MAINNET:-}" != "deploy-prices" ]]; then
  echo "!!! This sends real transactions on Stellar MAINNET and spends real XLM." >&2
  echo "!!! Re-run with CONFIRM_MAINNET=deploy-prices to proceed, or --dry-run to preview." >&2
  exit 1
fi
if [[ "$DRY_RUN" == false && -e "$OUT_FILE" ]]; then
  echo "!!! $OUT_FILE already exists - a deployment is on record. Move it away deliberately to redeploy." >&2
  exit 1
fi
if [[ "$DRY_RUN" == false && -e "$PARTIAL_FILE" && "${RESUME_PARTIAL:-}" != "1" ]]; then
  echo "!!! $PARTIAL_FILE exists - an earlier run deployed contracts and did not finish:" >&2
  sed 's/^/    /' "$PARTIAL_FILE" >&2
  echo "!!! To continue that deployment re-run with RESUME_PARTIAL=1. To start over, delete the file," >&2
  echo "!!! knowing the contracts listed above stay on mainnet, orphaned." >&2
  exit 1
fi
if [[ "$DRY_RUN" == false && "${RESUME_PARTIAL:-}" == "1" && ! -e "$PARTIAL_FILE" ]]; then
  echo "!!! RESUME_PARTIAL=1 but $PARTIAL_FILE does not exist - nothing to resume." >&2
  exit 1
fi

# Progress record for an interrupted run (see the header). No-ops in --dry-run.
partial_get() { [[ -e "$PARTIAL_FILE" ]] && grep -m1 "^$1=" "$PARTIAL_FILE" | cut -d= -f2- || true; }
partial_put() { [[ "$DRY_RUN" == true ]] || echo "$1=$2" >> "$PARTIAL_FILE"; }
step_done() { [[ -e "$PARTIAL_FILE" ]] && grep -qx "STEP_$1=1" "$PARTIAL_FILE"; }
mark_step() { partial_put "STEP_$1" 1; }

on_exit() {
  local code=$?
  if (( code != 0 )) && [[ "$DRY_RUN" == false && -e "$PARTIAL_FILE" && ! -e "$OUT_FILE" ]]; then
    echo "!!! Deployment stopped (exit $code). Contracts already on mainnet, from $PARTIAL_FILE:" >&2
    sed 's/^/    /' "$PARTIAL_FILE" >&2
    echo "!!! Re-run with RESUME_PARTIAL=1 once the cause is fixed." >&2
  fi
}
trap on_exit EXIT

retry() {
  local -i attempt=1
  until "$@"; do
    if (( attempt >= 6 )); then echo "!!! command failed after 6 attempts: $*" >&2; return 1; fi
    attempt+=1
    sleep 3
  done
}

# Runs a state-changing `stellar` command, or just prints it in --dry-run. Only for calls that are
# safe to repeat: it retries blindly on failure.
run() {
  if [[ "$DRY_RUN" == true ]]; then echo "[dry-run] $*" >&2; echo "DRYRUN"; else retry "$@"; fi
}

# Same, but sends the command once. For `deploy` and `initialize`, which are not safe to repeat: a
# failure after the transaction landed would deploy a second contract (losing the first id) or hit
# "already initialized" on a contract that is in fact set up. Callers check the chain instead.
run_once() {
  if [[ "$DRY_RUN" == true ]]; then echo "[dry-run] $*" >&2; echo "DRYRUN"; else "$@"; fi
}

# What a contract's roles look like on chain: prints `ok` (initialized with exactly the roles in this
# run), `foreign` (initialized with others - someone else called initialize first, so the contract
# must not be used) or `uninitialized`. The read is a free simulation, so it is retried on RPC errors;
# the contracts' release builds carry no panic text, so an unset `roles` surfaces as
# UnreachableCodeReached.
roles_state() {
  local id=$1 out err attempt
  err=$(mktemp)
  for attempt in 1 2 3 4 5 6; do
    if out=$(stellar contract invoke --id "$id" --source mainnet_admin --network "$NETWORK" -- roles 2>"$err"); then
      rm -f "$err"
      python3 -c 'import json,sys
want = dict(zip(("admin", "pauser", "keeper", "price_publisher", "risk"), sys.argv[2:]))
have = json.loads(sys.argv[1])
print("ok" if all(have.get(k) == v for k, v in want.items()) else "foreign")' \
        "$out" "$ADMIN" "$PAUSER" "$KEEPER" "$PRICE_PUBLISHER" "$RISK"
      return
    fi
    if grep -q "UnreachableCodeReached" "$err"; then rm -f "$err"; echo uninitialized; return; fi
    sleep 3
  done
  echo "!!! could not read roles of $id after 6 attempts:" >&2
  sed 's/^/    /' "$err" >&2
  rm -f "$err"
  return 1
}

# Derives the 32-byte ed25519 key (hex) from a G-address. A G-address is base32(version byte | key |
# CRC16-XModem checksum), so the version and checksum are checked: a malformed address must never
# turn into a key that gets registered as the NAV attestor.
publisher_key_hex() {
  python3 -c '
import base64, sys
raw = base64.b32decode(sys.argv[1])
assert len(raw) == 35 and raw[0] == 6 << 3, "not an ed25519 public key address"
crc = 0
for byte in raw[:33]:
    crc ^= byte << 8
    for _ in range(8):
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
assert crc.to_bytes(2, "little") == raw[33:], "checksum mismatch"
print(raw[1:33].hex())' "$1"
}

identity_address() {
  local name=$1
  if stellar keys address "$name" 2>/dev/null; then return; fi
  if [[ "$DRY_RUN" == true ]]; then echo "G<$name>"; return; fi
  echo "!!! stellar identity '$name' not found. Create and fund it first (see header)." >&2
  exit 1
}

ADMIN=$(identity_address mainnet_admin)
PAUSER=$(identity_address mainnet_pauser)
KEEPER=$(identity_address mainnet_keeper)
PRICE_PUBLISHER=$(identity_address mainnet_price_publisher)
RISK=$(identity_address mainnet_risk)

if [[ "$DRY_RUN" == false && "${RESUME_PARTIAL:-}" == "1" ]]; then
  # The recorded ids were initialized with these roles; resuming under another set would mix them.
  for role in ADMIN PAUSER KEEPER PRICE_PUBLISHER RISK; do
    recorded=$(partial_get "$role")
    if [[ "$recorded" != "${!role}" ]]; then
      echo "!!! $role in $PARTIAL_FILE (${recorded:-unset}) does not match identity mainnet_${role,,} (${!role}) - refusing to resume." >&2
      exit 1
    fi
  done
fi

if [[ "$DRY_RUN" == false ]]; then
  log "Checking every role account exists and has XLM on mainnet"
  for addr in "$ADMIN" "$PAUSER" "$KEEPER" "$PRICE_PUBLISHER" "$RISK"; do
    balance=$(curl -fsS --max-time 20 "https://horizon.stellar.org/accounts/$addr" \
      | python3 -c 'import sys,json; print(next(b["balance"] for b in json.load(sys.stdin)["balances"] if b["asset_type"]=="native"))') \
      || { echo "!!! $addr not found on mainnet - fund it first" >&2; exit 1; }
    log "  $addr  $balance XLM"
  done
fi

log "Building contracts"
(cd contracts && for c in common registry price-guard; do (cd "$c" && stellar contract build -q); done)

# Derived before anything is deployed, so a bad address stops the run while there is nothing to orphan.
# (A dry run uses placeholder addresses, which cannot be decoded.)
if [[ "$DRY_RUN" == true ]]; then
  PUBLISHER_KEY_HEX=$(publisher_key_hex "$PRICE_PUBLISHER" 2>/dev/null || echo "<publisher-key-hex>")
else
  PUBLISHER_KEY_HEX=$(publisher_key_hex "$PRICE_PUBLISHER") \
    || { echo "!!! cannot derive the NAV attestor key from mainnet_price_publisher ($PRICE_PUBLISHER)" >&2; exit 1; }
  log "NAV attestor key for $PRICE_PUBLISHER: $PUBLISHER_KEY_HEX"
fi

# The roles are written first so a resume can check it is talking to the same identities.
if [[ "$DRY_RUN" == false && ! -e "$PARTIAL_FILE" ]]; then
  for role in ADMIN PAUSER KEEPER PRICE_PUBLISHER RISK; do partial_put "$role" "${!role}"; done
fi

declare -A CID
log "Deploying registry and price-guard"
for c in registry price-guard; do
  key="$(echo "${c^^}" | tr - _)_CID"
  CID[$c]=$(partial_get "$key")
  if [[ -n "${CID[$c]}" ]]; then
    log "  $c -> ${CID[$c]} (already deployed, resuming)"
    continue
  fi
  wasm="contracts/target/wasm32v1-none/release/ballast_${c//-/_}.wasm"
  # Once, never retried (see run_once). If this fails the transaction may still have landed.
  CID[$c]=$(run_once stellar contract deploy --wasm "$wasm" --source mainnet_admin --network "$NETWORK") || {
    echo "!!! deploying $c failed. It may still have landed: look at $ADMIN's recent transactions on" >&2
    echo "!!! stellar.expert before re-running, and add a ${key}=<id> line to $PARTIAL_FILE if it did." >&2
    exit 1
  }
  partial_put "$key" "${CID[$c]}"
  log "  $c -> ${CID[$c]}"
done

log "Initializing roles"
for c in registry price-guard; do
  step_done "INIT_$c" && { log "  $c already initialized, skipping"; continue; }
  if [[ "$DRY_RUN" == true ]]; then
    run_once stellar contract invoke --id "${CID[$c]}" --source mainnet_admin --network "$NETWORK" -- initialize \
      --admin "$ADMIN" --pauser "$PAUSER" --keeper "$KEEPER" \
      --price_publisher "$PRICE_PUBLISHER" --risk "$RISK" >/dev/null
    continue
  fi
  # Ask the chain first, so a step that landed before its marker was written is recognised.
  state=$(roles_state "${CID[$c]}")
  if [[ "$state" == uninitialized ]]; then
    if ! run_once stellar contract invoke --id "${CID[$c]}" --source mainnet_admin --network "$NETWORK" -- initialize \
      --admin "$ADMIN" --pauser "$PAUSER" --keeper "$KEEPER" \
      --price_publisher "$PRICE_PUBLISHER" --risk "$RISK" >/dev/null; then
      echo "!!! initialize on $c failed; checking whether it landed anyway" >&2
    fi
    state=$(roles_state "${CID[$c]}")
  fi
  case "$state" in
    ok) log "  $c initialized with the expected roles" ;;
    foreign)
      echo "!!! ${CID[$c]} ($c) is initialized with DIFFERENT roles - someone else called initialize first." >&2
      echo "!!! Do not use this contract. Remove $PARTIAL_FILE and deploy again." >&2
      exit 1 ;;
    *)
      echo "!!! initialize on $c did not take effect and the contract is still uninitialized." >&2
      echo "!!! Nothing was changed by the failed call: fix the cause and re-run with RESUME_PARTIAL=1." >&2
      exit 1 ;;
  esac
  mark_step "INIT_$c"
done

mapfile -t ROWS < <(python3 -c '
import json,sys
for a in json.load(open(sys.argv[1])):
    print("\t".join([a["code"], a["issuer"], a["ccy"]]))
' "$ASSETS_FILE")

SAC_LINES=""
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r CODE ISSUER CCY <<<"$row"
  SAC=$(retry stellar contract id asset --asset "$CODE:$ISSUER" --network "$NETWORK")
  log "Registering $CODE ($ISSUER) as $SAC"
  SAC_LINES+="SAC_${CODE}=$SAC"$'\n'

  if step_done "REGISTER_$CODE"; then log "  $CODE already registered, skipping"; else
    run stellar contract invoke --id "${CID[registry]}" --source mainnet_admin --network "$NETWORK" -- register_asset \
      --admin "$ADMIN" --asset "$SAC" \
      --config "{\"issuer\":\"$ISSUER\",\"contract\":\"$SAC\",\"standard\":\"ClassicSac\",\"yield_type\":\"Accumulating\",\"custody_mode\":\"Escrow\",\"ccy\":\"$CCY\",\"redemption_lag_days\":1,\"haircut_base_bps\":$HAIRCUT_BASE_BPS,\"haircut_fx_bps\":0,\"price_band_bps\":$PRICE_BAND_BPS,\"daily_move_band_bps\":$DAILY_MOVE_BAND_BPS,\"status\":\"active\"}" \
      >/dev/null
    mark_step "REGISTER_$CODE"
  fi

  if step_done "GUARD_$CODE"; then log "  $CODE price-guard config already applied, skipping"; else
    run stellar contract invoke --id "${CID[price-guard]}" --source mainnet_admin --network "$NETWORK" -- configure_asset \
      --admin "$ADMIN" --asset "$SAC" --band_bps "$PRICE_BAND_BPS" --daily_move_band_bps "$DAILY_MOVE_BAND_BPS" \
      --window_seconds "$WINDOW_SECONDS" --window_move_band_bps "$WINDOW_MOVE_BAND_BPS" \
      --max_staleness_s "$MAX_STALENESS_S" >/dev/null
    mark_step "GUARD_$CODE"
  fi

  # No issuer signs NAV; the publisher key signs what the service read from the issuer's API.
  if step_done "ISSUERKEY_$CODE"; then log "  $CODE issuer key already set, skipping"; else
    run stellar contract invoke --id "${CID[price-guard]}" --source mainnet_admin --network "$NETWORK" -- configure_issuer_key \
      --admin "$ADMIN" --asset "$SAC" --issuer_pubkey "$PUBLISHER_KEY_HEX" >/dev/null
    mark_step "ISSUERKEY_$CODE"
  fi
done

log "Requiring NAV signatures"
if step_done SIGNATURES; then log "  already required, skipping"; else
  run stellar contract invoke --id "${CID[price-guard]}" --source mainnet_admin --network "$NETWORK" -- configure_signature_requirement \
    --admin "$ADMIN" --required true >/dev/null
  mark_step SIGNATURES
fi

if [[ "$DRY_RUN" == true ]]; then
  log "Dry run complete: nothing was sent and $OUT_FILE was not written."
  exit 0
fi

cat > "$OUT_FILE" <<EOT
# Generated by scripts/deploy-mainnet-prices.sh - price layer only (no lending contracts)
NETWORK=$NETWORK
ADMIN=$ADMIN
PAUSER=$PAUSER
KEEPER=$KEEPER
PRICE_PUBLISHER=$PRICE_PUBLISHER
RISK=$RISK
REGISTRY_CID=${CID[registry]}
PRICE_GUARD_CID=${CID[price-guard]}
${SAC_LINES}
EOT
rm -f "$PARTIAL_FILE"
log "Wrote $OUT_FILE. Point PRICE_GUARD_CONTRACT_ID / REGISTRY_CONTRACT_ID at these and run the price-guard service with PRICE_GUARD_PUBLISH=true."
