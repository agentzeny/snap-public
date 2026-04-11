import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  bytesToHex,
  deserializeNotePayload,
  encryptNote,
  serializeNotePayload,
} from "./commitment";
import {
  decryptNoteWithViewingKey,
  extractViewingKey,
  type AgentKeyPair,
  type ViewingKeyBundle,
} from "./keys";
import type { DecryptedNote, EncryptedNoteRecord, Note } from "./types";
import { cloneBytes } from "./utils";

const NONCE_LENGTH = 24;
const DEFAULT_NOTE_STORE_DIR = path.join(os.homedir(), ".snap");
const DEFAULT_NOTE_STORE_PATH = path.join(DEFAULT_NOTE_STORE_DIR, "notes.db");
const BACKUP_FILE_VERSION = 1;

interface StoredNoteRow {
  id: string;
  pool_address: string;
  deposit_index: number;
  commitment_hex: string;
  nonce_hex: string;
  ciphertext_hex: string;
  created_at: number;
}

interface ExportedNotesFile {
  version: number;
  exportedAt: string;
  noteCount: number;
  payload: string;
}

export interface NoteStoreOptions {
  dbPath?: string;
  warn?: (message: string) => void;
}

export class NoteStore {
  private readonly dbPath: string;
  private readonly warn: (message: string) => void;
  private db: Database.Database | null = null;
  private readonly memoryRows = new Map<string, StoredNoteRow>();
  private warnedFallback = false;

  constructor(options: NoteStoreOptions = {}) {
    this.dbPath = path.resolve(options.dbPath ?? resolveNoteStorePath());
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.initialize();
  }

  get path(): string {
    return this.dbPath;
  }

