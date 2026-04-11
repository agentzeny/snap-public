import {
  BorshAccountsCoder,
  BorshInstructionCoder,
  type Idl,
} from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { bytesToHex } from "./commitment";
import {
  COMMITMENT_PAGE_CAPACITY,
  decodeCommitmentPageState,
  deriveCommitmentPagePda,
  mergeCommitmentSources,
} from "./commitment-pages";
import {
  LEGACY_TREE_DEPTH,
  ROOT_HISTORY_SIZE,
  SNAP_IDL,
  SNAP_PROGRAM_ID,
} from "./constants";
import { deriveAgentKey, extractViewingKey, type MasterKeyPair, type ViewingKeyBundle } from "./keys";
import { decryptNoteWithViewingKey } from "./keys";
import { getEncryptedNotesForPool } from "./note-registry";
import type { TransactionRecord } from "./types";
import { getRecordField, normalizeBytesMatrix, toNumber } from "./utils";

interface PoolAccountState {
  depositAmountRaw: number;
  displayAmount: number;
  commitments: Uint8Array[];
  usedNullifiers: Uint8Array[];
  rootCount: number;
  roots: Uint8Array[];
  tokenMint: PublicKey | null;
  treeDepth: number;
  nullifierVersion: number;
}

interface PoolScanContext {
  state: PoolAccountState;
  depositSlots: Map<number, number>;
  withdrawalSlots: Map<string, number>;
}

const ACCOUNT_CODER = new BorshAccountsCoder(SNAP_IDL as Idl);
const INSTRUCTION_CODER = new BorshInstructionCoder(SNAP_IDL as Idl);
const LEGACY_POOL_ACCOUNT_NAME = "Pool";
const FEE_V2_POOL_ACCOUNT_NAME = "PoolFeeV2";
const V2_POOL_ACCOUNT_NAME = "PoolV2";

export async function reconstructHistory(
  connection: Connection,
  poolAddress: PublicKey,
  viewingKey: ViewingKeyBundle,
): Promise<TransactionRecord[]> {
  const scan = await scanPool(connection, poolAddress);
  return scanPoolForViewingKey(poolAddress, viewingKey, scan);
}

export async function auditPool(
  connection: Connection,
  poolAddress: PublicKey,
  masterKey: MasterKeyPair,
  maxAgentIndex: number,
): Promise<Map<string, TransactionRecord[]>> {
  if (!Number.isInteger(maxAgentIndex) || maxAgentIndex < 0) {
    throw new Error("SNAP: maxAgentIndex must be a non-negative integer");
  }

  const scan = await scanPool(connection, poolAddress);
  const results = new Map<string, TransactionRecord[]>();

  for (let index = 0; index <= maxAgentIndex; index += 1) {
    const agentKey = deriveAgentKey(masterKey, index);
    const viewingKey = extractViewingKey(agentKey);
    const history = scanPoolForViewingKey(poolAddress, viewingKey, scan);

    if (history.length > 0) {
      results.set(viewingKey.agentId, history);
    }
  }

  return results;
}

async function scanPool(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<PoolScanContext> {
  const state = await fetchPoolState(connection, poolAddress);
  const { depositSlots, withdrawalSlots } = await buildTimeline(connection, poolAddress);

  return { state, depositSlots, withdrawalSlots };
}

function scanPoolForViewingKey(
  poolAddress: PublicKey,
  viewingKey: ViewingKeyBundle,
  scan: PoolScanContext,
): TransactionRecord[] {
  const poolNotes = getEncryptedNotesForPool(poolAddress.toBase58());
  const notesByCommitment = new Map(
    poolNotes.map((record) => [bytesToHex(record.commitment), record]),
  );
  const usedNullifierSet = new Set(
    scan.state.usedNullifiers.map((value) => bytesToHex(value)),
  );
  for (const nullifierHash of scan.withdrawalSlots.keys()) {
    usedNullifierSet.add(nullifierHash);
  }

  const amount = scan.state.displayAmount;
  const history: TransactionRecord[] = [];

  scan.state.commitments.forEach((commitment, commitmentIndex) => {
    const record = notesByCommitment.get(bytesToHex(commitment));
    if (!record) {
      return;
    }

    const note = decryptNoteWithViewingKey(viewingKey, record.encryptedNote);
    if (!note) {
      return;
    }

    const nullifierHex = bytesToHex(note.nullifierHash);
    const nullified = usedNullifierSet.has(nullifierHex);
    const depositTimestamp =
      scan.depositSlots.get(commitmentIndex) ?? record.depositIndex;

    history.push({
      type: "deposit",
      amount,
      timestamp: depositTimestamp,
      commitmentIndex,
      nullified,
    });

    if (nullified) {
      history.push({
        type: "withdrawal",
        amount,
        timestamp:
          scan.withdrawalSlots.get(nullifierHex) ?? depositTimestamp,
        commitmentIndex,
        nullified: true,
      });
    }
  });

  return history.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }

    if (left.type === right.type) {
      return left.commitmentIndex - right.commitmentIndex;
    }

    return left.type === "deposit" ? -1 : 1;
  });
}

