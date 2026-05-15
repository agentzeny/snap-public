import { PublicKey } from "@solana/web3.js";

export interface SnapPoolInfoLike {
  depositAmount: number;
  assetType: "sol" | "spl";
  tokenMint?: PublicKey | null;
}

export interface SnapWithdrawalEstimateLike {
  depositAmount: number;
  protocolFee: number;
  relayerFee: number;
  recipientAmount: number;
  totalFee: number;
  protocolFeeBps?: number;
}

export interface SnapClientLike {
  deposit(pool: PublicKey, amount?: number): Promise<{ depositIndex: number }>;
  withdraw(
    pool: PublicKey,
    note: unknown,
    recipient: PublicKey
  ): Promise<string>;
  withdrawViaRelayer(
    pool: PublicKey,
    note: unknown,
    recipient: PublicKey,
    relayerUrl?: string
  ): Promise<{
    txSignature: string;
    fee: number;
    recipientReceived?: number;
  }>;
  estimateWithdrawal?(pool: PublicKey): Promise<SnapWithdrawalEstimateLike>;
  estimateRelayedWithdrawal?(
    pool: PublicKey,
    relayerUrl?: string
  ): Promise<SnapWithdrawalEstimateLike>;
  getPoolInfo(pool: PublicKey): Promise<SnapPoolInfoLike>;
  getAgentHistory?(
    pool: PublicKey,
    viewingKey: unknown
  ): Promise<
    Array<{
      type: "deposit" | "withdrawal";
      amount: number;
      nullified: boolean;
    }>
  >;
}

export interface SnapIntegrationContext {
  note?: unknown;
  poolAddress: string;
  recipientAddress?: string;
  relayerUrl?: string;
  snapClient: SnapClientLike;
  viewingKey?: unknown;
}

export function parsePoolAddress(poolAddress: string): PublicKey {
  return new PublicKey(poolAddress);
}

export function parseRecipientAddress(recipientAddress: string): PublicKey {
  return new PublicKey(recipientAddress);
}

export function formatAssetLabel(poolInfo: SnapPoolInfoLike): string {
  if (poolInfo.assetType === "sol") {
    return `${poolInfo.depositAmount} SOL`;
  }

  return poolInfo.tokenMint
    ? `${
        poolInfo.depositAmount
      } tokens of mint ${poolInfo.tokenMint.toBase58()}`
    : `${poolInfo.depositAmount} tokens`;
}

export async function estimateWithdrawalFee(
  snapClient: SnapClientLike,
  pool: PublicKey,
  relayerUrl?: string
): Promise<SnapWithdrawalEstimateLike> {
  if (relayerUrl && snapClient.estimateRelayedWithdrawal) {
    return snapClient.estimateRelayedWithdrawal(pool, relayerUrl);
  }

  if (snapClient.estimateWithdrawal) {
    return snapClient.estimateWithdrawal(pool);
  }

  const poolInfo = await snapClient.getPoolInfo(pool);
  const protocolFee = roundDisplayAmount(poolInfo.depositAmount * 0.0025);
  const recipientAmount = roundDisplayAmount(
    poolInfo.depositAmount - protocolFee
  );

  return {
    depositAmount: poolInfo.depositAmount,
    protocolFee,
    relayerFee: 0,
    recipientAmount,
    totalFee: protocolFee,
    protocolFeeBps: 25,
  };
}

export function formatWithdrawalEstimate(
  estimate: SnapWithdrawalEstimateLike,
  poolInfo: SnapPoolInfoLike
): string {
  const unit = poolInfo.assetType === "sol" ? "SOL" : "tokens";
  return [
    `Deposit amount: ${estimate.depositAmount} ${unit}`,
    `Protocol fee: ${estimate.protocolFee} ${unit}`,
    `Relayer fee: ${estimate.relayerFee} ${unit}`,
    `Recipient receives: ${estimate.recipientAmount} ${unit}`,
    `Total fee: ${estimate.totalFee} ${unit}`,
  ].join(". ");
}

export async function getShieldedBalance(
  snapClient: SnapClientLike,
  pool: PublicKey,
  viewingKey: unknown
): Promise<number> {
  if (!snapClient.getAgentHistory) {
    throw new Error(
      "SNAP integration requires snapClient.getAgentHistory(...) for private balance checks"
    );
  }

  const history = await snapClient.getAgentHistory(pool, viewingKey);
  return history.reduce((total, record) => {
    if (record.type === "deposit" && !record.nullified) {
      return total + record.amount;
    }

    return total;
  }, 0);
}

function roundDisplayAmount(amount: number): number {
  return Number(amount.toFixed(9));
}
