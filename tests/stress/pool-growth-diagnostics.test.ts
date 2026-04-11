import { BN } from "@coral-xyz/anchor";
import { createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { SendTransactionError } from "@solana/web3.js";
import {
  COMMITMENT_PAGE_CAPACITY,
  deriveCommitmentPagePda,
} from "../../sdk-package/src/commitment-pages";
import {
  buildArtifactHeader,
  closeStressContext,
  createNotesForPool,
  createSolPool,
  createSplPool,
  createStressContext,
  fetchPoolFootprint,
  fetchPoolState,
  makeAgentWallets,
  mintTokensToAgents,
  requestAirdrops,
  round,
  writeArtifact,
  type SplPoolHandle,
  type StressContext,
  type TokenAccountBundle,
} from "./shared";
import { deriveNullifierRecordPda, computeBudgetIx, extractComputeUnits } from "../helpers";
import { generateWithdrawProof } from "../../sdk-package/src/proof";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const SOL_DEPOSIT_AMOUNT_LAMPORTS = Math.floor(0.1 * LAMPORTS_PER_SOL);
const SPL_DEPOSIT_AMOUNT_RAW = 100_000;
const RECIPIENT_AIRDROP_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL);
const SOL_WINDOW = { start: 450, end: 530 } as const;
const SPL_WINDOW = { start: 220, end: 270 } as const;
const TREE_DEPTH = 20 as const;
const DIAGNOSTICS_FILE = "pool-growth-diagnostics.json";

interface DiagnosticFailure {
  assetType: "sol" | "spl";
  computeUnits: number | null;
  depositCount: number;
  errorMessage: string;
  errorType: string;
  failurePath: "realloc" | "deserialize" | "tree_update" | "transfer" | "unknown";
  logs: string[];
  poolAccountBytes: number;
  rentExemptMinimumLamports: number;
  signature: string | null;
  slot: number | null;
}

interface DiagnosticAttemptSummary {
  depositCount: number;
  depositErrorType: string | null;
  depositSignature: string | null;
  depositSucceeded: boolean;
  withdrawalErrorType: string | null;
  withdrawalSignature: string | null;
  withdrawalSucceeded: boolean;
}

interface DiagnosticAssetSummary {
  attempts: DiagnosticAttemptSummary[];
  firstFailingDeposit: DiagnosticFailure | null;
  firstFailingWithdrawal: DiagnosticFailure | null;
  notes: string[];
  window: {
    end: number;
    start: number;
  };
}

interface PoolGrowthDiagnosticsArtifact {
  metadata: ReturnType<typeof buildArtifactHeader>;
  sol: DiagnosticAssetSummary;
  spl: DiagnosticAssetSummary;
}

export async function runPoolGrowthDiagnostics(): Promise<PoolGrowthDiagnosticsArtifact> {
  const context = createStressContext();
  try {
    const artifact: PoolGrowthDiagnosticsArtifact = {
      metadata: buildArtifactHeader(context),
      sol: {
        attempts: [],
        firstFailingDeposit: null,
        firstFailingWithdrawal: null,
        notes: [],
        window: { ...SOL_WINDOW },
      },
      spl: {
        attempts: [],
        firstFailingDeposit: null,
        firstFailingWithdrawal: null,
        notes: [],
        window: { ...SPL_WINDOW },
      },
    };

    await requestAirdrops(context.connection, [context.payer], 800 * LAMPORTS_PER_SOL);

    artifact.sol = await runSolDiagnostics(context, artifact);
    writeArtifact(DIAGNOSTICS_FILE, artifact);

    artifact.spl = await runSplDiagnostics(context, artifact);
    writeArtifact(DIAGNOSTICS_FILE, artifact);

    return artifact;
  } finally {
    closeStressContext(context);
  }
}

