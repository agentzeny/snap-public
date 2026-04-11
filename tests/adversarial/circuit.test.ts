import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  Keypair,
  SystemProgram,
  type PublicKey,
} from "@solana/web3.js";
import { createNote, bytesEqual } from "../../sdk-package/src/commitment";
import {
  FIELD_PRIME,
  LEGACY_TREE_DEPTH,
} from "../../sdk-package/src/constants";
import {
  PoseidonMerkleTree,
  initPoseidon,
} from "../../sdk/poseidon-merkle";
import {
  createManualNote,
  createResultRecorder,
  createV2SolPool,
  depositV2Commitment,
  ensureFundedRecipient,
  extractNullifierRecord,
  isCriticalCircuitBypass,
  latestRootBytes,
  noteToCircuitInput,
  PROOF_TIMEOUT_MS,
  randomFieldElement,
  summarizeError,
  type AdversarialCaseResult,
  attemptDirectProof,
  verifyDirectProof,
} from "./shared";
import { computeBudgetIx, formatProof } from "../helpers";

/**
 * Circuit adversarial tests.
 *
 * Every test in this file attempts to forge a proof or bypass a
 * constraint. ALL tests should FAIL to produce a valid proof.
 * If any test produces a valid proof, that's a critical vulnerability.
 */

