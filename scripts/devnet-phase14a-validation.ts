import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  Keypair,
  PublicKey,
  clusterApiUrl,
  type ConfirmedTransactionMeta,
  type Connection,
  type ParsedTransactionWithMeta,
  type TransactionSignature,
} from "@solana/web3.js";
import { PROGRAM_ERROR_MESSAGES, type Note } from "../sdk-package/src";
import { bytesToHex } from "../sdk-package/src/commitment";
import {
  buildMetadata,
  closeDevnetContext,
  createDevnetContext,
  fetchPoolSnapshot,
  initializePersistentNoteJournal,
  markDevnetNoteDeposited,
  markDevnetNoteWithdrawn,
  persistDevnetNoteJournal,
  prefundSolVaultForLowDenomination,
  recordPlannedDevnetNote,
  round,
  type DevnetNoteJournal,
  type DevnetNoteRecord,
} from "./devnet-validation-shared";
import {
  drainSystemAccountBalance,
  ensureRelayerBalance,
  startRelayerHarness,
  stopRelayerHarness,
} from "./relayer-harness";
import {
  createSignedRelayRequest,
  fetchPoolState,
  postJson,
} from "../tests/stress/shared";
import { waitForNewSignature } from "./relayer-harness";

const DEFAULT_DIRECT_OUTPUT_FILE = "phase14a-validation.json";
const DEFAULT_DIRECT_NOTES_FILE = "phase14a-notes.json";
const DEFAULT_RELAYER_OUTPUT_FILE = "phase14a-relayer-validation.json";
const DEFAULT_RELAYER_NOTES_FILE = "phase14a-relayer-notes.json";
const DEFAULT_RELAYER_RECOVERY_FILE = "phase14a-relayer-recovery.json";
const DEFAULT_RELAYER_RECONCILIATION_FILE = "phase14a-relayer-reconciliation.json";
const DEFAULT_DIRECT_DEPOSIT_AMOUNT_SOL = 0.0001;
const DEFAULT_TREE_DEPTH = 20;
const DEFAULT_PROTOCOL_FEE_BPS = 250;
const DEFAULT_RELAYER_FEE_BPS = 50;
const DEFAULT_RELAYER_MIN_FEE_LAMPORTS = 10_000;
const DEFAULT_RELAYER_TARGET_LAMPORTS = 5_000_000;
const DEFAULT_BURN_RISK_LAMPORTS = 50_000_000;
const DEFAULT_TEMP_ACCOUNT_FUNDING_LAMPORTS = 1_000_000;
const ACCOUNT_PADDING_BYTES = 37;

interface DeploymentShowJson {
  authority: string | null;
  dataLen: number;
  lamports: number;
  lastDeploySlot: number;
  owner: string;
  programId: string;
  programdataAddress: string;
}

interface HistoryEntry {
  signature?: string;
}

interface DirectCanaryResult {
  matchedExpectation: boolean;
  observedInstruction: string | null;
  protocolFeeExpectedRaw: number;
  protocolFeeObservedRaw: number;
  recipientAmountExpectedRaw: number;
  recipientAmountObservedRaw: number;
  recipientResult: BalanceDelta;
  signatures: {
    createPool: string;
    deposit: string;
    withdraw: string;
  };
  treasuryResult: BalanceDelta;
  txError: string | null;
}

interface BalanceDelta {
  address: string;
  after: number;
  before: number;
  delta: number;
}

interface RelayerRequestOutcome {
  note: {
    amount: number;
    assetType: "sol";
    depositIndex: number;
    depositSignature: string | null;
    nullifierHash: string;
    pool: string;
  };
  noteStateAtScenarioEnd: {
    depositState: string;
    withdrawalSignature: string | null;
    withdrawn: boolean;
  };
  persistedRelayRecord: null;
  requestIndex: number;
  stage: string;
  surfaced: {
    classification: "success";
    error: string | null;
    httpStatus: number;
    retryAfterSeconds: number | null;
    txSignature: string | null;
  };
}

interface Phase14aRelayerArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
      phaseBefore: number | null;
      phaseDelta: number | null;
    };
    recipient: BalanceDelta | null;
    relayer: BalanceDelta | null;
    treasury: BalanceDelta | null;
  };
  config: {
    depositAmount: number;
    pool: string;
    protocolFeeBps: number;
    relayerFeeBps: number;
    relayerMinFeeLamports: number;
    relayerTargetLamports: number;
  };
  metadata: ReturnType<typeof buildMetadata>;
  nonSuccessResponses: Array<{
    body: unknown;
    classification: string;
    label: string;
    status: number;
  }>;
  replay: {
    exactSameSignedRequest: true;
    expectedStatus: number;
    matchedExpectation: boolean;
    response: {
      body: unknown;
      status: number;
    };
  } | null;
  requests: RelayerRequestOutcome[];
  scenario: {
    accepted: number;
    attempted: number;
    concurrency: number;
    httpStatuses: Record<string, number>;
    mode: "default-limits";
    noteJournalPath: string;
    relayer: string;
    txSignatures: string[];
  };
  split: {
    matchedExpectation: boolean;
    protocolFeeExpectedRaw: number;
    protocolFeeObservedRaw: number;
    recipientAmountExpectedRaw: number;
    recipientAmountObservedRaw: number;
    relayerFeeExpectedRaw: number;
    relayerFeeObservedRaw: number;
    relayerNetBalanceDeltaRaw: number;
    requestLatencyMs: number;
    requestResult: unknown;
    txError: string | null;
    txInstruction: string | null;
  } | null;
  duplicateWithdraw: {
    exactError: string;
    matchedExpectation: boolean;
  } | null;
}

interface RecoveryArtifact {
  balances: {
    payer: {
      after: number;
      before: number;
      delta: number;
    };
  };
  metadata: ReturnType<typeof buildMetadata>;
  summary: {
    alreadyWithdrawn: number;
    failed: number;
    recovered: number;
    unresolvedFound: number;
  };
  attempts: Array<{
    depositIndex: number;
    nullifierHash: string;
    pool: string;
    stage: string;
    status: "already-withdrawn" | "failed" | "recovered";
    withdrawalSignature: string | null;
    error: string | null;
  }>;
}

