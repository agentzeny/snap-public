import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SystemInstruction,
} from "@solana/web3.js";
import { createNote } from "../../sdk-package/src/commitment";
import {
  createManualNote,
  createResultRecorder,
  createLegacyPool,
  createSplPool,
  createV2SolPool,
  depositLegacyCommitment,
  depositSplCommitment,
  depositV2Commitment,
  ensureFundedRecipient,
  extractNullifierRecord,
  mintToWalletAta,
  noteToCircuitInput,
  randomFieldElement,
  sendRawInstruction,
  summarizeError,
  toNumber,
  type AdversarialCaseResult,
  attemptDirectProof,
} from "./shared";
import {
  COMMITMENT_PAGE_CAPACITY,
  deriveCommitmentPagePda,
} from "../../sdk-package/src/commitment-pages";
import {
  PoseidonMerkleTree,
  initPoseidon,
} from "../../sdk/poseidon-merkle";
import { computeBudgetIx, deriveNullifierRecordPda, deriveVaultPda, formatProof, fundSystemAccount } from "../helpers";

/**
 * On-chain program adversarial tests.
 *
 * Every test submits a transaction that SHOULD be rejected.
 * These bypass the SDK and construct raw instructions to test
 * the program's own validation layer.
 */

describe("On-chain program adversarial tests", function () {
  this.timeout(20 * 60 * 1000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentPrivacyPool as anchor.Program<any>;
  const recorder = createResultRecorder("program.json", "program");
  const unexpectedCases: string[] = [];
  const solDepositAmountLamports = 1_000_000;
  const splDepositAmountRaw = 1_000_000;

  before(async () => {
    await initPoseidon();
  });

  after(() => {
    recorder.persist();
  });

  it("2a-pool. rejects withdraw_zk_v2 with the wrong pool account", async () => {
    const context = await setupValidSolWithdraw(10);
    const outsider = Keypair.generate();
    await fundSystemAccount(provider, outsider.publicKey, 1_000_000);

    const instruction = await (program.methods as any)
      .withdrawZkV2(
        context.formattedProof.proofABytes,
        context.formattedProof.proofBBytes,
        context.formattedProof.proofCBytes,
        context.rootBytes,
        Array.from(context.note.nullifierHash),
      )
      .accounts({
        nullifierRecord: context.nullifierRecord,
        payer: provider.wallet.publicKey,
        pool: context.pool.publicKey,
        poolVault: context.poolVault,
        recipient: context.recipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    instruction.keys[0] = {
      ...instruction.keys[0],
      pubkey: outsider.publicKey,
    };

    const result = await captureProgramFailure({
      attempted:
        "Submitted withdraw_zk_v2 with a random system account in the pool slot instead of the pool PDA.",
      caseId: "2a-pool",
      name: "Wrong accounts: random pool account",
      send: async () => sendRawInstruction({ instruction, program }),
    });

    recordCase(result);
  });

  it("2a-depositor. rejects deposit_v2 when the depositor is not a signer", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports: solDepositAmountLamports,
      program,
      treeDepth: 10,
    });
    const victim = Keypair.generate();
    const note = await createNote(pool.publicKey, 0);
    const [commitmentPage] = deriveCommitmentPagePda(pool.publicKey, 0, program.programId);

    const instruction = await (program.methods as any)
      .depositV2(Array.from(note.commitment), 0)
      .accounts({
        commitmentPage,
        depositor: victim.publicKey,
        pool: pool.publicKey,
        poolVault,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    instruction.keys[2] = {
      ...instruction.keys[2],
      isSigner: false,
    };

    const result = await captureProgramFailure({
      attempted:
        "Built a raw deposit_v2 instruction with another wallet as depositor but stripped the signer flag so only the fee payer signed.",
      caseId: "2a-depositor",
      name: "Wrong accounts: depositor without signature",
      send: async () => sendRawInstruction({ instruction, program }),
    });

    recordCase(result);
  });

  it("2a-spl. rejects withdraw_zk_spl with a token account for the wrong mint", async () => {
    const context = await setupValidSplWithdraw();
    const wrongMint = await createMint(
      provider.connection,
      context.payer,
      provider.wallet.publicKey,
      null,
      6,
    );
    const wrongMintAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      context.payer,
      wrongMint,
      context.recipient.publicKey,
    );

    const result = await captureProgramFailure({
      attempted:
        "Submitted withdraw_zk_spl with a recipient token account whose mint does not match the pool mint.",
      caseId: "2a-spl",
      name: "Wrong accounts: wrong token mint",
      send: async () =>
        (program.methods as any)
          .withdrawZkSpl(
            context.formattedProof.proofABytes,
            context.formattedProof.proofBBytes,
            context.formattedProof.proofCBytes,
            context.rootBytes,
            Array.from(context.note.nullifierHash),
          )
          .accounts({
            nullifierRecord: context.nullifierRecord,
            payer: provider.wallet.publicKey,
            pool: context.pool.publicKey,
            poolVault: context.poolVault,
            recipient: context.recipient.publicKey,
            recipientTokenAccount: wrongMintAta.address,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2b-legacy-with-spl. rejects withdraw_zk against a V2 SPL pool", async () => {
    const splPool = await createSplPool({
      depositAmountRaw: splDepositAmountRaw,
      program,
    });
    const recipient = Keypair.generate();
    await ensureFundedRecipient(program, recipient.publicKey);

    const result = await captureProgramFailure({
      attempted:
        "Called legacy withdraw_zk against a V2 SPL pool and token vault.",
      caseId: "2b-legacy-with-spl",
      name: "Instruction confusion: legacy withdraw on SPL V2 pool",
      send: async () =>
        (program.methods as any)
          .withdrawZk(
            new Array(64).fill(0),
            new Array(128).fill(0),
            new Array(64).fill(0),
            new Array(32).fill(0),
            new Array(32).fill(0),
          )
          .accounts({
            payer: provider.wallet.publicKey,
            pool: splPool.pool.publicKey,
            poolVault: splPool.poolVault,
            recipient: recipient.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2b-spl-with-sol. rejects withdraw_zk_spl against a V2 SOL pool", async () => {
    const context = await setupValidSolWithdraw(10);
    const wrongMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet & { payer: Keypair }).payer,
      provider.wallet.publicKey,
      null,
      6,
    );
    const wrongMintAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet & { payer: Keypair }).payer,
      wrongMint,
      context.recipient.publicKey,
    );

    const result = await captureProgramFailure({
      attempted:
        "Called withdraw_zk_spl against a SOL V2 pool.",
      caseId: "2b-spl-with-sol",
      name: "Instruction confusion: SPL withdraw on SOL V2 pool",
      send: async () =>
        (program.methods as any)
          .withdrawZkSpl(
            context.formattedProof.proofABytes,
            context.formattedProof.proofBBytes,
            context.formattedProof.proofCBytes,
            context.rootBytes,
            Array.from(context.note.nullifierHash),
          )
          .accounts({
            nullifierRecord: context.nullifierRecord,
            payer: provider.wallet.publicKey,
            pool: context.pool.publicKey,
            poolVault: context.poolVault,
            recipient: context.recipient.publicKey,
            recipientTokenAccount: wrongMintAta.address,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2b-deposit-legacy-with-v2. rejects deposit against a V2 pool", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports: solDepositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(pool.publicKey, 0);

    const result = await captureProgramFailure({
      attempted: "Called legacy deposit against a V2 pool account.",
      caseId: "2b-deposit-legacy-with-v2",
      name: "Instruction confusion: legacy deposit on V2 pool",
      send: async () =>
        (program.methods as any)
          .deposit(Array.from(note.commitment))
          .accounts({
            depositor: provider.wallet.publicKey,
            pool: pool.publicKey,
            poolVault,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2b-deposit-v2-with-legacy. rejects deposit_v2 against a legacy pool", async () => {
    const { pool, poolVault } = await createLegacyPool(
      program,
      solDepositAmountLamports,
    );
    const note = await createNote(pool.publicKey, 0);
    const [commitmentPage] = deriveCommitmentPagePda(pool.publicKey, 0, program.programId);

    const result = await captureProgramFailure({
      attempted: "Called deposit_v2 against a legacy pool account.",
      caseId: "2b-deposit-v2-with-legacy",
      name: "Instruction confusion: V2 deposit on legacy pool",
      send: async () =>
        (program.methods as any)
          .depositV2(Array.from(note.commitment), 0)
          .accounts({
            commitmentPage,
            depositor: provider.wallet.publicKey,
            pool: pool.publicKey,
            poolVault,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2c. documents legacy realloc behavior near 10KB", async () => {
    const { pool, poolVault } = await createLegacyPool(program, 1);
    const initialInfo = await fetchRequiredAccountInfo(pool.publicKey);

    let deposits = 0;
    let outcome: "failed" | "succeeded" = "succeeded";
    let finalError: unknown;
    let accountInfo = initialInfo;

    for (; deposits < 300; deposits += 1) {
      const note = await createNote(pool.publicKey, deposits);

      try {
        await depositLegacyCommitment({
          commitment: note.commitment,
          pool: pool.publicKey,
          poolVault,
          program,
        });
      } catch (error) {
        outcome = "failed";
        finalError = error;
        break;
      }

      if ((deposits + 1) % 25 === 0) {
        accountInfo = await fetchRequiredAccountInfo(pool.publicKey);
      }
    }

    const finalInfo = await fetchRequiredAccountInfo(pool.publicKey);

    const result: AdversarialCaseResult = {
      attempted:
        "Repeatedly deposited into a legacy pool with 1-lamport denomination until the account approached the 10KB realloc zone.",
      caseId: "2c",
      matchedExpectation: true,
      name: "Realloc manipulation",
      notes: [
        `Deposits attempted: ${deposits}`,
        `Final account bytes: ${finalInfo.data.length}`,
        `Final account lamports: ${finalInfo.lamports}`,
        `Outcome: ${outcome}`,
      ],
      onChain:
        outcome === "succeeded"
          ? {
              status: "succeeded",
            }
          : {
              error: summarizeError(finalError),
              status: "failed",
            },
    };

    recorder.push(result);
  });

  it("2d-over. rejects relayed fees above the deposit amount", async () => {
    const context = await setupValidSolWithdraw(10, true);

    const result = await captureProgramFailure({
      attempted:
        "Called withdraw_zk_relayed_v2 with fee_lamports greater than deposit_amount.",
      caseId: "2d-over",
      name: "Fee manipulation: fee > deposit amount",
      send: async () =>
        (program.methods as any)
          .withdrawZkRelayedV2(
            context.formattedProof.proofABytes,
            context.formattedProof.proofBBytes,
            context.formattedProof.proofCBytes,
            context.rootBytes,
            Array.from(context.note.nullifierHash),
            new anchor.BN(solDepositAmountLamports + 1),
          )
          .accounts({
            nullifierRecord: context.nullifierRecord,
            pool: context.pool.publicKey,
            poolVault: context.poolVault,
            recipient: context.recipient.publicKey,
            relayer: context.relayer!.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([context.relayer!])
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2d-equal. rejects relayed fees equal to the deposit amount", async () => {
    const context = await setupValidSolWithdraw(10, true);

    const result = await captureProgramFailure({
      attempted:
        "Called withdraw_zk_relayed_v2 with fee_lamports equal to deposit_amount.",
      caseId: "2d-equal",
      name: "Fee manipulation: fee == deposit amount",
      send: async () =>
        (program.methods as any)
          .withdrawZkRelayedV2(
            context.formattedProof.proofABytes,
            context.formattedProof.proofBBytes,
            context.formattedProof.proofCBytes,
            context.rootBytes,
            Array.from(context.note.nullifierHash),
            new anchor.BN(solDepositAmountLamports),
          )
          .accounts({
            nullifierRecord: context.nullifierRecord,
            pool: context.pool.publicKey,
            poolVault: context.poolVault,
            recipient: context.recipient.publicKey,
            relayer: context.relayer!.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([context.relayer!])
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2d-max. rejects relayed fees at u64::MAX", async () => {
    const context = await setupValidSolWithdraw(10, true);

    const result = await captureProgramFailure({
      attempted: "Called withdraw_zk_relayed_v2 with fee_lamports = u64::MAX.",
      caseId: "2d-max",
      name: "Fee manipulation: fee = u64::MAX",
      send: async () =>
        (program.methods as any)
          .withdrawZkRelayedV2(
            context.formattedProof.proofABytes,
            context.formattedProof.proofBBytes,
            context.formattedProof.proofCBytes,
            context.rootBytes,
            Array.from(context.note.nullifierHash),
            new anchor.BN("18446744073709551615"),
          )
          .accounts({
            nullifierRecord: context.nullifierRecord,
            pool: context.pool.publicKey,
            poolVault: context.poolVault,
            recipient: context.recipient.publicKey,
            relayer: context.relayer!.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([context.relayer!])
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2e-zero. rejects initialize_v2 with deposit_amount = 0", async () => {
    const result = await captureInitializationResult({
      attempted: "Initialized a SOL V2 pool with deposit_amount = 0.",
      caseId: "2e-zero",
      name: "Pool initialization abuse: deposit_amount = 0",
      send: () => initializeV2WithArgs(0, 10),
    });

    recordCase(result);
  });

  it("2e-max. rejects initialize_v2 with deposit_amount = u64::MAX", async () => {
    const result = await captureInitializationResult({
      attempted: "Initialized a SOL V2 pool with deposit_amount = u64::MAX.",
      caseId: "2e-max",
      name: "Pool initialization abuse: deposit_amount = u64::MAX",
      send: () => initializeV2WithArgs("18446744073709551615", 10),
    });

    recordCase(result);
  });

  it("2e-depth-0. rejects tree_depth = 0", async () => {
    const result = await captureInitializationResult({
      attempted: "Initialized a SOL V2 pool with tree_depth = 0.",
      caseId: "2e-depth-0",
      name: "Pool initialization abuse: tree_depth = 0",
      send: () => initializeV2WithArgs(solDepositAmountLamports, 0),
    });

    recordCase(result);
  });

  it("2e-depth-15. rejects tree_depth = 15", async () => {
    const result = await captureInitializationResult({
      attempted: "Initialized a SOL V2 pool with tree_depth = 15.",
      caseId: "2e-depth-15",
      name: "Pool initialization abuse: tree_depth = 15",
      send: () => initializeV2WithArgs(solDepositAmountLamports, 15),
    });

    recordCase(result);
  });

  it("2e-depth-255. rejects tree_depth = 255", async () => {
    const result = await captureInitializationResult({
      attempted: "Initialized a SOL V2 pool with tree_depth = 255.",
      caseId: "2e-depth-255",
      name: "Pool initialization abuse: tree_depth = 255",
      send: () => initializeV2WithArgs(solDepositAmountLamports, 255),
    });

    recordCase(result);
  });

  it("2e-spl-mint. rejects initialize_spl with a nonexistent mint", async () => {
    const pool = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);
    const nonexistentMint = Keypair.generate().publicKey;

    const result = await captureInitializationResult({
      attempted: "Initialized an SPL pool with a mint account that does not exist.",
      caseId: "2e-spl-mint",
      name: "Pool initialization abuse: nonexistent SPL mint",
      send: () =>
        (program.methods as any)
          .initializeSpl(new anchor.BN(splDepositAmountRaw), nonexistentMint)
          .accounts({
            authority: provider.wallet.publicKey,
            pool: pool.publicKey,
            poolVault,
            systemProgram: SystemProgram.programId,
            tokenMintAccount: nonexistentMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([pool])
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2f. rejects double initialization at the same PDA", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports: solDepositAmountLamports,
      program,
      treeDepth: 10,
    });

    const result = await captureProgramFailure({
      attempted:
        "Initialized a V2 pool, then tried to initialize the same account again with different parameters.",
      caseId: "2f",
      name: "Double initialization",
      send: async () =>
        (program.methods as any)
          .initializeV2(new anchor.BN(solDepositAmountLamports + 1), 20)
          .accounts({
            authority: provider.wallet.publicKey,
            pool: pool.publicKey,
            poolVault,
            systemProgram: SystemProgram.programId,
          })
          .signers([pool])
          .preInstructions([computeBudgetIx()])
          .rpc(),
    });

    recordCase(result);
  });

  it("2g. rejects unauthorized crafted drains and records that there are no admin-only instructions", async () => {
    const { pool } = await createV2SolPool({
      depositAmountLamports: solDepositAmountLamports,
      program,
      treeDepth: 10,
    });
    const attacker = Keypair.generate();
    await fundSystemAccount(provider, attacker.publicKey, 2_000_000);

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: pool.publicKey,
      lamports: 1,
      toPubkey: attacker.publicKey,
    });

    const result = await captureProgramFailure({
      attempted:
        "Tried to drain the program-owned pool metadata account with a crafted system transfer; the current IDL has no admin-only instructions to call instead.",
      caseId: "2g",
      name: "Authority bypass",
      send: async () => sendRawInstruction({ instruction: transferInstruction, program }),
    });
    result.notes = [
      "The current IDL exposes no admin-only instructions.",
      ...(result.notes ?? []),
    ];

    recordCase(result);
  });

  it("2h. rejects a rent-exemption attack against the SOL vault PDA", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports: solDepositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(pool.publicKey, 0);
    const attacker = Keypair.generate();
    await fundSystemAccount(provider, attacker.publicKey, 2_000_000);
    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: poolVault,
      lamports: 1,
      toPubkey: attacker.publicKey,
    });

    const result = await captureProgramFailure({
      attempted:
        "Deposited into a SOL pool, then attempted a direct system transfer from the vault PDA to steal rent-exempt lamports.",
      caseId: "2h",
      name: "Rent exemption attack",
      send: async () => sendRawInstruction({ instruction: transferInstruction, program }),
    });

    recordCase(result);
  });

  it("all program adversarial cases matched expectations", () => {
    assert.deepEqual(
      unexpectedCases,
      [],
      `Unexpected program outcomes: ${unexpectedCases.join(", ")}`,
    );
  });

  async function setupValidSolWithdraw(treeDepth: 10 | 20, withRelayer = false) {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports: solDepositAmountLamports,
      program,
      treeDepth,
    });
    const note = await createNote(pool.publicKey, 0);
    const recipient = Keypair.generate();
    const relayer = withRelayer ? Keypair.generate() : undefined;
    await ensureFundedRecipient(program, recipient.publicKey);
    if (relayer) {
      await fundSystemAccount(provider, relayer.publicKey, 1_000_000_000);
    }

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth,
    });

    const tree = new PoseidonMerkleTree(treeDepth);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    const proof = tree.getProof(0);
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: proof.pathElements,
        pathIndices: proof.pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth,
    });

    assert.equal(proofAttempt.status, "generated");
    assert.equal(proofAttempt.verified, true);

    return {
      formattedProof: formatProof(proofAttempt.proof!),
      note,
      nullifierRecord: extractNullifierRecord(pool.publicKey, note, program.programId),
      pool,
      poolVault,
      recipient,
      relayer,
      rootBytes: Array.from(bigintToBytes32(tree.getRoot())),
    };
  }

  async function setupValidSplWithdraw() {
    const splPool = await createSplPool({
      depositAmountRaw: splDepositAmountRaw,
      program,
    });
    const depositorAta = await mintToWalletAta({
      amountRaw: splDepositAmountRaw,
      mint: splPool.mint,
      owner: provider.wallet.publicKey,
      payer: splPool.payer,
      program,
    });
    const note = await createNote(splPool.pool.publicKey, 0);
    const recipient = Keypair.generate();
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      splPool.payer,
      splPool.mint,
      recipient.publicKey,
    );
    await ensureFundedRecipient(program, recipient.publicKey);

    await depositSplCommitment({
      commitment: note.commitment,
      depositorTokenAccount: depositorAta.address,
      pool: splPool.pool.publicKey,
      poolVault: splPool.poolVault,
      program,
    });

    const tree = new PoseidonMerkleTree(20);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    const proof = tree.getProof(0);
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: proof.pathElements,
        pathIndices: proof.pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 20,
    });

    assert.equal(proofAttempt.status, "generated");
    assert.equal(proofAttempt.verified, true);

    return {
      ...splPool,
      formattedProof: formatProof(proofAttempt.proof!),
      note,
      nullifierRecord: extractNullifierRecord(
        splPool.pool.publicKey,
        note,
        program.programId,
      ),
      recipient,
      recipientTokenAccount,
      rootBytes: Array.from(bigintToBytes32(tree.getRoot())),
    };
  }

  async function captureProgramFailure(args: {
    attempted: string;
    caseId: string;
    name: string;
    send: () => Promise<string>;
  }): Promise<AdversarialCaseResult> {
    const result: AdversarialCaseResult = {
      attempted: args.attempted,
      caseId: args.caseId,
      matchedExpectation: false,
      name: args.name,
    };

    try {
      result.onChain = {
        status: "succeeded",
        txSignature: await args.send(),
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = true;
    }

    return result;
  }

  async function captureInitializationResult(args: {
    attempted: string;
    caseId: string;
    name: string;
    send: () => Promise<string>;
  }): Promise<AdversarialCaseResult> {
    return captureProgramFailure(args);
  }

  async function initializeV2WithArgs(
    depositAmount: number | string,
    treeDepth: number,
  ): Promise<string> {
    const pool = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

    return (program.methods as any)
      .initializeV2(new anchor.BN(depositAmount), treeDepth)
      .accounts({
        authority: provider.wallet.publicKey,
        pool: pool.publicKey,
        poolVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([pool])
      .preInstructions([computeBudgetIx()])
      .rpc();
  }

  function bigintToBytes32(value: bigint): Uint8Array {
    const hex = value.toString(16).padStart(64, "0");
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  function bytesToBigint(bytes: Uint8Array): bigint {
    return BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  }

  function recordCase(result: AdversarialCaseResult) {
    recorder.push(result);
    if (!result.matchedExpectation) {
      unexpectedCases.push(result.caseId);
    }
  }

  async function fetchRequiredAccountInfo(
    address: PublicKey,
    attempts = 10,
    delayMs = 250,
  ) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accountInfo = await provider.connection.getAccountInfo(address, "confirmed");
      if (accountInfo) {
        return accountInfo;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    assert.fail(`Account ${address.toBase58()} was not visible on localnet`);
  }
});
