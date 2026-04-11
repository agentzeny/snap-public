import fs from "fs";
import os from "os";
import path from "path";
import { Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  depositWithSignature,
  initializePersistentNoteJournal,
  markDevnetNoteWithdrawn,
  persistDevnetNoteJournal,
  recordDevnetNote,
  prefundSolVaultForLowDenomination,
  round,
  waitForCondition,
  withDevnetRetry,
  writeDevnetArtifact,
} from "./devnet-validation-shared";
import {
  assertBalanceAtLeast,
  drainRelayerBalance,
  ensureRelayerBalance,
  startRelayerHarness,
  stopRelayerHarness,
} from "./relayer-harness";
import {
  createSignedRelayRequest,
  fetchPoolState,
  postJson,
} from "../tests/stress/shared";

const DEFAULT_SOL_DEPOSIT_AMOUNT = 0.001;
const DEFAULT_RELAYER_TARGET_LAMPORTS = 50_000_000;
const DEFAULT_MAX_TOTAL_LAMPORTS = 10_000_000;
const DEFAULT_PAYER_BUFFER_LAMPORTS = 5_000_000;
const DEFAULT_BURST_OUTPUT_FILE = "relayer-burst-validation.json";
const DEFAULT_NOTES_OUTPUT_FILE = "relayer-validation-notes.json";
const DEFAULT_RESTART_OUTPUT_FILE = "relayer-restart-validation.json";
const NULLIFIER_RECORD_SIZE_BYTES = 8 + 32 + 32 + 8;
const RELAYER_TX_FEE_RESERVE_LAMPORTS = 20_000;

interface RelayRecordSnapshot {
  clientIp: string;
  error: string | null;
  id: string;
  lastValidBlockHeight: number | null;
  nextAttemptAt: number;
  receivedAt: number;
  retries: number;
  status: string;
  submittedAt: number | null;
  txSignature: string | null;
  updatedAt: number;
}

interface RelayRequestOutcome {
  note: {
    amount: number;
    assetType: "sol";
    depositIndex: number;
    depositSignature: string | null;
    nullifierHash: string;
    pool: string;
  };
  noteStateAtScenarioEnd: {
    depositState: string;
    withdrawalSignature: string | null;
    withdrawn: boolean;
  };
  persistedRelayRecord: RelayRecordSnapshot | null;
  requestIndex: number;
  stage: string;
  surfaced: {
    classification: "relay-failure" | "rate-limited" | "success" | "unexpected";
    error: string | null;
    httpStatus: number;
    retryAfterSeconds: number | null;
    txSignature: string | null;
  };
}

interface RelayScenarioResult {
  acceptanceRate: number;
  accepted: number;
  attempted: number;
  averageConfirmationLatencyMs: number | null;
  averageRequestLatencyMs: number;
  averageSubmissionLatencyMs: number | null;
  concurrency: number;
  httpStatuses: Record<string, number>;
  maxAcceptedRequests: number;
  maxTotalLamports: number;
  mode: "default-limits" | "raw-throughput";
  noteJournalPath: string;
  payerBalanceAfter: number;
  payerBalanceBefore: number;
  pool: string;
  rateLimited: number;
  rejected: number;
  relayerTargetLamports: number;
  relayerConfig: {
    maxRequestsPerMinuteGlobal: number;
    maxRequestsPerMinutePerIp: number;
    minFeeLamports: number;
    retryBackoffMs: number[];
    retryPollIntervalMs: number;
  };
  relayRecordStatuses: Record<string, number>;
  requests: RelayRequestOutcome[];
  relayer: string;
  requiredRelayerTargetLamports: number;
  requestTps: number;
  retryAfterSeconds: number[];
  txSignatures: string[];
}

interface BurstValidationArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  config: {
    defaultLimits: {
      global: number;
      perIp: number;
    };
    depositAmount: number;
    existingPool: string | null;
    maxTotalLamports: number;
    rawLimits: {
      global: number;
      perIp: number;
    };
    requiredPayerLamports: number;
  };
  metadata: ReturnType<typeof buildMetadata>;
  scenarios: RelayScenarioResult[];
  stopReason: string | null;
}

