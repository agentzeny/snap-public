import { generateZKNote, generateWithdrawProof, verifyProofOffChain, pubkeyToFieldElement } from "../sdk/proof";
import { PoseidonMerkleTree, initPoseidon } from "../sdk/poseidon-merkle";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";

describe("ZK proof generation (off-chain)", () => {
  it("generates and verifies a valid withdraw proof", async () => {
    await initPoseidon();

    // 1. Generate a note
    const note = await generateZKNote();
    console.log("  Note commitment:", note.commitment.toString().slice(0, 20) + "...");

    // 2. Build a Merkle tree and insert the commitment
    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    const leafIndex = tree.insert(note.commitment);
    assert.equal(leafIndex, 0);

    // 3. Generate the withdrawal proof
    const recipient = Keypair.generate();
    const recipientField = pubkeyToFieldElement(recipient.publicKey.toBytes());

    console.log("  Generating proof (this may take a few seconds)...");
    const { proof, publicSignals } = await generateWithdrawProof(
      note,
      tree,
      leafIndex,
      recipientField
    );

    console.log("  Proof generated:", JSON.stringify(proof).slice(0, 80) + "...");
    console.log("  Public signals:", publicSignals.length, "values");

    // 4. Verify the proof off-chain
    const valid = await verifyProofOffChain(proof, publicSignals);
    assert.isTrue(valid, "Proof should verify correctly");
    console.log("  Proof verified: VALID");
  });

  it("rejects a proof with wrong nullifier hash", async () => {
    await initPoseidon();

    const note = await generateZKNote();
    const tree = new PoseidonMerkleTree(10);
    await tree.init();
    const leafIndex = tree.insert(note.commitment);

    const recipient = Keypair.generate();
    const recipientField = pubkeyToFieldElement(recipient.publicKey.toBytes());

    const { proof, publicSignals } = await generateWithdrawProof(
      note,
      tree,
      leafIndex,
      recipientField
    );

    // Tamper with the nullifier hash (public signal index 1)
    const tamperedSignals = [...publicSignals];
    tamperedSignals[1] = "12345";

    const valid = await verifyProofOffChain(proof, tamperedSignals);
    assert.isFalse(valid, "Tampered proof should be rejected");
    console.log("  Tampered proof correctly rejected");
  });
});
