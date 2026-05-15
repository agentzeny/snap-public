export interface SnapKnownPool {
  address: string;
  assetType: "sol" | "spl";
  depositAmount: number;
  label: string;
  tokenMint?: string;
}

export const SNAP_MAINNET_PROGRAM_ID =
  "9uePoqdgaXpqFLQM2ED1GGQrwSEiqe3r6tW1AfsnrrbS";
export const SNAP_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
export const SNAP_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SNAP_MAINNET_SOL_POOL_ADDRESS =
  "B8SyffZKt8LABKogWjH9rZcjY5PV2hyYRCbTxxbcrpFf";

export const SNAP_MAINNET_POOLS: SnapKnownPool[] = [
  {
    label: "0.1 SOL",
    address: SNAP_MAINNET_SOL_POOL_ADDRESS,
    depositAmount: 0.1,
    assetType: "sol",
  },
  {
    label: "1 USDC",
    address: "5LeuHrPBgHNhgbCy996MEjcsBk5gNHhVj6AiuuCHZ8od",
    depositAmount: 1,
    assetType: "spl",
    tokenMint: SNAP_USDC_MINT,
  },
  {
    label: "10 USDC",
    address: "ECuHf8kgiWfmL3Q6id4WGBQWvuukhzqvF5vsxuPAKZBv",
    depositAmount: 10,
    assetType: "spl",
    tokenMint: SNAP_USDC_MINT,
  },
];

export function listKnownPools(
  configuredPoolAddress?: string,
  pools: SnapKnownPool[] = SNAP_MAINNET_POOLS
): SnapKnownPool[] {
  if (
    !configuredPoolAddress ||
    pools.some((pool) => pool.address === configuredPoolAddress)
  ) {
    return pools;
  }

  return [
    {
      label: "Configured pool",
      address: configuredPoolAddress,
      depositAmount: 0,
      assetType: "sol",
    },
    ...pools,
  ];
}
