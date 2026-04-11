import type { RequestHandler } from "express";
import { PublicKey } from "@solana/web3.js";
import { type SignedRequest } from "./auth";
import type {
  ParsedRelayRequest,
  RelayerHealthPayload,
  RelayerInfoPayload,
  RelayerStatsPayload,
  RelayRequest,
  RelaySuccessPayload,
} from "./types";

export interface RelayService {
  relay(request: {
    ip: string;
    signedRequest: SignedRequest;
  }): Promise<RelaySuccessPayload>;
  getHealth(): Promise<RelayerHealthPayload>;
  getInfo(): Promise<RelayerInfoPayload>;
  getMetrics(): Promise<string>;
  getStats(): Promise<RelayerStatsPayload>;
}

export class RelayerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

export function createRelayHandler(service: RelayService): RequestHandler {
  return async (req, res) => {
    try {
      const signedRequest = validateSignedRequest(req.body);
      const result = await service.relay({
        ip: req.ip || req.socket.remoteAddress || "unknown",
        signedRequest,
      });
      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      const { status, message, retryAfter } = toHttpError(error);
      applyRetryHeaders(res, retryAfter);
      res.status(status).json({
        success: false,
        error: message,
      });
    }
  };
}

export function createInfoHandler(service: RelayService): RequestHandler {
  return async (_req, res) => {
    try {
      res.json(await service.getInfo());
    } catch (error) {
      const { status, message, retryAfter } = toHttpError(error);
      applyRetryHeaders(res, retryAfter);
      res.status(status).json({
        success: false,
        error: message,
      });
    }
  };
}

export function createHealthHandler(service: RelayService): RequestHandler {
  return async (_req, res) => {
    try {
      res.json(await service.getHealth());
    } catch (error) {
      const { status, message, retryAfter } = toHttpError(error);
      applyRetryHeaders(res, retryAfter);
      res.status(status).json({
        success: false,
        error: message,
      });
    }
  };
}

export function createMetricsHandler(service: RelayService): RequestHandler {
  return async (_req, res) => {
    try {
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.send(await service.getMetrics());
    } catch (error) {
      const { status, message, retryAfter } = toHttpError(error);
      applyRetryHeaders(res, retryAfter);
      res.status(status).send(message);
    }
  };
}

export function createStatsHandler(service: RelayService): RequestHandler {
  return async (_req, res) => {
    try {
      res.json(await service.getStats());
    } catch (error) {
      const { status, message, retryAfter } = toHttpError(error);
      applyRetryHeaders(res, retryAfter);
      res.status(status).json({
        success: false,
        error: message,
      });
    }
  };
}

export function validateSignedRequest(body: unknown): SignedRequest {
  if (!body || typeof body !== "object") {
    throw new RelayerError("Request body must be a JSON object");
  }

  const payload = body as Record<string, unknown>;
  const signedRequest: SignedRequest = {
    payload: validateRelayPayload(payload.payload),
    signature: parseStringField(payload.signature, "signature"),
    sessionPubkey: parseStringField(payload.sessionPubkey, "sessionPubkey"),
    timestamp: parseIntegerField(payload.timestamp, "timestamp"),
  };

  return signedRequest;
}

export function validateRelayRequest(payload: RelayRequest): ParsedRelayRequest {
  return {
    pool: parsePublicKeyField(payload.pool, "pool"),
    recipient: parsePublicKeyField(payload.recipient, "recipient"),
    proofBytes: parseHexField(payload.proof, 256, "proof"),
    rootBytes: parseHexField(payload.root, 32, "root"),
    nullifierHashBytes: parseHexField(payload.nullifierHash, 32, "nullifierHash"),
    fee: parseIntegerField(payload.fee, "fee"),
  };
}

function validateRelayPayload(value: unknown): RelayRequest {
  if (!value || typeof value !== "object") {
    throw new RelayerError("Request payload must be a JSON object");
  }

  const payload = value as Record<string, unknown>;
  return {
    pool: parseStringField(payload.pool, "pool"),
    recipient: parseStringField(payload.recipient, "recipient"),
    proof: parseStringField(payload.proof, "proof"),
    root: parseStringField(payload.root, "root"),
    nullifierHash: parseStringField(payload.nullifierHash, "nullifierHash"),
    fee: parseIntegerField(payload.fee, "fee"),
  };
}

function parsePublicKeyField(value: unknown, field: string): PublicKey {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RelayerError(`Missing required field: ${field}`);
  }

  try {
    return new PublicKey(value);
  } catch {
    throw new RelayerError(`${field} must be a valid base58 public key`);
  }
}

function parseStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RelayerError(`Missing required field: ${field}`);
  }

  return value.trim();
}

function parseIntegerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RelayerError(`${field} must be a non-negative integer`);
  }

  return value;
}

function parseHexField(value: unknown, expectedLength: number, field: string): Uint8Array {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RelayerError(`Missing required field: ${field}`);
  }

  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new RelayerError(`${field} must be valid hex`);
  }

  const bytes = Uint8Array.from(Buffer.from(normalized, "hex"));
  if (bytes.length !== expectedLength) {
    throw new RelayerError(
      `${field} must be exactly ${expectedLength} bytes, received ${bytes.length}`,
    );
  }

  return bytes;
}

function toHttpError(
  error: unknown,
): { status: number; message: string; retryAfter?: number } {
  if (error instanceof RelayerError) {
    return {
      status: error.status,
      message: error.message,
      retryAfter: error.retryAfter,
    };
  }

  return {
    status: 500,
    message: error instanceof Error ? error.message : "Unknown relayer error",
  };
}

function applyRetryHeaders(res: { setHeader(name: string, value: string): void }, retryAfter?: number) {
  if (retryAfter === undefined) {
    return;
  }

  res.setHeader("retry-after", String(Math.ceil(retryAfter / 1_000)));
}
