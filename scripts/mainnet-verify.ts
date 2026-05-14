import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const ROOT_DIR = process.cwd();
const SDK_DIST = path.resolve(ROOT_DIR, "sdk-package", "dist");
const WALLET_PATH = path.join(
  process.env.HOME ?? "",
  ".config",
  "solana",
  "id.json"
);
const DEPLOYMENT_PATH = path.join(ROOT_DIR, "mainnet-deployment.json");
const POOLS_PATH = path.join(ROOT_DIR, "mainnet-pools.json");
const TREASURY_CONFIG_PATH = path.join(ROOT_DIR, "treasury-config.json");

function fail(message: string): never {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function loadWallet(): Keypair {
  if (!existsSync(WALLET_PATH)) {
    fail(`Solana wallet not found at ${WALLET_PATH}`);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8")))
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    fail(`${name} environment variable is required but not set.`);
  }
  return value.trim();
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SNAP_RPC_URL");

  console.log("=== SNAP Mainnet Verification ===");
  console.log("");

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

  const wallet = loadWallet();
  const connection = new Connection(rpcUrl, "confirmed");
  const { SNAPClient } = require(SDK_DIST);

  const programAccount = await connection.getAccountInfo(programId);
  if (!programAccount || !programAccount.executable) {
    fail("Program is not live or not executable.");
  }
  console.log(`Program:     ${programId.toBase58()} — LIVE`);
  console.log(`Treasury:    ${treasuryPubkey.toBase58()}`);
  console.log("");

  const snap = new SNAPClient(connection, wallet, { programId });

  let allPoolsOk = true;
  for (const poolEntry of poolsConfig.pools) {
    const poolPubkey = new PublicKey(poolEntry.address);
    try {
      const info = await snap.getPoolInfo(poolPubkey);
      const k = info.depositCount;
      const feeBps = info.protocolFeeBps;
      console.log(
        `Pool:        ${poolEntry.address} — ${poolEntry.denominationHuman} — k=${k} — fee=${feeBps}bps — LIVE`
      );

      if (feeBps !== poolEntry.protocolFeeBps) {
        console.log(`  [WARN] Expected fee=${poolEntry.protocolFeeBps}bps, got ${feeBps}bps`);
        allPoolsOk = false;
      }
      if (info.treeDepth !== poolEntry.treeDepth) {
        console.log(`  [WARN] Expected depth=${poolEntry.treeDepth}, got ${info.treeDepth}`);
        allPoolsOk = false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`Pool:        ${poolEntry.address} — ${poolEntry.denominationHuman} — FAIL: ${msg}`);
      allPoolsOk = false;
    }
  }

  console.log("");

  if (!allPoolsOk) {
    fail("One or more pool checks failed. Fix before proceeding.");
  }

  const solPool = poolsConfig.pools.find(
    (p: any) => p.asset === "SOL"
  );
  if (!solPool) {
    fail("No SOL pool found for verification canary.");
  }

  console.log("--- Verification Canary (0.1 SOL pool) ---");
  console.log("");
  console.log("This will deposit and withdraw 0.1 SOL on mainnet to verify fee collection.");

  const answer = await prompt("Type 'verify' to proceed: ");
  if (answer !== "verify") {
    console.log("Canary skipped. Pool state checks passed.");
    return;
  }

  const solPoolPubkey = new PublicKey(solPool.address);
  const poolInfo = await snap.getPoolInfo(solPoolPubkey);

  const treasuryBalanceBefore = await connection.getBalance(treasuryPubkey);

  console.log("");
  console.log("Depositing...");
  const note = await snap.deposit(solPoolPubkey);
  console.log(`  Deposit:   confirmed (index ${note.depositIndex})`);

  const recipient = Keypair.generate();
  console.log("Withdrawing...");
  const withdrawResult = await snap.withdrawWithResult(
    solPoolPubkey,
    note,
    recipient
  );
  console.log(`  Withdraw:  confirmed`);

  await new Promise((r) => setTimeout(r, 2000));
  const treasuryBalanceAfter = await connection.getBalance(treasuryPubkey);
  const treasuryDelta = treasuryBalanceAfter - treasuryBalanceBefore;

  const depositAmountRaw = poolInfo.depositAmountRaw;
  const expectedFeeBps = poolInfo.protocolFeeBps;
  const expectedFeeRaw = Math.floor(
    (depositAmountRaw * expectedFeeBps) / 10_000
  );
  const expectedRecipient = depositAmountRaw - expectedFeeRaw;

  const recipientBalance = await connection.getBalance(recipient.publicKey);

  console.log("");
  console.log("Fee check:");
  console.log(`  Deposit amount:     ${depositAmountRaw} lamports (${poolInfo.depositAmount} SOL)`);
  console.log(`  Protocol fee:       ${expectedFeeRaw} lamports (${expectedFeeBps / 100}%)`);
  console.log(`  Recipient received: ${recipientBalance} lamports`);
  console.log(`  Treasury delta:     ${treasuryDelta >= 0 ? "+" : ""}${treasuryDelta} lamports`);

  let feeCheckOk = true;

  if (treasuryDelta !== expectedFeeRaw) {
    console.log(
      `  [WARN] Expected treasury delta ${expectedFeeRaw}, got ${treasuryDelta}`
    );
    feeCheckOk = false;
  } else {
    console.log("  Treasury delta matches expected fee ✓");
  }

  if (recipientBalance < expectedRecipient - 5000) {
    console.log(
      `  [WARN] Recipient received less than expected (${expectedRecipient} - rent)`
    );
    feeCheckOk = false;
  }

  // Drain canary recipient back to deployer
  try {
    const { Transaction, SystemProgram } = require("@solana/web3.js");
    if (recipientBalance > 5000) {
      const drainTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: recipient.publicKey,
          toPubkey: wallet.publicKey,
          lamports: recipientBalance - 5000,
        })
      );
      await connection.sendTransaction(drainTx, [recipient]);
    }
  } catch {
    // non-critical
  }

  console.log("");
  if (feeCheckOk) {
    console.log("=== ALL CHECKS PASSED ===");
  } else {
    console.log("=== CHECKS COMPLETED WITH WARNINGS ===");
    console.log("Review the warnings above before proceeding.");
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
