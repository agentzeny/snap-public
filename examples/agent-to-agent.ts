import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { SNAPClient } from "../sdk-package/src";

const DEVNET_POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const NOTE_FILE = resolve("examples/.snap-note.json");
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

async function ensureBalance(wallet: Keypair, minimumSol: number): Promise<void> {
  const requiredLamports = Math.round(minimumSol * LAMPORTS_PER_SOL);
  if ((await connection.getBalance(wallet.publicKey)) >= requiredLamports) {
    return;
  }

  try {
    await connection.confirmTransaction(
      await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL),
      "confirmed",
    );
  } catch {
    throw new Error(
      `Fund ${wallet.publicKey.toBase58()} with: solana airdrop 1 ${wallet.publicKey.toBase58()} --url devnet`,
    );
  }
}

async function main(): Promise<void> {
  // Step 1: Create two agents and fund them independently on devnet.
  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  await ensureBalance(agentA, 0.2);
  await ensureBalance(agentB, 0.02);

  // Step 2: Agent A deposits and writes the serialized note to a shared file.
  const sender = new SNAPClient(connection, agentA);
  const note = await sender.deposit(DEVNET_POOL, 0.1);
  await mkdir(dirname(NOTE_FILE), { recursive: true });
  await writeFile(
    NOTE_FILE,
    JSON.stringify(
      {
        pool: DEVNET_POOL.toBase58(),
        note: SNAPClient.serializeNote(note),
      },
      null,
      2,
    ),
  );
  console.log(`Agent A deposited 0.1 SOL and wrote ${NOTE_FILE}.`);

  // Step 3: Agent B reads the note from the file and withdraws privately.
  const payload = JSON.parse(await readFile(NOTE_FILE, "utf8")) as {
    pool: string;
    note: string;
  };
  const receiver = new SNAPClient(connection, agentB);
  const tx = await receiver.withdraw(
    new PublicKey(payload.pool),
    SNAPClient.deserializeNote(payload.note),
    agentB,
  );

  // Step 4: Show the result, then delete the simulated off-chain message.
  await rm(NOTE_FILE, { force: true });
  console.log("Agent B withdrawal:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);
  console.log("Agent A wallet:", agentA.publicKey.toBase58());
  console.log("Agent B wallet:", agentB.publicKey.toBase58());
  console.log("The shared file simulated an encrypted DM or private message bus.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error("Retry after funding the printed wallet address on devnet.");
  process.exitCode = 1;
});