  isPersistent(): boolean {
    return this.db !== null;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  clear(): void {
    if (this.db) {
      this.db.prepare("delete from notes").run();
    }
    this.memoryRows.clear();
  }

  save(note: Note, agentKeyPair: AgentKeyPair): string {
    return this.saveEncryptedRecord({
      commitment: note.commitment,
      encryptedNote: encryptNote(note, agentKeyPair.viewingKey),
      poolAddress: note.poolAddress,
      depositIndex: note.depositIndex,
    });
  }

  saveEncryptedRecord(record: EncryptedNoteRecord): string {
    const row = toStoredNoteRow(record);

    if (this.db) {
      this.db
        .prepare(
          `insert into notes (
              id,
              pool_address,
              deposit_index,
              commitment_hex,
              nonce_hex,
              ciphertext_hex,
              created_at
            ) values (
              @id,
              @pool_address,
              @deposit_index,
              @commitment_hex,
              @nonce_hex,
              @ciphertext_hex,
              @created_at
            )
            on conflict(pool_address, commitment_hex) do update set
              id = excluded.id,
              pool_address = excluded.pool_address,
              deposit_index = excluded.deposit_index,
              commitment_hex = excluded.commitment_hex,
              nonce_hex = excluded.nonce_hex,
              ciphertext_hex = excluded.ciphertext_hex,
              created_at = excluded.created_at`,
        )
        .run(row);
    } else {
      this.memoryRows.set(row.id, row);
    }

    return row.id;
  }

  getEncryptedRecords(poolAddress?: string): EncryptedNoteRecord[] {
    const rows = this.listRows(poolAddress);
    return rows.map(toEncryptedNoteRecord);
  }

  load(
    poolAddress: string,
    viewingKeySource: AgentKeyPair | ViewingKeyBundle,
  ): DecryptedNote[] {
    const viewingKey = normalizeViewingKeySource(viewingKeySource);
    return this.getEncryptedRecords(poolAddress)
      .map((record) => decryptStoredRecord(record, viewingKey))
      .filter((note): note is DecryptedNote => note !== null)
      .sort((left, right) => left.depositIndex - right.depositIndex);
  }

  loadAll(viewingKeySource: AgentKeyPair | ViewingKeyBundle): DecryptedNote[] {
    const viewingKey = normalizeViewingKeySource(viewingKeySource);
    return this.getEncryptedRecords()
      .map((record) => decryptStoredRecord(record, viewingKey))
      .filter((note): note is DecryptedNote => note !== null)
      .sort((left, right) => {
        if (left.poolAddress !== right.poolAddress) {
          return left.poolAddress.localeCompare(right.poolAddress);
        }
        return left.depositIndex - right.depositIndex;
      });
  }

  delete(noteId: string): void {
    if (this.db) {
      this.db.prepare("delete from notes where id = ?").run(noteId);
    }
    this.memoryRows.delete(noteId);
  }

  export(
    viewingKeySource: AgentKeyPair | ViewingKeyBundle,
    outputPath: string,
  ): number {
    const viewingKey = normalizeViewingKeySource(viewingKeySource);
    const notes = this.loadAll(viewingKeySource).map((note) => serializeNotePayload(note));
    const payload = JSON.stringify({
      agentId: viewingKey.agentId,
      index: viewingKey.index,
      notes,
    });
    const encryptedPayload = encryptBackupPayload(payload, viewingKey.viewingKey);
    const document: ExportedNotesFile = {
      version: BACKUP_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      noteCount: notes.length,
      payload: Buffer.from(encryptedPayload).toString("hex"),
    };
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`);
    return notes.length;
  }

  import(
    viewingKeySource: AgentKeyPair | ViewingKeyBundle,
    inputPath: string,
  ): number {
    const viewingKey = normalizeViewingKeySource(viewingKeySource);
    const document = JSON.parse(
      fs.readFileSync(path.resolve(inputPath), "utf8"),
    ) as Partial<ExportedNotesFile>;

    if (
      document.version !== BACKUP_FILE_VERSION ||
      typeof document.payload !== "string"
    ) {
      throw new Error("SNAP: Invalid note backup file");
    }

    const decryptedPayload = decryptBackupPayload(
      document.payload,
      viewingKey.viewingKey,
    );
    const parsed = JSON.parse(decryptedPayload) as {
      notes?: string[];
    };
    if (!Array.isArray(parsed.notes)) {
      throw new Error("SNAP: Invalid note backup payload");
    }

    let imported = 0;
    for (const serializedNote of parsed.notes) {
      if (typeof serializedNote !== "string") {
        continue;
      }

      const note = deserializeNotePayload(serializedNote);

      this.saveEncryptedRecord({
        commitment: note.commitment,
        encryptedNote: encryptNote(note, viewingKey.viewingKey),
        poolAddress: note.poolAddress,
        depositIndex: note.depositIndex,
      });
      imported += 1;
    }

    return imported;
  }

  private initialize(): void {
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        create table if not exists notes (
          id text primary key,
          pool_address text not null,
          deposit_index integer not null,
          commitment_hex text not null,
          nonce_hex text not null,
          ciphertext_hex text not null,
          created_at integer not null
        );
        create index if not exists idx_notes_pool_deposit
          on notes(pool_address, deposit_index);
        create unique index if not exists idx_notes_pool_commitment
          on notes(pool_address, commitment_hex);
      `);
    } catch (error) {
      this.db = null;
      this.warnFallback(error);
    }
  }

  private listRows(poolAddress?: string): StoredNoteRow[] {
    const rows = this.db
      ? (poolAddress
          ? (this.db
              .prepare(
                `select
                    id,
                    pool_address,
                    deposit_index,
                    commitment_hex,
                    nonce_hex,
                    ciphertext_hex,
                    created_at
                 from notes
                 where pool_address = ?
                 order by deposit_index asc, created_at asc`,
              )
              .all(poolAddress) as StoredNoteRow[])
          : (this.db
              .prepare(
                `select
                    id,
                    pool_address,
                    deposit_index,
                    commitment_hex,
                    nonce_hex,
                    ciphertext_hex,
                    created_at
                 from notes
                 order by pool_address asc, deposit_index asc, created_at asc`,
              )
              .all() as StoredNoteRow[]))
      : Array.from(this.memoryRows.values())
          .filter((row) => (poolAddress ? row.pool_address === poolAddress : true))
          .sort((left, right) => {
            if (left.pool_address !== right.pool_address) {
              return left.pool_address.localeCompare(right.pool_address);
            }
            if (left.deposit_index !== right.deposit_index) {
              return left.deposit_index - right.deposit_index;
            }
            return left.created_at - right.created_at;
          });

    return rows;
  }

  private warnFallback(error: unknown): void {
    if (this.warnedFallback) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    this.warn(
      `SNAP: NoteStore failed to initialize at ${this.dbPath}; falling back to in-memory note storage (${message})`,
    );
    this.warnedFallback = true;
  }
}

