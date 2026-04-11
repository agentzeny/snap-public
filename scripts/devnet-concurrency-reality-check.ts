import os from "os";
import path from "path";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  buildSolDepositAttempts,
  buildSolWithdrawAttempts,
  createNotesForPool,
  createSolPool,
  type SolPoolHandle,
  executeOperationBatch,
  fetchPoolState,
  generateProofMeasurements,
  makeAgentWallets,
  percentile,
  summarizeOperations,
} from "../tests/stress/shared";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  depositWithSignature,
  fundSystemAccounts,
  initializePersistentNoteJournal,
  markDevnetNoteDeposited,
  markDevnetNoteFailed,
  markDevnetNoteWithdrawn,
  prefundSolVaultForLowDenomination,
  persistDevnetNoteJournal,
  recordDevnetNote,
  recordPlannedDevnetNote,
  round,
  withdrawWithSignature,
  writeDevnetArtifact,
} from "./devnet-validation-shared";
import { deriveVaultPda } from "../tests/helpers";
import {
  assertBalanceAtLeast,
  drainSystemAccountBalances,
} from "./relayer-harness";

const CONCURRENCY_LEVELS = [1, 3, 5] as const;
const DEFAULT_AGENT_FUNDING_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const DEFAULT_SOL_DEPOSIT_AMOUNT = 0.001;
const DEFAULT_MAX_TOTAL_LAMPORTS = 10_000_000;
const DEFAULT_PAYER_BUFFER_LAMPORTS = 1_000_000;
const OUTPUT_FILE = "concurrency-reality-check.json";
const NOTES_OUTPUT_FILE = "concurrency-reality-check-notes.json";

interface ConcurrencyResult {
  concurrency: number;
  contentionRate: number;
  deposits: ReturnType<typeof summarizeOperations>;
  depositWallClockMs: number;
  errors: Record<string, number>;
  pool: string;
  proofGenWallClockMs: number;
  round: number;
  sampleErrors: string[];
  withdrawWallClockMs: number;
  withdrawals: ReturnType<typeof summarizeOperations> & {
    proofGenTimes: number[];
  };
  warmup: {
    depositSignature: string;
    withdrawSignature: string;
  };
}

