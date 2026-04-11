import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  SNAPClient,
  SNAP_PROGRAM_ID,
} from "../../sdk-package/src";
import { bytesToHex } from "../../sdk-package/src/commitment";
import { generateWithdrawProof } from "../../sdk-package/src/proof";
import { signRelayerWithdrawRequest } from "../../sdk-package/src/relayer-auth";
import {
  createRelayerApp,
} from "../../relayer/src";
import { RelayerMetrics } from "../../relayer/src/metrics";
import { RateLimiter } from "../../relayer/src/rate-limiter";
import { RetryManager } from "../../relayer/src/retry";
import { ProductionRelayService } from "../../relayer/src/service";
import { RelayStore } from "../../relayer/src/store";
import type { RelayerConfig } from "../../relayer/src/config";
import {
  AnchorRelayerRuntime,
  type PoolAccountState,
  type RelayTransactionStatus,
  type RelayerRuntime,
  type SubmittedRelayTransaction,
} from "../../relayer/src/tx-builder";
import {
  createResultRecorder,
  summarizeError,
  type AdversarialCaseResult,
} from "./shared";
import { fundSystemAccount } from "../helpers";

/**
 * Relayer adversarial tests.
 *
 * Attacks the HTTP relayer with malformed, malicious, and edge-case
 * requests. Tests the auth, rate limiting, and validation layers.
 */

