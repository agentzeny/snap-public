// Poseidon-based Merkle tree for ZK circuit compatibility
// Uses circomlibjs Poseidon which matches the circom circuit

let poseidon: any;
let F: any;

export async function initPoseidon() {
  if (poseidon) return;
  const { buildPoseidon } = await import("circomlibjs");
  poseidon = await buildPoseidon();
  F = poseidon.F;
}

export function poseidonHash(inputs: bigint[]): bigint {
  const hash = poseidon(inputs.map((x) => F.e(x)));
  return BigInt(F.toString(hash));
}

export function poseidonHash2(a: bigint, b: bigint): bigint {
  return poseidonHash([a, b]);
}

export function poseidonHash1(a: bigint): bigint {
  return poseidonHash([a]);
}

export class PoseidonMerkleTree {
  private levels: number;
  private leaves: bigint[];
  private zeros: bigint[];

  constructor(levels: number = 10) {
    this.levels = levels;
    this.leaves = [];
    this.zeros = [];
  }

  async init() {
    await initPoseidon();
    this.zeros = this.generateZeros();
  }

  private generateZeros(): bigint[] {
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= this.levels; i++) {
      zeros.push(poseidonHash2(zeros[i - 1], zeros[i - 1]));
    }
    return zeros;
  }

  insert(leaf: bigint): number {
    const index = this.leaves.length;
    if (index >= 2 ** this.levels) {
      throw new Error("Merkle tree is full");
    }
    this.leaves.push(leaf);
    return index;
  }

  getRoot(): bigint {
    if (this.leaves.length === 0) {
      return this.zeros[this.levels];
    }
    return this.computeRoot(this.leaves);
  }

  private computeRoot(leaves: bigint[]): bigint {
    let currentLevel = [...leaves];
    for (let level = 0; level < this.levels; level++) {
      const nextLevel: bigint[] = [];
      const levelSize = Math.ceil(currentLevel.length / 2);
      for (let i = 0; i < levelSize; i++) {
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

  getProof(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    if (index >= this.leaves.length) {
      throw new Error("Leaf index out of range");
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentLevel = [...this.leaves];
    let currentIndex = index;

    for (let level = 0; level < this.levels; level++) {
      const siblingIndex =
        currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      const sibling =
        siblingIndex < currentLevel.length
          ? currentLevel[siblingIndex]
          : this.zeros[level];

      pathElements.push(sibling);
      pathIndices.push(currentIndex % 2);

      const nextLevel: bigint[] = [];
      for (let i = 0; i < Math.ceil(currentLevel.length / 2); i++) {
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
}