interface ConcurrencyArtifact {
  balances: {
    agents: {
      fundedLamports: number;
      refundedLamports: number;
      walletCount: number;
    };
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  config: {
    agentFundingLamports: number;
    concurrency: number[];
    depositAmount: number;
    existingPool: string | null;
    maxTotalLamports: number;
    rounds: number;
    treeDepth: number;
    withdrawRecipientMode: "agent" | "payer";
    requestedAgentFundingLamports: number;
  };
  metadata: ReturnType<typeof buildMetadata>;
  results: ConcurrencyResult[];
  summary: Array<{
    concurrency: number;
    contentionRate: number;
    depositTps: number;
    p95LatencyMs: number;
    withdrawTps: number;
  }>;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const depositAmount = parseFloatEnv(
    process.env.SNAP_DEVNET_CONCURRENCY_DEPOSIT_AMOUNT,
    DEFAULT_SOL_DEPOSIT_AMOUNT,
  );
  const requestedAgentFundingLamports = parseFloatEnv(
    process.env.SNAP_DEVNET_AGENT_FUNDING_SOL,
    DEFAULT_AGENT_FUNDING_LAMPORTS / LAMPORTS_PER_SOL,
  ) * LAMPORTS_PER_SOL;
  const existingPoolAddress = parsePublicKeyEnv(
    process.env.SNAP_DEVNET_CONCURRENCY_POOL_ADDRESS,
  );
  const allowFreshPool =
    process.env.SNAP_DEVNET_CONCURRENCY_ALLOW_FRESH_POOL === "1";
  const usePayerRecipient =
    process.env.SNAP_DEVNET_CONCURRENCY_USE_PAYER_RECIPIENT === "1";
  const maxTotalLamports = parseIntegerEnv(
    process.env.SNAP_DEVNET_CONCURRENCY_MAX_TOTAL_LAMPORTS,
    DEFAULT_MAX_TOTAL_LAMPORTS,
  );

  if (!existingPoolAddress && !allowFreshPool) {
    throw new Error(
      "Devnet concurrency reality checks require SNAP_DEVNET_CONCURRENCY_POOL_ADDRESS by default. Set SNAP_DEVNET_CONCURRENCY_ALLOW_FRESH_POOL=1 to create a fresh pool intentionally.",
    );
  }

  const context = createDevnetContext(rpcUrl, payerPath);
  try {
    const minimumAgentLamports = await context.connection.getMinimumBalanceForRentExemption(0);
    const agentFundingLamports = Math.max(
      requestedAgentFundingLamports,
      minimumAgentLamports,
    );
    const depositAmountLamports = Math.round(depositAmount * LAMPORTS_PER_SOL);
    const plannedMaxLamports =
      agentFundingLamports * Math.max(...CONCURRENCY_LEVELS) +
      depositAmountLamports * Math.max(...CONCURRENCY_LEVELS);
    if (plannedMaxLamports > maxTotalLamports) {
      throw new Error(
        `Planned concurrency spend ${plannedMaxLamports} lamports exceeds guardrail ${maxTotalLamports}`,
      );
    }
    const payerBalanceBefore = await assertBalanceAtLeast(
      context.connection,
      context.payer.publicKey,
      plannedMaxLamports + DEFAULT_PAYER_BUFFER_LAMPORTS,
      "devnet concurrency payer",
    );
    const noteJournal = initializePersistentNoteJournal(
      context,
      NOTES_OUTPUT_FILE,
      "devnet concurrency reality check",
    );
    const sharedAgents = makeAgentWallets(
      Math.max(...CONCURRENCY_LEVELS),
    );
    const artifact: ConcurrencyArtifact = {
      balances: {
        agents: {
          fundedLamports: sharedAgents.length * agentFundingLamports,
          refundedLamports: 0,
          walletCount: sharedAgents.length,
        },
        payer: {
          after: payerBalanceBefore,
          before: payerBalanceBefore,
          delta: 0,
        },
      },
      config: {
        agentFundingLamports,
        concurrency: [...CONCURRENCY_LEVELS],
        depositAmount,
        existingPool: existingPoolAddress?.toBase58() ?? null,
        maxTotalLamports,
        requestedAgentFundingLamports,
        rounds: 1,
        treeDepth: existingPoolAddress ? 20 : 10,
        withdrawRecipientMode: usePayerRecipient ? "payer" : "agent",
      },
      metadata: buildMetadata(context),
      results: [],
      summary: [],
    };

    try {
      await fundSystemAccounts(
        context.connection,
        context.payer,
        sharedAgents,
        agentFundingLamports,
      );

      for (const concurrency of CONCURRENCY_LEVELS) {
        const result = await runRound(
          context,
          sharedAgents.slice(0, concurrency),
          concurrency,
          depositAmount,
          existingPoolAddress,
          noteJournal,
          usePayerRecipient,
        );
        artifact.results.push(result);
        artifact.summary = summarizeArtifact(artifact.results);
        writeDevnetArtifact(OUTPUT_FILE, artifact);
      }
    } finally {
      const agentRefunds = await drainSystemAccountBalances(
        context.connection,
        sharedAgents,
        context.payer.publicKey,
        context.payer,
      ).catch(() => ({
        refundedLamports: 0,
        results: [],
      }));
      const payerBalanceAfter = await context.connection.getBalance(
        context.payer.publicKey,
        "confirmed",
      );
      artifact.balances.agents.refundedLamports = agentRefunds.refundedLamports;
      artifact.balances.payer = {
        after: payerBalanceAfter,
        before: payerBalanceBefore,
        delta: payerBalanceAfter - payerBalanceBefore,
      };
      writeDevnetArtifact(OUTPUT_FILE, artifact);
      persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    }

    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeDevnetContext(context);
  }
}

async function runRound(
  context: ReturnType<typeof createDevnetContext>,
  agents: Keypair[],
  concurrency: number,
  depositAmount: number,
  existingPoolAddress: PublicKey | null,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  usePayerRecipient: boolean,
): Promise<ConcurrencyResult> {
  let pool: SolPoolHandle;
  let noteStartIndex: number;
  let warmupDepositSignature: string;
  let warmupWithdrawSignature: string;

  if (existingPoolAddress) {
    const [poolVault] = deriveVaultPda(
      existingPoolAddress,
      context.program.programId,
    );
    const existingState = await fetchPoolState(
      context.program,
      context.connection,
      existingPoolAddress,
    );
    pool = {
      pool: existingPoolAddress,
      poolVault,
      treeDepth: existingState.treeDepth as 10 | 20,
    };
    noteStartIndex = existingState.nextIndex;
    warmupDepositSignature = "reused-existing-pool";
    warmupWithdrawSignature = "reused-existing-pool";
  } else {
    pool = await createSolPool(
      context,
      Math.round(depositAmount * LAMPORTS_PER_SOL),
      10,
    );
    await prefundSolVaultForLowDenomination(
      context.connection,
      context.payer,
      pool.pool,
      context.program.programId,
      Math.round(depositAmount * LAMPORTS_PER_SOL),
    );
    const warmupDeposit = await depositWithSignature(
      context,
      pool.pool,
      depositAmount,
    );
    recordDevnetNote(noteJournal, warmupDeposit.note, {
      amount: depositAmount,
      assetType: "sol",
      depositSignature: warmupDeposit.signature,
      stage: `concurrency-warmup-c${concurrency}`,
    });
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    const warmupWithdraw = await withdrawWithSignature(
      context,
      pool.pool,
      warmupDeposit.note,
      context.payer,
    );
    markDevnetNoteWithdrawn(
      noteJournal,
      warmupDeposit.note,
      warmupWithdraw.signature,
    );
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    noteStartIndex = 1;
    warmupDepositSignature = warmupDeposit.signature;
    warmupWithdrawSignature = warmupWithdraw.signature;
  }

  const notes = await createNotesForPool(pool.pool, concurrency, noteStartIndex);
  for (const note of notes) {
    recordPlannedDevnetNote(noteJournal, note, {
      amount: depositAmount,
      assetType: "sol",
      stage: `concurrency-c${concurrency}-round1`,
    });
  }
  persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
  const depositAttempts = await buildSolDepositAttempts(context, pool, agents, notes);

  const depositStartedAt = Date.now();
  const depositResults = await executeOperationBatch(context.connection, depositAttempts);
  const depositWallClockMs = Date.now() - depositStartedAt;
  const depositSummary = summarizeOperations(depositResults);

  for (const [index, result] of depositResults.entries()) {
    if (result.succeeded) {
      markDevnetNoteDeposited(noteJournal, notes[index], result.signature);
      continue;
    }

    markDevnetNoteFailed(
      noteJournal,
      notes[index],
      result.errorMessage ?? result.errorType ?? "Unknown deposit failure",
    );
  }
  persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);

