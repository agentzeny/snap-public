import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";
import {
  PROGRAM_ERROR_MESSAGES,
  type Note,
} from "../sdk-package/src";
import {
  bytesToHex,
  computeNullifierHash,
} from "../sdk-package/src/commitment";
import { COMMITMENT_PAGE_CAPACITY } from "../sdk-package/src/commitment-pages";
import {
  computeBudgetIx,
  deriveCommitmentPagePda,
  deriveNullifierRecordPda,
  deriveVaultPda,
} from "../tests/helpers";
import { fetchPoolState } from "../tests/stress/shared";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  fetchSignatureDetails,
  fetchPoolSnapshot,
  initializePersistentNoteJournal,
  markDevnetNoteDeposited,
  markDevnetNoteWithdrawn,
  persistDevnetNoteJournal,
  prefundSolVaultForLowDenomination,
  recordPlannedDevnetNote,
  round,
  withDevnetRetry,
  writeDevnetArtifact,
} from "./devnet-validation-shared";
import { waitForNewSignature } from "./relayer-harness";

const DEFAULT_EXISTING_POOL = "7YFJ8rTYZcFyDTeGwre54pmY96b4DW6Zi3kGHgirC4WT";
const DEFAULT_NEW_POOL_DEPOSIT_AMOUNT = 0.0001;
const DEFAULT_SPEND_ENVELOPE_LAMPORTS = 20_000_000;
const OUTPUT_FILE = "phase13b-validation.json";
const NOTES_OUTPUT_FILE = "phase13b-notes.json";
const ZERO_BYTES_32 = new Uint8Array(32);
const U64_MAX = "18446744073709551615";

interface DeploymentShowJson {
  authority: string | null;
  dataLen: number;
  lamports: number;
  lastDeploySlot: number;
  owner: string;
  programId: string;
  programdataAddress: string;
}

interface SimulationErrorEvidence {
  anchorErrorCode: number | null;
  anchorErrorMessage: string | null;
  anchorErrorName: string | null;
  err: unknown;
  logs: string[];
}

interface SimulatedCheck {
  attempted: string;
  exactError: string;
  expectedErrorCode: number;
  expectedErrorName: string;
  matchedExpectation: boolean;
  mode: "simulated";
  evidence: SimulationErrorEvidence;
}

interface FundedCheck {
  attempted: string;
  matchedExpectation: boolean;
  mode: "funded";
  recipientResult?: {
    address: string;
    balanceAfter: number;
    balanceBefore: number;
    delta: number;
  };
  signatures?: {
    deposit: string;
    withdraw: string;
  };
  error?: string;
}

interface RejectionCheck {
  attempted: string;
  exactError: string;
  matchedExpectation: boolean;
  mode: "bounded-devnet-check";
}