interface ReconciliationArtifact {
  inputs: {
    noteJournalPath: string;
    recoveryArtifactPath: string;
    validationArtifactPath: string;
  };
  metadata: ReturnType<typeof buildMetadata>;
  requests: Array<{
    bucket: "confirmed-success-surfaced-success";
    note: {
      amount: number;
      depositIndex: number;
      nullifierHash: string;
      pool: string;
      stage: string;
    };
    recovery: {
      needed: false;
      status: "not-needed";
      withdrawalSignature: string | null;
    };
    surfaced: {
      classification: "success";
      error: string | null;
      httpStatus: number;
      txSignature: string | null;
    };
    truth: {
      alreadySpentOnChainDespiteNonSuccess: false;
      laterRecoveredManually: false;
      withdrawalSignature: string | null;
      withdrawn: true;
    };
  }>;
  summary: {
    bucketCounts: {
      "confirmed-success-surfaced-success": number;
      "surfaced-failure-already-withdrawn-on-chain": number;
      "surfaced-failure-required-recovery": number;
    };
    unresolvedRelayedNotes: number;
  };
}

interface Phase14aConfig {
  approvalRecorded: boolean;
  burnRiskLamports: number;
  directNotesFile: string;
  directOutputFile: string;
  depositAmountSol: number;
  existingPoolAddress: string | null;
  existingTreasuryAddress: string | null;
  payerPath: string;
  phaseStartBalanceLamports: number | null;
  protocolFeeBps: number;
  relayerFeeBps: number;
  relayerMinFeeLamports: number;
  relayerNotesFile: string;
  relayerOutputFile: string;
  relayerRecoveryFile: string;
  relayerReconciliationFile: string;
  relayerTargetLamports: number;
  rpcUrl: string;
  tempAccountFundingLamports: number;
  treeDepth: number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const resumingRelayerOnly =
    config.existingPoolAddress !== null || config.existingTreasuryAddress !== null;
  if (resumingRelayerOnly && (!config.existingPoolAddress || !config.existingTreasuryAddress)) {
    throw new Error(
      "Phase 14A resume mode requires both SNAP_PHASE14A_EXISTING_POOL_ADDRESS and SNAP_PHASE14A_EXISTING_TREASURY_ADDRESS.",
    );
  }

  const context = createDevnetContext(config.rpcUrl, config.payerPath);
  const payerBeforeScript = await context.connection.getBalance(
    context.payer.publicKey,
    "confirmed",
  );
  const metadata = buildMetadata(context);

  const directNotes = resumingRelayerOnly
    ? null
    : initializePersistentNoteJournal(
        context,
        config.directNotesFile,
        "phase14a devnet validation",
      );
  const relayerNotes =
    resumingRelayerOnly && readArtifact<DevnetNoteJournal>(config.relayerNotesFile)
      ? readArtifact<DevnetNoteJournal>(config.relayerNotesFile)!
      : initializePersistentNoteJournal(
          context,
          config.relayerNotesFile,
          "phase14a devnet relayer validation",
        );

  const treasury = resumingRelayerOnly ? null : Keypair.generate();
  const directRecipient = resumingRelayerOnly ? null : Keypair.generate();
  const relayedRecipient = Keypair.generate();
  const relayer = Keypair.generate();
  let harness: Awaited<ReturnType<typeof startRelayerHarness>> | undefined;
  let cleanupCompleted = false;

