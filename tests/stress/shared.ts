import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import {
  AnchorProvider,
  BN,
  Program,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
  type TransactionInstruction,
  type TransactionSignature,
} from "@solana/web3.js";
import {
  SNAPClient,
  SNAP_IDL,
  SNAP_PROGRAM_ID,
  type Note,
} from "../../sdk-package/src";
import {
  COMMITMENT_PAGE_CAPACITY,
  decodeCommitmentPageState,
  deriveCommitmentPagePda,
  mergeCommitmentSources,
} from "../../sdk-package/src/commitment-pages";
import { bytesEqual, bytesToHex, createNote } from "../../sdk-package/src/commitment";
import {
  generateWithdrawProof,
  type GeneratedProof,
} from "../../sdk-package/src/proof";
import {
  getRecordField,
  normalizeBytesMatrix,
  toNumber,
} from "../../sdk-package/src/utils";
import { signRelayerWithdrawRequest } from "../../sdk-package/src/relayer-auth";
import {
  closeConnection,
  startRelayerHarness,
  stopRelayerHarness,
  writeJsonArtifact,
  type RelayerHarness,
} from "../../scripts/relayer-harness";
import {
  computeBudgetIx,
  deriveVaultPda,
  deriveNullifierRecordPda,
  extractComputeUnits,
  fetchTransactionComputeUnits,
} from "../helpers";

const DEFAULT_PROVER_TIMEOUT_MS = 180_000;
const LOCALNET_HOSTS = ["127.0.0.1", "localhost"];
const STRESS_RESULTS_DIR = path.resolve("stress-results");

export interface StressContext {
  connection: Connection;
  payer: Keypair;
  program: Program<any>;
  provider: AnchorProvider;
  snap: SNAPClient;
}

export interface StressPoolState {
  assetType: "sol" | "spl";
  commitments: Uint8Array[];
  depositAmountRaw: number;
  kind: "legacy" | "v2" | "feeV2";
  nextIndex: number;
  nullifierCount: number;
  nullifierVersion: number;
  protocolFeeBps: number;
  roots: Uint8Array[];
  treasury: PublicKey | null;
  tokenDecimals: number | null;
  tokenMint: PublicKey | null;
  treeDepth: number;
}

export interface PreparedTransaction {
  blockhash: BlockhashWithExpiryBlockHeight;
  label: string;
  transaction: Transaction;
}

export interface OperationAttempt {
  agent: Keypair;
  note?: Note;
  proof?: GeneratedProof;
  recipient?: Keypair;
  tx: PreparedTransaction;
}

export interface OperationResult {
  agent: string;
  computeUnits: number | null;
  errorMessage: string | null;
  errorType: string | null;
  label: string;
  latencyMs: number;
  recipient?: string;
  signature: string | null;
  succeeded: boolean;
}

export interface OperationSummary {
  attempted: number;
  computeUnits: number[];
  errors: Record<string, number>;
  failed: number;
  latencies: number[];
  succeeded: number;
}

export interface ProofGenerationMeasurement {
  agent: string;
  latencyMs: number;
  note: Note;
  proof: GeneratedProof;
  recipient: Keypair;
}

export interface SolPoolHandle {
  pool: PublicKey;
  poolVault: PublicKey;
  treeDepth: 10 | 20;
}

export interface SplPoolHandle extends SolPoolHandle {
  mint: PublicKey;
}

export interface TokenAccountBundle {
  owner: Keypair;
  tokenAccount: PublicKey;
}

export interface MemorySnapshot {
  arrayBuffers: number;
  external: number;
  heapTotal: number;
  heapUsed: number;
  rss: number;
  timestamp: string;
}

export interface SummaryTableRow {
  concurrency: number | string;
  contentionPct: string;
  depositTps: string;
  p95LatencyMs: string;
  withdrawTps: string;
}

export function createStressContext(): StressContext {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  assertLocalnet(provider.connection.rpcEndpoint);

  const wallet = provider.wallet as Wallet & { payer?: Keypair };
  if (!(wallet.payer instanceof Keypair)) {
    throw new Error("SNAP stress tests require a Keypair-backed ANCHOR_WALLET");
  }

  const program = new Program(
    { ...SNAP_IDL, address: SNAP_PROGRAM_ID.toBase58() } as never,
    provider,
  );

  return {
    connection: provider.connection,
    payer: wallet.payer,
    program,
    provider,
    snap: new SNAPClient(provider.connection, wallet.payer),
  };
}