interface Phase13bValidationArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  budget: {
    approvalRequired: boolean;
    envelopeLamports: number;
    envelopeSol: number;
  };
  checks: {
    duplicateWithdraw: RejectionCheck | null;
    initializeMax: SimulatedCheck | null;
    initializeZero: SimulatedCheck | null;
    validCanary: FundedCheck | null;
    zeroCommitment: SimulatedCheck | null;
    zeroNullifier: SimulatedCheck | null;
  };
  date: {
    calendarDateLocal: string;
    generatedAt: string;
  };
  deployment: {
    deploymentSignature: string | null;
    deploymentSlot: number;
    deploymentTimestampUtc: string | null;
    phase13aFixesLive: boolean;
    programDataAddress: string;
    programId: string;
    sdkErrorMapping: {
      errors: Record<string, string>;
      matchedExpectation: boolean;
    };
    status: "already-current" | "upgrade-required";
    upgradedDuringPhase: boolean;
    upgradeAuthority: string | null;
  };
  metadata: ReturnType<typeof buildMetadata>;
  pool: {
    address: string;
    createdDuringPhase: boolean;
    depositAmount: number;
    depositAmountRaw: number;
    notes: string[];
    snapshot: Awaited<ReturnType<typeof fetchPoolSnapshot>>;
    treeDepth: number;
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const preferredPool = process.env.SNAP_PHASE13B_POOL_ADDRESS ?? DEFAULT_EXISTING_POOL;
  const spendEnvelopeLamports = parseIntegerEnv(
    process.env.SNAP_PHASE13B_SPEND_ENVELOPE_LAMPORTS,
    DEFAULT_SPEND_ENVELOPE_LAMPORTS,
  );

  const context = createDevnetContext(rpcUrl, payerPath);
  try {
    const payerBalanceBefore = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    const artifact: Phase13bValidationArtifact = {
      balances: {
        payer: {
          after: payerBalanceBefore,
          before: payerBalanceBefore,
          delta: 0,
        },
      },
      budget: {
        approvalRequired: false,
        envelopeLamports: spendEnvelopeLamports,
        envelopeSol: round(spendEnvelopeLamports / 1_000_000_000, 9),
      },
      checks: {
        duplicateWithdraw: null,
        initializeMax: null,
        initializeZero: null,
        validCanary: null,
        zeroCommitment: null,
        zeroNullifier: null,
      },
      date: {
        calendarDateLocal: new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
        }).format(new Date()),
        generatedAt: new Date().toISOString(),
      },
      deployment: {
        deploymentSignature: null,
        deploymentSlot: 0,
        deploymentTimestampUtc: null,
        phase13aFixesLive: false,
        programDataAddress: "",
        programId: context.program.programId.toBase58(),
        sdkErrorMapping: {
          errors: {
            "6017": PROGRAM_ERROR_MESSAGES[6017] ?? "",
            "6018": PROGRAM_ERROR_MESSAGES[6018] ?? "",
            "6019": PROGRAM_ERROR_MESSAGES[6019] ?? "",
          },
          matchedExpectation:
            Boolean(PROGRAM_ERROR_MESSAGES[6017]) &&
            Boolean(PROGRAM_ERROR_MESSAGES[6018]) &&
            Boolean(PROGRAM_ERROR_MESSAGES[6019]),
        },
        status: "upgrade-required",
        upgradedDuringPhase: false,
        upgradeAuthority: null,
      },
      metadata: buildMetadata(context),
      pool: {
        address: "",
        createdDuringPhase: false,
        depositAmount: 0,
        depositAmountRaw: 0,
        notes: [],
        snapshot: {
          assetType: "sol",
          commitmentPageBytes: 0,
          commitmentPageCount: 0,
          commitmentPageRentLamports: 0,
          depositAmountRaw: 0,
          depositCount: 0,
          poolAccountBytes: 0,
          poolRentLamports: 0,
          totalStorageBytes: 0,
          totalStorageRentLamports: 0,
          treeDepth: 0,
          withdrawCount: 0,
        },
        treeDepth: 0,
      },
    };
    const noteJournal = initializePersistentNoteJournal(
      context,
      NOTES_OUTPUT_FILE,
      "phase13b devnet validation",
    );

    const deploymentShow = loadProgramShowJson(context.program.programId);
    const deploymentEvidence = await loadDeploymentEvidence(
      context.connection,
      context.program.programId,
      deploymentShow.programdataAddress,
    );
    artifact.deployment = {
      ...artifact.deployment,
      deploymentSignature: deploymentEvidence.signature,
      deploymentSlot: deploymentShow.lastDeploySlot,
      deploymentTimestampUtc: deploymentEvidence.timestampUtc,
      programDataAddress: deploymentShow.programdataAddress,
      upgradeAuthority: deploymentShow.authority,
    };

    const poolSelection = await selectPool(context, preferredPool);
    artifact.pool.address = poolSelection.pool.toBase58();
    artifact.pool.createdDuringPhase = poolSelection.createdDuringPhase;
    artifact.pool.depositAmount = poolSelection.poolInfo.depositAmount;
    artifact.pool.depositAmountRaw = poolSelection.poolInfo.depositAmountRaw;
    artifact.pool.notes = [...poolSelection.notes];
    artifact.pool.snapshot = await fetchPoolSnapshot(context, poolSelection.pool);
    artifact.pool.treeDepth = poolSelection.poolInfo.treeDepth;

    artifact.checks.initializeZero = await simulateInitializeAmountCheck(
      context,
      0,
      6017,
      "InvalidDepositAmount",
      "Simulated initialize_v2 with deposit_amount = 0.",
    );
    artifact.checks.initializeMax = await simulateInitializeAmountCheck(
      context,
      U64_MAX,
      6017,
      "InvalidDepositAmount",
      "Simulated initialize_v2 with deposit_amount = u64::MAX.",
    );
    artifact.checks.zeroCommitment = await simulateZeroCommitmentCheck(
      context,
      poolSelection.pool,
    );
    artifact.checks.zeroNullifier = await simulateZeroNullifierCheck(
      context,
      poolSelection.pool,
    );

    const preflightLive =
      artifact.deployment.sdkErrorMapping.matchedExpectation &&
      artifact.checks.initializeZero.matchedExpectation &&
      artifact.checks.initializeMax.matchedExpectation &&
      artifact.checks.zeroCommitment.matchedExpectation &&
      artifact.checks.zeroNullifier.matchedExpectation;

    artifact.deployment.phase13aFixesLive = preflightLive;
    artifact.deployment.status = preflightLive ? "already-current" : "upgrade-required";
    writeDevnetArtifact(OUTPUT_FILE, artifact);

    if (!preflightLive) {
      throw new Error(
        "Phase 13A hardening checks are not all live on devnet; upgrade is required before funded Phase 13B canaries.",
      );
    }

    artifact.checks.validCanary = await runFundedCanary(
      context,
      noteJournal,
      poolSelection.pool,
      poolSelection.poolInfo.depositAmount,
    );
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    writeDevnetArtifact(OUTPUT_FILE, artifact);

    artifact.checks.duplicateWithdraw = await runDuplicateWithdrawCheck(
      context,
      noteJournal.notes[noteJournal.notes.length - 1],
    );

    const payerBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    artifact.balances.payer = {
      after: payerBalanceAfter,
      before: payerBalanceBefore,
      delta: payerBalanceAfter - payerBalanceBefore,
    };

    if (payerBalanceBefore - payerBalanceAfter > spendEnvelopeLamports) {
      throw new Error(
        `Phase 13B validation spent ${payerBalanceBefore - payerBalanceAfter} lamports, exceeding the ${spendEnvelopeLamports} lamport envelope`,
      );
    }

    writeDevnetArtifact(OUTPUT_FILE, artifact);
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    closeDevnetContext(context);
  }
}

