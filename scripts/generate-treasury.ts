import { Keypair } from "@solana/web3.js";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

interface TreasuryConfig {
  treasuryAddress: string;
  generatedAt: string;
  purpose: string;
  note: string;
}

const TREASURY_KEYPAIR_PATH = path.resolve(process.cwd(), "treasury-keypair.json");
const TREASURY_CONFIG_PATH = path.resolve(process.cwd(), "treasury-config.json");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function ensureTargetDoesNotExist(targetPath: string): void {
  if (existsSync(targetPath)) {
    fail(
      `Refusing to overwrite existing file: ${targetPath}\n` +
        "Move it aside or back it up first, then rerun the treasury generator.",
    );
  }
}

function main(): void {
  ensureTargetDoesNotExist(TREASURY_KEYPAIR_PATH);
  ensureTargetDoesNotExist(TREASURY_CONFIG_PATH);

  const treasury = Keypair.generate();
  const secretKey = Array.from(treasury.secretKey);

  writeFileSync(
    TREASURY_KEYPAIR_PATH,
    `${JSON.stringify(secretKey, null, 2)}\n`,
    { mode: 0o600 },
  );

  try {
    chmodSync(TREASURY_KEYPAIR_PATH, 0o600);
  } catch {
    // Best effort only; not all filesystems honor POSIX permission bits.
  }

  const config: TreasuryConfig = {
    treasuryAddress: treasury.publicKey.toBase58(),
    generatedAt: new Date().toISOString(),
    purpose: "SNAP protocol fee collection",
    note: "This wallet receives 0.25% of every pool withdrawal. Back up treasury-keypair.json securely.",
  };

  writeFileSync(TREASURY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);

  console.log("SNAP treasury wallet generated.");
  console.log("");
  console.log("Sensitive file created:");
  console.log(`  ${TREASURY_KEYPAIR_PATH}`);
  console.log("");
  console.log("Public config created:");
  console.log(`  ${TREASURY_CONFIG_PATH}`);
  console.log("");
  console.log("Treasury public key:");
  console.log(`  ${treasury.publicKey.toBase58()}`);
  console.log("");
  console.log("Raw secret key bytes for backup:");
  console.log(JSON.stringify(secretKey));
  console.log("");
  console.log("Backup instructions:");
  console.log("  1. Store treasury-keypair.json in at least two physically separate locations.");
  console.log("  2. Treat the raw secret key bytes as equally sensitive.");
  console.log("  3. Never commit treasury-keypair.json to git or copy it to a public machine.");
  console.log("");
  console.log("Stop here and back up treasury-keypair.json before continuing to the ceremony.");
}

main();
