import type { Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import SNAP_IDL_JSON from "./idl.json";

export const SNAP_PROGRAM_ID = new PublicKey(
  "AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3",
);
export const DEFAULT_PROGRAM_ID = SNAP_PROGRAM_ID;

export const LEGACY_TREE_DEPTH = 10;
export const DEFAULT_TREE_DEPTH = 20;
export const MAX_TREE_DEPTH = 20;
export const TREE_DEPTH = LEGACY_TREE_DEPTH;
export const ROOT_HISTORY_SIZE = 30;
export const DEFAULT_PROVER_TIMEOUT = 30_000;

export const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

export const PROGRAM_ERROR_MESSAGES: Record<number, string> = {
  6000: "SNAP: Pool is full — this shielded pool cannot accept more deposits",
  6001: "SNAP: Commitment not found — this note does not exist in the pool",
  6002: "SNAP: Invalid nullifier hash — the note data is corrupted",
  6003: "SNAP: Nullifier already used — this note has already been withdrawn",
  6004: "SNAP: Insufficient vault funds — the pool cannot satisfy this withdrawal",
  6005: "SNAP: Invalid zero-knowledge proof — the note, Merkle path, or recipient is invalid",
  6006: "SNAP: Merkle root not recognized — the note does not match this pool state",
  6007: "SNAP: Poseidon hashing failed during verification",
  6008: "SNAP: Relayer fee is too high for this pool denomination",
  6009: "SNAP: treeDepth must be 10 or 20",
  6010: "SNAP: This instruction does not match the pool asset type",
  6011: "SNAP: The provided SPL token mint does not match the pool",
  6012: "SNAP: This pool uses an unsupported nullifier storage version",
  6013: "SNAP: The provided token account owner does not match the expected authority",
  6014: "SNAP: The SPL vault authority must be the vault PDA itself",
  6015: "SNAP: Legacy nullifier vector mode is deprecated",
  6016: "SNAP: The derived commitment page does not match the next deposit slot",
  6017: "SNAP: Pool denomination must be greater than zero and within the supported client range",
  6018: "SNAP: Commitment cannot be all zeros",
  6019: "SNAP: Notes with nullifier = 0 are not allowed",
  6020: "SNAP: protocolFeeBps must be less than or equal to 500",
  6021: "SNAP: The provided treasury account does not match the pool",
  6022: "SNAP: Protocol fee plus relayer fee must be less than the pool denomination",
  6023: "SNAP: Fee calculation overflowed",
};

export const SNAP_IDL: Idl = SNAP_IDL_JSON as Idl;
