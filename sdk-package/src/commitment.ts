import { randomBytes } from "crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { PublicKey } from "@solana/web3.js";
import { deriveViewingKeyBytes } from "./key-derivation";
import type { Note } from "./types";
import { initPoseidon, poseidonHash1, poseidonHash2 } from "./merkle";

export async function createNote(
  poolAddress: PublicKey,
  depositIndex: number,
): Promise<Note> {
  await initPoseidon();

  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  const commitment = bigintToBytes32(poseidonHash2(secret, nullifier));
  const nullifierHash = bigintToBytes32(poseidonHash1(nullifier));

  return {
    secret,
    nullifier,
    commitment,
    nullifierHash,
    depositIndex,
    poolAddress: poolAddress.toBase58(),
  };
}

export async function computeCommitment(
  secret: bigint,
  nullifier: bigint,
): Promise<Uint8Array> {
  await initPoseidon();
  return bigintToBytes32(poseidonHash2(secret, nullifier));
}

export async function computeNullifierHash(
  nullifier: bigint,
): Promise<Uint8Array> {
  await initPoseidon();
  return bigintToBytes32(poseidonHash1(nullifier));
}

export function randomFieldElement(): bigint {
  return BigInt(`0x${randomBytes(31).toString("hex")}`);
}

export function encryptNote(note: Note, viewingKey: Uint8Array): Uint8Array {
  assertKeyLength(viewingKey);
  const nonce = Uint8Array.from(randomBytes(24));
  const cipher = xchacha20poly1305(viewingKey, nonce);
  const plaintext = Buffer.from(serializeNotePayload(note), "utf8");
  const ciphertext = cipher.encrypt(plaintext);

  return Uint8Array.from([...nonce, ...ciphertext]);
}

export function decryptNote(encrypted: Uint8Array, key: Uint8Array): Note | null {
  if (encrypted.length <= 24 || key.length !== 32) {
    return null;
  }

  const nonce = encrypted.slice(0, 24);
  const ciphertext = encrypted.slice(24);
  const derivedViewingKey = deriveViewingKeyBytes(key);
  const candidateKeys = [key];

  if (!bytesEqual(derivedViewingKey, key)) {
    candidateKeys.push(derivedViewingKey);
  }

  for (const candidateKey of candidateKeys) {
    try {
      const cipher = xchacha20poly1305(candidateKey, nonce);
      const plaintext = cipher.decrypt(ciphertext);
      return deserializeNotePayload(Buffer.from(plaintext).toString("utf8"));
    } catch {
      continue;
    }
  }

  return null;
}

export function bigintToBytes32(value: bigint): Uint8Array {
  return Uint8Array.from(bigintToBytes(value, 32));
}

export function bigintToBytes(value: bigint, length = 32): number[] {
  const hex = value.toString(16).padStart(length * 2, "0");
  const bytes: number[] = [];

  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }

  return bytes;
}

export function bytesToBigint(bytes: Uint8Array): bigint {
  const hex = Buffer.from(bytes).toString("hex");
  return BigInt(`0x${hex || "0"}`);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string, expectedLength?: number): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;

  if (normalized.length % 2 !== 0) {
    throw new Error("SNAP: Invalid note — hex fields must have an even number of characters");
  }

  const bytes = Uint8Array.from(Buffer.from(normalized, "hex"));
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error(
      `SNAP: Invalid note — expected ${expectedLength} bytes but received ${bytes.length}`,
    );
  }

  return bytes;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

export function serializeNotePayload(note: Note): string {
  return JSON.stringify({
    s: note.secret.toString(),
    n: note.nullifier.toString(),
    c: Buffer.from(note.commitment).toString("hex"),
    nh: Buffer.from(note.nullifierHash).toString("hex"),
    di: note.depositIndex,
    pa: note.poolAddress,
  });
}

export function deserializeNotePayload(data: string): Note {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw new Error("SNAP: Invalid note — note data is not valid JSON");
  }

  if (
    typeof parsed.s !== "string" ||
    typeof parsed.n !== "string" ||
    typeof parsed.c !== "string" ||
    typeof parsed.nh !== "string" ||
    typeof parsed.di !== "number" ||
    typeof parsed.pa !== "string"
  ) {
    throw new Error("SNAP: Invalid note — note fields are missing or malformed");
  }

  return {
    secret: BigInt(parsed.s),
    nullifier: BigInt(parsed.n),
    commitment: hexToBytes(parsed.c, 32),
    nullifierHash: hexToBytes(parsed.nh, 32),
    depositIndex: parsed.di,
    poolAddress: parsed.pa,
  };
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error("SNAP: Note encryption keys must be 32 bytes");
  }
}
