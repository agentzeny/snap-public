import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import os from "os";
import path from "path";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { deriveAgentKey, extractViewingKey, generateMasterKey } from "../sdk-package/src/keys";
import { reconstructHistory } from "../sdk-package/src/history";
import {
  getDefaultNoteStore,
  resetDefaultNoteStore,
} from "../sdk-package/src/note-store";
import { SNAPClient } from "../sdk-package/src/snap-client";
import { fundSystemAccount } from "./helpers";

describe("Viewing key persistence", function () {
  this.timeout(600000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let tempDir = "";
  const originalNoteStorePath = process.env.SNAP_NOTE_STORE_PATH;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-viewing-persistence-"));
    process.env.SNAP_NOTE_STORE_PATH = path.join(tempDir, "notes.db");
    resetDefaultNoteStore();
  });

  afterEach(() => {
    resetDefaultNoteStore();
    if (originalNoteStorePath === undefined) {
      delete process.env.SNAP_NOTE_STORE_PATH;
    } else {
      process.env.SNAP_NOTE_STORE_PATH = originalNoteStorePath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists notes across restarts and reconstructs history from the viewing key", async () => {
    const operator = (provider.wallet as anchor.Wallet).payer;
    const operatorClient = new SNAPClient(provider.connection, operator);
    const recipient = Keypair.generate();
    const master = generateMasterKey("snap localnet viewing key persistence");
    const agent = deriveAgentKey(master, 0);
    const wrongAgent = deriveAgentKey(master, 1);
    const agentWallet = Keypair.fromSeed(agent.spendingKey);

    await fundSystemAccount(provider, recipient.publicKey, 1_000_000);
    await fundSystemAccount(provider, agentWallet.publicKey, 2_000_000_000);

    const pool = await operatorClient.createPool(0.1, { treeDepth: 20 });
    const agentClient = new SNAPClient(provider.connection, agent);
    const depositedNote = await agentClient.deposit(pool, 0.1);

    expect(
      getDefaultNoteStore().getEncryptedRecords(pool.toBase58()),
    ).to.have.length(1);

    const backupPath = path.join(tempDir, "notes.backup.json");
    const exported = getDefaultNoteStore().export(agent, backupPath);
    expect(exported).to.equal(1);

    resetDefaultNoteStore();

    const recoveredNotes = getDefaultNoteStore().load(pool.toBase58(), agent);
    expect(recoveredNotes).to.have.length(1);
    expect(recoveredNotes[0].depositIndex).to.equal(depositedNote.depositIndex);
    expect(getDefaultNoteStore().load(pool.toBase58(), wrongAgent)).to.have.length(0);

    getDefaultNoteStore().clear();
    expect(getDefaultNoteStore().load(pool.toBase58(), agent)).to.have.length(0);

    const imported = getDefaultNoteStore().import(agent, backupPath);
    expect(imported).to.equal(1);

    const importedNotes = getDefaultNoteStore().load(pool.toBase58(), agent);
    expect(importedNotes).to.have.length(1);

    await agentClient.withdraw(pool, importedNotes[0], recipient.publicKey);

    resetDefaultNoteStore();

    const history = await reconstructHistory(
      provider.connection,
      pool,
      extractViewingKey(agent),
    );
    expect(history).to.have.length(2);
    expect(history.map((record) => record.type)).to.deep.equal([
      "deposit",
      "withdrawal",
    ]);
    expect(history[0].nullified).to.equal(true);
    expect(history[1].nullified).to.equal(true);
  });
});
