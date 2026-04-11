import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SNAPClient, SNAP_PROGRAM_ID } from "../sdk-package/src";
import { bytesToHex } from "../sdk-package/src/commitment";
import { generateWithdrawProof } from "../sdk-package/src/proof";
import { signRelayerWithdrawRequest } from "../sdk-package/src/relayer-auth";
import { createRelayerApp } from "../relayer/src";
import { RelayerMetrics } from "../relayer/src/metrics";
import { RateLimiter } from "../relayer/src/rate-limiter";
import { RetryManager } from "../relayer/src/retry";
import { ProductionRelayService } from "../relayer/src/service";
import { RelayStore } from "../relayer/src/store";
import type { RelayerConfig } from "../relayer/src/config";
import { AnchorRelayerRuntime } from "../relayer/src/tx-builder";
import { inspectPool, type MonitorConfig, type MonitorEvent } from "../scripts/monitor";
import { fundSystemAccount } from "./helpers";

interface RelayerHarness {
  baseUrl: string;
  config: RelayerConfig;
  retryManager: RetryManager;
  server: http.Server;
  service: ProductionRelayService;
  store: RelayStore;
}

describe("Relayer localnet E2E", function () {
  this.timeout(180000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const relayer = Keypair.generate();
  const connection = provider.connection;
  const snap = new SNAPClient(connection, payer);

  let dbPath: string;
  let harness: RelayerHarness;
  let pool: PublicKey;

  before(async () => {
    await fundSystemAccount(provider, relayer.publicKey, 2_000_000_000);
  });

  beforeEach(async () => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "snap-relayer-e2e-")),
      "relayer.sqlite",
    );
    pool = await snap.createPool(0.1, { treeDepth: 10 });
    harness = await startRelayerHarness(connection, relayer, pool, dbPath);
  });

  afterEach(async () => {
    await stopRelayerHarness(harness);
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("handles deposit, relayed withdrawal, duplicate nullifier rejection, and monitor events", async () => {
    const snapshots = new Map<string, any>();
    const events: MonitorEvent[] = [];
    const monitorConfig = createMonitorConfig(relayer.publicKey.toBase58(), pool.toBase58());

    await inspectPool(
      connection,
      snap,
      pool.toBase58(),
      snapshots,
      monitorConfig,
      async (event) => {
        events.push(event);
      },
    );

    const note = await snap.deposit(pool, 0.1);
    await inspectPool(
      connection,
      snap,
      pool.toBase58(),
      snapshots,
      monitorConfig,
      async (event) => {
        events.push(event);
      },
    );

    const recipient = Keypair.generate();
    const withdrawal = await snap.withdrawViaRelayer(
      pool,
      note,
      recipient.publicKey,
      harness.baseUrl,
    );
    expect(withdrawal.txSignature).to.be.a("string");

    await inspectPool(
      connection,
      snap,
      pool.toBase58(),
      snapshots,
      monitorConfig,
      async (event) => {
        events.push(event);
      },
    );

    const signedRequest = await createSignedRelayRequest(
      snap,
      payer,
      pool,
      note,
      recipient.publicKey,
      harness.config,
    );
    const first = await postRelay(harness.baseUrl, signedRequest);
    const second = await postRelay(harness.baseUrl, signedRequest);

    expect(first.status).to.equal(409);
    expect(second.status).to.equal(409);
    expect(String(first.body.error)).to.include("Nullifier");

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).to.include("deposit");
    expect(eventTypes).to.include("withdrawal");
    expect(eventTypes).to.include("balance_change");
  });

  it("resumes an in-flight submitted withdrawal after relayer restart", async () => {
    const note = await snap.deposit(pool, 0.1);
    const recipient = Keypair.generate();
    const signedRequest = await createSignedRelayRequest(
      snap,
      payer,
      pool,
      note,
      recipient.publicKey,
      harness.config,
    );
    const parsedNullifier = Buffer.from(
      signedRequest.payload.nullifierHash,
      "hex",
    ).toString("hex");

    const id = harness.store.insert(
      {
        receivedAt: Date.now(),
        pool: pool.toBase58(),
        nullifierHash: parsedNullifier,
        fee: signedRequest.payload.fee,
        clientIp: "127.0.0.1",
      },
      JSON.stringify(signedRequest),
    );

    await harness.service.processRecord(harness.store.get(id)!);
    expect(harness.store.get(id)?.status).to.equal("submitted");

    await stopRelayerHarness(harness);
    harness = await startRelayerHarness(connection, relayer, pool, dbPath);

    await waitFor(async () => harness.store.get(id)?.status === "confirmed", 20000);
    expect(harness.store.get(id)?.status).to.equal("confirmed");
  });

  it("preserves repeated confirmed relay history across a relayer restart", async () => {
    const noteOne = await snap.deposit(pool, 0.1);
    const noteTwo = await snap.deposit(pool, 0.1);

    const firstResult = await snap.withdrawViaRelayer(
      pool,
      noteOne,
      Keypair.generate().publicKey,
      harness.baseUrl,
    );
    expect(firstResult.txSignature).to.be.a("string");
    expect(harness.store.getStats(0).confirmed).to.equal(1);

    await stopRelayerHarness(harness);
    harness = await startRelayerHarness(connection, relayer, pool, dbPath);

    const secondResult = await snap.withdrawViaRelayer(
      pool,
      noteTwo,
      Keypair.generate().publicKey,
      harness.baseUrl,
    );
    expect(secondResult.txSignature).to.be.a("string");

    const statsResponse = await fetch(`${harness.baseUrl}/stats`);
    const stats = (await statsResponse.json()) as {
      last24h: {
        confirmed: number;
        failed: number;
        total: number;
      };
    };

    expect(stats.last24h.total).to.equal(2);
    expect(stats.last24h.confirmed).to.equal(2);
    expect(stats.last24h.failed).to.equal(0);
    expect(harness.store.getStats(0).confirmed).to.equal(2);
    expect(harness.store.getStats(0).pending).to.equal(0);
  });
});

