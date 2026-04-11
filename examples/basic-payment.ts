import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { SNAPClient } from "../sdk-package/src";

const DEVNET_POOL = new PublicKey("8P7oho4YD6QPsVusD8bwRejgJK3EXYw9wV3dmcE2bFQT");
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
async function fund(wallet: Keypair, minimumSol: number) {
  if ((await connection.getBalance(wallet.publicKey)) >= minimumSol * LAMPORTS_PER_SOL) return;
  try {
    await connection.confirmTransaction(await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL), "confirmed");
  } catch {
    throw new Error(`Fund ${wallet.publicKey.toBase58()} with: solana airdrop 1 ${wallet.publicKey.toBase58()} --url devnet`);
  }
}
async function main() {
  // Create the sender and recipient wallets.
  const sender = Keypair.generate(), recipient = Keypair.generate();
  // Give both wallets enough devnet SOL for the demo flow.
  await fund(sender, 0.2); await fund(recipient, 0.02);
  // Deposit, pass the note off-chain, then withdraw with a ZK proof.
  const note = await new SNAPClient(connection, sender).deposit(DEVNET_POOL, 0.1);
  const tx = await new SNAPClient(connection, recipient).withdraw(DEVNET_POOL, note, recipient);
  console.log(`Private payment complete: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); console.error("If devnet airdrops are rate-limited, wait 30 seconds or use https://faucet.solana.com."); process.exitCode = 1; });
