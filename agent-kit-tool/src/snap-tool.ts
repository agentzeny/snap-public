import { PublicKey } from "@solana/web3.js";
import {
  SNAPClient,
  type PoolInfo,
  type SpendPolicy,
} from "@snap-protocol/sdk";
import type { SolanaAgentKit } from "solana-agent-kit";

export interface SNAPToolOptions {
  spendPolicy?: SpendPolicy;
}

export async function createSnapPool(
  agent: SolanaAgentKit,
  denomination: number,
  tokenMint?: string,
  options: SNAPToolOptions = {},
): Promise<Record<string, unknown>> {
  const snap = createClient(agent, options);
  const pool = await snap.createPool(
    denomination,
    tokenMint ? { tokenMint } : undefined,
  );

  return {
    success: true,
    pool: pool.toBase58(),
    denomination,
    tokenMint,
    message: tokenMint
      ? `Created SNAP shielded SPL pool ${pool.toBase58()} with fixed denomination ${denomination} tokens for mint ${tokenMint}.`
      : `Created SNAP shielded SOL pool ${pool.toBase58()} with fixed denomination ${denomination} SOL.`,
  };
}

export async function depositToSnapPool(
  agent: SolanaAgentKit,
  pool: string,
  amount?: number,
  options: SNAPToolOptions = {},
): Promise<Record<string, unknown>> {
  const snap = createClient(agent, options);
  const poolKey = new PublicKey(pool);
  const poolInfo = await snap.getPoolInfo(poolKey);
  const note = await snap.deposit(poolKey, amount);
  const serialized = SNAPClient.serializeNote(note);

  return {
    success: true,
    pool,
    amount: poolInfo.depositAmount,
    depositIndex: note.depositIndex,
    note: serialized,
    assetType: poolInfo.assetType,
    tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
    message: `Deposited ${formatPoolAmount(poolInfo)} into shielded pool. IMPORTANT: Share the note with the recipient privately. Do NOT post it on-chain.`,
  };
}

export async function withdrawFromSnapPool(
  agent: SolanaAgentKit,
  pool: string,
  note: string,
  options: SNAPToolOptions = {},
): Promise<Record<string, unknown>> {
  const snap = createClient(agent, options);
  const poolKey = new PublicKey(pool);
  const poolInfo = await snap.getPoolInfo(poolKey);
  const tx = await snap.withdraw(
    poolKey,
    SNAPClient.deserializeNote(note),
    agent.wallet.publicKey,
  );

  return {
    success: true,
    pool,
    amount: poolInfo.depositAmount,
    assetType: poolInfo.assetType,
    tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
    transaction: tx,
    message: `Successfully withdrew ${formatPoolAmount(poolInfo)}. The withdrawal cannot be linked to the original deposit on-chain.`,
  };
}

export async function withdrawFromSnapPoolPrivately(
  agent: SolanaAgentKit,
  pool: string,
  note: string,
  relayerUrl?: string,
  options: SNAPToolOptions = {},
): Promise<Record<string, unknown>> {
  const snap = createClient(agent, options);
  const poolKey = new PublicKey(pool);
  const poolInfo = await snap.getPoolInfo(poolKey);
  const relayed = await snap.withdrawViaRelayer(
    poolKey,
    SNAPClient.deserializeNote(note),
    agent.wallet.publicKey,
    relayerUrl,
  );
  const recipientReceived =
    relayed.recipientReceived ??
    Number((poolInfo.depositAmount - relayed.fee).toFixed(9));

  return {
    success: true,
    pool,
    amount: poolInfo.depositAmount,
    assetType: poolInfo.assetType,
    tokenMint: poolInfo.tokenMint?.toBase58() ?? null,
    fee: relayed.fee,
    recipientReceived,
    transaction: relayed.txSignature,
    message: `Successfully withdrew ${recipientReceived} ${poolInfo.assetType === "sol" ? "SOL" : "tokens"} via relayer. The relayer paid gas and received a fee of ${relayed.fee}.`,
  };
}

function createClient(
  agent: SolanaAgentKit,
  options: SNAPToolOptions,
): SNAPClient {
  return new SNAPClient(agent.connection as never, agent.wallet as never, {
    provider: (agent as { provider?: unknown }).provider as never,
    spendPolicy: options.spendPolicy,
  });
}

function formatPoolAmount(poolInfo: PoolInfo): string {
  if (poolInfo.assetType === "sol") {
    return `${poolInfo.depositAmount} SOL`;
  }

  return `${poolInfo.depositAmount} tokens of mint ${poolInfo.tokenMint?.toBase58()}`;
}
