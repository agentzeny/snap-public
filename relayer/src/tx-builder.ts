import {
  AnchorProvider,
  BN,
  Program,
  type Wallet,
} from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { PROGRAM_ERROR_MESSAGES, SNAP_IDL } from "@snap-protocol/sdk";
import { calculateFee } from "./fee-calculator";
import { RelayerError } from "./relay-handler";

export interface PoolAccountState {
  kind: "legacy" | "v2" | "feeV2";
  depositAmountRaw: number;
  roots: Uint8Array[];
  treeDepth: number;
  usedNullifiers: Uint8Array[];
  tokenMint: PublicKey | null;
  tokenDecimals: number | null;
  nullifierVersion: number;
  assetType: "sol" | "spl";
  feeCapable: boolean;
  protocolFeeBps: number;
  treasury: PublicKey | null;
}

interface SubmitRelayedWithdrawArgs {
  pool: PublicKey;
  recipient: PublicKey;
  proofABytes: number[];
  proofBBytes: number[];
  proofCBytes: number[];
  rootBytes: number[];
  nullifierHashBytes: number[];
  feeAmountRaw: number;
  poolState: PoolAccountState;
}

export interface SubmittedRelayTransaction {
  txSignature: string;
  lastValidBlockHeight: number;
}

export class AmbiguousSubmissionError extends RelayerError {
  constructor(
    message: string,
    readonly txSignature: string,
    readonly lastValidBlockHeight: number,
  ) {
    super(message, 500);
    this.name = "AmbiguousSubmissionError";
  }
}

export function isAmbiguousSubmissionError(
  error: unknown,
): error is AmbiguousSubmissionError {
  return error instanceof AmbiguousSubmissionError;
}

export interface RelayTransactionStatus {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown;
  found: boolean;
}

