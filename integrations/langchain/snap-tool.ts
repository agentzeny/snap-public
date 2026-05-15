import { StructuredTool } from "@langchain/core/tools";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  estimateWithdrawalFee,
  formatAssetLabel,
  formatWithdrawalEstimate,
  type SnapClientLike,
} from "../shared/snap-client";
import {
  listKnownPools,
  SNAP_MAINNET_POOLS,
  SNAP_MAINNET_SOL_POOL_ADDRESS,
  type SnapKnownPool,
} from "../shared/pools";
import {
  createSnapSdkClient,
  deserializeSnapNoteIfString,
  serializeSnapNoteIfPossible,
} from "../shared/snap-sdk";

export interface SNAPLangChainToolOptions {
  poolAddress?: string;
  pools?: SnapKnownPool[];
  relayerUrl?: string;
}

interface SNAPLangChainToolDeps extends SNAPLangChainToolOptions {
  snapClient: SnapClientLike;
}

const listPoolsSchema = z.object({});
const depositSchema = z.object({
  poolAddress: z.string().min(32).optional(),
  amount: z.number().positive().optional(),
});
const withdrawSchema = z.object({
  poolAddress: z.string().min(32).optional(),
  note: z.any(),
  recipient: z.string().min(32),
  relayerUrl: z.string().url().optional(),
});
const estimateFeeSchema = z.object({
  poolAddress: z.string().min(32).optional(),
  relayerUrl: z.string().url().optional(),
});

export class SNAPListPoolsTool extends StructuredTool<typeof listPoolsSchema> {
  name = "snap_list_pools";
  description = "List SNAP mainnet shielded payment pools.";
  schema = listPoolsSchema;

  constructor(private readonly deps: SNAPLangChainToolDeps) {
    super();
  }

  protected async _call(): Promise<string> {
    return stringify({
      pools: listKnownPools(this.deps.poolAddress, this.deps.pools),
    });
  }
}

export class SNAPDepositTool extends StructuredTool<typeof depositSchema> {
  name = "snap_deposit";
  description =
    "Deposit into a SNAP shielded pool. Returns a serialized note when the live SDK returns note material.";
  schema = depositSchema;

  constructor(private readonly deps: SNAPLangChainToolDeps) {
    super();
  }

  protected async _call(input: z.infer<typeof depositSchema>): Promise<string> {
    const pool = resolvePool(input.poolAddress, this.deps.poolAddress);
    const deposit = await this.deps.snapClient.deposit(pool, input.amount);
    const poolInfo = await this.deps.snapClient.getPoolInfo(pool);

    return stringify({
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
}

export class SNAPWithdrawTool extends StructuredTool<typeof withdrawSchema> {
  name = "snap_withdraw";
  description =
    "Withdraw a SNAP note to a recipient. Provide relayerUrl for relayed withdrawal.";
  schema = withdrawSchema;

  constructor(private readonly deps: SNAPLangChainToolDeps) {
    super();
  }

  protected async _call(
    input: z.infer<typeof withdrawSchema>
  ): Promise<string> {
    const pool = resolvePool(input.poolAddress, this.deps.poolAddress);
    const note = deserializeSnapNoteIfString(input.note);
    const relayerUrl = input.relayerUrl ?? this.deps.relayerUrl;

    if (relayerUrl) {
      const result = await this.deps.snapClient.withdrawViaRelayer(
        pool,
        note,
        new PublicKey(input.recipient),
        relayerUrl
      );
      return stringify({
        success: true,
        poolAddress: pool.toBase58(),
        recipient: input.recipient,
        relayerUrl,
        transaction: result.txSignature,
        fee: result.fee,
        recipientReceived: result.recipientReceived,
      });
    }

    const transaction = await this.deps.snapClient.withdraw(
      pool,
      note,
      new PublicKey(input.recipient)
    );
    return stringify({
      success: true,
      poolAddress: pool.toBase58(),
      recipient: input.recipient,
      transaction,
    });
  }
}

export class SNAPEstimateFeeTool extends StructuredTool<
  typeof estimateFeeSchema
> {
  name = "snap_estimate_fee";
  description =
    "Estimate SNAP withdrawal protocol and relayer fees for a pool.";
  schema = estimateFeeSchema;

  constructor(private readonly deps: SNAPLangChainToolDeps) {
    super();
  }

  protected async _call(
    input: z.infer<typeof estimateFeeSchema>
  ): Promise<string> {
    const pool = resolvePool(input.poolAddress, this.deps.poolAddress);
    const poolInfo = await this.deps.snapClient.getPoolInfo(pool);
    const estimate = await estimateWithdrawalFee(
      this.deps.snapClient,
      pool,
      input.relayerUrl ?? this.deps.relayerUrl
    );

    return stringify({
      poolAddress: pool.toBase58(),
      assetType: poolInfo.assetType,
      tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
      ...estimate,
      message: formatWithdrawalEstimate(estimate, poolInfo),
    });
  }
}

export function createSNAPTools(
  connection: Connection,
  wallet: unknown,
  options: SNAPLangChainToolOptions = {}
) {
  return createSNAPToolsFromClient(
    createSnapSdkClient(connection, wallet),
    options
  );
}

export function createSNAPToolsFromClient(
  snapClient: SnapClientLike,
  options: SNAPLangChainToolOptions = {}
) {
  const deps: SNAPLangChainToolDeps = {
    snapClient,
    poolAddress: options.poolAddress ?? SNAP_MAINNET_SOL_POOL_ADDRESS,
    pools: options.pools ?? SNAP_MAINNET_POOLS,
    relayerUrl: options.relayerUrl,
  };

  return [
    new SNAPListPoolsTool(deps),
    new SNAPDepositTool(deps),
    new SNAPWithdrawTool(deps),
    new SNAPEstimateFeeTool(deps),
  ];
}

function resolvePool(poolAddress?: string, fallback?: string): PublicKey {
  return new PublicKey(
    poolAddress ?? fallback ?? SNAP_MAINNET_SOL_POOL_ADDRESS
  );
}

function stringify(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