interface RestartValidationArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  metadata: ReturnType<typeof buildMetadata>;
  note: {
    depositIndex: number;
    nullifierHash: string;
  };
  pool: string;
  recordId: string;
  relayer: string;
  requestMode: "persisted-signed-request";
  status: {
    afterRestart: string | null;
    beforeRestart: string | null;
  };
  timings: {
    confirmationLatencyMs: number | null;
    submittedLatencyMs: number | null;
  };
  txSignature: string | null;
}

interface ScenarioSelection {
  baseline: boolean;
  burst: boolean;
  rawThroughput: boolean;
  restart: boolean;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const depositAmount = parseFloatEnv(
    process.env.SNAP_DEVNET_RELAYER_DEPOSIT_AMOUNT,
    DEFAULT_SOL_DEPOSIT_AMOUNT,
  );
  const existingPoolAddress = parsePublicKeyEnv(
    process.env.SNAP_DEVNET_RELAYER_POOL_ADDRESS,
  );
  const allowFreshPool =
    process.env.SNAP_DEVNET_RELAYER_ALLOW_FRESH_POOL === "1";
  const relayerTargetLamports =
    parseFloatEnv(
      process.env.SNAP_DEVNET_RELAYER_TARGET_SOL,
      DEFAULT_RELAYER_TARGET_LAMPORTS / 1_000_000_000,
    ) * 1_000_000_000;
  const maxTotalLamports = parseIntegerEnv(
    process.env.SNAP_DEVNET_RELAYER_MAX_TOTAL_LAMPORTS,
    DEFAULT_MAX_TOTAL_LAMPORTS,
  );
  const allowContinueAfterBaselineFailure =
    process.env.SNAP_DEVNET_RELAYER_ALLOW_CONTINUE_AFTER_BASELINE_FAILURE === "1";
  const allowContinueAfterBurstFailure =
    process.env.SNAP_DEVNET_RELAYER_ALLOW_CONTINUE_AFTER_BURST_FAILURE === "1";
  const scenarios = loadScenarioSelection(
    process.env.SNAP_DEVNET_RELAYER_SCENARIOS,
  );
  const outputFiles = {
    burst:
      process.env.SNAP_DEVNET_RELAYER_BURST_OUTPUT_FILE ??
      DEFAULT_BURST_OUTPUT_FILE,
    notes:
      process.env.SNAP_DEVNET_RELAYER_NOTES_OUTPUT_FILE ??
      DEFAULT_NOTES_OUTPUT_FILE,
    restart:
      process.env.SNAP_DEVNET_RELAYER_RESTART_OUTPUT_FILE ??
      DEFAULT_RESTART_OUTPUT_FILE,
  };

  if (!existingPoolAddress && !allowFreshPool) {
    throw new Error(
      "Devnet relayer validation requires SNAP_DEVNET_RELAYER_POOL_ADDRESS by default. Set SNAP_DEVNET_RELAYER_ALLOW_FRESH_POOL=1 to create a fresh pool intentionally.",
    );
  }
  if (!scenarios.baseline && !scenarios.burst && !scenarios.rawThroughput && !scenarios.restart) {
    throw new Error("At least one relayer scenario must be selected.");
  }
  const context = createDevnetContext(rpcUrl, payerPath);

