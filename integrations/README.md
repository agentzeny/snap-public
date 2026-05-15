# SNAP Integrations

All framework adapters in this directory use the SDK public surface only.

- OpenClaw skill wrapper: [`integrations/openclaw/snap-skill.ts`](./openclaw/snap-skill.ts)
- ElizaOS plugin: [`integrations/elizaos/snap-plugin.ts`](./elizaos/snap-plugin.ts)
- Coinbase AgentKit provider: [`integrations/agentkit/snap-actions.ts`](./agentkit/snap-actions.ts)
- LangChain/LangGraph tools: [`integrations/langchain/snap-tool.ts`](./langchain/snap-tool.ts)
- MCP server: [`integrations/mcp/snap-mcp-server.ts`](./mcp/snap-mcp-server.ts)
- Hermes skill: [`integrations/hermes/SKILL.md`](./hermes/SKILL.md)

Reference operator docs added in Phase 11:

- MCP live startup: [`integrations/mcp/README.md`](./mcp/README.md)
- MCP env template: [`integrations/mcp/.env.example`](./mcp/.env.example)
- AgentKit live wiring path: [`integrations/agentkit/README.md`](./agentkit/README.md)
- LangChain usage: [`integrations/langchain/README.md`](./langchain/README.md)
- ElizaOS usage: [`integrations/elizaos/README.md`](./elizaos/README.md)
- Hermes skill definition: [`integrations/hermes/SKILL.md`](./hermes/SKILL.md)

## Version Targets

- `@modelcontextprotocol/sdk`: `1.28.0`
- `@coinbase/agentkit`: `0.10.4`
- `@elizaos/core`: `2.0.0-alpha.77`
- `@langchain/core`: `>=0.3.x`

The ElizaOS runtime surface is still alpha and changes quickly. The plugin in this repo targets the current `Plugin` and `Action` interfaces from `@elizaos/core 2.0.0-alpha.77` and may need small shape adjustments if your runtime pins a different alpha build.

## Validation Scope

What is live in Phase 10:

- MCP stdio startup and handshake were exercised with the real `StdioClientTransport`
- MCP tool discovery and tool calls were exercised end to end over stdio
- the relayer-facing SDK path used by integrations is the real public SDK surface
- LangChain and Hermes adapters share the same stubbed SDK tests as the other framework wrappers

What remains stubbed in tests:

- OpenClaw, ElizaOS, and AgentKit tests use stub `SnapClientLike` implementations instead of a live Solana validator
- LangChain and Hermes tests use the same stubbed `SnapClientLike` path
- MCP stdio smoke tests use `SNAP_MCP_STUB_MODE=1` so the transport and tool contract are real while pool operations stay deterministic and offline

Why:

- these integration layers are adapter code; the validator-backed relayer flow is covered separately in the root localnet E2E suite
- keeping framework tests transport-focused avoids mixing framework regressions with proof generation or validator startup noise

## Live Reference Paths

### MCP

The MCP server is the primary live-oriented reference path.

- It accepts real `SNAP_POOL_ADDRESS`, `SNAP_RPC_URL`, `SNAP_RELAYER_URL`, and serialized note/viewing-key environment variables.
- It can still run in `SNAP_MCP_STUB_MODE=1` for deterministic transport smoke tests.
- Use [`integrations/mcp/README.md`](./mcp/README.md) for live startup and note/viewing-key environment wiring.

### AgentKit

The AgentKit integration remains stubbed in automated tests, but the runtime path is live-capable because it calls the real SDK surface for:

- `snapDeposit`
- `snapWithdraw`
- `snapWithdrawPrivate`

Use [`integrations/agentkit/README.md`](./agentkit/README.md) for a live relayer example that wires SNAP actions into an agent runtime with the mainnet pool and relayer URL.
