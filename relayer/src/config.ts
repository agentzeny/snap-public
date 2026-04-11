import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID, SNAP_PROGRAM_ID } from "@snap-protocol/sdk";
import {
  DEFAULT_MIN_FEE_LAMPORTS,
  DEFAULT_RELAYER_FEE_BPS,
} from "./fee-calculator";

export interface RelayerConfig {
  rpcUrl: string;
  cluster: "localnet" | "devnet" | "mainnet-beta";
  keypairPath: string;
  poolAddress: string;
  programId: string;
  feeBps: number;
  minFeeLamports: number;
  maxRequestsPerMinutePerIp: number;
  maxRequestsPerMinuteGlobal: number;
  maxRetries: number;
  retryBackoffMs: number[];
  port: number;
  host: string;
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  return {
    rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    cluster: parseCluster(env.SOLANA_CLUSTER ?? "devnet"),
    keypairPath: env.RELAYER_KEYPAIR_PATH ?? "relayer-keypair.json",
    poolAddress:
      env.SNAP_POOL_ADDRESS ?? "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT",
    programId: env.SNAP_PROGRAM_ID ?? SNAP_PROGRAM_ID.toBase58(),
    feeBps: parseInteger(
      env.RELAYER_FEE_BPS ?? String(DEFAULT_RELAYER_FEE_BPS),
      "RELAYER_FEE_BPS",
    ),
    minFeeLamports: parseInteger(
      env.MIN_FEE_LAMPORTS ?? String(DEFAULT_MIN_FEE_LAMPORTS),
      "MIN_FEE_LAMPORTS",
    ),
    maxRequestsPerMinutePerIp: parseInteger(
      env.MAX_REQUESTS_PER_MINUTE_PER_IP ?? "10",
      "MAX_REQUESTS_PER_MINUTE_PER_IP",
    ),
    maxRequestsPerMinuteGlobal: parseInteger(
      env.MAX_REQUESTS_PER_MINUTE_GLOBAL ?? "100",
      "MAX_REQUESTS_PER_MINUTE_GLOBAL",
    ),
    maxRetries: parseInteger(env.MAX_RETRIES ?? "3", "MAX_RETRIES"),
    retryBackoffMs: parseIntegerList(
      env.RETRY_BACKOFF_MS ?? "2000,8000,30000",
      "RETRY_BACKOFF_MS",
    ),
    port: parseInteger(env.RELAYER_PORT ?? env.PORT ?? "3000", "RELAYER_PORT"),
    host: env.RELAYER_HOST ?? "127.0.0.1",
    dbPath: env.RELAYER_DB_PATH ?? "snap-relayer.sqlite",
  };
}

export function loadKeypairFromFile(keypairPath: string): Keypair {
  const resolved = path.resolve(keypairPath);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Relayer: ${name} must be a non-negative integer`);
  }

  return parsed;
}

function parseIntegerList(value: string, name: string): number[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseInteger(entry, name));

  if (entries.length === 0) {
    throw new Error(`Relayer: ${name} must contain at least one integer`);
  }

  return entries;
}

function parseCluster(value: string): "localnet" | "devnet" | "mainnet-beta" {
  if (value === "localnet" || value === "devnet" || value === "mainnet-beta") {
    return value;
  }

  throw new Error(
    "Relayer: SOLANA_CLUSTER must be 'localnet', 'devnet', or 'mainnet-beta'",
  );
}
