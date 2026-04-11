import path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  bigintToBytes,
  bytesEqual,
  bytesToBigint,
} from "./commitment";
import {
  DEFAULT_TREE_DEPTH,
  FIELD_PRIME,
  LEGACY_TREE_DEPTH,
  MAX_TREE_DEPTH,
} from "./constants";
import { buildTreeFromCommitments } from "./merkle";
import type { Note } from "./types";

export interface SolanaProof {
  proofABytes: number[];
  proofBBytes: number[];
  proofCBytes: number[];
  rootBytes: number[];
  nullifierHashBytes: number[];
}

export interface GeneratedProof extends SolanaProof {
  publicSignals: string[];
}

export async function generateWithdrawProof(
  note: Note,
  commitments: Uint8Array[],
  recipient: PublicKey,
  timeoutMs: number,
  treeDepth = LEGACY_TREE_DEPTH,
): Promise<GeneratedProof> {
  if (treeDepth !== LEGACY_TREE_DEPTH && treeDepth !== MAX_TREE_DEPTH) {
    throw new Error(`SNAP: Unsupported tree depth ${treeDepth}`);
  }

  const commitmentIndex = findCommitmentIndex(
    commitments,
    note.commitment,
    note.depositIndex,
  );

  if (commitmentIndex === -1) {
    throw new Error("SNAP: Invalid note — commitment not found in the specified pool");
  }

  const tree = await buildTreeFromCommitments(
    commitments,
    bytesToBigint,
    treeDepth,
  );
  const root = tree.getRoot();
  const { pathElements, pathIndices } = tree.getProof(commitmentIndex);

  const input = {
    root: root.toString(),
    nullifierHash: bytesToBigint(note.nullifierHash).toString(),
    recipient: pubkeyToFieldElement(recipient.toBytes()).toString(),
    secret: note.secret.toString(),
    nullifier: note.nullifier.toString(),
    pathElements: pathElements.map((value) => value.toString()),
    pathIndices,
  };

  const snarkjs = await import("snarkjs");
  const artifactsDir = path.join(__dirname, "../assets");
  const { wasmName, zkeyName } = resolveArtifactNames(treeDepth);
  const wasmPath = path.join(artifactsDir, wasmName);
  const zkeyPath = path.join(artifactsDir, zkeyName);

  const provePromise = snarkjs.groth16.fullProve(input, wasmPath, zkeyPath) as Promise<{
    proof: {
      pi_a: [string, string];
      pi_b: [[string, string], [string, string]];
      pi_c: [string, string];
    };
    publicSignals: string[];
  }>;

  const { proof, publicSignals } = await withTimeout(
    provePromise,
    timeoutMs,
    `SNAP: Proof generation timed out after ${timeoutMs}ms`,
  );

  const formatted = formatProofForSolana(proof);

  return {
    ...formatted,
    rootBytes: bigintToBytes(root, 32),
    nullifierHashBytes: Array.from(note.nullifierHash),
    publicSignals,
  };
}

function resolveArtifactNames(treeDepth: number): {
  wasmName: string;
  zkeyName: string;
} {
  if (treeDepth === LEGACY_TREE_DEPTH) {
    return {
      wasmName: "withdraw_10.wasm",
      zkeyName: "withdraw_10_final.zkey",
    };
  }

  if (treeDepth === DEFAULT_TREE_DEPTH) {
    return {
      wasmName: "withdraw_20.wasm",
      zkeyName: "withdraw_20_final.zkey",
    };
  }

  throw new Error(`SNAP: Unsupported tree depth ${treeDepth}`);
}

export function pubkeyToFieldElement(pubkeyBytes: Uint8Array): bigint {
  const fieldBytes = pubkeyBytes.slice(0, 31);
  return BigInt(`0x${Buffer.from(fieldBytes).toString("hex")}`);
}

export function formatProofForSolana(proof: {
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
}): Omit<SolanaProof, "rootBytes" | "nullifierHashBytes"> {
  const proofABytes = negateG1Y([
    ...bigintToBytes(BigInt(proof.pi_a[0]), 32),
    ...bigintToBytes(BigInt(proof.pi_a[1]), 32),
  ]);

  const proofBBytes = [
    ...bigintToBytes(BigInt(proof.pi_b[0][1]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[0][0]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[1][1]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[1][0]), 32),
  ];

  const proofCBytes = [
    ...bigintToBytes(BigInt(proof.pi_c[0]), 32),
    ...bigintToBytes(BigInt(proof.pi_c[1]), 32),
  ];

  return { proofABytes, proofBBytes, proofCBytes };
}

function findCommitmentIndex(
  commitments: Uint8Array[],
  commitment: Uint8Array,
  hintedIndex: number,
): number {
  if (
    hintedIndex >= 0 &&
    hintedIndex < commitments.length &&
    bytesEqual(commitments[hintedIndex], commitment)
  ) {
    return hintedIndex;
  }

  return commitments.findIndex((candidate) => bytesEqual(candidate, commitment));
}

function negateG1Y(proofABytes: number[]): number[] {
  const yBytes = proofABytes.slice(32, 64);
  let y = 0n;

  for (const byte of yBytes) {
    y = (y << 8n) | BigInt(byte);
  }

  const negatedY = FIELD_PRIME - y;
  return [...proofABytes.slice(0, 32), ...bigintToBytes(negatedY, 32)];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
