import { createRequire } from "module";
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
  fetchConfirmedTransaction,
  formatProof,
  fundSystemAccount,
} from "./helpers";

const require = createRequire(import.meta.url);
const BUILT_PROGRAM_IDL = require("../target/idl/agent_privacy_pool.json");
const SOL_DEPOSIT_AMOUNT = new anchor.BN(100_000_000);
const SPL_DEPOSIT_AMOUNT = new anchor.BN(1_000_000);
const MAX_CLIENT_DEPOSIT_AMOUNT = new anchor.BN("9007199254740991");

describe("Protocol fee pools", function () {
  this.timeout(600000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentPrivacyPool as anchor.Program<any>;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const authority = provider.wallet;

  before(async () => {
    await initPoseidon();
  });

  it("splits direct SOL withdrawals between treasury and recipient", async () => {
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      250,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();

    const note = await generateZKNote();
    const [nullifierRecord] = deriveNullifierRecordPda(
      pool.publicKey,
      Uint8Array.from(bigintToBytes(note.nullifierHash, 32)),
      program.programId,
    );
    const leafIndex = tree.insert(note.commitment);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);
    const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
    await withdrawFeeV2(
      program,
      pool.publicKey,
      poolVault,
      treasury.publicKey,
      recipient.publicKey,
      note,
      tree,
      leafIndex,
      20,
    );
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    const recipientAfter = await provider.connection.getBalance(recipient.publicKey);

    assert.equal(treasuryAfter - treasuryBefore, 2_500_000);
    assert.equal(recipientAfter - recipientBefore, 97_500_000);
  });

  it("splits relayed SOL withdrawals between treasury, relayer, and recipient", async () => {
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    const relayer = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);
    await fundSystemAccount(provider, relayer.publicKey, 1_000_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      250,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();

    const note = await generateZKNote();
    const [nullifierRecord] = deriveNullifierRecordPda(
      pool.publicKey,
      Uint8Array.from(bigintToBytes(note.nullifierHash, 32)),
      program.programId,
    );
    const leafIndex = tree.insert(note.commitment);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);
    const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
    const relayerBefore = await provider.connection.getBalance(relayer.publicKey);
    await withdrawRelayedFeeV2(
      program,
      pool.publicKey,
      poolVault,
      treasury.publicKey,
      relayer,
      recipient.publicKey,
      note,
      tree,
      leafIndex,
      20,
      new anchor.BN(500_000),
    );
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    const recipientAfter = await provider.connection.getBalance(recipient.publicKey);
    const relayerAfter = await provider.connection.getBalance(relayer.publicKey);
    const nullifierRecordRent = await provider.connection.getBalance(nullifierRecord);

    assert.equal(treasuryAfter - treasuryBefore, 2_500_000);
    assert.equal(recipientAfter - recipientBefore, 97_000_000);
    assert.equal(relayerAfter - relayerBefore + nullifierRecordRent, 500_000);
  });

  it("splits SPL withdrawals between treasury and recipient", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const treasuryTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      Keypair.generate().publicKey,
      true,
    );
    const { pool, poolVault } = await createFeeSplPool(
      program,
      mint,
      SPL_DEPOSIT_AMOUNT,
      treasuryTokenAccount.address,
      250,
    );
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

    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositFeeSpl(
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

    await withdrawFeeSpl(
      program,
      pool.publicKey,
      poolVault,
      treasuryTokenAccount.address,
      recipient.publicKey,
      recipientTokenAccount.address,
      note,
      tree,
      leafIndex,
    );

    const treasuryState = await getAccount(
      provider.connection,
      treasuryTokenAccount.address,
    );
    const recipientState = await getAccount(
      provider.connection,
      recipientTokenAccount.address,
    );

    assert.equal(Number(treasuryState.amount), 25_000);
    assert.equal(Number(recipientState.amount), 975_000);
  });

  it("splits relayed SPL withdrawals between treasury, relayer, and recipient", async () => {
    const mint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6,
    );
    const treasuryOwner = Keypair.generate();
    const relayer = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, relayer.publicKey, 1_000_000_000);

    const treasuryTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      treasuryOwner.publicKey,
      true,
    );
    const relayerTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      relayer.publicKey,
    );
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      recipient.publicKey,
    );
    const { pool, poolVault } = await createFeeSplPool(
      program,
      mint,
      SPL_DEPOSIT_AMOUNT,
      treasuryTokenAccount.address,
      250,
    );
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

    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositFeeSpl(
      program,
      pool.publicKey,
      poolVault,
      depositorTokenAccount.address,
      note.commitment,
    );

    await withdrawRelayedFeeSpl(
      program,
      pool.publicKey,
      poolVault,
      treasuryTokenAccount.address,
      relayer,
      recipient.publicKey,
      recipientTokenAccount.address,
      relayerTokenAccount.address,
      note,
      tree,
      leafIndex,
      new anchor.BN(100_000),
    );

    const treasuryState = await getAccount(
      provider.connection,
      treasuryTokenAccount.address,
    );
    const relayerState = await getAccount(
      provider.connection,
      relayerTokenAccount.address,
    );
    const recipientState = await getAccount(
      provider.connection,
      recipientTokenAccount.address,
    );

    assert.equal(Number(treasuryState.amount), 25_000);
    assert.equal(Number(relayerState.amount), 100_000);
    assert.equal(Number(recipientState.amount), 875_000);
  });

  it("supports fee-capable pools with protocolFeeBps = 0", async () => {
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      0,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    const minimumVaultRent = await provider.connection.getMinimumBalanceForRentExemption(0);
    await fundSystemAccount(provider, poolVault, minimumVaultRent);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);
    const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
    await withdrawFeeV2(
      program,
      pool.publicKey,
      poolVault,
      treasury.publicKey,
      recipient.publicKey,
      note,
      tree,
      leafIndex,
      20,
    );
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    const recipientAfter = await provider.connection.getBalance(recipient.publicKey);

    assert.equal(treasuryAfter - treasuryBefore, 0);
    assert.equal(recipientAfter - recipientBefore, 100_000_000);
  });

  it("rejects protocolFeeBps above 500", async () => {
    const pool = Keypair.generate();
    const treasury = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);

    try {
      await (program.methods as any)
        .initializeFeeV2(SOL_DEPOSIT_AMOUNT, 20, 501)
        .accounts({
          pool: pool.publicKey,
          poolVault,
          treasury: treasury.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([pool])
        .preInstructions([computeBudgetIx(1_400_000)])
        .rpc();
      assert.fail("Expected protocolFeeBps > 500 to fail");
    } catch (error) {
      assert.match(String(error), /ProtocolFeeBpsTooHigh|protocol_fee_bps/i);
    }
  });

  it("rejects relayed withdrawals when protocol and relayer fees are too high together", async () => {
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    const relayer = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);
    await fundSystemAccount(provider, relayer.publicKey, 1_000_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      500,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    try {
      await withdrawRelayedFeeV2(
        program,
        pool.publicKey,
        poolVault,
        treasury.publicKey,
        relayer,
        recipient.publicKey,
        note,
        tree,
        leafIndex,
        20,
        new anchor.BN(95_000_000),
      );
      assert.fail("Expected combined fees to be rejected");
    } catch (error) {
      assert.match(String(error), /CombinedFeeTooHigh|protocol fee plus relayer fee/i);
    }
  });

  it("rejects wrong treasury accounts on-chain", async () => {
    const treasury = Keypair.generate();
    const wrongTreasury = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, wrongTreasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      250,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    try {
      await withdrawFeeV2(
        program,
        pool.publicKey,
        poolVault,
        wrongTreasury.publicKey,
        recipient.publicKey,
        note,
        tree,
        leafIndex,
        20,
      );
      assert.fail("Expected wrong treasury to be rejected");
    } catch (error) {
      assert.match(String(error), /InvalidTreasury|treasury/i);
    }
  });

  it("preserves exact integer fee precision at 0.25%", async () => {
    const precisionAmount = new anchor.BN(1_000_000);
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      precisionAmount,
      20,
      treasury.publicKey,
      25,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);
    const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
    await withdrawFeeV2(
      program,
      pool.publicKey,
      poolVault,
      treasury.publicKey,
      recipient.publicKey,
      note,
      tree,
      leafIndex,
      20,
    );
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    const recipientAfter = await provider.connection.getBalance(recipient.publicKey);

    assert.equal(treasuryAfter - treasuryBefore, 2_500);
    assert.equal(recipientAfter - recipientBefore, 997_500);
  });

  it("accumulates protocol fees exactly across repeated withdrawals", async () => {
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      250,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const notes: Awaited<ReturnType<typeof generateZKNote>>[] = [];
    const leafIndexes: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      const note = await generateZKNote();
      notes.push(note);
      leafIndexes.push(tree.insert(note.commitment));
      await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);
    }

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    for (const [index, note] of notes.entries()) {
      await withdrawFeeV2(
        program,
        pool.publicKey,
        poolVault,
        treasury.publicKey,
        recipient.publicKey,
        note,
        tree,
        leafIndexes[index],
        20,
      );
    }

    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(treasuryAfter - treasuryBefore, 25_000_000);
  });

  it("handles fee math at the maximum supported client denomination without overflow", async () => {
    const pool = Keypair.generate();
    const treasury = Keypair.generate();
    const recipient = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);
    const fakeNullifierHash = new Uint8Array(32).fill(7);
    const [nullifierRecord] = deriveNullifierRecordPda(
      pool.publicKey,
      fakeNullifierHash,
      program.programId,
    );
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    await (program.methods as any)
      .initializeFeeV2(MAX_CLIENT_DEPOSIT_AMOUNT, 20, 500)
      .accounts({
        pool: pool.publicKey,
        poolVault,
        treasury: treasury.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([pool])
      .preInstructions([computeBudgetIx(1_400_000)])
      .rpc();

    try {
      await (program.methods as any)
        .withdrawZkFeeV2(
          new Array(64).fill(0),
          new Array(128).fill(0),
          new Array(64).fill(0),
          new Array(32).fill(0),
          Array.from(fakeNullifierHash),
        )
        .accounts({
          pool: pool.publicKey,
          poolVault,
          treasury: treasury.publicKey,
          recipient: recipient.publicKey,
          payer: authority.publicKey,
          nullifierRecord,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx(1_400_000)])
        .rpc();
      assert.fail("Expected invalid root/proof failure");
    } catch (error) {
      assert.notMatch(String(error), /overflow/i);
      assert.match(String(error), /InvalidRoot|InvalidProof/i);
    }
  });

  it("updates the treasury and emits an auditable event", async () => {
    const treasury = Keypair.generate();
    const newTreasury = Keypair.generate();
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, newTreasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      250,
    );
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositFeeV2(program, pool.publicKey, poolVault, note.commitment);

    const updateSignature = await (program.methods as any)
      .updateTreasury(newTreasury.publicKey)
      .accounts({
        pool: pool.publicKey,
        authority: authority.publicKey,
      })
      .rpc();

    const transaction = await fetchConfirmedTransaction(
      provider.connection,
      updateSignature,
    );
    const coder = new anchor.BorshCoder(BUILT_PROGRAM_IDL);
    const treasuryUpdated = (transaction?.meta?.logMessages ?? [])
      .filter((log) => log.startsWith("Program data: "))
      .map((log) => coder.events.decode(log.slice("Program data: ".length)))
      .find((event) => event?.name === "TreasuryUpdated");
    const treasuryUpdatedData = treasuryUpdated?.data as
      | {
          pool: PublicKey;
          old_treasury?: PublicKey;
          new_treasury?: PublicKey;
        }
      | undefined;

    assert.exists(treasuryUpdated);
    assert.equal(treasuryUpdatedData?.pool.toBase58(), pool.publicKey.toBase58());
    assert.equal(
      treasuryUpdatedData?.old_treasury?.toBase58(),
      treasury.publicKey.toBase58(),
    );
    assert.equal(
      treasuryUpdatedData?.new_treasury?.toBase58(),
      newTreasury.publicKey.toBase58(),
    );

    const poolState = await (program.account as any).poolFeeV2.fetch(pool.publicKey);
    assert.equal(poolState.treasury.toBase58(), newTreasury.publicKey.toBase58());

    const oldTreasuryBefore = await provider.connection.getBalance(treasury.publicKey);
    const newTreasuryBefore = await provider.connection.getBalance(newTreasury.publicKey);
    await withdrawFeeV2(
      program,
      pool.publicKey,
      poolVault,
      newTreasury.publicKey,
      recipient.publicKey,
      note,
      tree,
      leafIndex,
      20,
    );
    const oldTreasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    const newTreasuryAfter = await provider.connection.getBalance(newTreasury.publicKey);

    assert.equal(oldTreasuryAfter - oldTreasuryBefore, 0);
    assert.equal(newTreasuryAfter - newTreasuryBefore, 2_500_000);
  });

  it("rejects unauthorized treasury updates", async () => {
    const treasury = Keypair.generate();
    const newTreasury = Keypair.generate();
    const outsider = Keypair.generate();
    await fundSystemAccount(provider, treasury.publicKey, 1_000_000);
    await fundSystemAccount(provider, outsider.publicKey, 1_000_000);

    const { pool } = await createFeeSolPool(
      program,
      SOL_DEPOSIT_AMOUNT,
      20,
      treasury.publicKey,
      250,
    );

    try {
      await (program.methods as any)
        .updateTreasury(newTreasury.publicKey)
        .accounts({
          pool: pool.publicKey,
          authority: outsider.publicKey,
        })
        .signers([outsider])
        .rpc();
      assert.fail("Expected unauthorized treasury update to fail");
    } catch (error) {
      assert.match(String(error), /ConstraintHasOne|authority|signature/i);
    }
  });

  it("keeps existing non-fee V2 pools backward compatible", async () => {
    const recipient = Keypair.generate();
    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);

    const { pool, poolVault } = await createV2Pool(program, SOL_DEPOSIT_AMOUNT, 20);
    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    const note = await generateZKNote();
    const leafIndex = tree.insert(note.commitment);
    await depositV2(program, pool.publicKey, poolVault, note.commitment);

    const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
    await withdrawV2(
      program,
      pool.publicKey,
      poolVault,
      recipient.publicKey,
      note,
      tree,
      leafIndex,
      20,
    );
    const recipientAfter = await provider.connection.getBalance(recipient.publicKey);

    assert.equal(recipientAfter - recipientBefore, 100_000_000);
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
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .rpc();

  return { pool, poolVault };
}

