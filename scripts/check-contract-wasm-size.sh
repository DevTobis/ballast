#!/usr/bin/env bash
set -euo pipefail

# Keep the shared per-contract budget here so CI and local runs use the same limit.
WASM_SIZE_BUDGET_BYTES=${WASM_SIZE_BUDGET_BYTES:-102400}

if [[ ! "$WASM_SIZE_BUDGET_BYTES" =~ ^[1-9][0-9]*$ ]]; then
  echo "WASM_SIZE_BUDGET_BYTES must be a positive integer (got: $WASM_SIZE_BUDGET_BYTES)" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
contracts_dir="$repo_root/contracts"
wasm_dir="$contracts_dir/target/wasm32v1-none/release"
contracts=(registry price-guard pledge-vault credit-line exit-desk repo-dvp)

echo "Building all deployable contracts with Stellar CLI..."
(cd "$contracts_dir" && stellar contract build -q)

summary_file=${GITHUB_STEP_SUMMARY:-}
budget_kib=$(awk -v bytes="$WASM_SIZE_BUDGET_BYTES" 'BEGIN { printf "%.1f KiB", bytes / 1024 }')
if [[ -n "$summary_file" ]]; then
  {
    echo "## Contract WASM sizes"
    echo
    echo "Shared budget: ${budget_kib} (${WASM_SIZE_BUDGET_BYTES} bytes) per contract."
    echo
    echo "| Contract | Size | Budget | Result |"
    echo "| --- | ---: | ---: | --- |"
  } >> "$summary_file"
fi

failed=0
for contract in "${contracts[@]}"; do
  wasm_name="ballast_${contract//-/_}.wasm"
  wasm_path="$wasm_dir/$wasm_name"

  if [[ ! -f "$wasm_path" ]]; then
    echo "Missing expected WASM artifact: $wasm_path" >&2
    result=FAIL
    size=missing
    size_kib=missing
    failed=1
  else
    size=$(wc -c < "$wasm_path" | tr -d '[:space:]')
    size_kib=$(awk -v bytes="$size" 'BEGIN { printf "%.1f KiB", bytes / 1024 }')
    if (( size > WASM_SIZE_BUDGET_BYTES )); then
      echo "$contract: $size bytes ($size_kib), over ${WASM_SIZE_BUDGET_BYTES}-byte budget" >&2
      result=FAIL
      failed=1
    else
      echo "$contract: $size bytes ($size_kib), within ${WASM_SIZE_BUDGET_BYTES}-byte budget"
      result=PASS
    fi
  fi

  if [[ -n "$summary_file" ]]; then
    printf '| `%s` | %s | %s (%s bytes) | %s |\n' "$contract" "$size_kib" "$budget_kib" "$WASM_SIZE_BUDGET_BYTES" "$result" >> "$summary_file"
  fi
done

if (( failed )); then
  echo "One or more contract WASM artifacts are missing or exceed the shared size budget." >&2
  exit 1
fi
