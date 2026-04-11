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
import { assert } from "chai";
import {
  generateZKNote,
  generateWithdrawProof,
  pubkeyToFieldElement,
  bigintToBytes,
} from "../sdk/proof";
import { PoseidonMerkleTree, initPoseidon } from "../sdk/poseidon-merkle";

// BN254 field prime for proof_a negation
const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

function negateG1Y(proofABytes: number[]): number[] {
  // proof_a is [x (32 bytes), y (32 bytes)]
  // Negate y: y' = FIELD_PRIME - y
  const yBytes = proofABytes.slice(32, 64);
  let y = BigInt(0);
  for (const b of yBytes) {
    y = (y << BigInt(8)) | BigInt(b);
  }
  const negY = FIELD_PRIME - y;
  const negYBytes = bigintToBytes(negY, 32);
  return [...proofABytes.slice(0, 32), ...negYBytes];
}

/** Helper: format proof for on-chain submission */
function formatProof(proof: any) {
  const proofABytes = negateG1Y([
    ...bigintToBytes(BigInt(proof.pi_a[0]), 32),
    ...bigintToBytes(BigInt(proof.pi_a[1]), 32),
  ]);
  const proofBBytes = [
    ...bigintToBytes(BigInt(proof.pi_b[0][1]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[0][0]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[1][1]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[1][0]), 32),
  ];
  const proofCBytes = [
    ...bigintToBytes(BigInt(proof.pi_c[0]), 32),
    ...bigintToBytes(BigInt(proof.pi_c[1]), 32),
  ];
  return { proofABytes, proofBBytes, proofCBytes };
}

describe("ZK withdraw (on-chain Groth16 verification)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .agentPrivacyPool as Program<AgentPrivacyPool>;
  const authority = provider.wallet;

  const depositAmount = new anchor.BN(100_000_000); // 0.1 SOL
  let poolKeypair: Keypair;
  let poolVaultPda: PublicKey;

  before(async () => {
    await initPoseidon();
    poolKeypair = Keypair.generate();
    [poolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolKeypair.publicKey.toBuffer()],
      program.programId
    );

    // Initialize pool
    await program.methods
      .initialize(depositAmount)
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([poolKeypair])
      .rpc();
  });

  it("Deposits with Poseidon commitment and withdraws with ZK proof", async () => {
    // 1. Generate a ZK note (Poseidon-based)
    const note = await generateZKNote();
    console.log(
      "    Note commitment:",
      note.commitment.toString().slice(0, 20) + "..."
    );

    // Deposit the Poseidon commitment (as 32 bytes)
    const commitmentBytes = bigintToBytes(note.commitment, 32);
    await program.methods
      .deposit(commitmentBytes)
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

    // 2. Build Poseidon Merkle tree and generate proof
    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    const leafIndex = tree.insert(note.commitment);

    const recipient = Keypair.generate();
    // Fund recipient
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient.publicKey,
        lamports: LAMPORTS_PER_SOL * 0.01,
      })
    );
    await provider.sendAndConfirm(fundTx);

    const recipientField = pubkeyToFieldElement(recipient.publicKey.toBytes());
    const root = tree.getRoot();

    console.log("    Generating ZK proof...");
    const { proof, publicSignals } = await generateWithdrawProof(
      note,
      tree,
      leafIndex,
      recipientField
    );
    console.log("    Proof generated.");

    // 3. Format proof for on-chain verification
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const rootBytes = bigintToBytes(root, 32);
    const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);

    const balanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    );

    // 4. Submit ZK withdrawal with increased compute budget
    console.log("    Submitting on-chain ZK verification...");
    const tx = await program.methods
      .withdrawZk(
        proofABytes,
        proofBBytes,
        proofCBytes,
        rootBytes,
        nullifierHashBytes
      )
      .accounts({
        pool: poolKeypair.publicKey,
        poolVault: poolVaultPda,
        recipient: recipient.publicKey,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    assert.equal(
      balanceAfter - balanceBefore,
      100_000_000,
      "Recipient should have received 0.1 SOL"
    );

    console.log("    ZK withdrawal successful! TX:", tx.slice(0, 20) + "...");
    console.log(
      "    The program verified the proof WITHOUT seeing the secret."
    );
  });

  it("Rejects withdraw_zk with invalid root", async () => {
    // Deposit a fresh commitment
    const note = await generateZKNote();
    const commitmentBytes = bigintToBytes(note.commitment, 32);
    await program.methods
      .deposit(commitmentBytes)
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

    // Generate a valid proof
    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(note.commitment);
    const recipient = Keypair.generate();
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient.publicKey,
        lamports: LAMPORTS_PER_SOL * 0.01,
      })
    );
    await provider.sendAndConfirm(fundTx);

    const recipientField = pubkeyToFieldElement(recipient.publicKey.toBytes());
    const { proof } = await generateWithdrawProof(
      note,
      tree,
      0,
      recipientField
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);

    // Use a random root instead of the real one
    const randomRoot = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 256)
    );

    try {
      await program.methods
        .withdrawZk(
          proofABytes,
          proofBBytes,
          proofCBytes,
          randomRoot,
          nullifierHashBytes
        )
        .accounts({
          pool: poolKeypair.publicKey,
          poolVault: poolVaultPda,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        ])
        .rpc();
      assert.fail("Should have rejected invalid root");
    } catch (err) {
      assert.include(err.toString(), "InvalidRoot");
    }
  });

  it("Withdraws using a previous root (not the latest)", async () => {
    // Initialize a fresh pool for this test
    const freshPool = Keypair.generate();
    const [freshVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), freshPool.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .initialize(depositAmount)
      .accounts({
        pool: freshPool.publicKey,
        poolVault: freshVault,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([freshPool])
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    // Deposit note1
    const note1 = await generateZKNote();
    await program.methods
      .deposit(bigintToBytes(note1.commitment, 32))
      .accounts({
        pool: freshPool.publicKey,
        poolVault: freshVault,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    // Snapshot tree state after deposit 1 (this is the "previous root")
    const tree1 = new PoseidonMerkleTree(10);
    await tree1.init();
    tree1.insert(note1.commitment);
    const root1 = tree1.getRoot();

    // Generate proof against root1
    const recipient = Keypair.generate();
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient.publicKey,
        lamports: LAMPORTS_PER_SOL * 0.01,
      })
    );
    await provider.sendAndConfirm(fundTx);

    const recipientField = pubkeyToFieldElement(recipient.publicKey.toBytes());
    const { proof } = await generateWithdrawProof(
      note1,
      tree1,
      0,
      recipientField
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);

    // Deposit note2 — this changes the on-chain current root
    const note2 = await generateZKNote();
    await program.methods
      .deposit(bigintToBytes(note2.commitment, 32))
      .accounts({
        pool: freshPool.publicKey,
        poolVault: freshVault,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    // Withdraw using proof against root1 (the previous, not current root)
    const rootBytes = bigintToBytes(root1, 32);
    const nullifierHashBytes = bigintToBytes(note1.nullifierHash, 32);
    const balanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    );

    await program.methods
      .withdrawZk(
        proofABytes,
        proofBBytes,
        proofCBytes,
        rootBytes,
        nullifierHashBytes
      )
      .accounts({
        pool: freshPool.publicKey,
        poolVault: freshVault,
        recipient: recipient.publicKey,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    );
    assert.equal(
      balanceAfter - balanceBefore,
      100_000_000,
      "Should withdraw using a previous root"
    );
    console.log(
      "    Withdrew using previous root (not latest) — root history works!"
    );
  });
});