export function closeStressContext(context: StressContext): void {
  closeConnection(context.connection);
}

export async function createSolPool(
  context: StressContext,
  depositAmountLamports: number,
  treeDepth: 10 | 20,
): Promise<SolPoolHandle> {
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, context.program.programId);

  await (context.program.methods as any)
    .initializeV2(new BN(depositAmountLamports), treeDepth)
    .accounts({
      pool: pool.publicKey,
      poolVault,
      authority: context.payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([computeBudgetIx(treeDepth > 10 ? 1_400_000 : 500_000)])
    .rpc();

  return {
    pool: pool.publicKey,
    poolVault,
    treeDepth,
  };
}

export async function createSplPool(
  context: StressContext,
  depositAmountRaw: number,
  decimals = 6,
): Promise<SplPoolHandle> {
  const mint = await createMint(
    context.connection,
    context.payer,
    context.payer.publicKey,
    null,
    decimals,
  );
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, context.program.programId);

  await (context.program.methods as any)
    .initializeSpl(new BN(depositAmountRaw), mint)
    .accounts({
      pool: pool.publicKey,
      poolVault,
      tokenMintAccount: mint,
      authority: context.payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();

  return {
    mint,
    pool: pool.publicKey,
    poolVault,
    treeDepth: 20,
  };
}

export async function fetchPoolState(
  program: Program<any>,
  connection: Connection,
  pool: PublicKey,
): Promise<StressPoolState> {
  let account: Record<string, unknown>;
  let kind: StressPoolState["kind"];
  try {
    account = await (program.account as any).poolFeeV2.fetch(pool);
    kind = "feeV2";
  } catch {
    account = await (program.account as any).poolV2.fetch(pool);
    kind = "v2";
  }
  const record = account as Record<string, unknown>;
  const tokenMint = normalizePublicKey(
    getRecordField(record, "tokenMint", "token_mint"),
  );
  const nextIndex = toNumber(getRecordField(record, "nextIndex", "next_index"));
  const inlineCommitments = normalizeBytesMatrix(getRecordField(record, "commitments"));
  const commitments = await fetchCommitmentsForPool(
    program,
    connection,
    pool,
    nextIndex,
    inlineCommitments,
  );

  return {
    assetType: tokenMint ? "spl" : "sol",
    commitments,
    depositAmountRaw: toNumber(
      getRecordField(record, "depositAmount", "deposit_amount"),
    ),
    kind,
    nextIndex,
    nullifierCount: toNumber(
      getRecordField(record, "nullifierCount", "nullifier_count"),
    ),
    nullifierVersion: toNumber(
      getRecordField(record, "nullifierVersion", "nullifier_version"),
    ),
    protocolFeeBps:
      kind === "feeV2"
        ? toNumber(
            getRecordField(record, "protocolFeeBps", "protocol_fee_bps"),
          )
        : 0,
    roots: normalizeBytesMatrix(getRecordField(record, "roots")),
    treasury:
      kind === "feeV2"
        ? normalizePublicKey(getRecordField(record, "treasury"))
        : null,
    tokenDecimals:
      tokenMint === null
        ? null
        : (await getMint(connection, tokenMint, "confirmed")).decimals,
    tokenMint,
    treeDepth: toNumber(getRecordField(record, "treeDepth", "tree_depth")),
  };
}

export async function requestAirdrops(
  connection: Connection,
  wallets: Keypair[],
  lamports: number,
): Promise<void> {
  const signatures = await Promise.all(
    wallets.map(async (wallet) => {
      const signature = await connection.requestAirdrop(wallet.publicKey, lamports);
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        {
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          signature,
        },
        "confirmed",
      );
      return signature;
    }),
  );

  if (signatures.length !== wallets.length) {
    throw new Error("Airdrop verification mismatch");
  }
}

export function makeAgentWallets(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.generate());
}

export async function createNotesForPool(
  pool: PublicKey,
  count: number,
  startIndex = 0,
): Promise<Note[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) => createNote(pool, startIndex + index)),
  );
}

