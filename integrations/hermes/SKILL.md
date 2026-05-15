---
name: snap-private-payments
description: Use SNAP shielded pools for private Solana agent payments.
entrypoint: ./snap-handler.ts
---

# SNAP Private Payments

Use this skill when an agent needs to deposit, transfer, withdraw, or estimate fees for SNAP private payments on Solana.

## Capabilities

- List supported SNAP mainnet pools.
- Deposit into a fixed-denomination shielded pool.
- Withdraw a SNAP note directly to a recipient wallet.
- Withdraw through a relayer when a `relayerUrl` is configured.
- Estimate protocol and relayer fees before withdrawal.

## Inputs

The handler accepts a command object:

```ts
{
  action: "list_pools" | "deposit" | "withdraw" | "estimate_fee",
  poolAddress?: string,
  amount?: number,
  note?: unknown,
  recipientAddress?: string,
  relayerUrl?: string
}
```

## Mainnet Defaults

- RPC: `https://api.mainnet-beta.solana.com`
- 0.1 SOL pool: `B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf`
- 1 USDC pool: `5LeuHrPBgHNhgbCy996MEjcsBk5gNHhVj6AiuuCHZ8od`
- 10 USDC pool: `ECuHf8kgiWfmL3Q6id4WGBQWvuukhzqvF5vsxuPAKZBv`

## Environment

- `SNAP_RPC_URL`
- `SNAP_POOL_ADDRESS`
- `SNAP_RELAYER_URL`
- `SNAP_WALLET_KEYPAIR_JSON`
