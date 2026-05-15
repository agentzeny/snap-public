# SNAP Private Payment Skill

## Description
Make private payments on Solana using zero-knowledge proofs.
Other agents and on-chain observers cannot see who you paid.

## Commands

### List SNAP pools
"List SNAP pools"
"Show private payment pools"

### Deposit into shielded pool
"Deposit [amount] into the SNAP privacy pool"
"Shield [amount] SOL privately"

### Withdraw from shielded pool
"Withdraw from SNAP pool to [address]"
"Claim my private payment"

### Estimate withdrawal fee
"Estimate SNAP withdrawal fee"
"What will this SNAP withdrawal cost?"

### Check shielded balance
"What's in my SNAP pool?"
"Show my private balance"

## Setup
npm install snap-solana-sdk

## Configuration
SNAP_POOL_ADDRESS=B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf
SNAP_RPC_URL=https://api.mainnet-beta.solana.com
SNAP_RELAYER_URL=<optional_relayer_url>
