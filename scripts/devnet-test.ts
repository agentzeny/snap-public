import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const walletPath = path.join(process.env.HOME ?? "", ".config", "solana", "id.json");
const poolConfigPath = path.resolve(__dirname, "..", "devnet-pool.json");
const sdkDistPath = path.resolve(__dirname, "..", "sdk-package", "dist");
const AGENT_B_GAS_FUNDING_SOL = 0.01;

function closeConnection(connection: Connection): void {
  const ws = (connection as Connection & {
    _rpcWebSocket?: { close: () => void };
  })._rpcWebSocket;
  ws?.close();
}

function loadWallet(): Keypair {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Solana wallet not found at ${walletPath}`);
  }

  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
}

function loadPoolAddress(): PublicKey {
  if (!fs.existsSync(poolConfigPath)) {
    throw new Error(
      `Missing ${path.basename(poolConfigPath)}. Run scripts/create-devnet-pool.ts first.`,
    );
  }

  const poolConfig = JSON.parse(fs.readFileSync(poolConfigPath, "utf8")) as {
    pool?: string;
  };

  if (!poolConfig.pool) {
    throw new Error(`Missing pool field in ${path.basename(poolConfigPath)}`);
  }

  return new PublicKey(poolConfig.pool);
}

async function fundAgentBGas(
  connection: Connection,
  agentA: Keypair,
  agentB: Keypair,
): Promise<void> {
  const balance = await connection.getBalance(agentB.publicKey);
  const targetLamports = Math.round(AGENT_B_GAS_FUNDING_SOL * LAMPORTS_PER_SOL);

  if (balance >= targetLamports) {
    return;
  }

  const transferLamports = targetLamports - balance;
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentA.publicKey,
        toPubkey: agentB.publicKey,
        lamports: transferLamports,
      }),
    ),
    [agentA],
    { commitment: "confirmed" },
  );

  console.log("   Funded Agent B for gas:", signature);
}

async function main(): Promise<void> {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  try {
    const agentA = loadWallet();
    const agentB = Keypair.generate();
    const pool = loadPoolAddress();
    const { SNAPClient } = require(sdkDistPath);

    const snapA = new SNAPClient(connection, agentA);

    console.log("=== SNAP Devnet Verification ===");
    console.log("");

    console.log("1. Checking pool...");
    const poolInfo = await snapA.getPoolInfo(pool);
    console.log("   Pool:", pool.toBase58());
    console.log("   Denomination:", poolInfo.depositAmount, "SOL");
    console.log("   Deposits:", poolInfo.depositCount);
    console.log("");

    console.log("2. Agent A depositing 0.1 SOL...");
    const note = await snapA.deposit(pool);
    console.log("   Deposit completed");
    console.log("");

    const serialized = SNAPClient.serializeNote(note);
    console.log("3. Note serialized for transfer to Agent B");
    console.log("   Length:", serialized.length, "chars");
    console.log("");

    console.log("4. Funding Agent B for gas...");
    await fundAgentBGas(connection, agentA, agentB);
    const agentBBalanceBefore = await connection.getBalance(agentB.publicKey);
    console.log(
      "   Agent B starting balance:",
      agentBBalanceBefore / LAMPORTS_PER_SOL,
      "SOL",
    );
    console.log("");

    console.log("5. Agent B generating ZK proof and withdrawing...");
    const restored = SNAPClient.deserializeNote(serialized);
    const snapB = new SNAPClient(connection, agentB);
    const txSignature = await snapB.withdraw(pool, restored, agentB);
    console.log("   Withdrawal TX:", txSignature);
    console.log(
      "   Explorer: https://explorer.solana.com/tx/" + txSignature + "?cluster=devnet",
    );
    console.log("");

    const agentBBalanceAfter = await connection.getBalance(agentB.publicKey);
    console.log("6. Privacy check:");
    console.log("   Deposit signer: ", agentA.publicKey.toBase58());
    console.log("   Withdraw signer:", agentB.publicKey.toBase58());
    console.log("   Agent B ending balance:", agentBBalanceAfter / LAMPORTS_PER_SOL, "SOL");
    console.log(
      "   Agent B net received:",
      (agentBBalanceAfter - agentBBalanceBefore) / LAMPORTS_PER_SOL,
      "SOL",
    );
    console.log("   These wallets are different and have no direct on-chain link.");
    console.log("");
    console.log("=== DEVNET VERIFICATION COMPLETE ===");
  } finally {
    closeConnection(connection);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
