import fs from "fs";
import os from "os";
import path from "path";
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { createNote, encryptNote } from "../src/commitment";
import { deriveAgentKey, generateMasterKey } from "../src/keys";
import { getNoteStore, registerEncryptedNote, resetNoteStore } from "../src/note-registry";

describe("Viewing key persistence", () => {
  let tempDir: string;
  const originalNoteStorePath = process.env.SNAP_NOTE_STORE_PATH;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-note-store-"));
    process.env.SNAP_NOTE_STORE_PATH = path.join(tempDir, "notes.db");
    resetNoteStore();
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

  it("persists encrypted notes across store restarts and rejects wrong viewing keys", async () => {
    const pool = Keypair.generate().publicKey;
    const master = generateMasterKey("snap persistence fixture");
    const agent = deriveAgentKey(master, 0);
    const wrongAgent = deriveAgentKey(master, 1);
    const note = await createNote(pool, 0);

    registerEncryptedNote({
      commitment: note.commitment,
      encryptedNote: encryptNote(note, agent.viewingKey),
      poolAddress: note.poolAddress,
      depositIndex: note.depositIndex,
    });

    expect(getNoteStore().load(pool.toBase58(), agent)).to.have.length(1);

    resetNoteStore();

    const recovered = getNoteStore().load(pool.toBase58(), agent);
    expect(recovered).to.have.length(1);
    expect(recovered[0].poolAddress).to.equal(note.poolAddress);
    expect(recovered[0].depositIndex).to.equal(note.depositIndex);
    expect(getNoteStore().load(pool.toBase58(), wrongAgent)).to.have.length(0);
  });

  it("exports and imports encrypted backups without leaking plaintext note data", async () => {
    const pool = Keypair.generate().publicKey;
    const master = generateMasterKey("snap export import fixture");
    const agent = deriveAgentKey(master, 0);
    const wrongAgent = deriveAgentKey(master, 1);
    const note = await createNote(pool, 0);
    const backupPath = path.join(tempDir, "notes.backup.json");

    getNoteStore().save(note, agent);
    const exported = getNoteStore().export(agent, backupPath);
    expect(exported).to.equal(1);

    const backupDocument = fs.readFileSync(backupPath, "utf8");
    expect(backupDocument).to.not.include(note.poolAddress);
    expect(backupDocument).to.not.include(note.secret.toString());

    getNoteStore().clear();
    expect(getNoteStore().load(pool.toBase58(), agent)).to.have.length(0);

    expect(() => getNoteStore().import(wrongAgent, backupPath)).to.throw(
      /could not be decrypted/i,
    );

    const imported = getNoteStore().import(agent, backupPath);
    expect(imported).to.equal(1);
    expect(getNoteStore().load(pool.toBase58(), agent)).to.have.length(1);
  });
});
