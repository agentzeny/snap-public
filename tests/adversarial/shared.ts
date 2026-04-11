import fs from "fs";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import {
  BN,
  type Program,
} from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  type Account as SplTokenAccount,
} from "@solana/spl-token";
import {
  COMMITMENT_PAGE_CAPACITY,
  deriveCommitmentPagePda,
} from "../../sdk-package/src/commitment-pages";
import {
  FIELD_PRIME,
  LEGACY_TREE_DEPTH,
} from "../../sdk-package/src/constants";
import {
  bigintToBytes32,
  bytesToBigint,
  bytesToHex,
} from "../../sdk-package/src/commitment";
import type { Note } from "../../sdk-package/src/types";
import {
  PoseidonMerkleTree,
  initPoseidon,
  poseidonHash1,
  poseidonHash2,
} from "../../sdk/poseidon-merkle";
import {
  computeBudgetIx,
  deriveNullifierRecordPda,
  deriveVaultPda,
  formatProof,
  fundSystemAccount,
} from "../helpers";

export const ADVERSARIAL_RESULTS_DIR = path.resolve(
  process.cwd(),
  "adversarial-results",
);
export const PROOF_TIMEOUT_MS = 30_000;

export interface ErrorSummary {
  logs?: string[];
  message: string;
  name?: string;
}

export interface ProofGenerationSummary {
  durationMs: number;
  error?: ErrorSummary;
  publicSignals?: string[];
  status: "failed" | "generated" | "timed_out";
  verified?: boolean;
}

export interface OnChainSummary {
  error?: ErrorSummary;
  status: "failed" | "skipped" | "succeeded";
  txSignature?: string;
}

export interface HttpSummary {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  status: number;
}

export interface AdversarialCaseResult {
  attempted: string;
  caseId: string;
  matchedExpectation: boolean;
  name: string;
  notes?: string[];
  offChainProof?: ProofGenerationSummary;
  onChain?: OnChainSummary;
  relayer?: HttpSummary;
}

export interface ResultRecorder {
  readonly filePath: string;
  readonly results: AdversarialCaseResult[];
  persist(): void;
  push(result: AdversarialCaseResult): void;
}

interface DirectProofOutput {
  proof: {
    pi_a: [string, string];
    pi_b: [[string, string], [string, string]];
    pi_c: [string, string];
  };
  publicSignals: string[];
}

export function createResultRecorder(
  filename: string,
  suite: string,
): ResultRecorder {
  fs.mkdirSync(ADVERSARIAL_RESULTS_DIR, { recursive: true });

  const filePath = path.join(ADVERSARIAL_RESULTS_DIR, filename);
  const results: AdversarialCaseResult[] = [];

  const persist = () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          results,
          suite,
        },
        null,
        2,
      ),
    );
  };

  persist();

  return {
    filePath,
    persist,
    push(result) {
      results.push(result);
      persist();
    },
    results,
  };
}

export function summarizeError(error: unknown): ErrorSummary {
  const logs =
    typeof error === "object" &&
    error !== null &&
    "logs" in error &&
    Array.isArray((error as { logs?: unknown }).logs)
      ? ((error as { logs: unknown[] }).logs.filter(
          (entry): entry is string => typeof entry === "string",
        ) as string[])
      : undefined;

  if (error instanceof Error) {
    return {
      logs,
      message: error.message,
      name: error.name,
    };
  }

  return {
    logs,
    message: String(error),
  };
}

export function latestRootBytes(poolState: {
  rootCount: number | BN;
  roots: ArrayLike<ArrayLike<number>>;
}): Uint8Array {
  const rootCount = toNumber(poolState.rootCount);
  if (rootCount === 0) {
    return new Uint8Array(32);
  }

  const index = (rootCount - 1) % poolState.roots.length;
  return Uint8Array.from(poolState.roots[index]);
}