async function runSolDiagnostics(
  context: StressContext,
  artifact: PoolGrowthDiagnosticsArtifact,
): Promise<DiagnosticAssetSummary> {
  const summary: DiagnosticAssetSummary = {
    attempts: [],
    firstFailingDeposit: null,
    firstFailingWithdrawal: null,
    notes: [],
    window: { ...SOL_WINDOW },
  };
  const pool = await createSolPool(context, SOL_DEPOSIT_AMOUNT_LAMPORTS, TREE_DEPTH);

  for (let depositCount = 1; depositCount <= SOL_WINDOW.end; depositCount += 1) {
    const [note] = await createNotesForPool(pool.pool, 1, depositCount - 1);
    const depositAttempt = await buildSolDepositTransaction(
      context,
      pool.pool,
      pool.poolVault,
      note,
    );
    const depositResult = await sendDiagnosticTransaction(
      context,
      depositAttempt,
      depositCount,
      pool.pool,
      "sol",
      "deposit",
    );

    if (depositCount >= SOL_WINDOW.start) {
      const attempt: DiagnosticAttemptSummary = {
        depositCount,
        depositErrorType: depositResult.errorType,
        depositSignature: depositResult.signature,
        depositSucceeded: depositResult.succeeded,
        withdrawalErrorType: null,
        withdrawalSignature: null,
        withdrawalSucceeded: false,
      };

      if (!depositResult.succeeded) {
        summary.firstFailingDeposit ??= depositResult.failure;
        summary.attempts.push(attempt);
        summary.notes.push(
          `deposit ${depositCount} failed with ${depositResult.errorType}: ${depositResult.errorMessage}`,
        );
        artifact.sol = summary;
        writeArtifact(DIAGNOSTICS_FILE, artifact);
        break;
      }

      const [recipient] = makeAgentWallets(1);
      await requestAirdrops(context.connection, [recipient], RECIPIENT_AIRDROP_LAMPORTS);
      const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
      const proof = await generateWithdrawProof(
        note,
        poolState.commitments,
        recipient.publicKey,
        180_000,
        poolState.treeDepth,
      );
      const [nullifierRecord] = deriveNullifierRecordPda(
        pool.pool,
        Uint8Array.from(proof.nullifierHashBytes),
        context.program.programId,
      );
      const withdrawAttempt = await buildSolWithdrawTransaction(
        context,
        pool.pool,
        pool.poolVault,
        recipient,
        nullifierRecord,
        proof,
      );
      const withdrawResult = await sendDiagnosticTransaction(
        context,
        withdrawAttempt,
        depositCount,
        pool.pool,
        "sol",
        "withdrawal",
      );

      attempt.withdrawalErrorType = withdrawResult.errorType;
      attempt.withdrawalSignature = withdrawResult.signature;
      attempt.withdrawalSucceeded = withdrawResult.succeeded;
      if (!withdrawResult.succeeded) {
        summary.firstFailingWithdrawal ??= withdrawResult.failure;
        summary.notes.push(
          `withdrawal at deposit ${depositCount} failed with ${withdrawResult.errorType}: ${withdrawResult.errorMessage}`,
        );
      }

      summary.attempts.push(attempt);
      artifact.sol = summary;
      writeArtifact(DIAGNOSTICS_FILE, artifact);

      if (summary.firstFailingDeposit && summary.firstFailingWithdrawal) {
        break;
      }
    } else if (!depositResult.succeeded) {
      throw new Error(
        `SOL diagnostic pre-window deposit ${depositCount} failed unexpectedly: ${depositResult.errorType} ${depositResult.errorMessage}`,
      );
    }
  }

  return summary;
}

