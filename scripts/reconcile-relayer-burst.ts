import fs from "fs";
import path from "path";
import {
  Connection,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { writeJsonArtifact } from "./relayer-harness";

const DEFAULT_BURST_ARTIFACT = path.resolve(
  "devnet-results/relayer-burst-validation.json",
);
const DEFAULT_NOTE_JOURNAL = path.resolve(
  "devnet-results/relayer-validation-notes.json",
);
const DEFAULT_RECOVERY_ARTIFACT = path.resolve(
  "devnet-results/phase12e-relayer-note-recovery.json",
);
const DEFAULT_OUTPUT_ARTIFACT = path.resolve(
  "devnet-results/phase12f-relayer-burst-reconciliation.json",
);

type RecoveryStatus =
  | "already-withdrawn"
  | "dry-run"
  | "failed"
  | "recovered"
  | "skipped-filtered"
  | "skipped-withdrawn";

type ReconciliationBucket =
  | "confirmed-success-surfaced-success"
  | "rate-limited-without-spend"
  | "surfaced-failure-already-withdrawn-on-chain"
  | "surfaced-failure-required-recovery";

interface BurstArtifact {
  metadata: {
    generatedAt: string;
    programId: string;
    rpcUrl: string;
    wallet: string;
  };
  scenarios: Array<{
    concurrency: number;
    httpStatuses: Record<string, number>;
    mode: "default-limits" | "raw-throughput";
    rateLimited: number;
    relayer: string;
    requests?: RequestOutcome[];
    txSignatures: string[];
  }>;
}

interface NoteJournal {
  notes: NoteRecord[];
}

interface NoteRecord {
  amount: number;
  assetType: "sol" | "spl";
  depositIndex: number;
  depositSignature: string | null;
  depositState: string;
  nullifierHash: string;
  pool: string;
  stage: string;
  withdrawalSignature: string | null;
  withdrawn: boolean;
}

interface RecoveryArtifact {
  attempts: RecoveryAttempt[];
}

interface RecoveryAttempt {
  error: string | null;
  nullifierHash: string;
  stage: string;
  status: RecoveryStatus;
  withdrawalSignature: string | null;
}

interface RequestOutcome {
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
  persistedRelayRecord: {
    error: string | null;
    id: string;
    lastValidBlockHeight: number | null;
    retries: number;
    status: string;
    submittedAt: number | null;
    txSignature: string | null;
    updatedAt: number;
  } | null;
  requestIndex: number;
  stage: string;
  surfaced: {
    classification: string;
    error: string | null;
    httpStatus: number;
    retryAfterSeconds: number | null;
    txSignature: string | null;
  };
}

interface RelayerTxMatch {
  blockTime: number | null;
  err: unknown;
  outcome: "failed" | "success";
  reason: string | null;
  signature: string;
  slot: number;
}

interface ReconciledRequest {
  bucket: ReconciliationBucket;
  finalNoteState: {
    alreadySpentOnChainDespiteNonSuccess: boolean;
    laterRecoveredManually: boolean;
    withdrawalSignature: string | null;
    withdrawn: boolean;
  };
  note: {
    amount: number;
    assetType: "sol" | "spl";
    depositIndex: number;
    depositSignature: string | null;
    depositState: string;
    nullifierHash: string;
    pool: string;
    stage: string;
  };
  onChainRelayerTransactions: RelayerTxMatch[];
  persistedRelayerRecord: RequestOutcome["persistedRelayRecord"] | null;
  recovery: {
    error: string | null;
    status: RecoveryStatus;
    withdrawalSignature: string | null;
  };
  requestIndex: number;
  surfaced: {
    classification: string;
    error: string | null;
    exact: boolean;
    httpStatus: number;
    retryAfterSeconds: number | null;
    txSignature: string | null;
  };
}

interface ReconciliationArtifact {
  inputs: {
    burstArtifactPath: string;
    noteJournalPath: string;
    outputPath: string;
    recoveryArtifactPath: string;
    rpcUrl: string;
  };
  metadata: {
    generatedAt: string;
    programId: string;
    wallet: string;
  };
  scenarios: Array<{
    concurrency: number;
    httpStatuses: Record<string, number>;
    mode: "default-limits" | "raw-throughput";
    rateLimited: number;
    relayer: string;
    requests: ReconciledRequest[];
    stage: string;
  }>;
  summary: {
    bucketCounts: Record<ReconciliationBucket, number>;
    exactHttpMappingAvailable: boolean;
    phase12e502Classification:
      | "entirely-false-negatives"
      | "entirely-true-failures"
      | "mixed-control-plane-result";
    surfacedStatusCounts: Record<string, number>;
    totalRequests: number;
  };
}

async function main(): Promise<void> {
  const burstArtifactPath = resolveInputPath(
    process.env.SNAP_RELAYER_BURST_ARTIFACT,
    DEFAULT_BURST_ARTIFACT,
  );
  const noteJournalPath = resolveInputPath(
    process.env.SNAP_RELAYER_NOTE_JOURNAL,
    DEFAULT_NOTE_JOURNAL,
  );
  const recoveryArtifactPath = resolveInputPath(
    process.env.SNAP_RELAYER_RECOVERY_ARTIFACT,
    DEFAULT_RECOVERY_ARTIFACT,
  );
  const outputPath = resolveInputPath(
    process.env.SNAP_RELAYER_RECONCILIATION_OUTPUT,
    DEFAULT_OUTPUT_ARTIFACT,
  );

  const burstArtifact = readJson<BurstArtifact>(burstArtifactPath);
  const noteJournal = readJson<NoteJournal>(noteJournalPath);
  const recoveryArtifact = readJson<RecoveryArtifact>(recoveryArtifactPath);
  const rpcUrl =
    process.env.SNAP_RPC_URL ??
    burstArtifact.metadata.rpcUrl ??
    clusterApiUrl("devnet");
  const connection = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(burstArtifact.metadata.programId);

  try {
    const recoveryByNullifier = new Map(
      recoveryArtifact.attempts.map((attempt) => [attempt.nullifierHash, attempt]),
    );
    const scenarios = [];

    for (const scenario of burstArtifact.scenarios) {
      const stage = `${scenario.mode}-c${scenario.concurrency}`;
      const stageNotes = noteJournal.notes
        .filter((note) => note.stage === stage)
        .sort((left, right) => left.depositIndex - right.depositIndex);
      const requestOutcomes =
        scenario.requests?.slice().sort((left, right) => left.requestIndex - right.requestIndex) ??
        null;
      const txMatches = await fetchScenarioRelayerTransactions(
        connection,
        new PublicKey(scenario.relayer),
        new PublicKey(stageNotes[0]?.pool ?? requestOutcomes?.[0]?.note.pool ?? ""),
        programId,
        stageNotes,
      );
      const requests = reconcileScenario(
        scenario,
        stageNotes,
        requestOutcomes,
        recoveryByNullifier,
        txMatches,
      );

      scenarios.push({
        concurrency: scenario.concurrency,
        httpStatuses: scenario.httpStatuses,
        mode: scenario.mode,
        rateLimited: scenario.rateLimited,
        relayer: scenario.relayer,
        requests,
        stage,
      });
    }

    const allRequests = scenarios.flatMap((scenario) => scenario.requests);
    const bucketCounts = countBy(
      allRequests.map((request) => request.bucket),
    ) as Record<ReconciliationBucket, number>;
    const exactHttpMappingAvailable = allRequests.every((request) => request.surfaced.exact);
    const falseNegatives =
      bucketCounts["surfaced-failure-already-withdrawn-on-chain"] ?? 0;
    const trueFailures =
      bucketCounts["surfaced-failure-required-recovery"] ?? 0;
    const phase12e502Classification =
      falseNegatives > 0 && trueFailures > 0
        ? "mixed-control-plane-result"
        : falseNegatives > 0
          ? "entirely-false-negatives"
          : "entirely-true-failures";
    const artifact: ReconciliationArtifact = {
      inputs: {
        burstArtifactPath,
        noteJournalPath,
        outputPath,
        recoveryArtifactPath,
        rpcUrl,
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        programId: burstArtifact.metadata.programId,
        wallet: burstArtifact.metadata.wallet,
      },
      scenarios,
      summary: {
        bucketCounts: {
          "confirmed-success-surfaced-success":
            bucketCounts["confirmed-success-surfaced-success"] ?? 0,
          "rate-limited-without-spend":
            bucketCounts["rate-limited-without-spend"] ?? 0,
          "surfaced-failure-already-withdrawn-on-chain":
            bucketCounts["surfaced-failure-already-withdrawn-on-chain"] ?? 0,
          "surfaced-failure-required-recovery":
            bucketCounts["surfaced-failure-required-recovery"] ?? 0,
        },
        exactHttpMappingAvailable,
        phase12e502Classification,
        surfacedStatusCounts: countBy(
          allRequests.map((request) => String(request.surfaced.httpStatus)),
        ),
        totalRequests: allRequests.length,
      },
    };

    writeJsonArtifact(outputPath, artifact);
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeConnection(connection);
  }
}

function reconcileScenario(
  scenario: BurstArtifact["scenarios"][number],
  stageNotes: NoteRecord[],
  requestOutcomes: RequestOutcome[] | null,
  recoveryByNullifier: Map<string, RecoveryAttempt>,
  txMatches: Map<string, RelayerTxMatch[]>,
): ReconciledRequest[] {
  const notesWithNoRelayTx = stageNotes.filter(
    (note) =>
      (recoveryByNullifier.get(note.nullifierHash)?.status ?? "skipped-filtered") === "recovered" &&
      (txMatches.get(note.nullifierHash)?.length ?? 0) === 0,
  );
  const assignNoRelayTxAsRateLimited =
    requestOutcomes === null &&
    notesWithNoRelayTx.length === scenario.rateLimited;

  return stageNotes.map((note, index) => {
    const requestOutcome =
      requestOutcomes?.find((entry) => entry.note.nullifierHash === note.nullifierHash) ??
      null;
    const recovery =
      recoveryByNullifier.get(note.nullifierHash) ??
      ({
        error: null,
        nullifierHash: note.nullifierHash,
        stage: note.stage,
        status: note.withdrawn ? "skipped-withdrawn" : "skipped-filtered",
        withdrawalSignature: note.withdrawalSignature,
      } satisfies RecoveryAttempt);
    const matchedTransactions = txMatches.get(note.nullifierHash) ?? [];
    const surfaced = requestOutcome
      ? {
          classification: requestOutcome.surfaced.classification,
          error: requestOutcome.surfaced.error,
          exact: true,
          httpStatus: requestOutcome.surfaced.httpStatus,
          retryAfterSeconds: requestOutcome.surfaced.retryAfterSeconds,
          txSignature: requestOutcome.surfaced.txSignature,
        }
      : deriveLegacySurface(scenario, note, recovery, matchedTransactions, assignNoRelayTxAsRateLimited);
    const bucket = classifyBucket(recovery.status, surfaced.httpStatus);

    return {
      bucket,
      finalNoteState: {
        alreadySpentOnChainDespiteNonSuccess:
          surfaced.httpStatus !== 200 && recovery.status === "already-withdrawn",
        laterRecoveredManually: recovery.status === "recovered",
        withdrawalSignature: note.withdrawalSignature,
        withdrawn: note.withdrawn,
      },
      note: {
        amount: note.amount,
        assetType: note.assetType,
        depositIndex: note.depositIndex,
        depositSignature: note.depositSignature,
        depositState: note.depositState,
        nullifierHash: note.nullifierHash,
        pool: note.pool,
        stage: note.stage,
      },
      onChainRelayerTransactions: matchedTransactions,
      persistedRelayerRecord: requestOutcome?.persistedRelayRecord ?? null,
      recovery: {
        error: recovery.error,
        status: recovery.status,
        withdrawalSignature: recovery.withdrawalSignature,
      },
      requestIndex: requestOutcome?.requestIndex ?? index,
      surfaced,
    };
  });
}

function deriveLegacySurface(
  scenario: BurstArtifact["scenarios"][number],
  note: NoteRecord,
  recovery: RecoveryAttempt,
  matchedTransactions: RelayerTxMatch[],
  assignNoRelayTxAsRateLimited: boolean,
): ReconciledRequest["surfaced"] {
  if (note.withdrawalSignature && recovery.status === "skipped-withdrawn") {
    return {
      classification: "success",
      error: null,
      exact: true,
      httpStatus: 200,
      retryAfterSeconds: null,
      txSignature: note.withdrawalSignature,
    };
  }

  if (recovery.status === "already-withdrawn") {
    const successfulTx = matchedTransactions.find((entry) => entry.outcome === "success");
    return {
      classification: "relay-failure",
      error: null,
      exact: true,
      httpStatus: 502,
      retryAfterSeconds: null,
      txSignature: successfulTx?.signature ?? null,
    };
  }

  if (recovery.status === "recovered") {
    if (assignNoRelayTxAsRateLimited && matchedTransactions.length === 0) {
      return {
        classification: "rate-limited",
        error: "Derived from legacy artifact: no relayer transaction matched this nullifier and the no-transaction count matched the saved 429 count",
        exact: true,
        httpStatus: 429,
        retryAfterSeconds: scenario.rateLimited > 0 ? 60 : null,
        txSignature: null,
      };
    }

    return {
      classification: "relay-failure",
      error: matchedTransactions[0]?.reason ?? null,
      exact: true,
      httpStatus: 502,
      retryAfterSeconds: null,
      txSignature: null,
    };
  }

  throw new Error(
    `Cannot derive surfaced status for ${note.nullifierHash} with recovery status ${recovery.status}`,
  );
}

function classifyBucket(
  recoveryStatus: RecoveryStatus,
  httpStatus: number,
): ReconciliationBucket {
  if (httpStatus === 200) {
    return "confirmed-success-surfaced-success";
  }

  if (httpStatus === 429) {
    return "rate-limited-without-spend";
  }

  if (recoveryStatus === "already-withdrawn") {
    return "surfaced-failure-already-withdrawn-on-chain";
  }

  return "surfaced-failure-required-recovery";
}

async function fetchScenarioRelayerTransactions(
  connection: Connection,
  relayer: PublicKey,
  pool: PublicKey,
  programId: PublicKey,
  notes: NoteRecord[],
): Promise<Map<string, RelayerTxMatch[]>> {
  if (notes.length === 0) {
    return new Map();
  }

  const nullifierRecordByAddress = new Map(
    notes.map((note) => {
      const [nullifierRecord] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          pool.toBuffer(),
          Buffer.from(note.nullifierHash, "hex"),
        ],
        programId,
      );
      return [nullifierRecord.toBase58(), note.nullifierHash] as const;
    }),
  );
  const signatures = await withRpcRetry(() =>
    connection.getSignaturesForAddress(
      relayer,
      { limit: 100 },
      "confirmed",
    ),
  );
  const matches = new Map<string, RelayerTxMatch[]>();

  for (const entry of signatures) {
    const tx = await withRpcRetry(() =>
      connection.getTransaction(entry.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (!tx) {
      continue;
    }

    const accountKeys = tx.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((key) => key.toBase58());
    const matchedNullifiers = accountKeys
      .map((key) => nullifierRecordByAddress.get(key) ?? null)
      .filter((value): value is string => value !== null);
    if (matchedNullifiers.length === 0) {
      continue;
    }

    const match: RelayerTxMatch = {
      blockTime: entry.blockTime ?? null,
      err: entry.err,
      outcome: entry.err === null ? "success" : "failed",
      reason: summarizeTransactionFailure(tx.meta?.logMessages ?? [], entry.err),
      signature: entry.signature,
      slot: entry.slot,
    };

    for (const nullifierHash of matchedNullifiers) {
      const existing = matches.get(nullifierHash) ?? [];
      existing.push(match);
      matches.set(nullifierHash, existing);
    }
  }

  for (const entries of matches.values()) {
    entries.sort((left, right) => left.slot - right.slot);
  }

  return matches;
}

async function withRpcRetry<T>(
  fn: () => Promise<T>,
  backoffMs = [500, 1_000, 2_000, 4_000, 8_000],
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/429|Too many requests/i.test(message) || attempt === backoffMs.length) {
        throw error;
      }

      await sleep(backoffMs[attempt]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function summarizeTransactionFailure(
  logs: string[],
  err: unknown,
): string | null {
  const highlighted = logs.find(
    (line) => line.includes("Allocate:") || line.includes("Transfer:"),
  );
  if (highlighted) {
    return highlighted;
  }

  return err === null ? null : JSON.stringify(err);
}

function resolveInputPath(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  return path.isAbsolute(value) ? value : path.resolve(value);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function closeConnection(connection: Connection): void {
  const internal = connection as Connection & {
    _rpcWebSocket?: { close?: () => void };
    _rpcWebSocketHeartbeat?: NodeJS.Timeout | null;
    _rpcWebSocketIdleTimeout?: NodeJS.Timeout | null;
  };

  if (internal._rpcWebSocketHeartbeat) {
    clearInterval(internal._rpcWebSocketHeartbeat);
    internal._rpcWebSocketHeartbeat = null;
  }

  if (internal._rpcWebSocketIdleTimeout) {
    clearTimeout(internal._rpcWebSocketIdleTimeout);
    internal._rpcWebSocketIdleTimeout = null;
  }

  internal._rpcWebSocket?.close?.();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
