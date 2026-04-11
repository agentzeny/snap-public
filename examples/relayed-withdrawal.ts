import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { SNAPClient } from "../sdk-package/src";

const DEVNET_POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const RELAYER_URL = process.env.RELAYER_URL ?? "http://127.0.0.1:3000";
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

async function ensureSenderBalance(sender: Keypair): Promise<void> {
  if ((await connection.getBalance(sender.publicKey)) >= 0.2 * LAMPORTS_PER_SOL) {
    return;
  }

  try {
    await connection.confirmTransaction(
      await connection.requestAirdrop(sender.publicKey, LAMPORTS_PER_SOL),
      "confirmed",
    );
  } catch {
    throw new Error(
      `Fund ${sender.publicKey.toBase58()} with: solana airdrop 1 ${sender.publicKey.toBase58()} --url devnet`,
    );
  }
}

async function main(): Promise<void> {
  // Step 1: Create a funded sender and an unfunded recipient.
  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  await ensureSenderBalance(sender);

  // Step 2: Deposit into the live devnet pool and keep the note off-chain.
  const senderClient = new SNAPClient(connection, sender);
  const note = await senderClient.deposit(DEVNET_POOL, 0.1);
  const serialized = SNAPClient.serializeNote(note);
  const recipientBalanceBefore = await connection.getBalance(recipient.publicKey);

  // Step 3: Ask the relayer to submit the withdrawal so the recipient pays no gas.
  const recipientClient = new SNAPClient(connection, recipient);
  const result = await recipientClient.withdrawViaRelayer(
    DEVNET_POOL,
    SNAPClient.deserializeNote(serialized),
    recipient.publicKey,
    RELAYER_URL,
  );

  // Step 4: Print the fee and the recipient's net amount.
  const recipientBalanceAfter = await connection.getBalance(recipient.publicKey);
  console.log("Relayed withdrawal:", `https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`);
  console.log("Relayer fee:", result.fee, "SOL");
  console.log(
    "Recipient received:",
    (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL,
    "SOL",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (/relayer/i.test(message)) {
    console.error("Start the demo relayer with:");
    console.error(
      "cd relayer && npm install && SOLANA_RPC_URL=https://api.devnet.solana.com RELAYER_KEYPAIR_PATH=../relayer-keypair.json SUPPORTED_POOLS=8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT npm run start",
    );
  }
  process.exitCode = 1;
});
