import fs from "fs";
import os from "os";
import path from "path";
import {
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { signRelayerWithdrawRequest } from "../sdk-package/src/relayer-auth";
import { bytesToHex } from "../sdk-package/src/commitment";
import { deriveNullifierRecordPda } from "../tests/helpers";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  type DevnetNoteJournal,
  fetchSignatureDetails,
  initializePersistentNoteJournal,
  markDevnetNoteDeposited,
  markDevnetNoteWithdrawn,
  persistDevnetNoteJournal,
  prefundSolVaultForLowDenomination,
  recordPlannedDevnetNote,
  round,
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
import { waitForNewSignature } from "./relayer-harness";

const DEFAULT_POOL = "7YFJ8rTYZcFyDTeGwre54pmY96b4DW6Zi3kGHgirC4WT";
const DEFAULT_RELAYER_TARGET_LAMPORTS = 15_000_000;
const DEFAULT_MAX_TOTAL_LAMPORTS = 1_300_000;
const DEFAULT_PAYER_BUFFER_LAMPORTS = 5_000_000;
const DEFAULT_BURST_CONCURRENCY = 10;
const DEFAULT_BURST_OUTPUT_FILE = "phase13b-relayer-validation.json";
const DEFAULT_NOTES_OUTPUT_FILE = "phase13b-relayer-notes.json";
const NULLIFIER_RECORD_SIZE_BYTES = 8 + 32 + 32 + 8;
const RELAYER_TX_FEE_RESERVE_LAMPORTS = 20_000;
const STALE_REQUEST_AGE_MS = 61_000;

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
  mode: "default-limits";
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

interface Phase13bRelayerArtifact {
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
    maxTotalLamports: number;
    pool: string;
    relayerTargetLamports: number;
    requiredPayerLamports: number;
  };
  metadata: ReturnType<typeof buildMetadata>;
  replay: {
    exactSameSignedRequest: true;
    expectedStatus: 409;
    matchedExpectation: boolean;
    response: {
      body: unknown;
      status: number;
    };
  } | null;
  scenarios: RelayScenarioResult[];
  stale: {
    matchedExpectation: boolean;
    noteSpentBeforeRecovery: boolean;
    response: {
      body: unknown;
      status: number;
    };
  } | null;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const pool = new PublicKey(process.env.SNAP_PHASE13B_RELAYER_POOL_ADDRESS ?? DEFAULT_POOL);
  const relayerTargetLamports = parseIntegerEnv(
    process.env.SNAP_PHASE13B_RELAYER_TARGET_LAMPORTS,
    DEFAULT_RELAYER_TARGET_LAMPORTS,
  );
  const maxTotalLamports = parseIntegerEnv(
    process.env.SNAP_PHASE13B_RELAYER_MAX_TOTAL_LAMPORTS,
    DEFAULT_MAX_TOTAL_LAMPORTS,
  );
  const artifactOutputFile =
    process.env.SNAP_PHASE13B_RELAYER_OUTPUT_FILE ?? DEFAULT_BURST_OUTPUT_FILE;
  const noteOutputFile =
    process.env.SNAP_PHASE13B_RELAYER_NOTES_FILE ?? DEFAULT_NOTES_OUTPUT_FILE;

  const context = createDevnetContext(rpcUrl, payerPath);
  try {
    const poolInfo = await context.snap.getPoolInfo(pool);
    if (poolInfo.assetType !== "sol") {
      throw new Error("Phase 13B relayer validation only supports a SOL pool");
    }

    if (!process.env.SNAP_PHASE13B_RELAYER_POOL_ADDRESS) {
      await prefundSolVaultForLowDenomination(
        context.connection,
        context.payer,
        pool,
        context.program.programId,
        poolInfo.depositAmountRaw,
      );
    }

    const plannedDepositExposureLamports =
      poolInfo.depositAmountRaw * (DEFAULT_BURST_CONCURRENCY + 2);
    if (plannedDepositExposureLamports > maxTotalLamports) {
      throw new Error(
        `Planned relayer validation exposure ${plannedDepositExposureLamports} lamports exceeds ${maxTotalLamports}`,
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
      "phase13b relayer payer",
    );
    const noteJournal = loadOrInitializeNoteJournal(
      context,
      noteOutputFile,
      "phase13b relayer validation",
    );
    const artifact: Phase13bRelayerArtifact = {
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
        depositAmount: poolInfo.depositAmount,
        maxTotalLamports,
        pool: pool.toBase58(),
        relayerTargetLamports,
        requiredPayerLamports,
      },
      metadata: buildMetadata(context),
      replay: null,
      scenarios: [],
      stale: null,
    };

    const baselineFlow = await runBaselineReplayAndStaleFlow(
      context,
      noteJournal,
      noteOutputFile,
      pool,
      poolInfo.depositAmount,
      relayerTargetLamports,
    );
    artifact.scenarios.push(baselineFlow.baseline);
    artifact.replay = baselineFlow.replay;
    artifact.stale = baselineFlow.stale;
    persistDevnetNoteJournal(noteOutputFile, noteJournal);
    writeDevnetArtifact(artifactOutputFile, artifact);

    if (
      artifact.scenarios[0].accepted !== 1 ||
      !artifact.replay.matchedExpectation ||
      !artifact.stale.matchedExpectation
    ) {
      throw new Error(
        "Phase 13B relayer baseline, replay, or stale-request validation did not match expectations; stopped before the burst.",
      );
    }

    const burst = await runBurstScenario(
      context,
      noteJournal,
      noteOutputFile,
      pool,
      poolInfo.depositAmount,
      relayerTargetLamports,
      maxTotalLamports,
    );
    artifact.scenarios.push(burst);
    persistDevnetNoteJournal(noteOutputFile, noteJournal);

    const payerBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    artifact.balances.payer = {
      after: payerBalanceAfter,
      before: payerBalanceBefore,
      delta: payerBalanceAfter - payerBalanceBefore,
    };

    writeDevnetArtifact(artifactOutputFile, artifact);
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeDevnetContext(context);
  }
}

