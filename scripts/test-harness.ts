#!/usr/bin/env -S npx tsx

/**
 * SNAP Interactive Test Harness
 *
 * This walks a first user through a complete private payment on Solana devnet.
 * Run: npx tsx scripts/test-harness.ts
 *
 * Requirements:
 *   - Node.js 18+
 *   - npm install snap-solana-sdk @solana/web3.js @coral-xyz/anchor
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";

const SNAP_PACKAGE = "snap-solana-sdk";
const PROGRAM_ID = new PublicKey("9uePoqdgaXpqFLQM2ED1GGQrwSEiqe3r6tW1AfsnrrbS");
const DEVNET_POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const WALLET_DIR = join(process.cwd(), ".snap-test-harness");
const MIN_AGENT_A_BALANCE = Math.round(0.2 * LAMPORTS_PER_SOL);
const MIN_AGENT_B_BALANCE = Math.round(0.02 * LAMPORTS_PER_SOL);

type SnapSdkModule = {
  SNAPClient: {
    new (connection: Connection, wallet: Keypair): {
      deposit(pool: PublicKey, amount?: number): Promise<unknown>;
      withdraw(
        pool: PublicKey,
        note: unknown,
        recipient: Keypair | PublicKey,
      ): Promise<string>;
    };
    serializeNote(note: unknown): string;
    deserializeNote(data: string): unknown;
  };
};

function printHeader(text: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${"=".repeat(60)}\n`);
}

function formatSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

function loadOrCreateKeypair(name: string): Keypair {
  const file = join(WALLET_DIR, `${name}.json`);

  if (existsSync(file)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]),
    );
  }

  mkdirSync(WALLET_DIR, { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey), null, 2));
  return keypair;
}

async function loadSnapSdk(): Promise<SnapSdkModule> {
  try {
    const sdk = (await import(SNAP_PACKAGE)) as Partial<SnapSdkModule>;
    if (!sdk.SNAPClient) {
      throw new Error("SNAPClient export missing");
    }
    return sdk as SnapSdkModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Install the SDK before running this harness: npm install ${SNAP_PACKAGE} @solana/web3.js @coral-xyz/anchor (${message})`,
    );
  }
}

async function tryAirdrop(
  connection: Connection,
  wallet: Keypair,
  label: string,
): Promise<void> {
  try {
    const signature = await connection.requestAirdrop(
      wallet.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(signature, "confirmed");
    console.log(`Requested 1 SOL for ${label}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Automatic airdrop for ${label} failed: ${message}`);
  }
}

async function ensureBalance(
  connection: Connection,
  wallet: Keypair,
  label: string,
  minimumLamports: number,
  manualAmount: string,
  prompt: (query: string) => Promise<string>,
): Promise<void> {
  const startingBalance = await connection.getBalance(wallet.publicKey);
  if (startingBalance >= minimumLamports) {
    console.log(`${label} balance: ${formatSol(startingBalance)}`);
    return;
  }

  console.log(`${label} needs devnet SOL. Trying an automatic airdrop...`);
  await tryAirdrop(connection, wallet, label);

  const currentBalance = await connection.getBalance(wallet.publicKey);
  if (currentBalance >= minimumLamports) {
    console.log(`${label} balance: ${formatSol(currentBalance)}`);
    return;
  }

  console.log(`Fund ${label} manually, then come back here:`);
  console.log(
    `  solana airdrop ${manualAmount} ${wallet.publicKey.toBase58()} --url devnet`,
  );
  console.log("  or use https://faucet.solana.com");
  await prompt(`Press Enter after funding ${label}...`);

  const fundedBalance = await connection.getBalance(wallet.publicKey);
  if (fundedBalance < minimumLamports) {
    throw new Error(
      `${label} still has only ${formatSol(fundedBalance)}. The harness needs at least ${formatSol(minimumLamports)}.`,
    );
  }

  console.log(`${label} balance: ${formatSol(fundedBalance)}`);
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  try {
    printHeader("SNAP — Shield Network Agent Payments");
    console.log("This test harness walks through a complete private payment.");
    console.log("Wallets are stored locally so faucet retries can reuse them.\n");
    console.log("Package:    ", SNAP_PACKAGE);
    console.log("Program ID: ", PROGRAM_ID.toBase58());
    console.log("Pool:       ", DEVNET_POOL.toBase58());
    console.log("Network:    ", "Solana Devnet");
    console.log("Wallet dir: ", WALLET_DIR);

    printHeader("Step 1: Create or Reuse Agent Wallets");

    const agentA = loadOrCreateKeypair("agent-a");
    const agentB = loadOrCreateKeypair("agent-b");

    console.log("Agent A (sender):  ", agentA.publicKey.toBase58());
    console.log("Agent B (receiver):", agentB.publicKey.toBase58());
    console.log("");
    console.log("Agent A needs enough SOL for a 0.1 SOL deposit plus fees.");
    console.log("Agent B needs a small amount of SOL to pay the withdrawal fee.\n");

    await ensureBalance(
      connection,
      agentA,
      "Agent A",
      MIN_AGENT_A_BALANCE,
      "1",
      (query) => rl.question(query),
    );
    await ensureBalance(
      connection,
      agentB,
      "Agent B",
      MIN_AGENT_B_BALANCE,
      "0.1",
      (query) => rl.question(query),
    );

    printHeader("Step 2: Agent A Deposits into the Shielded Pool");

    console.log("Loading SNAP SDK...");
    const { SNAPClient } = await loadSnapSdk();
    const snapA = new SNAPClient(connection, agentA);

    console.log("Depositing 0.1 SOL...");
    const note = await snapA.deposit(DEVNET_POOL, 0.1);
    console.log("Deposit confirmed.");
    console.log("");
    console.log("A secret note was generated. In production, Agent A would");
    console.log("send it to Agent B over an encrypted off-chain channel.");

    const serialized = SNAPClient.serializeNote(note);
    console.log("\nSerialized note length:", serialized.length, "characters");

    await rl.question("\nPress Enter to continue to withdrawal...");

    printHeader("Step 3: Agent B Withdraws with a ZK Proof");

    console.log("Agent B received the note off-chain.");
    console.log("Generating the Groth16 proof and submitting the withdrawal...");

    const restored = SNAPClient.deserializeNote(serialized);
    const snapB = new SNAPClient(connection, agentB);
    const startedAt = Date.now();
    const txSignature = await snapB.withdraw(DEVNET_POOL, restored, agentB);
    const elapsedMs = Date.now() - startedAt;

    console.log("\nWithdrawal confirmed.");
    console.log("Proof + transaction time:", `${elapsedMs} ms`);
    console.log("Transaction:", txSignature);
    console.log(
      "Explorer:",
      `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`,
    );

    printHeader("Step 4: Privacy Verification");

    const [balanceA, balanceB] = await Promise.all([
      connection.getBalance(agentA.publicKey),
      connection.getBalance(agentB.publicKey),
    ]);

    console.log("Agent A balance:", formatSol(balanceA));
    console.log("Agent B balance:", formatSol(balanceB));
    console.log("");
    console.log("Deposit signer: ", agentA.publicKey.toBase58());
    console.log("Withdraw signer:", agentB.publicKey.toBase58());
    console.log("");
    console.log("An on-chain observer can see:");
    console.log("  - someone deposited 0.1 SOL into the pool");
    console.log("  - someone withdrew 0.1 SOL from the pool");
    console.log("  - a valid ZK proof was submitted");
    console.log("");
    console.log("An on-chain observer cannot see:");
    console.log("  - that Agent A paid Agent B");
    console.log("  - which earlier deposit Agent B withdrew");

    printHeader("Test Complete");
    console.log("SNAP is working on Solana devnet.");
    console.log("");
    console.log("To integrate this into your own agent workflow:");
    console.log(`  npm install ${SNAP_PACKAGE} @solana/web3.js @coral-xyz/anchor`);
    console.log("");
    console.log('  const snap = new SNAPClient(connection, wallet);');
    console.log("  const note = await snap.deposit(pool, 0.1);");
    console.log("  await snap.withdraw(pool, note, recipient);");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error("\nSNAP test harness failed:");
  console.error(`  ${message}`);

  if (/Install the SDK before running this harness/i.test(message)) {
    console.error("  Run the install command above, then rerun the harness.");
  }

  if (/Pool not found|Account not found|specified pool account does not exist/i.test(message)) {
    console.error(
      `  Verify the live pool exists: solana account ${DEVNET_POOL.toBase58()} --url devnet`,
    );
    console.error("  You can also run: npx tsx scripts/health-check.ts");
  }

  if (/429|airdrop|faucet/i.test(message)) {
    console.error("  Devnet faucet traffic is bursty. Wait 30 seconds and retry.");
  }

  process.exit(1);
});
