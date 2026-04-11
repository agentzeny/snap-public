import {
  type Action,
  createLangchainTools,
  type SolanaAgentKit,
} from "solana-agent-kit";
import type { SpendPolicy } from "@snap-protocol/sdk";
import { z } from "zod";
import {
  createSnapPool,
  depositToSnapPool,
  withdrawFromSnapPool,
  withdrawFromSnapPoolPrivately,
  type SNAPToolOptions,
} from "./snap-tool";

export interface SNAPPluginOptions extends SNAPToolOptions {
  spendPolicy?: SpendPolicy;
}

export const snapCreatePoolSchema = z.object({
  denomination: z
    .number()
    .positive("Denomination must be greater than zero")
    .describe("Fixed pool denomination in SOL or token units"),
  token_mint: z
    .string()
    .min(32, "Invalid token mint address")
    .optional()
    .describe("Optional SPL token mint address. Omit for native SOL pools."),
});

export const snapDepositSchema = z.object({
  pool: z.string().min(32, "Invalid pool address"),
  amount: z
    .number()
    .positive("Amount must be greater than zero")
    .optional()
    .describe("Optional deposit amount. Must match the pool denomination if provided."),
});

export const snapWithdrawSchema = z.object({
  pool: z.string().min(32, "Invalid pool address"),
  note: z
    .string()
    .min(1, "Serialized SNAP note is required")
    .describe("Serialized note returned by snap_deposit"),
});

export const snapWithdrawPrivateSchema = z.object({
  pool: z.string().min(32, "Invalid pool address"),
  note: z
    .string()
    .min(1, "Serialized SNAP note is required")
    .describe("Serialized note returned by snap_deposit"),
  relayer_url: z
    .string()
    .url("Relayer URL must be a valid URL")
    .optional()
    .describe("Optional relayer base URL. Defaults to http://localhost:3000."),
});

export function createSnapCreatePoolAction(
  options: SNAPPluginOptions = {},
): Action {
  return {
    name: "snap_create_pool",
    similes: [
      "create private payment pool",
      "open shielded pool",
      "create snap pool",
    ],
    description:
      "Create a new shielded payment pool with a fixed SOL or SPL-token denomination for private SNAP payments.",
    examples: [
      [
        {
          input: { denomination: 0.1 },
          output: {
            success: true,
            pool: "9tRkLzRz6X7b3jxBvXv8L9tMCKb7W4XvFJjF5M1mV6Yx",
            denomination: 0.1,
          },
          explanation: "Create a 0.1 SOL shielded pool.",
        },
      ],
      [
        {
          input: {
            denomination: 1,
            token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          },
          output: {
            success: true,
            pool: "9tRkLzRz6X7b3jxBvXv8L9tMCKb7W4XvFJjF5M1mV6Yx",
            denomination: 1,
            tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          },
          explanation: "Create a 1 USDC-equivalent shielded SPL pool.",
        },
      ],
    ],
    schema: snapCreatePoolSchema,
    handler: async (agent: SolanaAgentKit, input: Record<string, unknown>) =>
      createSnapPool(
        agent,
        input.denomination as number,
        input.token_mint as string | undefined,
        options,
      ),
  };
}

export function createSnapDepositAction(
  options: SNAPPluginOptions = {},
): Action {
  return {
    name: "snap_deposit",
    similes: [
      "make private deposit",
      "deposit into shielded pool",
      "generate snap note",
    ],
    description:
      "Deposit SOL or SPL tokens into a SNAP shielded pool. Returns a secret note that must be shared with the recipient off-chain.",
    examples: [
      [
        {
          input: {
            pool: "9tRkLzRz6X7b3jxBvXv8L9tMCKb7W4XvFJjF5M1mV6Yx",
            amount: 0.1,
          },
          output: {
            success: true,
            pool: "9tRkLzRz6X7b3jxBvXv8L9tMCKb7W4XvFJjF5M1mV6Yx",
            amount: 0.1,
            note: "{\"s\":\"...\"}",
          },
          explanation: "Deposit into a shielded pool and return the serialized note.",
        },
      ],
    ],
    schema: snapDepositSchema,
    handler: async (agent: SolanaAgentKit, input: Record<string, unknown>) =>
      depositToSnapPool(
        agent,
        input.pool as string,
        input.amount as number | undefined,
        options,
      ),
  };
}

