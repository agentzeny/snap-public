import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  estimateWithdrawalFee,
  formatAssetLabel,
  formatWithdrawalEstimate,
  getShieldedBalance,
  type SnapClientLike,
  type SnapPoolInfoLike,
} from "../shared/snap-client";
import {
  listKnownPools,
  SNAP_MAINNET_POOLS,
  SNAP_MAINNET_RPC_URL,
  SNAP_MAINNET_SOL_POOL_ADDRESS,
  type SnapKnownPool,
} from "../shared/pools";
import {
  createSnapSdkClient,
  deserializeSnapNote,
  deserializeSnapNoteIfString,
  serializeSnapNoteIfPossible,
} from "../shared/snap-sdk";

export interface SnapMcpDependencies {
  noteProvider?: () => unknown;
  poolAddress: string;
  pools?: SnapKnownPool[];
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
    "snap_list_pools",
    {
      description: "List SNAP mainnet shielded payment pools",
    },
    async () =>
      jsonResult({
        pools: listKnownPools(deps.poolAddress, deps.pools),
      })
  );

  server.registerTool(
    "snap_deposit",
    {
      description: "Deposit into a SNAP privacy pool and return note metadata",
      inputSchema: {
        amount: z.number().positive().optional(),
        poolAddress: z.string().min(32).optional(),
      },
    },
    async ({ amount, poolAddress }) => {
      const pool = resolvePool(poolAddress, deps.poolAddress);
      const deposit = await deps.snapClient.deposit(pool, amount);
      const poolInfo = await deps.snapClient.getPoolInfo(pool);
      return jsonResult({
        success: true,
        poolAddress: pool.toBase58(),
        amount: poolInfo.depositAmount,
        assetType: poolInfo.assetType,
        tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
        depositIndex: deposit.depositIndex,
        note: serializeSnapNoteIfPossible(deposit),
        message: `Deposited ${formatAssetLabel(poolInfo)} into SNAP at index ${
          deposit.depositIndex
        }.`,
      });
    }
  );

  server.registerTool(
    "snap_withdraw",
    {
      description:
        "Withdraw from a SNAP pool with a note, optionally through a relayer",
      inputSchema: {
        recipient: z.string().min(32),
        note: z.any().optional(),
        poolAddress: z.string().min(32).optional(),
        relayerUrl: z.string().url().optional(),
      },
    },
    async ({ recipient, note, poolAddress, relayerUrl }) => {
      const resolvedNote = note ?? deps.noteProvider?.();
      if (!resolvedNote) {
        throw new Error(
          "SNAP MCP withdraw requires a note. Pass note in the tool call or set SNAP_MCP_NOTE."
        );
      }

      const pool = resolvePool(poolAddress, deps.poolAddress);
      const parsedNote = deserializeSnapNoteIfString(resolvedNote);
      const resolvedRelayerUrl = relayerUrl ?? deps.relayerUrl;
      if (resolvedRelayerUrl) {
        const result = await deps.snapClient.withdrawViaRelayer(
          pool,
          parsedNote,
          new PublicKey(recipient),
          resolvedRelayerUrl
        );
        return jsonResult({
          success: true,
          poolAddress: pool.toBase58(),
          recipient,
          relayerUrl: resolvedRelayerUrl,
          transaction: result.txSignature,
          fee: result.fee,
          recipientReceived: result.recipientReceived,
          message: `Privately withdrew from SNAP. Transaction: ${result.txSignature}. Fee: ${result.fee}.`,
        });
      }

      const signature = await deps.snapClient.withdraw(
        pool,
        parsedNote,
        new PublicKey(recipient)
      );
      return jsonResult({
        success: true,
        poolAddress: pool.toBase58(),
        recipient,
        transaction: signature,
        message: `Withdrew from SNAP. Transaction: ${signature}.`,
      });
    }
  );

  server.registerTool(
    "snap_estimate_fee",
    {
      description: "Estimate SNAP withdrawal fees for a pool",
      inputSchema: {
        poolAddress: z.string().min(32).optional(),
        relayerUrl: z.string().url().optional(),
      },
    },
    async ({ poolAddress, relayerUrl }) => {
      const pool = resolvePool(poolAddress, deps.poolAddress);
      const poolInfo = await deps.snapClient.getPoolInfo(pool);
      const estimate = await estimateWithdrawalFee(
        deps.snapClient,
        pool,
        relayerUrl ?? deps.relayerUrl
      );
      return jsonResult({
        poolAddress: pool.toBase58(),
        assetType: poolInfo.assetType,
        tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
        ...estimate,
        message: formatWithdrawalEstimate(estimate, poolInfo),
      });
    }
  );

  server.registerTool(
    "snap_withdraw_private",
    {
      description: "Legacy alias for relayed SNAP withdrawal",
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
          "SNAP MCP private withdraw requires a note. Pass note in the tool call or set SNAP_MCP_NOTE."
        );
      }

      const resolvedRelayerUrl = relayerUrl ?? deps.relayerUrl;
      if (!resolvedRelayerUrl) {
        throw new Error(
          "SNAP MCP private withdraw requires a relayer URL. Pass relayerUrl in the tool call or set SNAP_RELAYER_URL."
        );
      }

      const result = await deps.snapClient.withdrawViaRelayer(
        new PublicKey(deps.poolAddress),
        deserializeSnapNoteIfString(resolvedNote),
        new PublicKey(recipient),
        resolvedRelayerUrl
      );
      return textResult(
        `Privately withdrew from SNAP. Transaction: ${result.txSignature}. Fee: ${result.fee}.`
      );
    }
  );

  server.registerTool(
    "snap_pool_info",
    {
      description: "Get public information about the configured SNAP pool",
    },
    async () => {
      const poolInfo = await deps.snapClient.getPoolInfo(
        new PublicKey(deps.poolAddress)
      );
      return textResult(
        JSON.stringify(
          {
            assetType: poolInfo.assetType,
            depositAmount: poolInfo.depositAmount,
            tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
          },
          null,
          2
        )
      );
    }
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
          "SNAP MCP balance requires a viewing key. Set SNAP_MCP_VIEWING_KEY_JSON or provide a viewing key provider."
        );
      }

      const balance = await getShieldedBalance(
        deps.snapClient,
        new PublicKey(deps.poolAddress),
        viewingKey
      );
      return textResult(`Private SNAP balance: ${balance}.`);
    }
  );

  return server;
}

