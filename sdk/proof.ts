import { randomBytes } from "crypto";
import {
  initPoseidon,
  poseidonHash2,
  poseidonHash1,
  PoseidonMerkleTree,
} from "./poseidon-merkle";

export interface ZKNote {
  secret: bigint;
  nullifier: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

export async function generateZKNote(): Promise<ZKNote> {
  await initPoseidon();

  // Generate random 31-byte values (fit in BN254 field)
  const secret = BigInt("0x" + randomBytes(31).toString("hex"));
  const nullifier = BigInt("0x" + randomBytes(31).toString("hex"));

  const commitment = poseidonHash2(secret, nullifier);
  const nullifierHash = poseidonHash1(nullifier);

  return { secret, nullifier, commitment, nullifierHash };
}

export async function generateWithdrawProof(
  note: ZKNote,
  tree: PoseidonMerkleTree,
  leafIndex: number,
  recipientPubkey: bigint,
  treeDepth: number = 10,
) {
  // Dynamic import for snarkjs (CommonJS module)
  const snarkjs = await import("snarkjs");

  const root = tree.getRoot();
  const { pathElements, pathIndices } = tree.getProof(leafIndex);

  const input = {
    // Public inputs
    root: root.toString(),
    nullifierHash: note.nullifierHash.toString(),
    recipient: recipientPubkey.toString(),
    // Private inputs
    secret: note.secret.toString(),
    nullifier: note.nullifier.toString(),
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices,
  };

  const { wasmPath, zkeyPath } = resolveArtifacts(treeDepth);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  return { proof, publicSignals };
}

export async function verifyProofOffChain(
  proof: any,
  publicSignals: string[],
  treeDepth: number = 10,
): Promise<boolean> {
  const snarkjs = await import("snarkjs");
  const fs = await import("fs");
  const { verificationKeyPath } = resolveArtifacts(treeDepth);
  const vkey = JSON.parse(
    fs.readFileSync(verificationKeyPath, "utf8")
  );
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

// Convert a Solana pubkey (32 bytes) to a field element for the circuit
export function pubkeyToFieldElement(pubkeyBytes: Uint8Array): bigint {
  // Take first 31 bytes to fit in BN254 field
  const hex = Buffer.from(pubkeyBytes.slice(0, 31)).toString("hex");
  return BigInt("0x" + hex);
}

// Format proof for on-chain consumption (flattened bytes)
export function proofToBytes(proof: any): number[] {
  const piA = [
    BigInt(proof.pi_a[0]),
    BigInt(proof.pi_a[1]),
  ];
  const piB = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ];
  const piC = [
    BigInt(proof.pi_c[0]),
    BigInt(proof.pi_c[1]),
  ];

  const bytes: number[] = [];

  // Serialize each field element as 32 bytes big-endian
  for (const val of piA) {
    bytes.push(...bigintToBytes32(val));
  }
  for (const pair of piB) {
    for (const val of pair) {
      bytes.push(...bigintToBytes32(val));
    }
  }
  for (const val of piC) {
    bytes.push(...bigintToBytes32(val));
  }

  return bytes;
}

function bigintToBytes32(val: bigint): number[] {
  const hex = val.toString(16).padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}

export function bigintToBytes(val: bigint, len: number = 32): number[] {
  const hex = val.toString(16).padStart(len * 2, "0");
  const bytes: number[] = [];
  for (let i = 0; i < len * 2; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}

function resolveArtifacts(treeDepth: number): {
  wasmPath: string;
  zkeyPath: string;
  verificationKeyPath: string;
} {
  if (treeDepth === 20) {
    return {
      wasmPath: "build/withdraw_20_js/withdraw_20.wasm",
      zkeyPath: "build/withdraw_20_final.zkey",
      verificationKeyPath: "build/verification_key_20.json",
    };
  }

  return {
    wasmPath: "build/withdraw_js/withdraw.wasm",
    zkeyPath: "build/withdraw_final.zkey",
    verificationKeyPath: "build/verification_key.json",
  };
}