async function startRelayerHarness(
  connection: anchor.web3.Connection,
  relayer: Keypair,
  pool: PublicKey,
  dbPath: string,
): Promise<RelayerHarness> {
  const config: RelayerConfig = {
    rpcUrl: "http://127.0.0.1:8899",
    cluster: "localnet",
    keypairPath: path.join(path.dirname(dbPath), "relayer.json"),
    poolAddress: pool.toBase58(),
    programId: SNAP_PROGRAM_ID.toBase58(),
    feeBps: 50,
    minFeeLamports: 10_000,
    maxRequestsPerMinutePerIp: 50,
    maxRequestsPerMinuteGlobal: 500,
    maxRetries: 3,
    retryBackoffMs: [100, 250, 500],
    port: 0,
    host: "127.0.0.1",
    dbPath,
  };

  const runtime = new AnchorRelayerRuntime(connection, relayer, SNAP_PROGRAM_ID);
  const store = new RelayStore(dbPath);
  const rateLimiter = new RateLimiter({
    store,
    maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
    maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
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
    retryManager,
    server,
    service,
    store,
  };
}

async function stopRelayerHarness(harness: RelayerHarness | undefined): Promise<void> {
  if (!harness) {
    return;
  }

  harness.retryManager.stop();
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

async function createSignedRelayRequest(
  snap: SNAPClient,
  payer: Keypair,
  pool: PublicKey,
  note: Awaited<ReturnType<SNAPClient["deposit"]>>,
  recipient: PublicKey,
  config: RelayerConfig,
) {
  const poolState = await (snap as any).fetchPoolState(pool);
  const proof = await generateWithdrawProof(
    note,
    poolState.commitments,
    recipient,
    120000,
    poolState.treeDepth,
  );
  const fee = Math.max(
    Math.floor((poolState.depositAmountRaw * config.feeBps) / 10_000),
    config.minFeeLamports,
  );

  return signRelayerWithdrawRequest(
    {
      pool: pool.toBase58(),
      proof: bytesToHex(
        Uint8Array.from([
          ...proof.proofABytes,
          ...proof.proofBBytes,
          ...proof.proofCBytes,
        ]),
      ),
      root: bytesToHex(Uint8Array.from(proof.rootBytes)),
      nullifierHash: bytesToHex(Uint8Array.from(proof.nullifierHashBytes)),
      recipient: recipient.toBase58(),
      fee,
    },
    payer.secretKey.slice(0, 32),
  );
}

function createMonitorConfig(relayerAddress: string, poolAddress: string): MonitorConfig {
  return {
    pools: [poolAddress],
    relayerAddress,
    pollIntervalMs: 1000,
    alerts: {
      webhookUrl: "",
      emailTo: "",
      thresholds: {
        depositsPerFiveMinutes: 999,
        withdrawalsPerMinute: 999,
        relayerBalanceWarning: 1,
        relayerBalanceCritical: 1,
      },
    },
  };
}

async function postRelay(baseUrl: string, payload: unknown) {
  const response = await fetch(`${baseUrl}/relay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function onceListening(server: http.Server): Promise<void> {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    if (await predicate()) {
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for localnet relayer condition");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}
