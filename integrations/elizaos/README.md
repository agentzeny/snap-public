# SNAP ElizaOS Plugin

ElizaOS plugin actions for SNAP private payments.

## Target

- `@elizaos/core` `2.0.0-alpha.77`
- Node.js 18+
- SNAP SDK through the shared `SnapClientLike` interface

## Actions

- `SNAP_LIST_POOLS`
- `SNAP_DEPOSIT`
- `SNAP_WITHDRAW`
- `SNAP_ESTIMATE_FEE`
- `SNAP_BALANCE`

`SNAP_WITHDRAW` performs a direct withdrawal by default. Set `relayerUrl` in the action parameters or `SNAP_RELAYER_URL` to withdraw through a relayer.

## Agent Config

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { SNAPClient } from "snap-solana-sdk";
import { createSnapPlugin } from "./integrations/elizaos/snap-plugin";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SNAP_WALLET_KEYPAIR_JSON!)));

export const snapPlugin = createSnapPlugin({
  poolAddress: process.env.SNAP_POOL_ADDRESS ?? "B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf",
  relayerUrl: process.env.SNAP_RELAYER_URL,
  snapClient: new SNAPClient(connection, wallet),
});
```

Mainnet pools:

- `0.1 SOL`: `B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf`
- `1 USDC`: `5LeuHrPBgHNhgbCy996MEjcsBk5gNHhVj6AiuuCHZ8od`
- `10 USDC`: `ECuHf8kgiWfmL3Q6id4WGBQWvuukhzqvF5vsxuPAKZBv`