async function runBaselineReplayAndStaleFlow(
  context: ReturnType<typeof createDevnetContext>,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  noteOutputFile: string,
  pool: PublicKey,
  depositAmount: number,
  relayerTargetLamports: number,
): Promise<{
  baseline: RelayScenarioResult;
  replay: NonNullable<Phase13bRelayerArtifact["replay"]>;
  stale: NonNullable<Phase13bRelayerArtifact["stale"]>;
}> {
  const relayer = Keypair.generate();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-phase13b-relayer-baseline-"));
  const dbPath = path.join(dbDir, "relayer.sqlite");
  let harness: Awaited<ReturnType<typeof startRelayerHarness>> | undefined;

  try {
    const requiredRelayerTargetLamports = await estimateRequiredRelayerTargetLamports(
      context.connection,
      1,
    );
    if (relayerTargetLamports < requiredRelayerTargetLamports) {
      throw new Error(
        `Relayer target ${relayerTargetLamports} lamports is below the required baseline floor ${requiredRelayerTargetLamports}`,
      );
    }

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
      maxRequestsPerMinuteGlobal: 100,
      maxRequestsPerMinutePerIp: 10,
      minFeeLamports: 10_000,
      pool,
      relayer,
      retryBackoffMs: [1_000, 3_000, 8_000],
      retryPollIntervalMs: 1_000,
    });

    const baselineNote = await journaledDeposit(
      context,
      noteJournal,
      noteOutputFile,
      pool,
      depositAmount,
      "default-limits-c1",
    );
    const baselinePoolState = await fetchPoolState(
      context.program,
      context.connection,
      pool,
    );
    const baselineRequest = await createSignedRelayRequest(
      pool,
      baselineNote.note,
      baselinePoolState,
      context.payer.publicKey,
      calculateFee(baselinePoolState.depositAmountRaw, 50, 10_000),
      context.payer,
    );
    const baselineStartedAt = Date.now();
    const baselineResponse = await withDevnetRetry("phase13b-relayer-baseline", () =>
      postJson(`${harness.baseUrl}/relay`, baselineRequest),
    );
    if (
      baselineResponse.result.status === 200 &&
      typeof baselineResponse.result.body?.txSignature === "string"
    ) {
      markDevnetNoteWithdrawn(
        noteJournal,
        baselineNote.note,
        baselineResponse.result.body.txSignature,
      );
      persistDevnetNoteJournal(noteOutputFile, noteJournal);
    }

    const baseline = buildScenarioResult({
      concurrency: 1,
      context,
      depositAmount,
      maxTotalLamports: depositAmount * 1_000_000_000,
      noteJournal,
      noteOutputFile,
      pool,
      relayer: relayer.publicKey,
      relayerTargetLamports,
      requestEntries: [
        {
          elapsedMs: Date.now() - baselineStartedAt,
          note: baselineNote.note,
          request: baselineRequest,
          response: baselineResponse.result,
          stage: "default-limits-c1",
        },
      ],
      requiredRelayerTargetLamports,
    });

    const replayResponse = await postJson(`${harness.baseUrl}/relay`, baselineRequest);

    const staleNote = await journaledDeposit(
      context,
      noteJournal,
      noteOutputFile,
      pool,
      depositAmount,
      "phase13b-stale",
    );
    const stalePoolState = await fetchPoolState(
      context.program,
      context.connection,
      pool,
    );
    const freshStaleRequest = await createSignedRelayRequest(
      pool,
      staleNote.note,
      stalePoolState,
      context.payer.publicKey,
      calculateFee(stalePoolState.depositAmountRaw, 50, 10_000),
      context.payer,
    );
    const staleRequest = signRelayerWithdrawRequest(
      freshStaleRequest.payload,
      context.payer.secretKey.slice(0, 32),
      Date.now() - STALE_REQUEST_AGE_MS,
    );
    const staleResponse = await postJson(`${harness.baseUrl}/relay`, staleRequest);

    return {
      baseline,
      replay: {
        exactSameSignedRequest: true,
        expectedStatus: 409,
        matchedExpectation: replayResponse.status === 409,
        response: {
          body: replayResponse.body,
          status: replayResponse.status,
        },
      },
      stale: {
        matchedExpectation:
          staleResponse.status === 401 &&
          !(await isNullifierRecorded(
            context,
            pool,
            Uint8Array.from(Buffer.from(bytesToHex(staleNote.note.nullifierHash), "hex")),
          )),
        noteSpentBeforeRecovery: await isNullifierRecorded(
          context,
          pool,
          staleNote.note.nullifierHash,
        ),
        response: {
          body: staleResponse.body,
          status: staleResponse.status,
        },
      },
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
    fs.rmSync(dbDir, { force: true, recursive: true });
  }
}

