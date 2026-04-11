import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { SNAPClient } from "@snap-protocol/sdk";
import {
  createSNAPLangchainTools,
  createSNAPPlugin,
  SNAPPlugin,
  snapCreatePoolAction,
  snapDepositAction,
  snapWithdrawAction,
  snapWithdrawPrivateAction,
} from "../src";

describe("SNAP Agent Kit tool", function () {
  this.timeout(60000);

  const originalCreatePool = SNAPClient.prototype.createPool;
  const originalDeposit = SNAPClient.prototype.deposit;
  const originalGetPoolInfo = SNAPClient.prototype.getPoolInfo;
  const originalWithdraw = SNAPClient.prototype.withdraw;
  const originalWithdrawViaRelayer = SNAPClient.prototype.withdrawViaRelayer;

  let lastCreatePoolOptions: unknown;
  let sawSpendLimiter = false;

  beforeEach(() => {
    lastCreatePoolOptions = undefined;
    sawSpendLimiter = false;

    SNAPClient.prototype.createPool = async function (
      _denomination: number,
      options?: unknown,
    ) {
      lastCreatePoolOptions = options;
      return Keypair.generate().publicKey;
    };

    SNAPClient.prototype.getPoolInfo = async function (pool) {
      return {
        address: pool,
        authority: Keypair.generate().publicKey,
        depositAmount: 0.1,
        depositAmountRaw: 100_000_000,
        depositCount: 1,
        withdrawCount: 0,
        currentRoot: new Uint8Array(32),
        tokenMint: null,
        tokenDecimals: null,
        assetType: "sol" as const,
        treeDepth: 20,
        nullifierVersion: 1,
        legacy: false,
      };
    };

    SNAPClient.prototype.deposit = async function (pool) {
      return {
        secret: 1n,
        nullifier: 2n,
        commitment: new Uint8Array(32).fill(3),
        nullifierHash: new Uint8Array(32).fill(4),
        depositIndex: 0,
        poolAddress: pool.toBase58(),
      };
    };

    SNAPClient.prototype.withdraw = async function () {
      sawSpendLimiter = Boolean((this as any).spendLimiter);
      return "mock-withdraw-signature";
    };

    SNAPClient.prototype.withdrawViaRelayer = async function () {
      sawSpendLimiter = Boolean((this as any).spendLimiter);
      return {
        txSignature: "mock-relayed-withdraw-signature",
        fee: 0.0005,
        recipientReceived: 0.0995,
      };
    };
  });

  after(() => {
    SNAPClient.prototype.createPool = originalCreatePool;
    SNAPClient.prototype.deposit = originalDeposit;
    SNAPClient.prototype.getPoolInfo = originalGetPoolInfo;
    SNAPClient.prototype.withdraw = originalWithdraw;
    SNAPClient.prototype.withdrawViaRelayer = originalWithdrawViaRelayer;
  });

  it("runs the SNAP actions end-to-end", async () => {
    const agent = {
      connection: {},
      wallet: { publicKey: Keypair.generate().publicKey },
      config: {},
    };

    const createResult = await snapCreatePoolAction.handler(agent as never, {
      denomination: 0.1,
    });
    const depositResult = await snapDepositAction.handler(agent as never, {
      pool: createResult.pool as string,
      amount: 0.1,
    });
    const withdrawResult = await snapWithdrawAction.handler(agent as never, {
      pool: createResult.pool as string,
      note: depositResult.note as string,
    });
    const withdrawPrivateResult = await snapWithdrawPrivateAction.handler(agent as never, {
      pool: createResult.pool as string,
      note: depositResult.note as string,
      relayer_url: "http://localhost:3000",
    });

    expect(createResult.success).to.equal(true);
    expect(depositResult.success).to.equal(true);
    expect(withdrawResult.success).to.equal(true);
    expect(withdrawPrivateResult.success).to.equal(true);
    expect(withdrawResult.transaction).to.equal("mock-withdraw-signature");
    expect(withdrawPrivateResult.transaction).to.equal(
      "mock-relayed-withdraw-signature",
    );
    expect(withdrawPrivateResult.fee).to.equal(0.0005);
  });

  it("supports token pool creation and plugin-level spend policy injection", async () => {
    const spendPolicy = {
      maxPerTransaction: 100,
      maxPerHour: 500,
      maxPerDay: 1_000,
      requireOwnerApproval: 0,
      allowedPools: [],
    };
    const plugin = createSNAPPlugin({ spendPolicy });
    const agent = {
      connection: {},
      wallet: { publicKey: Keypair.generate().publicKey },
      config: {},
    };

    const createAction = plugin.actions.find((action) => action.name === "snap_create_pool");
    const withdrawAction = plugin.actions.find((action) => action.name === "snap_withdraw");
    expect(createAction).to.not.equal(undefined);
    expect(withdrawAction).to.not.equal(undefined);

    const createResult = await createAction!.handler(agent as never, {
      denomination: 1,
      token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });

    await withdrawAction!.handler(agent as never, {
      pool: createResult.pool as string,
      note: JSON.stringify({
        s: "1",
        n: "2",
        c: "03".repeat(32),
        nh: "04".repeat(32),
        di: 0,
        pa: createResult.pool,
      }),
    });

    expect((lastCreatePoolOptions as { tokenMint?: string } | undefined)?.tokenMint).to.equal(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(sawSpendLimiter).to.equal(true);
  });

  it("exports a current Solana Agent Kit v2 plugin and LangChain tools", () => {
    const agent = {
      connection: {},
      wallet: { publicKey: Keypair.generate().publicKey },
      config: {},
    };

    const tools = createSNAPLangchainTools(agent as never);
    const toolNames = tools.map((tool: { name: string }) => tool.name);

    expect(SNAPPlugin.name).to.equal("snap");
    expect(SNAPPlugin.actions).to.have.length(4);
    expect(toolNames).to.deep.equal([
      "snap_create_pool",
      "snap_deposit",
      "snap_withdraw",
      "snap_withdraw_private",
    ]);
  });
});
