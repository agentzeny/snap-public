import type { PublicKey } from "@solana/web3.js";

export interface RelayRequest {
  pool: string;
  recipient: string;
  proof: string;
  root: string;
  nullifierHash: string;
  fee: number;
}

export interface ParsedRelayRequest {
  pool: PublicKey;
  recipient: PublicKey;
  proofBytes: Uint8Array;
  rootBytes: Uint8Array;
  nullifierHashBytes: Uint8Array;
  fee: number;
}

export interface WithdrawalBreakdownPayload {
  depositAmount: number;
  depositAmountRaw: number;
  protocolFeeBps: number;
  protocolFee: number;
  protocolFeeRaw: number;
  relayerFee: number;
  relayerFeeRaw: number;
  recipientAmount: number;
  recipientAmountRaw: number;
  totalFee: number;
  totalFeeRaw: number;
}

export interface RelaySuccessPayload {
  txSignature: string;
  fee: number;
  recipientReceived: number;
  protocolFee: number;
  protocolFeeRaw: number;
  relayerFee: number;
  relayerFeeRaw: number;
  recipientAmount: number;
  recipientAmountRaw: number;
  totalFee: number;
  totalFeeRaw: number;
}

export interface RelayerInfoPayload {
  pool: string;
  poolDenomination: number;
  poolDenominationRaw: number;
  protocolFeeBps: number;
  relayerFeeBps: number;
  totalFeeBps: number;
  estimatedRecipientLamports: number;
  treasury: string | null;
  fee: {
    feeBps: number;
    minFeeLamports: number;
    protocolFeeBps: number;
    breakdown: WithdrawalBreakdownPayload;
  };
  network: string;
  programId: string;
  relayer: string;
  relayerBalanceLamports: number;
  maxRequestAgeMs: number;
}

export interface RelayerHealthPayload {
  status: "ok";
  uptime: number;
  version: string;
}

export interface RelayerStatsPayload {
  last24h: {
    total: number;
    confirmed: number;
    failed: number;
    fees: number;
    protocolFeesCollected: number;
    relayerFeesCollected: number;
  };
}
