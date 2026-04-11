import { PublicKey } from "@solana/web3.js";
import packageJson from "../package.json";
import {
  MAX_REQUEST_AGE_MS,
  getSignedRequestError,
  type SignedRequest,
} from "./auth";
import { calculateFee } from "./fee-calculator";
import { RelayerMetrics } from "./metrics";
import { verifyRelayProof } from "./proof-verifier";
import { RateLimiter } from "./rate-limiter";
import { validateRelayRequest, RelayerError } from "./relay-handler";
import type { RelayRecord, RelayStore } from "./store";
import type {
  ParsedRelayRequest,
  RelayerHealthPayload,
  RelayerInfoPayload,
  RelayerStatsPayload,
  RelaySuccessPayload,
} from "./types";
import type { RelayerConfig } from "./config";
import {
  isAmbiguousSubmissionError,
  type PoolAccountState,
  type RelayerRuntime,
} from "./tx-builder";

const DEFAULT_CONFIRMATION_POLL_MS = 1_000;

interface RelayServiceRequest {
  ip: string;
  signedRequest: SignedRequest;
}

interface ProductionRelayServiceOptions {
  config: RelayerConfig;
  metrics: RelayerMetrics;
  now?: () => number;
  rateLimiter: RateLimiter;
  runtime: RelayerRuntime;
  sleep?: (ms: number) => Promise<void>;
  store: RelayStore;
  confirmationPollMs?: number;
  proofVerifier?: (
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
  ) => Promise<void>;
}

export interface RelayService {
  relay(request: RelayServiceRequest): Promise<RelaySuccessPayload>;
  processRecord(record: RelayRecord): Promise<void>;
  getHealth(): Promise<RelayerHealthPayload>;
  getInfo(): Promise<RelayerInfoPayload>;
  getMetrics(): Promise<string>;
  getStats(): Promise<RelayerStatsPayload>;
}

export class ProductionRelayService implements RelayService {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly confirmationPollMs: number;
  private readonly proofVerifier: (
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
  ) => Promise<void>;

  constructor(private readonly options: ProductionRelayServiceOptions) {
    this.startedAt = (options.now ?? Date.now)();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.confirmationPollMs =
      options.confirmationPollMs ?? DEFAULT_CONFIRMATION_POLL_MS;
    this.proofVerifier = options.proofVerifier ?? verifyRelayProof;
  }

  async relay(request: RelayServiceRequest): Promise<RelaySuccessPayload> {
    const authError = getSignedRequestError(request.signedRequest, this.now());
    if (authError) {
      throw new RelayerError(authError, authError.includes("expired") ? 401 : 400);
    }

    const parsed = validateRelayRequest(request.signedRequest.payload);
    this.assertSupportedPool(parsed.pool);

    const nullifierHex = normalizedNullifier(parsed.nullifierHashBytes);
    const recordId = this.reservePendingRecord(
      request.signedRequest,
      parsed,
      request.ip,
      nullifierHex,
    );

    let poolState: PoolAccountState;
    try {
      poolState = await this.options.runtime.fetchPoolState(parsed.pool);
      if (
        await this.options.runtime.isNullifierUsed(
          parsed.pool,
          poolState,
          parsed.nullifierHashBytes,
        )
      ) {
        throw new RelayerError("Nullifier already used", 409);
      }

      const expectedFee = calculateFee(
        poolState.depositAmountRaw,
        this.options.config.feeBps,
        poolState.assetType === "sol" ? this.options.config.minFeeLamports : 0,
      );
      if (parsed.fee !== expectedFee) {
        throw new RelayerError(
          `Signed fee mismatch: expected ${expectedFee}, received ${parsed.fee}`,
        );
      }
      buildWithdrawalBreakdown(poolState, parsed.fee);

      const proofVerifyStartedAt = this.now();
      await this.proofVerifier(parsed, poolState);
      this.options.metrics.recordProofVerify(
        (this.now() - proofVerifyStartedAt) / 1_000,
      );
    } catch (error) {
      this.finalizeReservedRecord(recordId, error);
      throw error;
    }

    return this.waitForTerminalState(recordId, parsed, poolState);
  }

