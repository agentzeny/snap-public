import fs from "fs";
import os from "os";
import path from "path";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { SNAPClient, SNAP_PROGRAM_ID } from "../sdk-package/src";
import { bytesToHex } from "../sdk-package/src/commitment";
import { generateWithdrawProof } from "../sdk-package/src/proof";
import { signRelayerWithdrawRequest } from "../sdk-package/src/relayer-auth";
import { getPoolBalance, inspectPool, type MonitorConfig, type MonitorEvent } from "./monitor";
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

const DEFAULT_POOL = "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT";
const DEFAULT_RELAYER_TARGET_LAMPORTS = 20_000_000;
const DEFAULT_RELAYER_RESERVE_LAMPORTS = 20_000;
const DEFAULT_PAYER_BUFFER_LAMPORTS = 20_000_000;

interface CanaryConfig {
  endpointsOnly: boolean;
  outputPath?: string;
  payerPath: string;
  recipientMode: "ephemeral" | "payer";
  relayerReserveLamports: number;
  relayerTargetLamports: number;
  rpcUrl: string;
  poolAddress: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const payer = loadKeypair(config.payerPath);
  const snap = new SNAPClient(connection, payer);
  const pool = new PublicKey(config.poolAddress);
  const relayer = Keypair.generate();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-devnet-relayer-"));
  const dbPath = path.join(dbDir, "relayer.sqlite");
  const startedAt = new Date().toISOString();

  let harness: RelayerHarness | undefined;
  let relayerFunding:
    | {
        balanceBefore: number;
        topUpLamports: number;
        topUpSignature: string | null;
      }
    | undefined;
  let relayerRefund:
    | {
        balanceBefore: number;
        balanceAfter: number;
        refundLamports: number;
        refundSignature: string | null;
      }
    | undefined;

