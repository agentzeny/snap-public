import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  buildArtifactHeader,
  buildSolDepositAttempts,
  buildSolWithdrawAttempts,
  closeStressContext,
  createNotesForPool,
  createSolPool,
  createStressContext,
  executeOperationBatch,
  fetchPoolStorageFootprint,
  fetchPoolState,
  formatPct,
  generateProofMeasurements,
  makeAgentWallets,
  requestAirdrops,
  round,
  summarizeOperations,
  writeArtifact,
} from "./shared";

const CHECKPOINTS = [10, 50, 100, 500, 1000, 2000] as const;
const DEPOSIT_AMOUNT_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;
const GROWTH_TIMEOUT_MS =
  Number(process.env.SNAP_STRESS_GROWTH_TIMEOUT_MS ?? 30 * 60 * 1_000) || 30 * 60 * 1_000;
const TREE_DEPTH = 20 as const;
const WITHDRAW_AIRDROP_LAMPORTS = 2 * LAMPORTS_PER_SOL;

interface GrowthCheckpoint {
  commitmentPageBytes: number;
  commitmentPageCount: number;
  commitmentPageRentLamports: number;
  depositComputeUnits: number | null;
  depositCount: number;
  depositLatencyMs: number | null;
  merkleRootUpdateCu: number | null;
  poolAccountBytes: number;
  proofError: string | null;
  proofGenTimeMs: number | null;
  poolRentLamports: number;
  totalStorageBytes: number;
  totalStorageRentLamports: number;
  withdrawalComputeUnits: number | null;
  withdrawalError: string | null;
  withdrawalLatencyMs: number | null;
}

interface PoolGrowthArtifact {
  checkpoints: GrowthCheckpoint[];
  config: {
    checkpoints: number[];
    depositAmountLamports: number;
    timeoutMs: number;
    treeDepth: number;
  };
  finalDepositCount: number;
  metadata: ReturnType<typeof buildArtifactHeader>;
  notes: string[];
  timedOut: boolean;
  timedOutAtDepositCount: number | null;
}

