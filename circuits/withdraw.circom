pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/mux1.circom";

// Merkle proof verifier for a binary tree of given depth
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels]; // 0 = left, 1 = right
    signal output root;

    component hashers[levels];
    component mux[levels];

    signal hashes[levels + 1];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        mux[i] = Mux1();
        mux[i].c[0] <== hashes[i];
        mux[i].c[1] <== pathElements[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        // If pathIndex=0: hash(current, sibling); if pathIndex=1: hash(sibling, current)
        hashers[i].inputs[0] <== mux[i].out;
        hashers[i].inputs[1] <== hashes[i] + pathElements[i] - mux[i].out;

        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[levels];
}

// Withdraw circuit: proves knowledge of a valid commitment in the Merkle tree
template Withdraw(levels) {
    // Public inputs
    signal input root;           // Merkle root of the commitment tree
    signal input nullifierHash;  // Hash of nullifier (prevents double-spend)
    signal input recipient;      // Pubkey of recipient (bound to proof)

    // Private inputs
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Compute commitment = Poseidon(secret, nullifier)
    component commitHasher = Poseidon(2);
    commitHasher.inputs[0] <== secret;
    commitHasher.inputs[1] <== nullifier;

    // 2. Verify nullifierHash = Poseidon(nullifier)
    component nullHasher = Poseidon(1);
    nullHasher.inputs[0] <== nullifier;
    nullHasher.out === nullifierHash;

    // 3. Verify the commitment exists in the Merkle tree
    component tree = MerkleProof(levels);
    tree.leaf <== commitHasher.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // 4. Square recipient to prevent it from being optimized out
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

component main {public [root, nullifierHash, recipient]} = Withdraw(10);
