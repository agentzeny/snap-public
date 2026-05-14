#!/usr/bin/env -S npx tsx

/**
 * SNAP Devnet Health Check
 * Verifies the live program and pool are reachable on Solana devnet.
 */

import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("9uePoqdgaXpqFLQM2ED1GGQrwSEiqe3r6tW1AfsnrrbS");
const DEVNET_POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const TIMEOUT_MS = 4_500;

function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    }),
  ]);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  console.log("SNAP Devnet Health Check\n");
  console.log("Program ID:", PROGRAM_ID.toBase58());
  console.log("Pool:      ", DEVNET_POOL.toBase58());
  console.log("");

  const [programInfo, poolInfo, latestBlockhash] = await Promise.all([
    withTimeout(
      "Program account lookup",
      connection.getAccountInfo(PROGRAM_ID),
    ),
    withTimeout("Pool account lookup", connection.getAccountInfo(DEVNET_POOL)),
    withTimeout("Devnet blockhash lookup", connection.getLatestBlockhash()),
  ]);

  if (!programInfo) {
    throw new Error(
      `Program not found at ${PROGRAM_ID.toBase58()}. Confirm the Phase 4 deploy coordinates and Solana devnet RPC availability.`,
    );
  }

  if (programInfo.executable) {
    console.log("[OK] Program account exists and is executable");
  } else {
    console.log(
      `[OK] Program account exists (${programInfo.data.length} bytes)`,
    );
  }

  if (!poolInfo) {
    throw new Error(
      `Pool not found at ${DEVNET_POOL.toBase58()}. Confirm devnet-pool.json matches the live deployment.`,
    );
  }

  console.log(`[OK] Pool account exists (${poolInfo.data.length} bytes)`);

  if (poolInfo.owner.equals(PROGRAM_ID)) {
    console.log("[OK] Pool is owned by the SNAP program");
  } else {
    throw new Error(
      `Pool owner mismatch: expected ${PROGRAM_ID.toBase58()}, got ${poolInfo.owner.toBase58()}`,
    );
  }

  console.log(
    `[OK] Devnet connected (blockhash: ${latestBlockhash.blockhash.slice(0, 16)}...)`,
  );

  const elapsedMs = Date.now() - startedAt;
  console.log(`[OK] Completed in ${elapsedMs} ms`);
  console.log("\nAll checks passed. SNAP is live on devnet.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error("[FAIL] Health check error:", message);

  if (/timed out|fetch failed|ECONN|429/i.test(message)) {
    console.error(
      "       Retry against Solana devnet or set a healthier RPC endpoint in your Solana config.",
    );
  }

  if (/Program not found/i.test(message)) {
    console.error(
      `       Inspect the program account directly: solana account ${PROGRAM_ID.toBase58()} --url devnet`,
    );
  }

  if (/Pool not found|Pool owner mismatch/i.test(message)) {
    console.error(
      `       Inspect the pool account directly: solana account ${DEVNET_POOL.toBase58()} --url devnet`,
    );
  }

  process.exit(1);
});
