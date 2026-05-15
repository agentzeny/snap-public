import {
  estimateWithdrawalFee,
  formatAssetLabel,
  formatWithdrawalEstimate,
  getShieldedBalance,
  parsePoolAddress,
  parseRecipientAddress,
  type SnapClientLike,
} from "../shared/snap-client";
import {
  listKnownPools,
  SNAP_MAINNET_SOL_POOL_ADDRESS,
  type SnapKnownPool,
} from "../shared/pools";

export interface Content {
  text: string;
  [key: string]: unknown;
}

export type HandlerCallback = (
  response: Content,
  actionName?: string
) => Promise<unknown>;

export interface ActionParameter {
  name: string;
  description: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  text?: string;
  data?: Record<string, unknown>;
}

export interface Action {
  name: string;
  description: string;
  handler: (
    runtime: unknown,
    message: unknown,
    state?: unknown,
    options?: unknown,
    callback?: HandlerCallback
  ) => Promise<ActionResult | undefined>;
  validate: (
    runtime: unknown,
    message: unknown,
    state?: unknown
  ) => Promise<boolean>;
  similes?: string[];
  parameters?: ActionParameter[];
}

export interface Plugin {
  name: string;
  description: string;
  actions?: Action[];
}

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
  pools?: SnapKnownPool[];
  poolAddress: string;
  recipientAddress?: string;
  relayerUrl?: string;
  snapClient: SnapClientLike;
  noteProvider?: () => unknown;
  viewingKeyProvider?: () => unknown;
}

export function createSnapPlugin(deps: ElizaSnapDependencies): Plugin {
  return {
    name: "snap-private-payments",
    description: "Private agent payments via zero-knowledge proofs",
    actions: [
      createSnapListPoolsAction(deps),
      createSnapDepositAction(deps),
      createSnapWithdrawAction(deps),
      createSnapEstimateFeeAction(deps),
      createSnapBalanceAction(deps),
    ],
  };
}

export const snapPlugin: Plugin = createSnapPlugin({
  poolAddress: process.env.SNAP_POOL_ADDRESS ?? SNAP_MAINNET_SOL_POOL_ADDRESS,
  recipientAddress: process.env.SNAP_RECIPIENT_ADDRESS,
  relayerUrl: process.env.SNAP_RELAYER_URL,
  snapClient: undefined as unknown as SnapClientLike,
});

export function createSnapListPoolsAction(deps: ElizaSnapDependencies): Action {
  return {
    name: "SNAP_LIST_POOLS",
    description: "List available SNAP shielded payment pools",
    similes: ["list snap pools", "show private payment pools"],
    parameters: [],
    validate: async () => true,
    handler: async (_runtime, _message, _state, _options, callback) => {
      const pools = listKnownPools(deps.poolAddress, deps.pools);
      const text = JSON.stringify({ pools }, null, 2);
      await emitCallback(callback, text, "SNAP_LIST_POOLS");
      return {
        success: true,
        text,
        data: { pools },
      };
    },
  };
}

