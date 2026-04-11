import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentPrivacyPool } from "../target/types/agent_privacy_pool";
import {
  Keypair,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { assert } from "chai";

const demoEnabled = process.env.SNAP_DEMO === "1";
const describeDemo = demoEnabled ? describe : describe.skip;
const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function generateNote() {
  while (true) {
    const secret = Buffer.from(
      Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
    );
    const nullifier = Buffer.from(
      Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
    );
    const commitment = sha256(Buffer.concat([secret, nullifier]));

    if (bytesToBigInt(commitment) >= FIELD_PRIME) {
      continue;
    }

    const nullifierHash = sha256(nullifier);
    return { secret, nullifier, commitment, nullifierHash };
  }
}

function bytesToBigInt(bytes: Buffer): bigint {
  return BigInt(`0x${bytes.toString("hex")}`);
}

describeDemo("agent-privacy-pool", () => {
  if (!demoEnabled) {
    return;
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .agentPrivacyPool as Program<AgentPrivacyPool>;
  const authority = provider.wallet;

  const depositAmount = new anchor.BN(100_000_000); // 0.1 SOL
  let poolKeypair: Keypair;
  let poolVaultPda: PublicKey;
  let poolVaultBump: number;

  before(async () => {
    poolKeypair = Keypair.generate();
    [poolVaultPda, poolVaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolKeypair.publicKey.toBuffer()],
      program.programId
    );
  });

  it("Initializes the pool", async () => {
    await program.methods
      .initialize(depositAmount)
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([poolKeypair])
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    const pool = await program.account.pool.fetch(poolKeypair.publicKey);
    assert.equal(pool.depositAmount.toNumber(), 100_000_000);
    assert.equal(pool.nextIndex, 0);
    assert.equal(pool.nullifierCount, 0);
    assert.equal(pool.rootCount, 0);
  });

  it("Agent A deposits with a commitment", async () => {
    const note = generateNote();

    const vaultBalanceBefore = await provider.connection.getBalance(
      poolVaultPda
    );

    await program.methods
      .deposit(Array.from(note.commitment))
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    const pool = await program.account.pool.fetch(poolKeypair.publicKey);
    assert.equal(pool.nextIndex, 1);
    assert.equal(pool.rootCount, 1);

    const vaultBalanceAfter = await provider.connection.getBalance(
      poolVaultPda
    );
    assert.equal(
      vaultBalanceAfter - vaultBalanceBefore,
      100_000_000,
      "Vault should have received 0.1 SOL"
    );
  });

  it("Agent B withdraws with matching secret/nullifier", async () => {
    // Generate a fresh note and deposit it
    const note = generateNote();

    await program.methods
      .deposit(Array.from(note.commitment))
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    // Now withdraw as a different "agent"
    const recipient = Keypair.generate();

    // Fund the recipient account so it exists (rent-exempt minimum)
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient.publicKey,
        lamports: LAMPORTS_PER_SOL * 0.01, // small amount for rent
      })
    );
    await provider.sendAndConfirm(tx);

    const recipientBalanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    );

    await program.methods
      .withdraw(
        Array.from(note.secret),
        Array.from(note.nullifier),
        Array.from(note.nullifierHash)
      )
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        recipient: recipient.publicKey,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const recipientBalanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    assert.equal(
      recipientBalanceAfter - recipientBalanceBefore,
      100_000_000,
      "Recipient should have received 0.1 SOL"
    );
  });

  it("Rejects double-withdraw (same nullifier)", async () => {
    const note = generateNote();

    // Deposit
    await program.methods
      .deposit(Array.from(note.commitment))
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    const recipient = Keypair.generate();
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient.publicKey,
        lamports: LAMPORTS_PER_SOL * 0.01,
      })
    );
    await provider.sendAndConfirm(tx);

    // First withdraw succeeds
    await program.methods
      .withdraw(
        Array.from(note.secret),
        Array.from(note.nullifier),
        Array.from(note.nullifierHash)
      )
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        recipient: recipient.publicKey,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Second withdraw with same nullifier should fail
    try {
      await program.methods
        .withdraw(
          Array.from(note.secret),
          Array.from(note.nullifier),
          Array.from(note.nullifierHash)
        )
        .accounts({
          pool: poolKeypair.publicKey,
          poolVault: poolVaultPda,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown on double-withdraw");
    } catch (err) {
      assert.include(err.toString(), "AlreadyWithdrawn");
    }
  });

  it("Rejects withdraw with wrong secret", async () => {
    const note = generateNote();

    // Deposit
    await program.methods
      .deposit(Array.from(note.commitment))
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    const recipient = Keypair.generate();
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient.publicKey,
        lamports: LAMPORTS_PER_SOL * 0.01,
      })
    );
    await provider.sendAndConfirm(tx);

    // Use a wrong secret
    const wrongSecret = Buffer.from(
      Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
    );

    try {
      await program.methods
        .withdraw(
          Array.from(wrongSecret),
          Array.from(note.nullifier),
          Array.from(note.nullifierHash)
        )
        .accounts({
          pool: poolKeypair.publicKey,
          poolVault: poolVaultPda,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown on wrong secret");
    } catch (err) {
      assert.include(err.toString(), "CommitmentNotFound");
    }
  });
});