export async function startSnapMcpServer(
  deps: SnapMcpDependencies
): Promise<McpServer> {
  const server = createSnapMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export function loadSnapMcpEnv(
  env: NodeJS.ProcessEnv = process.env
): SnapMcpEnvConfig {
  return {
    poolAddress: env.SNAP_POOL_ADDRESS ?? SNAP_MAINNET_SOL_POOL_ADDRESS,
    relayerUrl: env.SNAP_RELAYER_URL,
    rpcUrl: env.SNAP_RPC_URL ?? SNAP_MAINNET_RPC_URL,
    stubAssetType: env.SNAP_MCP_STUB_ASSET_TYPE === "spl" ? "spl" : "sol",
    stubDepositAmount: Number.parseFloat(
      env.SNAP_MCP_STUB_DEPOSIT_AMOUNT ?? "0.1"
    ),
    stubTokenMint: env.SNAP_MCP_STUB_TOKEN_MINT,
    useStubClient: env.SNAP_MCP_STUB_MODE === "1",
  };
}

export function createSnapMcpDependenciesFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SnapMcpDependencies {
  const config = loadSnapMcpEnv(env);
  const pool = new PublicKey(config.poolAddress);
  const noteProvider = createEnvNoteProvider(env);
  const viewingKeyProvider = createEnvViewingKeyProvider(env);

  return {
    poolAddress: pool.toBase58(),
    relayerUrl: config.relayerUrl,
    noteProvider,
    pools: SNAP_MAINNET_POOLS,
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
  return createSnapSdkClient(connection, wallet);
}

function createStubSnapClient(config: SnapMcpEnvConfig): SnapClientLike {
  const poolInfo: SnapPoolInfoLike = {
    depositAmount: config.stubDepositAmount,
    assetType: config.stubAssetType,
    tokenMint: config.stubTokenMint
      ? new PublicKey(config.stubTokenMint)
      : null,
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
      relayerUrl?: string
    ) {
      return {
        txSignature: `stub-relayed-signature${
          relayerUrl ? `:${relayerUrl}` : ""
        }`,
        fee: 0.0005,
        recipientReceived: 0.0995,
      };
    },
    async estimateWithdrawal() {
      return buildStubEstimate(config.stubDepositAmount, 0);
    },
    async estimateRelayedWithdrawal() {
      return buildStubEstimate(config.stubDepositAmount, 0.0005);
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

function buildStubEstimate(depositAmount: number, relayerFee: number) {
  const protocolFee = Number((depositAmount * 0.0025).toFixed(9));
  const totalFee = Number((protocolFee + relayerFee).toFixed(9));
  return {
    depositAmount,
    protocolFee,
    relayerFee,
    recipientAmount: Number((depositAmount - totalFee).toFixed(9)),
    totalFee,
    protocolFeeBps: 25,
  };
}

function createEnvNoteProvider(
  env: NodeJS.ProcessEnv
): (() => unknown) | undefined {
  const serialized = env.SNAP_MCP_NOTE;
  if (!serialized) {
    return undefined;
  }

  return () => {
    try {
      return deserializeSnapNote(serialized);
    } catch (error) {
      throw new Error(
        `SNAP_MCP_NOTE is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
}

function createEnvViewingKeyProvider(
  env: NodeJS.ProcessEnv
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

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function resolvePool(
  poolAddress: string | undefined,
  fallback: string
): PublicKey {
  return new PublicKey(poolAddress ?? fallback);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