async function selectPool(
  context: ReturnType<typeof createDevnetContext>,
  preferredPoolAddress: string,
): Promise<{
  createdDuringPhase: boolean;
  notes: string[];
  pool: PublicKey;
  poolInfo: Awaited<ReturnType<typeof context.snap.getPoolInfo>>;
}> {
  const notes: string[] = [];
  const preferredPool = new PublicKey(preferredPoolAddress);

  try {
    const poolInfo = await context.snap.getPoolInfo(preferredPool);
    if (poolInfo.assetType === "sol" && poolInfo.depositAmount <= 0.001) {
      notes.push(`Reused existing low-denomination devnet SOL pool ${preferredPool.toBase58()}.`);
      return {
        createdDuringPhase: false,
        notes,
        pool: preferredPool,
        poolInfo,
      };
    }
  } catch {
    // Fall through to a fresh pool only if the preferred pool is unavailable.
  }

  const pool = await context.snap.createPool(DEFAULT_NEW_POOL_DEPOSIT_AMOUNT, {
    treeDepth: 20,
  });
  const depositAmountLamports = Math.round(
    DEFAULT_NEW_POOL_DEPOSIT_AMOUNT * 1_000_000_000,
  );
  const vaultFunding = await prefundSolVaultForLowDenomination(
    context.connection,
    context.payer,
    pool,
    context.program.programId,
    depositAmountLamports,
  );
  if (vaultFunding.fundedLamports > 0) {
    notes.push(
      `Prefunded fresh pool vault ${vaultFunding.vault.toBase58()} with ${vaultFunding.fundedLamports} lamports to keep the low-denomination SOL pool rent-safe.`,
    );
  }
  notes.push(`Created fresh low-denomination devnet SOL pool ${pool.toBase58()}.`);

  return {
    createdDuringPhase: true,
    notes,
    pool,
    poolInfo: await context.snap.getPoolInfo(pool),
  };
}

