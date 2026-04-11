import { randomBytes } from "crypto";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { decryptNote } from "./commitment";
import {
  deriveAgentId,
  deriveAgentSpendingKey,
  deriveMasterSeed,
  derivePublicId,
  deriveViewingKeyBytes,
} from "./key-derivation";
import type { DecryptedNote } from "./types";

/**
 * Agent key hierarchy:
 *
 * master_seed (owner secret)
 *   └─ spending_key = HKDF-SHA256(master_seed, "snap-spend", agent_index)
 *       ├─ Seeds the Solana wallet (Ed25519 keypair derivation)
 *       ├─ Signs relayer request payloads (transport authentication)
 *       └─ Does NOT authorize on-chain spend — the bearer note does that
 *   └─ viewing_key = HKDF-SHA256(spending_key, "snap-view")
 *       ├─ Decrypts encrypted note records for audit/history
 *       ├─ Cannot spend funds
 *       └─ Cannot recover the spending key
 *
 * IMPORTANT: On-chain spend authorization is bearer-note-based.
 * Anyone who possesses the note (secret + nullifier) can withdraw.
 * The spending key provides wallet identity and relayer auth, not
 * on-chain withdrawal authorization. A future circuit revision could
 * bind the spending key as a public input to create true key-based
 * spend control, but that is not the current model.
 */

export interface MasterKeyPair {
  seed: Uint8Array;
  publicId: string;
}

export interface AgentKeyPair {
  index: number;
  spendingKey: Uint8Array;
  viewingKey: Uint8Array;
  agentId: string;
}

export interface ViewingKeyBundle {
  viewingKey: Uint8Array;
  agentId: string;
  index: number;
}

export function generateMasterKey(seedPhrase?: string): MasterKeyPair {
  const seedMaterial = seedPhrase
    ? utf8ToBytes(seedPhrase.normalize("NFKD"))
    : randomBytes(32);
  const seed = deriveMasterSeed(seedMaterial);

  return {
    seed,
    publicId: derivePublicId(seed),
  };
}

export function deriveAgentKey(
  master: MasterKeyPair,
  index: number,
): AgentKeyPair {
  assertKeyIndex(index);

  const spendingKey = deriveAgentSpendingKey(master.seed, index);
  const viewingKey = deriveViewingKeyBytes(spendingKey);

  return {
    index,
    spendingKey,
    viewingKey,
    agentId: deriveAgentId(spendingKey),
  };
}

export function deriveViewingKey(spendingKey: Uint8Array): Uint8Array {
  assertKeyLength(spendingKey, "spending key");
  return deriveViewingKeyBytes(spendingKey);
}

export function extractViewingKey(agentKey: AgentKeyPair): ViewingKeyBundle {
  return {
    viewingKey: Uint8Array.from(agentKey.viewingKey),
    agentId: agentKey.agentId,
    index: agentKey.index,
  };
}

export function decryptNoteWithViewingKey(
  viewingKey: ViewingKeyBundle,
  encryptedNote: Uint8Array,
): DecryptedNote | null {
  const note = decryptNote(encryptedNote, viewingKey.viewingKey);
  if (!note) {
    return null;
  }

  return {
    ...note,
    agentId: viewingKey.agentId,
    index: viewingKey.index,
  };
}

function assertKeyIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("SNAP: Agent derivation index must be a non-negative integer");
  }
}

function assertKeyLength(key: Uint8Array, label: string): void {
  if (key.length !== 32) {
    throw new Error(`SNAP: ${label} must be 32 bytes`);
  }
}
