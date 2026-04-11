import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  buildArtifactHeader,
  buildSplDepositAttempts,
  buildSplWithdrawAttempts,
  calculateTps,
  closeStressContext,
  createNotesForPool,
  createRelayer,
  createSignedRelayRequest,
  createSplPool,
  createStressContext,
  disposeRelayer,
  executeOperationBatch,
  fetchPoolStorageFootprint,
  fetchPoolState,
  formatPct,
  generateProofMeasurements,
  makeAgentWallets,
  mintTokensToAgents,
  percentile,
  postJson,
  printSummaryTable,
  readArtifact,
  requestAirdrops,
  round,
  snapshotMemory,
  writeArtifact,
} from "./shared";

const CONCURRENCY_LEVELS = [1, 5, 10] as const;
const CONCURRENCY_ROUNDS = 3;
const GROWTH_CHECKPOINTS = [10, 100, 500, 1000] as const;
const SPL_DECIMALS = 6;
const TOKEN_AMOUNT_RAW = 1_000_000;
const TOKEN_AIRDROP_LAMPORTS = 2 * LAMPORTS_PER_SOL;

interface SplOperationSummary {
  attempted: number;
  computeUnits: number[];
  errors: Record<string, number>;
  failed: number;
  latencies: number[];
  succeeded: number;
}

interface SplConcurrentResult {
  concurrency: number;
  contentionRate: number;
  deposits: SplOperationSummary;
  depositWallClockMs: number;
  proofGenWallClockMs: number;
  proofGenTimes: number[];
  round: number;
  withdrawals: SplOperationSummary;
  withdrawWallClockMs: number;
}