async function simulateInitializeAmountCheck(
  context: ReturnType<typeof createDevnetContext>,
  depositAmount: number | string,
  expectedErrorCode: number,
  expectedErrorName: string,
  attempted: string,
): Promise<SimulatedCheck> {
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, context.program.programId);
  const transaction = await (context.program.methods as any)
    .initializeV2(new BN(depositAmount), 20)
    .accounts({
      authority: context.payer.publicKey,
      pool: pool.publicKey,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([computeBudgetIx(1_400_000)])
    .transaction();

  const evidence = await simulateTransaction(context, transaction, [context.payer, pool]);
  return finalizeSimulationCheck(
    attempted,
    evidence,
    expectedErrorCode,
    expectedErrorName,
  );
}

async function simulateZeroCommitmentCheck(
  context: ReturnType<typeof createDevnetContext>,
  pool: PublicKey,
): Promise<SimulatedCheck> {
  const poolState = await fetchPoolState(context.program, context.connection, pool);
  const [poolVault] = deriveVaultPda(pool, context.program.programId);
  const pageIndex = Math.floor(poolState.nextIndex / COMMITMENT_PAGE_CAPACITY);
  const [commitmentPage] = deriveCommitmentPagePda(
    pool,
    pageIndex,
    context.program.programId,
  );
  const transaction = await (context.program.methods as any)
    .depositV2(Array.from(ZERO_BYTES_32), pageIndex)
    .accounts({
      commitmentPage,
      depositor: context.payer.publicKey,
      pool,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .transaction();

  const evidence = await simulateTransaction(context, transaction, [context.payer]);
  return finalizeSimulationCheck(
    "Simulated deposit_v2 with commitment = 0x00..00.",
    evidence,
    6018,
    "InvalidCommitment",
  );
}

async function simulateZeroNullifierCheck(
  context: ReturnType<typeof createDevnetContext>,
  pool: PublicKey,
): Promise<SimulatedCheck> {
  const zeroNullifierHash = await computeNullifierHash(0n);
  const [poolVault] = deriveVaultPda(pool, context.program.programId);
  const [nullifierRecord] = deriveNullifierRecordPda(
    pool,
    zeroNullifierHash,
    context.program.programId,
  );
  const transaction = await (context.program.methods as any)
    .withdrawZkV2(
      Array(64).fill(0),
      Array(128).fill(0),
      Array(64).fill(0),
      Array(32).fill(0),
      Array.from(zeroNullifierHash),
    )
    .accounts({
      nullifierRecord,
      payer: context.payer.publicKey,
      pool,
      poolVault,
      recipient: context.payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx(1_400_000)])
    .transaction();

  const evidence = await simulateTransaction(context, transaction, [context.payer]);
  return finalizeSimulationCheck(
    "Simulated withdraw_zk_v2 using the public nullifier hash for nullifier = 0.",
    evidence,
    6019,
    "ZeroNullifierNote",
  );
}

async function runFundedCanary(
  context: ReturnType<typeof createDevnetContext>,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  pool: PublicKey,
  depositAmount: number,
): Promise<FundedCheck> {
  const recipientBalanceBefore = await context.connection.getBalance(
    context.payer.publicKey,
    "confirmed",
  );
  const deposit = await journaledDeposit(
    context,
    noteJournal,
    pool,
    depositAmount,
    "phase13b-canary",
  );

  try {
    const { result: signature } = await withDevnetRetry("phase13b-withdraw", () =>
      context.snap.withdraw(pool, deposit.note, context.payer),
    );
    const details = await fetchSignatureDetails(context.connection, signature);
    markDevnetNoteWithdrawn(noteJournal, deposit.note, signature);
    persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);
    const recipientBalanceAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );

    return {
      attempted:
        "Performed a real funded deposit and a real ZK withdrawal against the devnet SOL V2 canary pool.",
      matchedExpectation: details.error === null,
      mode: "funded",
      recipientResult: {
        address: context.payer.publicKey.toBase58(),
        balanceAfter: recipientBalanceAfter,
        balanceBefore: recipientBalanceBefore,
        delta: recipientBalanceAfter - recipientBalanceBefore,
      },
      signatures: {
        deposit: deposit.signature,
        withdraw: signature,
      },
    };
  } catch (error) {
    return {
      attempted:
        "Performed a real funded deposit and a real ZK withdrawal against the devnet SOL V2 canary pool.",
      error: error instanceof Error ? error.message : String(error),
      matchedExpectation: false,
      mode: "funded",
      signatures: {
        deposit: deposit.signature,
        withdraw: "",
      },
    };
  }
}

async function runDuplicateWithdrawCheck(
  context: ReturnType<typeof createDevnetContext>,
  lastNoteRecord: {
    commitment: string;
    depositIndex: number;
    nullifier: string;
    nullifierHash: string;
    pool: string;
    secret: string;
  },
): Promise<RejectionCheck> {
  const note: Note = {
    commitment: Uint8Array.from(Buffer.from(lastNoteRecord.commitment, "hex")),
    depositIndex: lastNoteRecord.depositIndex,
    nullifier: BigInt(lastNoteRecord.nullifier),
    nullifierHash: Uint8Array.from(Buffer.from(lastNoteRecord.nullifierHash, "hex")),
    poolAddress: lastNoteRecord.pool,
    secret: BigInt(lastNoteRecord.secret),
  };

  try {
    await context.snap.withdraw(new PublicKey(lastNoteRecord.pool), note, context.payer);
    return {
      attempted:
        "Attempted a second withdrawal with the exact same note after the funded canary had already succeeded.",
      exactError: "Second withdrawal unexpectedly succeeded",
      matchedExpectation: false,
      mode: "bounded-devnet-check",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attempted:
        "Attempted a second withdrawal with the exact same note after the funded canary had already succeeded.",
      exactError: message,
      matchedExpectation: message.includes(PROGRAM_ERROR_MESSAGES[6003]),
      mode: "bounded-devnet-check",
    };
  }
}

async function journaledDeposit(
  context: ReturnType<typeof createDevnetContext>,
  noteJournal: ReturnType<typeof initializePersistentNoteJournal>,
  pool: PublicKey,
  depositAmount: number,
  stage: string,
): Promise<{
  note: Note;
  signature: string;
}> {
  const seen = new Set(
    (
      await context.connection.getSignaturesForAddress(
        context.payer.publicKey,
        { limit: 20 },
        "confirmed",
      )
    ).map((entry) => entry.signature),
  );
  const { result: note } = await withDevnetRetry("phase13b-deposit", () =>
    context.snap.deposit(pool, depositAmount),
  );
  recordPlannedDevnetNote(noteJournal, note, {
    amount: depositAmount,
    assetType: "sol",
    stage,
  });
  persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);

  const signature = await waitForNewSignature(
    context.connection,
    context.payer.publicKey,
    seen,
    "phase13b deposit",
    60_000,
  );
  markDevnetNoteDeposited(noteJournal, note, signature);
  persistDevnetNoteJournal(NOTES_OUTPUT_FILE, noteJournal);

  return {
    note,
    signature,
  };
}