  try {
    const poolInfo = await snap.getPoolInfo(pool);
    const requiredPayerLamports =
      poolInfo.depositAmountRaw +
      config.relayerTargetLamports +
      DEFAULT_PAYER_BUFFER_LAMPORTS;
    const payerBalanceBefore = await connection.getBalance(payer.publicKey, "confirmed");

    if (!config.endpointsOnly) {
      await assertBalanceAtLeast(
        connection,
        payer.publicKey,
        requiredPayerLamports,
        "Devnet payer",
      );
      relayerFunding = await ensureRelayerBalance(
        connection,
        payer,
        relayer.publicKey,
        config.relayerTargetLamports,
      );
    } else {
      relayerFunding = {
        balanceBefore: await connection.getBalance(relayer.publicKey, "confirmed"),
        topUpLamports: 0,
        topUpSignature: null,
      };
    }

    harness = await startRelayerHarness({
      cluster: "devnet",
      connection,
      dbPath,
      pool,
      relayer,
      retryPollIntervalMs: 1000,
    });

    const snapshots = new Map<string, any>();
    const monitorEvents: MonitorEvent[] = [];
    const monitorConfig = createMonitorConfig(relayer.publicKey.toBase58(), pool.toBase58());
    const poolStateBefore = await capturePoolState(connection, snap, pool);
    const relayerBalanceAfterTopUp = await connection.getBalance(
      relayer.publicKey,
      "confirmed",
    );
    const endpointsBefore = await fetchEndpoints(harness.baseUrl);

    await inspectPool(
      connection,
      snap,
      pool.toBase58(),
      snapshots,
      monitorConfig,
      async (event) => {
        monitorEvents.push(event);
      },
    );

    let depositSignature: string | null = null;
    let duplicateNullifierResponse: {
      body: unknown;
      status: number;
    } | null = null;
    let recipientAddress: string | null = null;
    let recipientBalanceAfter: number | null = null;
    let recipientBalanceBefore: number | null = null;
    let relayRecord: Record<string, unknown> | null = null;
    let requestLatencyMs: number | null = null;
    let withdrawResponseBody: unknown = null;
    let withdrawSignature: string | null = null;
    let poolStateAfterDeposit = poolStateBefore;
    let poolStateAfterWithdrawal = poolStateBefore;

    if (!config.endpointsOnly) {
      const recipient =
        config.recipientMode === "payer" ? payer.publicKey : Keypair.generate().publicKey;
      recipientAddress = recipient.toBase58();
      recipientBalanceBefore = await connection.getBalance(recipient, "confirmed");

      const seenDepositSignatures = new Set(
        (
          await connection.getSignaturesForAddress(
            payer.publicKey,
            { limit: 10 },
            "confirmed",
          )
        ).map((entry) => entry.signature),
      );
      const note = await snap.deposit(pool, poolInfo.depositAmount);
      depositSignature = await waitForNewSignature(
        connection,
        payer.publicKey,
        seenDepositSignatures,
        "payer",
      );

      await inspectPool(
        connection,
        snap,
        pool.toBase58(),
        snapshots,
        monitorConfig,
        async (event) => {
          monitorEvents.push(event);
        },
      );
      poolStateAfterDeposit = await capturePoolState(connection, snap, pool);

      const relayRequest = await createSignedRelayRequest(
        snap,
        payer,
        pool,
        note,
        recipient,
        harness.config.feeBps,
        harness.config.minFeeLamports,
      );
      const withdrawStartedAt = Date.now();
      const withdrawResponse = await postRelay(harness.baseUrl, relayRequest);
      requestLatencyMs = Date.now() - withdrawStartedAt;
      withdrawResponseBody = withdrawResponse.body;
      if (withdrawResponse.status !== 200) {
        throw new Error(
          `Live devnet relay request failed with status ${withdrawResponse.status}: ${JSON.stringify(withdrawResponse.body)}`,
        );
      }

      withdrawSignature = extractTxSignature(withdrawResponse.body);
      duplicateNullifierResponse = await postRelay(harness.baseUrl, relayRequest);
      await inspectPool(
        connection,
        snap,
        pool.toBase58(),
        snapshots,
        monitorConfig,
        async (event) => {
          monitorEvents.push(event);
        },
      );

      poolStateAfterWithdrawal = await capturePoolState(connection, snap, pool);
      recipientBalanceAfter = await connection.getBalance(recipient, "confirmed");

      const persistedRecord = await waitForPersistedRecord(
        harness,
        bytesToHex(note.nullifierHash),
      );
      if (persistedRecord) {
        relayRecord = {
          ...persistedRecord,
          confirmationLatencyMs:
            persistedRecord.submittedAt === undefined
              ? null
              : persistedRecord.updatedAt - persistedRecord.submittedAt,
        };
      }
    }

    const endpointsAfter = await fetchEndpoints(harness.baseUrl);
    await stopRelayerHarness(harness);
    harness = undefined;

    relayerRefund = await drainRelayerBalance(
      connection,
      relayer,
      payer.publicKey,
      0,
      payer,
    );
    const payerBalanceAfter = await connection.getBalance(payer.publicKey, "confirmed");

    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      cluster: "devnet",
      mode: config.endpointsOnly ? "endpoints-only" : "full",
      payer: payer.publicKey.toBase58(),
      pool: pool.toBase58(),
      programId: SNAP_PROGRAM_ID.toBase58(),
      relayer: relayer.publicKey.toBase58(),
      recipientMode: config.recipientMode,
      recipient: recipientAddress,
      budget: {
        depositAmountLamports: poolInfo.depositAmountRaw,
        relayerReserveLamports: config.relayerReserveLamports,
        relayerTargetLamports: config.relayerTargetLamports,
        requiredPayerLamports,
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
        recipient: {
          before: recipientBalanceBefore,
          after: recipientBalanceAfter,
          delta:
            recipientBalanceBefore === null || recipientBalanceAfter === null
              ? null
              : recipientBalanceAfter - recipientBalanceBefore,
        },
      },
      endpoints: {
        before: endpointsBefore,
        after: endpointsAfter,
      },
      poolState: {
        before: poolStateBefore,
        afterDeposit: poolStateAfterDeposit,
        afterWithdrawal: poolStateAfterWithdrawal,
      },
      depositSignature,
      withdrawSignature,
      withdrawResponseBody,
      duplicateNullifierResponse,
      relayRecord,
      requestLatencyMs,
      monitorEvents,
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

async function capturePoolState(
  connection: Connection,
  snap: SNAPClient,
  pool: PublicKey,
) {
  const poolInfo = await snap.getPoolInfo(pool);
  return {
    assetType: poolInfo.assetType,
    currentRoot: bytesToHex(Uint8Array.from(poolInfo.currentRoot)),
    depositCount: poolInfo.depositCount,
    depositAmountRaw: poolInfo.depositAmountRaw,
    treeDepth: poolInfo.treeDepth,
    vaultBalanceLamports: await getPoolBalance(
      connection,
      pool,
      poolInfo.assetType,
    ),
    withdrawCount: poolInfo.withdrawCount,
  };
}

async function createSignedRelayRequest(
  snap: SNAPClient,
  payer: Keypair,
  pool: PublicKey,
  note: Awaited<ReturnType<SNAPClient["deposit"]>>,
  recipient: PublicKey,
  feeBps: number,
  minFeeLamports: number,
) {
  const poolState = await (snap as any).fetchPoolState(pool);
  const proof = await generateWithdrawProof(
    note,
    poolState.commitments,
    recipient,
    120_000,
    poolState.treeDepth,
  );
  const fee = Math.max(
    Math.floor((poolState.depositAmountRaw * feeBps) / 10_000),
    poolState.assetType === "sol" ? minFeeLamports : 0,
  );

  return signRelayerWithdrawRequest(
    {
      pool: pool.toBase58(),
      proof: bytesToHex(
        Uint8Array.from([
          ...proof.proofABytes,
          ...proof.proofBBytes,
          ...proof.proofCBytes,
        ]),
      ),
      root: bytesToHex(Uint8Array.from(proof.rootBytes)),
      nullifierHash: bytesToHex(Uint8Array.from(proof.nullifierHashBytes)),
      recipient: recipient.toBase58(),
      fee,
    },
    payer.secretKey.slice(0, 32),
  );
}

function createMonitorConfig(
  relayerAddress: string,
  poolAddress: string,
): MonitorConfig {
  return {
    pools: [poolAddress],
    relayerAddress,
    pollIntervalMs: 1000,
    alerts: {
      webhookUrl: "",
      emailTo: "",
      thresholds: {
        depositsPerFiveMinutes: 999,
        withdrawalsPerMinute: 999,
        relayerBalanceWarning: 1,
        relayerBalanceCritical: 1,
      },
    },
  };
}

function extractTxSignature(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "txSignature" in payload &&
    typeof (payload as { txSignature: unknown }).txSignature === "string"
  ) {
    return (payload as { txSignature: string }).txSignature;
  }

  throw new Error(`Relay response did not include a txSignature: ${JSON.stringify(payload)}`);
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

function loadConfig(): CanaryConfig {
  return {
    endpointsOnly: process.env.SNAP_CANARY_ENDPOINTS_ONLY === "1",
    outputPath: process.env.SNAP_CANARY_OUTPUT_PATH,
    payerPath:
      process.env.ANCHOR_WALLET ??
      path.join(os.homedir(), ".config/solana/id.json"),
    recipientMode:
      process.env.SNAP_CANARY_RECIPIENT_MODE === "payer"
        ? "payer"
        : "ephemeral",
    relayerReserveLamports: parseInteger(
      process.env.SNAP_CANARY_RELAYER_RESERVE_LAMPORTS ??
        String(DEFAULT_RELAYER_RESERVE_LAMPORTS),
      "SNAP_CANARY_RELAYER_RESERVE_LAMPORTS",
    ),
    relayerTargetLamports: parseInteger(
      process.env.SNAP_CANARY_RELAYER_TARGET_LAMPORTS ??
        String(DEFAULT_RELAYER_TARGET_LAMPORTS),
      "SNAP_CANARY_RELAYER_TARGET_LAMPORTS",
    ),
    rpcUrl: process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet"),
    poolAddress: process.env.SNAP_POOL_ADDRESS ?? DEFAULT_POOL,
  };
}

async function postRelay(baseUrl: string, payload: unknown) {
  const response = await fetch(`${baseUrl}/relay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return {
    body: (await response.json()) as unknown,
    status: response.status,
  };
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

async function waitForPersistedRecord(
  harness: RelayerHarness,
  nullifierHash: string,
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const record = harness.store.getByNullifier(nullifierHash);
    if (record) {
      return record;
    }

    await sleep(100);
  }

  return null;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
