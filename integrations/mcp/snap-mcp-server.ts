import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SNAPClient } from "../../sdk-package/src";
import {
  formatAssetLabel,
  getShieldedBalance,
  type SnapClientLike,
  type SnapPoolInfoLike,
} from "../shared/snap-client";

export interface SnapMcpDependencies {
  noteProvider?: () => unknown;
  poolAddress: string;
  relayerUrl?: string;
  snapClient: SnapClientLike;
  viewingKeyProvider?: () => unknown;
}

interface SnapMcpEnvConfig {
  poolAddress: string;
  relayerUrl?: string;
  rpcUrl: string;
  stubAssetType: "sol" | "spl";
  stubDepositAmount: number;
  stubTokenMint?: string;
  useStubClient: boolean;
}

/**
 * SNAP MCP Server
 *
 * Exposes SNAP operations as MCP tools that any MCP-compatible
 * AI agent can call. This is the highest-leverage reference integration.
 */
export function createSnapMcpServer(deps: SnapMcpDependencies): McpServer {
  const server = new McpServer({
    name: "snap-private-payments",
    version: "0.1.0",
  });

  server.registerTool(
    "snap_deposit",
    {
      description: "Deposit into the configured SNAP privacy pool",
      inputSchema: {
        amount: z.number().positive(),
      },
    },
    async ({ amount }) => {
      const pool = new PublicKey(deps.poolAddress);
      const deposit = await deps.snapClient.deposit(pool, amount);
      const poolInfo = await deps.snapClient.getPoolInfo(pool);
      return textResult(
        `Deposited ${formatAssetLabel(poolInfo)} into SNAP at index ${deposit.depositIndex}.`,
      );
    },
  );

  server.registerTool(
    "snap_withdraw",
    {
      description: "Withdraw from the configured SNAP pool with a note",
      inputSchema: {
        recipient: z.string().min(32),
        note: z.any().optional(),
      },
    },
    async ({ recipient, note }) => {
      const resolvedNote = note ?? deps.noteProvider?.();
      if (!resolvedNote) {
        throw new Error(
          "SNAP MCP withdraw requires a note. Pass note in the tool call or set SNAP_MCP_NOTE.",
        );
      }

      const signature = await deps.snapClient.withdraw(
        new PublicKey(deps.poolAddress),
        resolvedNote,
        new PublicKey(recipient),
      );
      return textResult(`Withdrew from SNAP. Transaction: ${signature}.`);
    },
  );

  server.registerTool(
    "snap_withdraw_private",
    {
      description: "Withdraw from the configured SNAP pool through a relayer",
      inputSchema: {
        recipient: z.string().min(32),
        note: z.any().optional(),
        relayerUrl: z.string().url().optional(),
      },
    },
    async ({ recipient, note, relayerUrl }) => {
      const resolvedNote = note ?? deps.noteProvider?.();
      if (!resolvedNote) {
        throw new Error(
          "SNAP MCP private withdraw requires a note. Pass note in the tool call or set SNAP_MCP_NOTE.",
        );
      }

      const resolvedRelayerUrl = relayerUrl ?? deps.relayerUrl;
      if (!resolvedRelayerUrl) {
        throw new Error(
          "SNAP MCP private withdraw requires a relayer URL. Pass relayerUrl in the tool call or set SNAP_RELAYER_URL.",
        );
      }

      const result = await deps.snapClient.withdrawViaRelayer(
        new PublicKey(deps.poolAddress),
        resolvedNote,
        new PublicKey(recipient),
        resolvedRelayerUrl,
      );
      return textResult(
        `Privately withdrew from SNAP. Transaction: ${result.txSignature}. Fee: ${result.fee}.`,
      );
    },
  );

  server.registerTool(
    "snap_pool_info",
    {
      description: "Get public information about the configured SNAP pool",
    },
    async () => {
      const poolInfo = await deps.snapClient.getPoolInfo(new PublicKey(deps.poolAddress));
      return textResult(
        JSON.stringify(
          {
            assetType: poolInfo.assetType,
            depositAmount: poolInfo.depositAmount,
            tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "snap_balance",
    {
      description: "Check private shielded balance with a viewing key",
    },
    async () => {
      const viewingKey = deps.viewingKeyProvider?.();
      if (!viewingKey) {
        throw new Error(
          "SNAP MCP balance requires a viewing key. Set SNAP_MCP_VIEWING_KEY_JSON or provide a viewing key provider.",
        );
      }

      const balance = await getShieldedBalance(
        deps.snapClient,
        new PublicKey(deps.poolAddress),
        viewingKey,
      );
      return textResult(`Private SNAP balance: ${balance}.`);
    },
  );

  return server;
}

export async function startSnapMcpServer(deps: SnapMcpDependencies): Promise<McpServer> {
  const server = createSnapMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export function loadSnapMcpEnv(env: NodeJS.ProcessEnv = process.env): SnapMcpEnvConfig {
  return {
    poolAddress:
      env.SNAP_POOL_ADDRESS ?? "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT",
    relayerUrl: env.SNAP_RELAYER_URL,
    rpcUrl: env.SNAP_RPC_URL ?? "https://api.devnet.solana.com",
    stubAssetType: env.SNAP_MCP_STUB_ASSET_TYPE === "spl" ? "spl" : "sol",
    stubDepositAmount: Number.parseFloat(env.SNAP_MCP_STUB_DEPOSIT_AMOUNT ?? "0.1"),
    stubTokenMint: env.SNAP_MCP_STUB_TOKEN_MINT,
    useStubClient: env.SNAP_MCP_STUB_MODE === "1",
  };
}

export function createSnapMcpDependenciesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SnapMcpDependencies {
  const config = loadSnapMcpEnv(env);
  const pool = new PublicKey(config.poolAddress);
  const noteProvider = createEnvNoteProvider(env);
  const viewingKeyProvider = createEnvViewingKeyProvider(env);

  return {
    poolAddress: pool.toBase58(),
    relayerUrl: config.relayerUrl,
    noteProvider,
    snapClient: config.useStubClient
      ? createStubSnapClient(config)
      : createLiveSnapClient(config),
    viewingKeyProvider,
  };
}

async function main(): Promise<void> {
  await startSnapMcpServer(createSnapMcpDependenciesFromEnv());
}

function createLiveSnapClient(config: SnapMcpEnvConfig): SnapClientLike {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const wallet = Keypair.generate();
  return new SNAPClient(connection, wallet);
}

function createStubSnapClient(config: SnapMcpEnvConfig): SnapClientLike {
  const poolInfo: SnapPoolInfoLike = {
    depositAmount: config.stubDepositAmount,
    assetType: config.stubAssetType,
    tokenMint: config.stubTokenMint ? new PublicKey(config.stubTokenMint) : null,
  };

  return {
    async deposit(_pool: PublicKey, _amount?: number) {
      return { depositIndex: 7 };
    },
    async withdraw() {
      return "stub-withdraw-signature";
    },
    async withdrawViaRelayer(
      _pool: PublicKey,
      _note: unknown,
      _recipient: PublicKey,
      relayerUrl?: string,
    ) {
      return {
        txSignature: `stub-relayed-signature${relayerUrl ? `:${relayerUrl}` : ""}`,
        fee: 0.0005,
        recipientReceived: 0.0995,
      };
    },
    async getPoolInfo() {
      return poolInfo;
    },
    async getAgentHistory() {
      return [
        {
          type: "deposit" as const,
          amount: config.stubDepositAmount,
          nullified: false,
        },
      ];
    },
  };
}

function createEnvNoteProvider(
  env: NodeJS.ProcessEnv,
): (() => unknown) | undefined {
  const serialized = env.SNAP_MCP_NOTE;
  if (!serialized) {
    return undefined;
  }

  return () => {
    try {
      return SNAPClient.deserializeNote(serialized);
    } catch (error) {
      throw new Error(
        `SNAP_MCP_NOTE is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

function createEnvViewingKeyProvider(
  env: NodeJS.ProcessEnv,
): (() => unknown) | undefined {
  const serialized = env.SNAP_MCP_VIEWING_KEY_JSON;
  if (!serialized) {
    return undefined;
  }

  return () => {
    try {
      return JSON.parse(serialized) as unknown;
    } catch {
      throw new Error("SNAP_MCP_VIEWING_KEY_JSON must be valid JSON");
    }
  };
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