export async function mintTokensToAgents(
  context: StressContext,
  mint: PublicKey,
  owners: Keypair[],
  amountRaw: number,
): Promise<TokenAccountBundle[]> {
  const bundles: TokenAccountBundle[] = [];

  for (const owner of owners) {
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      context.connection,
      context.payer,
      mint,
      owner.publicKey,
    );
    await mintTo(
      context.connection,
      context.payer,
      mint,
      tokenAccount.address,
      context.payer.publicKey,
      amountRaw,
    );
    bundles.push({
      owner,
      tokenAccount: tokenAccount.address,
    });
  }

  return bundles;
}

export async function prepareTransaction(
  transactionPromise: Promise<Transaction>,
  feePayer: Keypair,
  signers: Keypair[],
  blockhash: BlockhashWithExpiryBlockHeight,
  label: string,
): Promise<PreparedTransaction> {
  const transaction = await transactionPromise;
  transaction.feePayer = feePayer.publicKey;
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.sign(...signers);

  return {
    blockhash,
    label,
    transaction,
  };
}

export async function executeOperationBatch(
  connection: Connection,
  attempts: OperationAttempt[],
): Promise<OperationResult[]> {
  const settled = await Promise.allSettled(
    attempts.map((attempt) => sendTrackedTransaction(connection, attempt)),
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      agent: attempts[index].agent.publicKey.toBase58(),
      computeUnits: null,
      errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason),
      errorType: classifyError(result.reason),
      label: attempts[index].tx.label,
      latencyMs: 0,
      recipient: attempts[index].recipient?.publicKey.toBase58(),
      signature: null,
      succeeded: false,
    } satisfies OperationResult;
  });
}

export function summarizeOperations(results: OperationResult[]): OperationSummary {
  const errors: Record<string, number> = {};
  const latencies: number[] = [];
  const computeUnits: number[] = [];
  let succeeded = 0;

  for (const result of results) {
    if (result.succeeded) {
      succeeded += 1;
      latencies.push(result.latencyMs);
      if (result.computeUnits !== null) {
        computeUnits.push(result.computeUnits);
      }
      continue;
    }

    const key = result.errorType ?? "Unknown";
    errors[key] = (errors[key] ?? 0) + 1;
  }

  return {
    attempted: results.length,
    computeUnits,
    errors,
    failed: results.length - succeeded,
    latencies,
    succeeded,
  };
}

export async function generateProofMeasurements(
  poolState: StressPoolState,
  notes: Note[],
  recipients: Keypair[],
  proverTimeoutMs = DEFAULT_PROVER_TIMEOUT_MS,
): Promise<ProofGenerationMeasurement[]> {
  const settled = await Promise.allSettled(
    notes.map(async (note, index) => {
      const startedAt = Date.now();
      const proof = await generateWithdrawProof(
        note,
        poolState.commitments,
        recipients[index].publicKey,
        proverTimeoutMs,
        poolState.treeDepth,
      );

      return {
        agent: recipients[index].publicKey.toBase58(),
        latencyMs: Date.now() - startedAt,
        note,
        proof,
        recipient: recipients[index],
      } satisfies ProofGenerationMeasurement;
    }),
  );

  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }

  return settled.map(
    (result) => (result as PromiseFulfilledResult<ProofGenerationMeasurement>).value,
  );
}

