import * as anchor from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "fs";
import { SNAPClient } from "../sdk-package/src";

async function main() {
  console.log("=== Agent A: Initiating private payment to Agent B ===\n");

  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const wallet = anchor.Wallet.local();
  const snap = new SNAPClient(connection, wallet);

  console.log("Step 1: Creating shielded pool...");
  const pool = await snap.createPool(0.1);
  console.log(`  Pool created: ${pool.toBase58()}`);

  console.log("Step 2: Depositing 0.1 SOL into the pool...");
  const note = await snap.deposit(pool, 0.1);
  console.log(`  Deposit index: ${note.depositIndex}`);

  console.log("Step 3: Sharing the private note with Agent B off-chain...");
  mkdirSync("./shared", { recursive: true });
  writeFileSync(
    "./shared/note.json",
    JSON.stringify(
      {
        pool: pool.toBase58(),
        note: SNAPClient.serializeNote(note),
      },
      null,
      2,
    ),
  );
  console.log("  Shared note written to shared/note.json\n");

  console.log("=== Agent A complete ===");
  console.log("Observer view: a pool was created and funded.");
  console.log("Observer cannot tell who will later receive the withdrawal.\n");
}

main().catch(console.error);
