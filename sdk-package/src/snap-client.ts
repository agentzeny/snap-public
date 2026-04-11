import {
  AnchorProvider,
  BN,
  Program,
  type Wallet,
} from "@coral-xyz/anchor";
import { webcrypto } from "crypto";
import {
  Keypair,
  ComputeBudgetProgram,
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
import {
  bigintToBytes32,
  bytesEqual,
  bytesToHex,
  createNote,
  deserializeNotePayload,
  encryptNote,
  serializeNotePayload,
} from "./commitment";
import {
  COMMITMENT_PAGE_CAPACITY,
  decodeCommitmentPageState,
  deriveCommitmentPagePda,
  mergeCommitmentSources,
} from "./commitment-pages";
import {
  DEFAULT_PROGRAM_ID,
  DEFAULT_PROVER_TIMEOUT,
  DEFAULT_TREE_DEPTH,
  LEGACY_TREE_DEPTH,
  PROGRAM_ERROR_MESSAGES,
  ROOT_HISTORY_SIZE,
  SNAP_IDL,
  SNAP_PROGRAM_ID,
} from "./constants";
import { auditPool as auditPoolHistory, reconstructHistory } from "./history";
import type { AgentKeyPair, MasterKeyPair, ViewingKeyBundle } from "./keys";
import { registerEncryptedNote } from "./note-registry";
import { PoseidonMerkleTree } from "./merkle";
import { generateWithdrawProof } from "./proof";
import {
  extractRelayerAuthKey,
  signRelayerWithdrawRequest,
} from "./relayer-auth";
import { SpendLimiter, type SpendPolicy } from "./spend-limits";
import type {
  DirectWithdrawResult,
  DepositResult,
  Note,
  PoolInfo,
  RelayerInfoResponse,
  RelayerWithdrawRequest,
  RelayerWithdrawResponse,
  RelayerWithdrawResult,
  SNAPWallet,
  WithdrawalEstimate,
  WithdrawalAmounts,
  WalletAdapter,
} from "./types";
import { getRecordField, normalizeBytesMatrix, toNumber } from "./utils";

interface SNAPClientOptions {
  programId?: PublicKey;
  proverTimeout?: number;
  provider?: AnchorProvider;
  wallet?: SNAPWallet;
  agentKeyPair?: AgentKeyPair;
  maxDepositDelayMs?: number;
  maxWithdrawDelayMs?: number;
  spendPolicy?: SpendPolicy;
  spendLimiter?: SpendLimiter;
  sleep?: (ms: number) => Promise<void>;
}

interface CreatePoolOptions {
  tokenMint?: PublicKey | string;
  treasury?: PublicKey | string;
  treeDepth?: 10 | 20;
  protocolFeeBps?: number;
}

interface PoolAccountState {
  kind: "legacy" | "v2" | "feeV2";
  authority: PublicKey;
  depositAmountRaw: number;
  nextIndex: number;
  nullifierCount: number;
  rootCount: number;
  roots: Uint8Array[];
  commitments: Uint8Array[];
  usedNullifiers: Uint8Array[];
  tokenMint: PublicKey | null;
  tokenDecimals: number | null;
  treeDepth: number;
  nullifierVersion: number;
  assetType: "sol" | "spl";
  feeCapable: boolean;
  protocolFeeBps: number;
  treasury: PublicKey | null;
}

interface DecodedPoolAccount {
  kind: PoolAccountState["kind"];
  account: Record<string, unknown>;
}

export class SNAPClient {
  private readonly provider: AnchorProvider;
  private readonly wallet: WalletAdapter;
  private readonly program: Program;
  private readonly programId: PublicKey;
  private readonly proverTimeout: number;
  private readonly agentKeyPair?: AgentKeyPair;
  private readonly maxDepositDelayMs: number;
  private readonly maxWithdrawDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spendLimiter?: SpendLimiter;

  constructor(
    connection: AnchorProvider["connection"],
    walletOrAgentKey: SNAPWallet | AgentKeyPair,
    options: SNAPClientOptions = {},
  ) {
    this.agentKeyPair = isAgentKeyPair(walletOrAgentKey)
      ? walletOrAgentKey
      : options.agentKeyPair;

    const wallet = isAgentKeyPair(walletOrAgentKey)
      ? options.wallet ?? Keypair.fromSeed(walletOrAgentKey.spendingKey)
      : walletOrAgentKey;

    this.wallet = toWalletAdapter(wallet);
    this.provider =
      options.provider ??
      new AnchorProvider(connection, this.wallet as Wallet, {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
    this.programId = options.programId ?? SNAP_PROGRAM_ID;
    this.proverTimeout = options.proverTimeout ?? DEFAULT_PROVER_TIMEOUT;
    this.maxDepositDelayMs = options.maxDepositDelayMs ?? 0;
    this.maxWithdrawDelayMs = options.maxWithdrawDelayMs ?? 0;
    this.sleep = options.sleep ?? defaultSleep;
    this.program = new Program(
      { ...SNAP_IDL, address: this.programId.toBase58() } as never,
      this.provider,
    );
    this.spendLimiter = options.spendLimiter ?? (
      options.spendPolicy ? new SpendLimiter(options.spendPolicy) : undefined
    );
  }

  async createPool(
    depositAmount: number,
    options: CreatePoolOptions = {},
  ): Promise<PublicKey> {
    if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
      throw new Error("SNAP: Pool denomination must be greater than zero");
    }

    const tokenMint = normalizePublicKey(options.tokenMint);
    const treasury = normalizePublicKey(options.treasury);
    const treeDepth = options.treeDepth ?? DEFAULT_TREE_DEPTH;
    const protocolFeeBps = options.protocolFeeBps;
    const feeCapable = treasury !== null || protocolFeeBps !== undefined;
    const pool = Keypair.generate();
    const [poolVault] = deriveVaultPda(pool.publicKey, this.programId);

    if (feeCapable) {
      if (!treasury) {
        throw new Error("SNAP: Fee-capable pools require a treasury account");
      }
      if (!Number.isInteger(protocolFeeBps) || protocolFeeBps! < 0 || protocolFeeBps! > 500) {
        throw new Error("SNAP: protocolFeeBps must be an integer between 0 and 500");
      }
    }

    try {
      if (tokenMint) {
        if (treeDepth !== DEFAULT_TREE_DEPTH) {
          throw new Error("SNAP: SPL pools currently default to treeDepth=20");
        }

        const decimals = await this.fetchTokenDecimals(tokenMint);
        const rawAmount = uiAmountToRaw(depositAmount, decimals);

        if (feeCapable) {
          await (this.program.methods as any)
            .initializeFeeSpl(new BN(rawAmount), tokenMint, protocolFeeBps)
            .accounts({
              pool: pool.publicKey,
              poolVault,
              tokenMintAccount: tokenMint,
              treasuryTokenAccount: treasury,
              authority: this.wallet.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions(this.buildCreatePoolPreInstructions(DEFAULT_TREE_DEPTH, "spl"))
            .signers([pool])
            .rpc();
        } else {
          await (this.program.methods as any)
            .initializeSpl(new BN(rawAmount), tokenMint)
            .accounts({
              pool: pool.publicKey,
              poolVault,
              tokenMintAccount: tokenMint,
              authority: this.wallet.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions(this.buildCreatePoolPreInstructions(DEFAULT_TREE_DEPTH, "spl"))
            .signers([pool])
            .rpc();
        }
      } else {
        const rawAmount = solToLamports(depositAmount);

        if (feeCapable) {
          await (this.program.methods as any)
            .initializeFeeV2(new BN(rawAmount), treeDepth, protocolFeeBps)
            .accounts({
              pool: pool.publicKey,
              poolVault,
              treasury,
              authority: this.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions(this.buildCreatePoolPreInstructions(treeDepth, "sol"))
            .signers([pool])
            .rpc();
        } else {
          await (this.program.methods as any)
            .initializeV2(new BN(rawAmount), treeDepth)
            .accounts({
              pool: pool.publicKey,
              poolVault,
              authority: this.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions(this.buildCreatePoolPreInstructions(treeDepth, "sol"))
            .signers([pool])
            .rpc();
        }
      }
    } catch (error) {
      throw this.toReadableError(error);
    }

    return pool.publicKey;
  }

  async createSplPool(
    depositAmount: number,
    tokenMint: PublicKey | string,
  ): Promise<PublicKey> {
    return this.createPool(depositAmount, { tokenMint });
  }

  async deposit(pool: PublicKey, amount?: number): Promise<DepositResult> {
    const poolState = await this.fetchPoolState(pool);
    await this.assertDepositAmountMatches(poolState, amount);

    const note = await createNote(pool, poolState.nextIndex);
    const [poolVault] = deriveVaultPda(pool, this.programId);
    const commitmentPageIndex = Math.floor(
      poolState.nextIndex / COMMITMENT_PAGE_CAPACITY,
    );
    const [commitmentPage] = deriveCommitmentPagePda(
      pool,
      commitmentPageIndex,
      this.programId,
    );
    await this.applyRandomDelay(this.maxDepositDelayMs);

    try {
      if (poolState.assetType === "spl" && poolState.tokenMint) {
        const depositorTokenAccount = getAssociatedTokenAddressSync(
          poolState.tokenMint,
          this.wallet.publicKey,
        );
        const tokenAccountInfo = await this.provider.connection.getAccountInfo(
          depositorTokenAccount,
          "confirmed",
        );

        if (!tokenAccountInfo) {
          throw new Error(
            "SNAP: Depositor token account not found for the pool mint",
          );
        }

        const splDepositMethod =
          poolState.kind === "feeV2" ? "depositFeeSpl" : "depositSpl";

        await (this.program.methods as any)
          [splDepositMethod](Array.from(note.commitment), commitmentPageIndex)
          .accounts({
            pool,
            depositor: this.wallet.publicKey,
            depositorTokenAccount,
            commitmentPage,
            poolVault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(
            this.buildDepositPreInstructions(poolState.treeDepth, poolState.assetType),
          )
          .rpc();
      } else if (poolState.kind === "feeV2") {
        await (this.program.methods as any)
          .depositFeeV2(Array.from(note.commitment), commitmentPageIndex)
          .accounts({
            pool,
            commitmentPage,
            poolVault,
            depositor: this.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(
            this.buildDepositPreInstructions(poolState.treeDepth, poolState.assetType),
          )
          .rpc();
      } else if (poolState.kind === "v2") {
        await (this.program.methods as any)
          .depositV2(Array.from(note.commitment), commitmentPageIndex)
          .accounts({
            pool,
            commitmentPage,
            poolVault,
            depositor: this.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(
            this.buildDepositPreInstructions(poolState.treeDepth, poolState.assetType),
          )
          .rpc();
      } else {
        await (this.program.methods as any)
          .deposit(Array.from(note.commitment))
          .accounts({
            pool,
            poolVault,
            depositor: this.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(
            this.buildDepositPreInstructions(poolState.treeDepth, poolState.assetType),
          )
          .rpc();
      }
    } catch (error) {
      throw this.toReadableError(error);
    }

    const encryptedNote = this.agentKeyPair
      ? encryptNote(note, this.agentKeyPair.viewingKey)
      : undefined;

    if (encryptedNote) {
      registerEncryptedNote({
        commitment: note.commitment,
        encryptedNote,
        poolAddress: note.poolAddress,
        depositIndex: note.depositIndex,
      });
    }

    return {
      ...note,
      encryptedNote,
    };
  }

  async withdraw(
    pool: PublicKey,
    note: Note,
    recipient: Keypair | PublicKey,
  ): Promise<string> {
    const result = await this.withdrawWithResult(pool, note, recipient);
    return result.txSignature;
  }

  async withdrawWithResult(
    pool: PublicKey,
    note: Note,
    recipient: Keypair | PublicKey,
  ): Promise<DirectWithdrawResult> {
    assertValidNote(note);

    if (note.poolAddress !== pool.toBase58()) {
      throw new Error("SNAP: Invalid note — this note belongs to a different pool");
    }

    const recipientPublicKey = normalizePublicKey(recipient);
    if (!recipientPublicKey) {
      throw new Error("SNAP: Invalid recipient public key");
    }
    const poolState = await this.fetchPoolState(pool);

    if (await this.isNullifierUsed(pool, poolState, note.nullifierHash)) {
      throw new Error(PROGRAM_ERROR_MESSAGES[6003]);
    }

    if (this.spendLimiter) {
      const check = this.spendLimiter.check(
        poolState.depositAmountRaw,
        pool.toBase58(),
      );
      if (!check.allowed) {
        throw new Error(`SNAP: Spend limit exceeded: ${check.reason}`);
      }
    }

    const proof = await generateWithdrawProof(
      note,
      poolState.commitments,
      recipientPublicKey,
      this.proverTimeout,
      poolState.treeDepth,
    );

    const [poolVault] = deriveVaultPda(pool, this.programId);
    const preInstructions = this.buildWithdrawPreInstructions(poolState.treeDepth);
    const breakdown = this.buildWithdrawalAmounts(poolState, 0);
    await this.applyRandomDelay(this.maxWithdrawDelayMs);

    try {
      let signature: string;

      if (poolState.assetType === "spl" && poolState.tokenMint) {
        const recipientTokenAccount = getAssociatedTokenAddressSync(
          poolState.tokenMint,
          recipientPublicKey,
        );
        const ataInstructions = await this.buildCreateAtaInstructions(
          recipientPublicKey,
          poolState.tokenMint,
        );
        const [nullifierRecord] = deriveNullifierRecordPda(
          pool,
          note.nullifierHash,
          this.programId,
        );

        if (poolState.kind === "feeV2") {
          if (!poolState.treasury) {
            throw new Error("SNAP: Fee-capable pool is missing a treasury account");
          }

          signature = await (this.program.methods as any)
            .withdrawZkFeeSpl(
              proof.proofABytes,
              proof.proofBBytes,
              proof.proofCBytes,
              proof.rootBytes,
              proof.nullifierHashBytes,
            )
            .accounts({
              pool,
              poolVault,
              recipient: recipientPublicKey,
              treasuryTokenAccount: poolState.treasury,
              recipientTokenAccount,
              payer: this.wallet.publicKey,
              nullifierRecord,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions([...preInstructions, ...ataInstructions])
            .rpc();
        } else {
          signature = await (this.program.methods as any)
            .withdrawZkSpl(
              proof.proofABytes,
              proof.proofBBytes,
              proof.proofCBytes,
              proof.rootBytes,
              proof.nullifierHashBytes,
            )
            .accounts({
              pool,
              poolVault,
              recipient: recipientPublicKey,
              recipientTokenAccount,
              payer: this.wallet.publicKey,
              nullifierRecord,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions([...preInstructions, ...ataInstructions])
            .rpc();
        }
      } else if (poolState.kind === "feeV2") {
        if (!poolState.treasury) {
          throw new Error("SNAP: Fee-capable pool is missing a treasury account");
        }

        const [nullifierRecord] = deriveNullifierRecordPda(
          pool,
          note.nullifierHash,
          this.programId,
        );

        signature = await (this.program.methods as any)
          .withdrawZkFeeV2(
            proof.proofABytes,
            proof.proofBBytes,
            proof.proofCBytes,
            proof.rootBytes,
            proof.nullifierHashBytes,
          )
          .accounts({
            pool,
            poolVault,
            treasury: poolState.treasury,
            recipient: recipientPublicKey,
            payer: this.wallet.publicKey,
            nullifierRecord,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(preInstructions)
          .rpc();
      } else if (poolState.kind === "v2") {
        const [nullifierRecord] = deriveNullifierRecordPda(
          pool,
          note.nullifierHash,
          this.programId,
        );

        signature = await (this.program.methods as any)
          .withdrawZkV2(
            proof.proofABytes,
            proof.proofBBytes,
            proof.proofCBytes,
            proof.rootBytes,
            proof.nullifierHashBytes,
          )
          .accounts({
            pool,
            poolVault,
            recipient: recipientPublicKey,
            payer: this.wallet.publicKey,
            nullifierRecord,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(preInstructions)
          .rpc();
      } else {
        signature = await (this.program.methods as any)
          .withdrawZk(
            proof.proofABytes,
            proof.proofBBytes,
            proof.proofCBytes,
            proof.rootBytes,
            proof.nullifierHashBytes,
          )
          .accounts({
            pool,
            poolVault,
            recipient: recipientPublicKey,
            payer: this.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(preInstructions)
          .rpc();
      }

      if (this.spendLimiter) {
        this.spendLimiter.record(poolState.depositAmountRaw);
      }

      return {
        txSignature: signature,
        ...breakdown,
      };
    } catch (error) {
      throw this.toReadableError(error);
    }
  }

  async estimateDirectWithdrawal(pool: PublicKey): Promise<WithdrawalAmounts> {
    return this.estimateWithdrawal(pool);
  }

  async estimateWithdrawal(pool: PublicKey): Promise<WithdrawalEstimate> {
    const poolState = await this.fetchPoolState(pool);
    return this.buildWithdrawalAmounts(poolState, 0);
  }

  async estimateRelayedWithdrawal(
    pool: PublicKey,
    relayerUrl = "http://localhost:3000",
  ): Promise<WithdrawalEstimate> {
    const poolState = await this.fetchPoolState(pool);
    const relayerInfo = await this.fetchRelayerInfo(relayerUrl);
    if (relayerInfo.pool !== pool.toBase58()) {
      throw new Error(
        `SNAP: Relayer is configured for pool ${relayerInfo.pool}, not ${pool.toBase58()}`,
      );
    }

    const relayerFeeBps = relayerInfo.relayerFeeBps ?? relayerInfo.fee.feeBps;
    const relayerFeeRaw = calculateRelayerFee(
      poolState.depositAmountRaw,
      relayerFeeBps,
      poolState.assetType === "sol" ? relayerInfo.fee.minFeeLamports : 0,
    );
    return this.buildWithdrawalAmounts(poolState, relayerFeeRaw);
  }

  async updateTreasury(
    pool: PublicKey,
    newTreasury: PublicKey | string,
  ): Promise<string> {
    const poolState = await this.fetchPoolState(pool);
    if (poolState.kind !== "feeV2") {
      throw new Error("SNAP: Treasury updates are only supported on fee-capable pools");
    }

    const treasury = normalizePublicKey(newTreasury);
    if (!treasury) {
      throw new Error("SNAP: Invalid treasury public key");
    }

    try {
      return await (this.program.methods as any)
        .updateTreasury(treasury)
        .accounts({
          pool,
          authority: this.wallet.publicKey,
        })
        .rpc();
    } catch (error) {
      throw this.toReadableError(error);
    }
  }

  async withdrawViaRelayer(
    pool: PublicKey,
    note: Note,
    recipient: PublicKey,
    relayerUrl = "http://localhost:3000",
  ): Promise<RelayerWithdrawResult> {
    assertValidNote(note);

    if (note.poolAddress !== pool.toBase58()) {
      throw new Error("SNAP: Invalid note — this note belongs to a different pool");
    }

    const poolState = await this.fetchPoolState(pool);

    if (await this.isNullifierUsed(pool, poolState, note.nullifierHash)) {
      throw new Error(PROGRAM_ERROR_MESSAGES[6003]);
    }

    if (this.spendLimiter) {
      const check = this.spendLimiter.check(
        poolState.depositAmountRaw,
        pool.toBase58(),
      );
      if (!check.allowed) {
        throw new Error(`SNAP: Spend limit exceeded: ${check.reason}`);
      }
    }

    const proof = await generateWithdrawProof(
      note,
      poolState.commitments,
      recipient,
      this.proverTimeout,
      poolState.treeDepth,
    );
    await this.applyRandomDelay(this.maxWithdrawDelayMs);

    const relayerInfo = await this.fetchRelayerInfo(relayerUrl);
    if (relayerInfo.pool !== pool.toBase58()) {
      throw new Error(
        `SNAP: Relayer is configured for pool ${relayerInfo.pool}, not ${pool.toBase58()}`,
      );
    }

    const feeRaw = calculateRelayerFee(
      poolState.depositAmountRaw,
      relayerInfo.fee.feeBps,
      poolState.assetType === "sol" ? relayerInfo.fee.minFeeLamports : 0,
    );
    const breakdown = this.buildWithdrawalAmounts(poolState, feeRaw);

    const requestBody: RelayerWithdrawRequest = {
      pool: pool.toBase58(),
      proof: bytesToHex(
        Uint8Array.from([
          ...proof.proofABytes,
          ...proof.proofBBytes,
          ...proof.proofCBytes,
        ]),
      ),
      root: bytesToHex(Uint8Array.from(proof.rootBytes)),
      nullifierHash: bytesToHex(Uint8Array.from(proof.nullifierHashBytes)),
      recipient: recipient.toBase58(),
      fee: feeRaw,
    };
    const authKey = extractRelayerAuthKey(this.wallet, this.agentKeyPair);
    if (!authKey) {
      throw new Error(
        "SNAP: Relayer auth requires an AgentKeyPair or a Keypair-backed wallet",
      );
    }

    const signedRequest = signRelayerWithdrawRequest(requestBody, authKey);

    let response: Response;
    try {
      response = await fetch(resolveRelayerEndpoint(relayerUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(signedRequest),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SNAP: Failed to reach relayer — ${message}`);
    }

    let payload: RelayerWithdrawResponse | null = null;
    try {
      payload = (await response.json()) as RelayerWithdrawResponse;
    } catch {
      throw new Error("SNAP: Relayer returned a non-JSON response");
    }

    if (!response.ok || !isRelayerWithdrawSuccessResponse(payload)) {
      throw new Error(extractRelayerError(payload, response.status));
    }

    if (this.spendLimiter) {
      this.spendLimiter.record(poolState.depositAmountRaw);
    }

    return {
      ...breakdown,
      txSignature: payload.txSignature,
      fee: payload.fee,
      recipientReceived: payload.recipientReceived ?? breakdown.recipientAmount,
      protocolFee: payload.protocolFee ?? breakdown.protocolFee,
      protocolFeeRaw: payload.protocolFeeRaw ?? breakdown.protocolFeeRaw,
      relayerFee: payload.relayerFee ?? payload.fee ?? breakdown.relayerFee,
      relayerFeeRaw: payload.relayerFeeRaw ?? breakdown.relayerFeeRaw,
      recipientAmount: payload.recipientAmount ?? breakdown.recipientAmount,
      recipientAmountRaw: payload.recipientAmountRaw ?? breakdown.recipientAmountRaw,
      totalFee: payload.totalFee ?? breakdown.totalFee,
      totalFeeRaw: payload.totalFeeRaw ?? breakdown.totalFeeRaw,
    };
  }

  async getPoolInfo(pool: PublicKey): Promise<PoolInfo> {
    const state = await this.fetchPoolState(pool);
    const tokenDecimals = state.tokenDecimals;

    return {
      address: pool,
      authority: state.authority,
      depositAmount: toDisplayAmount(
        state.depositAmountRaw,
        state.assetType,
        tokenDecimals,
      ),
      depositAmountRaw: state.depositAmountRaw,
      depositCount: state.nextIndex,
      withdrawCount: state.nullifierCount,
      currentRoot:
        state.rootCount === 0
          ? await this.getZeroRoot(state.treeDepth)
          : state.roots[(state.rootCount - 1) % ROOT_HISTORY_SIZE],
      tokenMint: state.tokenMint,
      tokenDecimals,
      assetType: state.assetType,
      treeDepth: state.treeDepth,
      nullifierVersion: state.nullifierVersion,
      legacy: state.kind === "legacy",
      feeCapable: state.feeCapable,
      protocolFeeBps: state.protocolFeeBps,
      treasury: state.treasury,
    };
  }

  async getAgentHistory(pool: PublicKey, viewingKey: ViewingKeyBundle) {
    return reconstructHistory(this.provider.connection, pool, viewingKey);
  }

  async auditPool(
    pool: PublicKey,
    masterKey: MasterKeyPair,
    maxAgentIndex: number,
  ) {
    return auditPoolHistory(
      this.provider.connection,
      pool,
      masterKey,
      maxAgentIndex,
    );
  }

  static serializeNote(note: Note): string {
    assertValidNote(note);
    return serializeNotePayload(note);
  }

  static deserializeNote(data: string): Note {
    const note = deserializeNotePayload(data);
    assertValidNote(note);
    return note;
  }

  private async fetchPoolState(pool: PublicKey): Promise<PoolAccountState> {
    const { account, kind } = await this.fetchDecodedPoolAccount(pool);
    const state = normalizePoolState(account, kind);
    if (state.assetType === "spl" && state.tokenMint) {
      state.tokenDecimals = await this.fetchTokenDecimals(state.tokenMint);
    }
    if (kind !== "legacy") {
      state.commitments = await this.fetchCommitments(pool, state);
    }

    return state;
  }

  private async fetchDecodedPoolAccount(pool: PublicKey): Promise<DecodedPoolAccount> {
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

    throw this.toReadableError(lastError);
  }

  private async getZeroRoot(treeDepth: number): Promise<Uint8Array> {
    const tree = new PoseidonMerkleTree(treeDepth);
    await tree.init();
    return bigintToBytes32(tree.getRoot());
  }

  private async isNullifierUsed(
    pool: PublicKey,
    poolState: PoolAccountState,
    nullifierHash: Uint8Array,
  ): Promise<boolean> {
    if (poolState.nullifierVersion === 0) {
      return poolState.usedNullifiers.some((value) => bytesEqual(value, nullifierHash));
    }

    const [nullifierRecord] = deriveNullifierRecordPda(
      pool,
      nullifierHash,
      this.programId,
    );
    const accountInfo = await this.provider.connection.getAccountInfo(
      nullifierRecord,
      "confirmed",
    );
    return accountInfo !== null;
  }

  private async assertDepositAmountMatches(
    poolState: PoolAccountState,
    requestedAmount?: number,
  ): Promise<void> {
    if (requestedAmount === undefined) {
      return;
    }

    const requestedRaw =
      poolState.assetType === "sol"
        ? solToLamports(requestedAmount)
        : uiAmountToRaw(
            requestedAmount,
            await this.fetchTokenDecimals(poolState.tokenMint!),
          );

    if (requestedRaw !== poolState.depositAmountRaw) {
      const expectedAmount =
        poolState.assetType === "sol"
          ? lamportsToSol(poolState.depositAmountRaw)
          : toDisplayAmount(
              poolState.depositAmountRaw,
              poolState.assetType,
              await this.fetchTokenDecimals(poolState.tokenMint!),
            );
      const unit = poolState.assetType === "sol" ? "SOL" : "tokens";

      throw new Error(
        `SNAP: Pool denomination is ${expectedAmount} ${unit}; requested deposit was ${requestedAmount} ${unit}`,
      );
    }
  }

  private async fetchRelayerInfo(relayerUrl: string): Promise<RelayerInfoResponse> {
    let response: Response;
    try {
      response = await fetch(resolveRelayerInfoEndpoint(relayerUrl));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SNAP: Failed to reach relayer info endpoint — ${message}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("SNAP: Relayer info endpoint returned non-JSON data");
    }

    if (
      !response.ok ||
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as RelayerInfoResponse).pool !== "string" ||
      typeof (payload as RelayerInfoResponse).network !== "string" ||
      typeof (payload as RelayerInfoResponse).programId !== "string" ||
      typeof (payload as RelayerInfoResponse).relayer !== "string" ||
      typeof (payload as RelayerInfoResponse).relayerBalanceLamports !== "number" ||
      typeof (payload as RelayerInfoResponse).maxRequestAgeMs !== "number" ||
      typeof (
        (payload as RelayerInfoResponse).relayerFeeBps ??
        (payload as RelayerInfoResponse).fee?.feeBps
      ) !== "number" ||
      typeof (payload as RelayerInfoResponse).fee?.minFeeLamports !== "number"
    ) {
      throw new Error("SNAP: Relayer /info response is malformed");
    }

    return payload as RelayerInfoResponse;
  }

  private async fetchTokenDecimals(tokenMint: PublicKey): Promise<number> {
    const mint = await getMint(this.provider.connection, tokenMint, "confirmed");
    return mint.decimals;
  }

  private buildWithdrawalAmounts(
    poolState: PoolAccountState,
    relayerFeeRaw: number,
  ): WithdrawalEstimate {
    const protocolFeeRaw = calculateProtocolFee(
      poolState.depositAmountRaw,
      poolState.protocolFeeBps,
    );
    const totalFeeRaw = protocolFeeRaw + relayerFeeRaw;
    if (totalFeeRaw >= poolState.depositAmountRaw) {
      throw new Error("SNAP: Combined protocol and relayer fees leave no withdrawable balance");
    }

    const recipientAmountRaw = poolState.depositAmountRaw - totalFeeRaw;
    return {
      depositAmount: toDisplayAmount(
        poolState.depositAmountRaw,
        poolState.assetType,
        poolState.tokenDecimals,
      ),
      depositAmountRaw: poolState.depositAmountRaw,
      protocolFeeBps: poolState.protocolFeeBps,
      protocolFee: toDisplayAmount(
        protocolFeeRaw,
        poolState.assetType,
        poolState.tokenDecimals,
      ),
      protocolFeeRaw,
      relayerFee: toDisplayAmount(
        relayerFeeRaw,
        poolState.assetType,
        poolState.tokenDecimals,
      ),
      relayerFeeRaw,
      recipientAmount: toDisplayAmount(
        recipientAmountRaw,
        poolState.assetType,
        poolState.tokenDecimals,
      ),
      recipientAmountRaw,
      totalFee: toDisplayAmount(
        totalFeeRaw,
        poolState.assetType,
        poolState.tokenDecimals,
      ),
      totalFeeRaw,
    };
  }

  private buildCreatePoolPreInstructions(
    treeDepth: number,
    assetType: PoolAccountState["assetType"],
  ): TransactionInstruction[] {
    if (treeDepth > LEGACY_TREE_DEPTH || assetType === "spl") {
      return [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
    }

    return [];
  }

  private buildDepositPreInstructions(
    treeDepth: number,
    assetType: PoolAccountState["assetType"],
  ): TransactionInstruction[] {
    if (treeDepth > LEGACY_TREE_DEPTH || assetType === "spl") {
      return [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
    }

    return [];
  }

  private buildWithdrawPreInstructions(treeDepth: number): TransactionInstruction[] {
    const units = treeDepth > LEGACY_TREE_DEPTH ? 1_400_000 : 500_000;
    return [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  }

  private async buildCreateAtaInstructions(
    owner: PublicKey,
    mint: PublicKey,
  ): Promise<TransactionInstruction[]> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const accountInfo = await this.provider.connection.getAccountInfo(ata, "confirmed");

    if (accountInfo) {
      return [];
    }

    return [
      createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        ata,
        owner,
        mint,
      ),
    ];
  }

  private async fetchCommitments(
    pool: PublicKey,
    poolState: PoolAccountState,
  ): Promise<Uint8Array[]> {
    if (poolState.kind === "legacy" || poolState.nextIndex <= poolState.commitments.length) {
      return poolState.commitments;
    }

    const pageAddresses = Array.from(
      {
        length: Math.ceil(poolState.nextIndex / COMMITMENT_PAGE_CAPACITY),
      },
      (_, pageIndex) => deriveCommitmentPagePda(pool, pageIndex, this.programId)[0],
    );
    const accountNamespace = this.program.account as Record<
      string,
      {
        fetchMultiple?: (addresses: PublicKey[]) => Promise<Array<Record<string, unknown> | null>>;
      }
    >;
    const pages = accountNamespace.commitmentPage?.fetchMultiple
      ? (
          await accountNamespace.commitmentPage.fetchMultiple(pageAddresses)
        ).flatMap((account) =>
          account ? [decodeCommitmentPageState(account)] : [],
        )
      : (
          await this.provider.connection.getMultipleAccountsInfo(
            pageAddresses,
            "confirmed",
          )
        ).flatMap((info) => {
          if (!info) {
            return [];
          }

          try {
            const decoded = this.program.coder.accounts.decode(
              "CommitmentPage",
              info.data,
            ) as Record<string, unknown>;
            return [decodeCommitmentPageState(decoded)];
          } catch {
            return [];
          }
        });

    return mergeCommitmentSources({
      inlineCommitments: poolState.commitments,
      nextIndex: poolState.nextIndex,
      pages,
    });
  }

  private toReadableError(error: unknown): Error {
    const code = extractProgramErrorCode(error);
    if (code !== undefined && PROGRAM_ERROR_MESSAGES[code]) {
      return new Error(PROGRAM_ERROR_MESSAGES[code]);
    }

    const message =
      error instanceof Error ? error.message : "Unknown SNAP client error";

    if (/Account does not exist|AccountNotFound|could not find account/i.test(message)) {
      return new Error("SNAP: Pool not found — the specified pool account does not exist");
    }

    return new Error(`SNAP: ${message}`);
  }

  private async applyRandomDelay(maxDelayMs: number): Promise<void> {
    if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
      return;
    }

    await this.sleep(randomDelayMs(Math.floor(maxDelayMs)));
  }
}

function normalizePoolState(
  account: Record<string, unknown>,
  kind: PoolAccountState["kind"],
): PoolAccountState {
  const tokenMint =
    kind !== "legacy"
      ? normalizePublicKey(getRecordField(account, "tokenMint", "token_mint"))
      : null;
  const treasury =
    kind === "feeV2"
      ? normalizePublicKey(getRecordField(account, "treasury"))
      : null;
  const protocolFeeBps =
    kind === "feeV2"
      ? toNumber(getRecordField(account, "protocolFeeBps", "protocol_fee_bps"))
      : 0;

  return {
    kind,
    authority: getRecordField(account, "authority") as PublicKey,
    depositAmountRaw: toNumber(
      getRecordField(account, "depositAmount", "deposit_amount"),
    ),
    nextIndex: toNumber(getRecordField(account, "nextIndex", "next_index")),
    nullifierCount: toNumber(
      getRecordField(account, "nullifierCount", "nullifier_count"),
    ),
    rootCount: toNumber(getRecordField(account, "rootCount", "root_count")),
    roots: normalizeBytesMatrix(getRecordField(account, "roots")),
    commitments: normalizeBytesMatrix(getRecordField(account, "commitments")),
    usedNullifiers: normalizeBytesMatrix(
      getRecordField(account, "usedNullifiers", "used_nullifiers"),
    ),
    tokenMint,
    tokenDecimals: null,
    treeDepth:
      kind !== "legacy"
        ? toNumber(getRecordField(account, "treeDepth", "tree_depth"))
        : LEGACY_TREE_DEPTH,
    nullifierVersion:
      kind !== "legacy"
        ? toNumber(
            getRecordField(account, "nullifierVersion", "nullifier_version"),
          )
        : 0,
    assetType: tokenMint ? "spl" : "sol",
    feeCapable: kind === "feeV2",
    protocolFeeBps,
    treasury,
  };
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

function isAgentKeyPair(value: SNAPWallet | AgentKeyPair): value is AgentKeyPair {
  return (
    value !== null &&
    typeof value === "object" &&
    "spendingKey" in value &&
    "viewingKey" in value &&
    "agentId" in value &&
    "index" in value
  );
}

function toWalletAdapter(wallet: SNAPWallet): WalletAdapter {
  if (isKeypairLike(wallet)) {
    const signer = wallet as Keypair;

    const signTransaction = async <T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> => {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([signer]);
        return transaction;
      }

      transaction.partialSign(signer);
      return transaction;
    };

    return {
      payer: signer,
      publicKey: signer.publicKey,
      signTransaction,
      async signAllTransactions<T extends Transaction | VersionedTransaction>(
        transactions: T[],
      ): Promise<T[]> {
        return Promise.all(
          transactions.map((transaction) => signTransaction(transaction)),
        );
      },
    };
  }

  return wallet as WalletAdapter;
}

function isKeypairLike(wallet: SNAPWallet): wallet is Keypair {
  const maybeKeypair = wallet as Partial<Keypair> & { secretKey?: unknown };
  return (
    maybeKeypair !== null &&
    typeof maybeKeypair === "object" &&
    typeof maybeKeypair.publicKey?.toBase58 === "function" &&
    maybeKeypair.secretKey instanceof Uint8Array
  );
}

function resolveRelayerEndpoint(relayerUrl: string): string {
  const url = new URL(relayerUrl);
  url.pathname = "/relay";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveRelayerInfoEndpoint(relayerUrl: string): string {
  const url = new URL(relayerUrl);
  url.pathname = "/info";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isRelayerWithdrawSuccessResponse(
  value: RelayerWithdrawResponse | null,
): value is Extract<RelayerWithdrawResponse, { success: true }> {
  return (
    !!value &&
    value.success === true &&
    typeof value.txSignature === "string" &&
    typeof value.fee === "number"
  );
}

function extractRelayerError(
  payload: RelayerWithdrawResponse | null,
  status: number,
): string {
  if (payload && payload.success === false && typeof payload.error === "string") {
    return `SNAP: Relayer rejected withdrawal — ${payload.error}`;
  }

  return `SNAP: Relayer request failed with HTTP ${status}`;
}

function assertValidNote(note: Note): void {
  if (note.depositIndex < 0 || !Number.isInteger(note.depositIndex)) {
    throw new Error("SNAP: Invalid note — deposit index must be a non-negative integer");
  }

  if (note.commitment.length !== 32 || note.nullifierHash.length !== 32) {
    throw new Error("SNAP: Invalid note — commitment and nullifier hash must be 32 bytes");
  }

  if (!note.poolAddress) {
    throw new Error("SNAP: Invalid note — pool address is missing");
  }
}

function deriveVaultPda(
  pool: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
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

function solToLamports(amount: number): number {
  return Math.round(amount * LAMPORTS_PER_SOL);
}

function lamportsToSol(amount: number): number {
  return amount / LAMPORTS_PER_SOL;
}

function calculateRelayerFee(
  withdrawAmountLamports: number,
  feeBps: number,
  minFeeLamports: number,
): number {
  const bpsFee = Math.floor((withdrawAmountLamports * feeBps) / 10_000);
  return Math.max(bpsFee, minFeeLamports);
}

function calculateProtocolFee(
  withdrawAmountRaw: number,
  protocolFeeBps: number,
): number {
  return Math.floor((withdrawAmountRaw * protocolFeeBps) / 10_000);
}

function uiAmountToRaw(amount: number, decimals: number): number {
  return Math.round(amount * 10 ** decimals);
}

function randomDelayMs(maxDelayMs: number): number {
  if (maxDelayMs <= 0) {
    return 0;
  }

  const range = maxDelayMs + 1;
  const maxUnbiased = Math.floor(0xffffffff / range) * range;
  const buffer = new Uint32Array(1);

  for (;;) {
    webcrypto.getRandomValues(buffer);
    if (buffer[0] < maxUnbiased) {
      return buffer[0] % range;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toDisplayAmount(
  rawAmount: number,
  assetType: PoolAccountState["assetType"],
  tokenDecimals: number | null,
): number {
  if (assetType === "sol") {
    return lamportsToSol(rawAmount);
  }

  if (tokenDecimals === null) {
    return rawAmount;
  }

  return rawAmount / 10 ** tokenDecimals;
}