let defaultNoteStore: NoteStore | null = null;
let defaultNoteStorePath: string | null = null;

export function resolveNoteStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.SNAP_NOTE_STORE_PATH ?? DEFAULT_NOTE_STORE_PATH);
}

export function getDefaultNoteStore(): NoteStore {
  const resolvedPath = resolveNoteStorePath();

  if (!defaultNoteStore || defaultNoteStorePath !== resolvedPath) {
    defaultNoteStore?.close();
    defaultNoteStore = new NoteStore({ dbPath: resolvedPath });
    defaultNoteStorePath = resolvedPath;
  }

  return defaultNoteStore;
}

export function resetDefaultNoteStore(): void {
  defaultNoteStore?.close();
  defaultNoteStore = null;
  defaultNoteStorePath = null;
}

function toStoredNoteRow(record: EncryptedNoteRecord): StoredNoteRow {
  if (record.encryptedNote.length <= NONCE_LENGTH) {
    throw new Error("SNAP: Encrypted notes must include a 24-byte nonce and ciphertext");
  }

  const nonce = record.encryptedNote.slice(0, NONCE_LENGTH);
  const ciphertext = record.encryptedNote.slice(NONCE_LENGTH);
  const commitmentHex = bytesToHex(record.commitment);

  return {
    id:
      record.id ?? `${record.poolAddress}:${record.depositIndex}:${commitmentHex}`,
    pool_address: record.poolAddress,
    deposit_index: record.depositIndex,
    commitment_hex: commitmentHex,
    nonce_hex: Buffer.from(nonce).toString("hex"),
    ciphertext_hex: Buffer.from(ciphertext).toString("hex"),
    created_at: record.createdAt ?? Date.now(),
  };
}

function toEncryptedNoteRecord(row: StoredNoteRow): EncryptedNoteRecord {
  const encryptedNote = Uint8Array.from(
    Buffer.from(`${row.nonce_hex}${row.ciphertext_hex}`, "hex"),
  );

  return {
    id: row.id,
    commitment: Uint8Array.from(Buffer.from(row.commitment_hex, "hex")),
    encryptedNote,
    poolAddress: row.pool_address,
    depositIndex: row.deposit_index,
    createdAt: row.created_at,
  };
}

function decryptStoredRecord(
  record: EncryptedNoteRecord,
  viewingKey: ViewingKeyBundle,
): DecryptedNote | null {
  const decrypted = decryptNoteWithViewingKey(viewingKey, record.encryptedNote);
  if (!decrypted) {
    return null;
  }

  return {
    ...decrypted,
    commitment: cloneBytes(decrypted.commitment),
    nullifierHash: cloneBytes(decrypted.nullifierHash),
  };
}

function normalizeViewingKeySource(
  viewingKeySource: AgentKeyPair | ViewingKeyBundle,
): ViewingKeyBundle {
  return "spendingKey" in viewingKeySource
    ? extractViewingKey(viewingKeySource)
    : viewingKeySource;
}

function encryptBackupPayload(payload: string, viewingKey: Uint8Array): Uint8Array {
  const nonce = Uint8Array.from(randomBytes(NONCE_LENGTH));
  const cipher = xchacha20poly1305(viewingKey, nonce);
  const ciphertext = cipher.encrypt(Buffer.from(payload, "utf8"));
  return Uint8Array.from([...nonce, ...ciphertext]);
}

function decryptBackupPayload(payloadHex: string, viewingKey: Uint8Array): string {
  const payload = Buffer.from(payloadHex, "hex");
  if (payload.length <= NONCE_LENGTH) {
    throw new Error("SNAP: Invalid note backup payload");
  }

  const nonce = payload.subarray(0, NONCE_LENGTH);
  const ciphertext = payload.subarray(NONCE_LENGTH);

  try {
    const cipher = xchacha20poly1305(viewingKey, nonce);
    const plaintext = cipher.decrypt(ciphertext);
    return Buffer.from(plaintext).toString("utf8");
  } catch {
    throw new Error("SNAP: Note backup could not be decrypted with the provided viewing key");
  }
}
