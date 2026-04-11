import fs from "fs";
import path from "path";
import {
  AnchorProvider,
  Program,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  type Account as TokenAccount,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type ConfirmedTransactionMeta,
} from "@solana/web3.js";
import {
  SNAPClient,
  SNAP_IDL,
  SNAP_PROGRAM_ID,
  type Note,
} from "../sdk-package/src";
import { bytesToHex, hexToBytes } from "../sdk-package/src/commitment";
import {
  closeConnection,
  loadKeypair,
  waitForNewSignature,
  writeJsonArtifact,
} from "./relayer-harness";
import {
  fetchPoolStorageFootprint,
  type StressContext,
} from "../tests/stress/shared";
import { deriveVaultPda } from "../tests/helpers";

const DEVNET_RESULTS_DIR = path.resolve("devnet-results");
const DEVNET_NOTE_PERSISTENCE_ENV = "SNAP_DEVNET_PERSIST_NOTES";
const DEVNET_NOTE_JOURNAL_MODE = 0o600;

export interface TxObservation {
  error: string | null;
  latencyMs: number;
  retryErrors: string[];
  retries: number;
  signature: string;
  slot: number | null;
}

export interface DepositObservation extends TxObservation {
  note: Note;
}

export interface DevnetContext extends StressContext {}

export type DevnetNoteDepositState = "planned" | "confirmed" | "failed";

export interface DevnetNoteRecord {
  amount: number;
  assetType: "sol" | "spl";
  commitment: string;
  depositState: DevnetNoteDepositState;
  depositIndex: number;
  lastError: string | null;
  depositSignature: string | null;
  nullifier: string;
  nullifierHash: string;
  pool: string;
  secret: string;
  stage: string;
  withdrawalSignature: string | null;
  withdrawn: boolean;
}

export interface DevnetNoteJournal {
  metadata: ReturnType<typeof buildMetadata>;
  notes: DevnetNoteRecord[];
}

