import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SNAPClient, SNAP_PROGRAM_ID } from "../sdk-package/src";

/**
 * SNAP Pool Monitor
 *
 * Watches the pool account and logs:
 * - New deposits (commitment count changes)
 * - New withdrawals (nullifier count changes)
 * - Pool balance changes
 * - Unusual patterns (rapid deposits, large withdrawal bursts)
 *
 * Run: npx tsx scripts/monitor.ts
 *
 * Outputs structured JSON logs to stdout for ingestion by
 * any log aggregator (Datadog, Grafana Loki, CloudWatch, etc.)
 */

export interface MonitorConfig {
  pools: string[];
  relayerAddress: string;
  pollIntervalMs: number;
  alerts: {
    webhookUrl: string;
    emailTo: string;
    thresholds: {
      depositsPerFiveMinutes: number;
      withdrawalsPerMinute: number;
      relayerBalanceWarning: number;
      relayerBalanceCritical: number;
    };
  };
}

export interface MonitorEvent {
  timestamp: string;
  type: "deposit" | "withdrawal" | "balance_change" | "anomaly";
  pool: string;
  data: Record<string, unknown>;
}

export interface PoolSnapshot {
  balance: number;
  depositCount: number;
  withdrawCount: number;
  peakBalance: number;
  recentDeposits: number[];
  recentWithdrawals: number[];
  seenSignatures: Set<string>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const connection = new Connection(
    process.env.SNAP_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const snap = new SNAPClient(connection, Keypair.generate());
  const snapshots = new Map<string, PoolSnapshot>();
  let lastRelayerBalanceCheck = 0;

  for (;;) {
    for (const poolAddress of config.pools) {
      const eventSink = async (event: MonitorEvent) => {
        console.log(JSON.stringify(event));
        if (event.type === "anomaly") {
          await sendWebhookIfConfigured(config, event);
        }
      };

      await inspectPool(connection, snap, poolAddress, snapshots, config, eventSink);
    }

    if (
      config.relayerAddress &&
      Date.now() - lastRelayerBalanceCheck >= 60_000
    ) {
      lastRelayerBalanceCheck = Date.now();
      await inspectRelayerBalance(connection, config);
    }

    await sleep(config.pollIntervalMs);
  }
}

export async function inspectPool(
  connection: Connection,
  snap: SNAPClient,
  poolAddress: string,
  snapshots: Map<string, PoolSnapshot>,
  config: MonitorConfig,
  emit: (event: MonitorEvent) => Promise<void>,
): Promise<void> {
  const pool = new PublicKey(poolAddress);
  const poolInfo = await snap.getPoolInfo(pool);
  const balance = await getPoolBalance(connection, pool, poolInfo.assetType);
  const previous =
    snapshots.get(poolAddress) ??
    ({
      balance,
      depositCount: poolInfo.depositCount,
      withdrawCount: poolInfo.withdrawCount,
      peakBalance: balance,
      recentDeposits: [],
      recentWithdrawals: [],
      seenSignatures: new Set<string>(),
    } satisfies PoolSnapshot);

  if (poolInfo.depositCount > previous.depositCount) {
    previous.recentDeposits.push(Date.now());
    await emit({
      timestamp: new Date().toISOString(),
      type: "deposit",
      pool: poolAddress,
      data: {
        previous: previous.depositCount,
        current: poolInfo.depositCount,
      },
    });
  }

  if (poolInfo.withdrawCount > previous.withdrawCount) {
    previous.recentWithdrawals.push(Date.now());
    await emit({
      timestamp: new Date().toISOString(),
      type: "withdrawal",
      pool: poolAddress,
      data: {
        previous: previous.withdrawCount,
        current: poolInfo.withdrawCount,
      },
    });
  }

  if (balance !== previous.balance) {
    await emit({
      timestamp: new Date().toISOString(),
      type: "balance_change",
      pool: poolAddress,
      data: {
        previous: previous.balance,
        current: balance,
      },
    });
  }

  previous.depositCount = poolInfo.depositCount;
  previous.withdrawCount = poolInfo.withdrawCount;
  previous.balance = balance;
  previous.peakBalance = Math.max(previous.peakBalance, balance);
  previous.recentDeposits = filterRecent(previous.recentDeposits, 5 * 60_000);
  previous.recentWithdrawals = filterRecent(previous.recentWithdrawals, 60_000);

  if (
    previous.recentDeposits.length >
    config.alerts.thresholds.depositsPerFiveMinutes
  ) {
    await emitAnomaly(
      emit,
      poolAddress,
      "rapid_deposits",
      `More than ${config.alerts.thresholds.depositsPerFiveMinutes} deposits in 5 minutes`,
      { depositsInFiveMinutes: previous.recentDeposits.length },
    );
  }

  if (
    previous.recentWithdrawals.length >
    config.alerts.thresholds.withdrawalsPerMinute
  ) {
    await emitAnomaly(
      emit,
      poolAddress,
      "withdrawal_burst",
      `More than ${config.alerts.thresholds.withdrawalsPerMinute} withdrawals in 1 minute`,
      { withdrawalsInMinute: previous.recentWithdrawals.length },
    );
  }

  if (previous.peakBalance > 0 && balance < previous.peakBalance * 0.1) {
    await emitAnomaly(
      emit,
      poolAddress,
      "liquidity_warning",
      "Pool balance dropped below 10% of peak",
      {
        balance,
        peakBalance: previous.peakBalance,
      },
    );
  }

  await inspectRecentTransactions(connection, pool, previous, emit);
  snapshots.set(poolAddress, previous);
}

export async function inspectRecentTransactions(
  connection: Connection,
  pool: PublicKey,
  snapshot: PoolSnapshot,
  emit: (event: MonitorEvent) => Promise<void>,
): Promise<void> {
  const signatures = await connection.getSignaturesForAddress(
    pool,
    { limit: 20 },
    "confirmed",
  );

  for (const entry of signatures) {
    if (snapshot.seenSignatures.has(entry.signature)) {
      continue;
    }

    snapshot.seenSignatures.add(entry.signature);
    const transaction = await connection.getTransaction(entry.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = transaction?.meta?.logMessages ?? [];
    const joinedLogs = logs.join("\n");

    if (
      /custom program error: 0x1773/i.test(joinedLogs) ||
      /already in use/i.test(joinedLogs)
    ) {
      await emit({
        timestamp: new Date().toISOString(),
        type: "anomaly",
        pool: pool.toBase58(),
        data: {
          kind: "nullifier_pda_failure",
          message: "Potential double-spend attempt detected in transaction logs",
          signature: entry.signature,
        },
      });
    }
  }
}

export async function inspectRelayerBalance(
  connection: Connection,
  config: MonitorConfig,
): Promise<void> {
  const relayer = new PublicKey(config.relayerAddress);
  const balance = await connection.getBalance(relayer, "confirmed");
  const thresholds = config.alerts.thresholds;

  if (balance < thresholds.relayerBalanceCritical) {
    await sendWebhookIfConfigured(config, {
      timestamp: new Date().toISOString(),
      type: "anomaly",
      pool: config.pools[0] ?? "",
      data: {
        kind: "relayer_balance_critical",
        balance,
        relayer: relayer.toBase58(),
      },
    });
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "anomaly",
        pool: config.pools[0] ?? "",
        data: {
          kind: "relayer_balance_critical",
          balance,
          relayer: relayer.toBase58(),
        },
      }),
    );
    return;
  }

  if (balance < thresholds.relayerBalanceWarning) {
    await sendWebhookIfConfigured(config, {
      timestamp: new Date().toISOString(),
      type: "anomaly",
      pool: config.pools[0] ?? "",
      data: {
        kind: "relayer_balance_warning",
        balance,
        relayer: relayer.toBase58(),
      },
    });
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "anomaly",
        pool: config.pools[0] ?? "",
        data: {
          kind: "relayer_balance_warning",
          balance,
          relayer: relayer.toBase58(),
        },
      }),
    );
  }
}

