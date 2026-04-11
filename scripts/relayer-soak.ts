import fs from "fs";
import os from "os";
import path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { SNAPClient } from "../sdk-package/src";
import { bytesToHex } from "../sdk-package/src/commitment";
import {
  assertBalanceAtLeast,
  closeConnection,
  drainRelayerBalance,
  ensureRelayerBalance,
  fetchJson,
  fetchText,
  loadKeypair,
  sleep,
  startRelayerHarness,
  stopRelayerHarness,
  waitForNewSignature,
  writeJsonArtifact,
  type RelayerHarness,
} from "./relayer-harness";

const DEFAULT_LOCALNET_RPC = "http://127.0.0.1:8899";
const DEFAULT_DEVNET_POOL = "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT";
const DEFAULT_RELAYER_TARGET_LAMPORTS = 20_000_000;
const DEFAULT_RELAYER_RESERVE_LAMPORTS = 20_000;
const DEFAULT_PAYER_BUFFER_LAMPORTS = 20_000_000;

interface SoakConfig {
  allowDevnet: boolean;
  amount: number;
  cluster: "localnet" | "devnet";
  delayMs: number;
  iterations: number;
  maxTotalLamports: number;
  outputPath?: string;
  payerPath: string;
  poolAddress?: string;
  recipientMode: "ephemeral" | "payer";
  relayerReserveLamports: number;
  relayerTargetLamports: number;
  rpcUrl: string;
  treeDepth: 10 | 20;
}