export function createDevnetContext(
  rpcUrl: string,
  payerPath: string,
): DevnetContext {
  const connection = new Connection(rpcUrl, "confirmed");
  const payer = loadKeypair(payerPath);
  const wallet = toWalletAdapter(payer);
  const provider = new AnchorProvider(connection, wallet as Wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(
    { ...SNAP_IDL, address: SNAP_PROGRAM_ID.toBase58() } as never,
    provider,
  );

  return {
    connection,
    payer,
    program,
    provider,
    snap: new SNAPClient(connection, payer),
  };
}

export function closeDevnetContext(context: DevnetContext): void {
  closeConnection(context.connection);
}

export function devnetArtifactPath(fileName: string): string {
  fs.mkdirSync(DEVNET_RESULTS_DIR, { recursive: true });
  return path.join(DEVNET_RESULTS_DIR, fileName);
}

export function writeDevnetArtifact(fileName: string, value: unknown): string {
  return writeDevnetArtifactWithOptions(fileName, value);
}

export function writeDevnetArtifactWithOptions(
  fileName: string,
  value: unknown,
  options: {
    mode?: number;
  } = {},
): string {
  const outputPath = devnetArtifactPath(fileName);
  writeJsonArtifact(outputPath, value, options);
  return outputPath;
}

export function createNoteJournal(context: DevnetContext): DevnetNoteJournal {
  return {
    metadata: buildMetadata(context),
    notes: [],
  };
}

export function requireDevnetNotePersistence(runnerName: string): void {
  if (process.env[DEVNET_NOTE_PERSISTENCE_ENV] === "1") {
    return;
  }

  throw new Error(
    `${runnerName} refuses to run without recoverable note persistence. Set ${DEVNET_NOTE_PERSISTENCE_ENV}=1.`,
  );
}

export function initializePersistentNoteJournal(
  context: DevnetContext,
  fileName: string,
  runnerName: string,
): DevnetNoteJournal {
  requireDevnetNotePersistence(runnerName);
  const journal = createNoteJournal(context);
  persistDevnetNoteJournal(fileName, journal);
  return journal;
}

export function persistDevnetNoteJournal(
  fileName: string,
  journal: DevnetNoteJournal,
): string {
  return writeDevnetArtifactWithOptions(fileName, journal, {
    mode: DEVNET_NOTE_JOURNAL_MODE,
  });
}

export function recordDevnetNote(
  journal: DevnetNoteJournal,
  note: Note,
  details: {
    amount: number;
    assetType: "sol" | "spl";
    depositSignature?: string | null;
    stage: string;
  },
): void {
  upsertDevnetNoteRecord(journal, note, {
    amount: details.amount,
    assetType: details.assetType,
    depositSignature: details.depositSignature ?? null,
    depositState: "confirmed",
    lastError: null,
    stage: details.stage,
  });
}

export function recordPlannedDevnetNote(
  journal: DevnetNoteJournal,
  note: Note,
  details: {
    amount: number;
    assetType: "sol" | "spl";
    stage: string;
  },
): void {
  upsertDevnetNoteRecord(journal, note, {
    amount: details.amount,
    assetType: details.assetType,
    depositState: "planned",
    lastError: null,
    stage: details.stage,
  });
}

export function markDevnetNoteDeposited(
  journal: DevnetNoteJournal,
  note: Note,
  depositSignature?: string | null,
): void {
  const entry = findDevnetNoteRecord(journal, note);
  if (!entry) {
    return;
  }

  entry.depositState = "confirmed";
  entry.lastError = null;
  if (depositSignature !== undefined) {
    entry.depositSignature = depositSignature;
  }
}

export function markDevnetNoteFailed(
  journal: DevnetNoteJournal,
  note: Note,
  error: string,
): void {
  const entry = findDevnetNoteRecord(journal, note);
  if (!entry) {
    return;
  }

  entry.depositState = "failed";
  entry.lastError = error;
}

export function markDevnetNoteWithdrawn(
  journal: DevnetNoteJournal,
  note: Note,
  withdrawalSignature: string | null,
): void {
  const entry = findDevnetNoteRecord(journal, note);
  if (!entry) {
    return;
  }

  entry.withdrawn = true;
  entry.depositState = "confirmed";
  entry.lastError = null;
  if (withdrawalSignature !== null) {
    entry.withdrawalSignature = withdrawalSignature;
  }
}

export function devnetNoteRecordToNote(record: DevnetNoteRecord): Note {
  return {
    commitment: hexToBytes(record.commitment, 32),
    depositIndex: record.depositIndex,
    nullifier: BigInt(record.nullifier),
    nullifierHash: hexToBytes(record.nullifierHash, 32),
    poolAddress: record.pool,
    secret: BigInt(record.secret),
  };
}

export async function fundSystemAccounts(
  connection: Connection,
  payer: Keypair,
  recipients: Keypair[],
  lamportsEach: number,
): Promise<string[]> {
  const signatures: string[] = [];

  for (let start = 0; start < recipients.length; start += 8) {
    const batch = recipients.slice(start, start + 8);
    const transaction = new Transaction();
    for (const recipient of batch) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          lamports: lamportsEach,
          toPubkey: recipient.publicKey,
        }),
      );
    }

    signatures.push(
      await sendAndConfirmTransaction(connection, transaction, [payer], {
        commitment: "confirmed",
      }),
    );
  }

  return signatures;
}

export async function prefundSolVaultForLowDenomination(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  programId: PublicKey,
  depositAmountLamports: number,
): Promise<{
  currentVaultLamports: number;
  fundedLamports: number;
  minimumRentLamports: number;
  vault: PublicKey;
}> {
  const [vault] = deriveVaultPda(pool, programId);
  const minimumRentLamports = await connection.getMinimumBalanceForRentExemption(0);
  const currentVaultLamports = await connection.getBalance(vault, "confirmed");

  if (depositAmountLamports >= minimumRentLamports) {
    return {
      currentVaultLamports,
      fundedLamports: 0,
      minimumRentLamports,
      vault,
    };
  }

  const fundedLamports = Math.max(0, minimumRentLamports - currentVaultLamports);
  if (fundedLamports > 0) {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        lamports: fundedLamports,
        toPubkey: vault,
      }),
    );
    await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: "confirmed",
    });
  }

  return {
    currentVaultLamports,
    fundedLamports,
    minimumRentLamports,
    vault,
  };
}

