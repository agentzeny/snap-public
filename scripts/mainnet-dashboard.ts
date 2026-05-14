import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const SDK_DIST = path.resolve(ROOT_DIR, "sdk-package", "dist");
const DEPLOYMENT_PATH = path.join(ROOT_DIR, "mainnet-deployment.json");
const POOLS_PATH = path.join(ROOT_DIR, "mainnet-pools.json");
const TREASURY_CONFIG_PATH = path.join(ROOT_DIR, "treasury-config.json");

function fail(message: string): never {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    fail(`${name} environment variable is required but not set.`);
  }
  return value.trim();
}

function formatLamports(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SNAP_RPC_URL");

  for (const file of [DEPLOYMENT_PATH, POOLS_PATH, TREASURY_CONFIG_PATH]) {
    if (!existsSync(file)) {
      fail(`${path.basename(file)} not found.`);
    }
  }

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  const poolsConfig = JSON.parse(readFileSync(POOLS_PATH, "utf8"));
  const treasuryConfig = JSON.parse(readFileSync(TREASURY_CONFIG_PATH, "utf8"));

  const programId = new PublicKey(deployment.programId);
  const treasuryPubkey = new PublicKey(treasuryConfig.treasuryAddress);

  const connection = new Connection(rpcUrl, "confirmed");
  const { SNAPClient } = require(SDK_DIST);

  const now = new Date().toISOString();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║         SNAP Mainnet Dashboard               ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log(`Timestamp:   ${now}`);
  console.log(`Network:     mainnet-beta`);
  console.log(`Program:     ${programId.toBase58()}`);

  const programAccount = await connection.getAccountInfo(programId);
  console.log(
    `Status:      ${programAccount?.executable ? "LIVE" : "NOT FOUND"}`
  );
  console.log(`Authority:   ${deployment.upgradeAuthority}`);
  console.log("");

  console.log("--- Treasury ---");
  const treasuryBalance = await connection.getBalance(treasuryPubkey);
  console.log(`Address:     ${treasuryPubkey.toBase58()}`);
  console.log(`SOL balance: ${formatLamports(treasuryBalance)}`);
  console.log("");

  console.log("--- Pools ---");
  console.log("");

  let totalDeposits = 0;
  let totalWithdrawals = 0;

  // Use a dummy wallet just for reading — we don't sign anything
  const { Keypair } = require("@solana/web3.js");
  const dummyWallet = Keypair.generate();
  const snap = new SNAPClient(connection, dummyWallet, { programId });

  for (const poolEntry of poolsConfig.pools) {
    const poolPubkey = new PublicKey(poolEntry.address);

    try {
      const info = await snap.getPoolInfo(poolPubkey);

      const deposits = info.depositCount;
      const withdrawals = info.withdrawCount;
      const activeNotes = deposits - withdrawals;

      totalDeposits += deposits;
      totalWithdrawals += withdrawals;

      console.log(`${poolEntry.denominationHuman} (${poolEntry.asset})`);
      console.log(`  Address:    ${poolEntry.address}`);
      console.log(`  Deposits:   ${deposits}`);
      console.log(`  Withdrawals:${withdrawals}`);
      console.log(`  Active:     ${activeNotes} notes`);
      console.log(`  Fee:        ${info.protocolFeeBps} bps`);
      console.log(`  Tree depth: ${info.treeDepth}`);

      if (poolEntry.asset === "SOL") {
        const vaultSeeds = [
          Buffer.from("vault"),
          poolPubkey.toBuffer(),
        ];
        const [vaultPda] = PublicKey.findProgramAddressSync(
          vaultSeeds,
          programId
        );
        const vaultBalance = await connection.getBalance(vaultPda);
        console.log(`  Vault:      ${formatLamports(vaultBalance)}`);
      }

      console.log("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`${poolEntry.denominationHuman}: ERROR — ${msg}`);
      console.log("");
    }
  }

  console.log("--- Totals ---");
  console.log(`Deposits:    ${totalDeposits}`);
  console.log(`Withdrawals: ${totalWithdrawals}`);
  console.log(`Active:      ${totalDeposits - totalWithdrawals} notes across all pools`);
  console.log(`Treasury:    ${formatLamports(treasuryBalance)} collected`);

  if (totalWithdrawals > 0) {
    const avgFeePerWithdrawal = treasuryBalance / totalWithdrawals;
    console.log(`Avg fee:     ${formatLamports(Math.round(avgFeePerWithdrawal))} per withdrawal`);
  }

  console.log("");

  const relayerUrl = process.env.SNAP_RELAYER_URL ?? "http://localhost:3000";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${relayerUrl}/info`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const info = await res.json();
      console.log("--- Relayer ---");
      console.log(`URL:         ${relayerUrl}`);
      console.log(`Status:      ONLINE`);
      console.log(`Fee:         ${(info as any).feeBps ?? "unknown"} bps`);
    } else {
      console.log("--- Relayer ---");
      console.log(`URL:         ${relayerUrl}`);
      console.log(`Status:      ERROR (HTTP ${res.status})`);
    }
  } catch {
    console.log("--- Relayer ---");
    console.log(`URL:         ${relayerUrl}`);
    console.log(`Status:      OFFLINE`);
  }

  console.log("");
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
