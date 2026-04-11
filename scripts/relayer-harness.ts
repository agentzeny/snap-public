import fs from "fs";
import path from "path";
import http from "http";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { SNAP_PROGRAM_ID } from "../sdk-package/src";
import { createRelayerApp } from "../relayer/src";
import { RelayerMetrics } from "../relayer/src/metrics";
import { RateLimiter } from "../relayer/src/rate-limiter";
import { RetryManager } from "../relayer/src/retry";
import { ProductionRelayService } from "../relayer/src/service";
import { RelayStore } from "../relayer/src/store";
import type { RelayerConfig } from "../relayer/src/config";
import { AnchorRelayerRuntime } from "../relayer/src/tx-builder";

export interface RelayerHarness {
  baseUrl: string;
  config: RelayerConfig;
  retryManager: RetryManager;
  server: http.Server;
  service: ProductionRelayService;
  store: RelayStore;
}

export interface StartRelayerHarnessOptions {
  cluster: "localnet" | "devnet" | "mainnet-beta";
  connection: Connection;
  dbPath: string;
  feeBps?: number;
  host?: string;
  maxRequestsPerMinuteGlobal?: number;
  maxRequestsPerMinutePerIp?: number;
  maxRetries?: number;
  minFeeLamports?: number;
  pool: PublicKey;
  port?: number;
  programId?: PublicKey;
  relayer: Keypair;
  retryBackoffMs?: number[];
  retryPollIntervalMs?: number;
}

export async function startRelayerHarness(
  options: StartRelayerHarnessOptions,
): Promise<RelayerHarness> {
  const programId = options.programId ?? SNAP_PROGRAM_ID;
  const config: RelayerConfig = {
    rpcUrl: options.connection.rpcEndpoint,
    cluster: options.cluster,
    keypairPath: "",
    poolAddress: options.pool.toBase58(),
    programId: programId.toBase58(),
    feeBps: options.feeBps ?? 50,
    minFeeLamports: options.minFeeLamports ?? 10_000,
    maxRequestsPerMinutePerIp: options.maxRequestsPerMinutePerIp ?? 25,
    maxRequestsPerMinuteGlobal: options.maxRequestsPerMinuteGlobal ?? 250,
    maxRetries: options.maxRetries ?? 3,
    retryBackoffMs: options.retryBackoffMs ?? [1000, 3000, 8000],
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
    dbPath: options.dbPath,
  };

  const runtime = new AnchorRelayerRuntime(
    options.connection,
    options.relayer,
    programId,
  );
  const store = new RelayStore(config.dbPath);
  const rateLimiter = new RateLimiter({
    store,
    maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
    maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
  });
  const service = new ProductionRelayService({
    config,
    metrics: new RelayerMetrics(),
    rateLimiter,
    runtime,
    store,
  });
  const retryManager = new RetryManager(store, {
    pollIntervalMs: options.retryPollIntervalMs ?? 1000,
    processor: async (record) => {
      await service.processRecord(record);
    },
  });
  retryManager.start();

  const server = createRelayerApp(service).listen(config.port, config.host);
  await onceListening(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine relayer listening address");
  }

  return {
    baseUrl: `http://${config.host}:${address.port}`,
    config,
    retryManager,
    server,
    service,
    store,
  };
}

export async function stopRelayerHarness(
  harness: RelayerHarness | undefined,
): Promise<void> {
  if (!harness) {
    return;
  }

  harness.retryManager.stop();
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function assertBalanceAtLeast(
  connection: Connection,
  address: PublicKey,
  minimumLamports: number,
  label: string,
): Promise<number> {
  const balance = await connection.getBalance(address, "confirmed");
  if (balance < minimumLamports) {
    throw new Error(
      `${label} ${address.toBase58()} only has ${balance} lamports; requires at least ${minimumLamports}`,
    );
  }

  return balance;
}

export async function ensureRelayerBalance(
  connection: Connection,
  payer: Keypair,
  relayer: PublicKey,
  targetLamports: number,
): Promise<{
  balanceBefore: number;
  topUpLamports: number;
  topUpSignature: string | null;
}> {
  const balanceBefore = await connection.getBalance(relayer, "confirmed");
  const topUpLamports = Math.max(0, targetLamports - balanceBefore);
  if (topUpLamports === 0) {
    return {
      balanceBefore,
      topUpLamports: 0,
      topUpSignature: null,
    };
  }

  const topUpSignature = await connection.sendTransaction(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        lamports: topUpLamports,
        toPubkey: relayer,
      }),
    ),
    [payer],
  );
  await connection.confirmTransaction(topUpSignature, "confirmed");

  return {
    balanceBefore,
    topUpLamports,
    topUpSignature,
  };
}

