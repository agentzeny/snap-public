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
  fetchTransactionComputeUnits,
  formatProof,
  fundSystemAccount,
} from "./helpers";

describe("Depth-20 Merkle trees", function () {
  this.timeout(600000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentPrivacyPool as anchor.Program<any>;
  const authority = provider.wallet;
  const depositAmount = new anchor.BN(100_000_000);

  before(async () => {
    await initPoseidon();
  });

  it("creates a depth-20 pool", async () => {
    const { pool } = await createV2Pool(program, depositAmount, 20);
    const poolState = await (program.account as any).poolV2.fetch(pool.publicKey);

    assert.equal(poolState.treeDepth, 20);
    assert.equal(poolState.nullifierVersion, 1);
  });

  it("updates the Merkle root on depth-20 deposits", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 20);
    const tree = new PoseidonMerkleTree(20);
    await tree.init();

    const note = await generateZKNote();
    tree.insert(note.commitment);
    await depositV2(program, pool.publicKey, poolVault, note.commitment, 20);

    const poolState = await (program.account as any).poolV2.fetch(pool.publicKey);
    const expectedRoot = bigintToBytes(tree.getRoot(), 32);

    assert.equal(poolState.rootCount, 1);
    assert.deepEqual(Array.from(poolState.roots[0]), expectedRoot);
  });

  it("withdraws from a depth-20 pool with a ZK proof", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 20);
    const tree = new PoseidonMerkleTree(20);
    await tree.init();

    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositV2(program, pool.publicKey, poolVault, note.commitment, 20);

    const recipient = Keypair.generate();
    await fundSystemAccount(provider, recipient.publicKey, Math.floor(0.01 * LAMPORTS_PER_SOL));

    const { proof } = await generateWithdrawProof(
      note,
      tree,
      leafIndex,
      pubkeyToFieldElement(recipient.publicKey.toBytes()),
      20,
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const rootBytes = bigintToBytes(tree.getRoot(), 32);
    const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
    const [nullifierRecord] = deriveNullifierRecordPda(
      pool.publicKey,
      Uint8Array.from(nullifierHashBytes),
      program.programId,
    );

    const balanceBefore = await provider.connection.getBalance(recipient.publicKey);
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
      .preInstructions([computeBudgetIx()])
      .rpc();
    const balanceAfter = await provider.connection.getBalance(recipient.publicKey);

    assert.equal(balanceAfter - balanceBefore, 100_000_000);
  });

  it("keeps the pool account flat across commitment pages", async () => {
    const { pool, poolVault } = await createV2Pool(program, depositAmount, 20);
    const tree = new PoseidonMerkleTree(20);
    await tree.init();

    const sizeBefore = (
      await getRequiredAccountInfo(provider.connection, pool.publicKey)
    ).data.length;

    let latestNote = await generateZKNote();
    let latestLeafIndex = 0;
    for (let index = 0; index <= COMMITMENT_PAGE_CAPACITY; index += 1) {
      const note = await generateZKNote();
      latestLeafIndex = tree.insert(note.commitment);
      latestNote = note;
      await depositV2(program, pool.publicKey, poolVault, note.commitment, 20, 1_400_000);
    }

    const sizeAfter = (
      await getRequiredAccountInfo(provider.connection, pool.publicKey)
    ).data.length;
    assert.equal(sizeAfter, sizeBefore);

    const [page0] = deriveCommitmentPagePda(pool.publicKey, 0, program.programId);
    const [page1] = deriveCommitmentPagePda(pool.publicKey, 1, program.programId);
    const page0State = await (program.account as any).commitmentPage.fetch(page0);
    const page1State = await (program.account as any).commitmentPage.fetch(page1);

    assert.equal(Number(page0State.commitmentCount), COMMITMENT_PAGE_CAPACITY);
    assert.equal(Number(page1State.commitmentCount), 1);
    assert.equal(Number(page1State.startOffset), 0);

    const recipient = Keypair.generate();
    await fundSystemAccount(provider, recipient.publicKey, Math.floor(0.01 * LAMPORTS_PER_SOL));

    const { proof } = await generateWithdrawProof(
      latestNote,
      tree,
      latestLeafIndex,
      pubkeyToFieldElement(recipient.publicKey.toBytes()),
      20,
    );
    const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
    const rootBytes = bigintToBytes(tree.getRoot(), 32);
    const nullifierHashBytes = bigintToBytes(latestNote.nullifierHash, 32);
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
      .preInstructions([computeBudgetIx()])
      .rpc();
  });

  it("keeps legacy depth-10 pools working", async () => {
    const pool = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

    await (program.methods as any)
      .initialize(depositAmount)
      .accounts({
        pool: pool.publicKey,
        poolVault,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([pool])
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
      .rpc();

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);

    await (program.methods as any)
      .deposit(bigintToBytes(note.commitment, 32))
      .accounts({
        pool: pool.publicKey,
        poolVault,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
      .rpc();

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

    await (program.methods as any)
      .withdrawZk(
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
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
      .rpc();

    const poolState = await (program.account as any).pool.fetch(pool.publicKey);
    assert.equal(poolState.nullifierCount, 1);
    assert.equal(poolState.usedNullifiers.length, 1);
  });

  it("rejects invalid tree depths", async () => {
    const pool = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

    try {
      await (program.methods as any)
        .initializeV2(depositAmount, 15)
        .accounts({
          pool: pool.publicKey,
          poolVault,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([pool])
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
        .rpc();
      assert.fail("Expected invalid tree depth to fail");
    } catch (error) {
      assert.match(String(error), /InvalidTreeDepth|tree_depth/i);
    }
  });

  it("measures higher compute usage for depth-20 deposits", async () => {
    const depth10 = await createV2Pool(program, depositAmount, 10);
    const depth20 = await createV2Pool(program, depositAmount, 20);

    const depth10Note = await generateZKNote();
    const depth20Note = await generateZKNote();

    const depth10Sig = await depositV2(
      program,
      depth10.pool.publicKey,
      depth10.poolVault,
      depth10Note.commitment,
      10,
      500_000,
    );
    const depth20Sig = await depositV2(
      program,
      depth20.pool.publicKey,
      depth20.poolVault,
      depth20Note.commitment,
      20,
      1_400_000,
    );

    const depth10Units = await fetchTransactionComputeUnits(
      provider.connection,
      depth10Sig,
    );
    const depth20Units = await fetchTransactionComputeUnits(
      provider.connection,
      depth20Sig,
    );

    console.log("    depth10 deposit CU:", depth10Units);
    console.log("    depth20 deposit CU:", depth20Units);

    assert.isNotNull(depth10Units);
    assert.isNotNull(depth20Units);
    assert.isAbove(depth20Units!, depth10Units!);
    assert.isAtLeast(depth20Units! - depth10Units!, 10_000);
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
      authority: program.provider.wallet.publicKey,
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
  treeDepth: number,
  computeUnits = 500_000,
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

  return (program.methods as any)
    .depositV2(bigintToBytes(commitment, 32), pageIndex)
    .accounts({
      commitmentPage,
      pool,
      poolVault,
      depositor: program.provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(treeDepth > 10 ? computeUnits : 500_000)])
    .rpc();
}

async function getRequiredAccountInfo(
  connection: anchor.web3.Connection,
  address: PublicKey,
  attempts = 10,
): Promise<NonNullable<Awaited<ReturnType<typeof connection.getAccountInfo>>>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const accountInfo = await connection.getAccountInfo(address, "confirmed");
    if (accountInfo) {
      return accountInfo;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Account ${address.toBase58()} was not available on localnet`);
}
