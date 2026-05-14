import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const ROOT_DIR = process.cwd();
const SDK_DIST = path.resolve(ROOT_DIR, "sdk-package", "dist");
const WALLET_PATH = path.join(
  process.env.HOME ?? "",
  ".config",
  "solana",
  "id.json"
);
const DEPLOYMENT_PATH = path.join(ROOT_DIR, "mainnet-deployment.json");
const TREASURY_CONFIG_PATH = path.join(ROOT_DIR, "treasury-config.json");
const POOLS_OUTPUT_PATH = path.join(ROOT_DIR, "mainnet-pools.json");

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROTOCOL_FEE_BPS = 25;
const TREE_DEPTH = 20;

interface PoolSpec {
  denominationHuman: string;
  denominationRaw: number;
  asset: "SOL" | "USDC";
  tokenMint: string | null;
}

const POOL_LINEUP: PoolSpec[] = [
  {
    denominationHuman: "0.1 SOL",
    denominationRaw: 0.1 * LAMPORTS_PER_SOL,
    asset: "SOL",
    tokenMint: null,
  },
  {
    denominationHuman: "1 USDC",
    denominationRaw: 1_000_000,
    asset: "USDC",
    tokenMint: USDC_MINT,
  },
  {
    denominationHuman: "10 USDC",
    denominationRaw: 10_000_000,
    asset: "USDC",
    tokenMint: USDC_MINT,
  },
];

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

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SNAP_RPC_URL");

  console.log("=== SNAP Mainnet Pool Creation ===");
  console.log("");

  if (!existsSync(DEPLOYMENT_PATH)) {
    fail("mainnet-deployment.json not found. Run mainnet-deploy.ts first.");
  }
  if (!existsSync(TREASURY_CONFIG_PATH)) {
    fail("treasury-config.json not found. Run generate-treasury.ts first.");
  }

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  const treasuryConfig = JSON.parse(readFileSync(TREASURY_CONFIG_PATH, "utf8"));

  const programId = new PublicKey(deployment.programId);
  const treasuryAddress = treasuryConfig.treasuryAddress;

  const wallet = loadWallet();
  const connection = new Connection(rpcUrl, "confirmed");

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Network:     mainnet-beta`);
  console.log(`RPC:         ${rpcUrl}`);
  console.log(`Program:     ${programId.toBase58()}`);
  console.log(`Treasury:    ${treasuryAddress}`);
  console.log(`Deployer:    ${wallet.publicKey.toBase58()}`);
  console.log(`Balance:     ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Fee:         ${PROTOCOL_FEE_BPS} bps (0.25%)`);
  console.log(`Tree depth:  ${TREE_DEPTH}`);
  console.log("");

  const treasuryAccount = await connection.getAccountInfo(
    new PublicKey(treasuryAddress)
  );
  if (!treasuryAccount) {
    console.log(
      "[WARN] Treasury account does not exist on-chain yet. " +
        "It will be created when the first fee is collected."
    );
  }

  const usdcMintPubkey = new PublicKey(USDC_MINT);
  const mintInfo = await getMint(connection, usdcMintPubkey);
  if (mintInfo.decimals !== 6) {
    fail(
      `USDC mint has ${mintInfo.decimals} decimals, expected 6. ` +
        "Verify the USDC mint address."
    );
  }
  console.log(`[OK] USDC mint verified: ${USDC_MINT} (${mintInfo.decimals} decimals)`);
  console.log("");

  console.log("Pools to create:");
  for (const spec of POOL_LINEUP) {
    console.log(`  - ${spec.denominationHuman} (${spec.denominationRaw} raw, fee=${PROTOCOL_FEE_BPS}bps)`);
  }
  console.log("");

  const { SNAPClient } = require(SDK_DIST);

  const snap = new SNAPClient(connection, wallet, { programId });

  const createdPools: Array<{
    address: string;
    denomination: number;
    denominationHuman: string;
    asset: string;
    tokenMint: string | null;
    treeDepth: number;
    protocolFeeBps: number;
    createSignature: string;
  }> = [];

  for (let i = 0; i < POOL_LINEUP.length; i++) {
    const spec = POOL_LINEUP[i];

    console.log(`--- Pool ${i + 1}/${POOL_LINEUP.length}: ${spec.denominationHuman} ---`);

    const answer = await prompt(
      `Create ${spec.denominationHuman} pool? Type 'yes' to proceed: `
    );
    if (answer !== "yes") {
      console.log("Skipped.");
      console.log("");
      continue;
    }

    const uiAmount =
      spec.asset === "SOL"
        ? spec.denominationRaw / LAMPORTS_PER_SOL
        : spec.denominationRaw / 10 ** mintInfo.decimals;

    let treasuryForPool = treasuryAddress;
    if (spec.tokenMint) {
      const mint = new PublicKey(spec.tokenMint);
      const treasuryAta = getAssociatedTokenAddressSync(
        mint,
        new PublicKey(treasuryAddress)
      );
      const ataInfo = await connection.getAccountInfo(treasuryAta);
      if (!ataInfo) {
        console.log(`  Creating treasury USDC token account...`);
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            treasuryAta,
            new PublicKey(treasuryAddress),
            mint
          )
        );
        await connection.sendTransaction(tx, [wallet]);
        await new Promise((r) => setTimeout(r, 2000));
        console.log(`  [OK] Treasury ATA: ${treasuryAta.toBase58()}`);
      }
      treasuryForPool = treasuryAta.toBase58();
    }

    const poolAddress = await snap.createPool(uiAmount, {
      treasury: treasuryForPool,
      treeDepth: TREE_DEPTH,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      tokenMint: spec.tokenMint ?? undefined,
    });

    console.log(`[OK] Pool created: ${poolAddress.toBase58()}`);
    console.log(`     Denomination: ${spec.denominationHuman}`);
    console.log(`     Fee:          ${PROTOCOL_FEE_BPS} bps`);
    console.log(`     Tree depth:   ${TREE_DEPTH}`);

    try {
      const poolInfo = await snap.getPoolInfo(poolAddress);
      console.log(`     Verified:     deposits=${poolInfo.depositCount}, fee=${poolInfo.protocolFeeBps}bps`);
    } catch {
      console.log(`     [WARN] Pool created but read-back verification deferred`);
    }
    console.log("");

    createdPools.push({
      address: poolAddress.toBase58(),
      denomination: spec.denominationRaw,
      denominationHuman: spec.denominationHuman,
      asset: spec.asset,
      tokenMint: spec.tokenMint,
      treeDepth: TREE_DEPTH,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      createSignature: "check-explorer",
    });
  }

  if (createdPools.length === 0) {
    console.log("No pools created.");
    return;
  }

  const poolsConfig = {
    network: "mainnet-beta",
    programId: programId.toBase58(),
    treasury: treasuryAddress,
    treasuryNote:
      "Dedicated fee collection wallet — separate from deployer",
    createdAt: new Date().toISOString(),
    pools: createdPools,
  };

  writeFileSync(POOLS_OUTPUT_PATH, JSON.stringify(poolsConfig, null, 2) + "\n");

  console.log("=== Pool Creation Summary ===");
  console.log("");
  for (const pool of createdPools) {
    console.log(`  ${pool.denominationHuman}: ${pool.address}`);
  }
  console.log("");
  console.log(`Pool config written to ${path.basename(POOLS_OUTPUT_PATH)}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    '  SNAP_RPC_URL="..." SNAP_SEED_ENCRYPTION_KEY="..." npx tsx scripts/seed-mainnet-pools.ts'
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
