# SNAP MCP Server

MCP server for SNAP private payments. It targets `@modelcontextprotocol/sdk` `1.28.0` and uses stdio transport.

## Tools

- `snap_list_pools`
- `snap_deposit`
- `snap_withdraw`
- `snap_estimate_fee`

The server also keeps `snap_withdraw_private`, `snap_pool_info`, and `snap_balance` as compatibility helpers for existing local flows.

## Claude Code Config

```json
{
  "mcpServers": {
    "snap": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-privacy-pool/integrations/mcp/snap-mcp-server.ts"],
      "env": {
        "SNAP_RPC_URL": "https://api.mainnet-beta.solana.com",
        "SNAP_POOL_ADDRESS": "B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf",
        "SNAP_RELAYER_URL": "https://your-relayer.example"
      }
    }
  }
}
```

For deterministic local transport tests, set `SNAP_MCP_STUB_MODE=1`.

## Environment

Start from [`integrations/mcp/.env.example`](./.env.example):

- `SNAP_RPC_URL`
- `SNAP_POOL_ADDRESS`
- `SNAP_RELAYER_URL`
- `SNAP_MCP_NOTE`
- `SNAP_MCP_VIEWING_KEY_JSON`
- `SNAP_MCP_STUB_MODE`

`SNAP_MCP_NOTE` should be a serialized note returned by `SNAPClient.serializeNote(...)`.

## Mainnet Pools

- `0.1 SOL`: `B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf`
- `1 USDC`: `5LeuHrPBgHNhgbCy996MEjcsBk5gNHhVj6AiuuCHZ8od`
- `10 USDC`: `ECuHf8kgiWfmL3Q6id4WGBQWvuukhzqvF5vsxuPAKZBv`

## Run

```bash
cd /path/to/agent-privacy-pool
set -a
source integrations/mcp/.env.example
set +a
npx tsx integrations/mcp/snap-mcp-server.ts
```

Smoke test:

```bash
npx mocha --require tsx integrations/tests/mcp-stdio.test.ts
```
