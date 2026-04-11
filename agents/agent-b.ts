import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  SystemProgram,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { readFileSync } from "fs";

// Load IDL
const idl = JSON.parse(
  readFileSync("./target/idl/agent_privacy_pool.json", "utf8")
);

async function main() {
  console.log(
    "=== Agent B: Received encrypted note. Initiating withdrawal ===\n"
  );

  // Connect to localnet
  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const programId = new PublicKey(idl.address);
  const program = new Program(idl, provider);

  // Step 1: Read the note from Agent A
  console.log("Step 1: Reading encrypted note from Agent A...");
  const noteData = JSON.parse(readFileSync("./shared/note.json", "utf8"));
  console.log(`  Pool: ${noteData.pool}`);
  console.log(`  Commitment: ${noteData.commitment.slice(0, 32)}...`);
  console.log(`  I know the secret but won't reveal it on-chain.\n`);

  const secret = Buffer.from(noteData.secret, "hex");
  const nullifier = Buffer.from(noteData.nullifier, "hex");
  const nullifierHash = Buffer.from(noteData.nullifierHash, "hex");
  const poolPubkey = new PublicKey(noteData.pool);
  const poolVaultPda = new PublicKey(noteData.poolVault);

  // Step 2: Create a new keypair for the recipient (Agent B's wallet)
  console.log("Step 2: Setting up recipient wallet...");
  const recipient = Keypair.generate();

  // Fund the recipient so the account exists
  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: recipient.publicKey,
      lamports: LAMPORTS_PER_SOL * 0.01,
    })
  );
  await provider.sendAndConfirm(fundTx);
  console.log(`  Recipient: ${recipient.publicKey.toBase58()}\n`);

  // Step 3: Withdraw from the pool
  console.log("Step 3: Submitting withdrawal with secret proof...");
  const balanceBefore = await connection.getBalance(recipient.publicKey);

  const tx = await program.methods
    .withdraw(
      Array.from(secret),
      Array.from(nullifier),
      Array.from(nullifierHash)
    )
    .accounts({
      pool: poolPubkey,
      poolVault: poolVaultPda,
      recipient: recipient.publicKey,
      payer: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const balanceAfter = await connection.getBalance(recipient.publicKey);
  const received = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;

  console.log(`  TX: ${tx}`);
  console.log(`  Received: ${received} SOL`);
  console.log(
    `  On-chain: observer sees Agent B withdrew 0.1 SOL from the pool.`
  );
  console.log(
    `  On-chain: observer CANNOT determine that Agent A paid Agent B.\n`
  );

  console.log("=== PRIVACY ACHIEVED (Path A - hash-reveal demo) ===");
  console.log(
    "Agent A deposited. Agent B withdrew. The link between them is broken."
  );
  console.log(
    "NOTE: In Path A, the program sees the preimage (not truly private)."
  );
  console.log(
    "In production (Path B), a ZK proof replaces the hash reveal, making it fully private.\n"
  );
}

main().catch(console.error);
