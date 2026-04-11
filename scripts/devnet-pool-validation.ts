import os from "os";
import path from "path";
import {
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  createMintAndFundPayer,
  depositWithSignature,
  fetchPoolSnapshot,
  initializePersistentNoteJournal,
  markDevnetNoteWithdrawn,
  persistDevnetNoteJournal,
  prefundSolVaultForLowDenomination,
  recordDevnetNote,
  round,
  withDevnetRetry,
  withdrawWithSignature,
  writeDevnetArtifact,
} from "./devnet-validation-shared";

const SOL_CHECKPOINTS = [48, 49, 100, 300, 520, 600] as const;
const SPL_CHECKPOINTS = [48, 49, 100, 200, 260, 300] as const;
const DEFAULT_SOL_DEPOSIT_AMOUNT = 0.001;
const DEFAULT_SPL_DEPOSIT_AMOUNT = 1;
const DEFAULT_SPL_DECIMALS = 6;
const DEFAULT_SPL_MINT_AMOUNT_RAW = 500_000_000;
const OUTPUT_FILE = "paged-pool-validation.json";
const NOTES_OUTPUT_FILE = "paged-pool-validation-notes.json";

interface BaselineResult {
  deposit: {
    error: string | null;
    latencyMs: number;
    retryErrors: string[];
    retries: number;
    signature: string;
    slot: number | null;
  };
  noteDepositIndex: number;
  withdraw: {
    error: string | null;
    latencyMs: number;
    retryErrors: string[];
    retries: number;
    signature: string;
    slot: number | null;
  };
}

interface GrowthCheckpoint {
  commitmentPageBytes: number;
  commitmentPageCount: number;
  commitmentPageRentLamports: number;
  depositCount: number;
  depositError: string | null;
  depositLatencyMs: number;
  depositRetries: number;
  depositSignature: string;
  depositSlot: number | null;
  poolAccountBytes: number;
  poolRentLamports: number;
  totalStorageBytes: number;
  totalStorageRentLamports: number;
  withdrawCount: number;
  withdrawalError: string | null;
  withdrawalLatencyMs: number;
  withdrawalRetries: number;
  withdrawalSignature: string;
  withdrawalSlot: number | null;
}

interface AssetValidation {
  assetType: "sol" | "spl";
  checkpoints: GrowthCheckpoint[];
  config: {
    checkpoints: number[];
    depositAmount: number;
    depositAmountRaw?: number;
    depositAmountUnit: "sol" | "token";
    decimals?: number;
  };
  directBaseline: BaselineResult | null;
  finalDepositCount: number;
  firstFailure: {
    depositCount: number;
    error: string;
    stage: "baseline_deposit" | "baseline_withdraw" | "deposit" | "withdraw";
  } | null;
  mint?: string;
  notes: string[];
  pool: string;
}

interface PagedPoolValidationArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  metadata: ReturnType<typeof buildMetadata>;
  sol: AssetValidation;
  spl: AssetValidation;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const solDepositAmount = parseFloatEnv(
    process.env.SNAP_DEVNET_SOL_DEPOSIT_AMOUNT,
    DEFAULT_SOL_DEPOSIT_AMOUNT,
  );
  const splDepositAmount = parseFloatEnv(
    process.env.SNAP_DEVNET_SPL_DEPOSIT_AMOUNT,
    DEFAULT_SPL_DEPOSIT_AMOUNT,
  );

  const context = createDevnetContext(rpcUrl, payerPath);
  try {
    const payerBalanceBefore = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    const artifact: PagedPoolValidationArtifact = {
      balances: {
        payer: {
          after: payerBalanceBefore,
          before: payerBalanceBefore,
          delta: 0,
        },
      },
      metadata: buildMetadata(context),
      sol: {
        assetType: "sol",
        checkpoints: [],
        config: {
          checkpoints: [...SOL_CHECKPOINTS],
          depositAmount: solDepositAmount,
          depositAmountUnit: "sol",
        },
        directBaseline: null,
        finalDepositCount: 0,
        firstFailure: null,
        notes: [],
        pool: "",
      },
      spl: {
        assetType: "spl",
        checkpoints: [],
        config: {
          checkpoints: [...SPL_CHECKPOINTS],
          depositAmount: splDepositAmount,
          depositAmountRaw: splDepositAmount * 10 ** DEFAULT_SPL_DECIMALS,
          depositAmountUnit: "token",
          decimals: DEFAULT_SPL_DECIMALS,
        },
        directBaseline: null,
        finalDepositCount: 0,
        firstFailure: null,
        notes: [],
        pool: "",
      },
    };
    const noteJournal = initializePersistentNoteJournal(
      context,
      NOTES_OUTPUT_FILE,
      "devnet pool validation",
    );

    artifact.sol = await runSolValidation(
      context,
      artifact,
      noteJournal,
      solDepositAmount,
    );
    writeDevnetArtifact(OUTPUT_FILE, artifact);
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);

    artifact.spl = await runSplValidation(
      context,
      artifact,
      noteJournal,
      splDepositAmount,
    );
    const payerBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    artifact.balances.payer = {
      after: payerBalanceAfter,
      before: payerBalanceBefore,
      delta: payerBalanceAfter - payerBalanceBefore,
    };

    writeDevnetArtifact(OUTPUT_FILE, artifact);
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeDevnetContext(context);
  }
}