async function runSplDiagnostics(
  context: StressContext,
  artifact: PoolGrowthDiagnosticsArtifact,
): Promise<DiagnosticAssetSummary> {
  const summary: DiagnosticAssetSummary = {
    attempts: [],
    firstFailingDeposit: null,
    firstFailingWithdrawal: null,
    notes: [],
    window: { ...SPL_WINDOW },
  };
  const pool = await createSplPool(context, SPL_DEPOSIT_AMOUNT_RAW);
  const depositors = makeAgentWallets(SPL_WINDOW.end + 1);
  await requestAirdrops(context.connection, depositors, RECIPIENT_AIRDROP_LAMPORTS);
  const bundles = await mintTokensToAgents(
    context,
    pool.mint,
    depositors,
    SPL_DEPOSIT_AMOUNT_RAW * 2,
  );

  for (let depositCount = 1; depositCount <= SPL_WINDOW.end; depositCount += 1) {
    const note = (await createNotesForPool(pool.pool, 1, depositCount - 1))[0];
    const bundle = bundles[depositCount - 1];
    const depositAttempt = await buildSplDepositTransaction(context, pool, bundle, note);
    const depositResult = await sendDiagnosticTransaction(
      context,
      depositAttempt,
      depositCount,
      pool.pool,
      "spl",
      "deposit",
    );

    if (depositCount >= SPL_WINDOW.start) {
      const attempt: DiagnosticAttemptSummary = {
        depositCount,
        depositErrorType: depositResult.errorType,
        depositSignature: depositResult.signature,
        depositSucceeded: depositResult.succeeded,
        withdrawalErrorType: null,
        withdrawalSignature: null,
        withdrawalSucceeded: false,
      };

      if (!depositResult.succeeded) {
        summary.firstFailingDeposit ??= depositResult.failure;
        summary.attempts.push(attempt);
        summary.notes.push(
          `deposit ${depositCount} failed with ${depositResult.errorType}: ${depositResult.errorMessage}`,
        );
        artifact.spl = summary;
        writeArtifact(DIAGNOSTICS_FILE, artifact);
        break;
      }

      if (summary.firstFailingWithdrawal === null) {
        const recipient = Keypair.generate();
        await requestAirdrops(context.connection, [recipient], RECIPIENT_AIRDROP_LAMPORTS);
        const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
        const proof = await generateWithdrawProof(
          note,
          poolState.commitments,
          recipient.publicKey,
          180_000,
          poolState.treeDepth,
        );
        const [nullifierRecord] = deriveNullifierRecordPda(
          pool.pool,
          Uint8Array.from(proof.nullifierHashBytes),
          context.program.programId,
        );
        const recipientTokenAccount = getAssociatedTokenAddressSync(pool.mint, recipient.publicKey);
        const withdrawAttempt = await buildSplWithdrawTransaction(
          context,
          pool,
          recipient,
          recipientTokenAccount,
          nullifierRecord,
          proof,
        );
        const withdrawResult = await sendDiagnosticTransaction(
          context,
          withdrawAttempt,
          depositCount,
          pool.pool,
          "spl",
          "withdrawal",
        );

        attempt.withdrawalErrorType = withdrawResult.errorType;
        attempt.withdrawalSignature = withdrawResult.signature;
        attempt.withdrawalSucceeded = withdrawResult.succeeded;
        if (!withdrawResult.succeeded) {
          summary.firstFailingWithdrawal = withdrawResult.failure;
          summary.notes.push(
            `withdrawal at deposit ${depositCount} failed with ${withdrawResult.errorType}: ${withdrawResult.errorMessage}`,
          );
        }
      }

      summary.attempts.push(attempt);
      artifact.spl = summary;
      writeArtifact(DIAGNOSTICS_FILE, artifact);

      if (summary.firstFailingDeposit && summary.firstFailingWithdrawal) {
        break;
      }
    } else if (!depositResult.succeeded) {
      throw new Error(
        `SPL diagnostic pre-window deposit ${depositCount} failed unexpectedly: ${depositResult.errorType} ${depositResult.errorMessage}`,
      );
    }
  }

  return summary;
}