  try {
    const depositAmountLamports = Math.round(depositAmount * 1_000_000_000);
    const plannedRequestCount =
      (scenarios.baseline ? 1 : 0) +
      (scenarios.burst ? 12 : 0) +
      (scenarios.rawThroughput ? 12 : 0) +
      (scenarios.restart ? 1 : 0);
    const plannedDepositExposureLamports = depositAmountLamports * plannedRequestCount;
    if (plannedDepositExposureLamports > maxTotalLamports) {
      throw new Error(
        `Planned relayer validation spend ${plannedDepositExposureLamports} lamports exceeds guardrail ${maxTotalLamports}`,
      );
    }
    const requiredPayerLamports =
      relayerTargetLamports +
      plannedDepositExposureLamports +
      DEFAULT_PAYER_BUFFER_LAMPORTS;
    const payerBalanceBefore = await assertBalanceAtLeast(
      context.connection,
      context.payer.publicKey,
      requiredPayerLamports,
      "devnet relayer payer",
    );
    const noteJournal = initializePersistentNoteJournal(
      context,
      outputFiles.notes,
      "devnet relayer validation",
    );

    const burstArtifact: BurstValidationArtifact = {
      balances: {
        payer: {
          after: payerBalanceBefore,
          before: payerBalanceBefore,
          delta: 0,
        },
      },
      config: {
        defaultLimits: {
          global: 100,
          perIp: 10,
        },
        depositAmount,
        existingPool: existingPoolAddress?.toBase58() ?? null,
        maxTotalLamports,
        rawLimits: {
          global: 1_000,
          perIp: 1_000,
        },
        requiredPayerLamports,
      },
      metadata: buildMetadata(context),
      scenarios: [],
      stopReason: null,
    };

    if (scenarios.baseline) {
      const baselineScenario = await runRelayScenario(context, {
        concurrency: 1,
        depositAmount,
        existingPoolAddress,
        limits: burstArtifact.config.defaultLimits,
        maxTotalLamports,
        mode: "default-limits",
        noteJournal,
        noteOutputFile: outputFiles.notes,
        relayerTargetLamports,
      });
      burstArtifact.scenarios.push(baselineScenario);
      writeDevnetArtifact(outputFiles.burst, burstArtifact);

      if (
        !allowContinueAfterBaselineFailure &&
        shouldStopAfterBaselineFailure(baselineScenario)
      ) {
        const payerBalanceAfterStop = await context.connection.getBalance(
          context.payer.publicKey,
          "confirmed",
        );
        burstArtifact.balances.payer = {
          after: payerBalanceAfterStop,
          before: payerBalanceBefore,
          delta: payerBalanceAfterStop - payerBalanceBefore,
        };
        burstArtifact.stopReason =
          "Stopped after the single-request relayer baseline repeated the Phase 12C failure shape with no accepted request and at least one HTTP 502.";
        writeDevnetArtifact(outputFiles.burst, burstArtifact);
        console.log(JSON.stringify({ burstArtifact }, null, 2));
        return;
      }
    }

    if (scenarios.burst) {
      const burstScenario = await runRelayScenario(context, {
        concurrency: 12,
        depositAmount,
        existingPoolAddress,
        limits: burstArtifact.config.defaultLimits,
        maxTotalLamports,
        mode: "default-limits",
        noteJournal,
        noteOutputFile: outputFiles.notes,
        relayerTargetLamports,
      });
      burstArtifact.scenarios.push(burstScenario);
      writeDevnetArtifact(outputFiles.burst, burstArtifact);

      if (
        !allowContinueAfterBurstFailure &&
        shouldStopAfterBurstFailure(burstScenario)
      ) {
        const payerBalanceAfterStop = await context.connection.getBalance(
          context.payer.publicKey,
          "confirmed",
        );
        burstArtifact.balances.payer = {
          after: payerBalanceAfterStop,
          before: payerBalanceBefore,
          delta: payerBalanceAfterStop - payerBalanceBefore,
        };
        burstArtifact.stopReason =
          "Stopped after the default-limit burst repeated the bad control-plane behavior with HTTP 502 responses, so raw-throughput and restart were not worth additional spend.";
        writeDevnetArtifact(outputFiles.burst, burstArtifact);
        console.log(JSON.stringify({ burstArtifact }, null, 2));
        return;
      }
    }

    if (scenarios.rawThroughput) {
      burstArtifact.scenarios.push(
        await runRelayScenario(context, {
          concurrency: 12,
          depositAmount,
          existingPoolAddress,
          limits: burstArtifact.config.rawLimits,
          maxTotalLamports,
          mode: "raw-throughput",
          noteJournal,
          noteOutputFile: outputFiles.notes,
          relayerTargetLamports,
        }),
      );
      writeDevnetArtifact(outputFiles.burst, burstArtifact);
    }

    let restartArtifact: RestartValidationArtifact | null = null;
    if (scenarios.restart) {
      const restartPayerBalanceBefore = await context.connection.getBalance(
        context.payer.publicKey,
        "confirmed",
      );
      restartArtifact = await runRestartScenario(
        context,
        depositAmount,
        existingPoolAddress,
        noteJournal,
        outputFiles.notes,
        relayerTargetLamports,
      );
      const restartPayerBalanceAfter = await context.connection.getBalance(
        context.payer.publicKey,
        "confirmed",
      );
      restartArtifact.balances.payer = {
        after: restartPayerBalanceAfter,
        before: restartPayerBalanceBefore,
        delta: restartPayerBalanceAfter - restartPayerBalanceBefore,
      };
      writeDevnetArtifact(outputFiles.restart, restartArtifact);
    }

    const payerBalanceAfterSelectedScenarios = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    burstArtifact.balances.payer = {
      after: payerBalanceAfterSelectedScenarios,
      before: payerBalanceBefore,
      delta: payerBalanceAfterSelectedScenarios - payerBalanceBefore,
    };
    writeDevnetArtifact(outputFiles.burst, burstArtifact);

    console.log(
      JSON.stringify(
        restartArtifact === null ? { burstArtifact } : { burstArtifact, restartArtifact },
        null,
        2,
      ),
    );
  } finally {
    closeDevnetContext(context);
  }
}

