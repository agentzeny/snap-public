import fs from "fs";
import os from "os";
import path from "path";
import {
  BN,
  BorshAccountsCoder,
  BorshInstructionCoder,
  type Idl,
} from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { bytesEqual, createNote, encryptNote } from "../src/commitment";
import { SNAP_IDL, SNAP_PROGRAM_ID } from "../src/constants";
import { reconstructHistory } from "../src/history";
import {
  decryptNoteWithViewingKey,
  deriveAgentKey,
  deriveViewingKey,
  extractViewingKey,
  generateMasterKey,
} from "../src/keys";
import {
  clearEncryptedNoteRegistry,
  resetNoteStore,
  registerEncryptedNote,
} from "../src/note-registry";

const ACCOUNT_CODER = new BorshAccountsCoder(SNAP_IDL as Idl);
const INSTRUCTION_CODER = new BorshInstructionCoder(SNAP_IDL as Idl);

describe("Viewing keys", () => {
  let tempDir: string;
  const originalNoteStorePath = process.env.SNAP_NOTE_STORE_PATH;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-viewing-keys-"));
    process.env.SNAP_NOTE_STORE_PATH = path.join(tempDir, "notes.db");
    resetNoteStore();
    clearEncryptedNoteRegistry();
  });

  afterEach(() => {
    resetNoteStore();
    if (originalNoteStorePath === undefined) {
      delete process.env.SNAP_NOTE_STORE_PATH;
    } else {
      process.env.SNAP_NOTE_STORE_PATH = originalNoteStorePath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives the same agent keys for the same master seed and index", () => {
    const masterA = generateMasterKey(
      "test walk nut penalty hip pave soap entry language right filter choice",
    );
    const masterB = generateMasterKey(
      "test walk nut penalty hip pave soap entry language right filter choice",
    );
    const agentA = deriveAgentKey(masterA, 4);
    const agentB = deriveAgentKey(masterB, 4);

    expect(masterA.publicId).to.equal(masterB.publicId);
    expect(Buffer.from(agentA.spendingKey).equals(Buffer.from(agentB.spendingKey))).to.equal(
      true,
    );
    expect(Buffer.from(agentA.viewingKey).equals(Buffer.from(agentB.viewingKey))).to.equal(
      true,
    );
    expect(agentA.agentId).to.equal(agentB.agentId);
  });

  it("does not expose any path from a viewing key bundle back to the spending key", () => {
    const master = generateMasterKey("snap viewing key inverse test");
    const agent = deriveAgentKey(master, 1);
    const viewingBundle = extractViewingKey(agent);

    expect((viewingBundle as { spendingKey?: Uint8Array }).spendingKey).to.equal(undefined);
    expect(bytesEqual(viewingBundle.viewingKey, agent.spendingKey)).to.equal(false);
    expect(bytesEqual(deriveViewingKey(viewingBundle.viewingKey), agent.spendingKey)).to.equal(
      false,
    );
  });

  it("round-trips note encryption with the viewing key", async () => {
    const pool = Keypair.generate().publicKey;
    const master = generateMasterKey("snap viewing key round trip");
    const agent = deriveAgentKey(master, 0);
    const note = await createNote(pool, 0);
    const encrypted = encryptNote(note, agent.viewingKey);
    const decrypted = decryptNoteWithViewingKey(extractViewingKey(agent), encrypted);

    expect(decrypted).to.not.equal(null);
    expect(decrypted?.agentId).to.equal(agent.agentId);
    expect(decrypted?.index).to.equal(agent.index);
    expect(decrypted?.poolAddress).to.equal(note.poolAddress);
    expect(decrypted?.depositIndex).to.equal(note.depositIndex);
    expect(bytesEqual(decrypted!.commitment, note.commitment)).to.equal(true);
    expect(bytesEqual(decrypted!.nullifierHash, note.nullifierHash)).to.equal(true);
  });

  it("fails to decrypt an encrypted note with the wrong viewing key", async () => {
    const pool = Keypair.generate().publicKey;
    const master = generateMasterKey("snap wrong key test");
    const agentA = deriveAgentKey(master, 0);
    const agentB = deriveAgentKey(master, 1);
    const note = await createNote(pool, 0);
    const encrypted = encryptNote(note, agentA.viewingKey);

    const decrypted = decryptNoteWithViewingKey(extractViewingKey(agentB), encrypted);
    expect(decrypted).to.equal(null);
  });

  it("reconstructs only the deposits visible to a specific viewing key", async () => {
    const fixture = await createHistoryFixture();
    const history = await reconstructHistory(
      fixture.connection,
      fixture.pool,
      extractViewingKey(fixture.agentA),
    );

    expect(history).to.have.length(3);
    expect(history.every((record) => record.type === "deposit")).to.equal(true);
    expect(history.every((record) => record.nullified === false)).to.equal(true);
    expect(history.map((record) => record.commitmentIndex)).to.deep.equal([0, 2, 4]);
    expect(history.map((record) => record.timestamp)).to.deep.equal([101, 103, 105]);
  });

  it("marks spent notes as nullified and emits a withdrawal record", async () => {
    const fixture = await createHistoryFixture({ spentCommitmentIndex: 0 });
    const history = await reconstructHistory(
      fixture.connection,
      fixture.pool,
      extractViewingKey(fixture.agentA),
    );

    const spentDeposit = history.find(
      (record) => record.type === "deposit" && record.commitmentIndex === 0,
    );
    const withdrawal = history.find(
      (record) => record.type === "withdrawal" && record.commitmentIndex === 0,
    );

    expect(spentDeposit?.nullified).to.equal(true);
    expect(withdrawal?.nullified).to.equal(true);
    expect(withdrawal?.timestamp).to.equal(106);
    expect(history.filter((record) => record.type === "deposit")).to.have.length(3);
  });
});

