import path from "path";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("SNAP MCP stdio", function () {
  this.timeout(30000);

  it("starts from environment config, completes a real stdio handshake, lists tools, and serves a round-trip tool call", async () => {
    const { client, transport } = await connectMcpClient({
      SNAP_MCP_STUB_MODE: "1",
      SNAP_POOL_ADDRESS: Keypair.generate().publicKey.toBase58(),
      SNAP_RELAYER_URL: "http://localhost:3000",
      SNAP_MCP_STUB_DEPOSIT_AMOUNT: "0.25",
    });

    try {
      const tools = await client.listTools();
      const response = await client.callTool({
        name: "snap_pool_info",
        arguments: {},
      });

      expect(tools.tools.map((tool) => tool.name)).to.include("snap_withdraw_private");
      expect(response.isError).to.not.equal(true);
      expect(extractText(response)).to.include("\"depositAmount\": 0.25");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("returns clear MCP tool errors for missing note, relayer URL, and viewing key", async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const { client, transport } = await connectMcpClient({
      SNAP_MCP_STUB_MODE: "1",
      SNAP_POOL_ADDRESS: Keypair.generate().publicKey.toBase58(),
    });

    try {
      const missingNote = await client.callTool({
        name: "snap_withdraw_private",
        arguments: {
          recipient,
        },
      });
      const missingRelayer = await client.callTool({
        name: "snap_withdraw_private",
        arguments: {
          recipient,
          note: { demo: true },
        },
      });
      const missingViewingKey = await client.callTool({
        name: "snap_balance",
        arguments: {},
      });

      expect(missingNote.isError).to.equal(true);
      expect(extractText(missingNote)).to.include("requires a note");
      expect(missingRelayer.isError).to.equal(true);
      expect(extractText(missingRelayer)).to.include("requires a relayer URL");
      expect(missingViewingKey.isError).to.equal(true);
      expect(extractText(missingViewingKey)).to.include("requires a viewing key");
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

async function connectMcpClient(
  envOverrides: Record<string, string>,
): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const client = new Client({
    name: "snap-stdio-test-client",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: path.resolve(process.cwd(), "node_modules", ".bin", "tsx"),
    args: ["integrations/mcp/snap-mcp-server.ts"],
    cwd: process.cwd(),
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...envOverrides,
    },
    stderr: "pipe",
  });

  await client.connect(transport);
  return { client, transport };
}

function extractText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    ?.filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n") ?? "";
}