export async function createMintAndFundPayer(
  connection: Connection,
  payer: Keypair,
  decimals: number,
  amountRaw: number,
): Promise<{ ata: TokenAccount; mint: PublicKey }> {
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    decimals,
  );
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
  );
  await mintTo(
    connection,
    payer,
    mint,
    ata.address,
    payer.publicKey,
    amountRaw,
  );

  return {
    ata,
    mint,
  };
}

export async function withDevnetRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: {
    backoffMs?: number[];
  } = {},
): Promise<{ result: T; retryErrors: string[]; retries: number }> {
  const retryErrors: string[] = [];
  const backoffMs = options.backoffMs ?? [1_000, 2_500, 5_000];

  let lastError: unknown;
  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    try {
      return {
        result: await fn(),
        retryErrors,
        retries: attempt,
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableDevnetError(message) || attempt === backoffMs.length) {
        throw error;
      }

      retryErrors.push(`${label} retry ${attempt + 1}: ${message}`);
      await sleep(backoffMs[attempt]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function depositWithSignature(
  context: DevnetContext,
  pool: PublicKey,
  amount?: number,
): Promise<DepositObservation> {
  const seen = await recentSignatures(context.connection, context.payer.publicKey);
  const startedAt = Date.now();
  const { result: note, retryErrors, retries } = await withDevnetRetry(
    "deposit",
    () => context.snap.deposit(pool, amount),
  );
  const signature = await waitForNewSignature(
    context.connection,
    context.payer.publicKey,
    seen,
    "devnet deposit",
    60_000,
  );
  const details = await fetchSignatureDetails(context.connection, signature);

  return {
    error: details.error,
    latencyMs: Date.now() - startedAt,
    note,
    retryErrors,
    retries,
    signature,
    slot: details.slot,
  };
}

export async function withdrawWithSignature(
  context: DevnetContext,
  pool: PublicKey,
  note: Note,
  recipient: Keypair | PublicKey,
): Promise<TxObservation> {
  const startedAt = Date.now();
  const { result: signature, retryErrors, retries } = await withDevnetRetry(
    "withdraw",
    () => context.snap.withdraw(pool, note, recipient),
  );
  const details = await fetchSignatureDetails(context.connection, signature);

  return {
    error: details.error,
    latencyMs: Date.now() - startedAt,
    retryErrors,
    retries,
    signature,
    slot: details.slot,
  };
}

export async function fetchPoolSnapshot(
  context: DevnetContext,
  pool: PublicKey,
): Promise<{
  assetType: "sol" | "spl";
  commitmentPageBytes: number;
  commitmentPageCount: number;
  commitmentPageRentLamports: number;
  depositAmountRaw: number;
  depositCount: number;
  poolAccountBytes: number;
  poolRentLamports: number;
  totalStorageBytes: number;
  totalStorageRentLamports: number;
  treeDepth: number;
  withdrawCount: number;
}> {
  const poolInfo = await context.snap.getPoolInfo(pool);
  const footprint = await fetchPoolStorageFootprint(
    context.connection,
    pool,
    context.program.programId,
    poolInfo.depositCount,
  );

  return {
    assetType: poolInfo.assetType,
    commitmentPageBytes: footprint.commitmentPageBytes,
    commitmentPageCount: footprint.commitmentPageCount,
    commitmentPageRentLamports: footprint.commitmentPageRentLamports,
    depositAmountRaw: poolInfo.depositAmountRaw,
    depositCount: poolInfo.depositCount,
    poolAccountBytes: footprint.poolAccountBytes,
    poolRentLamports: footprint.poolRentLamports,
    totalStorageBytes: footprint.totalStorageBytes,
    totalStorageRentLamports: footprint.totalStorageRentLamports,
    treeDepth: poolInfo.treeDepth,
    withdrawCount: poolInfo.withdrawCount,
  };
}

export async function fetchSignatureDetails(
  connection: Connection,
  signature: string,
): Promise<{ error: string | null; slot: number | null }> {
  const tx = await fetchTransactionWithRetries(connection, signature);
  return {
    error: tx?.meta?.err ? JSON.stringify(tx.meta.err) : null,
    slot: tx?.slot ?? null,
  };
}

export function isRetryableDevnetError(message: string): boolean {
  return /429|Too Many Requests|Blockhash|Timed out|Node is behind|fetch failed|socket hang up|503|502|already processed|was not confirmed/i.test(
    message,
  );
}

export function buildMetadata(context: DevnetContext) {
  return {
    generatedAt: new Date().toISOString(),
    programId: context.program.programId.toBase58(),
    rpcUrl: context.connection.rpcEndpoint,
    wallet: context.payer.publicKey.toBase58(),
  };
}

export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting after ${timeoutMs}ms`);
    }

    await sleep(intervalMs);
  }
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function recentSignatures(
  connection: Connection,
  address: PublicKey,
): Promise<Set<string>> {
  return new Set(
    (
      await connection.getSignaturesForAddress(address, { limit: 20 }, "confirmed")
    ).map((entry) => entry.signature),
  );
}

async function fetchTransactionWithRetries(
  connection: Connection,
  signature: string,
  attempts = 20,
): Promise<
  | {
      meta: ConfirmedTransactionMeta | null;
      slot: number;
    }
  | null
> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      return {
        meta: tx.meta,
        slot: tx.slot,
      };
    }

    await sleep(500);
  }

  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function findDevnetNoteRecord(
  journal: DevnetNoteJournal,
  note: Note,
): DevnetNoteRecord | undefined {
  const nullifierHash = bytesToHex(note.nullifierHash);
  return journal.notes.find(
    (candidate) =>
      candidate.pool === note.poolAddress &&
      candidate.depositIndex === note.depositIndex &&
      candidate.nullifierHash === nullifierHash,
  );
}

function upsertDevnetNoteRecord(
  journal: DevnetNoteJournal,
  note: Note,
  details: {
    amount: number;
    assetType: "sol" | "spl";
    depositSignature?: string | null;
    depositState: DevnetNoteDepositState;
    lastError: string | null;
    stage: string;
  },
): void {
  const existing = findDevnetNoteRecord(journal, note);
  if (existing) {
    existing.amount = details.amount;
    existing.assetType = details.assetType;
    existing.depositState = details.depositState;
    existing.lastError = details.lastError;
    existing.stage = details.stage;
    if (details.depositSignature !== undefined) {
      existing.depositSignature = details.depositSignature;
    }
    return;
  }

  journal.notes.push({
    amount: details.amount,
    assetType: details.assetType,
    commitment: bytesToHex(note.commitment),
    depositIndex: note.depositIndex,
    depositSignature: details.depositSignature ?? null,
    depositState: details.depositState,
    lastError: details.lastError,
    nullifier: note.nullifier.toString(),
    nullifierHash: bytesToHex(note.nullifierHash),
    pool: note.poolAddress,
    secret: note.secret.toString(),
    stage: details.stage,
    withdrawalSignature: null,
    withdrawn: false,
  });
}

function toWalletAdapter(
  signer: Keypair,
): Wallet & {
  payer: Keypair;
} {
  return {
    payer: signer,
    publicKey: signer.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> => {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([signer]);
        return transaction;
      }

      transaction.partialSign(signer);
      return transaction;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      transactions: T[],
    ): Promise<T[]> => {
      return Promise.all(
        transactions.map(async (transaction) => {
          if (transaction instanceof VersionedTransaction) {
            transaction.sign([signer]);
            return transaction;
          }

          transaction.partialSign(signer);
          return transaction;
        }),
      );
    },
  } as Wallet & { payer: Keypair };
}
