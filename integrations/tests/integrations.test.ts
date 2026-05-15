import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleHermesSnap } from "../hermes/snap-handler";
import { createSNAPToolsFromClient } from "../langchain/snap-tool";
import { handleCommand } from "../openclaw/snap-skill";
import {
  createSnapEstimateFeeAction,
  createSnapDepositAction,
  createSnapBalanceAction,
  createSnapListPoolsAction,
  createSnapPlugin,
  createSnapWithdrawAction,
} from "../elizaos/snap-plugin";
import { SNAPActionProvider } from "../agentkit/snap-actions";
import { createSnapMcpServer } from "../mcp/snap-mcp-server";
import type { SnapClientLike } from "../shared/snap-client";

class StubSnapClient implements SnapClientLike {
  lastDeposit: { amount?: number; pool: string } | null = null;
  lastWithdraw: {
    note: unknown;
    pool: string;
    recipient: string;
    relayerUrl?: string;
  } | null = null;

  async deposit(
    pool: PublicKey,
    amount?: number
  ): Promise<{ depositIndex: number }> {
    this.lastDeposit = { pool: pool.toBase58(), amount };
    return { depositIndex: 7 };
  }

  async withdraw(
    pool: PublicKey,
    note: unknown,
    recipient: PublicKey
  ): Promise<string> {
    this.lastWithdraw = {
      pool: pool.toBase58(),
      note,
      recipient: recipient.toBase58(),
    };
    return "withdraw-signature";
  }

  async withdrawViaRelayer(
    pool: PublicKey,
    note: unknown,
    recipient: PublicKey,
    relayerUrl?: string
  ): Promise<{ txSignature: string; fee: number; recipientReceived?: number }> {
    this.lastWithdraw = {
      pool: pool.toBase58(),
      note,
      recipient: recipient.toBase58(),
      relayerUrl,
    };
    return {
      txSignature: "relayed-signature",
      fee: 0.0005,
      recipientReceived: 0.0995,
    };
  }

  async estimateWithdrawal() {
    return {
      depositAmount: 0.1,
      protocolFee: 0.00025,
      relayerFee: 0,
      recipientAmount: 0.09975,
      totalFee: 0.00025,
      protocolFeeBps: 25,
    };
  }

  async estimateRelayedWithdrawal() {
    return {
      depositAmount: 0.1,
      protocolFee: 0.00025,
      relayerFee: 0.0005,
      recipientAmount: 0.09925,
      totalFee: 0.00075,
      protocolFeeBps: 25,
    };
  }

  async getPoolInfo() {
    return {
      depositAmount: 0.1,
      assetType: "sol" as const,
      tokenMint: null,
    };
  }

  async getAgentHistory() {
    return [
      {
        type: "deposit" as const,
        amount: 0.1,
        nullified: false,
      },
    ];
  }
}