  async processRecord(record: RelayRecord): Promise<void> {
    const signedRequest = this.options.store.getSignedRequest(record.id);
    if (!signedRequest) {
      this.options.store.markExpired(record.id, "Relay payload missing from store");
      return;
    }

    let parsed: ParsedRelayRequest;
    try {
      parsed = validateRelayRequest(signedRequest.payload);
      this.assertSupportedPool(parsed.pool);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.markExpired(record.id, message);
      return;
    }

    let poolState: PoolAccountState;
    try {
      poolState = await this.options.runtime.fetchPoolState(parsed.pool);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (record.status === "submitted") {
        this.options.store.rescheduleSubmitted(
          record.id,
          this.now() + this.confirmationPollMs,
          message,
        );
        return;
      }

      this.handleSubmissionFailure(record, error);
      return;
    }

    if (record.status === "submitted") {
      try {
        await this.inspectSubmittedRecord(record, poolState);
      } catch (error) {
        this.rescheduleSubmittedRecord(record, error);
      }
      return;
    }

    if (record.status === "pending") {
      await this.submitPendingRecord(record, parsed, poolState);
    }
  }

  async getHealth(): Promise<RelayerHealthPayload> {
    return {
      status: "ok",
      uptime: this.now() - this.startedAt,
      version: packageJson.version,
    };
  }

  async getInfo(): Promise<RelayerInfoPayload> {
    const poolState = await this.options.runtime.fetchPoolState(
      new PublicKey(this.options.config.poolAddress),
    );
    const relayerFeeRaw = calculateFee(
      poolState.depositAmountRaw,
      this.options.config.feeBps,
      poolState.assetType === "sol" ? this.options.config.minFeeLamports : 0,
    );
    const breakdown = buildWithdrawalBreakdown(poolState, relayerFeeRaw);

    return {
      pool: this.options.config.poolAddress,
      poolDenomination: poolState.depositAmountRaw,
      poolDenominationRaw: poolState.depositAmountRaw,
      protocolFeeBps: poolState.protocolFeeBps,
      relayerFeeBps: this.options.config.feeBps,
      totalFeeBps: poolState.protocolFeeBps + this.options.config.feeBps,
      estimatedRecipientLamports: breakdown.recipientAmountRaw,
      treasury: poolState.treasury?.toBase58() ?? null,
      fee: {
        feeBps: this.options.config.feeBps,
        minFeeLamports: this.options.config.minFeeLamports,
        protocolFeeBps: poolState.protocolFeeBps,
        breakdown,
      },
      network: this.options.config.cluster,
      programId: this.options.config.programId,
      relayer: this.options.runtime.getRelayerPublicKey().toBase58(),
      relayerBalanceLamports: await this.options.runtime.getRelayerBalance(),
      maxRequestAgeMs: MAX_REQUEST_AGE_MS,
    };
  }

  async getMetrics(): Promise<string> {
    return this.options.metrics.render(
      this.options.store.getStats(0),
      await this.options.runtime.getRelayerBalance(),
    );
  }

  async getStats(): Promise<RelayerStatsPayload> {
    const stats = this.options.store.getStats(this.now() - 24 * 60 * 60 * 1_000);
    return {
      last24h: {
        total: stats.total,
        confirmed: stats.confirmed,
        failed: stats.failed,
        fees: stats.totalFees,
        protocolFeesCollected: stats.protocolFees,
        relayerFeesCollected: stats.relayerFees,
      },
    };
  }

  private reservePendingRecord(
    signedRequest: SignedRequest,
    parsed: ParsedRelayRequest,
    clientIp: string,
    nullifierHex: string,
  ): string {
    let reservation: ReturnType<RateLimiter["reserve"]>;
    try {
      reservation = this.options.rateLimiter.reserve({
        clientIp,
        fee: parsed.fee,
        nullifierHash: nullifierHex,
        pool: parsed.pool.toBase58(),
        requestJson: JSON.stringify(signedRequest),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Nullifier already exists") {
        throw new RelayerError("Nullifier already submitted to this relayer", 409);
      }

      throw error;
    }

    if (!reservation.allowed) {
      throw new RelayerError("Rate limit exceeded", 429, reservation.retryAfter);
    }

    if (!reservation.recordId) {
      throw new RelayerError("Relay reservation did not return a record id", 500);
    }

    return reservation.recordId;
  }

  private finalizeReservedRecord(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RelayerError && error.status < 500) {
      this.options.store.markExpired(id, message);
      return;
    }

    this.options.store.markFailed(id, message, this.now(), true);
  }

