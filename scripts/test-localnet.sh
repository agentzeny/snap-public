#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLANA_BIN_DIR="${HOME}/.local/share/solana/install/active_release/bin"
export PATH="${SOLANA_BIN_DIR}:${PATH}"

RPC_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
ANCHOR_WALLET_PATH="${ANCHOR_WALLET:-${HOME}/.config/solana/id.json}"
LEDGER_DIR="${SNAP_LOCALNET_LEDGER:-${ROOT_DIR}/.localnet-validation-ledger}"
WITH_STRESS=0
VALIDATOR_STARTED=0
VALIDATOR_PID=""

for arg in "$@"; do
  case "$arg" in
    --with-stress)
      WITH_STRESS=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

cleanup() {
  if [[ "${VALIDATOR_STARTED}" -eq 1 && -n "${VALIDATOR_PID}" ]]; then
    kill "${VALIDATOR_PID}" >/dev/null 2>&1 || true
    wait "${VALIDATOR_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

is_validator_healthy() {
  curl -sf -X POST "${RPC_URL}" \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1
}

wait_for_validator() {
  local attempts=0
  until is_validator_healthy; do
    attempts=$((attempts + 1))
    if [[ "${attempts}" -ge 40 ]]; then
      echo "Local validator at ${RPC_URL} did not become healthy" >&2
      exit 1
    fi
    sleep 1
  done
}

if ! is_validator_healthy; then
  solana-test-validator \
    --ledger "${LEDGER_DIR}" \
    --reset \
    --quiet \
    --bind-address 127.0.0.1 \
    --rpc-port 8899 \
    --faucet-port 9900 >/dev/null 2>&1 &
  VALIDATOR_PID=$!
  VALIDATOR_STARTED=1
  wait_for_validator
fi

cd "${ROOT_DIR}"

anchor build
anchor deploy --provider.cluster localnet

ANCHOR_PROVIDER_URL="${RPC_URL}" \
ANCHOR_WALLET="${ANCHOR_WALLET_PATH}" \
npx tsx node_modules/.bin/mocha --exit -t 1000000 "tests/**/*.ts"

if [[ "${WITH_STRESS}" -eq 1 ]]; then
  ANCHOR_PROVIDER_URL="${RPC_URL}" \
  ANCHOR_WALLET="${ANCHOR_WALLET_PATH}" \
  npx tsx tests/stress/concurrent-clients.test.ts

  ANCHOR_PROVIDER_URL="${RPC_URL}" \
  ANCHOR_WALLET="${ANCHOR_WALLET_PATH}" \
  npx tsx tests/stress/pool-growth.test.ts

  ANCHOR_PROVIDER_URL="${RPC_URL}" \
  ANCHOR_WALLET="${ANCHOR_WALLET_PATH}" \
  npx tsx tests/stress/spl-scaling.test.ts

  ANCHOR_PROVIDER_URL="${RPC_URL}" \
  ANCHOR_WALLET="${ANCHOR_WALLET_PATH}" \
  npx tsx tests/stress/relayer-throughput.test.ts
fi
