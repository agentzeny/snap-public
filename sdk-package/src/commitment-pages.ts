import { PublicKey } from "@solana/web3.js";
import { SNAP_PROGRAM_ID } from "./constants";
import { getRecordField, normalizeBytesMatrix, toNumber } from "./utils";

export const COMMITMENT_PAGE_CAPACITY = 48;

export interface CommitmentPageState {
  commitmentCount: number;
  commitments: Uint8Array[];
  pageIndex: number;
  startOffset: number;
}

export function deriveCommitmentPagePda(
  pool: PublicKey,
  pageIndex: number,
  programId: PublicKey = SNAP_PROGRAM_ID,
): [PublicKey, number] {
  const indexBytes = Buffer.alloc(4);
  indexBytes.writeUInt32LE(pageIndex, 0);

  return PublicKey.findProgramAddressSync(
    [Buffer.from("commitment_page"), pool.toBuffer(), indexBytes],
    programId,
  );
}

export function decodeCommitmentPageState(
  account: Record<string, unknown>,
): CommitmentPageState {
  return {
    commitmentCount: toNumber(
      getRecordField(account, "commitmentCount", "commitment_count"),
    ),
    commitments: normalizeBytesMatrix(getRecordField(account, "commitments")),
    pageIndex: toNumber(getRecordField(account, "pageIndex", "page_index")),
    startOffset: toNumber(
      getRecordField(account, "startOffset", "start_offset"),
    ),
  };
}

export function mergeCommitmentSources(args: {
  inlineCommitments: Uint8Array[];
  nextIndex: number;
  pages: CommitmentPageState[];
}): Uint8Array[] {
  const commitments = Array.from(
    { length: args.nextIndex },
    () => new Uint8Array(32),
  );

  args.inlineCommitments
    .slice(0, args.nextIndex)
    .forEach((commitment, index) => {
      commitments[index] = Uint8Array.from(commitment);
    });

  for (const page of args.pages) {
    const maxEntries = Math.min(
      page.commitmentCount,
      page.commitments.length,
      COMMITMENT_PAGE_CAPACITY,
    );

    for (let localIndex = 0; localIndex < maxEntries; localIndex += 1) {
      const globalIndex =
        page.pageIndex * COMMITMENT_PAGE_CAPACITY + page.startOffset + localIndex;
      if (globalIndex >= commitments.length) {
        break;
      }

      commitments[globalIndex] = Uint8Array.from(page.commitments[localIndex]);
    }
  }

  return commitments;
}