export function createSnapDepositAction(deps: ElizaSnapDependencies): Action {
  return {
    name: "SNAP_DEPOSIT",
    description: "Deposit into a SNAP shielded pool",
    similes: ["shield funds", "deposit into snap pool"],
    parameters: [
      {
        name: "amount",
        description: "Optional fixed pool denomination to deposit",
        required: false,
        schema: { type: "number" },
      },
      {
        name: "poolAddress",
        description: "Optional SNAP pool address override",
        required: false,
        schema: { type: "string" },
      },
    ],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options, callback) => {
      const params = extractParameters(options);
      const rawAmount = params.amount;
      const amount =
        rawAmount === undefined
          ? undefined
          : typeof rawAmount === "number"
          ? rawAmount
          : Number(rawAmount);
      if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
        throw new Error("SNAP_DEPOSIT requires a positive numeric amount");
      }

      const pool = parsePoolAddress(
        stringParam(params.poolAddress) ?? deps.poolAddress
      );
      const deposit = await deps.snapClient.deposit(pool, amount);
      const poolInfo = await deps.snapClient.getPoolInfo(pool);
      const text = `Deposited ${formatAssetLabel(
        poolInfo
      )} into SNAP at index ${deposit.depositIndex}.`;
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
    parameters: [
      {
        name: "note",
        description: "SNAP note object or serialized note",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "recipientAddress",
        description: "Recipient wallet address",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "relayerUrl",
        description: "Optional relayer URL for relayed withdrawal",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "poolAddress",
        description: "Optional SNAP pool address override",
        required: false,
        schema: { type: "string" },
      },
    ],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options, callback) => {
      const params = extractParameters(options);
      const note = params.note ?? deps.noteProvider?.();
      const recipientAddress =
        stringParam(params.recipientAddress) ?? deps.recipientAddress;
      const relayerUrl = stringParam(params.relayerUrl) ?? deps.relayerUrl;
      const pool = parsePoolAddress(
        stringParam(params.poolAddress) ?? deps.poolAddress
      );

      if (!note || !recipientAddress) {
        throw new Error(
          "SNAP_WITHDRAW requires both a note and recipientAddress"
        );
      }

      const result = relayerUrl
        ? await deps.snapClient.withdrawViaRelayer(
            pool,
            note,
            parseRecipientAddress(recipientAddress),
            relayerUrl
          )
        : await deps.snapClient.withdraw(
            pool,
            note,
            parseRecipientAddress(recipientAddress)
          );
      const signature =
        typeof result === "string" ? result : result.txSignature;
      const text = relayerUrl
        ? `Withdrew SNAP funds to ${recipientAddress} through a relayer. Transaction: ${signature}.`
        : `Withdrew SNAP funds to ${recipientAddress}. Transaction: ${signature}.`;
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

export function createSnapEstimateFeeAction(
  deps: ElizaSnapDependencies
): Action {
  return {
    name: "SNAP_ESTIMATE_FEE",
    description: "Estimate SNAP withdrawal fees",
    similes: ["estimate snap fee", "how much does snap withdrawal cost"],
    parameters: [
      {
        name: "poolAddress",
        description: "Optional SNAP pool address override",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "relayerUrl",
        description: "Optional relayer URL to include relayer fee",
        required: false,
        schema: { type: "string" },
      },
    ],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options, callback) => {
      const params = extractParameters(options);
      const pool = parsePoolAddress(
        stringParam(params.poolAddress) ?? deps.poolAddress
      );
      const poolInfo = await deps.snapClient.getPoolInfo(pool);
      const estimate = await estimateWithdrawalFee(
        deps.snapClient,
        pool,
        stringParam(params.relayerUrl) ?? deps.relayerUrl
      );
      const text = formatWithdrawalEstimate(estimate, poolInfo);
      await emitCallback(callback, text, "SNAP_ESTIMATE_FEE");
      return {
        success: true,
        text,
        data: estimate as unknown as Record<string, unknown>,
      };
    },
  };
}

export function createSnapBalanceAction(deps: ElizaSnapDependencies): Action {
  return {
    name: "SNAP_BALANCE",
    description: "Check private SNAP balance using a viewing key",
    similes: ["check snap balance", "private pool balance"],
    parameters: [],
    validate: async () => true,
    handler: async (_runtime, _message, _state, _options, callback) => {
      const viewingKey = deps.viewingKeyProvider?.();
      if (!viewingKey) {
        throw new Error("SNAP_BALANCE requires a viewing key provider");
      }

      const balance = await getShieldedBalance(
        deps.snapClient,
        parsePoolAddress(deps.poolAddress),
        viewingKey
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

function extractParameters(options: unknown): Record<string, unknown> {
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

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function emitCallback(
  callback: HandlerCallback | undefined,
  text: string,
  actionName: string
): Promise<void> {
  if (!callback) {
    return;
  }

  const content: Content = {
    text,
  } as Content;
  await callback(content, actionName);
}