interface IterationResult {
  confirmationLatencyMs: number | null;
  depositSignature: string | null;
  error: string | null;
  iteration: number;
  recipient: string;
  recipientBalanceAfter: number | null;
  recipientBalanceBefore: number | null;
  requestLatencyMs: number | null;
  retries: number | null;
  status: "confirmed" | "failed";
  withdrawSignature: string | null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.cluster === "devnet" && !config.allowDevnet) {
    throw new Error(
      "Devnet soak mode is disabled by default. Re-run with SNAP_SOAK_ALLOW_DEVNET=1.",
    );
  }

  const connection = new Connection(config.rpcUrl, "confirmed");
  const payer = loadKeypair(config.payerPath);
  const snap = new SNAPClient(connection, payer);
  const relayer = Keypair.generate();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-relayer-soak-"));
  const dbPath = path.join(dbDir, "relayer.sqlite");
  const startedAt = new Date().toISOString();

  let harness: RelayerHarness | undefined;

  try {
    const pool = await resolvePool(config, snap);
    const poolInfo = await snap.getPoolInfo(pool);
    const requestedTotalLamports = poolInfo.depositAmountRaw * config.iterations;
    if (requestedTotalLamports > config.maxTotalLamports) {
      throw new Error(
        `Requested soak spend ${requestedTotalLamports} lamports exceeds guardrail ${config.maxTotalLamports}`,
      );
    }

    const worstCasePayerLamports =
      config.relayerTargetLamports +
      DEFAULT_PAYER_BUFFER_LAMPORTS +
      (config.recipientMode === "payer"
        ? poolInfo.depositAmountRaw
        : requestedTotalLamports);
    const payerBalanceBefore = await assertBalanceAtLeast(
      connection,
      payer.publicKey,
      worstCasePayerLamports,
      `${config.cluster} payer`,
    );

    const relayerFunding = await ensureRelayerBalance(
      connection,
      payer,
      relayer.publicKey,
      config.relayerTargetLamports,
    );
    harness = await startRelayerHarness({
      cluster: config.cluster,
      connection,
      dbPath,
      pool,
      relayer,
      retryPollIntervalMs: config.cluster === "localnet" ? 100 : 1000,
      retryBackoffMs: config.cluster === "localnet" ? [100, 250, 500] : [1000, 3000, 8000],
    });

    const relayerBalanceAfterTopUp = await connection.getBalance(
      relayer.publicKey,
      "confirmed",
    );
    const endpointsBefore = await fetchEndpoints(harness.baseUrl);
    const results: IterationResult[] = [];

    for (let iteration = 1; iteration <= config.iterations; iteration += 1) {
      if (iteration > 1 && config.delayMs > 0) {
        await sleep(config.delayMs);
      }

      let note: Awaited<ReturnType<SNAPClient["deposit"]>> | null = null;
      let recipient: PublicKey =
        config.recipientMode === "payer" ? payer.publicKey : Keypair.generate().publicKey;
      const recipientBalanceBefore = await connection.getBalance(recipient, "confirmed");
      const seenDepositSignatures = new Set(
        (
          await connection.getSignaturesForAddress(
            payer.publicKey,
            { limit: 10 },
            "confirmed",
          )
        ).map((entry) => entry.signature),
      );

      try {
        note = await snap.deposit(pool, poolInfo.depositAmount);
        const depositSignature = await waitForNewSignature(
          connection,
          payer.publicKey,
          seenDepositSignatures,
          `deposit iteration ${iteration}`,
        );

        const requestStartedAt = Date.now();
        const withdrawResult = await snap.withdrawViaRelayer(
          pool,
          note,
          recipient,
          harness.baseUrl,
        );
        const requestLatencyMs = Date.now() - requestStartedAt;
        const persisted = harness.store.getByNullifier(bytesToHex(note.nullifierHash));

        results.push({
          confirmationLatencyMs:
            persisted?.submittedAt === undefined
              ? null
              : persisted.updatedAt - persisted.submittedAt,
          depositSignature,
          error: null,
          iteration,
          recipient: recipient.toBase58(),
          recipientBalanceAfter: await connection.getBalance(recipient, "confirmed"),
          recipientBalanceBefore,
          requestLatencyMs,
          retries: persisted?.retries ?? null,
          status: "confirmed",
          withdrawSignature: withdrawResult.txSignature,
        });
      } catch (error) {
        const persisted =
          note === null
            ? null
            : harness.store.getByNullifier(bytesToHex(note.nullifierHash));
        results.push({
          confirmationLatencyMs:
            persisted?.submittedAt === undefined
              ? null
              : persisted.updatedAt - persisted.submittedAt,
          depositSignature: null,
          error: error instanceof Error ? error.message : String(error),
          iteration,
          recipient: recipient.toBase58(),
          recipientBalanceAfter: await connection.getBalance(recipient, "confirmed"),
          recipientBalanceBefore,
          requestLatencyMs: null,
          retries: persisted?.retries ?? null,
          status: "failed",
          withdrawSignature: persisted?.txSignature ?? null,
        });
      }
    }

    const endpointsAfter = await fetchEndpoints(harness.baseUrl);
    await stopRelayerHarness(harness);
    harness = undefined;

    const relayerRefund = await drainRelayerBalance(
      connection,
      relayer,
      payer.publicKey,
      0,
      payer,
    );
    const payerBalanceAfter = await connection.getBalance(payer.publicKey, "confirmed");
    const confirmationLatencies = results
      .map((result) => result.confirmationLatencyMs)
      .filter((value): value is number => value !== null);
    const requestLatencies = results
      .map((result) => result.requestLatencyMs)
      .filter((value): value is number => value !== null);
    const retryCount = results.reduce(
      (total, result) => total + (result.retries ?? 0),
      0,
    );
    const successCount = results.filter((result) => result.status === "confirmed").length;
    const failureCount = results.length - successCount;

    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      cluster: config.cluster,
      pool: pool.toBase58(),
      payer: payer.publicKey.toBase58(),
      relayer: relayer.publicKey.toBase58(),
      recipientMode: config.recipientMode,
      config: {
        amount: poolInfo.depositAmount,
        delayMs: config.delayMs,
        iterations: config.iterations,
        maxTotalLamports: config.maxTotalLamports,
        requestedTotalLamports,
        relayerReserveLamports: config.relayerReserveLamports,
        relayerTargetLamports: config.relayerTargetLamports,
        treeDepth: poolInfo.treeDepth,
      },
      balances: {
        payer: {
          before: payerBalanceBefore,
          after: payerBalanceAfter,
          delta: payerBalanceAfter - payerBalanceBefore,
        },
        relayer: {
          funding: relayerFunding,
          afterTopUp: relayerBalanceAfterTopUp,
          refund: relayerRefund,
        },
      },
      endpoints: {
        before: endpointsBefore,
        after: endpointsAfter,
      },
      iterations: results,
      summary: {
        averageConfirmationLatencyMs: average(confirmationLatencies),
        averageRequestLatencyMs: average(requestLatencies),
        failureCount,
        maxConfirmationLatencyMs: max(confirmationLatencies),
        maxRequestLatencyMs: max(requestLatencies),
        minConfirmationLatencyMs: min(confirmationLatencies),
        minRequestLatencyMs: min(requestLatencies),
        retryCount,
        successCount,
        withdrawSignatures: results
          .map((result) => result.withdrawSignature)
          .filter((value): value is string => Boolean(value)),
      },
    };

    if (config.outputPath) {
      writeJsonArtifact(config.outputPath, summary);
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await stopRelayerHarness(harness);
    fs.rmSync(dbDir, { recursive: true, force: true });
    closeConnection(connection);
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

async function fetchEndpoints(baseUrl: string) {
  const health = await fetchJson(`${baseUrl}/health`);
  const info = await fetchJson(`${baseUrl}/info`);
  const stats = await fetchJson(`${baseUrl}/stats`);
  const metrics = await fetchText(`${baseUrl}/metrics`);

  return {
    health,
    info,
    stats,
    metrics,
  };
}

function loadConfig(): SoakConfig {
  const cluster = parseCluster(process.env.SNAP_SOAK_CLUSTER ?? "localnet");
  return {
    allowDevnet: process.env.SNAP_SOAK_ALLOW_DEVNET === "1",
    amount: parseFloatWithDefault(process.env.SNAP_SOAK_AMOUNT, 0.1),
    cluster,
    delayMs: parseInteger(process.env.SNAP_SOAK_DELAY_MS ?? "1000", "SNAP_SOAK_DELAY_MS"),
    iterations: parseInteger(
      process.env.SNAP_SOAK_ITERATIONS ?? (cluster === "devnet" ? "2" : "5"),
      "SNAP_SOAK_ITERATIONS",
    ),
    maxTotalLamports: parseInteger(
      process.env.SNAP_SOAK_MAX_TOTAL_LAMPORTS ??
        String(cluster === "devnet" ? 200_000_000 : 2_000_000_000),
      "SNAP_SOAK_MAX_TOTAL_LAMPORTS",
    ),
    outputPath: process.env.SNAP_SOAK_OUTPUT_PATH,
    payerPath:
      process.env.ANCHOR_WALLET ??
      path.join(os.homedir(), ".config/solana/id.json"),
    poolAddress:
      process.env.SNAP_SOAK_POOL_ADDRESS ??
      (cluster === "devnet" ? DEFAULT_DEVNET_POOL : undefined),
    recipientMode:
      process.env.SNAP_SOAK_RECIPIENT_MODE === "ephemeral"
        ? "ephemeral"
        : "payer",
    relayerReserveLamports: parseInteger(
      process.env.SNAP_SOAK_RELAYER_RESERVE_LAMPORTS ??
        String(DEFAULT_RELAYER_RESERVE_LAMPORTS),
      "SNAP_SOAK_RELAYER_RESERVE_LAMPORTS",
    ),
    relayerTargetLamports: parseInteger(
      process.env.SNAP_SOAK_RELAYER_TARGET_LAMPORTS ??
        String(DEFAULT_RELAYER_TARGET_LAMPORTS),
      "SNAP_SOAK_RELAYER_TARGET_LAMPORTS",
    ),
    rpcUrl:
      process.env.SNAP_RPC_URL ??
      (cluster === "devnet" ? clusterApiUrl("devnet") : DEFAULT_LOCALNET_RPC),
    treeDepth: parseTreeDepth(process.env.SNAP_SOAK_TREE_DEPTH ?? "10"),
  };
}

function max(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function min(values: number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function parseCluster(value: string): "localnet" | "devnet" {
  if (value === "localnet" || value === "devnet") {
    return value;
  }

  throw new Error("SNAP_SOAK_CLUSTER must be 'localnet' or 'devnet'");
}

function parseFloatWithDefault(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("SNAP_SOAK_AMOUNT must be a positive number");
  }

  return parsed;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseTreeDepth(value: string): 10 | 20 {
  if (value === "10") {
    return 10;
  }

  if (value === "20") {
    return 20;
  }

  throw new Error("SNAP_SOAK_TREE_DEPTH must be 10 or 20");
}

async function resolvePool(config: SoakConfig, snap: SNAPClient): Promise<PublicKey> {
  if (config.poolAddress) {
    return new PublicKey(config.poolAddress);
  }

  if (config.cluster !== "localnet") {
    throw new Error("SNAP_SOAK_POOL_ADDRESS is required outside localnet");
  }

  return snap.createPool(config.amount, { treeDepth: config.treeDepth });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
