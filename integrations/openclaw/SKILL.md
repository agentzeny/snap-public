# SNAP Private Payment Skill

## Description
Make private payments on Solana using zero-knowledge proofs.
Other agents and on-chain observers cannot see who you paid.

## Commands

### Deposit into shielded pool
"Deposit [amount] into the SNAP privacy pool"
"Shield [amount] SOL privately"

### Withdraw from shielded pool
"Withdraw from SNAP pool to [address]"
"Claim my private payment"

### Check shielded balance
"What's in my SNAP pool?"
"Show my private balance"

## Setup
npm install snap-solana-sdk

## Configuration
SNAP_POOL_ADDRESS=<pool_address>
SNAP_RPC_URL=https://api.devnet.solana.com
