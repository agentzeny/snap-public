import type { SnapClientLike } from "./snap-client";

interface SnapClientConstructor {
  new (connection: unknown, wallet: unknown): SnapClientLike;
  deserializeNote(data: string): unknown;
  serializeNote(note: never): string;
}

export function createSnapSdkClient(
  connection: unknown,
  wallet: unknown
): SnapClientLike {
  return new (loadSnapClientConstructor())(connection, wallet);
}

export function deserializeSnapNote(data: string): unknown {
  return loadSnapClientConstructor().deserializeNote(data);
}

export function deserializeSnapNoteIfString(note: unknown): unknown {
  if (typeof note !== "string") {
    return note;
  }

  try {
    return deserializeSnapNote(note);
  } catch {
    return note;
  }
}

export function serializeSnapNoteIfPossible(note: unknown): string | null {
  try {
    return loadSnapClientConstructor().serializeNote(note as never);
  } catch {
    return null;
  }
}

function loadSnapClientConstructor(): SnapClientConstructor {
  const sdk = require("../../sdk-package/src") as {
    SNAPClient: SnapClientConstructor;
  };
  return sdk.SNAPClient;
}