export interface RelayerRuntime {
  fetchPoolState(pool: PublicKey): Promise<PoolAccountState>;
  findNullifierSpendSignature(
    pool: PublicKey,
    poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<string | null>;
  isNullifierUsed(
    pool: PublicKey,
    poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<boolean>;
  submitRelayedWithdraw(args: SubmitRelayedWithdrawArgs): Promise<SubmittedRelayTransaction>;
  getSignatureStatus(txSignature: string): Promise<RelayTransactionStatus>;
  getCurrentBlockHeight(): Promise<number>;
  getRelayerBalance(): Promise<number>;
  getRelayerPublicKey(): PublicKey;
}

export interface RelayTransactionServiceOptions {
  runtime: RelayerRuntime;
  feeBps: number;
  minFeeLamports: number;
  supportedPools?: PublicKey[];
}

export class RelayTransactionService {
  private readonly runtime: RelayerRuntime;
  private readonly feeBps: number;
  private readonly minFeeLamports: number;
  private readonly supportedPools: PublicKey[];

  constructor(options: RelayTransactionServiceOptions) {
    this.runtime = options.runtime;
    this.feeBps = options.feeBps;
    this.minFeeLamports = options.minFeeLamports;
    this.supportedPools = options.supportedPools ?? [];
  }

  async relay(request: {
    pool: PublicKey;
    recipient: PublicKey;
    proofBytes: Uint8Array;
    rootBytes: Uint8Array;
    nullifierHashBytes: Uint8Array;
  }): Promise<{
    txSignature: string;
    fee: number;
    recipientReceived: number;
  }> {
    if (
      this.supportedPools.length > 0 &&
      !this.supportedPools.some((pool) => pool.equals(request.pool))
    ) {
      throw new RelayerError("Pool not supported by this relayer");
    }

    const poolState = await this.runtime.fetchPoolState(request.pool);
    if (
      await this.runtime.isNullifierUsed(
        request.pool,
        poolState,
        request.nullifierHashBytes,
      )
    ) {
      throw new RelayerError("Nullifier already used", 409);
    }

    const feeAmountRaw = calculateFee(
      poolState.depositAmountRaw,
      this.feeBps,
      poolState.assetType === "sol" ? this.minFeeLamports : 0,
    );
    if (feeAmountRaw >= poolState.depositAmountRaw) {
      throw new RelayerError("Configured relayer fee is too high for this pool", 500);
    }

    const { proofABytes, proofBBytes, proofCBytes } = splitProofBytes(request.proofBytes);
    const submitted = await this.runtime.submitRelayedWithdraw({
      pool: request.pool,
      recipient: request.recipient,
      proofABytes,
      proofBBytes,
      proofCBytes,
      rootBytes: Array.from(request.rootBytes),
      nullifierHashBytes: Array.from(request.nullifierHashBytes),
      feeAmountRaw,
      poolState,
    });

    return {
      txSignature: submitted.txSignature,
      fee: toDisplayAmount(feeAmountRaw, poolState),
      recipientReceived: toDisplayAmount(
        poolState.depositAmountRaw - feeAmountRaw,
        poolState,
      ),
    };
  }

  async getInfo(): Promise<{
    feePercent: number;
    minFee: number;
    supportedPools: string[];
    relayerBalance: number;
    relayer: string;
  }> {
    return {
      feePercent: this.feeBps / 100,
      minFee: lamportsToSol(this.minFeeLamports),
      supportedPools: this.supportedPools.map((pool) => pool.toBase58()),
      relayerBalance: lamportsToSol(await this.runtime.getRelayerBalance()),
      relayer: this.runtime.getRelayerPublicKey().toBase58(),
    };
  }
}

export class AnchorRelayerRuntime implements RelayerRuntime {
  private readonly connection: Connection;
  private readonly relayer: Keypair;
  private readonly programId: PublicKey;
  private readonly provider: AnchorProvider;
  private readonly program: Program;

  constructor(connection: Connection, relayer: Keypair, programId: PublicKey) {
    this.connection = connection;
    this.relayer = relayer;
    this.programId = programId;
    this.provider = new AnchorProvider(connection, toWalletAdapter(relayer) as Wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    this.program = new Program(
      { ...SNAP_IDL, address: this.programId.toBase58() } as never,
      this.provider,
    );
  }

  async fetchPoolState(pool: PublicKey): Promise<PoolAccountState> {
    const { account, kind } = await this.fetchDecodedPoolAccount(pool);
    const tokenMint = normalizePublicKey(getRecordField(account, "tokenMint", "token_mint"));
    const tokenDecimals =
      tokenMint === null
        ? null
        : (await getMint(this.connection, tokenMint, "confirmed")).decimals;

    return {
      kind,
      depositAmountRaw: toNumber(
        getRecordField(account, "depositAmount", "deposit_amount"),
      ),
      roots: normalizeBytesMatrix(getRecordField(account, "roots")),
      treeDepth:
        kind === "legacy"
          ? 10
          : toNumber(getRecordField(account, "treeDepth", "tree_depth")),
      usedNullifiers: normalizeBytesMatrix(
        getRecordField(account, "usedNullifiers", "used_nullifiers"),
      ),
      tokenMint,
      tokenDecimals,
      nullifierVersion:
        kind === "legacy"
          ? 0
          : toNumber(
              getRecordField(account, "nullifierVersion", "nullifier_version"),
            ),
      assetType: tokenMint ? "spl" : "sol",
      feeCapable: kind === "feeV2",
      protocolFeeBps:
        kind === "feeV2"
          ? toNumber(
              getRecordField(account, "protocolFeeBps", "protocol_fee_bps"),
            )
          : 0,
      treasury:
        kind === "feeV2"
          ? normalizePublicKey(getRecordField(account, "treasury"))
          : null,
    };
  }

  async isNullifierUsed(
    pool: PublicKey,
    poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<boolean> {
    if (poolState.nullifierVersion === 0) {
      return poolState.usedNullifiers.some((value) =>
        Buffer.from(value).equals(Buffer.from(nullifierHash)),
      );
    }

    const [nullifierRecord] = deriveNullifierRecordPda(
      pool,
      nullifierHash,
      this.programId,
    );
    const accountInfo = await this.connection.getAccountInfo(nullifierRecord, "confirmed");
    return accountInfo !== null;
  }

  async findNullifierSpendSignature(
    pool: PublicKey,
    poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<string | null> {
    if (poolState.nullifierVersion === 0) {
      return null;
    }

    const [nullifierRecord] = deriveNullifierRecordPda(
      pool,
      nullifierHash,
      this.programId,
    );
    const signatures = await this.connection.getSignaturesForAddress(
      nullifierRecord,
      { limit: 10 },
      "confirmed",
    );

    for (const entry of signatures) {
      if (entry.err !== null) {
        continue;
      }

      const tx = await this.connection.getTransaction(entry.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        continue;
      }

      const accountKeys = tx.transaction.message
        .getAccountKeys()
        .staticAccountKeys;
      if (accountKeys.some((key) => key.equals(this.relayer.publicKey))) {
        return entry.signature;
      }
    }

    return null;
  }

  async submitRelayedWithdraw(
    args: SubmitRelayedWithdrawArgs,
  ): Promise<SubmittedRelayTransaction> {
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const transaction = await this.buildRelayedWithdrawTransaction(args);
    transaction.feePayer = this.relayer.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.sign(this.relayer);
    const txSignature = getTransactionSignature(transaction);

    try {
      await this.connection.sendRawTransaction(
        transaction.serialize(),
        {
          maxRetries: 0,
          preflightCommitment: "confirmed",
        },
      );

      return {
        txSignature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      };
    } catch (error) {
      const readableError = toReadableError(error, 500);
      if (isDefinitiveSendFailure(error, readableError)) {
        throw readableError;
      }

      throw new AmbiguousSubmissionError(
        readableError.message,
        txSignature,
        latestBlockhash.lastValidBlockHeight,
      );
    }
  }

  async getSignatureStatus(txSignature: string): Promise<RelayTransactionStatus> {
    const response = await this.connection.getSignatureStatuses([txSignature]);
    const status = response.value[0];
    if (!status) {
      return {
        confirmationStatus: null,
        err: null,
        found: false,
      };
    }

    return {
      confirmationStatus: status.confirmationStatus ?? null,
      err: status.err,
      found: true,
    };
  }

  async getCurrentBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight("confirmed");
  }

  async getRelayerBalance(): Promise<number> {
    return this.connection.getBalance(this.relayer.publicKey);
  }

  getRelayerPublicKey(): PublicKey {
    return this.relayer.publicKey;
  }

  private async buildRelayedWithdrawTransaction(
    args: SubmitRelayedWithdrawArgs,
  ): Promise<Transaction> {
    const [poolVault] = deriveVaultPda(args.pool, this.programId);

    if (args.poolState.assetType === "spl" && args.poolState.tokenMint) {
      if (args.poolState.kind === "feeV2") {
        if (!args.poolState.treasury) {
          throw new RelayerError("Fee-capable pool is missing a treasury account", 500);
        }

        const recipientTokenAccount = getAssociatedTokenAddressSync(
          args.poolState.tokenMint,
          args.recipient,
        );
        const relayerTokenAccount = getAssociatedTokenAddressSync(
          args.poolState.tokenMint,
          this.relayer.publicKey,
        );
        const preInstructions = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ...(await this.buildCreateAtaInstructions(args.recipient, args.poolState.tokenMint)),
          ...(await this.buildCreateAtaInstructions(
            this.relayer.publicKey,
            args.poolState.tokenMint,
          )),
        ];
        const [nullifierRecord] = deriveNullifierRecordPda(
          args.pool,
          Uint8Array.from(args.nullifierHashBytes),
          this.programId,
        );

        return await (this.program.methods as any)
          .withdrawZkRelayedFeeSpl(
            args.proofABytes,
            args.proofBBytes,
            args.proofCBytes,
            args.rootBytes,
            args.nullifierHashBytes,
            new BN(args.feeAmountRaw),
          )
          .accounts({
            pool: args.pool,
            poolVault,
            relayer: this.relayer.publicKey,
            recipient: args.recipient,
            treasuryTokenAccount: args.poolState.treasury,
            recipientTokenAccount,
            relayerTokenAccount,
            nullifierRecord,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(preInstructions)
          .transaction();
      }

      const recipientTokenAccount = getAssociatedTokenAddressSync(
        args.poolState.tokenMint,
        args.recipient,
      );
      const relayerTokenAccount = getAssociatedTokenAddressSync(
        args.poolState.tokenMint,
        this.relayer.publicKey,
      );
      const preInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...(await this.buildCreateAtaInstructions(args.recipient, args.poolState.tokenMint)),
        ...(await this.buildCreateAtaInstructions(
          this.relayer.publicKey,
          args.poolState.tokenMint,
        )),
      ];
      const [nullifierRecord] = deriveNullifierRecordPda(
        args.pool,
        Uint8Array.from(args.nullifierHashBytes),
        this.programId,
      );

      return await (this.program.methods as any)
        .withdrawZkRelayedSpl(
          args.proofABytes,
          args.proofBBytes,
          args.proofCBytes,
          args.rootBytes,
          args.nullifierHashBytes,
          new BN(args.feeAmountRaw),
        )
        .accounts({
          pool: args.pool,
          poolVault,
          relayer: this.relayer.publicKey,
          recipient: args.recipient,
          recipientTokenAccount,
          relayerTokenAccount,
          nullifierRecord,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(preInstructions)
        .transaction();
    }

    if (args.poolState.kind === "feeV2") {
      if (!args.poolState.treasury) {
        throw new RelayerError("Fee-capable pool is missing a treasury account", 500);
      }

      const [nullifierRecord] = deriveNullifierRecordPda(
        args.pool,
        Uint8Array.from(args.nullifierHashBytes),
        this.programId,
      );

      return await (this.program.methods as any)
        .withdrawZkRelayedFeeV2(
          args.proofABytes,
          args.proofBBytes,
          args.proofCBytes,
          args.rootBytes,
          args.nullifierHashBytes,
          new BN(args.feeAmountRaw),
        )
        .accounts({
          pool: args.pool,
          poolVault,
          relayer: this.relayer.publicKey,
          treasury: args.poolState.treasury,
          recipient: args.recipient,
          nullifierRecord,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .transaction();
    }

    if (args.poolState.kind === "v2") {
      const [nullifierRecord] = deriveNullifierRecordPda(
        args.pool,
        Uint8Array.from(args.nullifierHashBytes),
        this.programId,
      );

      return await (this.program.methods as any)
        .withdrawZkRelayedV2(
          args.proofABytes,
          args.proofBBytes,
          args.proofCBytes,
          args.rootBytes,
          args.nullifierHashBytes,
          new BN(args.feeAmountRaw),
        )
        .accounts({
          pool: args.pool,
          poolVault,
          relayer: this.relayer.publicKey,
          recipient: args.recipient,
          nullifierRecord,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .transaction();
    }

    return await this.program.methods
      .withdrawZkRelayed(
        args.proofABytes,
        args.proofBBytes,
        args.proofCBytes,
        [
          args.rootBytes,
          args.nullifierHashBytes,
          recipientToPublicInput(args.recipient),
        ],
        new BN(args.feeAmountRaw),
      )
      .accounts({
        pool: args.pool,
        poolVault,
        relayer: this.relayer.publicKey,
        recipient: args.recipient,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .transaction();
  }

  private async fetchDecodedPoolAccount(pool: PublicKey): Promise<{
    account: Record<string, unknown>;
    kind: PoolAccountState["kind"];
  }> {
    const accounts = this.program.account as Record<
      string,
      {
        fetch?: (address: PublicKey) => Promise<Record<string, unknown>>;
      }
    >;
    let lastError: unknown;

    if (accounts.poolFeeV2?.fetch) {
      try {
        return {
          kind: "feeV2",
          account: await accounts.poolFeeV2.fetch(pool),
        };
      } catch (error) {
        lastError = error;
      }
    }

    if (accounts.poolV2?.fetch) {
      try {
        return {
          kind: "v2",
          account: await accounts.poolV2.fetch(pool),
        };
      } catch (error) {
        lastError = error;
      }
    }

    if (accounts.pool?.fetch) {
      try {
        return {
          kind: "legacy",
          account: await accounts.pool.fetch(pool),
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw toReadableError(lastError, 404);
  }

  private async buildCreateAtaInstructions(
    owner: PublicKey,
    mint: PublicKey,
  ): Promise<TransactionInstruction[]> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const accountInfo = await this.connection.getAccountInfo(ata, "confirmed");

    if (accountInfo) {
      return [];
    }

    return [
      createAssociatedTokenAccountInstruction(
        this.relayer.publicKey,
        ata,
        owner,
        mint,
      ),
    ];
  }
}

function splitProofBytes(proofBytes: Uint8Array): {
  proofABytes: number[];
  proofBBytes: number[];
  proofCBytes: number[];
} {
  if (proofBytes.length !== 256) {
    throw new RelayerError("proof must be exactly 256 bytes");
  }

  return {
    proofABytes: Array.from(proofBytes.slice(0, 64)),
    proofBBytes: Array.from(proofBytes.slice(64, 192)),
    proofCBytes: Array.from(proofBytes.slice(192, 256)),
  };
}

function recipientToPublicInput(recipient: PublicKey): number[] {
  const fieldBytes = new Uint8Array(32);
  fieldBytes.set(recipient.toBytes().slice(0, 31), 1);
  return Array.from(fieldBytes);
}

function deriveVaultPda(pool: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), pool.toBuffer()],
    programId,
  );
}

function deriveNullifierRecordPda(
  pool: PublicKey,
  nullifierHash: Uint8Array,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), pool.toBuffer(), Buffer.from(nullifierHash)],
    programId,
  );
}

function normalizeBytesMatrix(value: unknown): Uint8Array[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => Uint8Array.from(entry as ArrayLike<number>));
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

function getRecordField(
  value: Record<string, unknown>,
  ...names: string[]
): unknown {
  for (const name of names) {
    if (name in value) {
      return value[name];
    }
  }

  return undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString: () => string }).toString === "function"
  ) {
    return Number((value as { toString: () => string }).toString());
  }

  return Number(value);
}

function toReadableError(error: unknown, fallbackStatus: number): RelayerError {
  const code = extractProgramErrorCode(error);
  if (code !== undefined && PROGRAM_ERROR_MESSAGES[code]) {
    return new RelayerError(
      PROGRAM_ERROR_MESSAGES[code],
      code === 6003 ? 409 : fallbackStatus,
    );
  }

  const message = error instanceof Error ? error.message : "Unknown relayer runtime error";
  if (/Account does not exist|AccountNotFound|could not find account/i.test(message)) {
    return new RelayerError("SNAP: Pool not found — the specified pool account does not exist", 404);
  }

  return new RelayerError(message, fallbackStatus);
}

function getTransactionSignature(transaction: Transaction): string {
  if (!transaction.signature) {
    throw new RelayerError("Failed to sign relayed transaction", 500);
  }

  return bs58.encode(transaction.signature);
}

function isDefinitiveSendFailure(error: unknown, readableError: RelayerError): boolean {
  if (readableError.status < 500 || extractProgramErrorCode(error) !== undefined) {
    return true;
  }

  return /simulation failed|already used|already in use|insufficient (lamports|funds)|blockhash not found|signature verification failed|invalid (account data|transaction)|failed to sanitize/i.test(
    readableError.message,
  );
}

function extractProgramErrorCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof (error as { error?: unknown }).error === "object"
  ) {
    const nested = (error as {
      error?: {
        errorCode?: { number?: number };
      };
    }).error;

    if (nested?.errorCode?.number !== undefined) {
      return nested.errorCode.number;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/custom program error: (0x[0-9a-f]+)/i);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 16);
}

function toWalletAdapter(keypair: Keypair) {
  return {
    payer: keypair,
    publicKey: keypair.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([keypair]);
        return transaction;
      }

      transaction.partialSign(keypair);
      return transaction;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      transactions: T[],
    ): Promise<T[]> {
      return Promise.all(transactions.map((transaction) => this.signTransaction(transaction)));
    },
  };
}

function lamportsToSol(amount: number): number {
  return amount / LAMPORTS_PER_SOL;
}

function toDisplayAmount(amount: number, poolState: PoolAccountState): number {
  if (poolState.assetType === "sol" || poolState.tokenDecimals === null) {
    return lamportsToSol(amount);
  }

  return amount / 10 ** poolState.tokenDecimals;
}
