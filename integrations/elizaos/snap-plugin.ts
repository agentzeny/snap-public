import type {
  Action,
  HandlerCallback,
  Plugin,
} from "@elizaos/core";
import type { Content } from "@elizaos/core";
import {
  formatAssetLabel,
  getShieldedBalance,
  parsePoolAddress,
  parseRecipientAddress,
  type SnapClientLike,
} from "../shared/snap-client";

/**
 * ElizaOS plugin for SNAP private payments.
 *
 * Registers actions: SNAP_DEPOSIT, SNAP_WITHDRAW, SNAP_BALANCE
 *
 * Usage in ElizaOS character config:
 *   plugins: ["./integrations/elizaos/snap-plugin"]
 *
 * Targets @elizaos/core 2.0.0-alpha.77 style Plugin/Action interfaces.
 */
export interface ElizaSnapDependencies {
  poolAddress: string;
  recipientAddress?: string;
  snapClient: SnapClientLike;
  noteProvider?: () => unknown;
  viewingKeyProvider?: () => unknown;
}

export function createSnapPlugin(deps: ElizaSnapDependencies): Plugin {
  return {
    name: "snap-private-payments",
    description: "Private agent payments via zero-knowledge proofs",
    actions: [
      createSnapDepositAction(deps),
      createSnapWithdrawAction(deps),
      createSnapBalanceAction(deps),
    ],
  };
}

export const snapPlugin: Plugin = createSnapPlugin({
  poolAddress: process.env.SNAP_POOL_ADDRESS ?? "",
  recipientAddress: process.env.SNAP_RECIPIENT_ADDRESS,
  snapClient: undefined as unknown as SnapClientLike,
});

export function createSnapDepositAction(deps: ElizaSnapDependencies): Action {
  return {
    name: "SNAP_DEPOSIT",
    description: "Deposit into a SNAP shielded pool",
    similes: ["shield funds", "deposit into snap pool"],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options, callback) => {
      const rawAmount = extractParameters(options).amount;
      const amount =
        typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("SNAP_DEPOSIT requires a positive numeric amount");
      }

      const pool = parsePoolAddress(deps.poolAddress);
      const deposit = await deps.snapClient.deposit(pool, amount);
      const poolInfo = await deps.snapClient.getPoolInfo(pool);
      const text = `Deposited ${formatAssetLabel(poolInfo)} into SNAP at index ${deposit.depositIndex}.`;
      await emitCallback(callback, text, "SNAP_DEPOSIT");
      return {
        success: true,
        text,
        data: {
          depositIndex: deposit.depositIndex,
        },
      };
    },
  };
}

export function createSnapWithdrawAction(deps: ElizaSnapDependencies): Action {
  return {
    name: "SNAP_WITHDRAW",
    description: "Withdraw from a SNAP shielded pool",
    similes: ["claim snap payment", "withdraw shielded funds"],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options, callback) => {
      const params = extractParameters(options);
      const note = params.note ?? deps.noteProvider?.();
      const recipientAddress =
        (typeof params.recipientAddress === "string"
          ? params.recipientAddress
          : undefined) ?? deps.recipientAddress;

      if (!note || !recipientAddress) {
        throw new Error(
          "SNAP_WITHDRAW requires both a note and recipientAddress",
        );
      }

      const signature = await deps.snapClient.withdraw(
        parsePoolAddress(deps.poolAddress),
        note,
        parseRecipientAddress(recipientAddress),
      );
      const text = `Withdrew SNAP funds to ${recipientAddress}. Transaction: ${signature}.`;
      await emitCallback(callback, text, "SNAP_WITHDRAW");
      return {
        success: true,
        text,
        data: {
          transaction: signature,
        },
      };
    },
  };
}

export function createSnapBalanceAction(deps: ElizaSnapDependencies): Action {
  return {
    name: "SNAP_BALANCE",
    description: "Check private SNAP balance using a viewing key",
    similes: ["check snap balance", "private pool balance"],
    validate: async () => true,
    handler: async (_runtime, _message, _state, _options, callback) => {
      const viewingKey = deps.viewingKeyProvider?.();
      if (!viewingKey) {
        throw new Error("SNAP_BALANCE requires a viewing key provider");
      }

      const balance = await getShieldedBalance(
        deps.snapClient,
        parsePoolAddress(deps.poolAddress),
        viewingKey,
      );
      const text = `Private SNAP balance: ${balance}.`;
      await emitCallback(callback, text, "SNAP_BALANCE");
      return {
        success: true,
        text,
        data: {
          balance,
        },
      };
    },
  };
}

function extractParameters(
  options: unknown,
): Record<string, unknown> {
  if (
    options &&
    typeof options === "object" &&
    "parameters" in options &&
    typeof (options as { parameters?: unknown }).parameters === "object"
  ) {
    return (options as { parameters: Record<string, unknown> }).parameters;
  }

  return {};
}

async function emitCallback(
  callback: HandlerCallback | undefined,
  text: string,
  actionName: string,
): Promise<void> {
  if (!callback) {
    return;
  }

  const content: Content = {
    text,
  } as Content;
  await callback(content, actionName);
}
