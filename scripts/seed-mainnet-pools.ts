import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

const ROOT_DIR = process.cwd();
const SDK_DIST = path.resolve(ROOT_DIR, "sdk-package", "dist");
const WALLET_PATH = path.join(
  process.env.HOME ?? "",
  ".config",
  "solana",
  "id.json"
);
const POOLS_PATH = path.join(ROOT_DIR, "mainnet-pools.json");
const SEED_NOTES_DIR = path.join(ROOT_DIR, "mainnet-seed-notes");

const DEFAULT_SEED_COUNT = 25;
const MIN_DELAY_MS = 3_000;
const MAX_DELAY_MS = 15_000;
const SOL_GAS_BUFFER = 0.02 * LAMPORTS_PER_SOL;

function fail(message: string): never {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function loadWallet(): Keypair {
  if (!existsSync(WALLET_PATH)) {
    fail(`Solana wallet not found at ${WALLET_PATH}`);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8")))
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    fail(`${name} environment variable is required but not set.`);
  }
  return value.trim();
}

function deriveEncryptionKey(passphrase: string): Uint8Array {
  return createHash("sha256").update(passphrase).digest();
}

function encryptJournal(data: string, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(Buffer.from(data, "utf8"));
  const out = new Uint8Array(24 + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, 24);
  return out;
}

function randomDelay(): Promise<void> {
  const arr = new Uint32Array(1);
  globalThis.crypto.getRandomValues(arr);
  const ms = MIN_DELAY_MS + (arr[0] % (MAX_DELAY_MS - MIN_DELAY_MS));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface PoolConfig {
  address: string;
  denomination: number;
  denominationHuman: string;
  asset: "SOL" | "USDC";
  tokenMint: string | null;
}

interface SerializedNote {
  secret: string;
  nullifier: string;
  commitment: string;
  nullifierHash: string;
  depositIndex: number;
  poolAddress: string;
  tempWallet: string;
  depositedAt: string;
}

async function seedPool(
  connection: Connection,
  deployer: Keypair,
  pool: PoolConfig,
  seedCount: number,
  encryptionKey: Uint8Array,
  SNAPClient: any
): Promise<{ deposited: number; totalSpent: number }> {
  const poolPubkey = new PublicKey(pool.address);
  const journalPath = path.join(SEED_NOTES_DIR, `${pool.address}.json.enc`);

  const notes: SerializedNote[] = [];
  let totalSpent = 0;

  const snap = new SNAPClient(connection, deployer);

  for (let i = 0; i < seedCount; i++) {
    const tempWallet = Keypair.generate();

    const fundAmount =
      pool.asset === "SOL"
        ? pool.denomination + SOL_GAS_BUFFER
        : SOL_GAS_BUFFER * 2;

    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: tempWallet.publicKey,
        lamports: Math.ceil(fundAmount),
      })
    );

    if (pool.asset === "USDC" && pool.tokenMint) {
      const mint = new PublicKey(pool.tokenMint);
      const deployerAta = getAssociatedTokenAddressSync(
        mint,
        deployer.publicKey
      );
      const tempAta = getAssociatedTokenAddressSync(
        mint,
        tempWallet.publicKey
      );

      fundTx.add(
        createAssociatedTokenAccountInstruction(
          deployer.publicKey,
          tempAta,
          tempWallet.publicKey,
          mint
        ),
        createTransferInstruction(
          deployerAta,
          tempAta,
          deployer.publicKey,
          pool.denomination
        )
      );
    }

    await connection.sendTransaction(fundTx, [deployer], {
      skipPreflight: false,
    });
    await new Promise((r) => setTimeout(r, 1500));

    const tempSnap = new SNAPClient(connection, tempWallet);
    const result = await tempSnap.deposit(poolPubkey);

    const serialized: SerializedNote = {
      secret: result.secret.toString(),
      nullifier: result.nullifier.toString(),
      commitment: Buffer.from(result.commitment).toString("hex"),
      nullifierHash: Buffer.from(result.nullifierHash).toString("hex"),
      depositIndex: result.depositIndex,
      poolAddress: result.poolAddress,
      tempWallet: Buffer.from(tempWallet.secretKey).toString("hex"),
      depositedAt: new Date().toISOString(),
    };

    notes.push(serialized);

    const encrypted = encryptJournal(JSON.stringify(notes, null, 2), encryptionKey);
    writeFileSync(journalPath, encrypted);

    totalSpent += pool.denomination + SOL_GAS_BUFFER;

    console.log(
      `  [${i + 1}/${seedCount}] Deposited into ${pool.denominationHuman} pool (index ${result.depositIndex})`
    );

    try {
      const tempBalance = await connection.getBalance(tempWallet.publicKey);
      if (tempBalance > 5000) {
        const drainTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: tempWallet.publicKey,
            toPubkey: deployer.publicKey,
            lamports: tempBalance - 5000,
          })
        );
        await connection.sendTransaction(drainTx, [tempWallet]);
      }
    } catch {
      // non-critical — gas dust left in temp wallet
    }

    if (i < seedCount - 1) {
      await randomDelay();
    }
  }

  return { deposited: notes.length, totalSpent };
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SNAP_RPC_URL");
  const encryptionPassphrase = requireEnv("SNAP_SEED_ENCRYPTION_KEY");

  const seedCount = parseInt(
    process.env.SNAP_SEED_COUNT ?? String(DEFAULT_SEED_COUNT),
    10
  );

  console.log("=== SNAP Mainnet Pool Seeding ===");
  console.log("");

  if (!existsSync(POOLS_PATH)) {
    fail("mainnet-pools.json not found. Run create-mainnet-pools.ts first.");
  }

  const poolsConfig = JSON.parse(readFileSync(POOLS_PATH, "utf8"));
  const pools: PoolConfig[] = poolsConfig.pools;

  if (pools.length === 0) {
    fail("No pools found in mainnet-pools.json.");
  }

  const deployer = loadWallet();
  const connection = new Connection(rpcUrl, "confirmed");
  const encryptionKey = deriveEncryptionKey(encryptionPassphrase);

  mkdirSync(SEED_NOTES_DIR, { recursive: true });

  const balance = await connection.getBalance(deployer.publicKey);
  console.log(`Deployer:    ${deployer.publicKey.toBase58()}`);
  console.log(`Balance:     ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Seed count:  ${seedCount} deposits per pool`);
  console.log(`Pools:       ${pools.length}`);
  console.log(`Notes dir:   ${SEED_NOTES_DIR}`);
  console.log(`Encryption:  XChaCha20-Poly1305 (key derived from passphrase)`);
  console.log("");

  for (const pool of pools) {
    console.log(`  - ${pool.denominationHuman}: ${pool.address}`);
  }
  console.log("");

  const answer = await prompt(
    "Type 'seed' to begin seeding all pools: "
  );
  if (answer !== "seed") {
    console.log("Aborted.");
    return;
  }

  const { SNAPClient } = require(SDK_DIST);
  const results: Array<{ pool: string; deposited: number; spent: number }> = [];

  for (const pool of pools) {
    console.log("");
    console.log(`--- Seeding ${pool.denominationHuman} pool ---`);

    try {
      const { deposited, totalSpent } = await seedPool(
        connection,
        deployer,
        pool,
        seedCount,
        encryptionKey,
        SNAPClient
      );
      results.push({
        pool: pool.denominationHuman,
        deposited,
        spent: totalSpent,
      });
      console.log(`  [OK] ${deposited} deposits complete`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(`  [FAIL] Seeding stopped: ${message}`);
      console.error("  Notes saved so far are preserved in mainnet-seed-notes/");
      break;
    }
  }

  console.log("");
  console.log("=== Seeding Summary ===");
  for (const r of results) {
    console.log(`  ${r.pool}: ${r.deposited} deposits`);
  }

  const finalBalance = await connection.getBalance(deployer.publicKey);
  console.log("");
  console.log(
    `Deployer balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`
  );
  console.log("");
  console.log("IMPORTANT: Back up mainnet-seed-notes/ to offline storage NOW.");
  console.log("These encrypted journals are the ONLY way to recover seeded funds.");
  console.log("");
  console.log("Next: npx tsx scripts/mainnet-verify.ts");
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