export function noteToCircuitInput(args: {
  note: Pick<Note, "nullifier" | "nullifierHash" | "secret">;
  pathElements: bigint[];
  pathIndices: number[];
  recipient: PublicKey;
  root: bigint;
}): Record<string, unknown> {
  return {
    nullifier: args.note.nullifier.toString(),
    nullifierHash: bytesToBigint(args.note.nullifierHash).toString(),
    pathElements: args.pathElements.map((value) => value.toString()),
    pathIndices: args.pathIndices,
    recipient: recipientToField(args.recipient).toString(),
    root: args.root.toString(),
    secret: args.note.secret.toString(),
  };
}

export async function attemptDirectProof(args: {
  input: Record<string, unknown>;
  treeDepth: 10 | 20;
  timeoutMs?: number;
}): Promise<ProofGenerationSummary & { proof?: DirectProofOutput["proof"] }> {
  const startedAt = Date.now();

  try {
    const snarkjs = await import("snarkjs");
    const { wasmPath, zkeyPath } = resolveCircuitArtifacts(args.treeDepth);
    const { proof, publicSignals } = (await withTimeout(
      snarkjs.groth16.fullProve(
        args.input,
        wasmPath,
        zkeyPath,
      ) as Promise<DirectProofOutput>,
      args.timeoutMs ?? PROOF_TIMEOUT_MS,
      `Proof generation timed out after ${args.timeoutMs ?? PROOF_TIMEOUT_MS}ms`,
    )) as DirectProofOutput;

    const verified = await verifyDirectProof({
      proof,
      publicSignals,
      treeDepth: args.treeDepth,
    });

    return {
      durationMs: Date.now() - startedAt,
      proof,
      publicSignals,
      status: "generated",
      verified,
    };
  } catch (error) {
    const summary = summarizeError(error);
    const timedOut = /timed out/i.test(summary.message);
    return {
      durationMs: Date.now() - startedAt,
      error: summary,
      status: timedOut ? "timed_out" : "failed",
    };
  }
}

export async function verifyDirectProof(args: {
  proof: DirectProofOutput["proof"];
  publicSignals: string[];
  treeDepth: 10 | 20;
}): Promise<boolean> {
  const snarkjs = await import("snarkjs");
  const { verificationKeyPath } = resolveCircuitArtifacts(args.treeDepth);
  const verificationKey = JSON.parse(fs.readFileSync(verificationKeyPath, "utf8"));
  return snarkjs.groth16.verify(
    verificationKey,
    args.publicSignals,
    args.proof,
  ) as Promise<boolean>;
}

export async function createManualNote(args: {
  depositIndex: number;
  nullifier: bigint;
  pool: PublicKey;
  secret: bigint;
}): Promise<Note> {
  await initPoseidon();

  return {
    commitment: bigintToBytes32(poseidonHash2(args.secret, args.nullifier)),
    depositIndex: args.depositIndex,
    nullifier: args.nullifier,
    nullifierHash: bigintToBytes32(poseidonHash1(args.nullifier)),
    poolAddress: args.pool.toBase58(),
    secret: args.secret,
  };
}

export async function createLegacyPool(
  program: Program,
  depositAmountLamports: number,
): Promise<{ pool: Keypair; poolVault: PublicKey }> {
  const provider = program.provider as anchor.AnchorProvider;
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, program.programId);

  await (program.methods as any)
    .initialize(new BN(depositAmountLamports))
    .accounts({
      authority: provider.wallet.publicKey,
      pool: pool.publicKey,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
    .rpc();

  return { pool, poolVault };
}

export async function createV2SolPool(args: {
  depositAmountLamports: number;
  program: Program;
  treeDepth: 10 | 20;
}): Promise<{ pool: Keypair; poolVault: PublicKey }> {
  const provider = args.program.provider as anchor.AnchorProvider;
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, args.program.programId);

  await (args.program.methods as any)
    .initializeV2(new BN(args.depositAmountLamports), args.treeDepth)
    .accounts({
      authority: provider.wallet.publicKey,
      pool: pool.publicKey,
      poolVault,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool])
    .preInstructions([depositPreInstruction(args.treeDepth, "sol")])
    .rpc();

  return { pool, poolVault };
}

