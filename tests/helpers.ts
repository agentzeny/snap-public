import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { bigintToBytes } from "../sdk/proof";

const FIELD_PRIME = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

export function formatProof(proof: {
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
}) {
  const proofABytes = negateG1Y([
    ...bigintToBytes(BigInt(proof.pi_a[0]), 32),
    ...bigintToBytes(BigInt(proof.pi_a[1]), 32),
  ]);
  const proofBBytes = [
    ...bigintToBytes(BigInt(proof.pi_b[0][1]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[0][0]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[1][1]), 32),
    ...bigintToBytes(BigInt(proof.pi_b[1][0]), 32),
  ];
  const proofCBytes = [
    ...bigintToBytes(BigInt(proof.pi_c[0]), 32),
    ...bigintToBytes(BigInt(proof.pi_c[1]), 32),
  ];
  return { proofABytes, proofBBytes, proofCBytes };
}

export function deriveVaultPda(
  pool: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), pool.toBuffer()],
    programId,
  );
}

export function deriveNullifierRecordPda(
  pool: PublicKey,
  nullifierHash: Uint8Array,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), pool.toBuffer(), Buffer.from(nullifierHash)],
    programId,
  );
}

export function deriveCommitmentPagePda(
  pool: PublicKey,
  pageIndex: number,
  programId: PublicKey,
): [PublicKey, number] {
  const indexBytes = Buffer.alloc(4);
  indexBytes.writeUInt32LE(pageIndex, 0);

  return PublicKey.findProgramAddressSync(
    [Buffer.from("commitment_page"), pool.toBuffer(), indexBytes],
    programId,
  );
}

export async function fundSystemAccount(
  provider: anchor.AnchorProvider,
  recipient: PublicKey,
  lamports: number,
): Promise<void> {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: recipient,
      lamports,
    }),
  );
  await provider.sendAndConfirm(tx);
}

export function computeBudgetIx(units = 1_400_000) {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

type ComputeUnitSource =
  | {
      computeUnitsConsumed?: number | null;
      logMessages?: string[] | null;
    }
  | string[]
  | null
  | undefined;

export function extractComputeUnits(source: ComputeUnitSource): number | null {
  if (!source) {
    return null;
  }

  if (!Array.isArray(source) && typeof source.computeUnitsConsumed === "number") {
    return source.computeUnitsConsumed;
  }

  const logs = Array.isArray(source) ? source : source.logMessages;
  if (!logs) {
    return null;
  }

  for (const log of logs) {
    const match = log.match(/consumed (\d+) of (\d+) compute units/i);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

export async function fetchTransactionComputeUnits(
  connection: Connection,
  signature: string,
  attempts = 10,
  delayMs = 250,
): Promise<number | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const units = extractComputeUnits(tx?.meta);
    if (units !== null) {
      return units;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

export async function fetchConfirmedTransaction(
  connection: Connection,
  signature: string,
  attempts = 10,
  delayMs = 250,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta?.logMessages?.length) {
      return tx;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

function negateG1Y(proofABytes: number[]): number[] {
  const yBytes = proofABytes.slice(32, 64);
  let y = BigInt(0);

  for (const byte of yBytes) {
    y = (y << BigInt(8)) | BigInt(byte);
  }

  const negatedY = FIELD_PRIME - y;
  return [...proofABytes.slice(0, 32), ...bigintToBytes(negatedY, 32)];
}