async function runBurstScenario(
  context: ReturnType<typeof createDevnetContext>,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  noteOutputFile: string,
  pool: PublicKey,
  depositAmount: number,
  relayerTargetLamports: number,
  maxTotalLamports: number,
): Promise<RelayScenarioResult> {
  const relayer = Keypair.generate();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-phase13b-relayer-burst-"));
  const dbPath = path.join(dbDir, "relayer.sqlite");
  let harness: Awaited<ReturnType<typeof startRelayerHarness>> | undefined;

  try {
    const requiredRelayerTargetLamports = await estimateRequiredRelayerTargetLamports(
      context.connection,
      DEFAULT_BURST_CONCURRENCY,
    );
    if (relayerTargetLamports < requiredRelayerTargetLamports) {
      throw new Error(
        `Relayer target ${relayerTargetLamports} lamports is below the required burst floor ${requiredRelayerTargetLamports}`,
      );
    }

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
      maxRequestsPerMinuteGlobal: 100,
      maxRequestsPerMinutePerIp: 10,
      minFeeLamports: 10_000,
      pool,
      relayer,
      retryBackoffMs: [1_000, 3_000, 8_000],
      retryPollIntervalMs: 1_000,
    });

    const notes = [];
    for (let index = 0; index < DEFAULT_BURST_CONCURRENCY; index += 1) {
      notes.push(
        await journaledDeposit(
          context,
          noteJournal,
          noteOutputFile,
          pool,
          depositAmount,
          "default-limits-c10",
        ),
      );
    }

    const poolState = await fetchPoolState(context.program, context.connection, pool);
    const signedRequests = await Promise.all(
      notes.map((entry) =>
        createSignedRelayRequest(
          pool,
          entry.note,
          poolState,
          context.payer.publicKey,
          calculateFee(poolState.depositAmountRaw, 50, 10_000),
          context.payer,
        ),
      ),
    );

    const startedAt = Date.now();
    const responses = await Promise.all(
      signedRequests.map(async (request, index) => {
        const requestStartedAt = Date.now();
        const response = await withDevnetRetry("phase13b-relayer-burst", () =>
          postJson(`${harness!.baseUrl}/relay`, request),
        );
        if (
          response.result.status === 200 &&
          typeof response.result.body?.txSignature === "string"
        ) {
          markDevnetNoteWithdrawn(
            noteJournal,
            notes[index].note,
            response.result.body.txSignature,
          );
        }
        return {
          elapsedMs: Date.now() - requestStartedAt,
          note: notes[index].note,
          request,
          response: response.result,
          stage: "default-limits-c10" as const,
        };
      }),
    );
    persistDevnetNoteJournal(noteOutputFile, noteJournal);

    return buildScenarioResult({
      concurrency: DEFAULT_BURST_CONCURRENCY,
      context,
      depositAmount,
      maxTotalLamports,
      noteJournal,
      noteOutputFile,
      pool,
      relayer: relayer.publicKey,
      relayerTargetLamports,
      requestEntries: responses,
      requiredRelayerTargetLamports,
      scenarioDurationMs: Date.now() - startedAt,
    });
  } finally {
    await stopRelayerHarness(harness);
    await drainRelayerBalance(
      context.connection,
      relayer,
      context.payer.publicKey,
      0,
      context.payer,
    ).catch(() => undefined);
    fs.rmSync(dbDir, { force: true, recursive: true });
  }
}