async function createHistoryFixture(options: {
  spentCommitmentIndex?: number;
} = {}): Promise<{
  agentA: ReturnType<typeof deriveAgentKey>;
  connection: Connection;
  notes: Awaited<ReturnType<typeof createNote>>[];
  pool: PublicKey;
}> {
  const pool = Keypair.generate().publicKey;
  const master = generateMasterKey("snap history fixture");
  const agentA = deriveAgentKey(master, 0);
  const agentB = deriveAgentKey(master, 1);
  const notes = await Promise.all([
    createNote(pool, 0),
    createNote(pool, 1),
    createNote(pool, 2),
    createNote(pool, 3),
    createNote(pool, 4),
  ]);
  const noteOwners = [agentA, agentB, agentA, agentB, agentA] as const;

  noteOwners.forEach((owner, index) => {
    registerEncryptedNote({
      commitment: notes[index].commitment,
      encryptedNote: encryptNote(notes[index], owner.viewingKey),
      poolAddress: notes[index].poolAddress,
      depositIndex: notes[index].depositIndex,
    });
  });

  const usedNullifiers =
    options.spentCommitmentIndex === undefined
      ? []
      : [notes[options.spentCommitmentIndex].nullifierHash];
  const transactions = [
    makeTransaction("deposit-0", 101, encodeDeposit(notes[0].commitment)),
    makeTransaction("deposit-1", 102, encodeDeposit(notes[1].commitment)),
    makeTransaction("deposit-2", 103, encodeDeposit(notes[2].commitment)),
    makeTransaction("deposit-3", 104, encodeDeposit(notes[3].commitment)),
    makeTransaction("deposit-4", 105, encodeDeposit(notes[4].commitment)),
  ];

  if (options.spentCommitmentIndex !== undefined) {
    transactions.push(
      makeTransaction(
        "withdraw-0",
        106,
        encodeWithdraw(notes[options.spentCommitmentIndex].nullifierHash),
      ),
    );
  }

  const connection = createMockConnection({
    encodedPool: await encodePoolAccount(
      notes.map((note) => note.commitment),
      usedNullifiers,
    ),
    transactions,
  });

  return {
    agentA,
    connection,
    notes,
    pool,
  };
}

function createMockConnection(args: {
  encodedPool: Buffer;
  transactions: Array<{
    signature: string;
    slot: number;
    data: Buffer;
  }>;
}): Connection {
  const transactionsBySignature = new Map(
    args.transactions.map((transaction) => [transaction.signature, transaction]),
  );

  return {
    getAccountInfo: async () =>
      ({
        data: args.encodedPool,
        executable: false,
        lamports: 0,
        owner: SNAP_PROGRAM_ID,
        rentEpoch: 0,
      }) as never,
    getSignaturesForAddress: async () =>
      [...args.transactions]
        .reverse()
        .map((transaction) => ({ signature: transaction.signature })) as never,
    getTransaction: async (signature: string) => {
      const transaction = transactionsBySignature.get(signature);
      if (!transaction) {
        return null;
      }

      return {
        slot: transaction.slot,
        transaction: {
          message: {
            compiledInstructions: [
              {
                programIdIndex: 0,
                data: transaction.data,
              },
            ],
            getAccountKeys: () => ({
              get: (index: number) => (index === 0 ? SNAP_PROGRAM_ID : undefined),
            }),
          },
          signatures: [signature],
        },
        meta: {
          loadedAddresses: {
            writable: [],
            readonly: [],
          },
        },
      } as never;
    },
  } as Connection;
}

async function encodePoolAccount(
  commitments: Uint8Array[],
  usedNullifiers: Uint8Array[],
): Promise<Buffer> {
  const account = {
    authority: Keypair.generate().publicKey,
    deposit_amount: new BN(100_000_000),
    next_index: commitments.length,
    nullifier_count: usedNullifiers.length,
    bump: 255,
    root_count: commitments.length,
    roots: zeroMatrix(30),
    filled_subtrees: zeroMatrix(10),
    commitments: commitments.map((value) => Array.from(value)),
    used_nullifiers: usedNullifiers.map((value) => Array.from(value)),
  };
  const coder = ACCOUNT_CODER as unknown as {
    accountLayouts: Map<
      string,
      {
        layout: {
          encode: (value: Record<string, unknown>, buffer: Buffer) => number;
        };
      }
    >;
    accountDiscriminator: (name: string) => Buffer;
  };
  const layout = coder.accountLayouts.get(POOL_ACCOUNT_NAME);
  if (!layout) {
    throw new Error("Pool account layout not found");
  }

  const buffer = Buffer.alloc(4_096);
  const encodedLength = layout.layout.encode(account, buffer);

  return Buffer.concat([
    coder.accountDiscriminator(POOL_ACCOUNT_NAME),
    buffer.slice(0, encodedLength),
  ]);
}

function encodeDeposit(commitment: Uint8Array): Buffer {
  return INSTRUCTION_CODER.encode("deposit", {
    commitment: Array.from(commitment),
  });
}

function encodeWithdraw(nullifierHash: Uint8Array): Buffer {
  return INSTRUCTION_CODER.encode("withdraw_zk", {
    proof_a: new Array(64).fill(0),
    proof_b: new Array(128).fill(0),
    proof_c: new Array(64).fill(0),
    root: new Array(32).fill(0),
    nullifier_hash: Array.from(nullifierHash),
  });
}

function makeTransaction(signature: string, slot: number, data: Buffer) {
  return { signature, slot, data };
}

function zeroMatrix(length: number): number[][] {
  return Array.from({ length }, () => new Array(32).fill(0));
}

const POOL_ACCOUNT_NAME = "Pool";
