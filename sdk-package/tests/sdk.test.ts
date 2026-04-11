import { BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { bigintToBytes32 } from "../src/commitment";
import { PoseidonMerkleTree } from "../src/merkle";
import { DEFAULT_TREE_DEPTH } from "../src/constants";
import { SNAPClient } from "../src/snap-client";

interface MockPoolState {
  kind: "legacy" | "v2" | "feeV2";
  authority: PublicKey;
  depositAmountRaw: number;
  nextIndex: number;
  nullifierCount: number;
  rootCount: number;
  roots: Uint8Array[];
  commitments: Uint8Array[];
  usedNullifiers: Uint8Array[];
  tokenMint: PublicKey | null;
  treeDepth: number;
  nullifierVersion: number;
  protocolFeeBps: number;
  treasury: PublicKey | null;
}

describe("SNAPClient", function () {
  this.timeout(120000);
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a v2 SOL pool", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const info = await client.getPoolInfo(pool);

    expect(info.address.toBase58()).to.equal(pool.toBase58());
    expect(info.depositAmount).to.equal(0.1);
    expect(info.depositAmountRaw).to.equal(0.1 * LAMPORTS_PER_SOL);
    expect(info.assetType).to.equal("sol");
    expect(info.treeDepth).to.equal(DEFAULT_TREE_DEPTH);
    expect(info.nullifierVersion).to.equal(1);
    expect(info.legacy).to.equal(false);
    expect(info.feeCapable).to.equal(false);
    expect(info.protocolFeeBps).to.equal(0);
    expect(info.treasury).to.equal(null);
    expect(info.currentRoot.length).to.equal(32);
  });

  it("creates a fee-capable SOL pool and reports its treasury config", async () => {
    const treasury = Keypair.generate().publicKey;
    const { client } = createMockClient();
    const pool = await client.createPool(0.1, {
      protocolFeeBps: 250,
      treasury,
    });
    const info = await client.getPoolInfo(pool);

    expect(info.feeCapable).to.equal(true);
    expect(info.protocolFeeBps).to.equal(250);
    expect(info.treasury?.toBase58()).to.equal(treasury.toBase58());
  });

  it("creates an SPL pool and reports mint metadata", async () => {
    const tokenMint = Keypair.generate().publicKey;
    const { client } = createMockClient({ tokenMint });
    (client as any).fetchTokenDecimals = async () => 6;

    const pool = await client.createPool(1, { tokenMint });
    const info = await client.getPoolInfo(pool);

    expect(info.assetType).to.equal("spl");
    expect(info.depositAmount).to.equal(1);
    expect(info.depositAmountRaw).to.equal(1_000_000);
    expect(info.tokenMint?.toBase58()).to.equal(tokenMint.toBase58());
    expect(info.tokenDecimals).to.equal(6);
    expect(info.treeDepth).to.equal(DEFAULT_TREE_DEPTH);
  });

  it("accepts a PublicKey-like token mint when creating an SPL pool", async () => {
    const tokenMint = Keypair.generate().publicKey;
    const tokenMintLike = {
      toBase58: () => tokenMint.toBase58(),
    } as unknown as PublicKey;
    const { client } = createMockClient({ tokenMint });
    (client as any).fetchTokenDecimals = async () => 6;

    const pool = await client.createPool(1, { tokenMint: tokenMintLike });
    const info = await client.getPoolInfo(pool);

    expect(info.assetType).to.equal("spl");
    expect(info.tokenMint?.toBase58()).to.equal(tokenMint.toBase58());
    expect(info.depositAmountRaw).to.equal(1_000_000);
  });

  it("deposits and returns a serializable note", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool, 0.1);
    const serialized = SNAPClient.serializeNote(note);
    const restored = SNAPClient.deserializeNote(serialized);
    const info = await client.getPoolInfo(pool);

    expect(restored.poolAddress).to.equal(pool.toBase58());
    expect(restored.depositIndex).to.equal(0);
    expect(Buffer.from(restored.commitment).equals(Buffer.from(note.commitment))).to.equal(true);
    expect(info.depositCount).to.equal(1);
  });

  it("withdraws using a note with ZK proof through the v2 path", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const recipient = Keypair.generate();

    const txSig = await client.withdraw(pool, note, recipient);

    expect(txSig).to.equal("mock-withdraw");
  });

  it("returns fee breakdowns for fee-capable direct withdrawals", async () => {
    const treasury = Keypair.generate().publicKey;
    const { client } = createMockClient();
    const pool = await client.createPool(0.1, {
      protocolFeeBps: 250,
      treasury,
    });
    const note = await client.deposit(pool);
    const recipient = Keypair.generate();

    const result = await client.withdrawWithResult(pool, note, recipient);

    expect(result.txSignature).to.equal("mock-withdraw");
    expect(result.depositAmountRaw).to.equal(100_000_000);
    expect(result.protocolFeeBps).to.equal(250);
    expect(result.protocolFeeRaw).to.equal(2_500_000);
    expect(result.relayerFeeRaw).to.equal(0);
    expect(result.totalFeeRaw).to.equal(2_500_000);
    expect(result.recipientAmountRaw).to.equal(97_500_000);
  });

  it("estimates direct withdrawals with protocol fee context", async () => {
    const treasury = Keypair.generate().publicKey;
    const { client } = createMockClient();
    const pool = await client.createPool(0.1, {
      protocolFeeBps: 250,
      treasury,
    });

    const estimate = await client.estimateWithdrawal(pool);

    expect(estimate.depositAmountRaw).to.equal(100_000_000);
    expect(estimate.protocolFeeBps).to.equal(250);
    expect(estimate.protocolFeeRaw).to.equal(2_500_000);
    expect(estimate.relayerFeeRaw).to.equal(0);
    expect(estimate.recipientAmountRaw).to.equal(97_500_000);
  });

  it("updates the treasury for fee-capable pools", async () => {
    const treasury = Keypair.generate().publicKey;
    const newTreasury = Keypair.generate().publicKey;
    const { client } = createMockClient();
    const pool = await client.createPool(0.1, {
      protocolFeeBps: 250,
      treasury,
    });

    const txSignature = await client.updateTreasury(pool, newTreasury);
    const info = await client.getPoolInfo(pool);

    expect(txSignature).to.equal("mock-update-treasury");
    expect(info.treasury?.toBase58()).to.equal(newTreasury.toBase58());
  });

  it("accepts a PublicKey-like recipient when withdrawing", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const recipient = Keypair.generate().publicKey;
    const recipientLike = {
      toBase58: () => recipient.toBase58(),
    } as unknown as PublicKey;

    const txSig = await client.withdraw(pool, note, recipientLike);

    expect(txSig).to.equal("mock-withdraw");
  });

  it("withdraws via a relayer without signing on-chain as the recipient", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const recipient = Keypair.generate();
    let sawInfo = false;
    let sawRelay = false;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);

      if (url === "http://localhost:3000/info") {
        sawInfo = true;
        return new Response(
          JSON.stringify({
            pool: pool.toBase58(),
            poolDenomination: 0.1,
            poolDenominationRaw: 100_000_000,
            protocolFeeBps: 0,
            relayerFeeBps: 50,
            totalFeeBps: 50,
            estimatedRecipientLamports: 99_500_000,
            treasury: null,
            fee: {
              feeBps: 50,
              minFeeLamports: 10_000,
            },
            network: "devnet",
            programId: Keypair.generate().publicKey.toBase58(),
            relayer: Keypair.generate().publicKey.toBase58(),
            relayerBalanceLamports: 5 * LAMPORTS_PER_SOL,
            maxRequestAgeMs: 60_000,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      expect(url).to.equal("http://localhost:3000/relay");
      expect(init?.method).to.equal("POST");
      sawRelay = true;

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        payload: Record<string, string | number>;
        signature: string;
        sessionPubkey: string;
        timestamp: number;
      };
      expect(body.payload.pool).to.equal(pool.toBase58());
      expect(body.payload.recipient).to.equal(recipient.publicKey.toBase58());
      expect(body.payload.proof).to.have.length(512);
      expect(body.payload.root).to.have.length(64);
      expect(body.payload.nullifierHash).to.have.length(64);
      expect(body.payload.fee).to.equal(500_000);
      expect(body.signature.length).to.be.greaterThan(40);
      expect(body.sessionPubkey.length).to.be.greaterThan(20);
      expect(body.timestamp).to.be.a("number");

      return new Response(
        JSON.stringify({
          success: true,
          txSignature: "mock-relayed-withdraw",
          fee: 0.0005,
          recipientReceived: 0.0995,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const result = await client.withdrawViaRelayer(pool, note, recipient.publicKey);

    expect(sawInfo).to.equal(true);
    expect(sawRelay).to.equal(true);
    expect(result.txSignature).to.equal("mock-relayed-withdraw");
    expect(result.fee).to.equal(0.0005);
    expect(result.recipientReceived).to.equal(0.0995);
    expect(result.protocolFeeRaw).to.equal(0);
    expect(result.relayerFeeRaw).to.equal(500_000);
    expect(result.totalFeeRaw).to.equal(500_000);
  });

  it("estimates relayed withdrawals using protocol and relayer fees", async () => {
    const treasury = Keypair.generate().publicKey;
    const { client } = createMockClient();
    const pool = await client.createPool(0.1, {
      protocolFeeBps: 250,
      treasury,
    });

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url !== "http://localhost:3000/info") {
        throw new Error(`Unexpected URL ${url}`);
      }

      return new Response(
        JSON.stringify({
          pool: pool.toBase58(),
          poolDenomination: 0.1,
          poolDenominationRaw: 100_000_000,
          protocolFeeBps: 250,
          relayerFeeBps: 50,
          totalFeeBps: 300,
          estimatedRecipientLamports: 97_000_000,
          treasury: treasury.toBase58(),
          fee: {
            feeBps: 50,
            minFeeLamports: 10_000,
          },
          network: "devnet",
          programId: Keypair.generate().publicKey.toBase58(),
          relayer: Keypair.generate().publicKey.toBase58(),
          relayerBalanceLamports: 5 * LAMPORTS_PER_SOL,
          maxRequestAgeMs: 60_000,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const estimate = await client.estimateRelayedWithdrawal(pool);

    expect(estimate.protocolFeeRaw).to.equal(2_500_000);
    expect(estimate.relayerFeeRaw).to.equal(500_000);
    expect(estimate.totalFeeRaw).to.equal(3_000_000);
    expect(estimate.recipientAmountRaw).to.equal(97_000_000);
    expect(estimate.depositAmountRaw).to.equal(100_000_000);
    expect(estimate.protocolFeeBps).to.equal(250);
  });

  it("applies timing obfuscation with cryptographic randomness before submitting", async () => {
    const delays: number[] = [];
    const { client } = createMockClient({
      clientOptions: {
        maxDepositDelayMs: 10,
        maxWithdrawDelayMs: 10,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      },
    });
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const recipient = Keypair.generate();

    await client.withdraw(pool, note, recipient.publicKey);

    expect(delays).to.have.length(2);
    expect(delays[0]).to.be.at.least(0);
    expect(delays[0]).to.be.at.most(10);
    expect(delays[1]).to.be.at.least(0);
    expect(delays[1]).to.be.at.most(10);
  });

  it("serializes and deserializes notes correctly", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const roundTrip = SNAPClient.deserializeNote(SNAPClient.serializeNote(note));

    expect(roundTrip.secret).to.equal(note.secret);
    expect(roundTrip.nullifier).to.equal(note.nullifier);
    expect(Buffer.from(roundTrip.nullifierHash).equals(Buffer.from(note.nullifierHash))).to.equal(
      true,
    );
  });

  it("rejects withdrawal with an already-used note", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const recipient = Keypair.generate();

    await client.withdraw(pool, note, recipient);

    try {
      await client.withdraw(pool, note, recipient);
      throw new Error("Expected second withdrawal to fail");
    } catch (error) {
      expect((error as Error).message).to.include(
        "SNAP: Nullifier already used — this note has already been withdrawn",
      );
    }
  });

  it("provides meaningful error on invalid note", async () => {
    const { client } = createMockClient();
    const pool = await client.createPool(0.1);
    const note = await client.deposit(pool);
    const recipient = Keypair.generate();

    const tampered = SNAPClient.deserializeNote(SNAPClient.serializeNote(note));
    tampered.commitment = Uint8Array.from(tampered.commitment);
    tampered.commitment[0] ^= 0xff;

    try {
      await client.withdraw(pool, tampered, recipient);
      throw new Error("Expected invalid note to fail");
    } catch (error) {
      expect((error as Error).message).to.include("SNAP: Invalid note");
    }
  });
});

function createMockClient(options: {
  clientOptions?: Record<string, unknown>;
  tokenMint?: PublicKey;
} = {}) {
  const wallet = Keypair.generate();
  const nullifierRecords = new Set<string>();
  let state: MockPoolState | null = null;

  const connection = {
    getAccountInfo: async (address: PublicKey) => {
      if (options.tokenMint) {
        const ata = getAssociatedTokenAddressSync(options.tokenMint, wallet.publicKey);
        if (address.equals(ata)) {
          return {
            data: Buffer.alloc(0),
            executable: false,
            lamports: 1,
            owner: wallet.publicKey,
            rentEpoch: 0,
          } as never;
        }
      }

      if (nullifierRecords.has(address.toBase58())) {
        return {
          data: Buffer.alloc(8),
          executable: false,
          lamports: 1,
          owner: wallet.publicKey,
          rentEpoch: 0,
        } as never;
      }

      return null;
    },
  } as never;

  const client = new SNAPClient(connection, wallet, options.clientOptions as never);

  (client as any).program = {
    methods: {
      initializeV2: (depositAmount: BN, treeDepth: number) => ({
        accounts: (accounts: { authority: PublicKey }) => ({
          preInstructions: () => ({
            signers: () => ({
              rpc: async () => {
                state = {
                  kind: "v2",
                  authority: accounts.authority,
                  depositAmountRaw: depositAmount.toNumber(),
                  nextIndex: 0,
                  nullifierCount: 0,
                  rootCount: 0,
                  roots: [],
                  commitments: [],
                  usedNullifiers: [],
                  tokenMint: null,
                  treeDepth,
                  nullifierVersion: 1,
                  protocolFeeBps: 0,
                  treasury: null,
                };
                return "mock-create-pool";
              },
            }),
          }),
        }),
      }),
      initializeFeeV2: (depositAmount: BN, treeDepth: number, protocolFeeBps: number) => ({
        accounts: (accounts: { authority: PublicKey; treasury: PublicKey }) => ({
          preInstructions: () => ({
            signers: () => ({
              rpc: async () => {
                state = {
                  kind: "feeV2",
                  authority: accounts.authority,
                  depositAmountRaw: depositAmount.toNumber(),
                  nextIndex: 0,
                  nullifierCount: 0,
                  rootCount: 0,
                  roots: [],
                  commitments: [],
                  usedNullifiers: [],
                  tokenMint: null,
                  treeDepth,
                  nullifierVersion: 1,
                  protocolFeeBps,
                  treasury: accounts.treasury,
                };
                return "mock-create-fee-pool";
              },
            }),
          }),
        }),
      }),
      initializeSpl: (depositAmount: BN, tokenMint: PublicKey) => ({
        accounts: (accounts: { authority: PublicKey }) => ({
          preInstructions: () => ({
            signers: () => ({
              rpc: async () => {
                state = {
                  kind: "v2",
                  authority: accounts.authority,
                  depositAmountRaw: depositAmount.toNumber(),
                  nextIndex: 0,
                  nullifierCount: 0,
                  rootCount: 0,
                  roots: [],
                  commitments: [],
                  usedNullifiers: [],
                  tokenMint,
                  treeDepth: 20,
                  nullifierVersion: 1,
                  protocolFeeBps: 0,
                  treasury: null,
                };
                return "mock-create-spl-pool";
              },
            }),
          }),
        }),
      }),
      initializeFeeSpl: (
        depositAmount: BN,
        tokenMint: PublicKey,
        protocolFeeBps: number,
      ) => ({
        accounts: (accounts: { authority: PublicKey; treasuryTokenAccount: PublicKey }) => ({
          preInstructions: () => ({
            signers: () => ({
              rpc: async () => {
                state = {
                  kind: "feeV2",
                  authority: accounts.authority,
                  depositAmountRaw: depositAmount.toNumber(),
                  nextIndex: 0,
                  nullifierCount: 0,
                  rootCount: 0,
                  roots: [],
                  commitments: [],
                  usedNullifiers: [],
                  tokenMint,
                  treeDepth: 20,
                  nullifierVersion: 1,
                  protocolFeeBps,
                  treasury: accounts.treasuryTokenAccount,
                };
                return "mock-create-fee-spl-pool";
              },
            }),
          }),
        }),
      }),
      updateTreasury: (newTreasury: PublicKey) => ({
        accounts: () => ({
          rpc: async () => {
            assertPoolState(state);
            expect(state.kind).to.equal("feeV2");
            state.treasury = newTreasury;
            return "mock-update-treasury";
          },
        }),
      }),
      depositV2: (commitment: number[]) => ({
        accounts: () => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              state.commitments.push(Uint8Array.from(commitment));
              state.nextIndex += 1;
              state.roots[state.rootCount % 30] = await computeRoot(
                state.commitments,
                state.treeDepth,
              );
              state.rootCount += 1;
              return "mock-deposit";
            },
          }),
        }),
      }),
      depositSpl: (commitment: number[]) => ({
        accounts: () => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              state.commitments.push(Uint8Array.from(commitment));
              state.nextIndex += 1;
              state.roots[state.rootCount % 30] = await computeRoot(
                state.commitments,
                state.treeDepth,
              );
              state.rootCount += 1;
              return "mock-spl-deposit";
            },
          }),
        }),
      }),
      depositFeeV2: (commitment: number[]) => ({
        accounts: () => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              state.commitments.push(Uint8Array.from(commitment));
              state.nextIndex += 1;
              state.roots[state.rootCount % 30] = await computeRoot(
                state.commitments,
                state.treeDepth,
              );
              state.rootCount += 1;
              return "mock-fee-deposit";
            },
          }),
        }),
      }),
      depositFeeSpl: (commitment: number[]) => ({
        accounts: () => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              state.commitments.push(Uint8Array.from(commitment));
              state.nextIndex += 1;
              state.roots[state.rootCount % 30] = await computeRoot(
                state.commitments,
                state.treeDepth,
              );
              state.rootCount += 1;
              return "mock-fee-spl-deposit";
            },
          }),
        }),
      }),
      withdrawZkV2: (
        proofA: number[],
        proofB: number[],
        proofC: number[],
        root: number[],
        nullifierHash: number[],
      ) => ({
        accounts: (accounts: { pool: PublicKey }) => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              expect(proofA).to.have.length(64);
              expect(proofB).to.have.length(128);
              expect(proofC).to.have.length(64);
              expect(root).to.have.length(32);
              expect(nullifierHash).to.have.length(32);

              const [nullifierRecord] = PublicKey.findProgramAddressSync(
                [
                  Buffer.from("nullifier"),
                  accounts.pool.toBuffer(),
                  Buffer.from(nullifierHash),
                ],
                (client as any).programId,
              );
              nullifierRecords.add(nullifierRecord.toBase58());
              state.nullifierCount += 1;
              return "mock-withdraw";
            },
          }),
        }),
      }),
      withdrawZkFeeV2: (
        proofA: number[],
        proofB: number[],
        proofC: number[],
        root: number[],
        nullifierHash: number[],
      ) => ({
        accounts: (accounts: { pool: PublicKey }) => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              expect(proofA).to.have.length(64);
              expect(proofB).to.have.length(128);
              expect(proofC).to.have.length(64);
              expect(root).to.have.length(32);
              expect(nullifierHash).to.have.length(32);

              const [nullifierRecord] = PublicKey.findProgramAddressSync(
                [
                  Buffer.from("nullifier"),
                  accounts.pool.toBuffer(),
                  Buffer.from(nullifierHash),
                ],
                (client as any).programId,
              );
              nullifierRecords.add(nullifierRecord.toBase58());
              state.nullifierCount += 1;
              return "mock-withdraw";
            },
          }),
        }),
      }),
      withdrawZkFeeSpl: (
        proofA: number[],
        proofB: number[],
        proofC: number[],
        root: number[],
        nullifierHash: number[],
      ) => ({
        accounts: (accounts: { pool: PublicKey }) => ({
          preInstructions: () => ({
            rpc: async () => {
              assertPoolState(state);
              expect(proofA).to.have.length(64);
              expect(proofB).to.have.length(128);
              expect(proofC).to.have.length(64);
              expect(root).to.have.length(32);
              expect(nullifierHash).to.have.length(32);

              const [nullifierRecord] = PublicKey.findProgramAddressSync(
                [
                  Buffer.from("nullifier"),
                  accounts.pool.toBuffer(),
                  Buffer.from(nullifierHash),
                ],
                (client as any).programId,
              );
              nullifierRecords.add(nullifierRecord.toBase58());
              state.nullifierCount += 1;
              return "mock-withdraw";
            },
          }),
        }),
      }),
    },
    account: {
      poolFeeV2: {
        fetch: async () => {
          assertPoolState(state);
          if (state.kind !== "feeV2") {
            throw new Error("Mock client does not expose a fee-capable pool");
          }
          return {
            authority: state.authority,
            treasury: state.treasury,
            depositAmount: new BN(state.depositAmountRaw),
            protocolFeeBps: state.protocolFeeBps,
            nextIndex: state.nextIndex,
            nullifierCount: state.nullifierCount,
            rootCount: state.rootCount,
            roots: state.roots,
            commitments: state.commitments,
            usedNullifiers: state.usedNullifiers,
            tokenMint: state.tokenMint,
            treeDepth: state.treeDepth,
            nullifierVersion: state.nullifierVersion,
          };
        },
      },
      poolV2: {
        fetch: async () => {
          assertPoolState(state);
          if (state.kind !== "v2") {
            throw new Error("Mock client does not expose a non-fee v2 pool");
          }
          return {
            authority: state.authority,
            depositAmount: new BN(state.depositAmountRaw),
            nextIndex: state.nextIndex,
            nullifierCount: state.nullifierCount,
            rootCount: state.rootCount,
            roots: state.roots,
            commitments: state.commitments,
            usedNullifiers: state.usedNullifiers,
            tokenMint: state.tokenMint,
            treeDepth: state.treeDepth,
            nullifierVersion: state.nullifierVersion,
          };
        },
      },
      pool: {
        fetch: async () => {
          throw new Error("Mock client does not expose a legacy pool");
        },
      },
    },
  };

  return { client, wallet, getState: () => state };
}

function assertPoolState(state: MockPoolState | null): asserts state is MockPoolState {
  if (!state) {
    throw new Error("Pool has not been initialized");
  }
}

async function computeRoot(
  commitments: Uint8Array[],
  treeDepth: number,
): Promise<Uint8Array> {
  const tree = new PoseidonMerkleTree(treeDepth);
  await tree.init();

  for (const commitment of commitments) {
    tree.insert(bytesToBigInt(commitment));
  }

  return bigintToBytes32(tree.getRoot());
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  const hex = Buffer.from(bytes).toString("hex");
  return BigInt(`0x${hex || "0"}`);
}