  private async waitForTerminalState(
    id: string,
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
  ): Promise<RelaySuccessPayload> {
    for (;;) {
      const record = this.options.store.get(id);
      if (!record) {
        throw new RelayerError("Relay request disappeared from store", 500);
      }

      if (record.status === "confirmed") {
        return this.toSuccessPayload(record, parsed, poolState);
      }

      if (record.status === "failed") {
        throw new RelayerError(record.error ?? "Relay request failed", 502);
      }

      if (record.status === "expired") {
        throw new RelayerError(record.error ?? "Relay request expired", 410);
      }

      const delayMs = Math.max(0, record.nextAttemptAt - this.now());
      if (delayMs > 0) {
        await this.sleep(delayMs);
        continue;
      }

      await this.processRecord(record);
    }
  }

  private async submitPendingRecord(
    record: RelayRecord,
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
  ): Promise<void> {
    const submittedAt = this.now();
    const breakdown = buildWithdrawalBreakdown(poolState, parsed.fee);

    try {
      const { proofABytes, proofBBytes, proofCBytes } = splitProofBytes(parsed.proofBytes);
      const submitted = await this.options.runtime.submitRelayedWithdraw({
        pool: parsed.pool,
        recipient: parsed.recipient,
        proofABytes,
        proofBBytes,
        proofCBytes,
        rootBytes: Array.from(parsed.rootBytes),
        nullifierHashBytes: Array.from(parsed.nullifierHashBytes),
        feeAmountRaw: parsed.fee,
        poolState,
      });

      this.options.store.markSubmitted(
        record.id,
        submitted.txSignature,
        submittedAt,
        submitted.lastValidBlockHeight,
      );
      this.options.store.recordFeeBreakdown(
        record.id,
        breakdown.protocolFeeRaw,
        breakdown.relayerFeeRaw,
      );
    } catch (error) {
      if (isAmbiguousSubmissionError(error)) {
        this.options.store.markSubmitted(
          record.id,
          error.txSignature,
          submittedAt,
          error.lastValidBlockHeight,
        );
        this.options.store.rescheduleSubmitted(
          record.id,
          submittedAt,
          error.message,
        );
        this.options.store.recordFeeBreakdown(
          record.id,
          breakdown.protocolFeeRaw,
          breakdown.relayerFeeRaw,
        );
        return;
      }

      if (await this.tryRecoverPendingSpentFailure(record, parsed, poolState, submittedAt, error)) {
        return;
      }

      this.handleSubmissionFailure(record, error);
    }
  }

