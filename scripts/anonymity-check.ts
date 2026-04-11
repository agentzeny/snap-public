import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SNAPClient } from "../sdk-package/src";

/**
 * Check the current anonymity set size for a SNAP pool.
 *
 * Reports:
 * - Total deposits (commitments)
 * - Total withdrawals (nullifiers)
 * - Active anonymity set (deposits - withdrawals)
 * - Privacy rating (minimal / moderate / strong / excellent)
 *
 * Run: npx tsx scripts/anonymity-check.ts [pool_address]
 */
async function main(): Promise<void> {
  const poolAddress =
    process.argv[2] ??
    process.env.SNAP_POOL_ADDRESS ??
    "8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT";
  const rpcUrl = process.env.SNAP_RPC_URL ?? "https://api.devnet.solana.com";

  const connection = new Connection(rpcUrl, "confirmed");
  const snap = new SNAPClient(connection, Keypair.generate());
  const pool = new PublicKey(poolAddress);
  const info = await snap.getPoolInfo(pool);
  const activeSet = Math.max(0, info.depositCount - info.withdrawCount);

  console.log(
    JSON.stringify(
      {
        pool: pool.toBase58(),
        deposits: info.depositCount,
        withdrawals: info.withdrawCount,
        activeAnonymitySet: activeSet,
        privacyRating: getPrivacyRating(activeSet),
      },
      null,
      2,
    ),
  );
}

function getPrivacyRating(k: number): string {
  if (k < 10) {
    return "minimal";
  }

  if (k <= 50) {
    return "moderate";
  }

  if (k <= 200) {
    return "strong";
  }

  return "excellent";
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
