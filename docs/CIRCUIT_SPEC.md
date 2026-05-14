# SNAP Withdraw Circuit Specification

> Status: circuit notes for the SNAP limited release. The proving system and parameter-generation process are still review-stage, and the current documentation should not be read as an audit report.

## Circuit Description

The SNAP withdraw circuit proves, in zero knowledge, that the prover knows a valid note already committed into the pool's Merkle tree and is entitled to spend it exactly once.

In plain English, the proof says:

- I know a `secret` and `nullifier`
- Those values hash to a commitment that exists in the pool's depth-10 Merkle tree
- The Merkle path I supplied reconstructs the public Merkle root
- The `nullifierHash` I exposed is the hash of the same private `nullifier`
- The withdrawal is bound to the public `recipient` field element

The circuit is implemented in [`circuits/withdraw.circom`](../circuits/withdraw.circom).

## Public Inputs

- `root`: the Merkle root the proof is evaluated against
- `nullifierHash`: the public anti-double-spend tag for this note
- `recipient`: the recipient public key truncated into a BN254 field element

## Private Inputs

- `secret`: private note secret
- `nullifier`: private note nullifier
- `pathElements[10]`: Merkle sibling hashes for each tree level
- `pathIndices[10]`: left/right selectors for each tree level

## System Parameters

- Proving system: Groth16 over BN254 (`bn-128` in `snarkjs`)
- Hash function: Poseidon over the BN254 scalar field
- Tree depth: 10
- Capacity: 1,024 commitments per pool
- Compiled constraint count: 6,123

The constraint count above is the current compiled value from:

```bash
npx snarkjs r1cs info build/withdraw.r1cs
```

That command reports:

- `# of Constraints: 6123`
- `# of Private Inputs: 22`
- `# of Public Inputs: 3`

## Constraint Breakdown

### Commitment Check

The circuit recomputes the note commitment:

`commitment = Poseidon(secret, nullifier)`

This binds the proof to a concrete note preimage.

### Nullifier Hash Check

The circuit recomputes the anti-double-spend tag:

`nullifierHash = Poseidon(nullifier)`

The on-chain program stores used nullifier hashes and rejects reuse.

### Merkle Inclusion Proof

The circuit walks a 10-level Poseidon Merkle path:

- At each level it selects left/right ordering from `pathIndices[i]`
- It hashes the current node with `pathElements[i]`
- It carries the result to the next level

Each level uses Poseidon with two inputs:

`parent = Poseidon(left, right)`

### Root Equality

After the final level, the computed root must equal the public `root` input.

That binds the proof to a specific pool state already recognized by the on-chain program.

## Security Properties

### Soundness

A valid proof means the prover knows a `secret` and `nullifier` pair that:

- hashes to a commitment in the tree
- produces the public `nullifierHash`
- is bound to the claimed recipient

Absent toxic-waste compromise or a soundness failure in Groth16/Poseidon, a prover cannot forge this without a real note witness.

### Zero-Knowledge

The Groth16 proof reveals neither:

- which leaf in the tree is being spent
- the private `secret`
- the private `nullifier`
- the Merkle path values

Observers only see the root, nullifier hash, and recipient public input.

### Nullifier Binding

Each note deterministically maps to exactly one `nullifierHash`.

Because the program records each used nullifier hash, a note can only be withdrawn once.

## Parameter Generation

SNAP currently uses Groth16 parameter generation with two stages:

1. A public Powers of Tau transcript
2. A circuit-specific phase 2 zkey generation for `withdraw.circom`

Current repo state:

- Powers of Tau source: `powersOfTau28_hez_final_15.ptau`
- Circuit artifact: [`build/withdraw_final.zkey`](../build/withdraw_final.zkey)
- Verification key artifact: [`build/verification_key.json`](../build/verification_key.json)

Honest assessment:

- This is a demo-grade setup
- The repo findings document that phase-2 zkey generation happened outside a public multi-party transcript
- There is no independently auditable evidence in this repo that toxic waste was destroyed
- Auditors should treat the current proving key as carrying toxic-waste retention risk

For production, SNAP needs either:

- a public multi-party parameter-generation process with transcripts, or
- a proving system without per-circuit toxic waste

## Known Limitations

- Depth-10 tree limits each pool to 1,024 commitments
- Pools are fixed denomination
- BN254 is not post-quantum secure
- Groth16 introduces toxic-waste risk if parameter generation is compromised
- The current zkey generation flow is demo infrastructure, not an audit-grade parameter process