async function runRelayScenario(
  context: ReturnType<typeof createDevnetContext>,
  options: {
    concurrency: number;
    depositAmount: number;
    existingPoolAddress: PublicKey | null;
    limits: {
      global: number;
      perIp: number;
    };
    maxTotalLamports: number;
    mode: RelayScenarioResult["mode"];
    noteJournal: ReturnType<typeof initializePersistentNoteJournal>;
    noteOutputFile: string;
    relayerTargetLamports: number;
  },
): Promise<RelayScenarioResult> {
  const pool =
    options.existingPoolAddress ??
    await context.snap.createPool(options.depositAmount, { treeDepth: 20 });
  if (!options.existingPoolAddress) {
    await prefundSolVaultForLowDenomination(
      context.connection,
      context.payer,
      pool,
      context.program.programId,
      Math.round(options.depositAmount * 1_000_000_000),
    );
  }
  const relayer = Keypair.generate();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-devnet-relayer-"));
  const dbPath = path.join(dbDir, "relayer.sqlite");
  const payerBalanceBefore = await context.connection.getBalance(
    context.payer.publicKey,
    "confirmed",
  );
  let payerBalanceAfter = payerBalanceBefore;
  let scenarioResult:
    | Omit<
        RelayScenarioResult,
        | "maxTotalLamports"
        | "noteJournalPath"
        | "payerBalanceAfter"
        | "payerBalanceBefore"
      >
    | null = null;
  let harness:
    | Awaited<ReturnType<typeof startRelayerHarness>>
    | undefined;
  const maxAcceptedRequests = Math.min(
    options.concurrency,
    options.limits.global,
    options.limits.perIp,
  );
  const requiredRelayerTargetLamports = await estimateRequiredRelayerTargetLamports(
    context.connection,
    maxAcceptedRequests,
  );

  try {
    if (options.relayerTargetLamports < requiredRelayerTargetLamports) {
      throw new Error(
        `Configured relayer target ${options.relayerTargetLamports} lamports is insufficient for up to ${maxAcceptedRequests} accepted requests; requires at least ${requiredRelayerTargetLamports} lamports`,
      );
    }
    await ensureRelayerBalance(
      context.connection,
      context.payer,
      relayer.publicKey,
      options.relayerTargetLamports,
    );
    harness = await startRelayerHarness({
      cluster: "devnet",
      connection: context.connection,
      dbPath,
      maxRequestsPerMinuteGlobal: options.limits.global,
      maxRequestsPerMinutePerIp: options.limits.perIp,
      minFeeLamports: 10_000,
      pool,
      relayer,
      retryBackoffMs: [1_000, 3_000, 8_000],
      retryPollIntervalMs: 1_000,
    });

    const notes = [];
    for (let index = 0; index < options.concurrency; index += 1) {
      const deposit = await depositWithSignature(context, pool, options.depositAmount);
      recordDevnetNote(options.noteJournal, deposit.note, {
        amount: options.depositAmount,
        assetType: "sol",
        depositSignature: deposit.signature,
        stage: `${options.mode}-c${options.concurrency}`,
      });
      persistDevnetNoteJournal(options.noteOutputFile, options.noteJournal);
      notes.push(deposit.note);
    }

    const poolState = await fetchPoolState(
      context.program,
      context.connection,
      pool,
    );
    const signedRequests = await Promise.all(
      notes.map((note) =>
        createSignedRelayRequest(
          pool,
          note,
          poolState,
          context.payer.publicKey,
          calculateFee(poolState.depositAmountRaw, 50, 10_000),
          context.payer,
        ),
      ),
    );

    const startedAt = Date.now();
    const responses = await Promise.all(
      signedRequests.map(async (request) => {
        const requestStartedAt = Date.now();
        const response = await withDevnetRetry("relayer-post", () =>
          postJson(`${harness!.baseUrl}/relay`, request),
        );
        return {
          latencyMs: Date.now() - requestStartedAt,
          request,
          response: response.result,
        };
      }),
    );
    const scenarioDurationMs = Date.now() - startedAt;
    const accepted = responses.filter((entry) => entry.response.status === 200);
    responses.forEach((entry, index) => {
      const signature = entry.response.body.txSignature;
      if (entry.response.status === 200 && typeof signature === "string") {
        markDevnetNoteWithdrawn(options.noteJournal, notes[index], signature);
      }
    });
    persistDevnetNoteJournal(options.noteOutputFile, options.noteJournal);
    const requestOutcomes = responses.map((entry, index) => {
      const persistedRecord = harness!.store.getByNullifier(
        entry.request.payload.nullifierHash,
      );
      const noteRecord = options.noteJournal.notes.find(
        (candidate) =>
          candidate.depositIndex === notes[index].depositIndex &&
          candidate.nullifierHash === entry.request.payload.nullifierHash &&
          candidate.pool === notes[index].poolAddress,
      );

      return {
        note: {
          amount: options.depositAmount,
          assetType: "sol" as const,
          depositIndex: notes[index].depositIndex,
          depositSignature: noteRecord?.depositSignature ?? null,
          nullifierHash: entry.request.payload.nullifierHash,
          pool: notes[index].poolAddress,
        },
        noteStateAtScenarioEnd: {
          depositState: noteRecord?.depositState ?? "confirmed",
          withdrawalSignature: noteRecord?.withdrawalSignature ?? null,
          withdrawn: noteRecord?.withdrawn ?? false,
        },
        persistedRelayRecord: toRelayRecordSnapshot(persistedRecord),
        requestIndex: index,
        stage: `${options.mode}-c${options.concurrency}`,
        surfaced: {
          classification: classifyRelayResponse(entry.response.status),
          error:
            typeof entry.response.body?.error === "string"
              ? entry.response.body.error
              : null,
          httpStatus: entry.response.status,
          retryAfterSeconds: parseRetryAfterSeconds(entry.response.headers),
          txSignature:
            typeof entry.response.body?.txSignature === "string"
              ? entry.response.body.txSignature
              : null,
        },
      };
    });
    const records = requestOutcomes
      .map((entry) => entry.persistedRelayRecord)
      .filter((record): record is NonNullable<typeof record> => record !== null);
    const submissionLatencies = records
      .filter((record) => record.submittedAt !== null)
      .map((record) => (record.submittedAt as number) - record.receivedAt);
    const confirmationLatencies = records
      .filter((record) => record.submittedAt !== null)
      .map((record) => record.updatedAt - (record.submittedAt as number));

    scenarioResult = {
      acceptanceRate: options.concurrency === 0 ? 0 : accepted.length / options.concurrency,
      accepted: accepted.length,
      attempted: options.concurrency,
      averageConfirmationLatencyMs: average(confirmationLatencies),
      averageRequestLatencyMs: round(
        responses.reduce((total, entry) => total + entry.latencyMs, 0) /
          responses.length,
      ),
      averageSubmissionLatencyMs: average(submissionLatencies),
      concurrency: options.concurrency,
      httpStatuses: countStatuses(responses.map((entry) => entry.response.status)),
      maxAcceptedRequests,
      mode: options.mode,
      rejected: responses.length - accepted.length,
      relayerTargetLamports: options.relayerTargetLamports,
      relayerConfig: {
        maxRequestsPerMinuteGlobal: options.limits.global,
        maxRequestsPerMinutePerIp: options.limits.perIp,
        minFeeLamports: 10_000,
        retryBackoffMs: [1_000, 3_000, 8_000],
        retryPollIntervalMs: 1_000,
      },
      pool: pool.toBase58(),
      rateLimited: responses.filter((entry) => entry.response.status === 429).length,
      relayRecordStatuses: countStatuses(records.map((record) => record.status)),
      requests: requestOutcomes,
      relayer: relayer.publicKey.toBase58(),
      requiredRelayerTargetLamports,
      requestTps:
        scenarioDurationMs <= 0 ? 0 : round((accepted.length * 1_000) / scenarioDurationMs),
      retryAfterSeconds: responses
        .map((entry) => entry.response.headers.get("retry-after"))
        .flatMap((value) => (value === null ? [] : [Number(value)])),
      txSignatures: accepted
        .map((entry) => entry.response.body.txSignature)
        .filter((value): value is string => typeof value === "string"),
    };
  } finally {
    await stopRelayerHarness(harness);
    await drainRelayerBalance(
      context.connection,
      relayer,
      context.payer.publicKey,
      0,
      context.payer,
    ).catch(() => undefined);
    payerBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    fs.rmSync(dbDir, { recursive: true, force: true });
  }

  if (scenarioResult === null) {
    throw new Error("Relayer scenario did not produce a result");
  }

  return {
    ...scenarioResult,
    maxTotalLamports: options.maxTotalLamports,
    noteJournalPath: path.resolve("devnet-results", options.noteOutputFile),
    payerBalanceAfter,
    payerBalanceBefore,
  };
}

