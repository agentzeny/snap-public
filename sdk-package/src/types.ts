import type { Wallet } from "@coral-xyz/anchor";
import type {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

export interface Note {
  secret: bigint;
  nullifier: bigint;
  commitment: Uint8Array;
  nullifierHash: Uint8Array;
  depositIndex: number;
  poolAddress: string;
}

export interface DecryptedNote extends Note {
  agentId: string;
  index: number;
}

export interface DepositResult extends Note {
  encryptedNote?: Uint8Array;
}

export interface EncryptedNoteRecord {
  id?: string;
  commitment: Uint8Array;
  encryptedNote: Uint8Array;
  poolAddress: string;
  depositIndex: number;
  createdAt?: number;
}

export interface PoolInfo {
  address: PublicKey;
  authority: PublicKey;
  depositAmount: number;
  depositAmountRaw: number;
  depositCount: number;
  withdrawCount: number;
  currentRoot: Uint8Array;
  tokenMint: PublicKey | null;
  tokenDecimals: number | null;
  assetType: "sol" | "spl";
  treeDepth: number;
  nullifierVersion: number;
  legacy: boolean;
  feeCapable: boolean;
  protocolFeeBps: number;
  treasury: PublicKey | null;
}

export interface WithdrawalAmounts {
  protocolFee: number;
  protocolFeeRaw: number;
  relayerFee: number;
  relayerFeeRaw: number;
  recipientAmount: number;
  recipientAmountRaw: number;
  totalFee: number;
  totalFeeRaw: number;
}

export interface WithdrawalEstimate extends WithdrawalAmounts {
  depositAmount: number;
  depositAmountRaw: number;
  protocolFeeBps: number;
}

export interface DirectWithdrawResult extends WithdrawalEstimate {
  txSignature: string;
}

export interface WithdrawalResult extends DirectWithdrawResult {}

export interface RelayerWithdrawRequest {
  pool: string;
  proof: string;
  root: string;
  nullifierHash: string;
  recipient: string;
  fee: number;
}

export interface SignedRelayerWithdrawRequest {
  payload: RelayerWithdrawRequest;
  signature: string;
  sessionPubkey: string;
  timestamp: number;
}

export interface RelayerInfoResponse {
  pool: string;
  poolDenomination?: number;
  poolDenominationRaw?: number;
  protocolFeeBps?: number;
  relayerFeeBps?: number;
  totalFeeBps?: number;
  estimatedRecipientLamports?: number;
  treasury?: string | null;
  fee: {
    feeBps: number;
    minFeeLamports: number;
    protocolFeeBps?: number;
    breakdown?: WithdrawalEstimate;
  };
  network: string;
  programId: string;
  relayer: string;
  relayerBalanceLamports: number;
  maxRequestAgeMs: number;
}

export interface RelayerWithdrawSuccessResponse {
  success: true;
  txSignature: string;
  fee: number;
  recipientReceived: number;
  protocolFee?: number;
  protocolFeeRaw?: number;
  relayerFee?: number;
  relayerFeeRaw?: number;
  recipientAmount?: number;
  recipientAmountRaw?: number;
  totalFee?: number;
  totalFeeRaw?: number;
}

export interface RelayerWithdrawErrorResponse {
  success: false;
  error: string;
}

export interface RelayerWithdrawResult extends WithdrawalEstimate {
  txSignature: string;
  fee: number;
  recipientReceived?: number;
}

export interface TransactionRecord {
  type: "deposit" | "withdrawal";
  amount: number;
  timestamp: number;
  commitmentIndex: number;
  nullified: boolean;
}

export type RelayerWithdrawResponse =
  | RelayerWithdrawSuccessResponse
  | RelayerWithdrawErrorResponse;

export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]>;
  payer?: Keypair;
}

export type SNAPWallet = Wallet | WalletAdapter | Keypair;