async function createFeeSolPool(
  program: anchor.Program<any>,
  depositAmount: anchor.BN,
  treeDepth: number,
  treasury: PublicKey,
  protocolFeeBps: number,
) {
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

  await (program.methods as any)
    .initializeFeeV2(depositAmount, treeDepth, protocolFeeBps)
    .accounts({
      pool: pool.publicKey,
      poolVault,
      treasury,
      authority: program.provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .rpc();

  return { pool, poolVault };
}

async function createFeeSplPool(
  program: anchor.Program<any>,
  mint: PublicKey,
  depositAmount: anchor.BN,
  treasuryTokenAccount: PublicKey,
  protocolFeeBps: number,
) {
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

  await (program.methods as any)
    .initializeFeeSpl(depositAmount, mint, protocolFeeBps)
    .accounts({
      pool: pool.publicKey,
      poolVault,
      tokenMintAccount: mint,
      treasuryTokenAccount,
      authority: program.provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
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
  const pageIndex = Math.floor(Number(poolState.nextIndex) / COMMITMENT_PAGE_CAPACITY);
  const [commitmentPage] = deriveCommitmentPagePda(pool, pageIndex, program.programId);

  await (program.methods as any)
    .depositV2(bigintToBytes(commitment, 32), pageIndex)
    .accounts({
      commitmentPage,
      pool,
      poolVault,
      depositor: program.provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}

async function depositFeeV2(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  commitment: bigint,
) {
  const poolState = await (program.account as any).poolFeeV2.fetch(pool);
  const pageIndex = Math.floor(Number(poolState.nextIndex) / COMMITMENT_PAGE_CAPACITY);
  const [commitmentPage] = deriveCommitmentPagePda(pool, pageIndex, program.programId);

  await (program.methods as any)
    .depositFeeV2(bigintToBytes(commitment, 32), pageIndex)
    .accounts({
      commitmentPage,
      pool,
      poolVault,
      depositor: program.provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}

async function depositFeeSpl(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  depositorTokenAccount: PublicKey,
  commitment: bigint,
) {
  const poolState = await (program.account as any).poolFeeV2.fetch(pool);
  const pageIndex = Math.floor(Number(poolState.nextIndex) / COMMITMENT_PAGE_CAPACITY);
  const [commitmentPage] = deriveCommitmentPagePda(pool, pageIndex, program.programId);

  await (program.methods as any)
    .depositFeeSpl(bigintToBytes(commitment, 32), pageIndex)
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

async function withdrawV2(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  recipient: PublicKey,
  note: Awaited<ReturnType<typeof generateZKNote>>,
  tree: PoseidonMerkleTree,
  leafIndex: number,
  treeDepth: number,
) {
  const { proof } = await generateWithdrawProof(
    note,
    tree,
    leafIndex,
    pubkeyToFieldElement(recipient.toBytes()),
    treeDepth,
  );
  const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
  const rootBytes = bigintToBytes(tree.getRoot(), 32);
  const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
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
      pool,
      poolVault,
      recipient,
      payer: program.provider.wallet.publicKey,
      nullifierRecord,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}

async function withdrawFeeV2(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  treasury: PublicKey,
  recipient: PublicKey,
  note: Awaited<ReturnType<typeof generateZKNote>>,
  tree: PoseidonMerkleTree,
  leafIndex: number,
  treeDepth: number,
) {
  const { proof } = await generateWithdrawProof(
    note,
    tree,
    leafIndex,
    pubkeyToFieldElement(recipient.toBytes()),
    treeDepth,
  );
  const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
  const rootBytes = bigintToBytes(tree.getRoot(), 32);
  const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
    Uint8Array.from(nullifierHashBytes),
    program.programId,
  );

  await (program.methods as any)
    .withdrawZkFeeV2(
      proofABytes,
      proofBBytes,
      proofCBytes,
      rootBytes,
      nullifierHashBytes,
    )
    .accounts({
      pool,
      poolVault,
      treasury,
      recipient,
      payer: program.provider.wallet.publicKey,
      nullifierRecord,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}

async function withdrawRelayedFeeV2(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  treasury: PublicKey,
  relayer: Keypair,
  recipient: PublicKey,
  note: Awaited<ReturnType<typeof generateZKNote>>,
  tree: PoseidonMerkleTree,
  leafIndex: number,
  treeDepth: number,
  relayerFeeLamports: anchor.BN,
): Promise<string> {
  const { proof } = await generateWithdrawProof(
    note,
    tree,
    leafIndex,
    pubkeyToFieldElement(recipient.toBytes()),
    treeDepth,
  );
  const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
  const rootBytes = bigintToBytes(tree.getRoot(), 32);
  const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
    Uint8Array.from(nullifierHashBytes),
    program.programId,
  );

  return (program.methods as any)
    .withdrawZkRelayedFeeV2(
      proofABytes,
      proofBBytes,
      proofCBytes,
      rootBytes,
      nullifierHashBytes,
      relayerFeeLamports,
    )
    .accounts({
      pool,
      poolVault,
      relayer: relayer.publicKey,
      treasury,
      recipient,
      nullifierRecord,
      systemProgram: SystemProgram.programId,
    })
    .signers([relayer])
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}

async function withdrawFeeSpl(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  treasuryTokenAccount: PublicKey,
  recipient: PublicKey,
  recipientTokenAccount: PublicKey,
  note: Awaited<ReturnType<typeof generateZKNote>>,
  tree: PoseidonMerkleTree,
  leafIndex: number,
) {
  const { proof } = await generateWithdrawProof(
    note,
    tree,
    leafIndex,
    pubkeyToFieldElement(recipient.toBytes()),
    20,
  );
  const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
  const rootBytes = bigintToBytes(tree.getRoot(), 32);
  const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
    Uint8Array.from(nullifierHashBytes),
    program.programId,
  );

  await (program.methods as any)
    .withdrawZkFeeSpl(
      proofABytes,
      proofBBytes,
      proofCBytes,
      rootBytes,
      nullifierHashBytes,
    )
    .accounts({
      pool,
      poolVault,
      recipient,
      treasuryTokenAccount,
      recipientTokenAccount,
      payer: program.provider.wallet.publicKey,
      nullifierRecord,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}

async function withdrawRelayedFeeSpl(
  program: anchor.Program<any>,
  pool: PublicKey,
  poolVault: PublicKey,
  treasuryTokenAccount: PublicKey,
  relayer: Keypair,
  recipient: PublicKey,
  recipientTokenAccount: PublicKey,
  relayerTokenAccount: PublicKey,
  note: Awaited<ReturnType<typeof generateZKNote>>,
  tree: PoseidonMerkleTree,
  leafIndex: number,
  relayerFeeAmount: anchor.BN,
) {
  const { proof } = await generateWithdrawProof(
    note,
    tree,
    leafIndex,
    pubkeyToFieldElement(recipient.toBytes()),
    20,
  );
  const { proofABytes, proofBBytes, proofCBytes } = formatProof(proof);
  const rootBytes = bigintToBytes(tree.getRoot(), 32);
  const nullifierHashBytes = bigintToBytes(note.nullifierHash, 32);
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
    Uint8Array.from(nullifierHashBytes),
    program.programId,
  );

  await (program.methods as any)
    .withdrawZkRelayedFeeSpl(
      proofABytes,
      proofBBytes,
      proofCBytes,
      rootBytes,
      nullifierHashBytes,
      relayerFeeAmount,
    )
    .accounts({
      pool,
      poolVault,
      relayer: relayer.publicKey,
      recipient,
      treasuryTokenAccount,
      recipientTokenAccount,
      relayerTokenAccount,
      nullifierRecord,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([relayer])
    .preInstructions([computeBudgetIx(1_400_000)])
    .rpc();
}