export async function buildSolDepositAttempts(
  context: StressContext,
  pool: SolPoolHandle,
  agents: Keypair[],
  notes: Note[],
): Promise<OperationAttempt[]> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");

  return Promise.all(
    agents.map(async (agent, index) => ({
      agent,
      note: notes[index],
      tx: await prepareTransaction(
        (context.program.methods as any)
          .depositV2(
            Array.from(notes[index].commitment),
            Math.floor(notes[index].depositIndex / COMMITMENT_PAGE_CAPACITY),
          )
          .accounts({
            commitmentPage: deriveCommitmentPagePda(
              pool.pool,
              Math.floor(notes[index].depositIndex / COMMITMENT_PAGE_CAPACITY),
              context.program.programId,
            )[0],
            pool: pool.pool,
            poolVault: pool.poolVault,
            depositor: agent.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([computeBudgetIx(pool.treeDepth > 10 ? 1_400_000 : 500_000)])
          .transaction(),
        agent,
        [agent],
        blockhash,
        "deposit",
      ),
    })),
  );
}

export async function buildSolWithdrawAttempts(
  context: StressContext,
  pool: SolPoolHandle,
  proofs: ProofGenerationMeasurement[],
): Promise<OperationAttempt[]> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");

  return Promise.all(
    proofs.map(async (measurement) => {
      const [nullifierRecord] = deriveNullifierRecordPda(
        pool.pool,
        Uint8Array.from(measurement.proof.nullifierHashBytes),
        context.program.programId,
      );

      return {
        agent: measurement.recipient,
        note: measurement.note,
        proof: measurement.proof,
        recipient: measurement.recipient,
        tx: await prepareTransaction(
          (context.program.methods as any)
            .withdrawZkV2(
              measurement.proof.proofABytes,
              measurement.proof.proofBBytes,
              measurement.proof.proofCBytes,
              measurement.proof.rootBytes,
              measurement.proof.nullifierHashBytes,
            )
            .accounts({
              pool: pool.pool,
              poolVault: pool.poolVault,
              recipient: measurement.recipient.publicKey,
              payer: measurement.recipient.publicKey,
              nullifierRecord,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions([
              computeBudgetIx(pool.treeDepth > 10 ? 1_400_000 : 500_000),
            ])
            .transaction(),
          measurement.recipient,
          [measurement.recipient],
          blockhash,
          "withdraw",
        ),
      } satisfies OperationAttempt;
    }),
  );
}

export async function buildSplDepositAttempts(
  context: StressContext,
  pool: SplPoolHandle,
  bundles: TokenAccountBundle[],
  notes: Note[],
): Promise<OperationAttempt[]> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");

  return Promise.all(
    bundles.map(async (bundle, index) => ({
      agent: bundle.owner,
      note: notes[index],
      tx: await prepareTransaction(
        (context.program.methods as any)
          .depositSpl(
            Array.from(notes[index].commitment),
            Math.floor(notes[index].depositIndex / COMMITMENT_PAGE_CAPACITY),
          )
          .accounts({
            commitmentPage: deriveCommitmentPagePda(
              pool.pool,
              Math.floor(notes[index].depositIndex / COMMITMENT_PAGE_CAPACITY),
              context.program.programId,
            )[0],
            pool: pool.pool,
            poolVault: pool.poolVault,
            depositor: bundle.owner.publicKey,
            depositorTokenAccount: bundle.tokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([computeBudgetIx(1_400_000)])
          .transaction(),
        bundle.owner,
        [bundle.owner],
        blockhash,
        "deposit_spl",
      ),
    })),
  );
}

export async function buildSplWithdrawAttempts(
  context: StressContext,
  pool: SplPoolHandle,
  proofs: ProofGenerationMeasurement[],
  options: {
    createRecipientAtaIfMissing?: boolean;
    mint: PublicKey;
    payerIsRecipient?: boolean;
  },
): Promise<OperationAttempt[]> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");

  return Promise.all(
    proofs.map(async (measurement) => {
      const payer = options.payerIsRecipient ? measurement.recipient : context.payer;
      const recipientTokenAccount = getAssociatedTokenAddressSync(
        options.mint,
        measurement.recipient.publicKey,
      );
      const preInstructions: TransactionInstruction[] = [computeBudgetIx(1_400_000)];

      if (
        options.createRecipientAtaIfMissing &&
        !(await context.connection.getAccountInfo(recipientTokenAccount, "confirmed"))
      ) {
        preInstructions.push(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            recipientTokenAccount,
            measurement.recipient.publicKey,
            options.mint,
          ),
        );
      }

      const [nullifierRecord] = deriveNullifierRecordPda(
        pool.pool,
        Uint8Array.from(measurement.proof.nullifierHashBytes),
        context.program.programId,
      );

      return {
        agent: payer,
        note: measurement.note,
        proof: measurement.proof,
        recipient: measurement.recipient,
        tx: await prepareTransaction(
          (context.program.methods as any)
            .withdrawZkSpl(
              measurement.proof.proofABytes,
              measurement.proof.proofBBytes,
              measurement.proof.proofCBytes,
              measurement.proof.rootBytes,
              measurement.proof.nullifierHashBytes,
            )
            .accounts({
              pool: pool.pool,
              poolVault: pool.poolVault,
              recipient: measurement.recipient.publicKey,
              recipientTokenAccount,
              payer: payer.publicKey,
              nullifierRecord,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions(preInstructions)
            .transaction(),
          payer,
          [payer],
          blockhash,
          "withdraw_spl",
        ),
      } satisfies OperationAttempt;
    }),
  );
}

export async function createSignedRelayRequest(
  pool: PublicKey,
  note: Note,
  poolState: StressPoolState,
  recipient: PublicKey,
  fee: number,
  signer: Keypair,
  proverTimeoutMs = DEFAULT_PROVER_TIMEOUT_MS,
) {
  const proof = await generateWithdrawProof(
    note,
    poolState.commitments,
    recipient,
    proverTimeoutMs,
    poolState.treeDepth,
  );

  return signRelayerWithdrawRequest(
    {
      fee,
      nullifierHash: bytesToHex(Uint8Array.from(proof.nullifierHashBytes)),
      pool: pool.toBase58(),
      proof: bytesToHex(
        Uint8Array.from([
          ...proof.proofABytes,
          ...proof.proofBBytes,
          ...proof.proofCBytes,
        ]),
      ),
      recipient: recipient.toBase58(),
      root: bytesToHex(Uint8Array.from(proof.rootBytes)),
    },
    signer.secretKey.slice(0, 32),
  );
}

export async function postJson(
  url: string,
  payload: unknown,
): Promise<{ body: any; headers: Headers; status: number }> {
  const response = await fetch(url, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  return {
    body: await response.json(),
    headers: response.headers,
    status: response.status,
  };
}

export function createRelayerDbPath(prefix: string): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    "relayer.sqlite",
  );
}

export function snapshotMemory(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    arrayBuffers: usage.arrayBuffers,
    external: usage.external,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    timestamp: new Date().toISOString(),
  };
}

export async function createRelayer(
  context: StressContext,
  pool: PublicKey,
  options: {
    feeBps?: number;
    maxRequestsPerMinuteGlobal?: number;
    maxRequestsPerMinutePerIp?: number;
    minFeeLamports?: number;
    retryBackoffMs?: number[];
    retryPollIntervalMs?: number;
  } = {},
): Promise<{ dbPath: string; harness: RelayerHarness; relayer: Keypair }> {
  const relayer = Keypair.generate();
  const dbPath = createRelayerDbPath("snap-relayer-throughput-");
  const rentAndFees = 2 * LAMPORTS_PER_SOL;
  const signature = await context.connection.requestAirdrop(
    relayer.publicKey,
    rentAndFees,
  );
  const latest = await context.connection.getLatestBlockhash("confirmed");
  await context.connection.confirmTransaction(
    {
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      signature,
    },
    "confirmed",
  );

  const harness = await startRelayerHarness({
    cluster: "localnet",
    connection: context.connection,
    dbPath,
    feeBps: options.feeBps,
    maxRequestsPerMinuteGlobal: options.maxRequestsPerMinuteGlobal,
    maxRequestsPerMinutePerIp: options.maxRequestsPerMinutePerIp,
    minFeeLamports: options.minFeeLamports,
    pool,
    relayer,
    retryBackoffMs: options.retryBackoffMs,
    retryPollIntervalMs: options.retryPollIntervalMs,
  });

  return {
    dbPath,
    harness,
    relayer,
  };
}

export async function disposeRelayer(
  harness: RelayerHarness | undefined,
  dbPath: string | undefined,
): Promise<void> {
  await stopRelayerHarness(harness);
  if (dbPath) {
    fs.rmSync(path.dirname(dbPath), { force: true, recursive: true });
  }
}

export async function fetchPoolFootprint(
  connection: Connection,
  address: PublicKey,
): Promise<{ accountBytes: number; rentLamports: number }> {
  const accountInfo = await connection.getAccountInfo(address, "confirmed");
  if (!accountInfo) {
    throw new Error(`Pool account ${address.toBase58()} not found`);
  }

  return {
    accountBytes: accountInfo.data.length,
    rentLamports: accountInfo.lamports,
  };
}

export async function fetchPoolStorageFootprint(
  connection: Connection,
  pool: PublicKey,
  programId: PublicKey,
  nextIndex: number,
): Promise<{
  commitmentPageBytes: number;
  commitmentPageCount: number;
  commitmentPageRentLamports: number;
  poolAccountBytes: number;
  poolRentLamports: number;
  totalStorageBytes: number;
  totalStorageRentLamports: number;
}> {
  const poolFootprint = await fetchPoolFootprint(connection, pool);
  if (nextIndex <= 0) {
    return {
      commitmentPageBytes: 0,
      commitmentPageCount: 0,
      commitmentPageRentLamports: 0,
      poolAccountBytes: poolFootprint.accountBytes,
      poolRentLamports: poolFootprint.rentLamports,
      totalStorageBytes: poolFootprint.accountBytes,
      totalStorageRentLamports: poolFootprint.rentLamports,
    };
  }

  const pageAddresses = Array.from(
    { length: Math.ceil(nextIndex / COMMITMENT_PAGE_CAPACITY) },
    (_, pageIndex) => deriveCommitmentPagePda(pool, pageIndex, programId)[0],
  );
  const pageInfos = await connection.getMultipleAccountsInfo(pageAddresses, "confirmed");
  const existingPages = pageInfos.filter(
    (info): info is NonNullable<typeof info> => info !== null,
  );
  const commitmentPageBytes = existingPages.reduce(
    (total, info) => total + info.data.length,
    0,
  );
  const commitmentPageRentLamports = existingPages.reduce(
    (total, info) => total + info.lamports,
    0,
  );

  return {
    commitmentPageBytes,
    commitmentPageCount: existingPages.length,
    commitmentPageRentLamports,
    poolAccountBytes: poolFootprint.accountBytes,
    poolRentLamports: poolFootprint.rentLamports,
    totalStorageBytes: poolFootprint.accountBytes + commitmentPageBytes,
    totalStorageRentLamports:
      poolFootprint.rentLamports + commitmentPageRentLamports,
  };
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(index, 0)];
}

