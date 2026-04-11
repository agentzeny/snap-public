import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Note } from "../../sdk-package/src";
import {
  buildArtifactHeader,
  buildSolDepositAttempts,
  buildSolWithdrawAttempts,
  calculateTps,
  closeStressContext,
  createNotesForPool,
  createSolPool,
  createStressContext,
  executeOperationBatch,
  fetchPoolState,
  formatPct,
  generateProofMeasurements,
  makeAgentWallets,
  percentile,
  printSummaryTable,
  requestAirdrops,
  round,
  summarizeOperations,
  writeArtifact,
  type OperationResult,
  type OperationSummary,
} from "./shared";

const CONCURRENCY_LEVELS = [1, 3, 5, 10, 20] as const;
const DEFAULT_ROUNDS = 3;
const DEPOSIT_AMOUNT_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;
const AGENT_AIRDROP_LAMPORTS = 2 * LAMPORTS_PER_SOL;
const TREE_DEPTH = 10 as const;

interface StressOperationSummary extends OperationSummary {
  computeUnits: number[];
}

interface ConcurrentStressResult {
  concurrency: number;
  contentionRate: number;
  deposits: StressOperationSummary;
  depositWallClockMs: number;
  effectiveTps: number;
  pool: string;
  proofGenWallClockMs: number;
  round: number;
  roundWallClockMs: number;
  withdrawals: StressOperationSummary & {
    proofGenTimes: number[];
  };
  withdrawWallClockMs: number;
}

interface ConcurrentStressArtifact {
  config: {
    agentAirdropLamports: number;
    concurrency: number[];
    depositAmountLamports: number;
    rounds: number;
    treeDepth: number;
  };
  metadata: ReturnType<typeof buildArtifactHeader>;
  results: ConcurrentStressResult[];
  summary: Array<{
    concurrency: number;
    contentionRateAvg: number;
    depositTpsAvg: number;
    p95LatencyMs: number;
    rounds: number;
    withdrawTpsAvg: number;
  }>;
}

export async function runConcurrentClientsStressTest(): Promise<ConcurrentStressArtifact> {
  const context = createStressContext();
  try {
    const artifact: ConcurrentStressArtifact = {
      config: {
        agentAirdropLamports: AGENT_AIRDROP_LAMPORTS,
        concurrency: [...CONCURRENCY_LEVELS],
        depositAmountLamports: DEPOSIT_AMOUNT_LAMPORTS,
        rounds: DEFAULT_ROUNDS,
        treeDepth: TREE_DEPTH,
      },
      metadata: buildArtifactHeader(context),
      results: [],
      summary: [],
    };

    for (const concurrency of CONCURRENCY_LEVELS) {
      for (let roundNumber = 1; roundNumber <= DEFAULT_ROUNDS; roundNumber += 1) {
        console.log(`\n[concurrent-clients] concurrency=${concurrency} round=${roundNumber}`);
        const result = await runRound(context, concurrency, roundNumber);
        artifact.results.push(result);
        artifact.summary = summarizeArtifact(artifact.results);
        writeArtifact("concurrent-clients.json", artifact);
      }
    }

    printSummaryTable(
      artifact.summary.map((row) => ({
        concurrency: row.concurrency,
        contentionPct: formatPct(row.contentionRateAvg),
        depositTps: row.depositTpsAvg.toFixed(2),
        p95LatencyMs: `${Math.round(row.p95LatencyMs)}ms`,
        withdrawTps: row.withdrawTpsAvg.toFixed(2),
      })),
    );

    return artifact;
  } finally {
    closeStressContext(context);
  }
}