async function buildSolDepositTransaction(
  context: StressContext,
  pool: PublicKey,
  poolVault: PublicKey,
  note: { commitment: Uint8Array; depositIndex: number },
): Promise<TransactionWithBlockhash> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");
  const pageIndex = Math.floor(note.depositIndex / COMMITMENT_PAGE_CAPACITY);
  const transaction = await (context.program.methods as any)
    .depositV2(Array.from(note.commitment), pageIndex)
    .accounts({
      commitmentPage: deriveCommitmentPagePda(
        pool,
        pageIndex,
        context.program.programId,
      )[0],
      pool,
      poolVault,
      depositor: context.payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .transaction();
  transaction.feePayer = context.payer.publicKey;
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.sign(context.payer);
  return { blockhash, transaction };
}

async function buildSplDepositTransaction(
  context: StressContext,
  pool: SplPoolHandle,
  bundle: TokenAccountBundle,
  note: { commitment: Uint8Array; depositIndex: number },
): Promise<TransactionWithBlockhash> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");
  const pageIndex = Math.floor(note.depositIndex / COMMITMENT_PAGE_CAPACITY);
  const transaction = await (context.program.methods as any)
    .depositSpl(Array.from(note.commitment), pageIndex)
    .accounts({
      commitmentPage: deriveCommitmentPagePda(
        pool.pool,
        pageIndex,
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
    .transaction();
  transaction.feePayer = bundle.owner.publicKey;
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.sign(bundle.owner);
  return { blockhash, transaction };
}

async function buildSolWithdrawTransaction(
  context: StressContext,
  pool: PublicKey,
  poolVault: PublicKey,
  recipient: Keypair,
  nullifierRecord: PublicKey,
  proof: Awaited<ReturnType<typeof generateWithdrawProof>>,
): Promise<TransactionWithBlockhash> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");
  const transaction = await (context.program.methods as any)
    .withdrawZkV2(
      proof.proofABytes,
      proof.proofBBytes,
      proof.proofCBytes,
      proof.rootBytes,
      proof.nullifierHashBytes,
    )
    .accounts({
      pool,
      poolVault,
      recipient: recipient.publicKey,
      payer: recipient.publicKey,
      nullifierRecord,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .transaction();
  transaction.feePayer = recipient.publicKey;
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.sign(recipient);
  return { blockhash, transaction };
}

async function buildSplWithdrawTransaction(
  context: StressContext,
  pool: SplPoolHandle,
  recipient: Keypair,
  recipientTokenAccount: PublicKey,
  nullifierRecord: PublicKey,
  proof: Awaited<ReturnType<typeof generateWithdrawProof>>,
): Promise<TransactionWithBlockhash> {
  const blockhash = await context.connection.getLatestBlockhash("confirmed");
  const preInstructions: TransactionInstruction[] = [computeBudgetIx(1_400_000)];
  if (!(await context.connection.getAccountInfo(recipientTokenAccount, "confirmed"))) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        recipient.publicKey,
        recipientTokenAccount,
        recipient.publicKey,
        pool.mint,
      ),
    );
  }

  const transaction = await (context.program.methods as any)
    .withdrawZkSpl(
      proof.proofABytes,
      proof.proofBBytes,
      proof.proofCBytes,
      proof.rootBytes,
      proof.nullifierHashBytes,
    )
    .accounts({
      pool: pool.pool,
      poolVault: pool.poolVault,
      recipient: recipient.publicKey,
      recipientTokenAccount,
      payer: recipient.publicKey,
      nullifierRecord,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preInstructions)
    .transaction();
  transaction.feePayer = recipient.publicKey;
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.sign(recipient);
  return { blockhash, transaction };
}

interface TransactionWithBlockhash {
  blockhash: BlockhashWithExpiryBlockHeight;
  transaction: Transaction;
}

interface DiagnosticSendResult {
  errorMessage: string | null;
  errorType: string | null;
  failure: DiagnosticFailure | null;
  signature: string | null;
  succeeded: boolean;
}

async function sendDiagnosticTransaction(
  context: StressContext,
  tx: TransactionWithBlockhash,
  depositCount: number,
  pool: PublicKey,
  assetType: "sol" | "spl",
  operation: "deposit" | "withdrawal",
): Promise<DiagnosticSendResult> {
  let signature: string | null = null;

  try {
    signature = await context.connection.sendRawTransaction(tx.transaction.serialize(), {
      maxRetries: 0,
      skipPreflight: true,
    });
    const confirmation = await context.connection.confirmTransaction(
      {
        blockhash: tx.blockhash.blockhash,
        lastValidBlockHeight: tx.blockhash.lastValidBlockHeight,
        signature,
      },
      "confirmed",
    );

    if (!confirmation.value.err) {
      return {
        errorMessage: null,
        errorType: null,
        failure: null,
        signature,
        succeeded: true,
      };
    }

    const details = await fetchFailureDetails(context, signature, pool, depositCount, assetType, operation);
    return {
      errorMessage: details.errorMessage,
      errorType: details.errorType,
      failure: details,
      signature,
      succeeded: false,
    };
  } catch (error) {
    const sendError = error as Partial<SendTransactionError> & { signature?: string };
    signature ??= typeof sendError.signature === "string" ? sendError.signature : null;
    const details = await fetchFailureDetails(
      context,
      signature,
      pool,
      depositCount,
      assetType,
      operation,
      error,
    );
    return {
      errorMessage: details.errorMessage,
      errorType: details.errorType,
      failure: details,
      signature,
      succeeded: false,
    };
  }
}

async function fetchFailureDetails(
  context: StressContext,
  signature: string | null,
  pool: PublicKey,
  depositCount: number,
  assetType: "sol" | "spl",
  operation: "deposit" | "withdrawal",
  originalError?: unknown,
): Promise<DiagnosticFailure> {
  const footprint = await fetchPoolFootprint(context.connection, pool);
  const rentExemptMinimumLamports = await context.connection.getMinimumBalanceForRentExemption(
    footprint.accountBytes,
  );
  const tx = signature
    ? await fetchTransactionWithRetries(context, signature)
    : null;
  const logs = collectLogs(originalError, tx?.meta?.logMessages);
  const errorMessage = stringifyFailure(originalError, tx?.meta?.err, logs);
  const errorType = classifyError(errorMessage);

  return {
    assetType,
    computeUnits: tx ? extractComputeUnits(tx.meta) : null,
    depositCount,
    errorMessage,
    errorType,
    failurePath: classifyFailurePath(operation, assetType, logs, errorMessage),
    logs,
    poolAccountBytes: footprint.accountBytes,
    rentExemptMinimumLamports,
    signature,
    slot: tx?.slot ?? null,
  };
}

async function fetchTransactionWithRetries(
  context: StressContext,
  signature: string,
  attempts = 15,
): Promise<Awaited<ReturnType<StressContext["connection"]["getTransaction"]>>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tx = await context.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      return tx;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

function collectLogs(originalError: unknown, transactionLogs?: string[] | null): string[] {
  if (transactionLogs && transactionLogs.length > 0) {
    return [...transactionLogs];
  }

  const logs = (originalError as Partial<SendTransactionError> & { logs?: string[] | null })?.logs;
  return Array.isArray(logs) ? [...logs] : [];
}

function classifyError(message: string): string {
  if (/ProgramFailedToComplete/i.test(message)) {
    return "ProgramFailedToComplete";
  }

  if (/AccountInUse/i.test(message)) {
    return "AccountInUse";
  }

  if (/BlockhashNotFound|TransactionExpired/i.test(message)) {
    return "Blockhash";
  }

  return "Unknown";
}

function classifyFailurePath(
  operation: "deposit" | "withdrawal",
  assetType: "sol" | "spl",
  logs: string[],
  message: string,
): DiagnosticFailure["failurePath"] {
  const joined = `${message}\n${logs.join("\n")}`;

  if (/realloc|resize|account data too small|failed to reallocate/i.test(joined)) {
    return "realloc";
  }

  if (
    /deserialize|failed to deserialize|out of memory|memory allocation failed|access violation/i.test(
      joined,
    )
  ) {
    return "deserialize";
  }

  if (/Program log: Instruction: Deposit|Program log: Instruction: DepositV2|Program log: Instruction: DepositSpl/i.test(joined)) {
    const transferNeedle =
      assetType === "spl"
        ? "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke"
        : "Program 11111111111111111111111111111111 invoke";

    if (!joined.includes(transferNeedle)) {
      return "realloc";
    }

    if (operation === "deposit") {
      return "tree_update";
    }
  }

  if (/transfer/i.test(joined)) {
    return "transfer";
  }

  return "unknown";
}

function stringifyFailure(
  originalError: unknown,
  transactionError: unknown,
  logs: string[],
): string {
  if (transactionError) {
    return `${JSON.stringify(transactionError)}${logs.length > 0 ? ` ${logs[0]}` : ""}`.trim();
  }

  if (originalError instanceof Error) {
    return originalError.message;
  }

  return String(originalError ?? "Unknown failure");
}

if (require.main === module) {
  runPoolGrowthDiagnostics()
    .then((artifact) => {
      console.log(
        [
          `[pool-growth-diagnostics] solDepositFailure=${artifact.sol.firstFailingDeposit?.depositCount ?? "none"}`,
          `solWithdrawFailure=${artifact.sol.firstFailingWithdrawal?.depositCount ?? "none"}`,
          `splDepositFailure=${artifact.spl.firstFailingDeposit?.depositCount ?? "none"}`,
          `splWithdrawFailure=${artifact.spl.firstFailingWithdrawal?.depositCount ?? "none"}`,
        ].join(" "),
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
