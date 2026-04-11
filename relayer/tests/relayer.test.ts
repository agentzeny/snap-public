import fs from "fs";
import os from "os";
import path from "path";
import { expect } from "chai";
import request from "supertest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createNote, bytesToHex } from "../../sdk-package/src/commitment";
import { generateWithdrawProof } from "../../sdk-package/src/proof";
import { signRelayerWithdrawRequest } from "../../sdk-package/src/relayer-auth";
import { createRelayerApp } from "../src";
import { RelayerMetrics } from "../src/metrics";
import { RateLimiter } from "../src/rate-limiter";
import { RetryManager } from "../src/retry";
import { ProductionRelayService } from "../src/service";
import { RelayStore } from "../src/store";
import type { RelayerConfig } from "../src/config";
import { AmbiguousSubmissionError } from "../src/tx-builder";
import type { ParsedRelayRequest } from "../src/types";
import type {
  PoolAccountState,
  RelayTransactionStatus,
  RelayerRuntime,
  SubmittedRelayTransaction,
} from "../src/tx-builder";

interface ProofFixture {
  nullifierHash: string;
  proof: string;
  recipient: string;
  root: string;
  roots: Uint8Array[];
  treeDepth: number;
}

interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
  onSleep(hook: (() => void) | null): void;
}

interface SubmitPlan {
  error?: Error;
  lastValidBlockHeight?: number;
  resolvedNullifierSpendSignature?: string;
  statuses?: RelayTransactionStatus[];
  txSignature?: string;
}

class MockRuntime implements RelayerRuntime {
  readonly relayer = Keypair.generate();
  readonly resolvedSpendSignatures = new Map<string, string>();
  readonly submittedNullifiers = new Map<string, string>();
  readonly statusQueues = new Map<string, RelayTransactionStatus[]>();
  readonly chainNullifiers = new Set<string>();
  balanceLamports = 2 * LAMPORTS_PER_SOL;
  currentBlockHeight = 100;
  submitCalls = 0;

  constructor(
    readonly poolState: PoolAccountState,
    private readonly submitPlans: SubmitPlan[] = [],
    private readonly statusErrors: Error[] = [],
  ) {}

  async fetchPoolState(): Promise<PoolAccountState> {
    return {
      ...this.poolState,
      usedNullifiers: [
        ...this.poolState.usedNullifiers,
        ...Array.from(this.chainNullifiers, (value) =>
          Uint8Array.from(Buffer.from(value, "hex")),
        ),
      ],
    };
  }