describe("Relayer adversarial tests", function () {
  this.timeout(15 * 60 * 1000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const connection = provider.connection;
  const relayer = Keypair.generate();
  const snap = new SNAPClient(connection, payer);
  const recorder = createResultRecorder("relayer.json", "relayer");
  const unexpectedCases: string[] = [];

  before(async () => {
    await fundSystemAccount(provider, relayer.publicKey, 2_000_000_000);
  });

  after(() => {
    recorder.persist();
  });

  it("3a-proof. rejects proof tampering after signing", async () => {
    await withRealHarness(async (harness) => {
      const recipient = Keypair.generate().publicKey;
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient,
        snap,
      });
      signedRequest.payload.proof = mutateHex(signedRequest.payload.proof);

      const response = await postRelay(harness.baseUrl, signedRequest);
      const result = relayResult({
        attempted:
          "Signed a valid request, then modified the proof bytes after signing.",
        caseId: "3a-proof",
        expectedStatus: 400,
        name: "Request tampering: proof bytes",
        response,
      });
      result.matchedExpectation =
        result.matchedExpectation &&
        /signature verification failed/i.test(JSON.stringify(response.body));

      recordCase(result);
    });
  });

  it("3a-recipient. rejects recipient tampering after signing", async () => {
    await withRealHarness(async (harness) => {
      const recipient = Keypair.generate().publicKey;
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient,
        snap,
      });
      signedRequest.payload.recipient = Keypair.generate().publicKey.toBase58();

      const response = await postRelay(harness.baseUrl, signedRequest);
      const result = relayResult({
        attempted:
          "Signed a valid request, then modified the recipient after signing.",
        caseId: "3a-recipient",
        expectedStatus: 400,
        name: "Request tampering: recipient",
        response,
      });
      result.matchedExpectation =
        result.matchedExpectation &&
        /signature verification failed/i.test(JSON.stringify(response.body));

      recordCase(result);
    });
  });

  it("3a-fee. rejects fee tampering after signing", async () => {
    await withRealHarness(async (harness) => {
      const recipient = Keypair.generate().publicKey;
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient,
        snap,
      });
      signedRequest.payload.fee += 1;

      const response = await postRelay(harness.baseUrl, signedRequest);
      const result = relayResult({
        attempted:
          "Signed a valid request, then modified the relayer fee after signing.",
        caseId: "3a-fee",
        expectedStatus: 400,
        name: "Request tampering: fee",
        response,
      });
      result.matchedExpectation =
        result.matchedExpectation &&
        /signature verification failed/i.test(JSON.stringify(response.body));

      recordCase(result);
    });
  });

  it("3b. rejects replay of a successful signed request", async () => {
    await withRealHarness(async (harness) => {
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient: Keypair.generate().publicKey,
        snap,
      });

      const first = await postRelay(harness.baseUrl, signedRequest);
      const second = await postRelay(harness.baseUrl, signedRequest);

      const result: AdversarialCaseResult = {
        attempted:
          "Submitted one valid signed relay request successfully, then replayed the exact same request.",
        caseId: "3b",
        matchedExpectation:
          first.status === 200 &&
          second.status === 409 &&
          /nullifier/i.test(JSON.stringify(second.body)),
        name: "Replay attack",
        notes: [
          `First response: ${first.status}`,
          `Second response: ${second.status}`,
        ],
        relayer: {
          body: {
            first: first.body,
            second: second.body,
          },
          headers: second.headers,
          status: second.status,
        },
      };

      recordCase(result);
    });
  });

  it("3c-epoch. rejects timestamp 0", async () => {
    await withRealHarness(async (harness) => {
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient: Keypair.generate().publicKey,
        snap,
        timestamp: 0,
      });
      const response = await postRelay(harness.baseUrl, signedRequest);

      const result = relayResult({
        attempted: "Submitted a request signed with timestamp 0 (Unix epoch).",
        caseId: "3c-epoch",
        expectedStatus: 401,
        name: "Timestamp manipulation: Unix epoch",
        response,
      });

      recordCase(result);
    });
  });

  it("3c-future. rejects a far-future timestamp", async () => {
    await withRealHarness(async (harness) => {
      const futureTimestamp = new Date("2030-01-01T00:00:00Z").getTime();
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient: Keypair.generate().publicKey,
        snap,
        timestamp: futureTimestamp,
      });
      const response = await postRelay(harness.baseUrl, signedRequest);

      const result = relayResult({
        attempted:
          "Submitted a request signed with a future timestamp of January 1, 2030 UTC.",
        caseId: "3c-future",
        expectedStatus: 400,
        name: "Timestamp manipulation: far future",
        response,
      });

      recordCase(result);
    });
  });

  it("3c-stale. rejects a request older than 60 seconds", async () => {
    await withRealHarness(async (harness) => {
      const staleTimestamp = Date.now() - 61_000;
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient: Keypair.generate().publicKey,
        snap,
        timestamp: staleTimestamp,
      });
      const response = await postRelay(harness.baseUrl, signedRequest);

      const result = relayResult({
        attempted:
          "Submitted a request signed 61 seconds in the past, just beyond the freshness window.",
        caseId: "3c-stale",
        expectedStatus: 401,
        name: "Timestamp manipulation: stale request",
        response,
      });

      recordCase(result);
    });
  });

  it("3d-empty. rejects an empty request body with 400, not 500", async () => {
    await withMockHarness(async (harness) => {
      const response = await postRawBody(harness.baseUrl, "");
      const result = relayResult({
        attempted: "Sent an empty POST body to /relay.",
        caseId: "3d-empty",
        expectedStatus: 400,
        name: "Payload fuzzing: empty body",
        response,
      });

      recordCase(result);
    });
  });

  it("3d-missing. rejects JSON missing required fields", async () => {
    await withMockHarness(async (harness) => {
      const response = await postRelay(harness.baseUrl, { payload: {} });
      const result = relayResult({
        attempted: "Sent valid JSON with the relay fields removed.",
        caseId: "3d-missing",
        expectedStatus: 400,
        name: "Payload fuzzing: missing required fields",
        response,
      });

      recordCase(result);
    });
  });

  it("3d-zero-proof. rejects a zero-byte proof", async () => {
    await withMockHarness(async (harness) => {
      const request = createMockSignedRequest(harness.config.poolAddress, {
        proof: "",
      });
      const response = await postRelay(harness.baseUrl, request);
      const result = relayResult({
        attempted: "Submitted a signed request with an empty proof field.",
        caseId: "3d-zero-proof",
        expectedStatus: 400,
        name: "Payload fuzzing: zero-byte proof",
        response,
      });

      recordCase(result);
    });
  });

  it("3d-10mb. rejects a 10MB proof payload without a 500", async () => {
    await withMockHarness(async (harness) => {
      const response = await postLargeProofRequest(
        harness.baseUrl,
        createLargeRequestPrefix(harness.config.poolAddress),
        10 * 1024 * 1024,
      );
      const result: AdversarialCaseResult = {
        attempted:
          "Submitted a request whose proof field expanded to roughly 10MB of hex data.",
        caseId: "3d-10mb",
        matchedExpectation: response.status === 413 || response.status === 400,
        name: "Payload fuzzing: 10MB proof",
        relayer: {
          body: response.body,
          headers: response.headers,
          status: response.status,
        },
      };

      recordCase(result);
    });
  });

  it("3d-invalid-nullifier. rejects invalid hex in nullifierHash", async () => {
    await withMockHarness(async (harness) => {
      const request = createMockSignedRequest(harness.config.poolAddress, {
        nullifierHash: "not-hex",
      });
      const response = await postRelay(harness.baseUrl, request);
      const result = relayResult({
        attempted: "Submitted a signed request with invalid hex in nullifierHash.",
        caseId: "3d-invalid-nullifier",
        expectedStatus: 400,
        name: "Payload fuzzing: invalid nullifier hex",
        response,
      });

      recordCase(result);
    });
  });

  it("3d-base58-vs-hex. rejects mismatched encodings", async () => {
    await withMockHarness(async (harness) => {
      const request = createMockSignedRequest(harness.config.poolAddress, {
        pool: "deadbeef",
        proof: Keypair.generate().publicKey.toBase58(),
      });
      const response = await postRelay(harness.baseUrl, request);
      const result = relayResult({
        attempted:
          "Submitted base58 where hex was expected and hex where a base58 public key was expected.",
        caseId: "3d-base58-vs-hex",
        expectedStatus: 400,
        name: "Payload fuzzing: base58/hex mismatch",
        response,
      });

      recordCase(result);
    });
  });

  it("3e. rate-limits 100 requests from the same IP and recovers after the window", async () => {
    let currentTime = Date.now();
    await withMockHarness(
      async (harness) => {
        const responses = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            postRelay(
              harness.baseUrl,
              createMockSignedRequest(harness.config.poolAddress, {
                nullifierHash: `${(index + 1).toString(16).padStart(2, "0")}`.repeat(32),
                timestamp: currentTime,
              }),
            ),
          ),
        );

        const accepted = responses.filter((response) => response.status === 200);
        const rateLimited = responses.filter((response) => response.status === 429);

        currentTime += 1_500;
        const followUp = await postRelay(
          harness.baseUrl,
          createMockSignedRequest(harness.config.poolAddress, {
            nullifierHash: "ff".repeat(32),
            timestamp: currentTime,
          }),
        );

        const result: AdversarialCaseResult = {
          attempted:
            "Fired 100 signed requests from the same IP within one limiter window, then retried after the window expired.",
          caseId: "3e",
          matchedExpectation:
            accepted.length === 5 &&
            rateLimited.length === 95 &&
            rateLimited.every((response) => Number(response.headers["retry-after"]) > 0) &&
            followUp.status === 200,
          name: "Rate limit exhaustion",
          notes: [
            `Accepted: ${accepted.length}`,
            `Rate-limited: ${rateLimited.length}`,
            `Follow-up after window: ${followUp.status}`,
          ],
          relayer: {
            body: {
              accepted: accepted.length,
              followUp: followUp.body,
              rateLimited: rateLimited.length,
            },
            headers: followUp.headers,
            status: followUp.status,
          },
        };

        recordCase(result);
      },
      {
        clock: {
          advance(ms: number) {
            currentTime += ms;
          },
          now: () => currentTime,
        },
        limits: {
          perIp: 5,
          windowMs: 1_000,
        },
      },
    );
  });

  it("3f. allows exactly one of 10 concurrent identical requests", async () => {
    await withRealHarness(async (harness) => {
      const { signedRequest } = await createLiveSignedRequest({
        config: harness.config,
        payer,
        pool: harness.pool,
        recipient: Keypair.generate().publicKey,
        snap,
      });

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => postRelay(harness.baseUrl, signedRequest)),
      );

      const succeeded = responses.filter((response) => response.status === 200);
      const rejected = responses.filter((response) => response.status !== 200);

      const result: AdversarialCaseResult = {
        attempted:
          "Submitted 10 identical valid signed requests concurrently with the same nullifier.",
        caseId: "3f",
        matchedExpectation:
          succeeded.length === 1 && rejected.length === 9,
        name: "Concurrent identical requests",
        notes: [
          `Succeeded: ${succeeded.length}`,
          `Rejected: ${rejected.length}`,
        ],
        relayer: {
          body: responses.map((response) => response.status),
          headers: succeeded[0]?.headers,
          status: succeeded[0]?.status ?? 0,
        },
      };

      recordCase(result);
    });
  });

  it("3g. rejects a 100MB proof payload before the relayer parses the whole body", async () => {
    await withMockHarness(async (harness) => {
      const response = await postLargeProofRequest(
        harness.baseUrl,
        createLargeRequestPrefix(harness.config.poolAddress),
        100 * 1024 * 1024,
      );
      const result: AdversarialCaseResult = {
        attempted:
          "Submitted a request whose proof field advertised roughly 100MB of hex data.",
        caseId: "3g",
        matchedExpectation: response.status === 413 || response.status === 400,
        name: "Large payload DoS",
        notes: ["The relayer should reject this before normal JSON validation."],
        relayer: {
          body: response.body,
          headers: response.headers,
          status: response.status,
        },
      };

      recordCase(result);
    });
  });

  it("all relayer adversarial cases matched expectations", () => {
    assert.deepEqual(
      unexpectedCases,
      [],
      `Unexpected relayer outcomes: ${unexpectedCases.join(", ")}`,
    );
  });

  async function withRealHarness(
    run: (harness: RealHarness) => Promise<void>,
  ): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-adversarial-relayer-"));
    const dbPath = path.join(tempDir, "relayer.sqlite");
    const pool = await snap.createPool(0.001, { treeDepth: 10 });
    const harness = await startRealHarness({
      connection,
      dbPath,
      pool,
      relayer,
    });

    try {
      await run(harness);
    } finally {
      await stopHarness(harness);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function withMockHarness(
    run: (harness: MockHarness) => Promise<void>,
    options?: {
      clock?: { advance(ms: number): void; now(): number };
      limits?: { perIp?: number; windowMs?: number };
    },
  ): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-adversarial-relayer-mock-"));
    const dbPath = path.join(tempDir, "relayer.sqlite");
    const harness = await startMockHarness(dbPath, options);

    try {
      await run(harness);
    } finally {
      await stopHarness(harness);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  function recordCase(result: AdversarialCaseResult) {
    recorder.push(result);
    if (!result.matchedExpectation) {
      unexpectedCases.push(result.caseId);
    }
  }
});