export async function drainRelayerBalance(
  connection: Connection,
  relayer: Keypair,
  recipient: PublicKey,
  reserveLamports = 20_000,
  feePayer?: Keypair,
): Promise<{
  balanceBefore: number;
  balanceAfter: number;
  refundLamports: number;
  refundSignature: string | null;
}> {
  return drainSystemAccountBalance(
    connection,
    relayer,
    recipient,
    reserveLamports,
    feePayer,
  );
}

export async function drainSystemAccountBalance(
  connection: Connection,
  source: Keypair,
  recipient: PublicKey,
  reserveLamports = 0,
  feePayer?: Keypair,
): Promise<{
  balanceBefore: number;
  balanceAfter: number;
  refundLamports: number;
  refundSignature: string | null;
}> {
  const balanceBefore = await connection.getBalance(source.publicKey, "confirmed");
  const payer = feePayer ?? source;
  const minimumBalance = Math.max(
    reserveLamports,
    await connection.getMinimumBalanceForRentExemption(0),
  );
  const refundLamports = Math.max(0, balanceBefore - minimumBalance);
  let refundSignature: string | null = null;

  if (refundLamports > 0) {
    const transaction = new Transaction({
      feePayer: payer.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: source.publicKey,
        lamports: refundLamports,
        toPubkey: recipient,
      }),
    );
    const signers = payer.publicKey.equals(source.publicKey)
      ? [source]
      : [payer, source];
    refundSignature = await connection.sendTransaction(transaction, signers);
    await connection.confirmTransaction(refundSignature, "confirmed");
  }

  return {
    balanceBefore,
    balanceAfter: await connection.getBalance(source.publicKey, "confirmed"),
    refundLamports,
    refundSignature,
  };
}

export async function drainSystemAccountBalances(
  connection: Connection,
  sources: Keypair[],
  recipient: PublicKey,
  feePayer: Keypair,
): Promise<{
  refundedLamports: number;
  results: Array<{
    address: string;
    balanceAfter: number;
    balanceBefore: number;
    refundLamports: number;
    refundSignature: string | null;
  }>;
}> {
  const results = [];

  for (const source of sources) {
    const refund = await drainSystemAccountBalance(
      connection,
      source,
      recipient,
      0,
      feePayer,
    );
    results.push({
      address: source.publicKey.toBase58(),
      ...refund,
    });
  }

  return {
    refundedLamports: results.reduce(
      (total, result) => total + result.refundLamports,
      0,
    ),
    results,
  };
}

export async function fetchJson(
  url: string,
): Promise<{
  body: unknown;
  status: number;
}> {
  const response = await fetch(url);
  return {
    body: await response.json(),
    status: response.status,
  };
}

export async function fetchText(
  url: string,
): Promise<{
  body: string;
  status: number;
}> {
  const response = await fetch(url);
  return {
    body: await response.text(),
    status: response.status,
  };
}

export function closeConnection(connection: Connection): void {
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

export function loadKeypair(filePath: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export async function onceListening(server: http.Server): Promise<void> {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

export async function waitForNewSignature(
  connection: Connection,
  address: PublicKey,
  seen: Set<string>,
  label = address.toBase58(),
  timeoutMs = 30_000,
): Promise<string> {
  const startedAt = Date.now();

  for (;;) {
    const signatures = await connection.getSignaturesForAddress(
      address,
      { limit: 10 },
      "confirmed",
    );
    const unseen = signatures.find((entry) => !seen.has(entry.signature));
    if (unseen) {
      return unseen.signature;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for a new signature on ${label}`);
    }

    await sleep(1000);
  }
}

export function writeJsonArtifact(
  outputPath: string,
  value: unknown,
  options: {
    mode?: number;
  } = {},
): void {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    mode: options.mode,
  });
  if (options.mode !== undefined) {
    fs.chmodSync(resolved, options.mode);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