async function simulateTransaction(
  context: ReturnType<typeof createDevnetContext>,
  transaction: Transaction,
  signers: Keypair[],
): Promise<SimulationErrorEvidence> {
  transaction.feePayer = context.payer.publicKey;
  const simulation = await context.connection.simulateTransaction(
    transaction,
    dedupeSigners(signers),
  );

  return extractSimulationEvidence(simulation.value);
}

function finalizeSimulationCheck(
  attempted: string,
  evidence: SimulationErrorEvidence,
  expectedErrorCode: number,
  expectedErrorName: string,
): SimulatedCheck {
  const exactError =
    evidence.anchorErrorMessage ??
    evidence.anchorErrorName ??
    JSON.stringify(evidence.err) ??
    "Unknown simulation failure";

  return {
    attempted,
    exactError,
    expectedErrorCode,
    expectedErrorName,
    matchedExpectation:
      evidence.anchorErrorCode === expectedErrorCode &&
      evidence.anchorErrorName === expectedErrorName,
    mode: "simulated",
    evidence,
  };
}

function extractSimulationEvidence(
  value: SimulatedTransactionResponse,
): SimulationErrorEvidence {
  const logs = value.logs ?? [];
  const joined = logs.join("\n");
  const anchorMatch = joined.match(
    /Error Code: ([A-Za-z0-9_]+)\. Error Number: (\d+)\. Error Message: ([^\n]+)/,
  );

  return {
    anchorErrorCode: anchorMatch ? Number(anchorMatch[2]) : null,
    anchorErrorMessage: anchorMatch ? anchorMatch[3] : null,
    anchorErrorName: anchorMatch ? anchorMatch[1] : null,
    err: value.err,
    logs,
  };
}

function loadProgramShowJson(programId: PublicKey): DeploymentShowJson {
  return JSON.parse(
    execFileSync(
      "solana",
      [
        "program",
        "show",
        programId.toBase58(),
        "--url",
        "devnet",
        "--output",
        "json",
      ],
      {
        encoding: "utf8",
      },
    ),
  ) as DeploymentShowJson;
}

async function loadDeploymentEvidence(
  connection: ReturnType<typeof createDevnetContext>["connection"],
  programId: PublicKey,
  programDataAddress: string,
): Promise<{
  signature: string | null;
  timestampUtc: string | null;
}> {
  const history = JSON.parse(
    execFileSync(
      "solana",
      [
        "transaction-history",
        programDataAddress,
        "--url",
        "devnet",
        "--limit",
        "5",
        "--output",
        "json",
      ],
      {
        encoding: "utf8",
      },
    ),
  ) as Array<{ signature?: string }>;
  const signature = history[0]?.signature ?? null;
  if (!signature) {
    return {
      signature: null,
      timestampUtc: null,
    };
  }

  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return {
    signature,
    timestampUtc:
      tx?.blockTime === undefined || tx.blockTime === null
        ? null
        : new Date(tx.blockTime * 1_000).toISOString(),
  };
}

function dedupeSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  const deduped: Keypair[] = [];
  for (const signer of signers) {
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(signer);
  }
  return deduped;
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }

  return parsed;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