  private async inspectSubmittedRecord(
    record: RelayRecord,
    poolState: PoolAccountState,
  ): Promise<void> {
    if (!record.txSignature) {
      this.options.store.markFailed(
        record.id,
        "Submitted relay request is missing a transaction signature",
        this.now(),
        true,
      );
      return;
    }

    const status = await this.options.runtime.getSignatureStatus(record.txSignature);
    if (status.found && status.err) {
      if (await this.tryRecoverSubmittedSpentFailure(record, poolState)) {
        return;
      }

      this.options.store.markFailed(
        record.id,
        `Relayed transaction failed: ${JSON.stringify(status.err)}`,
        this.now(),
        true,
        false,
      );
      return;
    }

    if (
      status.found &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      if (record.submittedAt !== undefined) {
        this.options.metrics.recordTxConfirm(
          (this.now() - record.submittedAt) / 1_000,
        );
      }
      const breakdown = buildWithdrawalBreakdown(poolState, record.fee);
      this.options.store.recordFeeBreakdown(
        record.id,
        breakdown.protocolFeeRaw,
        breakdown.relayerFeeRaw,
      );
      this.options.store.markConfirmed(record.id);
      return;
    }

    if (status.found) {
      this.options.store.rescheduleSubmitted(
        record.id,
        this.now() + this.confirmationPollMs,
      );
      return;
    }

    if (
      await this.options.runtime.isNullifierUsed(
        new PublicKey(record.pool),
        poolState,
        Buffer.from(record.nullifierHash, "hex"),
      )
    ) {
      if (record.submittedAt !== undefined) {
        this.options.metrics.recordTxConfirm(
          (this.now() - record.submittedAt) / 1_000,
        );
      }
      const breakdown = buildWithdrawalBreakdown(poolState, record.fee);
      this.options.store.recordFeeBreakdown(
        record.id,
        breakdown.protocolFeeRaw,
        breakdown.relayerFeeRaw,
      );
      this.options.store.markConfirmed(record.id);
      return;
    }

    if (
      record.lastValidBlockHeight !== undefined &&
      (await this.options.runtime.getCurrentBlockHeight()) > record.lastValidBlockHeight
    ) {
      this.handleSubmissionFailure(
        record,
        new Error("Transaction expired before confirmation"),
      );
      return;
    }

    this.options.store.rescheduleSubmitted(
      record.id,
      this.now() + this.confirmationPollMs,
    );
  }

  private handleSubmissionFailure(record: RelayRecord, error: unknown): void {
    const backoffMs = this.getBackoffMs(record.retries);
    const finalFailure =
      !isRetryableError(error) || record.retries >= this.options.config.maxRetries;
    const message = error instanceof Error ? error.message : String(error);
    const preserveSubmission = finalFailure && record.status === "submitted";

    this.options.store.markFailed(
      record.id,
      message,
      finalFailure ? this.now() : this.now() + backoffMs,
      finalFailure,
      !preserveSubmission,
    );
  }

  private async tryRecoverPendingSpentFailure(
    record: RelayRecord,
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
    submittedAt: number,
    error: unknown,
  ): Promise<boolean> {
    if (!isRecoverableSpentPendingFailure(error)) {
      return false;
    }

    try {
      if (
        !(await this.options.runtime.isNullifierUsed(
          parsed.pool,
          poolState,
          parsed.nullifierHashBytes,
        ))
      ) {
        return false;
      }

      const recoveredSignature = await this.options.runtime.findNullifierSpendSignature(
        parsed.pool,
        poolState,
        parsed.nullifierHashBytes,
      );
      if (!recoveredSignature) {
        return false;
      }

      this.options.metrics.recordTxConfirm((this.now() - submittedAt) / 1_000);
      const breakdown = buildWithdrawalBreakdown(poolState, parsed.fee);
      this.options.store.recordFeeBreakdown(
        record.id,
        breakdown.protocolFeeRaw,
        breakdown.relayerFeeRaw,
      );
      this.options.store.markConfirmed(record.id, recoveredSignature, submittedAt);
      return true;
    } catch {
      return false;
    }
  }

  private async tryRecoverSubmittedSpentFailure(
    record: RelayRecord,
    poolState: PoolAccountState,
  ): Promise<boolean> {
    try {
      const pool = new PublicKey(record.pool);
      const nullifierHash = Buffer.from(record.nullifierHash, "hex");
      if (!(await this.options.runtime.isNullifierUsed(pool, poolState, nullifierHash))) {
        return false;
      }

      const recoveredSignature = await this.options.runtime.findNullifierSpendSignature(
        pool,
        poolState,
        nullifierHash,
      );
      if (!recoveredSignature) {
        return false;
      }

      if (record.submittedAt !== undefined) {
        this.options.metrics.recordTxConfirm(
          (this.now() - record.submittedAt) / 1_000,
        );
      }
      const breakdown = buildWithdrawalBreakdown(poolState, record.fee);
      this.options.store.recordFeeBreakdown(
        record.id,
        breakdown.protocolFeeRaw,
        breakdown.relayerFeeRaw,
      );
      this.options.store.markConfirmed(
        record.id,
        recoveredSignature,
        record.submittedAt,
      );
      return true;
    } catch {
      return false;
    }
  }

