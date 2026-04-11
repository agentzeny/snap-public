import fs from "fs";
import path from "path";
import { RelayerError } from "./relay-handler";
import type { ParsedRelayRequest } from "./types";
import type { PoolAccountState } from "./tx-builder";

const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

interface Groth16Proof {
  protocol: "groth16";
  curve: "bn128";
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
}

const verificationKeyCache = new Map<number, unknown>();

export async function verifyRelayProof(
  request: ParsedRelayRequest,
  poolState: Pick<PoolAccountState, "roots" | "treeDepth">,
): Promise<void> {
  if (!hasKnownRoot(request.rootBytes, poolState.roots)) {
    throw new RelayerError("Proof root is not present in the pool root history", 400);
  }

  const proof = decodeSolanaProof(request.proofBytes);
  const publicSignals = [
    bytesToBigint(request.rootBytes).toString(),
    bytesToBigint(request.nullifierHashBytes).toString(),
    pubkeyToFieldElement(request.recipient.toBytes()).toString(),
  ];

  const snarkjs = require("snarkjs") as {
    groth16: {
      verify(
        verificationKey: unknown,
        publicSignals: string[],
        proof: Groth16Proof,
      ): Promise<boolean>;
    };
  };
  const verificationKey = loadVerificationKey(poolState.treeDepth);

  let valid = false;
  try {
    valid = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
  } catch {
    valid = false;
  }

  if (!valid) {
    throw new RelayerError("Withdrawal proof verification failed", 400);
  }
}

function loadVerificationKey(treeDepth: number): unknown {
  const cached = verificationKeyCache.get(treeDepth);
  if (cached) {
    return cached;
  }

  const filename = resolveVerificationKeyName(treeDepth);
  const filePath = path.resolve(__dirname, "../assets", filename);
  const loaded = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  verificationKeyCache.set(treeDepth, loaded);
  return loaded;
}

function resolveVerificationKeyName(treeDepth: number): string {
  if (treeDepth === 10) {
    return "verification_key_10.json";
  }

  if (treeDepth === 20) {
    return "verification_key_20.json";
  }

  throw new RelayerError(`Unsupported tree depth ${treeDepth} for off-chain verification`, 500);
}

function hasKnownRoot(rootBytes: Uint8Array, roots: Uint8Array[]): boolean {
  return roots.some((candidate) =>
    Buffer.from(candidate).equals(Buffer.from(rootBytes)),
  );
}

function decodeSolanaProof(proofBytes: Uint8Array): Groth16Proof {
  if (proofBytes.length !== 256) {
    throw new RelayerError("proof must be exactly 256 bytes", 400);
  }

  const aX = bytesToBigint(proofBytes.slice(0, 32));
  const negatedAY = bytesToBigint(proofBytes.slice(32, 64));
  const aY = (FIELD_PRIME - negatedAY) % FIELD_PRIME;
  const b00 = bytesToBigint(proofBytes.slice(64, 96));
  const b01 = bytesToBigint(proofBytes.slice(96, 128));
  const b10 = bytesToBigint(proofBytes.slice(128, 160));
  const b11 = bytesToBigint(proofBytes.slice(160, 192));
  const cX = bytesToBigint(proofBytes.slice(192, 224));
  const cY = bytesToBigint(proofBytes.slice(224, 256));

  return {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [aX.toString(), aY.toString(), "1"],
    pi_b: [
      [b01.toString(), b00.toString()],
      [b11.toString(), b10.toString()],
      ["1", "0"],
    ],
    pi_c: [cX.toString(), cY.toString(), "1"],
  };
}

function bytesToBigint(bytes: Uint8Array): bigint {
  const hex = Buffer.from(bytes).toString("hex");
  return BigInt(`0x${hex || "0"}`);
}

function pubkeyToFieldElement(pubkeyBytes: Uint8Array): bigint {
  return bytesToBigint(pubkeyBytes.slice(0, 31));
}
