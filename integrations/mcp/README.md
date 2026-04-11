# SNAP MCP Live Startup

This is the live reference path for running the SNAP MCP server against a real relayer.

## Required Environment

Start from [`integrations/mcp/.env.example`](./.env.example) and set:

- `SNAP_RPC_URL`
- `SNAP_POOL_ADDRESS`
- `SNAP_RELAYER_URL`
- `SNAP_MCP_NOTE`
- `SNAP_MCP_VIEWING_KEY_JSON` if you want `snap_balance`

The MCP server uses the live SDK path unless `SNAP_MCP_STUB_MODE=1` is set.

## Example Startup

```bash
cd /path/to/agent-privacy-pool
set -a
source integrations/mcp/.env.example
set +a
npx tsx integrations/mcp/snap-mcp-server.ts
```

## Live Devnet Example

```bash
SNAP_RPC_URL=https://api.devnet.solana.com \
SNAP_POOL_ADDRESS=8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT \
SNAP_RELAYER_URL=http://127.0.0.1:3000 \
SNAP_MCP_NOTE='<serialized note>' \
npx tsx integrations/mcp/snap-mcp-server.ts
```

`SNAP_MCP_NOTE` should be a serialized note returned by `SNAPClient.serializeNote(...)` or a deposit command that already uses the SDK.

## Live Vs Stubbed

- Live mode: real SDK, real RPC, real relayer URL
- Stub mode: set `SNAP_MCP_STUB_MODE=1` for transport-only smoke tests

The Phase 10/11 MCP tests exercise the real stdio transport and tool round-trips. Pool operations stay deterministic in CI by using stub mode there.