export async function createSplPool(args: {
  decimals?: number;
  depositAmountRaw: number;
  mintAuthority?: PublicKey;
  program: Program;
}): Promise<{
  mint: PublicKey;
  pool: Keypair;
  poolVault: PublicKey;
  payer: Keypair;
}> {
  const provider = args.program.provider as anchor.AnchorProvider;
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const mint = await createMint(
    provider.connection,
    payer,
    args.mintAuthority ?? provider.wallet.publicKey,
    null,
    args.decimals ?? 6,
  );
  const pool = Keypair.generate();
  const [poolVault] = deriveVaultPda(pool.publicKey, args.program.programId);

  await (args.program.methods as any)
    .initializeSpl(new BN(args.depositAmountRaw), mint)
    .accounts({
      authority: provider.wallet.publicKey,
      pool: pool.publicKey,
      poolVault,
      systemProgram: SystemProgram.programId,
      tokenMintAccount: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([pool])
    .preInstructions([depositPreInstruction(20, "spl")])
    .rpc();

  return { mint, payer, pool, poolVault };
}

export async function depositLegacyCommitment(args: {
  commitment: Uint8Array;
  pool: PublicKey;
  poolVault: PublicKey;
  program: Program;
}): Promise<string> {
  const provider = args.program.provider as anchor.AnchorProvider;

  return (args.program.methods as any)
    .deposit(Array.from(args.commitment))
    .accounts({
      depositor: provider.wallet.publicKey,
      pool: args.pool,
      poolVault: args.poolVault,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 })])
    .rpc();
}

export async function depositV2Commitment(args: {
  commitment: Uint8Array;
  pool: PublicKey;
  poolVault: PublicKey;
  program: Program;
  treeDepth: 10 | 20;
}): Promise<string> {
  const provider = args.program.provider as anchor.AnchorProvider;
  const poolState = await (args.program.account as any).poolV2.fetch(args.pool);
  const pageIndex = Math.floor(toNumber(poolState.nextIndex) / COMMITMENT_PAGE_CAPACITY);
  const [commitmentPage] = deriveCommitmentPagePda(
    args.pool,
    pageIndex,
    args.program.programId,
  );

  return (args.program.methods as any)
    .depositV2(Array.from(args.commitment), pageIndex)
    .accounts({
      commitmentPage,
      depositor: provider.wallet.publicKey,
      pool: args.pool,
      poolVault: args.poolVault,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([depositPreInstruction(args.treeDepth, "sol")])
    .rpc();
}

export async function depositSplCommitment(args: {
  commitment: Uint8Array;
  depositorTokenAccount: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
  program: Program;
}): Promise<string> {
  const provider = args.program.provider as anchor.AnchorProvider;
  const poolState = await (args.program.account as any).poolV2.fetch(args.pool);
  const pageIndex = Math.floor(toNumber(poolState.nextIndex) / COMMITMENT_PAGE_CAPACITY);
  const [commitmentPage] = deriveCommitmentPagePda(
    args.pool,
    pageIndex,
    args.program.programId,
  );

  return (args.program.methods as any)
    .depositSpl(Array.from(args.commitment), pageIndex)
    .accounts({
      commitmentPage,
      depositor: provider.wallet.publicKey,
      depositorTokenAccount: args.depositorTokenAccount,
      pool: args.pool,
      poolVault: args.poolVault,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([depositPreInstruction(20, "spl")])
    .rpc();
}

export async function mintToWalletAta(args: {
  amountRaw: number;
  mint: PublicKey;
  owner: PublicKey;
  payer: Keypair;
  program: Program;
}): Promise<SplTokenAccount> {
  const provider = args.program.provider as anchor.AnchorProvider;
  const ata = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    args.payer,
    args.mint,
    args.owner,
  );

  await mintTo(
    provider.connection,
    args.payer,
    args.mint,
    ata.address,
    provider.wallet.publicKey,
    args.amountRaw,
  );

  return ata;
}

export async function generateValidWithdrawArtifacts(args: {
  commitments: Uint8Array[];
  note: Note;
  recipient: PublicKey;
  treeDepth: 10 | 20;
}): Promise<{
  formattedProof: {
    proofABytes: number[];
    proofBBytes: number[];
    proofCBytes: number[];
  };
  rootBytes: number[];
}> {
  const tree = new PoseidonMerkleTree(args.treeDepth);
  await tree.init();
  for (const commitment of args.commitments) {
    tree.insert(bytesToBigint(commitment));
  }

  const leafIndex = args.note.depositIndex;
  const proofAttempt = await attemptDirectProof({
    input: noteToCircuitInput({
      note: args.note,
      pathElements: tree.getProof(leafIndex).pathElements,
      pathIndices: tree.getProof(leafIndex).pathIndices,
      recipient: args.recipient,
      root: tree.getRoot(),
    }),
    treeDepth: args.treeDepth,
  });

  if (proofAttempt.status !== "generated" || !proofAttempt.proof) {
    throw new Error(
      `Expected valid proof generation to succeed, received ${proofAttempt.status}: ${
        proofAttempt.error?.message ?? "unknown error"
      }`,
    );
  }

  return {
    formattedProof: formatProof(proofAttempt.proof),
    rootBytes: Array.from(bigintToBytes32(tree.getRoot())),
  };
}

export async function sendRawInstruction(args: {
  computeUnits?: number;
  instruction: anchor.web3.TransactionInstruction;
  program: Program;
  signers?: Keypair[];
}): Promise<string> {
  const provider = args.program.provider as anchor.AnchorProvider;
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: args.computeUnits ?? 1_400_000,
    }),
    args.instruction,
  );

  return provider.sendAndConfirm(tx, args.signers ?? []);
}

