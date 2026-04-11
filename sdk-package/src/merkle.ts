let poseidon: ((inputs: bigint[]) => bigint) | null = null;
let poseidonField: {
  e(value: bigint): unknown;
  toString(value: unknown): string;
} | null = null;

export async function initPoseidon(): Promise<void> {
  if (poseidon && poseidonField) {
    return;
  }

  const { buildPoseidon } = await import("circomlibjs");
  const instance = await buildPoseidon();

  poseidonField = instance.F as {
    e(value: bigint): unknown;
    toString(value: unknown): string;
  };

  poseidon = (inputs: bigint[]): bigint => {
    const hash = instance(inputs.map((value) => poseidonField!.e(value)));
    return BigInt(poseidonField!.toString(hash));
  };
}

export function poseidonHash(inputs: bigint[]): bigint {
  if (!poseidon) {
    throw new Error("SNAP: Poseidon has not been initialized");
  }

  return poseidon(inputs);
}

export function poseidonHash1(value: bigint): bigint {
  return poseidonHash([value]);
}

export function poseidonHash2(left: bigint, right: bigint): bigint {
  return poseidonHash([left, right]);
}

export class PoseidonMerkleTree {
  private readonly levels: number;
  private readonly leaves: bigint[];
  private zeros: bigint[];

  constructor(levels = 10) {
    this.levels = levels;
    this.leaves = [];
    this.zeros = [];
  }

  async init(): Promise<void> {
    await initPoseidon();
    this.zeros = this.generateZeros();
  }

  insert(leaf: bigint): number {
    const index = this.leaves.length;
    if (index >= 2 ** this.levels) {
      throw new Error("SNAP: Pool is full — the Merkle tree cannot accept more leaves");
    }

    this.leaves.push(leaf);
    return index;
  }

  getRoot(): bigint {
    if (this.zeros.length === 0) {
      throw new Error("SNAP: Poseidon Merkle tree has not been initialized");
    }

    if (this.leaves.length === 0) {
      return this.zeros[this.levels];
    }

    return this.computeRoot(this.leaves);
  }

  getProof(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error("SNAP: Invalid note — deposit index is outside the Merkle tree");
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentLevel = [...this.leaves];
    let currentIndex = index;

    for (let level = 0; level < this.levels; level += 1) {
      const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      const sibling =
        siblingIndex < currentLevel.length
          ? currentLevel[siblingIndex]
          : this.zeros[level];

      pathElements.push(sibling);
      pathIndices.push(currentIndex % 2);

      const nextLevel: bigint[] = [];
      for (let i = 0; i < Math.ceil(currentLevel.length / 2); i += 1) {
        const left = currentLevel[i * 2];
        const right =
          i * 2 + 1 < currentLevel.length
            ? currentLevel[i * 2 + 1]
            : this.zeros[level];
        nextLevel.push(poseidonHash2(left, right));
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }

  get size(): number {
    return this.leaves.length;
  }

  private computeRoot(leaves: bigint[]): bigint {
    let currentLevel = [...leaves];

    for (let level = 0; level < this.levels; level += 1) {
      const nextLevel: bigint[] = [];
      const levelSize = Math.ceil(currentLevel.length / 2);

      for (let i = 0; i < levelSize; i += 1) {
        const left = currentLevel[i * 2];
        const right =
          i * 2 + 1 < currentLevel.length
            ? currentLevel[i * 2 + 1]
            : this.zeros[level];
        nextLevel.push(poseidonHash2(left, right));
      }

      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  private generateZeros(): bigint[] {
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= this.levels; i += 1) {
      zeros.push(poseidonHash2(zeros[i - 1], zeros[i - 1]));
    }
    return zeros;
  }
}

export async function buildTreeFromCommitments(
  commitments: Uint8Array[],
  toBigInt: (value: Uint8Array) => bigint,
  levels = 10,
): Promise<PoseidonMerkleTree> {
  const tree = new PoseidonMerkleTree(levels);
  await tree.init();

  for (const commitment of commitments) {
    tree.insert(toBigInt(commitment));
  }

  return tree;
}
