import * as anchor from "@coral-xyz/anchor";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { SNAPClient } from "../sdk-package/src";

async function main() {
  console.log("=== Agent B: Withdrawing through the relayer ===\n");

  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const wallet = anchor.Wallet.local();
  const snap = new SNAPClient(connection, wallet);
  const relayerUrl = process.env.RELAYER_URL ?? "http://127.0.0.1:3000";

  console.log("Step 1: Reading the private note...");
  const noteData = JSON.parse(readFileSync("./shared/note.json", "utf8")) as {
    pool: string;
    note: string;
  };
  const pool = new PublicKey(noteData.pool);
  const note = SNAPClient.deserializeNote(noteData.note);
  console.log(`  Pool: ${pool.toBase58()}`);
  console.log(`  Recipient: ${wallet.publicKey.toBase58()}`);

  console.log("Step 2: Asking the relayer to submit the withdrawal...");
  const balanceBefore = await connection.getBalance(wallet.publicKey);
  const result = await snap.withdrawViaRelayer(
    pool,
    note,
    wallet.publicKey,
    relayerUrl,
  );
  const balanceAfter = await connection.getBalance(wallet.publicKey);
  const received = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;

  console.log(`  Relayer URL: ${relayerUrl}`);
  console.log(`  Transaction: ${result.txSignature}`);
  console.log(`  Fee paid to relayer: ${result.fee} SOL`);
  console.log(`  Recipient received: ${received} SOL\n`);

  console.log("=== Privacy preserved ===");
  console.log("On-chain signer: relayer wallet");
  console.log("On-chain recipient: Agent B wallet");
  console.log("Agent B never appeared as the gas payer.\n");
}

main().catch(console.error);