interface SplGrowthCheckpoint {
  commitmentPageBytes: number;
  commitmentPageCount: number;
  commitmentPageRentLamports: number;
  depositComputeUnits: number | null;
  depositCount: number;
  depositLatencyMs: number | null;
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

interface SplGrowthFailure {
  depositCount: number;
  message: string;
}

interface SplAtaOverheadMeasurement {
  firstWithdrawalComputeUnits: number | null;
  firstWithdrawalLatencyMs: number;
  overheadComputeUnits: number | null;
  overheadLatencyMs: number;
  secondWithdrawalComputeUnits: number | null;
  secondWithdrawalLatencyMs: number;
}

interface SplRelayedMeasurement {
  confirmationLatencyMs: number | null;
  feeRaw: number;
  memoryAfter: ReturnType<typeof snapshotMemory>;
  memoryBefore: ReturnType<typeof snapshotMemory>;
  recipientAtaCreated: boolean;
  recipientReceivedRaw: number;
  relayerAtaCreated: boolean;
  requestLatencyMs: number;
  status: number;
  submissionLatencyMs: number | null;
  txSignature: string | null;
  withdrawalComputeUnits: number | null;
}

interface SplScalingArtifact {
  ataCreationOverhead: SplAtaOverheadMeasurement;
  comparison: {
    concurrency: Array<{
      concurrency: number;
      depositTpsDeltaPct: number | null;
      splDepositTps: number;
      splWithdrawTps: number;
      solDepositTps: number | null;
      solWithdrawTps: number | null;
      withdrawTpsDeltaPct: number | null;
    }>;
    growth: Array<{
      depositCount: number;
      splDepositLatencyMs: number;
      splWithdrawalLatencyMs: number;
      solDepositLatencyMs: number | null;
      solWithdrawalLatencyMs: number | null;
    }>;
  };
  concurrency: {
    results: SplConcurrentResult[];
    summary: Array<{
      concurrency: number;
      contentionRateAvg: number;
      depositTpsAvg: number;
      p95LatencyMs: number;
      rounds: number;
      withdrawTpsAvg: number;
    }>;
  };
  config: {
    concurrencyLevels: number[];
    concurrencyRounds: number;
    depositAmountRaw: number;
    growthCheckpoints: number[];
    tokenDecimals: number;
  };
  growth: {
    checkpoints: SplGrowthCheckpoint[];
    failure: SplGrowthFailure | null;
  };
  metadata: ReturnType<typeof buildArtifactHeader>;
  relayedWithdrawal: SplRelayedMeasurement;
}

export async function runSplScalingStressTest(): Promise<SplScalingArtifact> {
  const context = createStressContext();
  try {
    const artifact: SplScalingArtifact = {
      ataCreationOverhead: await measureAtaCreationOverhead(context),
      comparison: {
        concurrency: [],
        growth: [],
      },
      concurrency: {
        results: [],
        summary: [],
      },
      config: {
        concurrencyLevels: [...CONCURRENCY_LEVELS],
        concurrencyRounds: CONCURRENCY_ROUNDS,
        depositAmountRaw: TOKEN_AMOUNT_RAW,
        growthCheckpoints: [...GROWTH_CHECKPOINTS],
        tokenDecimals: SPL_DECIMALS,
      },
      growth: {
        checkpoints: [],
        failure: null,
      },
      metadata: buildArtifactHeader(context),
      relayedWithdrawal: await measureRelayedSplWithdrawal(context),
    };

    for (const concurrency of CONCURRENCY_LEVELS) {
      for (let roundNumber = 1; roundNumber <= CONCURRENCY_ROUNDS; roundNumber += 1) {
        console.log(`\n[spl-scaling] concurrency=${concurrency} round=${roundNumber}`);
        const result = await runConcurrentRound(context, concurrency, roundNumber);
        artifact.concurrency.results.push(result);
        artifact.concurrency.summary = summarizeConcurrentResults(
          artifact.concurrency.results,
        );
        artifact.comparison = buildComparison(artifact);
        writeArtifact("spl-scaling.json", artifact);
      }
    }

    const growthResult = await runGrowthCheckpoints(context, (checkpoints, failure) => {
      artifact.growth.checkpoints = checkpoints;
      artifact.growth.failure = failure;
      artifact.comparison = buildComparison(artifact);
      writeArtifact("spl-scaling.json", artifact);
    });
    artifact.growth.checkpoints = growthResult.checkpoints;
    artifact.growth.failure = growthResult.failure;
    artifact.comparison = buildComparison(artifact);
    writeArtifact("spl-scaling.json", artifact);

    printSummaryTable(
      artifact.concurrency.summary.map((row) => ({
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

async function runConcurrentRound(
  context: ReturnType<typeof createStressContext>,
  concurrency: number,
  roundNumber: number,
): Promise<SplConcurrentResult> {
  const pool = await createSplPool(context, TOKEN_AMOUNT_RAW, SPL_DECIMALS);
  const agents = makeAgentWallets(concurrency);
  await requestAirdrops(context.connection, agents, TOKEN_AIRDROP_LAMPORTS);
  const tokenAccounts = await mintTokensToAgents(
    context,
    pool.mint,
    agents,
    TOKEN_AMOUNT_RAW,
  );
  const notes = await createNotesForPool(pool.pool, concurrency);

  const depositAttempts = await buildSplDepositAttempts(
    context,
    pool,
    tokenAccounts,
    notes,
  );
  const depositStartedAt = Date.now();
  const depositResults = await executeOperationBatch(context.connection, depositAttempts);
  const depositWallClockMs = Date.now() - depositStartedAt;

  const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
  const successfulNotes = depositResults.flatMap((result, index) =>
    result.succeeded ? [{ agent: agents[index], note: notes[index] }] : [],
  );
  const proofStartedAt = Date.now();
  const proofs = await generateProofMeasurements(
    poolState,
    successfulNotes.map((entry) => entry.note),
    successfulNotes.map((entry) => entry.agent),
  );
  const proofGenWallClockMs = Date.now() - proofStartedAt;

  const withdrawAttempts = await buildSplWithdrawAttempts(context, pool, proofs, {
    createRecipientAtaIfMissing: false,
    mint: pool.mint,
    payerIsRecipient: true,
  });
  const withdrawStartedAt = Date.now();
  const withdrawResults = await executeOperationBatch(context.connection, withdrawAttempts);
  const withdrawWallClockMs = Date.now() - withdrawStartedAt;

  const depositSummary = summarizeBatch(depositResults);
  const withdrawSummary = summarizeBatch(withdrawResults);
  const totalAttempts = depositSummary.attempted + withdrawSummary.attempted;
  const totalFailures = depositSummary.failed + withdrawSummary.failed;

  return {
    concurrency,
    contentionRate: totalAttempts === 0 ? 0 : totalFailures / totalAttempts,
    deposits: depositSummary,
    depositWallClockMs,
    proofGenTimes: proofs.map((entry) => entry.latencyMs),
    proofGenWallClockMs,
    round: roundNumber,
    withdrawals: withdrawSummary,
    withdrawWallClockMs,
  };
}

async function runGrowthCheckpoints(
  context: ReturnType<typeof createStressContext>,
  onCheckpoint?: (
    checkpoints: SplGrowthCheckpoint[],
    failure: SplGrowthFailure | null,
  ) => void,
): Promise<{
  checkpoints: SplGrowthCheckpoint[];
  failure: SplGrowthFailure | null;
}> {
  const pool = await createSplPool(context, TOKEN_AMOUNT_RAW, SPL_DECIMALS);
  const [depositor] = makeAgentWallets(1);
  await requestAirdrops(context.connection, [depositor], TOKEN_AIRDROP_LAMPORTS);
  const [recipient] = makeAgentWallets(1);
  await requestAirdrops(context.connection, [recipient], TOKEN_AIRDROP_LAMPORTS);

  const [depositorBundle] = await mintTokensToAgents(
    context,
    pool.mint,
    [depositor],
    TOKEN_AMOUNT_RAW * (GROWTH_CHECKPOINTS[GROWTH_CHECKPOINTS.length - 1] + 10),
  );
  await getOrCreateAssociatedTokenAccount(
    context.connection,
    context.payer,
    pool.mint,
    recipient.publicKey,
  );

  const checkpointSet = new Set<number>(GROWTH_CHECKPOINTS);
  const checkpoints: SplGrowthCheckpoint[] = [];
  let failure: SplGrowthFailure | null = null;

  for (let depositCount = 1; depositCount <= GROWTH_CHECKPOINTS[GROWTH_CHECKPOINTS.length - 1]; depositCount += 1) {
    const [note] = await createNotesForPool(pool.pool, 1, depositCount - 1);
    const [depositAttempt] = await buildSplDepositAttempts(
      context,
      pool,
      [depositorBundle],
      [note],
    );
    const [depositResult] = await executeOperationBatch(context.connection, [
      depositAttempt,
    ]);

    if (!depositResult.succeeded) {
      failure = {
        depositCount,
        message: `${depositResult.errorType} ${depositResult.errorMessage ?? ""}`.trim(),
      };
      onCheckpoint?.([...checkpoints], failure);
      return {
        checkpoints,
        failure,
      };
    }

    if (!checkpointSet.has(depositCount)) {
      continue;
    }

    const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
    const footprint = await fetchPoolStorageFootprint(
      context.connection,
      pool.pool,
      context.program.programId,
      poolState.nextIndex,
    );
    let proofGenTimeMs: number | null = null;
    let proofError: string | null = null;
    let withdrawalComputeUnits: number | null = null;
    let withdrawalError: string | null = null;
    let withdrawalLatencyMs: number | null = null;

    try {
      const [proofMeasurement] = await generateProofMeasurements(
        poolState,
        [note],
        [recipient],
      );
      proofGenTimeMs = proofMeasurement.latencyMs;
      const [withdrawAttempt] = await buildSplWithdrawAttempts(context, pool, [
        proofMeasurement,
      ], {
        createRecipientAtaIfMissing: false,
        mint: pool.mint,
        payerIsRecipient: false,
      });
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

    checkpoints.push({
      commitmentPageBytes: footprint.commitmentPageBytes,
      commitmentPageCount: footprint.commitmentPageCount,
      commitmentPageRentLamports: footprint.commitmentPageRentLamports,
      depositComputeUnits: depositResult.computeUnits,
      depositCount,
      depositLatencyMs: depositResult.latencyMs,
      poolAccountBytes: footprint.poolAccountBytes,
      proofError,
      proofGenTimeMs,
      poolRentLamports: footprint.poolRentLamports,
      totalStorageBytes: footprint.totalStorageBytes,
      totalStorageRentLamports: footprint.totalStorageRentLamports,
      withdrawalComputeUnits,
      withdrawalError,
      withdrawalLatencyMs,
    });
    onCheckpoint?.([...checkpoints], failure);
  }

  return {
    checkpoints,
    failure,
  };
}

async function measureAtaCreationOverhead(
  context: ReturnType<typeof createStressContext>,
): Promise<SplAtaOverheadMeasurement> {
  const pool = await createSplPool(context, TOKEN_AMOUNT_RAW, SPL_DECIMALS);
  const [depositor] = makeAgentWallets(1);
  await requestAirdrops(context.connection, [depositor], TOKEN_AIRDROP_LAMPORTS);
  const [depositorBundle] = await mintTokensToAgents(
    context,
    pool.mint,
    [depositor],
    TOKEN_AMOUNT_RAW * 3,
  );
  const [recipient] = makeAgentWallets(1);

  const notes = await createNotesForPool(pool.pool, 2);
  for (const note of notes) {
    const [depositAttempt] = await buildSplDepositAttempts(
      context,
      pool,
      [depositorBundle],
      [note],
    );
    const [depositResult] = await executeOperationBatch(context.connection, [
      depositAttempt,
    ]);
    if (!depositResult.succeeded) {
      throw new Error(
        `SPL ATA deposit failed: ${depositResult.errorType} ${depositResult.errorMessage ?? ""}`,
      );
    }
  }

  let poolState = await fetchPoolState(context.program, context.connection, pool.pool);
  const [firstProof] = await generateProofMeasurements(poolState, [notes[0]], [recipient]);
  const [firstAttempt] = await buildSplWithdrawAttempts(context, pool, [firstProof], {
    createRecipientAtaIfMissing: true,
    mint: pool.mint,
    payerIsRecipient: false,
  });
  const [firstResult] = await executeOperationBatch(context.connection, [firstAttempt]);
  if (!firstResult.succeeded) {
    throw new Error(
      `First ATA-creating SPL withdrawal failed: ${firstResult.errorType} ${firstResult.errorMessage ?? ""}`,
    );
  }

  poolState = await fetchPoolState(context.program, context.connection, pool.pool);
  const [secondProof] = await generateProofMeasurements(poolState, [notes[1]], [recipient]);
  const [secondAttempt] = await buildSplWithdrawAttempts(context, pool, [secondProof], {
    createRecipientAtaIfMissing: true,
    mint: pool.mint,
    payerIsRecipient: false,
  });
  const [secondResult] = await executeOperationBatch(context.connection, [secondAttempt]);
  if (!secondResult.succeeded) {
    throw new Error(
      `Second steady-state SPL withdrawal failed: ${secondResult.errorType} ${secondResult.errorMessage ?? ""}`,
    );
  }

  return {
    firstWithdrawalComputeUnits: firstResult.computeUnits,
    firstWithdrawalLatencyMs: firstResult.latencyMs,
    overheadComputeUnits:
      firstResult.computeUnits !== null && secondResult.computeUnits !== null
        ? firstResult.computeUnits - secondResult.computeUnits
        : null,
    overheadLatencyMs: firstResult.latencyMs - secondResult.latencyMs,
    secondWithdrawalComputeUnits: secondResult.computeUnits,
    secondWithdrawalLatencyMs: secondResult.latencyMs,
  };
}

async function measureRelayedSplWithdrawal(
  context: ReturnType<typeof createStressContext>,
): Promise<SplRelayedMeasurement> {
  const pool = await createSplPool(context, TOKEN_AMOUNT_RAW, SPL_DECIMALS);
  const [depositor] = makeAgentWallets(1);
  await requestAirdrops(context.connection, [depositor], TOKEN_AIRDROP_LAMPORTS);
  const [depositorBundle] = await mintTokensToAgents(
    context,
    pool.mint,
    [depositor],
    TOKEN_AMOUNT_RAW * 2,
  );
  const [note] = await createNotesForPool(pool.pool, 1);
  const [depositAttempt] = await buildSplDepositAttempts(
    context,
    pool,
    [depositorBundle],
    [note],
  );
  const [depositResult] = await executeOperationBatch(context.connection, [depositAttempt]);
  if (!depositResult.succeeded) {
    throw new Error(
      `Relayed SPL deposit failed: ${depositResult.errorType} ${depositResult.errorMessage ?? ""}`,
    );
  }

  const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
  const { dbPath, harness, relayer } = await createRelayer(context, pool.pool, {
    maxRequestsPerMinuteGlobal: 1_000,
    maxRequestsPerMinutePerIp: 1_000,
  });
  const recipient = makeAgentWallets(1)[0];
  const recipientTokenAccount = getAssociatedTokenAddressSync(
    pool.mint,
    recipient.publicKey,
  );
  const relayerTokenAccount = getAssociatedTokenAddressSync(
    pool.mint,
    relayer.publicKey,
  );
  const memoryBefore = snapshotMemory();

  try {
    const feeRaw = Math.floor((TOKEN_AMOUNT_RAW * harness.config.feeBps) / 10_000);
    const signedRequest = await createSignedRelayRequest(
      pool.pool,
      note,
      poolState,
      recipient.publicKey,
      feeRaw,
      depositor,
    );

    const requestStartedAt = Date.now();
    const response = await postJson(`${harness.baseUrl}/relay`, signedRequest);
    const requestLatencyMs = Date.now() - requestStartedAt;

    let submissionLatencyMs: number | null = null;
    let confirmationLatencyMs: number | null = null;
    let txSignature: string | null = null;
    let withdrawalComputeUnits: number | null = null;

    if (response.status === 200) {
      txSignature = String(response.body.txSignature);
      const record = harness.store.getByNullifier(
        signedRequest.payload.nullifierHash,
      );
      if (record?.submittedAt) {
        submissionLatencyMs = record.submittedAt - record.receivedAt;
      }
      if (record?.submittedAt && record.updatedAt) {
        confirmationLatencyMs = record.updatedAt - record.submittedAt;
      }
      withdrawalComputeUnits = txSignature
        ? await import("../helpers").then(({ fetchTransactionComputeUnits }) =>
            fetchTransactionComputeUnits(context.connection, txSignature),
          )
        : null;
    }

    return {
      confirmationLatencyMs,
      feeRaw,
      memoryAfter: snapshotMemory(),
      memoryBefore,
      recipientAtaCreated:
        (await context.connection.getAccountInfo(recipientTokenAccount, "confirmed")) !== null,
      recipientReceivedRaw: response.status === 200 ? TOKEN_AMOUNT_RAW - feeRaw : 0,
      relayerAtaCreated:
        (await context.connection.getAccountInfo(relayerTokenAccount, "confirmed")) !== null,
      requestLatencyMs,
      status: response.status,
      submissionLatencyMs,
      txSignature,
      withdrawalComputeUnits,
    };
  } finally {
    await disposeRelayer(harness, dbPath);
  }
}

function summarizeConcurrentResults(results: SplConcurrentResult[]) {
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

function summarizeBatch(
  results: Array<{
    computeUnits: number | null;
    errorType: string | null;
    latencyMs: number;
    succeeded: boolean;
  }>,
): SplOperationSummary {
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

function buildComparison(artifact: SplScalingArtifact) {
  const concurrentSol = readArtifact<{
    summary: Array<{
      concurrency: number;
      depositTpsAvg: number;
      withdrawTpsAvg: number;
    }>;
  }>("concurrent-clients.json");
  const growthSol = readArtifact<{
    checkpoints: Array<{
      depositCount: number;
      depositLatencyMs: number;
      withdrawalLatencyMs: number;
    }>;
  }>("pool-growth.json");

  return {
    concurrency: artifact.concurrency.summary.map((entry) => {
      const sol = concurrentSol?.summary.find(
        (candidate) => candidate.concurrency === entry.concurrency,
      );
      return {
        concurrency: entry.concurrency,
        depositTpsDeltaPct:
          sol && sol.depositTpsAvg > 0
            ? round(((entry.depositTpsAvg - sol.depositTpsAvg) / sol.depositTpsAvg) * 100, 2)
            : null,
        splDepositTps: entry.depositTpsAvg,
        splWithdrawTps: entry.withdrawTpsAvg,
        solDepositTps: sol?.depositTpsAvg ?? null,
        solWithdrawTps: sol?.withdrawTpsAvg ?? null,
        withdrawTpsDeltaPct:
          sol && sol.withdrawTpsAvg > 0
            ? round(((entry.withdrawTpsAvg - sol.withdrawTpsAvg) / sol.withdrawTpsAvg) * 100, 2)
            : null,
      };
    }),
    growth: artifact.growth.checkpoints.map((entry) => {
      const sol = growthSol?.checkpoints.find(
        (candidate) => candidate.depositCount === entry.depositCount,
      );
      return {
        depositCount: entry.depositCount,
        splDepositLatencyMs: entry.depositLatencyMs,
        splWithdrawalLatencyMs: entry.withdrawalLatencyMs,
        solDepositLatencyMs: sol?.depositLatencyMs ?? null,
        solWithdrawalLatencyMs: sol?.withdrawalLatencyMs ?? null,
      };
    }),
  };
}

if (require.main === module) {
  runSplScalingStressTest()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