export function calculateTps(successCount: number, durationMs: number): number {
  if (durationMs <= 0) {
    return 0;
  }

  return (successCount * 1_000) / durationMs;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function formatPct(value: number): string {
  return `${round(value * 100, 1)}%`;
}

export function printSummaryTable(rows: SummaryTableRow[]): void {
  console.log(
    [
      "Concurrency | Deposit TPS | Withdraw TPS | Contention % | p95 Latency",
      "---------------------------------------------------------------------",
      ...rows.map((row) =>
        [
          pad(String(row.concurrency), 11),
          pad(row.depositTps, 11),
          pad(row.withdrawTps, 12),
          pad(row.contentionPct, 12),
          row.p95LatencyMs,
        ].join(" | "),
      ),
    ].join("\n"),
  );
}

export function artifactPath(fileName: string): string {
  fs.mkdirSync(STRESS_RESULTS_DIR, { recursive: true });
  return path.join(STRESS_RESULTS_DIR, fileName);
}

export function writeArtifact(fileName: string, value: unknown): string {
  const outputPath = artifactPath(fileName);
  writeJsonArtifact(outputPath, value);
  return outputPath;
}

export function readArtifact<T>(fileName: string): T | null {
  const outputPath = artifactPath(fileName);
  if (!fs.existsSync(outputPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(outputPath, "utf8")) as T;
}

export function buildArtifactHeader(context: StressContext) {
  return {
    generatedAt: new Date().toISOString(),
    programId: context.program.programId.toBase58(),
    rpcUrl: context.connection.rpcEndpoint,
    wallet: context.payer.publicKey.toBase58(),
  };
}

export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/AccountInUse|account in use|account is locked/i.test(message)) {
    return "AccountInUse";
  }

  if (
    /BlockhashNotFound|blockhash not found|TransactionExpiredBlockheightExceeded|block height exceeded|signature has expired/i.test(
      message,
    )
  ) {
    return "BlockhashNotFound";
  }

  if (
    /ComputationalBudgetExceeded|compute budget|exceeded maximum number of instructions|consumed .* compute units/i.test(
      message,
    )
  ) {
    return "ComputeBudgetExceeded";
  }

  if (/Custom.*6003|custom program error: 0x1773|AlreadyWithdrawn/i.test(message)) {
    return "Custom(6003)";
  }

  return "Unknown";
}