async function fetchPoolState(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<PoolAccountState> {
  const accountInfo = await connection.getAccountInfo(poolAddress, "confirmed");
  if (!accountInfo) {
    throw new Error("SNAP: Pool not found — the specified pool account does not exist");
  }

  const rawData = Buffer.from(accountInfo.data);
  const account =
    tryDecodeAccount(FEE_V2_POOL_ACCOUNT_NAME, rawData) ??
    tryDecodeAccount(V2_POOL_ACCOUNT_NAME, rawData) ??
    tryDecodeAccount(LEGACY_POOL_ACCOUNT_NAME, rawData);

  if (!account) {
    throw new Error("SNAP: Pool account data does not match a supported pool layout");
  }
  const tokenMint = normalizePublicKey(getRecordField(account, "tokenMint", "token_mint"));
  const depositAmountRaw = toNumber(
    getRecordField(account, "depositAmount", "deposit_amount"),
  );
  const nextIndex = toNumber(getRecordField(account, "nextIndex", "next_index"));
  const inlineCommitments = normalizeBytesMatrix(
    getRecordField(account, "commitments"),
  );

  return {
    depositAmountRaw,
    displayAmount: await toDisplayAmount(connection, depositAmountRaw, tokenMint),
    commitments: await fetchCommitments(
      connection,
      poolAddress,
      nextIndex,
      inlineCommitments,
    ),
    usedNullifiers: normalizeBytesMatrix(
      getRecordField(account, "usedNullifiers", "used_nullifiers"),
    ),
    rootCount: toNumber(getRecordField(account, "rootCount", "root_count")),
    roots: normalizeBytesMatrix(getRecordField(account, "roots")).slice(
      0,
      ROOT_HISTORY_SIZE,
    ),
    tokenMint,
    treeDepth: tokenMint || "treeDepth" in account || "tree_depth" in account
      ? toNumber(getRecordField(account, "treeDepth", "tree_depth"))
      : LEGACY_TREE_DEPTH,
    nullifierVersion: "nullifierVersion" in account || "nullifier_version" in account
      ? toNumber(getRecordField(account, "nullifierVersion", "nullifier_version"))
      : 0,
  };
}

async function fetchCommitments(
  connection: Connection,
  poolAddress: PublicKey,
  nextIndex: number,
  inlineCommitments: Uint8Array[],
): Promise<Uint8Array[]> {
  if (nextIndex <= inlineCommitments.length) {
    return inlineCommitments;
  }

  const pageAddresses = Array.from(
    { length: Math.ceil(nextIndex / COMMITMENT_PAGE_CAPACITY) },
    (_, pageIndex) => deriveCommitmentPagePda(poolAddress, pageIndex)[0],
  );
  const infos = await connection.getMultipleAccountsInfo(pageAddresses, "confirmed");
  const pages = infos.flatMap((info) => {
    if (!info) {
      return [];
    }

    const decoded = tryDecodeAccount("CommitmentPage", Buffer.from(info.data));
    return decoded ? [decodeCommitmentPageState(decoded)] : [];
  });

  return mergeCommitmentSources({
    inlineCommitments,
    nextIndex,
    pages,
  });
}

async function buildTimeline(
  connection: Connection,
  poolAddress: PublicKey,
): Promise<{
  depositSlots: Map<number, number>;
  withdrawalSlots: Map<string, number>;
}> {
  const depositSlots = new Map<number, number>();
  const withdrawalSlots = new Map<string, number>();

  if (
    typeof connection.getSignaturesForAddress !== "function" ||
    typeof connection.getTransaction !== "function"
  ) {
    return { depositSlots, withdrawalSlots };
  }

  const signatures = await connection.getSignaturesForAddress(poolAddress, {
    limit: 1_000,
  }, "confirmed");
  let depositIndex = 0;

  for (const signatureInfo of [...signatures].reverse()) {
    const transaction = await connection.getTransaction(signatureInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) {
      continue;
    }

    const message = transaction.transaction.message as {
      compiledInstructions: Array<{
        programIdIndex: number;
        data: Uint8Array;
      }>;
      getAccountKeys: (args?: {
        accountKeysFromLookups?: {
          writable: PublicKey[];
          readonly: PublicKey[];
        };
      }) => {
        get(index: number): PublicKey | undefined;
      };
    };
    const accountKeys = message.getAccountKeys(
      transaction.meta?.loadedAddresses
        ? { accountKeysFromLookups: transaction.meta.loadedAddresses }
        : undefined,
    );

    for (const instruction of message.compiledInstructions) {
      const programId = accountKeys.get(instruction.programIdIndex);
      if (!programId || !programId.equals(SNAP_PROGRAM_ID)) {
        continue;
      }

      const decoded = INSTRUCTION_CODER.decode(Buffer.from(instruction.data));
      if (!decoded) {
        continue;
      }

      if (
        decoded.name === "deposit" ||
        decoded.name === "deposit_v2" ||
        decoded.name === "deposit_spl" ||
        decoded.name === "deposit_fee_v2" ||
        decoded.name === "deposit_fee_spl"
      ) {
        depositSlots.set(depositIndex, transaction.slot);
        depositIndex += 1;
        continue;
      }

      if (
        decoded.name === "withdraw_zk" ||
        decoded.name === "withdraw_zk_v2" ||
        decoded.name === "withdraw_zk_spl" ||
        decoded.name === "withdraw_zk_fee_v2" ||
        decoded.name === "withdraw_zk_fee_spl"
      ) {
        const nullifierHash = Uint8Array.from(
          getRecordField(
            decoded.data as Record<string, unknown>,
            "nullifierHash",
            "nullifier_hash",
          ) as ArrayLike<number>,
        );
        withdrawalSlots.set(bytesToHex(nullifierHash), transaction.slot);
        continue;
      }

      if (decoded.name === "withdraw_zk_relayed") {
        const publicInputs = getRecordField(
          decoded.data as Record<string, unknown>,
          "publicInputs",
          "public_inputs",
        ) as ArrayLike<ArrayLike<number>>;
        const nullifierHash = Uint8Array.from(publicInputs[1]);
        withdrawalSlots.set(bytesToHex(nullifierHash), transaction.slot);
        continue;
      }

      if (
        decoded.name === "withdraw_zk_relayed_v2" ||
        decoded.name === "withdraw_zk_relayed_spl" ||
        decoded.name === "withdraw_zk_relayed_fee_v2" ||
        decoded.name === "withdraw_zk_relayed_fee_spl"
      ) {
        const nullifierHash = Uint8Array.from(
          getRecordField(
            decoded.data as Record<string, unknown>,
            "nullifierHash",
            "nullifier_hash",
          ) as ArrayLike<number>,
        );
        withdrawalSlots.set(bytesToHex(nullifierHash), transaction.slot);
      }
    }
  }

  return { depositSlots, withdrawalSlots };
}

function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

function normalizePublicKey(value: unknown): PublicKey | null {
  if (!value) {
    return null;
  }

  if (value instanceof PublicKey) {
    return value;
  }

  if (typeof value === "string") {
    return new PublicKey(value);
  }

  if (typeof value !== "object") {
    return null;
  }

  if (
    "toBase58" in value &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  ) {
    return new PublicKey(
      (value as { toBase58: () => string }).toBase58(),
    );
  }

  if (
    "toBytes" in value &&
    typeof (value as { toBytes?: unknown }).toBytes === "function"
  ) {
    return new PublicKey(
      (value as { toBytes: () => Uint8Array }).toBytes(),
    );
  }

  if (
    "toBuffer" in value &&
    typeof (value as { toBuffer?: unknown }).toBuffer === "function"
  ) {
    return new PublicKey(
      (value as { toBuffer: () => Uint8Array }).toBuffer(),
    );
  }

  if ("publicKey" in value) {
    return normalizePublicKey(
      (value as { publicKey?: unknown }).publicKey,
    );
  }

  return null;
}

async function toDisplayAmount(
  connection: Connection,
  rawAmount: number,
  tokenMint: PublicKey | null,
): Promise<number> {
  if (!tokenMint) {
    return lamportsToSol(rawAmount);
  }

  const mint = await getMint(connection, tokenMint, "confirmed");
  return rawAmount / 10 ** mint.decimals;
}

function tryDecodeAccount(
  accountName: string,
  data: Buffer,
): Record<string, unknown> | null {
  try {
    return ACCOUNT_CODER.decode(accountName, data) as Record<string, unknown>;
  } catch {
    return null;
  }
}