  const freshDirectArtifact: Record<string, unknown> = {
    balances: {
      payer: {
        after: payerBeforeScript,
        before: payerBeforeScript,
        delta: 0,
        phaseBefore: config.phaseStartBalanceLamports,
        phaseDelta:
          config.phaseStartBalanceLamports === null
            ? null
            : payerBeforeScript - config.phaseStartBalanceLamports,
      },
    },
    budget: {
      approvalRecorded: config.approvalRecorded,
      approvalRequired: config.burnRiskLamports > DEFAULT_BURN_RISK_LAMPORTS,
      defaultBurnRiskLamports: DEFAULT_BURN_RISK_LAMPORTS,
      defaultBurnRiskSol: round(DEFAULT_BURN_RISK_LAMPORTS / 1_000_000_000, 9),
      envelopeLamports: config.burnRiskLamports,
      envelopeSol: round(config.burnRiskLamports / 1_000_000_000, 9),
    },
    date: {
      calendarDateLocal: new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
      }).format(new Date()),
      generatedAt: new Date().toISOString(),
    },
    deployment: {},
    metadata,
    pool: {},
    checks: {},
  };
  const directArtifact =
    resumingRelayerOnly && readArtifact<Record<string, unknown>>(config.directOutputFile)
      ? readArtifact<Record<string, unknown>>(config.directOutputFile)!
      : freshDirectArtifact;

  const relayerArtifact: Phase14aRelayerArtifact = {
    balances: {
      payer: {
        after: payerBeforeScript,
        before: payerBeforeScript,
        delta: 0,
        phaseBefore: config.phaseStartBalanceLamports,
        phaseDelta:
          config.phaseStartBalanceLamports === null
            ? null
            : payerBeforeScript - config.phaseStartBalanceLamports,
      },
      recipient: null,
      relayer: null,
      treasury: null,
    },
    config: {
      depositAmount: config.depositAmountSol,
      pool: "",
      protocolFeeBps: config.protocolFeeBps,
      relayerFeeBps: config.relayerFeeBps,
      relayerMinFeeLamports: config.relayerMinFeeLamports,
      relayerTargetLamports: config.relayerTargetLamports,
    },
    metadata,
    nonSuccessResponses: [],
    replay: null,
    requests: [],
    scenario: {
      accepted: 0,
      attempted: 0,
      concurrency: 1,
      httpStatuses: {},
      mode: "default-limits",
      noteJournalPath: path.resolve("devnet-results", config.relayerNotesFile),
      relayer: relayer.publicKey.toBase58(),
      txSignatures: [],
    },
    split: null,
    duplicateWithdraw: null,
  };

  try {
    if (config.burnRiskLamports > DEFAULT_BURN_RISK_LAMPORTS && !config.approvalRecorded) {
      throw new Error(
        "Phase 14A devnet validation requires explicit approval once the planned spend exceeds 0.05 SOL. Set SNAP_PHASE14A_APPROVAL_RECORDED=1.",
      );
    }

    const deployment = await collectDeploymentEvidence(context.connection);
    directArtifact.deployment = deployment;
    writeArtifact(config.directOutputFile, directArtifact);

    const poolInfo = resumingRelayerOnly
      ? await context.snap.getPoolInfo(new PublicKey(config.existingPoolAddress!))
      : await (async () => {
          await fundTemporaryAccounts(
            context.connection,
            context.payer,
            [treasury!, directRecipient!, relayedRecipient],
            config.tempAccountFundingLamports,
          );

          const createdPool = await createFeeSolPoolWithSignature(
            context.connection,
            context.snap,
            context.payer.publicKey,
            config.depositAmountSol,
            treasury!.publicKey,
            config.protocolFeeBps,
            config.treeDepth,
          );
          const createdPoolInfo = await context.snap.getPoolInfo(createdPool.pool);
          const vaultFunding = await prefundSolVaultForLowDenomination(
            context.connection,
            context.payer,
            createdPoolInfo.address,
            context.program.programId,
            createdPoolInfo.depositAmountRaw,
          );

          directArtifact.pool = {
            address: createdPoolInfo.address.toBase58(),
            createdDuringPhase: true,
            depositAmount: createdPoolInfo.depositAmount,
            depositAmountRaw: createdPoolInfo.depositAmountRaw,
            feeCapable: createdPoolInfo.feeCapable,
            protocolFeeBps: createdPoolInfo.protocolFeeBps,
            snapshot: await fetchPoolSnapshot(context, createdPoolInfo.address),
            treasury: createdPoolInfo.treasury?.toBase58() ?? null,
            treeDepth: createdPoolInfo.treeDepth,
            vaultFunding,
          };

          directArtifact.checks = {
            feePoolConfiguration: {
              createPoolSignature: createdPool.signature,
              matchedExpectation:
                createdPoolInfo.assetType === "sol" &&
                createdPoolInfo.feeCapable &&
                createdPoolInfo.protocolFeeBps === config.protocolFeeBps &&
                createdPoolInfo.treasury?.equals(treasury!.publicKey) === true,
              observedInstruction: createdPool.instruction,
            },
          };
          writeArtifact(config.directOutputFile, directArtifact);

          const directDeposit = await journaledDeposit(
            context,
            directNotes!,
            config.directNotesFile,
            createdPoolInfo.address,
            config.depositAmountSol,
            "phase14a-direct",
          );
          const directEstimate = await context.snap.estimateDirectWithdrawal(
            createdPoolInfo.address,
          );
          const directCanary = await runDirectCanary(
            context.connection,
            context.snap,
            createdPoolInfo.address,
            directDeposit.note,
            directRecipient!.publicKey,
            treasury!.publicKey,
            directEstimate.protocolFeeRaw,
            directEstimate.recipientAmountRaw,
            directDeposit.signature,
            createdPool.signature,
          );
          markDevnetNoteWithdrawn(
            directNotes!,
            directDeposit.note,
            directCanary.signatures.withdraw,
          );
          persistDevnetNoteJournal(config.directNotesFile, directNotes!);
          (directArtifact.checks as Record<string, unknown>).directCanary = directCanary;
          writeArtifact(config.directOutputFile, directArtifact);

          return createdPoolInfo;
        })();

    if (resumingRelayerOnly) {
      const configuredTreasury = new PublicKey(config.existingTreasuryAddress!);
      if (
        poolInfo.assetType !== "sol" ||
        !poolInfo.feeCapable ||
        poolInfo.protocolFeeBps !== config.protocolFeeBps ||
        poolInfo.treasury?.equals(configuredTreasury) !== true
      ) {
        throw new Error(
          "Phase 14A resume preflight failed: existing pool does not match the expected fee-capable SOL configuration.",
        );
      }

      directArtifact.pool = {
        ...(typeof directArtifact.pool === "object" && directArtifact.pool !== null
          ? directArtifact.pool
          : {}),
        address: poolInfo.address.toBase58(),
        resumedForRelayerValidation: true,
        treasury: configuredTreasury.toBase58(),
      };
      (directArtifact.checks as Record<string, unknown>).relayerResume = {
        matchedExpectation: true,
        mode: "reuse-existing-direct-artifact",
        pool: poolInfo.address.toBase58(),
        treasury: configuredTreasury.toBase58(),
      };
      writeArtifact(config.directOutputFile, directArtifact);

      await fundTemporaryAccounts(
        context.connection,
        context.payer,
        [relayedRecipient],
        config.tempAccountFundingLamports,
      );
    }

    const treasuryAddress = poolInfo.treasury ?? treasury?.publicKey;
    if (!treasuryAddress) {
      throw new Error("Phase 14A could not determine the pool treasury address.");
    }

    const relayerFunding = await ensureRelayerBalance(
      context.connection,
      context.payer,
      relayer.publicKey,
      config.relayerTargetLamports,
    );
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "snap-phase14a-relayer-")),
      "relayer.sqlite",
    );
    harness = await startRelayerHarness({
      cluster: "devnet",
      connection: context.connection,
      dbPath,
      feeBps: config.relayerFeeBps,
      maxRequestsPerMinuteGlobal: 100,
      maxRequestsPerMinutePerIp: 10,
      minFeeLamports: config.relayerMinFeeLamports,
      pool: poolInfo.address,
      programId: context.program.programId,
      relayer,
      retryBackoffMs: [1000, 3000, 8000],
      retryPollIntervalMs: 1000,
    });
    relayerArtifact.config.pool = poolInfo.address.toBase58();
    (relayerArtifact.config as Record<string, unknown>).relayerBalanceTopUp = relayerFunding;

    const infoResponse = await fetchJson(`${harness.baseUrl}/info`);
    const relayerEstimate = await context.snap.estimateRelayedWithdrawal(
      poolInfo.address,
      harness.baseUrl,
    );
    (relayerArtifact.config as Record<string, unknown>).info = infoResponse;

    const existingRelayedRecord = findReusableRelayedNote(relayerNotes, poolInfo.address);
    const relayedDeposit = existingRelayedRecord
      ? {
          note: noteRecordToNote(existingRelayedRecord),
          signature: existingRelayedRecord.depositSignature!,
        }
      : await journaledDeposit(
          context,
          relayerNotes,
          config.relayerNotesFile,
          poolInfo.address,
          config.depositAmountSol,
          "phase14a-relayed",
        );
    persistDevnetNoteJournal(config.relayerNotesFile, relayerNotes);

    const poolState = await fetchPoolState(
      context.program,
      context.connection,
      poolInfo.address,
    );
    const signedRequest = await createSignedRelayRequest(
      poolInfo.address,
      relayedDeposit.note,
      poolState,
      relayedRecipient.publicKey,
      relayerEstimate.relayerFeeRaw,
      context.payer,
    );
    const [relayedNullifierRecord] = deriveNullifierRecordPda(
      poolInfo.address,
      relayedDeposit.note.nullifierHash,
      context.program.programId,
    );
    const relayedBefore = await fetchBalanceSet(
      context.connection,
      treasuryAddress,
      relayer.publicKey,
      relayedRecipient.publicKey,
    );

    const relayStartedAt = Date.now();
    const relayResponse = await postJson(`${harness.baseUrl}/relay`, signedRequest);
    const relayLatencyMs = Date.now() - relayStartedAt;
    const relayTxSignature =
      relayResponse.status === 200 &&
      relayResponse.body &&
      typeof relayResponse.body === "object" &&
      typeof relayResponse.body.txSignature === "string"
        ? relayResponse.body.txSignature
        : null;
    if (relayResponse.status !== 200 || !relayTxSignature) {
      throw new Error(
        `Phase 14A relayed canary failed with status ${relayResponse.status}: ${JSON.stringify(relayResponse.body)}`,
      );
    }

    const relayTx = await fetchTransactionWithRetries(
      context.connection,
      relayTxSignature,
    );
    const relayedAfter = await fetchBalanceSet(
      context.connection,
      treasuryAddress,
      relayer.publicKey,
      relayedRecipient.publicKey,
      relayedBefore,
    );
    const relayerFeeObservedRaw = computeObservedRelayerFee(
      relayTx,
      relayer.publicKey,
      relayedNullifierRecord,
    );

    markDevnetNoteWithdrawn(relayerNotes, relayedDeposit.note, relayTxSignature);
    persistDevnetNoteJournal(config.relayerNotesFile, relayerNotes);

    relayerArtifact.requests = [
      {
        note: {
          amount: config.depositAmountSol,
          assetType: "sol",
          depositIndex: relayedDeposit.note.depositIndex,
          depositSignature: relayedDeposit.signature,
          nullifierHash: bytesToHex(relayedDeposit.note.nullifierHash),
          pool: poolInfo.address.toBase58(),
        },
        noteStateAtScenarioEnd: {
          depositState: "confirmed",
          withdrawalSignature: relayTxSignature,
          withdrawn: true,
        },
        persistedRelayRecord: null,
        requestIndex: 0,
        stage: "phase14a-relayed",
        surfaced: {
          classification: "success",
          error: null,
          httpStatus: relayResponse.status,
          retryAfterSeconds: null,
          txSignature: relayTxSignature,
        },
      },
    ];
    relayerArtifact.scenario = {
      accepted: 1,
      attempted: 1,
      concurrency: 1,
      httpStatuses: {
        "200": 1,
      },
      mode: "default-limits",
      noteJournalPath: path.resolve("devnet-results", config.relayerNotesFile),
      relayer: relayer.publicKey.toBase58(),
      txSignatures: [relayTxSignature],
    };
    relayerArtifact.split = {
      matchedExpectation:
        relayedAfter.treasury.delta === relayerEstimate.protocolFeeRaw &&
        relayerFeeObservedRaw === relayerEstimate.relayerFeeRaw &&
        relayedAfter.recipient.delta === relayerEstimate.recipientAmountRaw,
      protocolFeeExpectedRaw: relayerEstimate.protocolFeeRaw,
      protocolFeeObservedRaw: relayedAfter.treasury.delta,
      recipientAmountExpectedRaw: relayerEstimate.recipientAmountRaw,
      recipientAmountObservedRaw: relayedAfter.recipient.delta,
      relayerFeeExpectedRaw: relayerEstimate.relayerFeeRaw,
      relayerFeeObservedRaw: relayerFeeObservedRaw ?? relayedAfter.relayer.delta,
      relayerNetBalanceDeltaRaw: relayedAfter.relayer.delta,
      requestLatencyMs: relayLatencyMs,
      requestResult: relayResponse.body,
      txError: relayTx?.meta?.err ? JSON.stringify(relayTx.meta.err) : null,
      txInstruction: findInstructionLog(relayTx?.meta, "WithdrawZkRelayedFeeV2"),
    };
    relayerArtifact.balances.treasury = relayedAfter.treasury;
    relayerArtifact.balances.relayer = relayedAfter.relayer;
    relayerArtifact.balances.recipient = relayedAfter.recipient;
    writeArtifact(config.relayerOutputFile, relayerArtifact);

    const replayResponse = await postJson(`${harness.baseUrl}/relay`, signedRequest);
    relayerArtifact.replay = {
      exactSameSignedRequest: true,
      expectedStatus: 409,
      matchedExpectation: replayResponse.status === 409,
      response: {
        body: replayResponse.body,
        status: replayResponse.status,
      },
    };
    relayerArtifact.nonSuccessResponses.push({
      body: replayResponse.body,
      classification: replayResponse.status === 409 ? "duplicate-signed-request" : "unexpected",
      label: "exact-signed-request-replay",
      status: replayResponse.status,
    });

    try {
      await context.snap.withdraw(
        poolInfo.address,
        relayedDeposit.note,
        relayedRecipient.publicKey,
      );
      relayerArtifact.duplicateWithdraw = {
        exactError: "Duplicate withdrawal unexpectedly succeeded",
        matchedExpectation: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      relayerArtifact.duplicateWithdraw = {
        exactError: message,
        matchedExpectation: message.includes(PROGRAM_ERROR_MESSAGES[6003]),
      };
    }
    writeArtifact(config.relayerOutputFile, relayerArtifact);

    const recoveryArtifact = await recoverUnresolvedNotes(
      context.connection,
      context.snap,
      metadata,
      relayerNotes,
      config.relayerRecoveryFile,
    );
    const reconciliationArtifact = buildReconciliationArtifact(
      metadata,
      config.relayerOutputFile,
      config.relayerNotesFile,
      config.relayerRecoveryFile,
      relayerArtifact,
      recoveryArtifact,
    );
    writeArtifact(config.relayerReconciliationFile, reconciliationArtifact);

    await stopRelayerHarness(harness);
    harness = undefined;

    const cleanup = await drainTemporaryAccounts(
      context.connection,
      context.payer,
      treasury,
      directRecipient,
      relayedRecipient,
      relayer,
    );
    (directArtifact as Record<string, unknown>).cleanup = cleanup;
    (relayerArtifact as Record<string, unknown>).cleanup = cleanup;
    cleanupCompleted = true;

    const payerAfter = await context.connection.getBalance(
      context.payer.publicKey,
      "confirmed",
    );
    (directArtifact.balances as Record<string, unknown>).payer = {
      after: payerAfter,
      before: payerBeforeScript,
      delta: payerAfter - payerBeforeScript,
      phaseBefore: config.phaseStartBalanceLamports,
      phaseDelta:
        config.phaseStartBalanceLamports === null
          ? null
          : payerAfter - config.phaseStartBalanceLamports,
    };
    relayerArtifact.balances.payer = {
      after: payerAfter,
      before: payerBeforeScript,
      delta: payerAfter - payerBeforeScript,
      phaseBefore: config.phaseStartBalanceLamports,
      phaseDelta:
        config.phaseStartBalanceLamports === null
          ? null
          : payerAfter - config.phaseStartBalanceLamports,
    };

    writeArtifact(config.directOutputFile, directArtifact);
    writeArtifact(config.relayerOutputFile, relayerArtifact);

    const totalPhaseSpend =
      config.phaseStartBalanceLamports === null
        ? payerBeforeScript - payerAfter
        : config.phaseStartBalanceLamports - payerAfter;
    if (totalPhaseSpend > config.burnRiskLamports) {
      throw new Error(
        `Phase 14A spent ${totalPhaseSpend} lamports, exceeding the approved envelope of ${config.burnRiskLamports}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          directArtifact,
          relayerArtifact,
          recoveryArtifact,
          reconciliationArtifact,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!cleanupCompleted) {
      try {
        const cleanup = await drainTemporaryAccounts(
          context.connection,
          context.payer,
          treasury,
          directRecipient,
          relayedRecipient,
          relayer,
        );
        (directArtifact as Record<string, unknown>).cleanup = cleanup;
        (relayerArtifact as Record<string, unknown>).cleanup = cleanup;
        writeArtifact(config.directOutputFile, directArtifact);
        writeArtifact(config.relayerOutputFile, relayerArtifact);
      } catch (cleanupError) {
        (directArtifact as Record<string, unknown>).cleanupError =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        (relayerArtifact as Record<string, unknown>).cleanupError =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        writeArtifact(config.directOutputFile, directArtifact);
        writeArtifact(config.relayerOutputFile, relayerArtifact);
      }
    }

    await stopRelayerHarness(harness);
    closeDevnetContext(context);
  }
}

async function collectDeploymentEvidence(
  connection: Connection,
): Promise<Record<string, unknown>> {
  const show = loadProgramShowJson();
  const history = loadProgramHistory(show.programdataAddress);
  const upgradeSignature = history[0]?.signature ?? null;
  const extensionSignature = history[1]?.signature ?? null;
  const upgradeTx = upgradeSignature
    ? await fetchTransactionWithRetries(connection, upgradeSignature)
    : null;
  const extensionTx = extensionSignature
    ? await fetchTransactionWithRetries(connection, extensionSignature)
    : null;
  const dumpPath = path.join(os.tmpdir(), "phase14a-devnet-dump.so");
  execFileSync("solana", [
    "program",
    "dump",
    "--url",
    "devnet",
    "AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3",
    dumpPath,
  ]);
  const localBinary = fs.readFileSync(path.resolve("target/deploy/agent_privacy_pool.so"));
  const deployedBinary = fs.readFileSync(dumpPath);

  return {
    dataLen: show.dataLen,
    deployedBinaryBytes: deployedBinary.length,
    deployedPrefixMatchesLocal:
      deployedBinary.length >= localBinary.length &&
      localBinary.equals(deployedBinary.subarray(0, localBinary.length)),
    deploymentState:
      deployedBinary.length >= localBinary.length &&
      localBinary.equals(deployedBinary.subarray(0, localBinary.length))
        ? "matches-local-binary"
        : "differs-from-local-binary",
    extension: {
      blockTimeUtc:
        extensionTx?.blockTime === null || extensionTx?.blockTime === undefined
          ? null
          : new Date(extensionTx.blockTime * 1000).toISOString(),
      signature: extensionSignature,
      slot: extensionTx?.slot ?? null,
    },
    lastDeploySlot: show.lastDeploySlot,
    localBinaryBytes: localBinary.length,
    programDataAddress: show.programdataAddress,
    programId: show.programId,
    trailingZeroPaddingBytes: Math.max(0, deployedBinary.length - localBinary.length),
    upgrade: {
      blockTimeUtc:
        upgradeTx?.blockTime === null || upgradeTx?.blockTime === undefined
          ? null
          : new Date(upgradeTx.blockTime * 1000).toISOString(),
      signature: upgradeSignature,
      slot: upgradeTx?.slot ?? null,
    },
    upgradeAuthority: show.authority,
    zeroPaddingMatchesExpectation:
      deployedBinary.length - localBinary.length === ACCOUNT_PADDING_BYTES &&
      deployedBinary.subarray(localBinary.length).every((byte) => byte === 0),
  };
}

async function createFeeSolPoolWithSignature(
  connection: Connection,
  snap: ReturnType<typeof createDevnetContext>["snap"],
  payer: PublicKey,
  depositAmount: number,
  treasury: PublicKey,
  protocolFeeBps: number,
  treeDepth: number,
): Promise<{ instruction: string | null; pool: PublicKey; signature: string }> {
  const seen = await recentSignatures(connection, payer);
  const pool = await snap.createPool(depositAmount, {
    protocolFeeBps,
    treasury,
    treeDepth,
  });
  const signature = await waitForNewSignature(
    connection,
    payer,
    seen,
    "phase14a create fee pool",
    60_000,
  );
  const tx = await fetchTransactionWithRetries(connection, signature);

  return {
    instruction: findInstructionLog(tx?.meta, "InitializeFeeV2"),
    pool,
    signature,
  };
}

async function journaledDeposit(
  context: ReturnType<typeof createDevnetContext>,
  journal: DevnetNoteJournal,
  fileName: string,
  pool: PublicKey,
  amount: number,
  stage: string,
): Promise<{ note: Note; signature: string }> {
  const seen = await recentSignatures(context.connection, context.payer.publicKey);
  const note = await context.snap.deposit(pool, amount);
  recordPlannedDevnetNote(journal, note, {
    amount,
    assetType: "sol",
    stage,
  });
  persistDevnetNoteJournal(fileName, journal);

  const signature = await waitForNewSignature(
    context.connection,
    context.payer.publicKey,
    seen,
    `${stage} deposit`,
    60_000,
  );
  markDevnetNoteDeposited(journal, note, signature);
  persistDevnetNoteJournal(fileName, journal);
  return {
    note,
    signature,
  };
}

async function runDirectCanary(
  connection: Connection,
  snap: ReturnType<typeof createDevnetContext>["snap"],
  pool: PublicKey,
  note: Note,
  recipient: PublicKey,
  treasury: PublicKey,
  protocolFeeExpectedRaw: number,
  recipientAmountExpectedRaw: number,
  depositSignature: string,
  createPoolSignature: string,
): Promise<DirectCanaryResult> {
  const treasuryBefore = await connection.getBalance(treasury, "confirmed");
  const recipientBefore = await connection.getBalance(recipient, "confirmed");
  const result = await snap.withdrawWithResult(pool, note, recipient);
  const withdrawTx = await fetchTransactionWithRetries(connection, result.txSignature);
  const treasuryAfter = await connection.getBalance(treasury, "confirmed");
  const recipientAfter = await connection.getBalance(recipient, "confirmed");

  return {
    matchedExpectation:
      (withdrawTx?.meta?.err ?? null) === null &&
      treasuryAfter - treasuryBefore === protocolFeeExpectedRaw &&
      recipientAfter - recipientBefore === recipientAmountExpectedRaw &&
      result.protocolFeeRaw === protocolFeeExpectedRaw &&
      result.recipientAmountRaw === recipientAmountExpectedRaw,
    observedInstruction: findInstructionLog(withdrawTx?.meta, "WithdrawZkFeeV2"),
    protocolFeeExpectedRaw,
    protocolFeeObservedRaw: treasuryAfter - treasuryBefore,
    recipientAmountExpectedRaw,
    recipientAmountObservedRaw: recipientAfter - recipientBefore,
    recipientResult: {
      address: recipient.toBase58(),
      after: recipientAfter,
      before: recipientBefore,
      delta: recipientAfter - recipientBefore,
    },
    signatures: {
      createPool: createPoolSignature,
      deposit: depositSignature,
      withdraw: result.txSignature,
    },
    treasuryResult: {
      address: treasury.toBase58(),
      after: treasuryAfter,
      before: treasuryBefore,
      delta: treasuryAfter - treasuryBefore,
    },
    txError: withdrawTx?.meta?.err ? JSON.stringify(withdrawTx.meta.err) : null,
  };
}

async function recoverUnresolvedNotes(
  connection: Connection,
  snap: ReturnType<typeof createDevnetContext>["snap"],
  metadata: ReturnType<typeof buildMetadata>,
  journal: DevnetNoteJournal,
  outputFile: string,
): Promise<RecoveryArtifact> {
  const payer = new PublicKey(metadata.wallet);
  const payerBalanceBefore = await connection.getBalance(payer, "confirmed");
  const unresolved = journal.notes.filter((record) => !record.withdrawn);
  const attempts: RecoveryArtifact["attempts"] = [];

  for (const record of unresolved) {
    const note = noteRecordToNote(record);
    try {
      const signature = await snap.withdraw(new PublicKey(record.pool), note, payer);
      markDevnetNoteWithdrawn(journal, note, signature);
      attempts.push({
        depositIndex: record.depositIndex,
        error: null,
        nullifierHash: record.nullifierHash,
        pool: record.pool,
        stage: record.stage,
        status: "recovered",
        withdrawalSignature: signature,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(PROGRAM_ERROR_MESSAGES[6003])) {
        attempts.push({
          depositIndex: record.depositIndex,
          error: null,
          nullifierHash: record.nullifierHash,
          pool: record.pool,
          stage: record.stage,
          status: "already-withdrawn",
          withdrawalSignature: record.withdrawalSignature,
        });
        continue;
      }

      attempts.push({
        depositIndex: record.depositIndex,
        error: message,
        nullifierHash: record.nullifierHash,
        pool: record.pool,
        stage: record.stage,
        status: "failed",
        withdrawalSignature: null,
      });
    }
  }

  const payerBalanceAfter = await connection.getBalance(payer, "confirmed");
  const artifact: RecoveryArtifact = {
    attempts,
    balances: {
      payer: {
        after: payerBalanceAfter,
        before: payerBalanceBefore,
        delta: payerBalanceAfter - payerBalanceBefore,
      },
    },
    metadata,
    summary: {
      alreadyWithdrawn: attempts.filter((attempt) => attempt.status === "already-withdrawn").length,
      failed: attempts.filter((attempt) => attempt.status === "failed").length,
      recovered: attempts.filter((attempt) => attempt.status === "recovered").length,
      unresolvedFound: unresolved.length,
    },
  };
  writeArtifact(outputFile, artifact);
  return artifact;
}

function buildReconciliationArtifact(
  metadata: ReturnType<typeof buildMetadata>,
  validationArtifactPath: string,
  noteJournalPath: string,
  recoveryArtifactPath: string,
  relayerArtifact: Phase14aRelayerArtifact,
  recoveryArtifact: RecoveryArtifact,
): ReconciliationArtifact {
  const request = relayerArtifact.requests[0];
  const recovered = recoveryArtifact.attempts.find(
    (attempt) => attempt.nullifierHash === request.note.nullifierHash,
  );

  return {
    inputs: {
      noteJournalPath: path.resolve("devnet-results", noteJournalPath),
      recoveryArtifactPath: path.resolve("devnet-results", recoveryArtifactPath),
      validationArtifactPath: path.resolve("devnet-results", validationArtifactPath),
    },
    metadata,
    requests: [
      {
        bucket: "confirmed-success-surfaced-success",
        note: {
          amount: request.note.amount,
          depositIndex: request.note.depositIndex,
          nullifierHash: request.note.nullifierHash,
          pool: request.note.pool,
          stage: request.stage,
        },
        recovery: {
          needed: false,
          status: "not-needed",
          withdrawalSignature: recovered?.withdrawalSignature ?? request.surfaced.txSignature,
        },
        surfaced: {
          classification: "success",
          error: request.surfaced.error,
          httpStatus: request.surfaced.httpStatus,
          txSignature: request.surfaced.txSignature,
        },
        truth: {
          alreadySpentOnChainDespiteNonSuccess: false,
          laterRecoveredManually: false,
          withdrawalSignature: request.noteStateAtScenarioEnd.withdrawalSignature,
          withdrawn: request.noteStateAtScenarioEnd.withdrawn,
        },
      },
    ],
    summary: {
      bucketCounts: {
        "confirmed-success-surfaced-success": 1,
        "surfaced-failure-already-withdrawn-on-chain": 0,
        "surfaced-failure-required-recovery": 0,
      },
      unresolvedRelayedNotes: recoveryArtifact.summary.unresolvedFound,
    },
  };
}

async function drainTemporaryAccounts(
  connection: Connection,
  payer: Keypair,
  treasury: Keypair | null,
  directRecipient: Keypair | null,
  relayedRecipient: Keypair,
  relayer: Keypair,
): Promise<Record<string, unknown>> {
  return {
    directRecipient: await drainOptionalSystemAccountBalance(
      connection,
      directRecipient,
      payer,
    ),
    relayedRecipient: await drainSystemAccountBalance(
      connection,
      relayedRecipient,
      payer.publicKey,
      0,
      payer,
    ),
    relayer: await drainSystemAccountBalance(
      connection,
      relayer,
      payer.publicKey,
      20_000,
      payer,
    ),
    treasury: await drainOptionalSystemAccountBalance(connection, treasury, payer),
  };
}

async function drainOptionalSystemAccountBalance(
  connection: Connection,
  source: Keypair | null,
  payer: Keypair,
): Promise<
  | {
      balanceAfter: number;
      balanceBefore: number;
      refundLamports: number;
      refundSignature: string | null;
    }
  | { skipped: true }
> {
  if (!source) {
    return { skipped: true };
  }

  return drainSystemAccountBalance(
    connection,
    source,
    payer.publicKey,
    0,
    payer,
  );
}

async function fundTemporaryAccounts(
  connection: Connection,
  payer: Keypair,
  accounts: Keypair[],
  lamportsEach: number,
): Promise<void> {
  for (const account of accounts) {
    const signature = await connection.requestAirdrop(account.publicKey, 0).catch(() => null);
    if (signature) {
      await connection.confirmTransaction(signature, "confirmed");
    }
    const transferSignature = await connection.sendTransaction(
      new (await import("@solana/web3.js")).Transaction().add(
        (await import("@solana/web3.js")).SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          lamports: lamportsEach,
          toPubkey: account.publicKey,
        }),
      ),
      [payer],
    );
    await connection.confirmTransaction(transferSignature, "confirmed");
  }
}

async function fetchBalanceSet(
  connection: Connection,
  treasury: PublicKey,
  relayer: PublicKey,
  recipient: PublicKey,
  before?: {
    recipient: BalanceDelta;
    relayer: BalanceDelta;
    treasury: BalanceDelta;
  },
): Promise<{
  recipient: BalanceDelta;
  relayer: BalanceDelta;
  treasury: BalanceDelta;
}> {
  const [treasuryBalance, relayerBalance, recipientBalance] = await Promise.all([
    connection.getBalance(treasury, "confirmed"),
    connection.getBalance(relayer, "confirmed"),
    connection.getBalance(recipient, "confirmed"),
  ]);

  return {
    recipient: {
      address: recipient.toBase58(),
      after: recipientBalance,
      before: before?.recipient.after ?? recipientBalance,
      delta: recipientBalance - (before?.recipient.after ?? recipientBalance),
    },
    relayer: {
      address: relayer.toBase58(),
      after: relayerBalance,
      before: before?.relayer.after ?? relayerBalance,
      delta: relayerBalance - (before?.relayer.after ?? relayerBalance),
    },
    treasury: {
      address: treasury.toBase58(),
      after: treasuryBalance,
      before: before?.treasury.after ?? treasuryBalance,
      delta: treasuryBalance - (before?.treasury.after ?? treasuryBalance),
    },
  };
}

function noteRecordToNote(record: DevnetNoteRecord): Note {
  return {
    commitment: Uint8Array.from(Buffer.from(record.commitment, "hex")),
    depositIndex: record.depositIndex,
    nullifier: BigInt(record.nullifier),
    nullifierHash: Uint8Array.from(Buffer.from(record.nullifierHash, "hex")),
    poolAddress: record.pool,
    secret: BigInt(record.secret),
  };
}

function findReusableRelayedNote(
  journal: DevnetNoteJournal,
  pool: PublicKey,
): DevnetNoteRecord | null {
  return (
    journal.notes.find(
      (record) =>
        record.pool === pool.toBase58() &&
        record.stage === "phase14a-relayed" &&
        record.depositState === "confirmed" &&
        record.withdrawn === false &&
        record.depositSignature !== null,
    ) ?? null
  );
}

function loadConfig(): Phase14aConfig {
  const rpcUrl = process.env.SNAP_RPC_URL ?? clusterApiUrl("devnet");
  const payerPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const burnRiskLamports = parseIntegerEnv(
    process.env.SNAP_PHASE14A_SPEND_ENVELOPE_LAMPORTS,
    DEFAULT_BURN_RISK_LAMPORTS,
  );
  const phaseStartBalanceLamports = process.env.SNAP_PHASE14A_PHASE_START_BALANCE_LAMPORTS
    ? Number.parseInt(process.env.SNAP_PHASE14A_PHASE_START_BALANCE_LAMPORTS, 10)
    : null;

  return {
    approvalRecorded: process.env.SNAP_PHASE14A_APPROVAL_RECORDED === "1",
    burnRiskLamports,
    directNotesFile: process.env.SNAP_PHASE14A_NOTES_FILE ?? DEFAULT_DIRECT_NOTES_FILE,
    directOutputFile: process.env.SNAP_PHASE14A_OUTPUT_FILE ?? DEFAULT_DIRECT_OUTPUT_FILE,
    depositAmountSol: parseFloatEnv(
      process.env.SNAP_PHASE14A_DEPOSIT_AMOUNT_SOL,
      DEFAULT_DIRECT_DEPOSIT_AMOUNT_SOL,
    ),
    existingPoolAddress: process.env.SNAP_PHASE14A_EXISTING_POOL_ADDRESS ?? null,
    existingTreasuryAddress: process.env.SNAP_PHASE14A_EXISTING_TREASURY_ADDRESS ?? null,
    payerPath,
    phaseStartBalanceLamports,
    protocolFeeBps: parseIntegerEnv(
      process.env.SNAP_PHASE14A_PROTOCOL_FEE_BPS,
      DEFAULT_PROTOCOL_FEE_BPS,
    ),
    relayerFeeBps: parseIntegerEnv(
      process.env.SNAP_PHASE14A_RELAYER_FEE_BPS,
      DEFAULT_RELAYER_FEE_BPS,
    ),
    relayerMinFeeLamports: parseIntegerEnv(
      process.env.SNAP_PHASE14A_RELAYER_MIN_FEE_LAMPORTS,
      DEFAULT_RELAYER_MIN_FEE_LAMPORTS,
    ),
    relayerNotesFile:
      process.env.SNAP_PHASE14A_RELAYER_NOTES_FILE ?? DEFAULT_RELAYER_NOTES_FILE,
    relayerOutputFile:
      process.env.SNAP_PHASE14A_RELAYER_OUTPUT_FILE ?? DEFAULT_RELAYER_OUTPUT_FILE,
    relayerRecoveryFile:
      process.env.SNAP_PHASE14A_RELAYER_RECOVERY_FILE ?? DEFAULT_RELAYER_RECOVERY_FILE,
    relayerReconciliationFile:
      process.env.SNAP_PHASE14A_RELAYER_RECONCILIATION_FILE ??
      DEFAULT_RELAYER_RECONCILIATION_FILE,
    relayerTargetLamports: parseIntegerEnv(
      process.env.SNAP_PHASE14A_RELAYER_TARGET_LAMPORTS,
      DEFAULT_RELAYER_TARGET_LAMPORTS,
    ),
    rpcUrl,
    tempAccountFundingLamports: parseIntegerEnv(
      process.env.SNAP_PHASE14A_TEMP_ACCOUNT_FUNDING_LAMPORTS,
      DEFAULT_TEMP_ACCOUNT_FUNDING_LAMPORTS,
    ),
    treeDepth: parseIntegerEnv(process.env.SNAP_PHASE14A_TREE_DEPTH, DEFAULT_TREE_DEPTH),
  };
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

function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid float value: ${value}`);
  }
  return parsed;
}

