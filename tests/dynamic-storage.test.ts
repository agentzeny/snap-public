import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentPrivacyPool } from "../target/types/agent_privacy_pool";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import {
  bigintToBytes,
  generateWithdrawProof,
  generateZKNote,
  pubkeyToFieldElement,
} from "../sdk/proof";
import { initPoseidon, PoseidonMerkleTree } from "../sdk/poseidon-merkle";

const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

function negateG1Y(proofABytes: number[]): number[] {
  const yBytes = proofABytes.slice(32, 64);
  let y = BigInt(0);
  for (const b of yBytes) {
    y = (y << BigInt(8)) | BigInt(b);
  }
  const negY = FIELD_PRIME - y;
  const negYBytes = bigintToBytes(negY, 32);
  return [...proofABytes.slice(0, 32), ...negYBytes];
}

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

describe("Dynamic commitment storage", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .agentPrivacyPool as Program<AgentPrivacyPool>;
  const authority = provider.wallet;

  const depositAmount = new anchor.BN(100_000_000);
  let poolKeypair: Keypair;
  let poolVaultPda: PublicKey;
  let tree: PoseidonMerkleTree;

  before(async () => {
    await initPoseidon();
    tree = new PoseidonMerkleTree(10);
    await tree.init();

    poolKeypair = Keypair.generate();
    [poolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolKeypair.publicKey.toBuffer()],
      program.programId
    );

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
  });

  it("Supports more than 16 deposits (old MAX_COMMITMENTS limit)", async () => {
    for (let i = 0; i < 20; i++) {
      const note = await generateZKNote();
      tree.insert(note.commitment);

      await program.methods
        .deposit(bigintToBytes(note.commitment, 32))
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
    }

    const pool = await program.account.pool.fetch(poolKeypair.publicKey);
    assert.equal(pool.nextIndex, 20);
    assert.equal(pool.commitments.length, 20);
    assert.equal(pool.rootCount, 20);
  });

  it("Pool account grows in size after each deposit", async () => {
    const sizeBefore = (await provider.connection.getAccountInfo(
      poolKeypair.publicKey
    ))!.data.length;

    const note = await generateZKNote();
    tree.insert(note.commitment);

    await program.methods
      .deposit(bigintToBytes(note.commitment, 32))
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

    const sizeAfter = (await provider.connection.getAccountInfo(
      poolKeypair.publicKey
    ))!.data.length;

    assert.isAbove(sizeAfter, sizeBefore, "Account should grow after deposit");
  });

  it("Withdrawals still work after the pool has been reallocated", async () => {
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);

    await program.methods
      .deposit(bigintToBytes(note.commitment, 32))
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
      leafIndex,
      recipientField
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const rootBytes = bigintToBytes(tree.getRoot(), 32);
    const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
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
      "Withdrawal should work after repeated reallocations"
    );
  });
});
