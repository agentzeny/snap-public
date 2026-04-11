#!/bin/bash
set -e

echo "==========================================="
echo "  SNAP: Shielded Agent Payments on Solana"
echo "  Phase 3 Demo (relayed withdrawal)"
echo "==========================================="
echo ""

# Check if validator is already running
if ! solana cluster-version --url localhost 2>/dev/null; then
    echo "Starting Solana test validator..."
    solana-test-validator --reset &
    VALIDATOR_PID=$!
    sleep 4
    echo "Validator started (PID: $VALIDATOR_PID)"
else
    echo "Validator already running."
    VALIDATOR_PID=""
fi

RELAYER_PID=""

cleanup() {
    if [ -n "$RELAYER_PID" ]; then
        kill $RELAYER_PID 2>/dev/null || true
        echo "Relayer stopped."
    fi

    if [ -n "$VALIDATOR_PID" ]; then
        kill $VALIDATOR_PID 2>/dev/null || true
        echo "Validator stopped."
    fi
}

trap cleanup EXIT

echo ""
echo "=== Building program ==="
anchor build

echo ""
echo "=== Deploying program ==="
anchor deploy

echo ""
echo "=== Airdropping SOL to test wallet ==="
solana airdrop 5 --url localhost 2>/dev/null || true

echo ""
echo "=== Preparing relayer wallet ==="
if [ ! -f relayer-keypair.json ]; then
    solana-keygen new -o relayer-keypair.json --no-bip39-passphrase --force >/dev/null
fi
solana airdrop 10 "$(solana-keygen pubkey relayer-keypair.json)" --url localhost 2>/dev/null || true

echo ""
echo "=== Agent A deposits (direct) ==="
echo ""
npx tsx agents/agent-a.ts

echo ""
echo "=== Starting relayer ==="
RELAYER_KEYPAIR_PATH=relayer-keypair.json npx tsx relayer/src/index.ts &
RELAYER_PID=$!
sleep 2

echo ""
echo "=== Agent B withdraws via relayer (private) ==="
echo ""
npx tsx agents/agent-b-relayed.ts

echo ""
echo "=== Demo complete ==="