export function createSnapWithdrawAction(
  options: SNAPPluginOptions = {},
): Action {
  return {
    name: "snap_withdraw",
    similes: [
      "withdraw private payment",
      "redeem snap note",
      "claim shielded funds",
    ],
    description:
      "Withdraw SOL or SPL tokens from a shielded pool using a secret SNAP note. Generates a ZK proof automatically.",
    examples: [
      [
        {
          input: {
            pool: "9tRkLzRz6X7b3jxBvXv8L9tMCKb7W4XvFJjF5M1mV6Yx",
            note: "{\"s\":\"...\"}",
          },
          output: {
            success: true,
            amount: 0.1,
            transaction: "5UfgJ5wVZxUxefDGqzqkVLHzHxVTyYH9StYyHKgvHYmXJgqJKxEqy9k4Rz9LpXrHF9kUZB7",
          },
          explanation: "Withdraw the shielded deposit to the current agent wallet.",
        },
      ],
    ],
    schema: snapWithdrawSchema,
    handler: async (agent: SolanaAgentKit, input: Record<string, unknown>) =>
      withdrawFromSnapPool(
        agent,
        input.pool as string,
        input.note as string,
        options,
      ),
  };
}

export function createSnapWithdrawPrivateAction(
  options: SNAPPluginOptions = {},
): Action {
  return {
    name: "snap_withdraw_private",
    similes: [
      "withdraw with relayer",
      "private relayed withdrawal",
      "maximum privacy withdrawal",
    ],
    description:
      "Withdraw SOL or SPL tokens from a shielded pool using a relayer for maximum privacy. A third-party relayer submits the transaction so the recipient wallet never appears as the gas payer. A relayer fee is deducted from the withdrawal amount.",
    examples: [
      [
        {
          input: {
            pool: "9tRkLzRz6X7b3jxBvXv8L9tMCKb7W4XvFJjF5M1mV6Yx",
            note: "{\"s\":\"...\"}",
            relayer_url: "http://localhost:3000",
          },
          output: {
            success: true,
            amount: 0.1,
            fee: 0.0005,
            recipientReceived: 0.0995,
            transaction: "5UfgJ5wVZxUxefDGqzqkVLHzHxVTyYH9StYyHKgvHYmXJgqJKxEqy9k4Rz9LpXrHF9kUZB7",
          },
          explanation: "Withdraw the shielded deposit through a relayer so the recipient wallet never pays gas on-chain.",
        },
      ],
    ],
    schema: snapWithdrawPrivateSchema,
    handler: async (agent: SolanaAgentKit, input: Record<string, unknown>) =>
      withdrawFromSnapPoolPrivately(
        agent,
        input.pool as string,
        input.note as string,
        input.relayer_url as string | undefined,
        options,
      ),
  };
}

export function createSnapActions(
  options: SNAPPluginOptions = {},
): Action[] {
  return [
    createSnapCreatePoolAction(options),
    createSnapDepositAction(options),
    createSnapWithdrawAction(options),
    createSnapWithdrawPrivateAction(options),
  ];
}

export const snapCreatePoolAction = createSnapCreatePoolAction();
export const snapDepositAction = createSnapDepositAction();
export const snapWithdrawAction = createSnapWithdrawAction();
export const snapWithdrawPrivateAction = createSnapWithdrawPrivateAction();
export const snapActions = createSnapActions();

export function createSNAPLangchainTools(
  agent: SolanaAgentKit,
  options: SNAPPluginOptions = {},
) {
  return createLangchainTools(agent, createSnapActions(options));
}
