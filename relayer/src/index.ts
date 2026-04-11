import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig, loadKeypairFromFile } from "./config";
import {
  createHealthHandler,
  createInfoHandler,
  createMetricsHandler,
  createRelayHandler,
  createStatsHandler,
} from "./relay-handler";
import { RelayerMetrics } from "./metrics";
import { RateLimiter } from "./rate-limiter";
import { RetryManager } from "./retry";
import { ProductionRelayService, type RelayService } from "./service";
import { RelayStore } from "./store";
import {
  AnchorRelayerRuntime,
} from "./tx-builder";

export function createRelayerApp(service: RelayService): Express {
  const app = express();
  app.use(express.json());
  app.post("/relay", createRelayHandler(service));
  app.get("/health", createHealthHandler(service));
  app.get("/info", createInfoHandler(service));
  app.get("/metrics", createMetricsHandler(service));
  app.get("/stats", createStatsHandler(service));
  app.use(jsonSyntaxErrorHandler);
  return app;
}

export async function startRelayerServer() {
  const config = loadConfig();
  const relayerKeypair = loadKeypairFromFile(config.keypairPath);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const runtime = new AnchorRelayerRuntime(
    connection,
    relayerKeypair,
    new PublicKey(config.programId),
  );
  const metrics = new RelayerMetrics();
  const store = new RelayStore(config.dbPath);
  const rateLimiter = new RateLimiter({
    store,
    maxRequestsPerMinutePerIp: config.maxRequestsPerMinutePerIp,
    maxRequestsPerMinuteGlobal: config.maxRequestsPerMinuteGlobal,
  });
  const service = new ProductionRelayService({
    config,
    metrics,
    rateLimiter,
    runtime,
    store,
  });
  const retryManager = new RetryManager(store, {
    processor: async (record) => {
      await service.processRecord(record);
    },
  });
  retryManager.start();

  const app = createRelayerApp(service);
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `SNAP relayer listening on http://${config.host}:${config.port} as ${relayerKeypair.publicKey.toBase58()}`,
    );
  });
  server.on("close", () => retryManager.stop());

  return { app, server, config, retryManager, service, store };
}

function jsonSyntaxErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (error instanceof SyntaxError) {
    res.status(400).json({
      success: false,
      error: "Request body must be valid JSON",
    });
    return;
  }

  next(error);
}

if (require.main === module) {
  void startRelayerServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
