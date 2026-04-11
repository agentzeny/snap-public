import { BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SNAPClient } from "../src/snap-client";
import { SpendLimiter, type SpendPolicy } from "../src/spend-limits";

describe("Spend limits", function () {
  this.timeout(120000);

  const basePolicy: SpendPolicy = {
    maxPerTransaction: 100,
    maxPerHour: 500,
    maxPerDay: 1_000,
    requireOwnerApproval: 900,
    allowedPools: [],
  };

  it("allows an under-limit withdrawal", () => {
    const limiter = new SpendLimiter(basePolicy);
    const result = limiter.check(100);

    expect(result).to.deep.equal({ allowed: true });
  });

  it("blocks an over-limit single transaction", () => {
    const limiter = new SpendLimiter(basePolicy);
    const result = limiter.check(101);

    expect(result.allowed).to.equal(false);
    expect(result.reason).to.include("maxPerTransaction");
  });

  it("enforces the hourly rate limit", () => {
    let now = 1_000;
    const limiter = new SpendLimiter(basePolicy, () => now);

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check(100).allowed).to.equal(true);
      limiter.record(100);
    }

    const blocked = limiter.check(100);
    expect(blocked.allowed).to.equal(false);
    expect(blocked.reason).to.include("hourly limit exceeded");

    now += 60 * 60 * 1000 + 1;
    expect(limiter.check(100).allowed).to.equal(true);
  });

  it("enforces the daily rate limit", () => {
    let now = 1_000;
    const limiter = new SpendLimiter(basePolicy, () => now);

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.check(100).allowed).to.equal(true);
      limiter.record(100);
      now += 60 * 60 * 1000 + 1;
    }

    const blocked = limiter.check(100);
    expect(blocked.allowed).to.equal(false);
    expect(blocked.reason).to.include("daily limit exceeded");

    now += 24 * 60 * 60 * 1000 + 1;
    expect(limiter.check(100).allowed).to.equal(true);
  });

  it("enforces the pool allowlist", () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const limiter = new SpendLimiter({
      ...basePolicy,
      allowedPools: [pool],
    });

    expect(limiter.check(100, pool).allowed).to.equal(true);
    const blocked = limiter.check(100, Keypair.generate().publicKey.toBase58());
    expect(blocked.allowed).to.equal(false);
    expect(blocked.reason).to.include("allowlist");
  });

  it("serializes and restores limiter state", () => {
    let now = 1_000;
    const serializationPolicy: SpendPolicy = {
      ...basePolicy,
      maxPerTransaction: 500,
      requireOwnerApproval: 0,
    };
    const limiter = new SpendLimiter(serializationPolicy, () => now);
    limiter.record(100);
    limiter.record(100);

    const restored = SpendLimiter.deserialize(
      limiter.serialize(),
      serializationPolicy,
      () => now,
    );
    const blocked = restored.check(400);

    expect(blocked.allowed).to.equal(false);
    expect(blocked.reason).to.include("hourly limit exceeded");
    expect(restored.check(300).allowed).to.equal(true);
  });

  it("blocks client withdrawals when a spend policy is exceeded", async () => {
    const { client, pool, note } = await createSpendLimitedClient({
      maxPerTransaction: 50_000_000,
      maxPerHour: 1_000_000_000,
      maxPerDay: 1_000_000_000,
      requireOwnerApproval: 0,
      allowedPools: [],
    });

    try {
      await client.withdraw(pool, note, Keypair.generate());
      throw new Error("Expected withdraw to be blocked by spend policy");
    } catch (error) {
      expect((error as Error).message).to.include("Spend limit exceeded");
    }
  });

  it("does not enforce limits when the client has no policy", async () => {
    const { client, pool, note } = await createSpendLimitedClient();
    const signature = await client.withdraw(pool, note, Keypair.generate());

    expect(signature).to.equal("mock-withdraw");
  });
});

async function createSpendLimitedClient(policy?: SpendPolicy): Promise<{
  client: SNAPClient;
  pool: PublicKey;
  note: Awaited<ReturnType<SNAPClient["deposit"]>>;
}> {
  const wallet = Keypair.generate();
  const client = new SNAPClient({ getAccountInfo: async () => null } as never, wallet, {
    spendPolicy: policy,
  });
  const pool = Keypair.generate().publicKey;
  let state = {
    authority: wallet.publicKey,
    depositAmountRaw: 100_000_000,
    nextIndex: 0,
    nullifierCount: 0,
    rootCount: 0,
    roots: [] as Uint8Array[],
    commitments: [] as Uint8Array[],
    usedNullifiers: [] as Uint8Array[],
    treeDepth: 20,
    nullifierVersion: 1,
  };

  (client as any).program = {
    methods: {
      initializeV2: () => ({
        accounts: () => ({
          preInstructions: () => ({
            signers: () => ({
              rpc: async () => "mock-create-pool",
            }),
          }),
        }),
      }),
      depositV2: (commitment: number[]) => ({
        accounts: () => ({
          preInstructions: () => ({
            rpc: async () => {
              state.commitments.push(Uint8Array.from(commitment));
              state.nextIndex += 1;
              state.rootCount += 1;
              state.roots[0] = new Uint8Array(32);
              return "mock-deposit";
            },
          }),
        }),
      }),
      withdrawZkV2: () => ({
        accounts: () => ({
          preInstructions: () => ({
            rpc: async () => "mock-withdraw",
          }),
        }),
      }),
    },
    account: {
      poolV2: {
        fetch: async () => ({
          authority: state.authority,
          depositAmount: new BN(state.depositAmountRaw),
          nextIndex: state.nextIndex,
          nullifierCount: state.nullifierCount,
          rootCount: state.rootCount,
          roots: state.roots,
          commitments: state.commitments,
          usedNullifiers: state.usedNullifiers,
          tokenMint: null,
          treeDepth: state.treeDepth,
          nullifierVersion: state.nullifierVersion,
        }),
      },
    },
  };

  const note = await client.deposit(pool);
  return { client, pool, note };
}