function loadProgramShowJson(): DeploymentShowJson {
  return JSON.parse(
    execFileSync(
      "solana",
      [
        "program",
        "show",
        "--url",
        "devnet",
        "--output",
        "json-compact",
        "AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3",
      ],
      {
        encoding: "utf8",
      },
    ),
  ) as DeploymentShowJson;
}

function loadProgramHistory(programDataAddress: string): HistoryEntry[] {
  return JSON.parse(
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
  ) as HistoryEntry[];
}

async function fetchTransactionWithRetries(
  connection: Connection,
  signature: TransactionSignature,
  attempts = 20,
  delayMs = 1000,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      return tx;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

function findInstructionLog(
  meta: ConfirmedTransactionMeta | null | undefined,
  instructionName: string,
): string | null {
  const logs = meta?.logMessages ?? [];
  return logs.find((line) => line.includes(`Instruction: ${instructionName}`)) ?? null;
}

function computeObservedRelayerFee(
  tx: ParsedTransactionWithMeta | null,
  relayer: PublicKey,
  nullifierRecord: PublicKey,
): number | null {
  const meta = tx?.meta;
  if (!meta) {
    return null;
  }

  const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const relayerIndex = accountKeys.findIndex((key) => key.equals(relayer));
  const nullifierIndex = accountKeys.findIndex((key) => key.equals(nullifierRecord));
  if (relayerIndex < 0) {
    return null;
  }

  const relayerNetDelta =
    meta.postBalances[relayerIndex]! - meta.preBalances[relayerIndex]!;
  const nullifierRent =
    nullifierIndex >= 0
      ? meta.postBalances[nullifierIndex]! - meta.preBalances[nullifierIndex]!
      : 0;

  return relayerNetDelta + meta.fee + nullifierRent;
}

async function recentSignatures(
  connection: Connection,
  address: PublicKey,
): Promise<Set<string>> {
  return new Set(
    (
      await connection.getSignaturesForAddress(address, { limit: 20 }, "confirmed")
    ).map((entry) => entry.signature),
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  return response.json();
}

function writeArtifact(fileName: string, value: unknown): void {
  const outputPath = path.resolve("devnet-results", fileName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readArtifact<T>(fileName: string): T | null {
  const outputPath = path.resolve("devnet-results", fileName);
  if (!fs.existsSync(outputPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(outputPath, "utf8")) as T;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
