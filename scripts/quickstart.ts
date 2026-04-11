#!/usr/bin/env -S npx ts-node

/**
 * SNAP Quickstart — Private Agent Payments on Solana
 *
 * Run this script to see a complete private payment in action:
 *   npx ts-node scripts/quickstart.ts
 *
 * What happens:
 *   1. Two agents are created (Agent A = sender, Agent B = receiver)
 *   2. Agent A deposits 0.1 SOL into the shielded pool
 *   3. A secret note is generated and "transferred" to Agent B
 *   4. Agent B generates a ZK proof and withdraws the SOL
 *   5. An on-chain observer cannot link the deposit to the withdrawal
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPClient } from "@snap-protocol/sdk";

const DEVNET_POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const KEYPAIR_DIR = join(process.cwd(), ".snap-quickstart");
const MIN_AGENT_A_BALANCE = Math.round(0.2 * LAMPORTS_PER_SOL);
const MIN_AGENT_B_BALANCE = Math.round(0.02 * LAMPORTS_PER_SOL);

function loadOrCreateKeypair(name: string): Keypair {
  const file = join(KEYPAIR_DIR, `${name}.json`);
  if (existsSync(file)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]),
    );
  }

  mkdirSync(KEYPAIR_DIR, { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

async function ensureBalance(
  connection: Connection,
  wallet: Keypair,
  minimumLamports: number,
  label: string,
): Promise<boolean> {
  const startingBalance = await connection.getBalance(wallet.publicKey);
  if (startingBalance >= minimumLamports) {
    return true;
  }

  console.log(`${label} needs devnet SOL. Attempting an airdrop...`);

  try {
    const signature = await connection.requestAirdrop(
      wallet.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(signature, "confirmed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Automatic airdrop failed: ${message}`);
  }

  const currentBalance = await connection.getBalance(wallet.publicKey);
  if (currentBalance >= minimumLamports) {
    return true;
  }

  console.log(`Fund ${label} and rerun this script:`);
  console.log(
    `  solana airdrop 1 ${wallet.publicKey.toBase58()} --url devnet`,
  );
  console.log("  or use https://faucet.solana.com");
  return false;
}

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const agentA = loadOrCreateKeypair("agent-a");
  const agentB = loadOrCreateKeypair("agent-b");

  console.log("SNAP Quickstart — Private Agent Payments on Solana\n");
  console.log("Agent A wallet:", agentA.publicKey.toBase58());
  console.log("Agent B wallet:", agentB.publicKey.toBase58());
  console.log("Pool:", DEVNET_POOL.toBase58());
  console.log("");

  const senderReady = await ensureBalance(
    connection,
    agentA,
    MIN_AGENT_A_BALANCE,
    "Agent A",
  );
  const recipientReady = await ensureBalance(
    connection,
    agentB,
    MIN_AGENT_B_BALANCE,
    "Agent B",
  );

  if (!senderReady || !recipientReady) {
    return;
  }

  const snapA = new SNAPClient(connection, agentA);
  const snapB = new SNAPClient(connection, agentB);

  console.log("1. Agent A depositing 0.1 SOL into the shielded pool...");
  const note = await snapA.deposit(DEVNET_POOL, 0.1);
  console.log("   Deposit confirmed.\n");

  console.log("2. Transferring the note to Agent B through an off-chain channel...");
  const serialized = SNAPClient.serializeNote(note);
  console.log(`   Serialized note length: ${serialized.length} characters.\n`);

  console.log("3. Agent B generating a ZK proof and withdrawing...");
  console.log("   First proof generation may take a few seconds.");
  const restored = SNAPClient.deserializeNote(serialized);
  const tx = await snapB.withdraw(DEVNET_POOL, restored, agentB);

  const [balanceA, balanceB] = await Promise.all([
    connection.getBalance(agentA.publicKey),
    connection.getBalance(agentB.publicKey),
  ]);

  console.log("\nWithdrawal confirmed!");
  console.log("TX:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  console.log("");
  console.log("Agent A balance:", balanceA / LAMPORTS_PER_SOL, "SOL");
  console.log("Agent B balance:", balanceB / LAMPORTS_PER_SOL, "SOL");
  console.log("");
  console.log("What an on-chain observer can see:");
  console.log("  - a public deposit into the shielded pool");
  console.log("  - a public withdrawal to Agent B");
  console.log("What they cannot see:");
  console.log("  - the private note transferred off-chain");
  console.log("  - which deposit Agent B proved ownership of");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error("\nSNAP quickstart failed:");
  console.error(`  ${message}`);

  if (/Pool not found|Account not found/i.test(message)) {
    console.error(
      `  Verify the live pool exists: solana account ${DEVNET_POOL.toBase58()} --url devnet`,
    );
  }

  if (/429|airdrop|faucet/i.test(message)) {
    console.error("  Devnet faucet traffic is bursty. Wait 30 seconds and retry.");
  }

  process.exitCode = 1;
});
