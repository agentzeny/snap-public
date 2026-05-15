import { PublicKey } from "@solana/web3.js";
import {
  estimateWithdrawalFee,
  type SnapClientLike,
} from "../shared/snap-client";
import {
  deserializeSnapNoteIfString,
  serializeSnapNoteIfPossible,
} from "../shared/snap-sdk";
import {
  listKnownPools,
  SNAP_MAINNET_POOLS,
  SNAP_MAINNET_SOL_POOL_ADDRESS,
  type SnapKnownPool,
} from "../shared/pools";

export type HermesSnapAction =
  | "list_pools"
  | "deposit"
  | "withdraw"
  | "estimate_fee";

export interface HermesSnapCommand {
  action: HermesSnapAction;
  amount?: number;
  note?: unknown;
  poolAddress?: string;
  recipientAddress?: string;
  relayerUrl?: string;
}

export interface HermesSnapDependencies {
  poolAddress?: string;
  pools?: SnapKnownPool[];
  relayerUrl?: string;
  snapClient: SnapClientLike;
}

export async function handleHermesSnap(
  command: HermesSnapCommand,
  deps: HermesSnapDependencies
): Promise<Record<string, unknown>> {
  const defaultPool = deps.poolAddress ?? SNAP_MAINNET_SOL_POOL_ADDRESS;

  if (command.action === "list_pools") {
    return {
      success: true,
      pools: listKnownPools(defaultPool, deps.pools ?? SNAP_MAINNET_POOLS),
    };
  }

  const pool = new PublicKey(command.poolAddress ?? defaultPool);

  if (command.action === "deposit") {
    const deposit = await deps.snapClient.deposit(pool, command.amount);
    const poolInfo = await deps.snapClient.getPoolInfo(pool);
    return {
      success: true,
      poolAddress: pool.toBase58(),
      amount: poolInfo.depositAmount,
      assetType: poolInfo.assetType,
      tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
      depositIndex: deposit.depositIndex,
      note: serializeSnapNoteIfPossible(deposit),
    };
  }

  if (command.action === "withdraw") {
    if (!command.note || !command.recipientAddress) {
      throw new Error(
        "Hermes SNAP withdraw requires note and recipientAddress"
      );
    }

    const note = deserializeSnapNoteIfString(command.note);
    const recipient = new PublicKey(command.recipientAddress);
    const relayerUrl = command.relayerUrl ?? deps.relayerUrl;

    if (relayerUrl) {
      const result = await deps.snapClient.withdrawViaRelayer(
        pool,
        note,
        recipient,
        relayerUrl
      );
      return {
        success: true,
        poolAddress: pool.toBase58(),
        recipientAddress: recipient.toBase58(),
        relayerUrl,
        transaction: result.txSignature,
        fee: result.fee,
        recipientReceived: result.recipientReceived,
      };
    }

    const transaction = await deps.snapClient.withdraw(pool, note, recipient);
    return {
      success: true,
      poolAddress: pool.toBase58(),
      recipientAddress: recipient.toBase58(),
      transaction,
    };
  }

  if (command.action === "estimate_fee") {
    const poolInfo = await deps.snapClient.getPoolInfo(pool);
    const estimate = await estimateWithdrawalFee(
      deps.snapClient,
      pool,
      command.relayerUrl ?? deps.relayerUrl
    );
    return {
      success: true,
      poolAddress: pool.toBase58(),
      assetType: poolInfo.assetType,
      tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
      ...estimate,
    };
  }

  throw new Error(`Unsupported Hermes SNAP action: ${command.action}`);
}
