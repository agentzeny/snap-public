import { PublicKey } from "@solana/web3.js";

export interface SnapPoolInfoLike {
  depositAmount: number;
  assetType: "sol" | "spl";
  tokenMint?: PublicKey | null;
}

export interface SnapClientLike {
  deposit(pool: PublicKey, amount?: number): Promise<{ depositIndex: number }>;
  withdraw(
    pool: PublicKey,
    note: unknown,
    recipient: PublicKey,
  ): Promise<string>;
  withdrawViaRelayer(
    pool: PublicKey,
    note: unknown,
    recipient: PublicKey,
    relayerUrl?: string,
  ): Promise<{
    txSignature: string;
    fee: number;
    recipientReceived?: number;
  }>;
  getPoolInfo(pool: PublicKey): Promise<SnapPoolInfoLike>;
  getAgentHistory?(
    pool: PublicKey,
    viewingKey: unknown,
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
    ? `${poolInfo.depositAmount} tokens of mint ${poolInfo.tokenMint.toBase58()}`
    : `${poolInfo.depositAmount} tokens`;
}

export async function getShieldedBalance(
  snapClient: SnapClientLike,
  pool: PublicKey,
  viewingKey: unknown,
): Promise<number> {
  if (!snapClient.getAgentHistory) {
    throw new Error(
      "SNAP integration requires snapClient.getAgentHistory(...) for private balance checks",
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