export async function ensureFundedRecipient(
  program: Program,
  recipient: PublicKey,
  lamports = 2_000_000,
): Promise<void> {
  await fundSystemAccount(
    program.provider as anchor.AnchorProvider,
    recipient,
    lamports,
  );
}

export async function buildSingleLeafTree(
  commitment: Uint8Array,
  depth: 10 | 20,
): Promise<{ tree: PoseidonMerkleTree; root: bigint }> {
  const tree = new PoseidonMerkleTree(depth);
  await tree.init();
  tree.insert(bytesToBigint(commitment));

  return {
    root: tree.getRoot(),
    tree,
  };
}

export function recipientToField(recipient: PublicKey): bigint {
  return BigInt(`0x${Buffer.from(recipient.toBytes().slice(0, 31)).toString("hex")}`);
}

export function randomFieldElement(): bigint {
  const secret = Keypair.generate().secretKey.slice(0, 31);
  return BigInt(`0x${Buffer.from(secret).toString("hex")}`);
}

export function depositPreInstruction(
  treeDepth: number,
  assetType: "sol" | "spl",
) {
  return treeDepth > LEGACY_TREE_DEPTH || assetType === "spl"
    ? computeBudgetIx()
    : ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
}

export function extractNullifierRecord(
  pool: PublicKey,
  note: Note,
  programId: PublicKey,
): PublicKey {
  return deriveNullifierRecordPda(pool, note.nullifierHash, programId)[0];
}

export function isCriticalCircuitBypass(result: AdversarialCaseResult): boolean {
  return (
    result.offChainProof?.status === "generated" &&
    result.offChainProof.verified === true &&
    result.matchedExpectation === false
  ) || result.onChain?.status === "succeeded";
}

export function toNumber(value: unknown): number {
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

  throw new Error(`Cannot convert value to number: ${String(value)}`);
}

function resolveCircuitArtifacts(treeDepth: 10 | 20): {
  verificationKeyPath: string;
  wasmPath: string;
  zkeyPath: string;
} {
  if (treeDepth === 20) {
    return {
      verificationKeyPath: path.resolve(process.cwd(), "build/verification_key_20.json"),
      wasmPath: path.resolve(process.cwd(), "build/withdraw_20_js/withdraw_20.wasm"),
      zkeyPath: path.resolve(process.cwd(), "build/withdraw_20_final.zkey"),
    };
  }

  return {
    verificationKeyPath: path.resolve(process.cwd(), "build/verification_key.json"),
    wasmPath: path.resolve(process.cwd(), "build/withdraw_js/withdraw.wasm"),
    zkeyPath: path.resolve(process.cwd(), "build/withdraw_final.zkey"),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