async function fetchCommitmentsForPool(
  program: Program<any>,
  connection: Connection,
  pool: PublicKey,
  nextIndex: number,
  inlineCommitments: Uint8Array[],
): Promise<Uint8Array[]> {
  if (nextIndex <= inlineCommitments.length) {
    return inlineCommitments;
  }

  const pageAddresses = Array.from(
    { length: Math.ceil(nextIndex / COMMITMENT_PAGE_CAPACITY) },
    (_, pageIndex) =>
      deriveCommitmentPagePda(pool, pageIndex, program.programId)[0],
  );
  const accountNamespace = program.account as Record<
    string,
    {
      fetchMultiple?: (addresses: PublicKey[]) => Promise<Array<Record<string, unknown> | null>>;
    }
  >;
  const pages = accountNamespace.commitmentPage?.fetchMultiple
    ? (
        await accountNamespace.commitmentPage.fetchMultiple(pageAddresses)
      ).flatMap((account) => (account ? [decodeCommitmentPageState(account)] : []))
    : (
        await connection.getMultipleAccountsInfo(pageAddresses, "confirmed")
      ).flatMap((info) => {
        if (!info) {
          return [];
        }

        try {
          const decoded = program.coder.accounts.decode(
            "CommitmentPage",
            info.data,
          ) as Record<string, unknown>;
          return [decodeCommitmentPageState(decoded)];
        } catch {
          return [];
        }
      });

  return mergeCommitmentSources({
    inlineCommitments,
    nextIndex,
    pages,
  });
}

