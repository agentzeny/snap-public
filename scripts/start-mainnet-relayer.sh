#!/bin/bash
set -e

echo "=== SNAP Mainnet Relayer ==="
echo ""

: ${SNAP_RELAYER_KEYPAIR:?"Set SNAP_RELAYER_KEYPAIR to your relayer wallet path"}
: ${SNAP_RPC_URL:?"Set SNAP_RPC_URL to your mainnet RPC (Helius/Triton recommended)"}

if [ ! -f "mainnet-pools.json" ]; then
    echo "ERROR: mainnet-pools.json not found. Run scripts/create-mainnet-pools.ts first."
    exit 1
fi

if [ ! -f "mainnet-deployment.json" ]; then
    echo "ERROR: mainnet-deployment.json not found. Run scripts/mainnet-deploy.ts first."
    exit 1
fi

SNAP_POOL_ADDRESS=${SNAP_POOL_ADDRESS:-$(node -e "console.log(JSON.parse(require('fs').readFileSync('mainnet-pools.json','utf8')).pools[0].address)")}
SNAP_PROGRAM_ID=${SNAP_PROGRAM_ID:-$(node -e "console.log(JSON.parse(require('fs').readFileSync('mainnet-deployment.json','utf8')).programId)")}

export SNAP_CLUSTER="mainnet-beta"
export SNAP_RELAYER_FEE_BPS=${SNAP_RELAYER_FEE_BPS:-50}
export SNAP_MIN_FEE_LAMPORTS=${SNAP_MIN_FEE_LAMPORTS:-10000}
export SNAP_DB_PATH=${SNAP_DB_PATH:-"./relayer-mainnet.db"}
export SNAP_PORT=${SNAP_PORT:-3000}

SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
export PATH="$SOLANA_BIN:$PATH"

RELAYER_PUBKEY=$(solana-keygen pubkey "$SNAP_RELAYER_KEYPAIR")
RELAYER_BALANCE=$(solana balance "$RELAYER_PUBKEY" --url mainnet-beta 2>/dev/null || echo "unknown")

echo "Network:    mainnet-beta"
echo "RPC:        $SNAP_RPC_URL"
echo "Program:    $SNAP_PROGRAM_ID"
echo "Pool:       $SNAP_POOL_ADDRESS"
echo "Relayer:    $RELAYER_PUBKEY"
echo "Balance:    $RELAYER_BALANCE"
echo "Fee:        ${SNAP_RELAYER_FEE_BPS} bps"
echo "DB:         $SNAP_DB_PATH"
echo "Port:       $SNAP_PORT"
echo ""

if echo "$RELAYER_BALANCE" | grep -q "^0\b"; then
    echo "WARNING: Relayer has no SOL for gas. Fund it before processing withdrawals."
    echo "  solana transfer $RELAYER_PUBKEY 0.2 --url mainnet-beta"
    echo ""
fi

echo "Starting relayer..."
echo "(Press Ctrl+C to stop)"
echo ""

cd relayer && node dist/index.js
