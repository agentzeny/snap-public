import * as anchor from "@coral-xyz/anchor";
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
import { COMMITMENT_PAGE_CAPACITY } from "../sdk-package/src/commitment-pages";
import { initPoseidon, PoseidonMerkleTree } from "../sdk/poseidon-merkle";
import {
  computeBudgetIx,
  deriveCommitmentPagePda,
  deriveNullifierRecordPda,
  deriveVaultPda,
  formatProof,
  fundSystemAccount,
} from "./helpers";

describe("Nullifier PDA migration", function () {
  this.timeout(600000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentPrivacyPool as anchor.Program<any>;
  const authority = provider.wallet;
  const depositAmount = new anchor.BN(100_000_000);

  before(async () => {
    await initPoseidon();
  });

  it("creates a nullifier PDA after withdrawal", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 10);
    const tree = new PoseidonMerkleTree(10);
    await tree.init();

    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);

    await depositV2(program, pool.publicKey, poolVault, note.commitment);

    const recipient = Keypair.generate();
    await fundSystemAccount(provider, recipient.publicKey, Math.floor(0.01 * LAMPORTS_PER_SOL));

    const { proof } = await generateWithdrawProof(
      note,
      tree,
      leafIndex,
      pubkeyToFieldElement(recipient.publicKey.toBytes()),
      10,
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const rootBytes = bigintToBytes(tree.getRoot(), 32);
    const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
    const [nullifierRecord] = deriveNullifierRecordPda(
      pool.publicKey,
      Uint8Array.from(nullifierHashBytes),
      program.programId,
    );

    await (program.methods as any)
      .withdrawZkV2(
        proofABytes,
        proofBBytes,
        proofCBytes,
        rootBytes,
        nullifierHashBytes,
      )
      .accounts({
        pool: pool.publicKey,
        poolVault,
        recipient: recipient.publicKey,
        payer: authority.publicKey,
        nullifierRecord,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([computeBudgetIx(500_000)])
      .rpc();

    const nullifierInfo = await provider.connection.getAccountInfo(nullifierRecord);
    assert.isNotNull(nullifierInfo, "nullifier PDA should exist after withdrawal");

    const poolState = await (program.account as any).poolV2.fetch(pool.publicKey);
    assert.equal(poolState.nullifierCount, 1);
    assert.equal(poolState.usedNullifiers.length, 0);
  });

  it("rejects a second withdrawal with the same nullifier PDA", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 10);
    const tree = new PoseidonMerkleTree(10);
    await tree.init();

    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositV2(program, pool.publicKey, poolVault, note.commitment);

    const recipient = Keypair.generate();
    await fundSystemAccount(provider, recipient.publicKey, Math.floor(0.01 * LAMPORTS_PER_SOL));

    const { proof } = await generateWithdrawProof(
      note,
      tree,
      leafIndex,
      pubkeyToFieldElement(recipient.publicKey.toBytes()),
      10,
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const rootBytes = bigintToBytes(tree.getRoot(), 32);
    const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
    const [nullifierRecord] = deriveNullifierRecordPda(
      pool.publicKey,
      Uint8Array.from(nullifierHashBytes),
      program.programId,
    );

    const withdraw = () =>
      (program.methods as any)
        .withdrawZkV2(
          proofABytes,
          proofBBytes,
          proofCBytes,
          rootBytes,
          nullifierHashBytes,
        )
        .accounts({
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          nullifierRecord,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx(500_000)])
        .rpc();

    await withdraw();

    try {
      await withdraw();
      assert.fail("Expected duplicate nullifier withdrawal to fail");
    } catch (error) {
      assert.match(String(error), /(already in use|already initialized|Allocate|custom program error)/i);
    }
  });

  it("allows different nullifiers to withdraw successfully", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 10);
    const tree = new PoseidonMerkleTree(10);
    await tree.init();

    const notes = [await generateZKNote(), await generateZKNote()];
    const recipients = [Keypair.generate(), Keypair.generate()];

    for (const recipient of recipients) {
      await fundSystemAccount(provider, recipient.publicKey, Math.floor(0.01 * LAMPORTS_PER_SOL));
    }

    for (const note of notes) {
      tree.insert(note.commitment);
      await depositV2(program, pool.publicKey, poolVault, note.commitment);
    }

    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      const recipient = recipients[index];
      const { proof } = await generateWithdrawProof(
        note,
        tree,
        index,
        pubkeyToFieldElement(recipient.publicKey.toBytes()),
        10,
      );
      const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
      const rootBytes = bigintToBytes(tree.getRoot(), 32);
      const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
      const [nullifierRecord] = deriveNullifierRecordPda(
        pool.publicKey,
        Uint8Array.from(nullifierHashBytes),
        program.programId,
      );

      await (program.methods as any)
        .withdrawZkV2(
          proofABytes,
          proofBBytes,
          proofCBytes,
          rootBytes,
          nullifierHashBytes,
        )
        .accounts({
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          nullifierRecord,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx(500_000)])
        .rpc();

      const nullifierInfo = await provider.connection.getAccountInfo(nullifierRecord);
      assert.isNotNull(nullifierInfo);
    }
  });

  it("handles 50 sequential withdrawals without nullifier-scan growth", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 10);
    const tree = new PoseidonMerkleTree(10);
    await tree.init();

    const recipient = Keypair.generate();
    await fundSystemAccount(provider, recipient.publicKey, Math.floor(0.01 * LAMPORTS_PER_SOL));

    const notes = [];
    for (let i = 0; i < 50; i += 1) {
      const note = await generateZKNote();
      notes.push(note);
      tree.insert(note.commitment);
      await depositV2(program, pool.publicKey, poolVault, note.commitment);
    }

    const rootBytes = bigintToBytes(tree.getRoot(), 32);

    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      const { proof } = await generateWithdrawProof(
        note,
        tree,
        index,
        pubkeyToFieldElement(recipient.publicKey.toBytes()),
        10,
      );
      const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
      const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
      const [nullifierRecord] = deriveNullifierRecordPda(
        pool.publicKey,
        Uint8Array.from(nullifierHashBytes),
        program.programId,
      );

      await (program.methods as any)
        .withdrawZkV2(
          proofABytes,
          proofBBytes,
          proofCBytes,
          rootBytes,
          nullifierHashBytes,
        )
        .accounts({
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          nullifierRecord,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx(500_000)])
        .rpc();
    }

    const poolState = await (program.account as any).poolV2.fetch(pool.publicKey);
    assert.equal(poolState.nullifierCount, 50);
    assert.equal(poolState.usedNullifiers.length, 0);
  });
});

async function createV2Pool(
  program: anchor.Program<any>,
  depositAmount: anchor.BN,
  treeDepth: number,
) {
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

  await (program.methods as any)
    .initializeV2(depositAmount, treeDepth)
    .accounts({
      pool: pool.publicKey,
      poolVault,
      authority: program.provider.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
    .rpc();

  return { pool, poolVault };
}

async function depositV2(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  commitment: bigint,
) {
  const poolState = await (program.account as any).poolV2.fetch(pool);
  const pageIndex = Math.floor(
    Number(poolState.nextIndex) / COMMITMENT_PAGE_CAPACITY,
  );
  const [commitmentPage] = deriveCommitmentPagePda(
    pool,
    pageIndex,
    program.programId,
  );

  await (program.methods as any)
    .depositV2(bigintToBytes(commitment, 32), pageIndex)
    .accounts({
      commitmentPage,
      pool,
      poolVault,
      depositor: program.provider.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
    .rpc();
}
