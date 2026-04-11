import fs from "fs";
import os from "os";
import path from "path";
import { PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  devnetNoteRecordToNote,
  markDevnetNoteWithdrawn,
  type DevnetNoteDepositState,
  type DevnetNoteJournal,
  type DevnetNoteRecord,
  withDevnetRetry,
} from "./devnet-validation-shared";
import { writeJsonArtifact } from "./relayer-harness";

const DEFAULT_OUTPUT_FILE = "devnet-note-recovery.json";
const NOTE_JOURNAL_MODE = 0o600;
const DEVNET_RESULTS_DIR = path.resolve("devnet-results");

interface RecoveryAttempt {
  amount: number;
  assetType: "sol" | "spl";
  depositIndex: number;
  depositState: DevnetNoteDepositState;
  error: string | null;
  journalPath: string;
  nullifierHash: string;
  pool: string;
  stage: string;
  status:
    | "already-withdrawn"
    | "dry-run"
    | "failed"
    | "recovered"
    | "skipped-filtered"
    | "skipped-withdrawn";
  withdrawalSignature: string | null;
}

interface RecoveryArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  config: {
    dryRun: boolean;
    includePlanned: boolean;
    journals: string[];
    outputPath: string;
    poolFilter: string | null;
    recipient: string;
  };
  metadata: ReturnType<typeof buildMetadata>;
  summary: {
    alreadyWithdrawn: number;
    failed: number;
    recovered: number;
    skipped: number;
    total: number;
  };
  attempts: RecoveryAttempt[];
}

interface RecoveryConfig {
  dryRun: boolean;
  includePlanned: boolean;
  notesFiles: string[];
  outputPath: string;
  payerPath: string;
  poolFilter: PublicKey | null;
  recipient: PublicKey | null;
  rpcUrl: string;
}

interface LoadedJournal {
  changed: boolean;
  journal: DevnetNoteJournal;
  path: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const context = createDevnetContext(config.rpcUrl, config.payerPath);

  try {
    const recipient = config.recipient ?? context.payer.publicKey;
    const payerBalanceBefore = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    const journals = config.notesFiles.map(loadJournal);
    const attempts: RecoveryAttempt[] = [];

    for (const source of journals) {
      for (const record of source.journal.notes) {
        const poolMatches =
          config.poolFilter === null ||
          record.pool === config.poolFilter.toBase58();
        if (!poolMatches) {
          attempts.push(buildAttempt(source.path, record, "skipped-filtered", null, null));
          continue;
        }

        if (record.withdrawn) {
          attempts.push(buildAttempt(source.path, record, "skipped-withdrawn", null, record.withdrawalSignature));
          continue;
        }

        const depositState = normalizeDepositState(record.depositState);
        if (depositState === "failed") {
          attempts.push(buildAttempt(source.path, record, "skipped-filtered", record.lastError, null));
          continue;
        }

        if (!config.includePlanned && depositState === "planned") {
          attempts.push(buildAttempt(source.path, record, "skipped-filtered", null, null));
          continue;
        }

        if (config.dryRun) {
          attempts.push(buildAttempt(source.path, record, "dry-run", null, null));
          continue;
        }

        try {
          const note = devnetNoteRecordToNote(record);
          const pool = new PublicKey(record.pool);
          const { result: signature } = await withDevnetRetry(
            "recover-note",
            () => context.snap.withdraw(pool, note, recipient),
          );

          markDevnetNoteWithdrawn(source.journal, note, signature);
          record.lastError = null;
          source.changed = true;
          attempts.push(buildAttempt(source.path, record, "recovered", null, signature));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const note = devnetNoteRecordToNote(record);

          if (isAlreadyWithdrawnError(message)) {
            markDevnetNoteWithdrawn(source.journal, note, null);
            record.lastError = null;
            source.changed = true;
            attempts.push(buildAttempt(source.path, record, "already-withdrawn", null, null));
            continue;
          }

          record.lastError = message;
          source.changed = true;
          attempts.push(buildAttempt(source.path, record, "failed", message, null));
        }
      }

      if (source.changed && !config.dryRun) {
        writeJsonArtifact(source.path, source.journal, {
          mode: NOTE_JOURNAL_MODE,
        });
      }
    }

    const payerBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    const artifact: RecoveryArtifact = {
      attempts,
      balances: {
        payer: {
          after: payerBalanceAfter,
          before: payerBalanceBefore,
          delta: payerBalanceAfter - payerBalanceBefore,
        },
      },
      config: {
        dryRun: config.dryRun,
        includePlanned: config.includePlanned,
        journals: config.notesFiles.map((entry) => path.resolve(entry)),
        outputPath: config.outputPath,
        poolFilter: config.poolFilter?.toBase58() ?? null,
        recipient: recipient.toBase58(),
      },
      metadata: buildMetadata(context),
      summary: summarizeAttempts(attempts),
    };

    writeJsonArtifact(config.outputPath, artifact);
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeDevnetContext(context);
  }
}

