import { createHash } from "crypto";

export interface Note {
  secret: Buffer;
  nullifier: Buffer;
  commitment: Buffer;
  nullifierHash: Buffer;
}

export function generateNote(): Note {
  const secret = Buffer.from(
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
  );
  const nullifier = Buffer.from(
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
  );

  // commitment = sha256(secret || nullifier) — matches on-chain computation
  const commitment = sha256(Buffer.concat([secret, nullifier]));

  // nullifierHash = sha256(nullifier) — matches on-chain computation
  const nullifierHash = sha256(nullifier);

  return { secret, nullifier, commitment, nullifierHash };
}

export function computeCommitment(secret: Buffer, nullifier: Buffer): Buffer {
  return sha256(Buffer.concat([secret, nullifier]));
}

export function computeNullifierHash(nullifier: Buffer): Buffer {
  return sha256(nullifier);
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function noteToJSON(note: Note): string {
  return JSON.stringify({
    secret: note.secret.toString("hex"),
    nullifier: note.nullifier.toString("hex"),
    commitment: note.commitment.toString("hex"),
    nullifierHash: note.nullifierHash.toString("hex"),
  });
}

export function noteFromJSON(json: string): Note {
  const parsed = JSON.parse(json);
  return {
    secret: Buffer.from(parsed.secret, "hex"),
    nullifier: Buffer.from(parsed.nullifier, "hex"),
    commitment: Buffer.from(parsed.commitment, "hex"),
    nullifierHash: Buffer.from(parsed.nullifierHash, "hex"),
  };
}