async function runSolValidation(
  context: ReturnType<typeof createDevnetContext>,
  artifact: PagedPoolValidationArtifact,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  depositAmount: number,
): Promise<AssetValidation> {
  const summary: AssetValidation = {
    assetType: "sol",
    checkpoints: [],
    config: {
      checkpoints: [...SOL_CHECKPOINTS],
      depositAmount,
      depositAmountUnit: "sol",
    },
    directBaseline: null,
    finalDepositCount: 0,
    firstFailure: null,
    notes: [],
    pool: "",
  };
  const pool = await context.snap.createPool(depositAmount, { treeDepth: 20 });
  summary.pool = pool.toBase58();
  const solDenominationLamports = Math.round(depositAmount * 1_000_000_000);
  const vaultFunding = await prefundSolVaultForLowDenomination(
    context.connection,
    context.payer,
    pool,
    context.program.programId,
    solDenominationLamports,
  );
  if (vaultFunding.fundedLamports > 0) {
    summary.notes.push(
      `Prefunded SOL vault ${vaultFunding.vault.toBase58()} with ${vaultFunding.fundedLamports} lamports to keep a ${depositAmount} SOL denomination above the devnet rent floor`,
    );
  }

  try {
    const baselineDeposit = await depositWithSignature(context, pool, depositAmount);
    recordDevnetNote(noteJournal, baselineDeposit.note, {
      amount: depositAmount,
      assetType: "sol",
      depositSignature: baselineDeposit.signature,
      stage: "sol-baseline",
    });
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    const baselineWithdraw = await withdrawWithSignature(
      context,
      pool,
      baselineDeposit.note,
      context.payer,
    );
    markDevnetNoteWithdrawn(
      noteJournal,
      baselineDeposit.note,
      baselineWithdraw.signature,
    );
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    summary.directBaseline = {
      deposit: {
        error: baselineDeposit.error,
        latencyMs: baselineDeposit.latencyMs,
        retryErrors: baselineDeposit.retryErrors,
        retries: baselineDeposit.retries,
        signature: baselineDeposit.signature,
        slot: baselineDeposit.slot,
      },
      noteDepositIndex: baselineDeposit.note.depositIndex,
      withdraw: {
        error: baselineWithdraw.error,
        latencyMs: baselineWithdraw.latencyMs,
        retryErrors: baselineWithdraw.retryErrors,
        retries: baselineWithdraw.retries,
        signature: baselineWithdraw.signature,
        slot: baselineWithdraw.slot,
      },
    };
    summary.finalDepositCount = 1;
    writePartial(artifact, summary, "sol");
  } catch (error) {
    summary.firstFailure = {
      depositCount: 1,
      error: stringifyError(error),
      stage: "baseline_deposit",
    };
    summary.notes.push(`SOL baseline failed: ${summary.firstFailure.error}`);
    writePartial(artifact, summary, "sol");
    throw error;
  }

  for (let depositCount = 2; depositCount <= SOL_CHECKPOINTS[SOL_CHECKPOINTS.length - 1]; depositCount += 1) {
    try {
      const isCheckpoint = SOL_CHECKPOINTS.includes(
        depositCount as (typeof SOL_CHECKPOINTS)[number],
      );
      if (!isCheckpoint) {
        const { result: note } = await withDevnetRetry(
          "deposit",
          () => context.snap.deposit(pool, depositAmount),
        );
        recordDevnetNote(noteJournal, note, {
          amount: depositAmount,
          assetType: "sol",
          stage: `sol-growth-${depositCount}`,
        });
        persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
        summary.finalDepositCount = depositCount;
        continue;
      }

      const deposit = await depositWithSignature(context, pool, depositAmount);
      recordDevnetNote(noteJournal, deposit.note, {
        amount: depositAmount,
        assetType: "sol",
        depositSignature: deposit.signature,
        stage: `sol-checkpoint-${depositCount}`,
      });
      persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
      summary.finalDepositCount = depositCount;
      if (isCheckpoint) {
        const snapshot = await fetchPoolSnapshot(context, pool);
        const withdraw = await withdrawWithSignature(
          context,
          pool,
          deposit.note,
          context.payer,
        );
        markDevnetNoteWithdrawn(
          noteJournal,
          deposit.note,
          withdraw.signature,
        );
        persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
        summary.checkpoints.push({
          commitmentPageBytes: snapshot.commitmentPageBytes,
          commitmentPageCount: snapshot.commitmentPageCount,
          commitmentPageRentLamports: snapshot.commitmentPageRentLamports,
          depositCount,
          depositError: deposit.error,
          depositLatencyMs: round(deposit.latencyMs, 1),
          depositRetries: deposit.retries,
          depositSignature: deposit.signature,
          depositSlot: deposit.slot,
          poolAccountBytes: snapshot.poolAccountBytes,
          poolRentLamports: snapshot.poolRentLamports,
          totalStorageBytes: snapshot.totalStorageBytes,
          totalStorageRentLamports: snapshot.totalStorageRentLamports,
          withdrawCount: snapshot.withdrawCount + 1,
          withdrawalError: withdraw.error,
          withdrawalLatencyMs: round(withdraw.latencyMs, 1),
          withdrawalRetries: withdraw.retries,
          withdrawalSignature: withdraw.signature,
          withdrawalSlot: withdraw.slot,
        });
        summary.notes.push(
          `SOL checkpoint ${depositCount}: poolBytes=${snapshot.poolAccountBytes} pages=${snapshot.commitmentPageCount} totalBytes=${snapshot.totalStorageBytes}`,
        );
        writePartial(artifact, summary, "sol");
      }
    } catch (error) {
      summary.firstFailure = {
        depositCount,
        error: stringifyError(error),
        stage: "deposit",
      };
      summary.notes.push(`SOL failed at deposit ${depositCount}: ${summary.firstFailure.error}`);
      writePartial(artifact, summary, "sol");
      return summary;
    }
  }

  return summary;
}

