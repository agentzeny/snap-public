import {
  ActionProvider,
  CreateAction,
  type Action,
  type Network,
} from "@coinbase/agentkit";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { formatAssetLabel, type SnapClientLike } from "../shared/snap-client";

/**
 * Coinbase AgentKit action provider for SNAP.
 *
 * Registers: snap_deposit, snap_withdraw, snap_withdraw_private
 *
 * Compatible with AgentKit's framework-agnostic action system.
 * Targets @coinbase/agentkit 0.10.4.
 */
const depositSchema = z.object({
  pool: z.string().min(32),
  amount: z.number().positive(),
});

const withdrawSchema = z.object({
  pool: z.string().min(32),
  note: z.unknown(),
  recipient: z.string().min(32),
});

const withdrawPrivateSchema = z.object({
  pool: z.string().min(32),
  note: z.unknown(),
  recipient: z.string().min(32),
  relayerUrl: z.string().url().optional(),
});

export class SNAPActionProvider extends ActionProvider {
  constructor(
    private readonly snapClient: SnapClientLike,
    private readonly defaults: { relayerUrl?: string } = {},
  ) {
    super("snap-private-payments", []);
  }

  supportsNetwork(_network: Network): boolean {
    return true;
  }

  override getActions(): Action[] {
    return [
      {
        name: "snap_deposit",
        description: "Deposit into a SNAP privacy pool",
        schema: depositSchema,
        invoke: async (args) => {
          const pool = new PublicKey(args.pool);
          const deposit = await this.snapClient.deposit(pool, args.amount);
          const poolInfo = await this.snapClient.getPoolInfo(pool);
          return `Deposited ${formatAssetLabel(poolInfo)} into SNAP at index ${deposit.depositIndex}.`;
        },
      },
      {
        name: "snap_withdraw",
        description: "Withdraw from a SNAP privacy pool",
        schema: withdrawSchema,
        invoke: async (args) => {
          const signature = await this.snapClient.withdraw(
            new PublicKey(args.pool),
            args.note,
            new PublicKey(args.recipient),
          );
          return `Withdrew from SNAP. Transaction: ${signature}.`;
        },
      },
      {
        name: "snap_withdraw_private",
        description: "Withdraw from a SNAP pool through a relayer",
        schema: withdrawPrivateSchema,
        invoke: async (args) => {
          const relayerUrl = args.relayerUrl ?? this.defaults.relayerUrl;
          if (!relayerUrl) {
            throw new Error(
              "snap_withdraw_private requires relayerUrl or a provider default",
            );
          }

          const result = await this.snapClient.withdrawViaRelayer(
            new PublicKey(args.pool),
            args.note,
            new PublicKey(args.recipient),
            relayerUrl,
          );
          return `Privately withdrew from SNAP via relayer. Transaction: ${result.txSignature}. Fee: ${result.fee}.`;
        },
      },
    ];
  }
}

void CreateAction;