async function sendTrackedTransaction(
  connection: Connection,
  attempt: OperationAttempt,
): Promise<OperationResult> {
  const startedAt = Date.now();
  let signature: TransactionSignature | null = null;

  try {
    signature = await connection.sendRawTransaction(
      attempt.tx.transaction.serialize(),
      {
        maxRetries: 0,
        skipPreflight: true,
      },
    );

    const confirmation = await connection.confirmTransaction(
      {
        blockhash: attempt.tx.blockhash.blockhash,
        lastValidBlockHeight: attempt.tx.blockhash.lastValidBlockHeight,
        signature,
      },
      "confirmed",
    );

    const latencyMs = Date.now() - startedAt;
    const computeUnits = await fetchTransactionComputeUnits(connection, signature);

    if (confirmation.value.err) {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const message = stringifyTransactionError(confirmation.value.err, tx?.meta?.logMessages);
      return {
        agent: attempt.agent.publicKey.toBase58(),
        computeUnits: computeUnits ?? extractComputeUnits(tx?.meta),
        errorMessage: message,
        errorType: classifyError(message),
        label: attempt.tx.label,
        latencyMs,
        recipient: attempt.recipient?.publicKey.toBase58(),
        signature,
        succeeded: false,
      };
    }

    return {
      agent: attempt.agent.publicKey.toBase58(),
      computeUnits,
      errorMessage: null,
      errorType: null,
      label: attempt.tx.label,
      latencyMs,
      recipient: attempt.recipient?.publicKey.toBase58(),
      signature,
      succeeded: true,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const computeUnits =
      signature === null ? null : await fetchTransactionComputeUnits(connection, signature, 4, 200);

    return {
      agent: attempt.agent.publicKey.toBase58(),
      computeUnits,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorType: classifyError(error),
      label: attempt.tx.label,
      latencyMs,
      recipient: attempt.recipient?.publicKey.toBase58(),
      signature,
      succeeded: false,
    };
  }
}

function stringifyTransactionError(error: unknown, logs?: string[] | null): string {
  const errorText =
    typeof error === "string" ? error : JSON.stringify(error ?? "Unknown transaction error");
  const computeLog = logs?.find((entry) => /compute|consumed/i.test(entry));
  return computeLog ? `${errorText} (${computeLog})` : errorText;
}

function normalizePublicKey(value: unknown): PublicKey | null {
  if (!value) {
    return null;
  }

  if (value instanceof PublicKey) {
    return value;
  }

  if (typeof value === "string") {
    return new PublicKey(value);
  }

  if (typeof value !== "object") {
    return null;
  }

  if (
    "toBase58" in value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return new PublicKey(
      (value as { toBase58: () => string }).toBase58(),
    );
  }

  if (
    "toBytes" in value &&
    typeof (value as { toBytes?: unknown }).toBytes === "function"
  ) {
    return new PublicKey(
      (value as { toBytes: () => Uint8Array }).toBytes(),
    );
  }

  if (
    "toBuffer" in value &&
    typeof (value as { toBuffer?: unknown }).toBuffer === "function"
  ) {
    return new PublicKey(
      (value as { toBuffer: () => Uint8Array }).toBuffer(),
    );
  }

  if ("publicKey" in value) {
    return normalizePublicKey(
      (value as { publicKey?: unknown }).publicKey,
    );
  }

  return null;
}

function assertLocalnet(rpcEndpoint: string): void {
  const endpoint = new URL(rpcEndpoint);
  if (!LOCALNET_HOSTS.includes(endpoint.hostname)) {
    throw new Error(
      `SNAP stress tests must run on localnet. Current RPC endpoint: ${rpcEndpoint}`,
    );
  }
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