  const successfulDeposits = depositResults.flatMap((result, index) =>
    result.succeeded
      ? [{ agent: agents[index], note: notes[index] }]
      : [],
  );

  let proofGenWallClockMs = 0;
  let withdrawSummary: ConcurrencyResult["withdrawals"] = {
    attempted: 0,
    computeUnits: [],
    errors: {},
    failed: 0,
    latencies: [],
    proofGenTimes: [],
    succeeded: 0,
  };
  let withdrawWallClockMs = 0;
  let withdrawResults: Awaited<ReturnType<typeof executeOperationBatch>> = [];

  if (successfulDeposits.length > 0) {
    const poolState = await fetchPoolState(
      context.program,
      context.connection,
      pool.pool,
    );
    const proofStartedAt = Date.now();
    const proofs = await generateProofMeasurements(
      poolState,
      successfulDeposits.map((entry) => entry.note),
      usePayerRecipient
        ? successfulDeposits.map(() => context.payer)
        : successfulDeposits.map((entry) => entry.agent),
    );
    proofGenWallClockMs = Date.now() - proofStartedAt;

    const withdrawAttempts = await buildSolWithdrawAttempts(context, pool, proofs);
    const withdrawStartedAt = Date.now();
    withdrawResults = await executeOperationBatch(
      context.connection,
      withdrawAttempts,
    );
    withdrawWallClockMs = Date.now() - withdrawStartedAt;
    withdrawSummary = {
      ...summarizeOperations(withdrawResults),
      proofGenTimes: proofs.map((proof) => proof.latencyMs),
    };

    for (const [index, result] of withdrawResults.entries()) {
      if (!result.succeeded || result.signature === null) {
        continue;
      }

      markDevnetNoteWithdrawn(
        noteJournal,
        proofs[index].note,
        result.signature,
      );
    }
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
  }

  const totalAttempts = depositSummary.attempted + withdrawSummary.attempted;
  const totalFailures = depositSummary.failed + withdrawSummary.failed;

  return {
    concurrency,
    contentionRate: totalAttempts === 0 ? 0 : totalFailures / totalAttempts,
    deposits: depositSummary,
    depositWallClockMs,
    errors: {
      ...depositSummary.errors,
      ...withdrawSummary.errors,
    },
    pool: pool.pool.toBase58(),
    proofGenWallClockMs,
    round: 1,
    sampleErrors: collectSampleErrors(depositResults, withdrawResults),
    withdrawWallClockMs,
    withdrawals: withdrawSummary,
    warmup: {
      depositSignature: warmupDepositSignature,
      withdrawSignature: warmupWithdrawSignature,
    },
  };
}

function summarizeArtifact(results: ConcurrencyResult[]) {
  return CONCURRENCY_LEVELS.map((concurrency) => {
    const sample = results.find((result) => result.concurrency === concurrency);
    if (!sample) {
      return {
        concurrency,
        contentionRate: 0,
        depositTps: 0,
        p95LatencyMs: 0,
        withdrawTps: 0,
      };
    }

    return {
      concurrency,
      contentionRate: round(sample.contentionRate, 4),
      depositTps: round(
        sample.deposits.succeeded === 0
          ? 0
          : (sample.deposits.succeeded * 1_000) / sample.depositWallClockMs,
      ),
      p95LatencyMs: percentile(
        [...sample.deposits.latencies, ...sample.withdrawals.latencies],
        95,
      ),
      withdrawTps: round(
        sample.withdrawals.succeeded === 0
          ? 0
          : (sample.withdrawals.succeeded * 1_000) / sample.withdrawWallClockMs,
      ),
    };
  });
}

function collectSampleErrors(
  depositResults: Array<{ errorMessage: string | null }>,
  withdrawResults: Array<{ errorMessage: string | null }>,
): string[] {
  const unique = new Set<string>();
  for (const result of [...depositResults, ...withdrawResults]) {
    if (result.errorMessage) {
      unique.add(result.errorMessage);
    }
    if (unique.size >= 3) {
      break;
    }
  }

  return [...unique];
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

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }

  return parsed;
}

function parsePublicKeyEnv(value: string | undefined): PublicKey | null {
  if (!value) {
    return null;
  }

  return new PublicKey(value);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
