import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
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

describe("SPL pool support", function () {
  this.timeout(600000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentPrivacyPool as anchor.Program<any>;
  const authority = provider.wallet;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const usdcAmount = new anchor.BN(1_000_000);

  before(async () => {
    await initPoseidon();
  });

  it("creates a USDC pool with a PDA-owned vault", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );

    const { pool, poolVault } = await createSplPool(program, mint, usdcAmount);
    const poolState = await (program.account as any).poolV2.fetch(pool.publicKey);
    const vaultState = await getAccount(provider.connection, poolVault);

    assert.equal(poolState.tokenMint.toBase58(), mint.toBase58());
    assert.equal(poolState.treeDepth, 20);
    assert.equal(poolState.nullifierVersion, 1);
    assert.equal(vaultState.mint.toBase58(), mint.toBase58());
    assert.equal(vaultState.owner.toBase58(), poolVault.toBase58());
    assert.equal(Number(vaultState.amount), 0);
  });

  it("deposits SPL tokens into the pool vault", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const { pool, poolVault } = await createSplPool(program, mint, usdcAmount);
    const depositorTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      authority.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      depositorTokenAccount.address,
      authority.publicKey,
      2_000_000,
    );

    const note = await generateZKNote();
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    tree.insert(note.commitment);

    await depositSpl(
      program,
      pool.publicKey,
      poolVault,
      depositorTokenAccount.address,
      note.commitment,
    );

    const vaultState = await getAccount(provider.connection, poolVault);
    const depositorState = await getAccount(
      provider.connection,
      depositorTokenAccount.address,
    );

    assert.equal(Number(vaultState.amount), 1_000_000);
    assert.equal(Number(depositorState.amount), 1_000_000);
  });

  it("withdraws SPL tokens with a ZK proof", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const { pool, poolVault } = await createSplPool(program, mint, usdcAmount);
    const depositorTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      authority.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      depositorTokenAccount.address,
      authority.publicKey,
      1_000_000,
    );

    const note = await generateZKNote();
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const leafIndex = tree.insert(note.commitment);

    await depositSpl(
      program,
      pool.publicKey,
      poolVault,
      depositorTokenAccount.address,
      note.commitment,
    );

    const recipient = Keypair.generate();
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      recipient.publicKey,
    );

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

    await (program.methods as any)
      .withdrawZkSpl(
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
        recipientTokenAccount: recipientTokenAccount.address,
        payer: authority.publicKey,
        nullifierRecord,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([computeBudgetIx()])
      .rpc();

    const recipientState = await getAccount(
      provider.connection,
      recipientTokenAccount.address,
    );
    const vaultState = await getAccount(provider.connection, poolVault);

    assert.equal(Number(recipientState.amount), 1_000_000);
    assert.equal(Number(vaultState.amount), 0);
  });

  it("supports relayed SPL withdrawals with the fee deducted in tokens", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const { pool, poolVault } = await createSplPool(program, mint, usdcAmount);
    const depositorTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      authority.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      depositorTokenAccount.address,
      authority.publicKey,
      1_000_000,
    );

    const note = await generateZKNote();
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const leafIndex = tree.insert(note.commitment);

    await depositSpl(
      program,
      pool.publicKey,
      poolVault,
      depositorTokenAccount.address,
      note.commitment,
    );

    const recipient = Keypair.generate();
    const relayer = Keypair.generate();
    await fundSystemAccount(provider, relayer.publicKey, 1_000_000_000);

    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      recipient.publicKey,
    );
    const relayerTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      relayer.publicKey,
    );

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

    await (program.methods as any)
      .withdrawZkRelayedSpl(
        proofABytes,
        proofBBytes,
        proofCBytes,
        rootBytes,
        nullifierHashBytes,
        new anchor.BN(50_000),
      )
      .accounts({
        pool: pool.publicKey,
        poolVault,
        relayer: relayer.publicKey,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount.address,
        relayerTokenAccount: relayerTokenAccount.address,
        nullifierRecord,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([relayer])
      .preInstructions([computeBudgetIx()])
      .rpc();

    const recipientState = await getAccount(
      provider.connection,
      recipientTokenAccount.address,
    );
    const relayerState = await getAccount(
      provider.connection,
      relayerTokenAccount.address,
    );

    assert.equal(Number(recipientState.amount), 950_000);
    assert.equal(Number(relayerState.amount), 50_000);
  });

  it("rejects depositing SOL into an SPL pool", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const { pool, poolVault } = await createSplPool(program, mint, usdcAmount);
    const note = await generateZKNote();

    try {
      const pageIndex = 0;
      const [commitmentPage] = deriveCommitmentPagePda(
        pool.publicKey,
        pageIndex,
        program.programId,
      );
      await (program.methods as any)
        .depositV2(bigintToBytes(note.commitment, 32), pageIndex)
        .accounts({
          commitmentPage,
          pool: pool.publicKey,
          poolVault,
          depositor: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx(500_000)])
        .rpc();
      assert.fail("Expected SOL deposit into SPL pool to fail");
    } catch (error) {
      assert.match(String(error), /InvalidPoolAsset|asset type/i);
    }
  });

  it("rejects deposits with the wrong SPL token mint", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const wrongMint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const { pool, poolVault } = await createSplPool(program, mint, usdcAmount);
    const wrongTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      wrongMint,
      authority.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      wrongMint,
      wrongTokenAccount.address,
      authority.publicKey,
      1_000_000,
    );

    const note = await generateZKNote();

    try {
      await depositSpl(
        program,
        pool.publicKey,
        poolVault,
        wrongTokenAccount.address,
        note.commitment,
      );
      assert.fail("Expected deposit with wrong mint to fail");
    } catch (error) {
      assert.match(String(error), /InvalidTokenMint|constraint/i);
    }
  });
});

async function createSplPool(
  program: anchor.Program<any>,
  mint: PublicKey,
  depositAmount: anchor.BN,
) {
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

  await (program.methods as any)
    .initializeSpl(depositAmount, mint)
    .accounts({
      pool: pool.publicKey,
      poolVault,
      tokenMintAccount: mint,
      authority: program.provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .rpc();

  return { pool, poolVault };
}

async function depositSpl(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  depositorTokenAccount: PublicKey,
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
    .depositSpl(bigintToBytes(commitment, 32), pageIndex)
    .accounts({
      commitmentPage,
      pool,
      depositor: program.provider.wallet.publicKey,
      depositorTokenAccount,
      poolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}
