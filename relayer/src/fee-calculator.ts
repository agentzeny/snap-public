export const DEFAULT_RELAYER_FEE_BPS = 50;
export const DEFAULT_MIN_FEE_LAMPORTS = 10_000;

export function calculateFee(
  withdrawAmountLamports: number,
  feeBps = DEFAULT_RELAYER_FEE_BPS,
  minFeeLamports = DEFAULT_MIN_FEE_LAMPORTS,
): number {
  if (!Number.isInteger(withdrawAmountLamports) || withdrawAmountLamports <= 0) {
    throw new Error("Relayer: withdraw amount must be a positive lamport amount");
  }

  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error("Relayer: fee basis points must be a non-negative integer");
  }

  if (!Number.isInteger(minFeeLamports) || minFeeLamports < 0) {
    throw new Error("Relayer: minimum fee must be a non-negative integer");
  }

  const bpsFee = Math.floor((withdrawAmountLamports * feeBps) / 10_000);
  return Math.max(bpsFee, minFeeLamports);
}
