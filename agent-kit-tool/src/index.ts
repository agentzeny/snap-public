import type { Plugin } from "solana-agent-kit";
import {
  createSnapPool,
  depositToSnapPool,
  withdrawFromSnapPool,
  withdrawFromSnapPoolPrivately,
  type SNAPToolOptions,
} from "./snap-tool";
import {
  createSNAPLangchainTools,
  createSnapActions,
  createSnapCreatePoolAction,
  createSnapDepositAction,
  createSnapWithdrawAction,
  createSnapWithdrawPrivateAction,
  snapActions,
  snapCreatePoolAction,
  snapDepositAction,
  snapWithdrawAction,
  snapWithdrawPrivateAction,
  type SNAPPluginOptions,
} from "./tool-definitions";

export function createSNAPPlugin(
  options: SNAPPluginOptions = {},
): Plugin {
  const toolOptions: SNAPToolOptions = {
    spendPolicy: options.spendPolicy,
  };

  return {
    name: "snap",
    methods: {
      snapCreatePool: (
        agent: Parameters<typeof createSnapPool>[0],
        denomination: Parameters<typeof createSnapPool>[1],
        tokenMint?: Parameters<typeof createSnapPool>[2],
      ) => createSnapPool(agent, denomination, tokenMint, toolOptions),
      snapDeposit: (
        agent: Parameters<typeof depositToSnapPool>[0],
        pool: Parameters<typeof depositToSnapPool>[1],
        amount?: Parameters<typeof depositToSnapPool>[2],
      ) => depositToSnapPool(agent, pool, amount, toolOptions),
      snapWithdraw: (
        agent: Parameters<typeof withdrawFromSnapPool>[0],
        pool: Parameters<typeof withdrawFromSnapPool>[1],
        note: Parameters<typeof withdrawFromSnapPool>[2],
      ) => withdrawFromSnapPool(agent, pool, note, toolOptions),
      snapWithdrawPrivate: (
        agent: Parameters<typeof withdrawFromSnapPoolPrivately>[0],
        pool: Parameters<typeof withdrawFromSnapPoolPrivately>[1],
        note: Parameters<typeof withdrawFromSnapPoolPrivately>[2],
        relayerUrl?: Parameters<typeof withdrawFromSnapPoolPrivately>[3],
      ) =>
        withdrawFromSnapPoolPrivately(
          agent,
          pool,
          note,
          relayerUrl,
          toolOptions,
        ),
    },
    actions: createSnapActions(toolOptions),
    initialize(): void {
      // No plugin-level initialization is required today.
    },
  };
}

export const SNAPPlugin: Plugin = createSNAPPlugin();

export {
  createSnapPool,
  depositToSnapPool,
  withdrawFromSnapPool,
  withdrawFromSnapPoolPrivately,
  createSNAPLangchainTools,
  createSnapActions,
  createSnapCreatePoolAction,
  createSnapDepositAction,
  createSnapWithdrawAction,
  createSnapWithdrawPrivateAction,
  snapActions,
  snapCreatePoolAction,
  snapDepositAction,
  snapWithdrawAction,
  snapWithdrawPrivateAction,
};

export type { SNAPToolOptions, SNAPPluginOptions };

export default SNAPPlugin;