function loadConfig(): RecoveryConfig {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const dryRun = process.env.SNAP_DEVNET_RECOVERY_DRY_RUN === "1";
  const includePlanned =
    process.env.SNAP_DEVNET_RECOVERY_INCLUDE_PLANNED !== "0";
  const notesFiles = resolveNotesFiles(process.env.SNAP_DEVNET_RECOVERY_NOTES_FILES);
  if (notesFiles.length === 0 && !dryRun) {
    throw new Error(
      "No devnet note journals found. Set SNAP_DEVNET_RECOVERY_NOTES_FILES or create a *-notes.json artifact under devnet-results/.",
    );
  }

  const outputPath = resolveOutputPath(
    process.env.SNAP_DEVNET_RECOVERY_OUTPUT_FILE ?? DEFAULT_OUTPUT_FILE,
  );

  return {
    dryRun,
    includePlanned,
    notesFiles,
    outputPath,
    payerPath,
    poolFilter: parsePublicKeyEnv(process.env.SNAP_DEVNET_RECOVERY_POOL_ADDRESS),
    recipient: parsePublicKeyEnv(process.env.SNAP_DEVNET_RECOVERY_RECIPIENT),
    rpcUrl,
  };
}

function loadJournal(journalPath: string): LoadedJournal {
  const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Partial<DevnetNoteJournal>;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.notes)) {
    throw new Error(`Invalid note journal: ${journalPath}`);
  }

  return {
    changed: false,
    journal: {
      metadata: (
        parsed.metadata && typeof parsed.metadata === "object"
          ? parsed.metadata
          : {}
      ) as ReturnType<typeof buildMetadata>,
      notes: parsed.notes.map((record) =>
        normalizeNoteRecord(record as Partial<DevnetNoteRecord>),
      ),
    },
    path: path.resolve(journalPath),
  };
}

function normalizeNoteRecord(record: Partial<DevnetNoteRecord>): DevnetNoteRecord {
  return {
    amount: Number(record.amount ?? 0),
    assetType: record.assetType === "spl" ? "spl" : "sol",
    commitment: String(record.commitment ?? ""),
    depositIndex: Number(record.depositIndex ?? 0),
    depositSignature:
      typeof record.depositSignature === "string" ? record.depositSignature : null,
    depositState: normalizeDepositState(record.depositState),
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    nullifier: String(record.nullifier ?? "0"),
    nullifierHash: String(record.nullifierHash ?? ""),
    pool: String(record.pool ?? ""),
    secret: String(record.secret ?? "0"),
    stage: typeof record.stage === "string" ? record.stage : "unknown",
    withdrawalSignature:
      typeof record.withdrawalSignature === "string" ? record.withdrawalSignature : null,
    withdrawn: record.withdrawn === true,
  };
}

function normalizeDepositState(value: unknown): DevnetNoteDepositState {
  if (value === "planned" || value === "failed") {
    return value;
  }

  return "confirmed";
}

function resolveNotesFiles(value: string | undefined): string[] {
  if (value) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => path.resolve(entry));
  }

  if (!fs.existsSync(DEVNET_RESULTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(DEVNET_RESULTS_DIR)
    .filter((entry) => entry.endsWith("-notes.json"))
    .map((entry) => path.join(DEVNET_RESULTS_DIR, entry))
    .sort();
}

function resolveOutputPath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(DEVNET_RESULTS_DIR, value);
}

function parsePublicKeyEnv(value: string | undefined): PublicKey | null {
  if (!value) {
    return null;
  }

  return new PublicKey(value);
}

function isAlreadyWithdrawnError(message: string): boolean {
  return /already used|already been withdrawn|custom program error: 0x1773|alreadywithdrawn/i.test(
    message,
  );
}

function buildAttempt(
  journalPath: string,
  record: DevnetNoteRecord,
  status: RecoveryAttempt["status"],
  error: string | null,
  withdrawalSignature: string | null,
): RecoveryAttempt {
  return {
    amount: record.amount,
    assetType: record.assetType,
    depositIndex: record.depositIndex,
    depositState: normalizeDepositState(record.depositState),
    error,
    journalPath,
    nullifierHash: record.nullifierHash,
    pool: record.pool,
    stage: record.stage,
    status,
    withdrawalSignature,
  };
}

function summarizeAttempts(attempts: RecoveryAttempt[]) {
  return attempts.reduce(
    (summary, attempt) => {
      summary.total += 1;
      if (attempt.status === "recovered") {
        summary.recovered += 1;
      } else if (attempt.status === "already-withdrawn") {
        summary.alreadyWithdrawn += 1;
      } else if (attempt.status === "failed") {
        summary.failed += 1;
      } else {
        summary.skipped += 1;
      }

      return summary;
    },
    {
      alreadyWithdrawn: 0,
      failed: 0,
      recovered: 0,
      skipped: 0,
      total: 0,
    },
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
