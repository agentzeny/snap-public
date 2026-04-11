import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  buildArtifactHeader,
  buildSolDepositAttempts,
  calculateTps,
  closeStressContext,
  createNotesForPool,
  createRelayer,
  createSignedRelayRequest,
  createSolPool,
  createStressContext,
  disposeRelayer,
  executeOperationBatch,
  fetchPoolState,
  makeAgentWallets,
  postJson,
  requestAirdrops,
  round,
  snapshotMemory,
  writeArtifact,
} from "./shared";

const CONCURRENCY_LEVELS = [1, 5, 10, 20] as const;
const DEPOSIT_AMOUNT_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;
const RECIPIENT_AIRDROP_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
const TREE_DEPTH = 20 as const;

interface RelayerScenarioResult {
  acceptanceRate: number;
  attempted: number;
  averageConfirmationLatencyMs: number | null;
  averageRequestLatencyMs: number;
  averageSubmissionLatencyMs: number | null;
  concurrency: number;
  confirmed: number;
  httpStatuses: Record<string, number>;
  memoryAfter: ReturnType<typeof snapshotMemory>;
  memoryBefore: ReturnType<typeof snapshotMemory>;
  mode: "default-limits" | "raw-throughput";
  rateLimited: number;
  relayRecordStatuses: Record<string, number>;
  requestTps: number;
  retryAfterSeconds: number[];
  sqliteWritesPerSecond: number;
  txSignatures: string[];
}

interface RelayerThroughputArtifact {
  config: {
    concurrencyLevels: number[];
    defaultLimits: {
      global: number;
      perIp: number;
    };
    depositAmountLamports: number;
    rawLimits: {
      global: number;
      perIp: number;
    };
    treeDepth: number;
  };
  metadata: ReturnType<typeof buildArtifactHeader>;
  results: RelayerScenarioResult[];
}

export async function runRelayerThroughputStressTest(): Promise<RelayerThroughputArtifact> {
  const context = createStressContext();
  try {
    const artifact: RelayerThroughputArtifact = {
      config: {
        concurrencyLevels: [...CONCURRENCY_LEVELS],
        defaultLimits: {
          global: 100,
          perIp: 10,
        },
        depositAmountLamports: DEPOSIT_AMOUNT_LAMPORTS,
        rawLimits: {
          global: 1_000,
          perIp: 1_000,
        },
        treeDepth: TREE_DEPTH,
      },
      metadata: buildArtifactHeader(context),
      results: [],
    };

    for (const concurrency of CONCURRENCY_LEVELS) {
      artifact.results.push(
        await runScenario(context, concurrency, "raw-throughput", {
          global: artifact.config.rawLimits.global,
          perIp: artifact.config.rawLimits.perIp,
        }),
      );
      writeArtifact("relayer-throughput.json", artifact);

      artifact.results.push(
        await runScenario(context, concurrency, "default-limits", {
          global: artifact.config.defaultLimits.global,
          perIp: artifact.config.defaultLimits.perIp,
        }),
      );
      writeArtifact("relayer-throughput.json", artifact);
    }

    printSummary(artifact.results);
    return artifact;
  } finally {
    closeStressContext(context);
  }
}

