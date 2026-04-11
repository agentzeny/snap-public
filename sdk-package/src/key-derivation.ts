import bs58 from "bs58";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

const MASTER_SALT = utf8ToBytes("snap-master");
const MASTER_INFO = utf8ToBytes("snap-master-seed");
const VIEWING_INFO = utf8ToBytes("snap-viewing");
const PUBLIC_ID_INFO = utf8ToBytes("snap-public-id");
const AGENT_ID_INFO = utf8ToBytes("snap-agent-id");

export function deriveMasterSeed(seedMaterial: Uint8Array): Uint8Array {
  return hkdf(sha256, seedMaterial, MASTER_SALT, MASTER_INFO, 32);
}

export function deriveAgentSpendingKey(
  masterSeed: Uint8Array,
  index: number,
): Uint8Array {
  return hkdf(
    sha256,
    masterSeed,
    undefined,
    utf8ToBytes(`snap-agent-${index}`),
    32,
  );
}

export function deriveViewingKeyBytes(spendingKey: Uint8Array): Uint8Array {
  return hkdf(sha256, spendingKey, undefined, VIEWING_INFO, 32);
}

export function derivePublicId(seed: Uint8Array): string {
  return bs58.encode(
    hkdf(sha256, seed, undefined, PUBLIC_ID_INFO, 16),
  );
}

export function deriveAgentId(spendingKey: Uint8Array): string {
  return bs58.encode(
    hkdf(sha256, spendingKey, undefined, AGENT_ID_INFO, 16),
  );
}