export async function getPoolBalance(
  connection: Connection,
  pool: PublicKey,
  assetType: "sol" | "spl",
): Promise<number> {
  const vault = deriveVaultPda(pool);

  if (assetType === "sol") {
    return connection.getBalance(vault, "confirmed");
  }

  const tokenBalance = await connection.getTokenAccountBalance(vault, "confirmed");
  return Number(tokenBalance.value.amount);
}

export function deriveVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), pool.toBuffer()],
    SNAP_PROGRAM_ID,
  )[0];
}

export function loadConfig(): MonitorConfig {
  const configPath =
    process.env.SNAP_MONITOR_CONFIG ??
    path.join(process.cwd(), "scripts", "monitor-config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as MonitorConfig;
}

export function filterRecent(values: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return values.filter((value) => value >= cutoff);
}

export async function emitAnomaly(
  emit: (event: MonitorEvent) => Promise<void>,
  pool: string,
  kind: string,
  message: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await emit({
    timestamp: new Date().toISOString(),
    type: "anomaly",
    pool,
    data: {
      kind,
      message,
      ...extra,
    },
  });
}

export async function sendWebhookIfConfigured(
  config: MonitorConfig,
  event: MonitorEvent,
): Promise<void> {
  if (!config.alerts.webhookUrl) {
    return;
  }

  await fetch(config.alerts.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