function buildScenarioResult(args: {
  concurrency: number;
  context: ReturnType<typeof createDevnetContext>;
  depositAmount: number;
  maxTotalLamports: number;
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>;
  noteOutputFile: string;
  pool: PublicKey;
  relayer: PublicKey;
  relayerTargetLamports: number;
  requestEntries: Array<{
    elapsedMs: number;
    note: Awaited<ReturnType<typeof journaledDeposit>>["note"];
    request: Awaited<ReturnType<typeof createSignedRelayRequest>>;
    response: Awaited<ReturnType<typeof postJson>>;
    stage: string;
  }>;
  requiredRelayerTargetLamports: number;
  scenarioDurationMs?: number;
}): RelayScenarioResult {
  const records = args.requestEntries.map((entry, index) => {
    const noteRecord = args.noteJournal.notes.find(
      (candidate) =>
        candidate.depositIndex === entry.note.depositIndex &&
        candidate.nullifierHash === entry.request.payload.nullifierHash &&
        candidate.pool === entry.note.poolAddress,
    );

    return {
      note: {
        amount: args.depositAmount,
        assetType: "sol" as const,
        depositIndex: entry.note.depositIndex,
        depositSignature: noteRecord?.depositSignature ?? null,
        nullifierHash: entry.request.payload.nullifierHash,
        pool: entry.note.poolAddress,
      },
      noteStateAtScenarioEnd: {
        depositState: noteRecord?.depositState ?? "confirmed",
        withdrawalSignature: noteRecord?.withdrawalSignature ?? null,
        withdrawn: noteRecord?.withdrawn ?? false,
      },
      persistedRelayRecord: null,
      requestIndex: index,
      stage: entry.stage,
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
    } satisfies RelayRequestOutcome;
  });
  const accepted = records.filter((entry) => entry.surfaced.httpStatus === 200);
  const scenarioDurationMs =
    args.scenarioDurationMs ??
    args.requestEntries.reduce((max, entry) => Math.max(max, entry.elapsedMs), 0);

  return {
    acceptanceRate:
      args.concurrency === 0 ? 0 : accepted.length / args.concurrency,
    accepted: accepted.length,
    attempted: args.concurrency,
    averageConfirmationLatencyMs: null,
    averageRequestLatencyMs:
      args.requestEntries.length === 0
        ? 0
        : round(
            args.requestEntries.reduce((total, entry) => total + entry.elapsedMs, 0) /
              args.requestEntries.length,
          ),
    averageSubmissionLatencyMs: null,
    concurrency: args.concurrency,
    httpStatuses: countStatuses(records.map((entry) => entry.surfaced.httpStatus)),
    maxAcceptedRequests: args.concurrency,
    maxTotalLamports: args.maxTotalLamports,
    mode: "default-limits",
    noteJournalPath: path.resolve("devnet-results", args.noteOutputFile),
    payerBalanceAfter: 0,
    payerBalanceBefore: 0,
    pool: args.pool.toBase58(),
    rateLimited: records.filter((entry) => entry.surfaced.httpStatus === 429).length,
    rejected: args.requestEntries.length - accepted.length,
    relayerTargetLamports: args.relayerTargetLamports,
    relayerConfig: {
      maxRequestsPerMinuteGlobal: 100,
      maxRequestsPerMinutePerIp: 10,
      minFeeLamports: 10_000,
      retryBackoffMs: [1_000, 3_000, 8_000],
      retryPollIntervalMs: 1_000,
    },
    relayRecordStatuses: {},
    requests: records,
    relayer: args.relayer.toBase58(),
    requiredRelayerTargetLamports: args.requiredRelayerTargetLamports,
    requestTps:
      scenarioDurationMs <= 0
        ? 0
        : round((accepted.length * 1_000) / scenarioDurationMs),
    retryAfterSeconds: args.requestEntries
      .map((entry) => entry.response.headers.get("retry-after"))
      .flatMap((value) => (value === null ? [] : [Number(value)])),
    txSignatures: accepted
      .map((entry) => entry.surfaced.txSignature)
      .filter((value): value is string => typeof value === "string"),
  };
}

