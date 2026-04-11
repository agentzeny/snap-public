import os from "os";
import path from "path";
import { PublicKey, clusterApiUrl } from "@solana/web3.js";
import { bytesToHex } from "../sdk-package/src/commitment";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  depositWithSignature,
  devnetArtifactPath,
  initializePersistentNoteJournal,
  persistDevnetNoteJournal,
  recordDevnetNote,
  writeDevnetArtifact,
} from "./devnet-validation-shared";
import { assertBalanceAtLeast } from "./relayer-harness";

const DEFAULT_POOL = "7YFJ8rTYZcFyDTeGwre54pmY96b4DW6Zi3kGHgirC4WT";
const DEFAULT_PAYER_BUFFER_LAMPORTS = 2_000_000;
const OUTPUT_FILE = "phase12e-recovery-canary.json";
const NOTES_OUTPUT_FILE = "phase12e-recovery-canary-notes.json";

interface RecoveryCanaryArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  deposit: {
    amount: number;
    assetType: "sol" | "spl";
    depositIndex: number;
    error: string | null;
    latencyMs: number;
    nullifierHash: string;
    retries: number;
    retryErrors: string[];
    signature: string;
    slot: number | null;
  };
  journalPath: string;
  metadata: ReturnType<typeof buildMetadata>;
  pool: string;
  recipient: string;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const pool = new PublicKey(process.env.SNAP_DEVNET_RECOVERY_POOL_ADDRESS ?? DEFAULT_POOL);
  const context = createDevnetContext(rpcUrl, payerPath);

  try {
    const poolInfo = await context.snap.getPoolInfo(pool);
    const requiredPayerLamports =
      poolInfo.depositAmountRaw + DEFAULT_PAYER_BUFFER_LAMPORTS;
    const payerBalanceBefore = await assertBalanceAtLeast(
      context.connection,
      context.payer.publicKey,
      requiredPayerLamports,
      "devnet recovery canary payer",
    );
    const noteJournal = initializePersistentNoteJournal(
      context,
      NOTES_OUTPUT_FILE,
      "devnet recovery canary",
    );
    const deposit = await depositWithSignature(
      context,
      pool,
      poolInfo.depositAmount,
    );

    recordDevnetNote(noteJournal, deposit.note, {
      amount: poolInfo.depositAmount,
      assetType: poolInfo.assetType,
      depositSignature: deposit.signature,
      stage: "phase12e-recovery-canary",
    });
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);

    const payerBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    const artifact: RecoveryCanaryArtifact = {
      balances: {
        payer: {
          after: payerBalanceAfter,
          before: payerBalanceBefore,
          delta: payerBalanceAfter - payerBalanceBefore,
        },
      },
      deposit: {
        amount: poolInfo.depositAmount,
        assetType: poolInfo.assetType,
        depositIndex: deposit.note.depositIndex,
        error: deposit.error,
        latencyMs: deposit.latencyMs,
        nullifierHash: bytesToHex(deposit.note.nullifierHash),
        retries: deposit.retries,
        retryErrors: deposit.retryErrors,
        signature: deposit.signature,
        slot: deposit.slot,
      },
      journalPath: devnetArtifactPath(NOTES_OUTPUT_FILE),
      metadata: buildMetadata(context),
      pool: pool.toBase58(),
      recipient: context.payer.publicKey.toBase58(),
    };

    writeDevnetArtifact(OUTPUT_FILE, artifact);
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeDevnetContext(context);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
