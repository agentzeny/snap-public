import { clusterApiUrl, Connection, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const walletPath = path.join(process.env.HOME ?? "", ".config", "solana", "id.json");
const sdkDistPath = path.resolve(__dirname, "..", "sdk-package", "dist");
const poolConfigPath = path.resolve(__dirname, "..", "devnet-pool.json");

function loadWallet(): Keypair {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Solana wallet not found at ${walletPath}`);
  }

  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
}

async function main(): Promise<void> {
  const wallet = loadWallet();
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const { SNAP_PROGRAM_ID, SNAPClient } = require(sdkDistPath);

  console.log("Deployer:", wallet.publicKey.toBase58());
  console.log(
    "Balance:",
    await connection.getBalance(wallet.publicKey).then((lamports) => lamports / LAMPORTS_PER_SOL),
    "SOL",
  );
  console.log("Program ID:", SNAP_PROGRAM_ID.toBase58());

  const snap = new SNAPClient(connection, wallet);

  console.log("Creating 0.1 SOL shielded pool on devnet...");
  const poolAddress = await snap.createPool(0.1);
  const poolInfo = await snap.getPoolInfo(poolAddress);

  console.log("");
  console.log("=== DEVNET POOL CREATED ===");
  console.log("Pool address:", poolAddress.toBase58());
  console.log("Denomination:", poolInfo.depositAmount, "SOL");
  console.log(
    "Explorer: https://explorer.solana.com/address/" +
      poolAddress.toBase58() +
      "?cluster=devnet",
  );

  fs.writeFileSync(
    poolConfigPath,
    JSON.stringify(
      {
        pool: poolAddress.toBase58(),
        denomination: poolInfo.depositAmount,
        programId: SNAP_PROGRAM_ID.toBase58(),
        network: "devnet",
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log("");
  console.log("Pool config written to", path.basename(poolConfigPath));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