interface HarnessBase {
  baseUrl: string;
  config: RelayerConfig;
  server: http.Server;
}

interface RealHarness extends HarnessBase {
  pool: PublicKey;
  retryManager: RetryManager;
  service: ProductionRelayService;
  store: RelayStore;
}

interface MockHarness extends HarnessBase {
  service: ProductionRelayService;
  store: RelayStore;
}

class MockRuntime implements RelayerRuntime {
  readonly relayer = Keypair.generate();
  readonly usedNullifiers = new Set<string>();

  constructor(private readonly poolState: PoolAccountState) {}

  async fetchPoolState(): Promise<PoolAccountState> {
    return {
      ...this.poolState,
      usedNullifiers: Array.from(this.usedNullifiers, (value) =>
        Uint8Array.from(Buffer.from(value, "hex")),
      ),
    };
  }

  async findNullifierSpendSignature(): Promise<string | null> {
    return null;
  }

  async isNullifierUsed(
    _pool: PublicKey,
    _poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<boolean> {
    return this.usedNullifiers.has(Buffer.from(nullifierHash).toString("hex"));
  }

  async submitRelayedWithdraw(args: {
    nullifierHashBytes: number[];
  }): Promise<SubmittedRelayTransaction> {
    this.usedNullifiers.add(Buffer.from(args.nullifierHashBytes).toString("hex"));
    return {
      lastValidBlockHeight: 1_000,
      txSignature: `mock-${Math.random().toString(16).slice(2)}`,
    };
  }

  async getSignatureStatus(): Promise<RelayTransactionStatus> {
    return {
      confirmationStatus: "confirmed",
      err: null,
      found: true,
    };
  }

  async getCurrentBlockHeight(): Promise<number> {
    return 1;
  }

  async getRelayerBalance(): Promise<number> {
    return 1_000_000_000;
  }

  getRelayerPublicKey(): PublicKey {
    return this.relayer.publicKey;
  }
}

async function startRealHarness(args: {
  connection: anchor.web3.Connection;
  dbPath: string;
  pool: PublicKey;
  relayer: Keypair;
}): Promise<RealHarness> {
  const config: RelayerConfig = {
    rpcUrl: "http://127.0.0.1:8899",
    cluster: "localnet",
    dbPath: args.dbPath,
    feeBps: 50,
    host: "127.0.0.1",
    keypairPath: path.join(path.dirname(args.dbPath), "relayer.json"),
    maxRequestsPerMinuteGlobal: 500,
    maxRequestsPerMinutePerIp: 50,
    maxRetries: 3,
    minFeeLamports: 10_000,
    poolAddress: args.pool.toBase58(),
    port: 0,
    programId: SNAP_PROGRAM_ID.toBase58(),
    retryBackoffMs: [100, 250, 500],
  };
  const runtime = new AnchorRelayerRuntime(
    args.connection,
    args.relayer,
    SNAP_PROGRAM_ID,
  );
  const store = new RelayStore(args.dbPath);
  const rateLimiter = new RateLimiter({
    maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
    maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
    store,
  });
  const service = new ProductionRelayService({
    config,
    metrics: new RelayerMetrics(),
    rateLimiter,
    runtime,
    store,
  });
  const retryManager = new RetryManager(store, {
    pollIntervalMs: 100,
    processor: async (record) => {
      await service.processRecord(record);
    },
  });
  retryManager.start();

  const server = createRelayerApp(service).listen(0, config.host);
  await onceListening(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine relayer listening address");
  }

  return {
    baseUrl: `http://${config.host}:${address.port}`,
    config,
    pool: args.pool,
    retryManager,
    server,
    service,
    store,
  };
}

async function startMockHarness(
  dbPath: string,
  options?: {
    clock?: { advance(ms: number): void; now(): number };
    limits?: { perIp?: number; windowMs?: number };
  },
): Promise<MockHarness> {
  const config: RelayerConfig = {
    rpcUrl: "http://127.0.0.1:8899",
    cluster: "localnet",
    dbPath,
    feeBps: 50,
    host: "127.0.0.1",
    keypairPath: path.join(path.dirname(dbPath), "relayer.json"),
    maxRequestsPerMinuteGlobal: 100,
    maxRequestsPerMinutePerIp: options?.limits?.perIp ?? 10,
    maxRetries: 0,
    minFeeLamports: 10_000,
    poolAddress: Keypair.generate().publicKey.toBase58(),
    port: 0,
    programId: SNAP_PROGRAM_ID.toBase58(),
    retryBackoffMs: [50],
  };
  const store = new RelayStore(dbPath, options?.clock?.now);
  const rateLimiter = new RateLimiter({
    maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
    maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
    now: options?.clock?.now,
    store,
    windowMs: options?.limits?.windowMs ?? 60_000,
  });
  const service = new ProductionRelayService({
    config,
    metrics: new RelayerMetrics(),
    now: options?.clock?.now,
    proofVerifier: async () => undefined,
    rateLimiter,
    runtime: new MockRuntime(createMockPoolState()),
    store,
  });
  const server = createRelayerApp(service).listen(0, config.host);
  await onceListening(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine mock relayer listening address");
  }

  return {
    baseUrl: `http://${config.host}:${address.port}`,
    config,
    server,
    service,
    store,
  };
}

async function stopHarness(
  harness: RealHarness | MockHarness | undefined,
): Promise<void> {
  if (!harness) {
    return;
  }

  if ("retryManager" in harness) {
    harness.retryManager.stop();
  }

  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function createLiveSignedRequest(args: {
  config: RelayerConfig;
  payer: Keypair;
  pool: PublicKey;
  recipient: PublicKey;
  snap: SNAPClient;
  timestamp?: number;
}): Promise<{
  note: Awaited<ReturnType<SNAPClient["deposit"]>>;
  signedRequest: ReturnType<typeof signRelayerWithdrawRequest>;
}> {
  const note = await args.snap.deposit(args.pool, 0.001);
  const poolState = await (args.snap as any).fetchPoolState(args.pool);
  const proof = await generateWithdrawProof(
    note,
    poolState.commitments,
    args.recipient,
    120_000,
    poolState.treeDepth,
  );
  const fee = Math.max(
    Math.floor((poolState.depositAmountRaw * args.config.feeBps) / 10_000),
    args.config.minFeeLamports,
  );

  const signedRequest = signRelayerWithdrawRequest(
    {
      fee,
      nullifierHash: bytesToHex(Uint8Array.from(proof.nullifierHashBytes)),
      pool: args.pool.toBase58(),
      proof: bytesToHex(
        Uint8Array.from([
          ...proof.proofABytes,
          ...proof.proofBBytes,
          ...proof.proofCBytes,
        ]),
      ),
      recipient: args.recipient.toBase58(),
      root: bytesToHex(Uint8Array.from(proof.rootBytes)),
    },
    args.payer.secretKey.slice(0, 32),
    args.timestamp,
  );

  return { note, signedRequest };
}

function createMockSignedRequest(
  poolAddress: string,
  overrides: Partial<{
    fee: number;
    nullifierHash: string;
    pool: string;
    proof: string;
    recipient: string;
    root: string;
    timestamp: number;
  }> = {},
) {
  const payload = {
    fee: overrides.fee ?? 10_000,
    nullifierHash: overrides.nullifierHash ?? "11".repeat(32),
    pool: overrides.pool ?? poolAddress,
    proof: overrides.proof ?? "aa".repeat(256),
    recipient: overrides.recipient ?? Keypair.generate().publicKey.toBase58(),
    root: overrides.root ?? "22".repeat(32),
  };

  return signRelayerWithdrawRequest(
    payload,
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    overrides.timestamp,
  );
}

function createMockPoolState(): PoolAccountState {
  return {
    assetType: "sol",
    depositAmountRaw: 1_000_000,
    feeCapable: false,
    kind: "v2",
    nullifierVersion: 1,
    protocolFeeBps: 0,
    roots: [Uint8Array.from(Buffer.alloc(32, 1))],
    tokenDecimals: null,
    tokenMint: null,
    treasury: null,
    treeDepth: 10,
    usedNullifiers: [],
  };
}

function relayResult(args: {
  attempted: string;
  caseId: string;
  expectedStatus: number;
  name: string;
  response: RelayResponse;
}): AdversarialCaseResult {
  return {
    attempted: args.attempted,
    caseId: args.caseId,
    matchedExpectation: args.response.status === args.expectedStatus,
    name: args.name,
    relayer: {
      body: args.response.body,
      headers: args.response.headers,
      status: args.response.status,
    },
  };
}

interface RelayResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

async function postRelay(baseUrl: string, payload: unknown): Promise<RelayResponse> {
  const response = await fetch(`${baseUrl}/relay`, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  return {
    body: await parseResponseBody(response),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
}

async function postRawBody(baseUrl: string, body: string): Promise<RelayResponse> {
  const response = await fetch(`${baseUrl}/relay`, {
    body,
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  return {
    body: await parseResponseBody(response),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
}

function createLargeRequestPrefix(poolAddress: string): string {
  const payloadPrefix = JSON.stringify({
    payload: {
      fee: 10_000,
      nullifierHash: "11".repeat(32),
      pool: poolAddress,
      proof: "",
      recipient: Keypair.generate().publicKey.toBase58(),
      root: "22".repeat(32),
    },
    sessionPubkey: Keypair.generate().publicKey.toBase58(),
    signature: "1111111111111111111111111111111111111111111111111111111111111111",
    timestamp: Date.now(),
  });

  const marker = '"proof":"';
  const markerIndex = payloadPrefix.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("Failed to build large payload prefix");
  }

  return payloadPrefix.slice(0, markerIndex + marker.length);
}

async function postLargeProofRequest(
  baseUrl: string,
  prefix: string,
  proofBytes: number,
): Promise<RelayResponse> {
  const target = new URL(`${baseUrl}/relay`);
  const suffix =
    '","recipient":"' +
    Keypair.generate().publicKey.toBase58() +
    '","root":"' +
    "22".repeat(32) +
    '"},"sessionPubkey":"' +
    Keypair.generate().publicKey.toBase58() +
    '","signature":"' +
    "11".repeat(64) +
    `","timestamp":${Date.now()}}`;
  return new Promise<RelayResponse>((resolve, reject) => {
    let resolved = false;
    let responseReceived = false;
    let proofHexRemaining = proofBytes * 2;
    const proofChunk = "aa".repeat(32 * 1024);
    const request = http.request(
      {
        headers: {
          "content-type": "application/json",
        },
        host: target.hostname,
        method: "POST",
        path: target.pathname,
        port: Number(target.port),
      },
      (response) => {
        responseReceived = true;
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            body,
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );

    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }

      request.destroy(new Error("Large proof request timed out"));
    }, 30_000);

    request.on("error", (error) => {
      if (resolved) {
        return;
      }

      clearTimeout(timeout);
      reject(error);
    });

    request.write(prefix);

    const writeChunk = () => {
      if (responseReceived) {
        request.end();
        return;
      }

      if (proofHexRemaining <= 0) {
        request.end(suffix);
        return;
      }

      const chunk = proofChunk.slice(0, Math.min(proofChunk.length, proofHexRemaining));
      proofHexRemaining -= chunk.length;
      request.write(chunk);
      setImmediate(writeChunk);
    };

    writeChunk();
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function mutateHex(hex: string): string {
  const index = Math.max(0, hex.length - 2);
  const byte = hex.slice(index);
  const mutated = byte.toLowerCase() === "ff" ? "00" : "ff";
  return `${hex.slice(0, index)}${mutated}`;
}

async function onceListening(server: http.Server): Promise<void> {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
  });
}