async function runRestartScenario(
  context: ReturnType<typeof createDevnetContext>,
  depositAmount: number,
  existingPoolAddress: PublicKey | null,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  noteOutputFile: string,
  relayerTargetLamports: number,
): Promise<RestartValidationArtifact> {
  const pool =
    existingPoolAddress ??
    await context.snap.createPool(depositAmount, { treeDepth: 20 });
  if (!existingPoolAddress) {
    await prefundSolVaultForLowDenomination(
      context.connection,
      context.payer,
      pool,
      context.program.programId,
      Math.round(depositAmount * 1_000_000_000),
    );
  }
  const relayer = Keypair.generate();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-devnet-relayer-restart-"));
  const dbPath = path.join(dbDir, "relayer.sqlite");
  let harness:
    | Awaited<ReturnType<typeof startRelayerHarness>>
    | undefined;

  try {
    await ensureRelayerBalance(
      context.connection,
      context.payer,
      relayer.publicKey,
      relayerTargetLamports,
    );
    harness = await startRelayerHarness({
      cluster: "devnet",
      connection: context.connection,
      dbPath,
      pool,
      relayer,
      retryBackoffMs: [1_000, 3_000, 8_000],
      retryPollIntervalMs: 1_000,
    });

    const deposit = await depositWithSignature(context, pool, depositAmount);
    recordDevnetNote(noteJournal, deposit.note, {
      amount: depositAmount,
      assetType: "sol",
      depositSignature: deposit.signature,
      stage: "restart",
    });
    persistDevnetNoteJournal(noteOutputFile, noteJournal);
    const poolState = await fetchPoolState(
      context.program,
      context.connection,
      pool,
    );
    const signedRequest = await createSignedRelayRequest(
      pool,
      deposit.note,
      poolState,
      context.payer.publicKey,
      calculateFee(poolState.depositAmountRaw, 50, 10_000),
      context.payer,
    );
    const recordId = harness.store.insert(
      {
        clientIp: "127.0.0.1",
        fee: signedRequest.payload.fee,
        nullifierHash: signedRequest.payload.nullifierHash,
        pool: pool.toBase58(),
        receivedAt: Date.now(),
      },
      JSON.stringify(signedRequest),
    );

    await harness.service.processRecord(harness.store.get(recordId)!);
    const beforeRestart = harness.store.get(recordId) ?? null;

    await stopRelayerHarness(harness);
    harness = await startRelayerHarness({
      cluster: "devnet",
      connection: context.connection,
      dbPath,
      pool,
      relayer,
      retryBackoffMs: [1_000, 3_000, 8_000],
      retryPollIntervalMs: 1_000,
    });

    await waitForCondition(async () => {
      const record = harness?.store.get(recordId);
      return record?.status === "confirmed" || record?.status === "failed" || record?.status === "expired";
    }, 180_000, 1_000);

    const afterRestart = harness.store.get(recordId) ?? null;
    if (afterRestart?.status === "confirmed") {
      markDevnetNoteWithdrawn(
        noteJournal,
        deposit.note,
        afterRestart.txSignature ?? null,
      );
      persistDevnetNoteJournal(noteOutputFile, noteJournal);
    }

    return {
      balances: {
        payer: {
          after: 0,
          before: 0,
          delta: 0,
        },
      },
      metadata: buildMetadata(context),
      note: {
        depositIndex: deposit.note.depositIndex,
        nullifierHash: signedRequest.payload.nullifierHash,
      },
      pool: pool.toBase58(),
      recordId,
      relayer: relayer.publicKey.toBase58(),
      requestMode: "persisted-signed-request",
      status: {
        afterRestart: afterRestart?.status ?? null,
        beforeRestart: beforeRestart?.status ?? null,
      },
      timings: {
        confirmationLatencyMs:
          afterRestart?.submittedAt === undefined
            ? null
            : afterRestart.updatedAt - afterRestart.submittedAt,
        submittedLatencyMs:
          beforeRestart === null || beforeRestart.submittedAt === undefined
            ? null
            : beforeRestart.submittedAt - beforeRestart.receivedAt,
      },
      txSignature: afterRestart?.txSignature ?? beforeRestart?.txSignature ?? null,
    };
  } finally {
    await stopRelayerHarness(harness);
    await drainRelayerBalance(
      context.connection,
      relayer,
      context.payer.publicKey,
      0,
      context.payer,
    ).catch(() => undefined);
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

function countStatuses(values: Array<number | string>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function toRelayRecordSnapshot(
  record:
    | {
        clientIp: string;
        error?: string;
        id: string;
        lastValidBlockHeight?: number;
        nextAttemptAt: number;
        receivedAt: number;
        retries: number;
        status: string;
        submittedAt?: number;
        txSignature?: string;
        updatedAt: number;
      }
    | null,
): RelayRecordSnapshot | null {
  if (!record) {
    return null;
  }

  return {
    clientIp: record.clientIp,
    error: record.error ?? null,
    id: record.id,
    lastValidBlockHeight: record.lastValidBlockHeight ?? null,
    nextAttemptAt: record.nextAttemptAt,
    receivedAt: record.receivedAt,
    retries: record.retries,
    status: record.status,
    submittedAt: record.submittedAt ?? null,
    txSignature: record.txSignature ?? null,
    updatedAt: record.updatedAt,
  };
}

function classifyRelayResponse(
  httpStatus: number,
): RelayRequestOutcome["surfaced"]["classification"] {
  if (httpStatus === 200) {
    return "success";
  }

  if (httpStatus === 429) {
    return "rate-limited";
  }

  if (httpStatus >= 500) {
    return "relay-failure";
  }

  return "unexpected";
}

function parseRetryAfterSeconds(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function estimateRequiredRelayerTargetLamports(
  connection: ReturnType<typeof createDevnetContext>["connection"],
  maxAcceptedRequests: number,
): Promise<number> {
  const nullifierRecordRentLamports =
    await connection.getMinimumBalanceForRentExemption(NULLIFIER_RECORD_SIZE_BYTES);

  return maxAcceptedRequests * (nullifierRecordRentLamports + RELAYER_TX_FEE_RESERVE_LAMPORTS);
}

function calculateFee(
  withdrawAmountLamports: number,
  feeBps: number,
  minFeeLamports: number,
): number {
  return Math.max(Math.floor((withdrawAmountLamports * feeBps) / 10_000), minFeeLamports);
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

function loadScenarioSelection(value: string | undefined): ScenarioSelection {
  if (!value) {
    return {
      baseline: true,
      burst: true,
      rawThroughput: true,
      restart: true,
    };
  }

  const tokens = new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );

  return {
    baseline: tokens.has("baseline") || tokens.has("n1"),
    burst: tokens.has("burst") || tokens.has("default-burst"),
    rawThroughput: tokens.has("raw") || tokens.has("raw-throughput"),
    restart: tokens.has("restart") || tokens.has("persistence"),
  };
}

function shouldStopAfterBaselineFailure(scenario: RelayScenarioResult): boolean {
  return scenario.accepted === 0 && (scenario.httpStatuses["502"] ?? 0) > 0;
}

function shouldStopAfterBurstFailure(scenario: RelayScenarioResult): boolean {
  return (scenario.httpStatuses["502"] ?? 0) > 0;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
