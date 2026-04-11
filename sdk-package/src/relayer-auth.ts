import { createHash } from "crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { AgentKeyPair } from "./keys";
import type {
  RelayerWithdrawRequest,
  SignedRelayerWithdrawRequest,
  WalletAdapter,
} from "./types";

const REQUEST_SIGNATURE_DOMAIN = "snap-relay-request-v1";

export function signRelayerWithdrawRequest(
  payload: RelayerWithdrawRequest,
  authKey: Uint8Array,
  timestamp = Date.now(),
): SignedRelayerWithdrawRequest {
  // This signed envelope is transport integrity and replay protection only.
  // The relayer must still verify the proof and bound public signals off-chain.
  assertAuthKey(authKey);
  const sessionSeed = deriveSessionSeed(authKey, payload, timestamp);
  const sessionKeypair = nacl.sign.keyPair.fromSeed(sessionSeed);
  const requestHash = hashSignedRequest(payload, timestamp);
  const signature = nacl.sign.detached(requestHash, sessionKeypair.secretKey);

  return {
    payload,
    signature: bs58.encode(signature),
    sessionPubkey: bs58.encode(sessionKeypair.publicKey),
    timestamp,
  };
}

export function extractRelayerAuthKey(
  wallet: WalletAdapter,
  agentKeyPair?: AgentKeyPair,
): Uint8Array | null {
  if (agentKeyPair) {
    return Uint8Array.from(agentKeyPair.spendingKey);
  }

  if (wallet.payer?.secretKey) {
    return wallet.payer.secretKey.slice(0, 32);
  }

  return null;
}

function deriveSessionSeed(
  authKey: Uint8Array,
  payload: RelayerWithdrawRequest,
  timestamp: number,
): Uint8Array {
  const digest = createHash("sha256");
  digest.update("snap-relay-session-v1");
  digest.update("\0");
  digest.update(authKey);
  digest.update("\0");
  digest.update(hashSignedRequest(payload, timestamp));
  return Uint8Array.from(digest.digest());
}

function hashSignedRequest(
  payload: RelayerWithdrawRequest,
  timestamp: number,
): Uint8Array {
  const digest = createHash("sha256");
  digest.update(REQUEST_SIGNATURE_DOMAIN);
  digest.update("\0");
  digest.update(canonicalizeRelayRequest(payload));
  digest.update("\0");
  digest.update(Buffer.from(String(timestamp), "utf8"));
  return Uint8Array.from(digest.digest());
}

function canonicalizeRelayRequest(payload: RelayerWithdrawRequest): string {
  return JSON.stringify({
    fee: payload.fee,
    nullifierHash: normalizeHex(payload.nullifierHash),
    pool: payload.pool,
    proof: normalizeHex(payload.proof),
    recipient: payload.recipient,
    root: normalizeHex(payload.root),
  });
}

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
}

function assertAuthKey(authKey: Uint8Array): void {
  if (authKey.length !== 32) {
    throw new Error("SNAP: Relayer auth requires a 32-byte spending key seed");
  }
}