async function journaledDeposit(
  context: ReturnType<typeof createDevnetContext>,
  noteJournal: DevnetNoteJournal,
  noteOutputFile: string,
  pool: PublicKey,
  depositAmount: number,
  stage: string,
): Promise<{
  note: Awaited<ReturnType<typeof context.snap.deposit>>;
  signature: string;
}> {
  const seen = new Set(
    (
      await context.connection.getSignaturesForAddress(
        context.payer.publicKey,
        { limit: 20 },
        "confirmed",
      )
    ).map((entry) => entry.signature),
  );
  const { result: note } = await withDevnetRetry("phase13b-relayer-deposit", () =>
    context.snap.deposit(pool, depositAmount),
  );
  recordPlannedDevnetNote(noteJournal, note, {
    amount: depositAmount,
    assetType: "sol",
    stage,
  });
  persistDevnetNoteJournal(noteOutputFile, noteJournal);

  const signature = await waitForNewSignature(
    context.connection,
    context.payer.publicKey,
    seen,
    "phase13b relayer deposit",
    60_000,
  );
  markDevnetNoteDeposited(noteJournal, note, signature);
  persistDevnetNoteJournal(noteOutputFile, noteJournal);
  await fetchSignatureDetails(context.connection, signature);

  return {
    note,
    signature,
  };
}

function loadOrInitializeNoteJournal(
  context: ReturnType<typeof createDevnetContext>,
  fileName: string,
  runnerName: string,
): DevnetNoteJournal {
  const journalPath = path.resolve("devnet-results", fileName);
  if (!fs.existsSync(journalPath)) {
    return initializePersistentNoteJournal(context, fileName, runnerName);
  }

  const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8")) as DevnetNoteJournal;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.notes)) {
    throw new Error(`Invalid existing note journal: ${journalPath}`);
  }

  return parsed;
}

async function estimateRequiredRelayerTargetLamports(
  connection: ReturnType<typeof createDevnetContext>["connection"],
  maxAcceptedRequests: number,
): Promise<number> {
  const nullifierRecordRentLamports =
    await connection.getMinimumBalanceForRentExemption(NULLIFIER_RECORD_SIZE_BYTES);
  return maxAcceptedRequests * (nullifierRecordRentLamports + RELAYER_TX_FEE_RESERVE_LAMPORTS);
}

async function isNullifierRecorded(
  context: ReturnType<typeof createDevnetContext>,
  pool: PublicKey,
  nullifierHash: Uint8Array,
): Promise<boolean> {
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
    nullifierHash,
    context.program.programId,
  );
  return (
    (await context.connection.getAccountInfo(nullifierRecord, "confirmed")) !== null
  );
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

function calculateFee(
  withdrawAmountLamports: number,
  feeBps: number,
  minFeeLamports: number,
): number {
  return Math.max(Math.floor((withdrawAmountLamports * feeBps) / 10_000), minFeeLamports);
}

function countStatuses(values: Array<number | string>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }

  return parsed;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
