#!/usr/bin/env bash
# Registers the price publisher's Ed25519 key as the NAV attestor for the test asset and makes
# PriceGuard enforce it. No issuer signs NAV, so services/price-guard signs each reading it
# fetched with the publisher key (see services/price-guard/src/navAttestor.ts) and
# PriceGuard.publish_nav verifies that signature on-chain.
#
# Usage:
#   scripts/configure-nav-key.sh [network]     # network defaults to `testnet`
#
# Safe to re-run, and the way to bring an existing deployment (one that still has the signature
# requirement disabled) in line.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=${1:-testnet}
# shellcheck source=/dev/null
source ".env.${NETWORK}-deploy"

retry() {
  local -i attempt=1
  until "$@"; do
    if (( attempt >= 6 )); then echo "!!! command failed: $*" >&2; return 1; fi
    attempt+=1
    sleep 3
  done
}

# A G-address is base32(version byte | 32-byte key | 2-byte checksum): the key is bytes 1..33.
PUBLISHER_KEY_HEX=$(python3 -c 'import base64,sys; print(base64.b32decode(sys.argv[1])[1:33].hex())' "$PRICE_PUBLISHER")

echo ">>> Registering $PRICE_PUBLISHER as the NAV attestor for $RWA_SAC"
retry stellar contract invoke --id "$PRICE_GUARD_CID" --source admin --network "$NETWORK" -- configure_issuer_key \
  --admin "$ADMIN" --asset "$RWA_SAC" --issuer_pubkey "$PUBLISHER_KEY_HEX" >/dev/null

echo ">>> Requiring NAV signatures for $RWA_SAC"
retry stellar contract invoke --id "$PRICE_GUARD_CID" --source admin --network "$NETWORK" -- configure_signature_requirement \
  --admin "$ADMIN" --asset "$RWA_SAC" --required true >/dev/null
