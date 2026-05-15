# SNAP LangChain/LangGraph Tools

Thin `@langchain/core` tools for SNAP private payments on Solana.

## Install

```bash
npm install snap-solana-sdk @langchain/core @solana/web3.js
```

## Tools

- `snap_list_pools` lists the configured mainnet pools.
- `snap_deposit` deposits into a pool and returns deposit metadata plus a serialized note when the live SDK result includes note material.
- `snap_withdraw` withdraws a serialized note directly, or through a relayer when `relayerUrl` is provided.
- `snap_estimate_fee` estimates direct or relayed withdrawal fees.

## Usage

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { createSNAPTools } from "./integrations/langchain/snap-tool";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SNAP_WALLET_KEYPAIR_JSON!)));

const tools = createSNAPTools(connection, wallet, {
  poolAddress: "B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf",
  relayerUrl: process.env.SNAP_RELAYER_URL,
});

const deposit = await tools.find((tool) => tool.name === "snap_deposit")!.invoke({
  amount: 0.1,
});
```

The exported `createSNAPToolsFromClient(snapClient, options)` factory is available for LangGraph nodes or tests that already own a `SnapClientLike`.