async function runRound(
  context: ReturnType<typeof createStressContext>,
  concurrency: number,
  roundNumber: number,
): Promise<ConcurrentStressResult> {
  const roundStartedAt = Date.now();
  const pool = await createSolPool(context, DEPOSIT_AMOUNT_LAMPORTS, TREE_DEPTH);
  const agents = makeAgentWallets(concurrency);
  await requestAirdrops(context.connection, agents, AGENT_AIRDROP_LAMPORTS);

  const notes = await createNotesForPool(pool.pool, concurrency);
  const depositAttempts = await buildSolDepositAttempts(context, pool, agents, notes);

  const depositsStartedAt = Date.now();
  const depositResults = await executeOperationBatch(context.connection, depositAttempts);
  const depositWallClockMs = Date.now() - depositsStartedAt;
  const depositSummary = summarizeOperations(depositResults);

  const successfulDeposits = collectSuccessfulNotes(depositResults, notes, agents);
  let proofGenWallClockMs = 0;
  let proofGenTimes: number[] = [];
  let withdrawSummary: StressOperationSummary & { proofGenTimes: number[] } = {
    attempted: 0,
    computeUnits: [],
    errors: {},
    failed: 0,
    latencies: [],
    proofGenTimes: [],
    succeeded: 0,
  };
  let withdrawWallClockMs = 0;

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
      successfulDeposits.map((entry) => entry.agent),
    );
    proofGenWallClockMs = Date.now() - proofStartedAt;
    proofGenTimes = proofs.map((entry) => entry.latencyMs);

    const withdrawAttempts = await buildSolWithdrawAttempts(context, pool, proofs);
    const withdrawStartedAt = Date.now();
    const withdrawResults = await executeOperationBatch(
      context.connection,
      withdrawAttempts,
    );
    withdrawWallClockMs = Date.now() - withdrawStartedAt;
    withdrawSummary = {
      ...summarizeOperations(withdrawResults),
      proofGenTimes,
    };
  }

  const roundWallClockMs = Date.now() - roundStartedAt;
  const totalAttempts = depositSummary.attempted + withdrawSummary.attempted;
  const totalFailures = depositSummary.failed + withdrawSummary.failed;

  return {
    concurrency,
    contentionRate: totalAttempts === 0 ? 0 : totalFailures / totalAttempts,
    deposits: depositSummary,
    depositWallClockMs,
    effectiveTps: calculateTps(
      depositSummary.succeeded + withdrawSummary.succeeded,
      roundWallClockMs,
    ),
    pool: pool.pool.toBase58(),
    proofGenWallClockMs,
    round: roundNumber,
    roundWallClockMs,
    withdrawals: withdrawSummary,
    withdrawWallClockMs,
  };
}

function collectSuccessfulNotes(
  results: OperationResult[],
  notes: Note[],
  agents: ReturnType<typeof makeAgentWallets>,
): Array<{ agent: ReturnType<typeof makeAgentWallets>[number]; note: Note }> {
  return results.flatMap((result, index) =>
    result.succeeded
      ? [
          {
            agent: agents[index],
            note: notes[index],
          },
        ]
      : [],
  );
}

function summarizeArtifact(results: ConcurrentStressResult[]) {
  return CONCURRENCY_LEVELS.map((concurrency) => {
    const samples = results.filter((result) => result.concurrency === concurrency);
    const depositTpsAvg =
      samples.length === 0
        ? 0
        : round(
            samples.reduce(
              (total, sample) =>
                total + calculateTps(sample.deposits.succeeded, sample.depositWallClockMs),
              0,
            ) / samples.length,
          );
    const withdrawTpsAvg =
      samples.length === 0
        ? 0
        : round(
            samples.reduce(
              (total, sample) =>
                total + calculateTps(sample.withdrawals.succeeded, sample.withdrawWallClockMs),
              0,
            ) / samples.length,
          );
    const contentionRateAvg =
      samples.length === 0
        ? 0
        : round(
            samples.reduce((total, sample) => total + sample.contentionRate, 0) /
              samples.length,
            4,
          );
    const p95LatencyMs = percentile(
      samples.flatMap((sample) => [
        ...sample.deposits.latencies,
        ...sample.withdrawals.latencies,
      ]),
      95,
    );

    return {
      concurrency,
      contentionRateAvg,
      depositTpsAvg,
      p95LatencyMs,
      rounds: samples.length,
      withdrawTpsAvg,
    };
  });
}

if (require.main === module) {
  runConcurrentClientsStressTest()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
