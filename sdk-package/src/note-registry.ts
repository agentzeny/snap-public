import type { EncryptedNoteRecord } from "./types";
import {
  getDefaultNoteStore,
  resetDefaultNoteStore,
  type NoteStore,
} from "./note-store";

export function registerEncryptedNote(record: EncryptedNoteRecord): void {
  getDefaultNoteStore().saveEncryptedRecord(record);
}

export function registerEncryptedNotes(records: EncryptedNoteRecord[]): void {
  for (const record of records) {
    registerEncryptedNote(record);
  }
}

export function getEncryptedNotesForPool(poolAddress: string): EncryptedNoteRecord[] {
  return getDefaultNoteStore().getEncryptedRecords(poolAddress);
}

export function clearEncryptedNoteRegistry(): void {
  getDefaultNoteStore().clear();
}

export function getNoteStore(): NoteStore {
  return getDefaultNoteStore();
}

export function resetNoteStore(): void {
  resetDefaultNoteStore();
}