async function runSplValidation(
  context: ReturnType<typeof createDevnetContext>,
  artifact: PagedPoolValidationArtifact,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  depositAmount: number,
): Promise<AssetValidation> {
  const summary: AssetValidation = {
    assetType: "spl",
    checkpoints: [],
    config: {
      checkpoints: [...SPL_CHECKPOINTS],
      depositAmount,
      depositAmountRaw: depositAmount * 10 ** DEFAULT_SPL_DECIMALS,
      depositAmountUnit: "token",
      decimals: DEFAULT_SPL_DECIMALS,
    },
    directBaseline: null,
    finalDepositCount: 0,
    firstFailure: null,
    notes: [],
    pool: "",
  };

  const { mint } = await createMintAndFundPayer(
    context.connection,
    context.payer,
    DEFAULT_SPL_DECIMALS,
    DEFAULT_SPL_MINT_AMOUNT_RAW,
  );
  summary.mint = mint.toBase58();
  const pool = await context.snap.createSplPool(depositAmount, mint);
  summary.pool = pool.toBase58();

  try {
    const baselineDeposit = await depositWithSignature(context, pool, depositAmount);
    recordDevnetNote(noteJournal, baselineDeposit.note, {
      amount: depositAmount,
      assetType: "spl",
      depositSignature: baselineDeposit.signature,
      stage: "spl-baseline",
    });
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    const baselineWithdraw = await withdrawWithSignature(
      context,
      pool,
      baselineDeposit.note,
      context.payer,
    );
    markDevnetNoteWithdrawn(
      noteJournal,
      baselineDeposit.note,
      baselineWithdraw.signature,
    );
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    summary.directBaseline = {
      deposit: {
        error: baselineDeposit.error,
        latencyMs: baselineDeposit.latencyMs,
        retryErrors: baselineDeposit.retryErrors,
        retries: baselineDeposit.retries,
        signature: baselineDeposit.signature,
        slot: baselineDeposit.slot,
      },
      noteDepositIndex: baselineDeposit.note.depositIndex,
      withdraw: {
        error: baselineWithdraw.error,
        latencyMs: baselineWithdraw.latencyMs,
        retryErrors: baselineWithdraw.retryErrors,
        retries: baselineWithdraw.retries,
        signature: baselineWithdraw.signature,
        slot: baselineWithdraw.slot,
      },
    };
    summary.finalDepositCount = 1;
    writePartial(artifact, summary, "spl");
  } catch (error) {
    summary.firstFailure = {
      depositCount: 1,
      error: stringifyError(error),
      stage: "baseline_deposit",
    };
    summary.notes.push(`SPL baseline failed: ${summary.firstFailure.error}`);
    writePartial(artifact, summary, "spl");
    throw error;
  }

  for (let depositCount = 2; depositCount <= SPL_CHECKPOINTS[SPL_CHECKPOINTS.length - 1]; depositCount += 1) {
    try {
      const isCheckpoint = SPL_CHECKPOINTS.includes(
        depositCount as (typeof SPL_CHECKPOINTS)[number],
      );
      if (!isCheckpoint) {
        const { result: note } = await withDevnetRetry(
          "deposit",
          () => context.snap.deposit(pool, depositAmount),
        );
        recordDevnetNote(noteJournal, note, {
          amount: depositAmount,
          assetType: "spl",
          stage: `spl-growth-${depositCount}`,
        });
        persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
        summary.finalDepositCount = depositCount;
        continue;
      }

      const deposit = await depositWithSignature(context, pool, depositAmount);
      recordDevnetNote(noteJournal, deposit.note, {
        amount: depositAmount,
        assetType: "spl",
        depositSignature: deposit.signature,
        stage: `spl-checkpoint-${depositCount}`,
      });
      persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
      summary.finalDepositCount = depositCount;
      if (isCheckpoint) {
        const snapshot = await fetchPoolSnapshot(context, pool);
        const withdraw = await withdrawWithSignature(
          context,
          pool,
          deposit.note,
          context.payer,
        );
        markDevnetNoteWithdrawn(
          noteJournal,
          deposit.note,
          withdraw.signature,
        );
        persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
        summary.checkpoints.push({
          commitmentPageBytes: snapshot.commitmentPageBytes,
          commitmentPageCount: snapshot.commitmentPageCount,
          commitmentPageRentLamports: snapshot.commitmentPageRentLamports,
          depositCount,
          depositError: deposit.error,
          depositLatencyMs: round(deposit.latencyMs, 1),
          depositRetries: deposit.retries,
          depositSignature: deposit.signature,
          depositSlot: deposit.slot,
          poolAccountBytes: snapshot.poolAccountBytes,
          poolRentLamports: snapshot.poolRentLamports,
          totalStorageBytes: snapshot.totalStorageBytes,
          totalStorageRentLamports: snapshot.totalStorageRentLamports,
          withdrawCount: snapshot.withdrawCount + 1,
          withdrawalError: withdraw.error,
          withdrawalLatencyMs: round(withdraw.latencyMs, 1),
          withdrawalRetries: withdraw.retries,
          withdrawalSignature: withdraw.signature,
          withdrawalSlot: withdraw.slot,
        });
        summary.notes.push(
          `SPL checkpoint ${depositCount}: poolBytes=${snapshot.poolAccountBytes} pages=${snapshot.commitmentPageCount} totalBytes=${snapshot.totalStorageBytes}`,
        );
        writePartial(artifact, summary, "spl");
      }
    } catch (error) {
      summary.firstFailure = {
        depositCount,
        error: stringifyError(error),
        stage: "deposit",
      };
      summary.notes.push(`SPL failed at deposit ${depositCount}: ${summary.firstFailure.error}`);
      writePartial(artifact, summary, "spl");
      return summary;
    }
  }

  return summary;
}

function writePartial(
  artifact: PagedPoolValidationArtifact,
  summary: AssetValidation,
  asset: "sol" | "spl",
): void {
  const nextArtifact: PagedPoolValidationArtifact = {
    ...artifact,
    [asset]: summary,
  };
  writeDevnetArtifact(OUTPUT_FILE, nextArtifact);
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value: ${value}`);
  }

  return parsed;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