  async findNullifierSpendSignature(
    _pool: PublicKey,
    _poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<string | null> {
    return this.resolvedSpendSignatures.get(Buffer.from(nullifierHash).toString("hex")) ?? null;
  }

  async isNullifierUsed(
    _pool: PublicKey,
    poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<boolean> {
    const encoded = Buffer.from(nullifierHash).toString("hex");
    return (
      this.chainNullifiers.has(encoded) ||
      poolState.usedNullifiers.some((value) =>
        Buffer.from(value).equals(Buffer.from(nullifierHash)),
      )
    );
  }

  async submitRelayedWithdraw(args: {
    feeAmountRaw: number;
    nullifierHashBytes: number[];
  }): Promise<SubmittedRelayTransaction> {
    this.submitCalls += 1;
    const plan = this.submitPlans.shift() ?? {};
    const ambiguousError =
      plan.error instanceof AmbiguousSubmissionError ? plan.error : null;
    const nullifier = Buffer.from(args.nullifierHashBytes).toString("hex");
    const txSignature =
      ambiguousError?.txSignature ?? plan.txSignature ?? `mock-relayed-signature-${this.submitCalls}`;
    const lastValidBlockHeight =
      ambiguousError?.lastValidBlockHeight ??
      plan.lastValidBlockHeight ??
      this.currentBlockHeight + 5;
    const statuses = plan.statuses ?? [
      {
        confirmationStatus: "confirmed",
        err: null,
        found: true,
      },
    ];

    this.statusQueues.set(txSignature, [...statuses]);
    this.submittedNullifiers.set(txSignature, nullifier);
    this.balanceLamports += args.feeAmountRaw;

    if (plan.resolvedNullifierSpendSignature) {
      this.chainNullifiers.add(nullifier);
      this.resolvedSpendSignatures.set(
        nullifier,
        plan.resolvedNullifierSpendSignature,
      );
    }

    if (ambiguousError) {
      throw ambiguousError;
    }

    if (plan.error) {
      throw plan.error;
    }

    return {
      txSignature,
      lastValidBlockHeight,
    };
  }

  async getSignatureStatus(txSignature: string): Promise<RelayTransactionStatus> {
    const statusError = this.statusErrors.shift();
    if (statusError) {
      throw statusError;
    }

    const queue = this.statusQueues.get(txSignature);
    if (!queue || queue.length === 0) {
      return {
        confirmationStatus: null,
        err: null,
        found: false,
      };
    }

    const status = queue.length > 1 ? queue.shift()! : queue[0];
    if (
      status.found &&
      !status.err &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      const nullifier = this.submittedNullifiers.get(txSignature);
      if (nullifier) {
        this.chainNullifiers.add(nullifier);
      }
    }

    return status;
  }

  async getCurrentBlockHeight(): Promise<number> {
    return this.currentBlockHeight;
  }

  async getRelayerBalance(): Promise<number> {
    return this.balanceLamports;
  }

  getRelayerPublicKey(): PublicKey {
    return this.relayer.publicKey;
  }

  advanceBlockHeight(delta = 1): void {
    this.currentBlockHeight += delta;
  }
}

let tempDir: string;
let validProofFixture: ProofFixture;

describe("SNAP Relayer", function () {
  this.timeout(120000);

  before(async () => {
    validProofFixture = await createProofFixture();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-relayer-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a valid request only after off-chain proof verification succeeds", async () => {
    const fixture = createFixture({
      poolState: createPoolState(validProofFixture),
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }, validProofFixture));

    expect(response.status).to.equal(200);
    expect(response.body.success).to.equal(true);
    expect(response.body.txSignature).to.equal("mock-relayed-signature-1");
    expect(fixture.runtime.submitCalls).to.equal(1);
  });

  it("rejects a tampered signed request", async () => {
    const fixture = createFixture();
    const app = createRelayerApp(fixture.service);
    const signed = createSignedRequest({ pool: fixture.config.poolAddress });
    signed.payload.recipient = Keypair.generate().publicKey.toBase58();

    const response = await request(app).post("/relay").send(signed);

    expect(response.status).to.equal(400);
    expect(response.body.success).to.equal(false);
    expect(response.body.error).to.equal("Request signature verification failed");
    expect(fixture.runtime.submitCalls).to.equal(0);
  });

  it("rejects an expired signed request", async () => {
    const fixture = createFixture();
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(
        createSignedRequest(
          {
            pool: fixture.config.poolAddress,
            timestamp: Date.now() - 61_000,
          },
          validProofFixture,
        ),
      );

    expect(response.status).to.equal(401);
    expect(response.body.success).to.equal(false);
    expect(response.body.error).to.equal("Request signature expired");
    expect(fixture.runtime.submitCalls).to.equal(0);
  });

  it("rejects an invalid proof before transaction submission", async () => {
    const fixture = createFixture({
      poolState: createPoolState(validProofFixture),
    });
    const app = createRelayerApp(fixture.service);
    const invalidProof = mutateHex(validProofFixture.proof);

    const response = await request(app)
      .post("/relay")
      .send(
        createSignedRequest(
          {
            pool: fixture.config.poolAddress,
            proof: invalidProof,
          },
          validProofFixture,
        ),
      );

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Withdrawal proof verification failed");
    expect(fixture.runtime.submitCalls).to.equal(0);
  });

  it("rejects random signed junk before transaction submission", async () => {
    const junkRoot = "aa".repeat(32);
    const fixture = createFixture({
      poolState: {
        ...createPoolState(validProofFixture),
        roots: [Uint8Array.from(Buffer.from(junkRoot, "hex"))],
      },
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(
        createSignedRequest(
          {
            pool: fixture.config.poolAddress,
            proof: "ab".repeat(256),
            root: junkRoot,
            nullifierHash: "cc".repeat(32),
          },
          validProofFixture,
        ),
      );

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Withdrawal proof verification failed");
    expect(fixture.runtime.submitCalls).to.equal(0);
  });

  it("rejects replayed nullifier submissions", async () => {
    const fixture = createFixture();
    const app = createRelayerApp(fixture.service);
    const signed = createSignedRequest({ pool: fixture.config.poolAddress });

    const first = await request(app).post("/relay").send(signed);
    const second = await request(app).post("/relay").send(signed);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(409);
    expect(second.body.error).to.equal("Nullifier already submitted to this relayer");
  });

  it("rejects excess simultaneous burst requests with 429 and retry-after headers", async () => {
    const fixture = createFixture({
      proofVerifier: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const app = createRelayerApp(fixture.service);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request(app)
          .post("/relay")
          .send(
            createSignedRequest(
              {
                pool: fixture.config.poolAddress,
                nullifierHash: `${(index + 1).toString(16).padStart(2, "0")}`.repeat(32),
              },
              validProofFixture,
            ),
          ),
      ),
    );

    const accepted = responses.filter((response) => response.status === 200);
    const rateLimited = responses.filter((response) => response.status === 429);

    expect(accepted).to.have.length(10);
    expect(rateLimited).to.have.length(2);
    expect(fixture.runtime.submitCalls).to.equal(10);

    for (const response of rateLimited) {
      expect(response.body.error).to.equal("Rate limit exceeded");
      expect(Number(response.headers["retry-after"])).to.be.greaterThan(0);
    }
  });

  it("waits for real confirmation state before returning success", async () => {
    const fixture = createFixture({
      submitPlans: [
        {
          statuses: [
            { confirmationStatus: "processed", err: null, found: true },
            { confirmationStatus: "confirmed", err: null, found: true },
          ],
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal("mock-relayed-signature-1");
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(fixture.store.getStats(0).confirmed).to.equal(1);
  });

  it("retries a dropped submission with a fresh attempt", async () => {
    const fixture = createFixture({
      submitPlans: [
        {
          error: new Error("RPC send failed"),
        },
        {
          txSignature: "mock-relayed-signature-2",
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal("mock-relayed-signature-2");
    expect(fixture.runtime.submitCalls).to.equal(2);
  });

  it("tracks an ambiguous send as submitted work and confirms it by signature", async () => {
    const txSignature = "ambiguous-send-signature";
    const fixture = createFixture({
      submitPlans: [
        {
          error: new AmbiguousSubmissionError(
            "RPC connection closed after send",
            txSignature,
            105,
          ),
          statuses: [
            { confirmationStatus: null, err: null, found: false },
            { confirmationStatus: "confirmed", err: null, found: true },
          ],
          txSignature,
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal(txSignature);
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.status).to.equal(
      "confirmed",
    );
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.txSignature).to.equal(
      txSignature,
    );
  });

  it("does not treat a definitive simulation failure as submitted work", async () => {
    const fixture = createFixture({
      submitPlans: [
        {
          error: new Error(
            "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773",
          ),
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(502);
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.status).to.equal(
      "failed",
    );
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.txSignature).to.equal(
      undefined,
    );
  });

  it("recovers a pending duplicate failure when the nullifier is already used on-chain", async () => {
    const txSignature = "recovered-nullifier-signature";
    const fixture = createFixture({
      submitPlans: [
        {
          error: new Error(
            "Simulation failed. Message: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x0. Logs: [\"Allocate: account Address { address: test, base: None } already in use\"]",
          ),
          resolvedNullifierSpendSignature: txSignature,
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal(txSignature);
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.status).to.equal(
      "confirmed",
    );
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.txSignature).to.equal(
      txSignature,
    );
  });

  it("recovers a submitted failure when another relayer tx already spent the note", async () => {
    const recoveredTxSignature = "successful-prior-signature";
    const failedTxSignature = "failed-late-signature";
    const fixture = createFixture({
      submitPlans: [
        {
          resolvedNullifierSpendSignature: recoveredTxSignature,
          statuses: [
            {
              confirmationStatus: "confirmed",
              err: { InstructionError: [1, { Custom: 0 }] },
              found: true,
            },
          ],
          txSignature: failedTxSignature,
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal(recoveredTxSignature);
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.status).to.equal(
      "confirmed",
    );
    expect(fixture.store.getByNullifier(validProofFixture.nullifierHash)?.txSignature).to.equal(
      recoveredTxSignature,
    );
  });

  it("retries when a submitted transaction expires without landing", async () => {
    const fixture = createFixture({
      onSleep: () => {
        fixture.runtime.advanceBlockHeight(1);
      },
      submitPlans: [
        {
          txSignature: "expired-signature",
          lastValidBlockHeight: 100,
          statuses: [
            { confirmationStatus: null, err: null, found: false },
            { confirmationStatus: null, err: null, found: false },
          ],
        },
        {
          txSignature: "replacement-signature",
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal("replacement-signature");
    expect(fixture.runtime.submitCalls).to.equal(2);
  });

  it("treats a submitted request as confirmed when the nullifier is already used after status loss", async () => {
    let markedSpent = false;
    const fixture = createFixture({
      onSleep: () => {
        fixture.runtime.advanceBlockHeight(1);
        if (!markedSpent) {
          fixture.runtime.chainNullifiers.add(validProofFixture.nullifierHash);
          markedSpent = true;
        }
      },
      submitPlans: [
        {
          txSignature: "late-landed-signature",
          lastValidBlockHeight: 100,
          statuses: [
            { confirmationStatus: null, err: null, found: false },
            { confirmationStatus: null, err: null, found: false },
          ],
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal("late-landed-signature");
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(
      fixture.store.getByNullifier(validProofFixture.nullifierHash)?.status,
    ).to.equal("confirmed");
  });

  it("resumes submitted work after a relayer restart", async () => {
    const clock = createClock();
    const dbPath = path.join(tempDir, "restart.sqlite");
    const poolState = createPoolState(validProofFixture);
    const runtime = new MockRuntime(poolState, [
      {
        txSignature: "in-flight-signature",
        statuses: [{ confirmationStatus: "processed", err: null, found: true }],
      },
    ]);
    clock.onSleep(() => {
      runtime.advanceBlockHeight(1);
    });

    const config = createConfig(dbPath);
    const store = new RelayStore(dbPath, clock.now);
    const rateLimiter = new RateLimiter({
      store,
      now: clock.now,
      maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
      maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
    });
    const service = new ProductionRelayService({
      config,
      metrics: new RelayerMetrics(),
      now: clock.now,
      rateLimiter,
      runtime,
      sleep: clock.sleep,
      store,
      proofVerifier: async () => undefined,
      confirmationPollMs: 1,
    });

    const id = store.insert(
      {
        receivedAt: clock.now(),
        pool: config.poolAddress,
        nullifierHash: validProofFixture.nullifierHash,
        fee: 500_000,
        clientIp: "127.0.0.1",
      },
      JSON.stringify(createSignedRequest({ pool: config.poolAddress }, validProofFixture)),
    );

    await service.processRecord(store.get(id)!);
    expect(store.get(id)?.status).to.equal("submitted");

    runtime.statusQueues.set("in-flight-signature", [
      { confirmationStatus: "confirmed", err: null, found: true },
    ]);

    const restartedStore = new RelayStore(dbPath, clock.now);
    const restartedRateLimiter = new RateLimiter({
      store: restartedStore,
      now: clock.now,
      maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
      maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
    });
    const restartedService = new ProductionRelayService({
      config,
      metrics: new RelayerMetrics(),
      now: clock.now,
      rateLimiter: restartedRateLimiter,
      runtime,
      sleep: clock.sleep,
      store: restartedStore,
      proofVerifier: async () => undefined,
      confirmationPollMs: 1,
    });

    await restartedService.processRecord(restartedStore.get(id)!);
    expect(restartedStore.get(id)?.status).to.equal("confirmed");
  });

  it("keeps submitted work alive when status polling fails temporarily", async () => {
    const fixture = createFixture({
      statusErrors: [new Error("RPC status polling unavailable")],
      submitPlans: [
        {
          txSignature: "flaky-status-signature",
          statuses: [{ confirmationStatus: "confirmed", err: null, found: true }],
        },
      ],
    });
    const app = createRelayerApp(fixture.service);

    const response = await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    expect(response.status).to.equal(200);
    expect(response.body.txSignature).to.equal("flaky-status-signature");
    expect(fixture.runtime.submitCalls).to.equal(1);
    expect(
      fixture.store.getByNullifier(validProofFixture.nullifierHash)?.status,
    ).to.equal("confirmed");
  });

  it("persists rate limits across store restarts", () => {
    const clock = createClock();
    const dbPath = path.join(tempDir, "rate-limit.sqlite");
    const firstStore = new RelayStore(dbPath, clock.now);
    firstStore.insert({
      receivedAt: clock.now(),
      pool: Keypair.generate().publicKey.toBase58(),
      nullifierHash: "aa".repeat(32),
      fee: 500_000,
      clientIp: "127.0.0.1",
    });

    const secondStore = new RelayStore(dbPath, clock.now);
    const limiter = new RateLimiter({
      store: secondStore,
      now: clock.now,
      maxRequestsPerMinutePerIp: 1,
      maxRequestsPerMinuteGlobal: 100,
    });

    expect(limiter.check("127.0.0.1").allowed).to.equal(false);
  });

  it("preserves repeated rate-limit accounting across restart", () => {
    const clock = createClock();
    const dbPath = path.join(tempDir, "rate-repeat.sqlite");
    const firstStore = new RelayStore(dbPath, clock.now);

    for (const [index, clientIp] of ["127.0.0.1", "127.0.0.1", "127.0.0.2"].entries()) {
      firstStore.insert({
        receivedAt: clock.now(),
        pool: Keypair.generate().publicKey.toBase58(),
        nullifierHash: `${index + 1}`.repeat(64),
        fee: 500_000,
        clientIp,
      });
    }

    const secondStore = new RelayStore(dbPath, clock.now);
    const perIpLimiter = new RateLimiter({
      store: secondStore,
      now: clock.now,
      maxRequestsPerMinutePerIp: 2,
      maxRequestsPerMinuteGlobal: 10,
    });
    const globalLimiter = new RateLimiter({
      store: secondStore,
      now: clock.now,
      maxRequestsPerMinutePerIp: 10,
      maxRequestsPerMinuteGlobal: 3,
    });

    expect(perIpLimiter.check("127.0.0.1").allowed).to.equal(false);
    expect(globalLimiter.check("127.0.0.9").allowed).to.equal(false);
  });

  it("expires old rate-limit windows and preserves retry-after values", () => {
    const clock = createClock();
    const dbPath = path.join(tempDir, "rate-window.sqlite");
    const store = new RelayStore(dbPath, clock.now);
    const limiter = new RateLimiter({
      store,
      now: clock.now,
      maxRequestsPerMinutePerIp: 1,
      maxRequestsPerMinuteGlobal: 100,
    });

    store.insert({
      receivedAt: clock.now(),
      pool: Keypair.generate().publicKey.toBase58(),
      nullifierHash: "bb".repeat(32),
      fee: 500_000,
      clientIp: "127.0.0.1",
    });

    clock.advance(30_000);
    const limited = limiter.check("127.0.0.1");
    expect(limited.allowed).to.equal(false);
    expect(limited.retryAfter).to.equal(30_000);

    clock.advance(31_000);
    expect(limiter.check("127.0.0.1").allowed).to.equal(true);
  });

  it("drains persisted pending work through the retry manager", async () => {
    const dbPath = path.join(tempDir, "retry.sqlite");
    const store = new RelayStore(dbPath);
    const id = store.insert(
      {
        receivedAt: Date.now(),
        pool: Keypair.generate().publicKey.toBase58(),
        nullifierHash: "dd".repeat(32),
        fee: 500_000,
        clientIp: "127.0.0.1",
      },
      JSON.stringify(createSignedRequest({ pool: Keypair.generate().publicKey.toBase58() })),
    );
    const attemptTimes: number[] = [];

    const manager = new RetryManager(store, {
      pollIntervalMs: 10,
      processor: async (record) => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          store.markFailed(record.id, "boom", Date.now() + 30, false);
          return;
        }

        store.markConfirmed(record.id);
      },
    });

    manager.start();
    await waitFor(() => store.get(id)?.status === "confirmed");
    manager.stop();

    expect(attemptTimes).to.have.length(2);
    expect(attemptTimes[1] - attemptTimes[0]).to.be.greaterThanOrEqual(30);
  });

  it("exposes Prometheus metrics", async () => {
    const fixture = createFixture();
    const app = createRelayerApp(fixture.service);

    await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    const response = await request(app).get("/metrics");

    expect(response.status).to.equal(200);
    expect(response.text).to.include("snap_relay_requests_total{status=\"confirmed\"}");
    expect(response.text).to.include("snap_relay_fees_total");
    expect(response.text).to.include("snap_relay_proof_verify_seconds_bucket");
    expect(response.text).to.include("snap_relayer_balance_lamports");
  });

  it("exposes the full fee picture on /info and split fee totals on /stats", async () => {
    const treasury = Keypair.generate().publicKey;
    const fixture = createFixture({
      poolState: {
        ...createPoolState(validProofFixture),
        kind: "feeV2",
        feeCapable: true,
        protocolFeeBps: 250,
        treasury,
      },
    });
    const app = createRelayerApp(fixture.service);

    await request(app)
      .post("/relay")
      .send(createSignedRequest({ pool: fixture.config.poolAddress }));

    const infoResponse = await request(app).get("/info");
    expect(infoResponse.status).to.equal(200);
    expect(infoResponse.body.protocolFeeBps).to.equal(250);
    expect(infoResponse.body.relayerFeeBps).to.equal(50);
    expect(infoResponse.body.totalFeeBps).to.equal(300);
    expect(infoResponse.body.poolDenomination).to.equal(100_000_000);
    expect(infoResponse.body.estimatedRecipientLamports).to.equal(97_000_000);
    expect(infoResponse.body.treasury).to.equal(treasury.toBase58());

    const statsResponse = await request(app).get("/stats");
    expect(statsResponse.status).to.equal(200);
    expect(statsResponse.body.last24h.total).to.equal(1);
    expect(statsResponse.body.last24h.confirmed).to.equal(1);
    expect(statsResponse.body.last24h.protocolFeesCollected).to.equal(2_500_000);
    expect(statsResponse.body.last24h.relayerFeesCollected).to.equal(500_000);
    expect(statsResponse.body.last24h.fees).to.equal(3_000_000);
  });
});

function createFixture(options: {
  onSleep?: () => void;
  poolState?: PoolAccountState;
  proofVerifier?: (
    parsed: ParsedRelayRequest,
    poolState: PoolAccountState,
  ) => Promise<void>;
  statusErrors?: Error[];
  submitPlans?: SubmitPlan[];
} = {}) {
  const clock = createClock();
  const runtime = new MockRuntime(
    options.poolState ?? createPoolState(validProofFixture),
    options.submitPlans,
    options.statusErrors,
  );
  const dbPath = path.join(tempDir, `${Math.random()}.sqlite`);
  const config = createConfig(dbPath);
  const store = new RelayStore(dbPath, clock.now);
  const rateLimiter = new RateLimiter({
    store,
    now: clock.now,
    maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
    maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
  });

  if (options.onSleep) {
    clock.onSleep(options.onSleep);
  }

  const service = new ProductionRelayService({
    config,
    metrics: new RelayerMetrics(),
    now: clock.now,
    rateLimiter,
    runtime,
    sleep: clock.sleep,
    store,
    confirmationPollMs: 1,
    proofVerifier: options.proofVerifier,
  });

  return { config, clock, runtime, service, store };
}

function createConfig(
  dbPath: string,
  overrides: Partial<RelayerConfig> = {},
): RelayerConfig {
  return {
    rpcUrl: "http://127.0.0.1:8899",
    cluster: "devnet",
    keypairPath: "relayer-keypair.json",
    poolAddress: Keypair.generate().publicKey.toBase58(),
    programId: Keypair.generate().publicKey.toBase58(),
    feeBps: 50,
    minFeeLamports: 10_000,
    maxRequestsPerMinutePerIp: 10,
    maxRequestsPerMinuteGlobal: 100,
    maxRetries: 3,
    retryBackoffMs: [25, 50, 100],
    port: 3000,
    host: "127.0.0.1",
    dbPath,
    ...overrides,
  };
}

function createPoolState(proofFixture: ProofFixture): PoolAccountState {
  return {
    kind: "v2",
    depositAmountRaw: 100_000_000,
    roots: proofFixture.roots,
    treeDepth: proofFixture.treeDepth,
    usedNullifiers: [],
    tokenMint: null,
    tokenDecimals: null,
    nullifierVersion: 1,
    assetType: "sol",
    feeCapable: false,
    protocolFeeBps: 0,
    treasury: null,
  };
}

function createSignedRequest(
  options: {
    fee?: number;
    nullifierHash?: string;
    pool: string;
    proof?: string;
    recipient?: string;
    root?: string;
    timestamp?: number;
  },
  proofFixture: ProofFixture = validProofFixture,
) {
  return signRelayerWithdrawRequest(
    {
      pool: options.pool,
      proof: options.proof ?? proofFixture.proof,
      root: options.root ?? proofFixture.root,
      nullifierHash: options.nullifierHash ?? proofFixture.nullifierHash,
      recipient: options.recipient ?? proofFixture.recipient,
      fee: options.fee ?? 500_000,
    },
    Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1)),
    options.timestamp,
  );
}

async function createProofFixture(): Promise<ProofFixture> {
  const pool = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const note = await createNote(pool, 0);
  const proof = await generateWithdrawProof(
    note,
    [note.commitment],
    recipient,
    120000,
    10,
  );

  return {
    nullifierHash: bytesToHex(Uint8Array.from(proof.nullifierHashBytes)),
    proof: bytesToHex(
      Uint8Array.from([
        ...proof.proofABytes,
        ...proof.proofBBytes,
        ...proof.proofCBytes,
      ]),
    ),
    recipient: recipient.toBase58(),
    root: bytesToHex(Uint8Array.from(proof.rootBytes)),
    roots: [Uint8Array.from(proof.rootBytes)],
    treeDepth: 10,
  };
}

function createClock(start = Date.now()): Clock {
  let current = start;
  let sleepHook: (() => void) | null = null;

  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
      sleepHook?.();
    },
    advance: (ms: number) => {
      current += ms;
    },
    onSleep: (hook: (() => void) | null) => {
      sleepHook = hook;
    },
  };
}

function mutateHex(value: string): string {
  const replacement = value.startsWith("0") ? "1" : "0";
  return `${replacement}${value.slice(1)}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for retry manager");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
