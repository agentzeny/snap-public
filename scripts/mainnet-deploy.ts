import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const ROOT_DIR = process.cwd();
const WALLET_PATH = path.join(
  process.env.HOME ?? "",
  ".config",
  "solana",
  "id.json"
);
const PROGRAM_SO_PATH = path.join(
  ROOT_DIR,
  "target",
  "deploy",
  "agent_privacy_pool.so"
);
const DEPLOYMENT_OUTPUT_PATH = path.join(ROOT_DIR, "mainnet-deployment.json");
const ANCHOR_TOML_PATH = path.join(ROOT_DIR, "Anchor.toml");

const MIN_DEPLOY_BALANCE_SOL = 5;

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

function sha256File(filePath: string): string {
  if (!existsSync(filePath)) {
    fail(`File not found: ${filePath}`);
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

  console.log("=== SNAP Mainnet Deployment ===");
  console.log("");

  if (existsSync(DEPLOYMENT_OUTPUT_PATH)) {
    fail(
      `${path.basename(DEPLOYMENT_OUTPUT_PATH)} already exists. ` +
        "Move it aside before redeploying."
    );
  }

  if (!existsSync(PROGRAM_SO_PATH)) {
    fail(
      "Program binary not found. Run 'anchor build' first.\n" +
        `  Expected: ${PROGRAM_SO_PATH}`
    );
  }

  const wallet = loadWallet();
  const connection = new Connection(rpcUrl, "confirmed");

  const balanceBefore = await connection.getBalance(wallet.publicKey);
  const balanceBeforeSol = balanceBefore / LAMPORTS_PER_SOL;

  if (balanceBeforeSol < MIN_DEPLOY_BALANCE_SOL) {
    fail(
      `Deployer balance is ${balanceBeforeSol.toFixed(4)} SOL. ` +
        `Need at least ${MIN_DEPLOY_BALANCE_SOL} SOL for deployment.`
    );
  }

  const bytecodeHash = sha256File(PROGRAM_SO_PATH);
  const binarySize = readFileSync(PROGRAM_SO_PATH).length;

  console.log("Network:       mainnet-beta");
  console.log(`RPC:           ${rpcUrl}`);
  console.log(`Deployer:      ${wallet.publicKey.toBase58()}`);
  console.log(`Balance:       ${balanceBeforeSol.toFixed(4)} SOL`);
  console.log(`Binary:        ${PROGRAM_SO_PATH}`);
  console.log(`Binary size:   ${(binarySize / 1024).toFixed(1)} KB`);
  console.log(`Binary hash:   ${bytecodeHash}`);
  console.log("");
  console.log("This will deploy the SNAP program to Solana mainnet-beta.");
  console.log("The deployer wallet will be the upgrade authority.");
  console.log("");

  const answer = await prompt(
    "Type 'deploy-mainnet-now' to proceed (anything else aborts): "
  );

  if (answer !== "deploy-mainnet-now") {
    console.log("Aborted.");
    return;
  }

  console.log("");
  console.log("Deploying...");

  const solanaPath = path.join(
    process.env.HOME ?? "",
    ".local",
    "share",
    "solana",
    "install",
    "active_release",
    "bin"
  );
  const cargoPath = path.join(process.env.HOME ?? "", ".cargo", "bin");
  const envPath = `${solanaPath}:${cargoPath}:${process.env.PATH}`;

  const deploy = spawnSync(
    "anchor",
    [
      "deploy",
      "--provider.cluster",
      rpcUrl,
      "--provider.wallet",
      WALLET_PATH,
    ],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: { ...process.env, PATH: envPath },
      timeout: 300_000,
    }
  );

  const deployOutput = [deploy.stdout, deploy.stderr].filter(Boolean).join("\n");

  if (deploy.status !== 0) {
    console.error(deployOutput);
    fail("Deployment failed. See output above.");
  }

  console.log(deployOutput);

  const programIdMatch = deployOutput.match(
    /Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/
  );
  if (!programIdMatch) {
    fail(
      "Could not parse program ID from anchor deploy output.\n" +
        "Check the output above and record the program ID manually."
    );
  }

  const programId = programIdMatch[1];
  console.log("");
  console.log(`[OK] Program deployed: ${programId}`);

  const programAccount = await connection.getAccountInfo(
    new PublicKey(programId)
  );
  if (!programAccount || !programAccount.executable) {
    fail("Program account is not executable. Deployment may have failed.");
  }
  console.log("[OK] Program account is executable on mainnet");

  const balanceAfter = await connection.getBalance(wallet.publicKey);
  const balanceAfterSol = balanceAfter / LAMPORTS_PER_SOL;
  const deployCostSol = balanceBeforeSol - balanceAfterSol;

  const deploySignatureMatch = deployOutput.match(
    /Deploy success.*?([1-9A-HJ-NP-Za-km-z]{64,88})/
  );
  const deploySignature = deploySignatureMatch
    ? deploySignatureMatch[1]
    : "check-explorer";

  const deployment = {
    programId,
    deploySignature,
    deployedAt: new Date().toISOString(),
    deployer: wallet.publicKey.toBase58(),
    upgradeAuthority: wallet.publicKey.toBase58(),
    network: "mainnet-beta",
    deployerBalanceBefore: `${balanceBeforeSol.toFixed(9)} SOL`,
    deployerBalanceAfter: `${balanceAfterSol.toFixed(9)} SOL`,
    deployCost: `${deployCostSol.toFixed(9)} SOL`,
    bytecodeHash,
  };

  writeFileSync(DEPLOYMENT_OUTPUT_PATH, JSON.stringify(deployment, null, 2) + "\n");

  console.log("");
  console.log(`Deploy cost:   ${deployCostSol.toFixed(4)} SOL`);
  console.log(`Balance after: ${balanceAfterSol.toFixed(4)} SOL`);
  console.log("");
  console.log(`Deployment record written to ${path.basename(DEPLOYMENT_OUTPUT_PATH)}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. npx tsx scripts/update-mainnet-coordinates.ts");
  console.log("  2. anchor build && cd sdk-package && npm run build && cd ..");
  console.log("  3. npx tsx scripts/create-mainnet-pools.ts");
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
