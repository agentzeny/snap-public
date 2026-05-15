# SNAP Coinbase AgentKit Actions

Action provider for `@coinbase/agentkit` `0.10.4`.

## Actions

- `snap_list_pools`
- `snap_deposit`
- `snap_withdraw`
- `snap_withdraw_private`
- `snap_estimate_fee`

`snap_deposit`, `snap_withdraw`, and `snap_estimate_fee` default to the configured pool when `pool` is omitted. `snap_withdraw_private` uses the per-call `relayerUrl` or the provider default.

## Minimal Wiring

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { SNAPClient } from "snap-solana-sdk";
import { SNAPActionProvider } from "./integrations/agentkit/snap-actions";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SNAP_WALLET_KEYPAIR_JSON!)));
const snapClient = new SNAPClient(connection, wallet);

export const snapActions = new SNAPActionProvider(snapClient, {
  poolAddress: "B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf",
  relayerUrl: process.env.SNAP_RELAYER_URL,
});
```

## Mainnet Pools

- `0.1 SOL`: `B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf`
- `1 USDC`: `5LeuHrPBgHNhgbCy996MEjcsBk5gNHhVj6AiuuCHZ8od`
- `10 USDC`: `ECuHf8kgiWfmL3Q6id4WGBQWvuukhzqvF5vsxuPAKZBv`

Use the validator-backed localnet suite for chain-level proof and relayer validation. These actions are thin framework wrappers over the public SNAP SDK surface.
