import { createHash } from "crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { RelayRequest } from "./types";

export const REQUEST_SIGNATURE_DOMAIN = "snap-relay-request-v1";
export const MAX_REQUEST_AGE_MS = 60_000;
export const MAX_CLOCK_SKEW_MS = 5_000;

/**
 * Request signing uses Ed25519 signatures over the request hash.
 * This is only the transport envelope: it protects request integrity
 * and enforces a freshness window, but it does not prove note ownership
 * by itself.
 *
 * The signature does NOT reveal the agent's identity to the relayer.
 * The session key is ephemeral and derived per-request from the auth key,
 * request payload, and timestamp, so the relayer cannot correlate normal
 * requests to the same caller via a stable session public key.
 */
export interface SignedRequest {
  payload: RelayRequest;
  signature: string;
  sessionPubkey: string;
  timestamp: number;
}

export function verifyRequest(signed: SignedRequest): boolean {
  return getSignedRequestError(signed) === null;
}

export function getSignedRequestError(
  signed: SignedRequest,
  now = Date.now(),
): string | null {
  if (!Number.isFinite(signed.timestamp)) {
    return "Request timestamp is invalid";
  }

  if (now - signed.timestamp > MAX_REQUEST_AGE_MS) {
    return "Request signature expired";
  }

  if (signed.timestamp - now > MAX_CLOCK_SKEW_MS) {
    return "Request timestamp is too far in the future";
  }

  let signature: Uint8Array;
  let sessionPubkey: Uint8Array;

  try {
    signature = bs58.decode(signed.signature);
    sessionPubkey = bs58.decode(signed.sessionPubkey);
  } catch {
    return "Request signature must be valid base58";
  }

  if (signature.length !== nacl.sign.signatureLength) {
    return "Request signature must be 64 bytes";
  }

  if (sessionPubkey.length !== nacl.sign.publicKeyLength) {
    return "Session public key must be 32 bytes";
  }

  const requestHash = hashSignedRequest(signed.payload, signed.timestamp);
  const verified = nacl.sign.detached.verify(requestHash, signature, sessionPubkey);
  return verified ? null : "Request signature verification failed";
}

export function hashSignedRequest(
  payload: RelayRequest,
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

export function canonicalizeRelayRequest(payload: RelayRequest): string {
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