  private rescheduleSubmittedRecord(record: RelayRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.store.rescheduleSubmitted(
      record.id,
      this.now() + this.confirmationPollMs,
      message,
    );
  }

  private getBackoffMs(retries: number): number {
    return this.options.config.retryBackoffMs[
      Math.min(retries, this.options.config.retryBackoffMs.length - 1)
    ];
  }

  private toSuccessPayload(
    record: RelayRecord,
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
  ): RelaySuccessPayload {
    if (!record.txSignature) {
      throw new RelayerError("Confirmed relay request is missing a transaction signature", 500);
    }

    const breakdown = buildWithdrawalBreakdown(poolState, parsed.fee);
    return {
      txSignature: record.txSignature,
      fee: breakdown.relayerFee,
      recipientReceived: breakdown.recipientAmount,
      protocolFee: breakdown.protocolFee,
      protocolFeeRaw: breakdown.protocolFeeRaw,
      relayerFee: breakdown.relayerFee,
      relayerFeeRaw: breakdown.relayerFeeRaw,
      recipientAmount: breakdown.recipientAmount,
      recipientAmountRaw: breakdown.recipientAmountRaw,
      totalFee: breakdown.totalFee,
      totalFeeRaw: breakdown.totalFeeRaw,
    };
  }

  private assertSupportedPool(pool: PublicKey): void {
    if (pool.toBase58() !== this.options.config.poolAddress) {
      throw new RelayerError("Pool not supported by this relayer", 404);
    }
  }
}

function normalizedNullifier(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function splitProofBytes(proofBytes: Uint8Array): {
  proofABytes: number[];
  proofBBytes: number[];
  proofCBytes: number[];
} {
  if (proofBytes.length !== 256) {
    throw new RelayerError("proof must be exactly 256 bytes");
  }

  return {
    proofABytes: Array.from(proofBytes.slice(0, 64)),
    proofBBytes: Array.from(proofBytes.slice(64, 192)),
    proofCBytes: Array.from(proofBytes.slice(192, 256)),
  };
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof RelayerError) {
    return error.status >= 500 || error.status === 429;
  }

  const message = error instanceof Error ? error.message : String(error);
  return !/custom program error|simulation failed|invalid proof|already used/i.test(message);
}

function isRecoverableSpentPendingFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already used|already in use|Allocate:.*already in use/i.test(message);
}

function buildWithdrawalBreakdown(
  poolState: PoolAccountState,
  relayerFeeRaw: number,
): RelayerInfoPayload["fee"]["breakdown"] {
  const protocolFeeRaw = Math.floor(
    (poolState.depositAmountRaw * poolState.protocolFeeBps) / 10_000,
  );
  const totalFeeRaw = protocolFeeRaw + relayerFeeRaw;
  if (totalFeeRaw >= poolState.depositAmountRaw) {
    throw new RelayerError(
      "Configured relayer fee plus protocol fee is too high for this pool",
      500,
    );
  }

  const recipientAmountRaw = poolState.depositAmountRaw - totalFeeRaw;
  return {
    depositAmount: toDisplayAmount(poolState.depositAmountRaw, poolState),
    depositAmountRaw: poolState.depositAmountRaw,
    protocolFeeBps: poolState.protocolFeeBps,
    protocolFee: toDisplayAmount(protocolFeeRaw, poolState),
    protocolFeeRaw,
    relayerFee: toDisplayAmount(relayerFeeRaw, poolState),
    relayerFeeRaw,
    recipientAmount: toDisplayAmount(recipientAmountRaw, poolState),
    recipientAmountRaw,
    totalFee: toDisplayAmount(totalFeeRaw, poolState),
    totalFeeRaw,
  };
}

function toDisplayAmount(amount: number, poolState: PoolAccountState): number {
  if (poolState.assetType === "sol" || poolState.tokenDecimals === null) {
    return amount / 1_000_000_000;
  }

  return amount / 10 ** poolState.tokenDecimals;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