export async function runPoolGrowthStressTest(): Promise<PoolGrowthArtifact> {
  const context = createStressContext();
  try {
    await requestAirdrops(context.connection, [context.payer], 750 * LAMPORTS_PER_SOL);

    const artifact: PoolGrowthArtifact = {
      checkpoints: [],
      config: {
        checkpoints: [...CHECKPOINTS],
        depositAmountLamports: DEPOSIT_AMOUNT_LAMPORTS,
        timeoutMs: GROWTH_TIMEOUT_MS,
        treeDepth: TREE_DEPTH,
      },
      finalDepositCount: 0,
      metadata: buildArtifactHeader(context),
      notes: [],
      timedOut: false,
      timedOutAtDepositCount: null,
    };

    const pool = await createSolPool(context, DEPOSIT_AMOUNT_LAMPORTS, TREE_DEPTH);
    const checkpointSet = new Set<number>(CHECKPOINTS);
    const startedAt = Date.now();

    for (let depositCount = 1; depositCount <= CHECKPOINTS[CHECKPOINTS.length - 1]; depositCount += 1) {
      const [note] = await createNotesForPool(pool.pool, 1, depositCount - 1);
      const [depositAttempt] = await buildSolDepositAttempts(context, pool, [context.payer], [note]);
      const [depositResult] = await executeOperationBatch(context.connection, [depositAttempt]);

      if (!depositResult.succeeded) {
        artifact.notes.push(
          `deposit ${depositCount} failed: ${depositResult.errorType} ${depositResult.errorMessage ?? ""}`,
        );
        writeArtifact("pool-growth.json", artifact);
        throw new Error(
          `Pool growth deposit ${depositCount} failed: ${depositResult.errorType} ${depositResult.errorMessage ?? ""}`,
        );
      }

      artifact.finalDepositCount = depositCount;

      if (checkpointSet.has(depositCount)) {
        const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
        const poolFootprint = await fetchPoolStorageFootprint(
          context.connection,
          pool.pool,
          context.program.programId,
          poolState.nextIndex,
        );
        const [recipient] = makeAgentWallets(1);
        await requestAirdrops(context.connection, [recipient], WITHDRAW_AIRDROP_LAMPORTS);

        let proofGenTimeMs: number | null = null;
        let proofError: string | null = null;
        let withdrawalComputeUnits: number | null = null;
        let withdrawalError: string | null = null;
        let withdrawalLatencyMs: number | null = null;

        try {
          const proofMeasurement = (
            await generateProofMeasurements(poolState, [note], [recipient])
          )[0];
          proofGenTimeMs = proofMeasurement.latencyMs;

          const [withdrawAttempt] = await buildSolWithdrawAttempts(context, pool, [
            proofMeasurement,
          ]);
          const [withdrawResult] = await executeOperationBatch(context.connection, [
            withdrawAttempt,
          ]);

          if (!withdrawResult.succeeded) {
            withdrawalError = `${withdrawResult.errorType} ${withdrawResult.errorMessage ?? ""}`.trim();
          } else {
            withdrawalComputeUnits = withdrawResult.computeUnits;
            withdrawalLatencyMs = withdrawResult.latencyMs;
          }
        } catch (error) {
          proofError = error instanceof Error ? error.message : String(error);
        }

        artifact.checkpoints.push({
          commitmentPageBytes: poolFootprint.commitmentPageBytes,
          commitmentPageCount: poolFootprint.commitmentPageCount,
          commitmentPageRentLamports: poolFootprint.commitmentPageRentLamports,
          depositComputeUnits: depositResult.computeUnits,
          depositCount,
          depositLatencyMs: depositResult.latencyMs,
          merkleRootUpdateCu: null,
          poolAccountBytes: poolFootprint.poolAccountBytes,
          proofError,
          proofGenTimeMs,
          poolRentLamports: poolFootprint.poolRentLamports,
          totalStorageBytes: poolFootprint.totalStorageBytes,
          totalStorageRentLamports: poolFootprint.totalStorageRentLamports,
          withdrawalComputeUnits,
          withdrawalError,
          withdrawalLatencyMs,
        });

        artifact.notes.push(
          [
            `checkpoint=${depositCount}`,
            `depositCu=${depositResult.computeUnits ?? "n/a"}`,
            `withdrawCu=${withdrawalComputeUnits ?? "n/a"}`,
            `withdrawError=${withdrawalError ?? "none"}`,
            `poolBytes=${poolFootprint.poolAccountBytes}`,
            `pageBytes=${poolFootprint.commitmentPageBytes}`,
          ].join(" "),
        );
        writeArtifact("pool-growth.json", artifact);
        printCheckpoint(artifact.checkpoints[artifact.checkpoints.length - 1]);
      }

      if (Date.now() - startedAt > GROWTH_TIMEOUT_MS && depositCount < CHECKPOINTS[CHECKPOINTS.length - 1]) {
        artifact.timedOut = true;
        artifact.timedOutAtDepositCount = depositCount;
        artifact.notes.push(`Timed out after reaching deposit ${depositCount}`);
        writeArtifact("pool-growth.json", artifact);
        break;
      }
    }

    writeArtifact("pool-growth.json", artifact);
    return artifact;
  } finally {
    closeStressContext(context);
  }
}

function printCheckpoint(checkpoint: GrowthCheckpoint): void {
  console.log(
    [
      `[pool-growth] checkpoint=${checkpoint.depositCount}`,
      `deposit=${checkpoint.depositLatencyMs === null ? "n/a" : `${round(checkpoint.depositLatencyMs, 1)}ms`}`,
      `withdraw=${checkpoint.withdrawalLatencyMs === null ? "n/a" : `${round(checkpoint.withdrawalLatencyMs, 1)}ms`}`,
      `proof=${checkpoint.proofGenTimeMs === null ? "n/a" : `${round(checkpoint.proofGenTimeMs, 1)}ms`}`,
      `poolBytes=${checkpoint.poolAccountBytes}`,
      `pageBytes=${checkpoint.commitmentPageBytes}`,
      `pages=${checkpoint.commitmentPageCount}`,
      `rent=${checkpoint.totalStorageRentLamports}`,
      checkpoint.withdrawalError ? `withdrawError=${checkpoint.withdrawalError}` : "withdrawError=none",
    ].join(" "),
  );
}

if (require.main === module) {
  runPoolGrowthStressTest()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