async function runScenario(
  context: ReturnType<typeof createStressContext>,
  concurrency: number,
  mode: RelayerScenarioResult["mode"],
  limits: { global: number; perIp: number },
): Promise<RelayerScenarioResult> {
  console.log(`\n[relayer-throughput] mode=${mode} concurrency=${concurrency}`);
  const pool = await createSolPool(context, DEPOSIT_AMOUNT_LAMPORTS, TREE_DEPTH);
  const { dbPath, harness } = await createRelayer(context, pool.pool, {
    maxRequestsPerMinuteGlobal: limits.global,
    maxRequestsPerMinutePerIp: limits.perIp,
    retryBackoffMs: [100, 250, 500],
    retryPollIntervalMs: 100,
  });
  const recipients = makeAgentWallets(concurrency);
  await requestAirdrops(context.connection, recipients, RECIPIENT_AIRDROP_LAMPORTS);

  try {
    const notes = await createNotesForPool(pool.pool, concurrency);
    for (const note of notes) {
      const [attempt] = await buildSolDepositAttempts(context, pool, [context.payer], [note]);
      const [result] = await executeOperationBatch(context.connection, [attempt]);
      if (!result.succeeded) {
        throw new Error(
          `Relayer setup deposit failed: ${result.errorType} ${result.errorMessage ?? ""}`,
        );
      }
    }

    const poolState = await fetchPoolState(context.program, context.connection, pool.pool);
    const signedRequests = await Promise.all(
      notes.map((note, index) =>
        createSignedRelayRequest(
          pool.pool,
          note,
          poolState,
          recipients[index].publicKey,
          Math.max(
            Math.floor((DEPOSIT_AMOUNT_LAMPORTS * harness.config.feeBps) / 10_000),
            harness.config.minFeeLamports,
          ),
          context.payer,
        ),
      ),
    );

    const memoryBefore = snapshotMemory();
    const startedAt = Date.now();
    const responses = await Promise.all(
      signedRequests.map(async (request) => {
        const requestStartedAt = Date.now();
        const response = await postJson(`${harness.baseUrl}/relay`, request);
        return {
          latencyMs: Date.now() - requestStartedAt,
          request,
          response,
        };
      }),
    );
    const scenarioDurationMs = Date.now() - startedAt;
    const memoryAfter = snapshotMemory();

    const httpStatuses = countStatuses(responses.map((entry) => entry.response.status));
    const retryAfterSeconds = responses
      .map((entry) => entry.response.headers.get("retry-after"))
      .flatMap((value) => (value === null ? [] : [Number(value)]));
    const acceptedRequests = responses.filter((entry) => entry.response.status === 200);
    const records = acceptedRequests
      .map((entry) => harness.store.getByNullifier(entry.request.payload.nullifierHash))
      .filter((record): record is NonNullable<typeof record> => record !== null);

    const submissionLatencies = records
      .filter((record) => record.submittedAt !== undefined)
      .map((record) => (record.submittedAt as number) - record.receivedAt);
    const confirmationLatencies = records
      .filter((record) => record.submittedAt !== undefined)
      .map((record) => record.updatedAt - (record.submittedAt as number));
    const relayRecordStatuses = countStatuses(records.map((record) => record.status));
    const lifecycleWrites = records.reduce((total, record) => {
      if (record.status === "confirmed" || record.status === "failed" || record.status === "expired") {
        return total + 3;
      }
      if (record.status === "submitted") {
        return total + 2;
      }
      return total + 1;
    }, 0);

    return {
      acceptanceRate: concurrency === 0 ? 0 : acceptedRequests.length / concurrency,
      attempted: concurrency,
      averageConfirmationLatencyMs:
        confirmationLatencies.length === 0
          ? null
          : round(
              confirmationLatencies.reduce((total, value) => total + value, 0) /
                confirmationLatencies.length,
            ),
      averageRequestLatencyMs: round(
        responses.reduce((total, entry) => total + entry.latencyMs, 0) /
          responses.length,
      ),
      averageSubmissionLatencyMs:
        submissionLatencies.length === 0
          ? null
          : round(
              submissionLatencies.reduce((total, value) => total + value, 0) /
                submissionLatencies.length,
            ),
      concurrency,
      confirmed: relayRecordStatuses.confirmed ?? 0,
      httpStatuses,
      memoryAfter,
      memoryBefore,
      mode,
      rateLimited: httpStatuses["429"] ?? 0,
      relayRecordStatuses,
      requestTps: calculateTps(acceptedRequests.length, scenarioDurationMs),
      retryAfterSeconds,
      sqliteWritesPerSecond:
        scenarioDurationMs <= 0 ? 0 : round((lifecycleWrites * 1_000) / scenarioDurationMs),
      txSignatures: acceptedRequests
        .map((entry) => entry.response.body.txSignature)
        .filter((value): value is string => typeof value === "string"),
    };
  } finally {
    await disposeRelayer(harness, dbPath);
  }
}

function countStatuses(values: Array<number | string>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function printSummary(results: RelayerScenarioResult[]): void {
  for (const result of results) {
    console.log(
      [
        `[relayer-throughput] mode=${result.mode}`,
        `concurrency=${result.concurrency}`,
        `accepted=${result.httpStatuses["200"] ?? 0}/${result.attempted}`,
        `429=${result.rateLimited}`,
        `requestTps=${result.requestTps.toFixed(2)}`,
        `sqliteWritesPerSecond=${result.sqliteWritesPerSecond.toFixed(2)}`,
      ].join(" "),
    );
  }
}

if (require.main === module) {
  runRelayerThroughputStressTest()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