describe("Circuit adversarial tests", function () {
  this.timeout(15 * 60 * 1000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentPrivacyPool as anchor.Program<any>;
  const recorder = createResultRecorder("circuit.json", "circuit");
  const unexpectedCases: string[] = [];
  const depositAmountLamports = 1_000_000;

  before(async () => {
    await initPoseidon();
  });

  after(() => {
    recorder.persist();
  });

  it("1a. rejects commitment forgery", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const recipient = Keypair.generate();
    const realNote = await createNote(pool.publicKey, 0);
    const forgedNote = await createNote(pool.publicKey, 0);

    assert.isFalse(
      bytesEqual(realNote.commitment, forgedNote.commitment),
      "forged note unexpectedly matched the real commitment",
    );

    await depositV2Commitment({
      commitment: realNote.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(realNote.commitment));
    const proof = tree.getProof(0);
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note: forgedNote,
        pathElements: proof.pathElements,
        pathIndices: proof.pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Deposited a real commitment, then tried to prove membership with a different secret/nullifier pair against the real Merkle root.",
      caseId: "1a",
      matchedExpectation:
        proofAttempt.status !== "generated" || proofAttempt.verified === false,
      name: "Commitment forgery",
      offChainProof: proofAttempt,
    };

    recordCase(result, true);
  });

  it("1b. rejects nullifier manipulation", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const recipient = Keypair.generate();
    const realNote = await createNote(pool.publicKey, 0);
    const manipulatedNote = await createManualNote({
      depositIndex: 0,
      nullifier: realNote.nullifier + 1n,
      pool: pool.publicKey,
      secret: realNote.secret,
    });

    await depositV2Commitment({
      commitment: realNote.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(realNote.commitment));
    const proof = tree.getProof(0);
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note: manipulatedNote,
        pathElements: proof.pathElements,
        pathIndices: proof.pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Used the original secret with a modified nullifier and the real Merkle path.",
      caseId: "1b",
      matchedExpectation:
        proofAttempt.status !== "generated" || proofAttempt.verified === false,
      name: "Nullifier manipulation",
      offChainProof: proofAttempt,
    };

    recordCase(result, true);
  });

  it("1c. rejects a fabricated Merkle path", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const recipient = Keypair.generate();
    const note = await createNote(pool.publicKey, 0);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));

    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: Array.from({ length: 10 }, () => randomFieldElement()),
        pathIndices: Array.from({ length: 10 }, (_, index) => index % 2),
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Used the correct secret/nullifier with random sibling nodes instead of the real Merkle path.",
      caseId: "1c",
      matchedExpectation:
        proofAttempt.status !== "generated" || proofAttempt.verified === false,
      name: "Wrong Merkle path",
      offChainProof: proofAttempt,
    };

    recordCase(result, true);
  });

  it("1d. rejects a fabricated root on-chain", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(pool.publicKey, 0);
    const recipient = Keypair.generate();
    await ensureFundedRecipient(program, recipient.publicKey);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    const directProof = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: tree.getProof(0).pathElements,
        pathIndices: tree.getProof(0).pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    assert.equal(directProof.status, "generated");
    assert.equal(directProof.verified, true);

    const fakeRoot = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const nullifierRecord = extractNullifierRecord(
      pool.publicKey,
      note,
      program.programId,
    );

    const result: AdversarialCaseResult = {
      attempted:
        "Submitted a valid proof but replaced the public root with bytes not present in the pool root history.",
      caseId: "1d",
      matchedExpectation: false,
      name: "Root fabrication",
      offChainProof: directProof,
    };

    try {
      await (program.methods as any)
        .withdrawZkV2(
          formatProof(directProof.proof!).proofABytes,
          formatProof(directProof.proof!).proofBBytes,
          formatProof(directProof.proof!).proofCBytes,
          Array.from(fakeRoot),
          Array.from(note.nullifierHash),
        )
        .accounts({
          nullifierRecord,
          payer: provider.wallet.publicKey,
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx()])
        .rpc();

      result.onChain = {
        status: "succeeded",
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = /InvalidRoot|root not found/i.test(
        result.onChain.error?.message ?? "",
      );
    }

    recordCase(result, true);
  });

  it("1e. rejects recipient substitution on-chain", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(pool.publicKey, 0);
    const recipientA = Keypair.generate();
    const recipientB = Keypair.generate();
    await ensureFundedRecipient(program, recipientA.publicKey);
    await ensureFundedRecipient(program, recipientB.publicKey);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: tree.getProof(0).pathElements,
        pathIndices: tree.getProof(0).pathIndices,
        recipient: recipientA.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    assert.equal(proofAttempt.status, "generated");
    assert.equal(proofAttempt.verified, true);

    const formattedProof = formatProof(proofAttempt.proof!);
    const nullifierRecord = extractNullifierRecord(
      pool.publicKey,
      note,
      program.programId,
    );

    const result: AdversarialCaseResult = {
      attempted:
        "Generated a valid proof for recipient A, then submitted the same proof to recipient B.",
      caseId: "1e",
      matchedExpectation: false,
      name: "Recipient substitution",
      offChainProof: proofAttempt,
    };

    try {
      await (program.methods as any)
        .withdrawZkV2(
          formattedProof.proofABytes,
          formattedProof.proofBBytes,
          formattedProof.proofCBytes,
          Array.from(bigintToBytes32(tree.getRoot())),
          Array.from(note.nullifierHash),
        )
        .accounts({
          nullifierRecord,
          payer: provider.wallet.publicKey,
          pool: pool.publicKey,
          poolVault,
          recipient: recipientB.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx()])
        .rpc();

      result.onChain = {
        status: "succeeded",
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = /InvalidProof|zero-knowledge proof/i.test(
        result.onChain.error?.message ?? "",
      );
    }

    recordCase(result, true);
  });

  it("1f. rejects cross-pool proof reuse", async () => {
    const poolX = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const poolY = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(poolX.pool.publicKey, 0);
    const recipient = Keypair.generate();
    await ensureFundedRecipient(program, recipient.publicKey);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: poolX.pool.publicKey,
      poolVault: poolX.poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: tree.getProof(0).pathElements,
        pathIndices: tree.getProof(0).pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    assert.equal(proofAttempt.status, "generated");
    assert.equal(proofAttempt.verified, true);

    const formattedProof = formatProof(proofAttempt.proof!);
    const nullifierRecord = extractNullifierRecord(
      poolY.pool.publicKey,
      note,
      program.programId,
    );

    const result: AdversarialCaseResult = {
      attempted:
        "Generated a valid proof against Pool X and submitted it unchanged to Pool Y.",
      caseId: "1f",
      matchedExpectation: false,
      name: "Cross-pool proof reuse",
      offChainProof: proofAttempt,
    };

    try {
      await (program.methods as any)
        .withdrawZkV2(
          formattedProof.proofABytes,
          formattedProof.proofBBytes,
          formattedProof.proofCBytes,
          Array.from(bigintToBytes32(tree.getRoot())),
          Array.from(note.nullifierHash),
        )
        .accounts({
          nullifierRecord,
          payer: provider.wallet.publicKey,
          pool: poolY.pool.publicKey,
          poolVault: poolY.poolVault,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx()])
        .rpc();

      result.onChain = {
        status: "succeeded",
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = /InvalidRoot|root not found/i.test(
        result.onChain.error?.message ?? "",
      );
    }

    recordCase(result, true);
  });

  it("1g. rejects a proof generated with the wrong tree depth", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(pool.publicKey, 0);
    const recipient = Keypair.generate();
    await ensureFundedRecipient(program, recipient.publicKey);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const depth10Tree = new PoseidonMerkleTree(10);
    await depth10Tree.init();
    depth10Tree.insert(bytesToBigint(note.commitment));

    const depth20Tree = new PoseidonMerkleTree(20);
    await depth20Tree.init();
    depth20Tree.insert(bytesToBigint(note.commitment));

    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: depth20Tree.getProof(0).pathElements,
        pathIndices: depth20Tree.getProof(0).pathIndices,
        recipient: recipient.publicKey,
        root: depth20Tree.getRoot(),
      }),
      treeDepth: 20,
    });

    assert.equal(proofAttempt.status, "generated");
    assert.equal(proofAttempt.verified, true);

    const formattedProof = formatProof(proofAttempt.proof!);
    const nullifierRecord = extractNullifierRecord(
      pool.publicKey,
      note,
      program.programId,
    );

    const result: AdversarialCaseResult = {
      attempted:
        "Built a valid depth-20 proof for a note deposited in a depth-10 pool, then submitted that proof to the depth-10 pool using its real root.",
      caseId: "1g",
      matchedExpectation: false,
      name: "Depth mismatch",
      offChainProof: proofAttempt,
    };

    try {
      await (program.methods as any)
        .withdrawZkV2(
          formattedProof.proofABytes,
          formattedProof.proofBBytes,
          formattedProof.proofCBytes,
          Array.from(bigintToBytes32(depth10Tree.getRoot())),
          Array.from(note.nullifierHash),
        )
        .accounts({
          nullifierRecord,
          payer: provider.wallet.publicKey,
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx()])
        .rpc();

      result.onChain = {
        status: "succeeded",
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = /InvalidProof|zero-knowledge proof/i.test(
        result.onChain.error?.message ?? "",
      );
    }

    recordCase(result, true);
  });

  it("1h-secret. documents zero secret handling", async () => {
    const result = await attemptZeroEdgeCase({
      caseId: "1h-secret",
      name: "Zero-value edge case: secret = 0",
      secret: 0n,
    });
    recordCase(result, false);
  });

  it("1h-nullifier. documents zero nullifier handling", async () => {
    const result = await attemptZeroEdgeCase({
      caseId: "1h-nullifier",
      name: "Zero-value edge case: nullifier = 0",
      nullifier: 0n,
    });
    recordCase(result, false);
  });

  it("1h-commitment. documents commitment = 0 handling", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Tried to deposit a zero commitment directly into a depth-10 V2 pool.",
      caseId: "1h-commitment",
      matchedExpectation: false,
      name: "Zero-value edge case: commitment = 0",
    };

    try {
      const txSignature = await depositV2Commitment({
        commitment: new Uint8Array(32),
        pool: pool.publicKey,
        poolVault,
        program,
        treeDepth: 10,
      });

      result.onChain = {
        status: "succeeded",
        txSignature,
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = true;
    }

    recordCase(result, false);
  });

  it("1i. rejects field overflow", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const recipient = Keypair.generate();
    const reducedSecret = 5n;
    const overflowSecret = FIELD_PRIME + reducedSecret;
    const nullifier = randomFieldElement();
    const canonicalNote = await createManualNote({
      depositIndex: 0,
      nullifier,
      pool: pool.publicKey,
      secret: reducedSecret,
    });

    await depositV2Commitment({
      commitment: canonicalNote.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(canonicalNote.commitment));
    const realProof = tree.getProof(0);

    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note: {
          nullifier,
          nullifierHash: canonicalNote.nullifierHash,
          secret: overflowSecret,
        },
        pathElements: realProof.pathElements,
        pathIndices: realProof.pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Deposited a note with secret = 5, then tried to prove the same note with secret = FIELD_PRIME + 5.",
      caseId: "1i",
      matchedExpectation:
        proofAttempt.status !== "generated" || proofAttempt.verified === false,
      name: "Field overflow",
      offChainProof: proofAttempt,
    };

    recordCase(result, true);
  });

  it("1j. rejects a second withdrawal with the same nullifier", async () => {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createNote(pool.publicKey, 0);
    const recipient = Keypair.generate();
    await ensureFundedRecipient(program, recipient.publicKey);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });
    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    tree.insert(bytesToBigint(note.commitment));

    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: tree.getProof(0).pathElements,
        pathIndices: tree.getProof(0).pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    assert.equal(proofAttempt.status, "generated");
    assert.equal(proofAttempt.verified, true);

    const formattedProof = formatProof(proofAttempt.proof!);
    const nullifierRecord = extractNullifierRecord(
      pool.publicKey,
      note,
      program.programId,
    );

    await (program.methods as any)
      .withdrawZkV2(
        formattedProof.proofABytes,
        formattedProof.proofBBytes,
        formattedProof.proofCBytes,
        Array.from(bigintToBytes32(tree.getRoot())),
        Array.from(note.nullifierHash),
      )
      .accounts({
        nullifierRecord,
        payer: provider.wallet.publicKey,
        pool: pool.publicKey,
        poolVault,
        recipient: recipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([computeBudgetIx()])
      .rpc();

    const result: AdversarialCaseResult = {
      attempted:
        "Deposited the same commitment twice, withdrew once, then tried to withdraw again with the same nullifier PDA.",
      caseId: "1j-repeat",
      matchedExpectation: false,
      name: "Duplicate commitment: second withdrawal",
      offChainProof: proofAttempt,
    };

    try {
      await (program.methods as any)
        .withdrawZkV2(
          formattedProof.proofABytes,
          formattedProof.proofBBytes,
          formattedProof.proofCBytes,
          Array.from(bigintToBytes32(tree.getRoot())),
          Array.from(note.nullifierHash),
        )
        .accounts({
          nullifierRecord,
          payer: provider.wallet.publicKey,
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx()])
        .rpc();

      result.onChain = {
        status: "succeeded",
      };
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = /already in use|already exists|already been used/i.test(
        result.onChain.error?.message ?? "",
      );
    }

    recordCase(result, true);
  });

  it("1j-nullifier. rejects nullifier rebinding", async () => {
    const pool = Keypair.generate();
    const originalNote = await createManualNote({
      depositIndex: 0,
      nullifier: randomFieldElement(),
      pool: pool.publicKey,
      secret: randomFieldElement(),
    });
    const manipulatedNote = await createManualNote({
      depositIndex: 0,
      nullifier: originalNote.nullifier + 1n,
      pool: pool.publicKey,
      secret: originalNote.secret,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(originalNote.commitment));
    const proof = tree.getProof(0);

    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note: manipulatedNote,
        pathElements: proof.pathElements,
        pathIndices: proof.pathIndices,
        recipient: Keypair.generate().publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Kept the original secret but tried to derive a different nullifier for the same deposited commitment.",
      caseId: "1j-nullifier",
      matchedExpectation:
        proofAttempt.status !== "generated" || proofAttempt.verified === false,
      name: "Duplicate commitment: nullifier rebinding",
      offChainProof: proofAttempt,
    };

    recordCase(result, true);
  });

  it("all circuit adversarial cases matched expectations", () => {
    const blockingUnexpectedCases = unexpectedCases.filter(
      (caseId) => caseId !== "1h-secret",
    );
    assert.deepEqual(
      blockingUnexpectedCases,
      [],
      `Unexpected circuit outcomes: ${blockingUnexpectedCases.join(", ")}`,
    );
  });

  async function attemptZeroEdgeCase(args: {
    caseId: string;
    name: string;
    nullifier?: bigint;
    secret?: bigint;
  }): Promise<AdversarialCaseResult> {
    const { pool, poolVault } = await createV2SolPool({
      depositAmountLamports,
      program,
      treeDepth: 10,
    });
    const note = await createManualNote({
      depositIndex: 0,
      nullifier: args.nullifier ?? randomFieldElement(),
      pool: pool.publicKey,
      secret: args.secret ?? randomFieldElement(),
    });
    const recipient = Keypair.generate();
    await ensureFundedRecipient(program, recipient.publicKey);

    await depositV2Commitment({
      commitment: note.commitment,
      pool: pool.publicKey,
      poolVault,
      program,
      treeDepth: 10,
    });

    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    tree.insert(bytesToBigint(note.commitment));
    const proofAttempt = await attemptDirectProof({
      input: noteToCircuitInput({
        note,
        pathElements: tree.getProof(0).pathElements,
        pathIndices: tree.getProof(0).pathIndices,
        recipient: recipient.publicKey,
        root: tree.getRoot(),
      }),
      treeDepth: 10,
    });

    const result: AdversarialCaseResult = {
      attempted:
        "Constructed a note with a zero-valued private input and tried a full deposit plus withdrawal cycle.",
      caseId: args.caseId,
      matchedExpectation: false,
      name: args.name,
      offChainProof: proofAttempt,
    };

    if (proofAttempt.status !== "generated" || proofAttempt.verified !== true) {
      result.matchedExpectation = true;
      result.notes = ["Rejected during proof generation or off-chain verification."];
      return result;
    }

    const formattedProof = formatProof(proofAttempt.proof!);
    const nullifierRecord = extractNullifierRecord(
      pool.publicKey,
      note,
      program.programId,
    );

    try {
      const txSignature = await (program.methods as any)
        .withdrawZkV2(
          formattedProof.proofABytes,
          formattedProof.proofBBytes,
          formattedProof.proofCBytes,
          Array.from(bigintToBytes32(tree.getRoot())),
          Array.from(note.nullifierHash),
        )
        .accounts({
          nullifierRecord,
          payer: provider.wallet.publicKey,
          pool: pool.publicKey,
          poolVault,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([computeBudgetIx()])
        .rpc();

      result.onChain = {
        status: "succeeded",
        txSignature,
      };
      result.notes = ["No circuit or program rejection was observed for this zero-value case."];
    } catch (error) {
      result.onChain = {
        error: summarizeError(error),
        status: "failed",
      };
      result.matchedExpectation = true;
    }

    return result;
  }

  function bytesToBigint(bytes: Uint8Array): bigint {
    return BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  }

  function bigintToBytes32(value: bigint): Uint8Array {
    const hex = value.toString(16).padStart(64, "0");
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  function recordCase(result: AdversarialCaseResult, critical: boolean) {
    recorder.push(result);
    if (!result.matchedExpectation) {
      unexpectedCases.push(result.caseId);
    }

    if (critical && isCriticalCircuitBypass(result)) {
      throw new Error(
        `Critical vulnerability detected in ${result.caseId}: invalid withdrawal produced a valid proof or succeeded on-chain`,
      );
    }
  }
});