describe("Framework integrations", () => {
  it("parses an OpenClaw deposit command and calls snap.deposit()", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();

    const message = await handleCommand("deposit 0.1 SOL into SNAP pool", {
      poolAddress: pool,
      snapClient,
    });

    expect(snapClient.lastDeposit).to.deep.equal({
      pool,
      amount: 0.1,
    });
    expect(message).to.include("Deposited 0.1 SOL into SNAP");
  });

  it("returns a human-readable OpenClaw error when a required note is missing", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();

    try {
      await handleCommand(
        `withdraw to ${Keypair.generate().publicKey.toBase58()}`,
        {
          poolAddress: pool,
          snapClient,
        }
      );
      throw new Error("Expected missing note error");
    } catch (error) {
      expect((error as Error).message).to.include("requires a note");
    }
  });

  it("lists OpenClaw pools and estimates fees", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();

    const pools = await handleCommand("list SNAP pools", {
      poolAddress: pool,
      snapClient,
    });
    const estimate = await handleCommand("estimate SNAP withdrawal fee", {
      poolAddress: pool,
      snapClient,
      relayerUrl: "http://localhost:3000",
    });

    expect(pools).to.include(pool);
    expect(estimate).to.include("Total fee: 0.00075 SOL");
  });

  it("routes ElizaOS balance action parameters into the SDK", async () => {
    const snapClient = new StubSnapClient();
    const action = createSnapBalanceAction({
      poolAddress: Keypair.generate().publicKey.toBase58(),
      snapClient,
      viewingKeyProvider: () => ({ key: "viewing-key" }),
    });
    const plugin = createSnapPlugin({
      poolAddress: Keypair.generate().publicKey.toBase58(),
      snapClient,
      viewingKeyProvider: () => ({ key: "viewing-key" }),
    });

    const result = await action.handler(
      {} as never,
      {} as never,
      undefined,
      {},
      undefined
    );

    expect(plugin.actions).to.have.length(5);
    expect(result?.success).to.equal(true);
    expect(result?.text).to.equal("Private SNAP balance: 0.1.");
  });

  it("routes ElizaOS list and estimate actions", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();
    const listAction = createSnapListPoolsAction({
      poolAddress: pool,
      snapClient,
    });
    const estimateAction = createSnapEstimateFeeAction({
      poolAddress: pool,
      snapClient,
      relayerUrl: "http://localhost:3000",
    });

    const listResult = await listAction.handler(
      {} as never,
      {} as never,
      undefined,
      {},
      undefined
    );
    const estimateResult = await estimateAction.handler(
      {} as never,
      {} as never,
      undefined,
      {},
      undefined
    );

    expect(listResult?.text).to.include(pool);
    expect(estimateResult?.text).to.include("Recipient receives: 0.09925 SOL");
  });

  it("returns clear ElizaOS errors for invalid deposit amount and withdraw context", async () => {
    const snapClient = new StubSnapClient();
    const depositAction = createSnapDepositAction({
      poolAddress: Keypair.generate().publicKey.toBase58(),
      snapClient,
    });
    const withdrawAction = createSnapWithdrawAction({
      poolAddress: Keypair.generate().publicKey.toBase58(),
      snapClient,
    });

    try {
      await depositAction.handler(
        {} as never,
        {} as never,
        undefined,
        { parameters: { amount: 0 } },
        undefined
      );
      throw new Error("Expected invalid deposit amount");
    } catch (error) {
      expect((error as Error).message).to.equal(
        "SNAP_DEPOSIT requires a positive numeric amount"
      );
    }

    try {
      await withdrawAction.handler(
        {} as never,
        {} as never,
        undefined,
        {},
        undefined
      );
      throw new Error("Expected missing withdraw context");
    } catch (error) {
      expect((error as Error).message).to.include(
        "requires both a note and recipientAddress"
      );
    }
  });

  it("exposes AgentKit actions that validate and call the SDK", async () => {
    const snapClient = new StubSnapClient();
    const provider = new SNAPActionProvider(snapClient);
    const pool = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const actions = provider.getActions();
    const withdrawPrivate = actions.find(
      (action) => action.name === "snap_withdraw_private"
    );

    expect(actions.map((action) => action.name)).to.include("snap_deposit");
    expect(actions.map((action) => action.name)).to.include("snap_list_pools");
    expect(actions.map((action) => action.name)).to.include(
      "snap_estimate_fee"
    );
    expect(() =>
      withdrawPrivate?.schema.parse({
        pool,
        recipient,
        note: "note",
        relayerUrl: "http://localhost:3000",
      })
    ).to.not.throw();

    const result = await withdrawPrivate!.invoke({
      pool,
      recipient,
      note: "serialized-note",
      relayerUrl: "http://localhost:3000",
    });

    expect(snapClient.lastWithdraw).to.deep.equal({
      pool,
      recipient,
      note: "serialized-note",
      relayerUrl: "http://localhost:3000",
    });
    expect(result).to.include("relayed-signature");
  });

  it("estimates AgentKit fees with provider defaults", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();
    const provider = new SNAPActionProvider(snapClient, {
      poolAddress: pool,
      relayerUrl: "http://localhost:3000",
    });
    const estimate = provider
      .getActions()
      .find((action) => action.name === "snap_estimate_fee");

    const result = await estimate!.invoke({});

    expect(result).to.include("Total fee: 0.00075 SOL");
  });

  it("returns a clear AgentKit relayer error when no relayer URL is configured", async () => {
    const snapClient = new StubSnapClient();
    const provider = new SNAPActionProvider(snapClient);
    const withdrawPrivate = provider
      .getActions()
      .find((action) => action.name === "snap_withdraw_private");

    try {
      await withdrawPrivate!.invoke({
        pool: Keypair.generate().publicKey.toBase58(),
        recipient: Keypair.generate().publicKey.toBase58(),
        note: "serialized-note",
      });
      throw new Error("Expected missing relayer URL error");
    } catch (error) {
      expect((error as Error).message).to.equal(
        "snap_withdraw_private requires relayerUrl or a provider default"
      );
    }
  });

  it("serves MCP tools and returns tool results over an in-memory transport", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();
    const server = createSnapMcpServer({
      poolAddress: pool,
      snapClient,
      viewingKeyProvider: () => ({ key: "viewing-key" }),
    });
    const client = new Client({
      name: "snap-test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    const response = await client.callTool({
      name: "snap_list_pools",
      arguments: {},
    });
    const estimate = await client.callTool({
      name: "snap_estimate_fee",
      arguments: {
        relayerUrl: "http://localhost:3000",
      },
    });

    expect(tools.tools.map((tool) => tool.name)).to.include("snap_list_pools");
    expect(tools.tools.map((tool) => tool.name)).to.include("snap_deposit");
    expect(tools.tools.map((tool) => tool.name)).to.include("snap_withdraw");
    expect(tools.tools.map((tool) => tool.name)).to.include(
      "snap_estimate_fee"
    );
    const responseContent = response.content as Array<{ text: string }>;
    const estimateContent = estimate.content as Array<{ text: string }>;
    expect(responseContent[0]).to.have.property("type", "text");
    expect(responseContent[0].text).to.include(pool);
    expect(estimateContent[0].text).to.include('"totalFee": 0.00075');

    await client.close();
    await server.close();
  });

  it("exposes LangChain tools that validate and call the SDK", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const tools = createSNAPToolsFromClient(snapClient, {
      poolAddress: pool,
      relayerUrl: "http://localhost:3000",
    });

    const names = tools.map((tool) => tool.name);
    const deposit = await tools
      .find((tool) => tool.name === "snap_deposit")!
      .invoke({ amount: 0.1 });
    const withdraw = await tools
      .find((tool) => tool.name === "snap_withdraw")!
      .invoke({ note: { demo: true }, recipient });
    const estimate = await tools
      .find((tool) => tool.name === "snap_estimate_fee")!
      .invoke({});

    expect(names).to.deep.equal([
      "snap_list_pools",
      "snap_deposit",
      "snap_withdraw",
      "snap_estimate_fee",
    ]);
    expect(deposit).to.include('"depositIndex": 7');
    expect(withdraw).to.include('"transaction": "relayed-signature"');
    expect(estimate).to.include('"totalFee": 0.00075');
  });

  it("handles Hermes SNAP commands through the shared SDK interface", async () => {
    const snapClient = new StubSnapClient();
    const pool = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();

    const pools = await handleHermesSnap(
      { action: "list_pools" },
      { poolAddress: pool, snapClient }
    );
    const deposit = await handleHermesSnap(
      { action: "deposit", amount: 0.1 },
      { poolAddress: pool, snapClient }
    );
    const withdraw = await handleHermesSnap(
      {
        action: "withdraw",
        note: { demo: true },
        recipientAddress: recipient,
      },
      { poolAddress: pool, relayerUrl: "http://localhost:3000", snapClient }
    );
    const estimate = await handleHermesSnap(
      { action: "estimate_fee" },
      { poolAddress: pool, relayerUrl: "http://localhost:3000", snapClient }
    );

    expect(JSON.stringify(pools)).to.include(pool);
    expect(deposit.depositIndex).to.equal(7);
    expect(withdraw.transaction).to.equal("relayed-signature");
    expect(estimate.totalFee).to.equal(0.00075);
  });
});
