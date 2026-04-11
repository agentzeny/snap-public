import { createHash } from "crypto";

// Simple off-chain Merkle tree (informational for Path A, critical for Path B)
export class MerkleTree {
  private levels: number;
  private leaves: Buffer[];
  private zeros: Buffer[];

  constructor(levels: number = 10) {
    this.levels = levels;
    this.leaves = [];
    this.zeros = this.generateZeros();
  }

  private generateZeros(): Buffer[] {
    const zeros: Buffer[] = [Buffer.alloc(32)]; // level 0 zero = 32 zero bytes
    for (let i = 1; i <= this.levels; i++) {
      zeros.push(hashPair(zeros[i - 1], zeros[i - 1]));
    }
    return zeros;
  }

  insert(leaf: Buffer): number {
    const index = this.leaves.length;
    if (index >= 2 ** this.levels) {
      throw new Error("Merkle tree is full");
    }
    this.leaves.push(leaf);
    return index;
  }

  getRoot(): Buffer {
    if (this.leaves.length === 0) {
      return this.zeros[this.levels];
    }
    return this.computeRoot(this.leaves);
  }

  private computeRoot(leaves: Buffer[]): Buffer {
    let currentLevel = [...leaves];
    for (let level = 0; level < this.levels; level++) {
      const nextLevel: Buffer[] = [];
      const levelSize = Math.ceil(currentLevel.length / 2);
      for (let i = 0; i < levelSize; i++) {
        const left = currentLevel[i * 2];
        const right =
          i * 2 + 1 < currentLevel.length
            ? currentLevel[i * 2 + 1]
            : this.zeros[level];
        nextLevel.push(hashPair(left, right));
      }
      currentLevel = nextLevel;
    }
    return currentLevel[0];
  }

  getProof(
    index: number
  ): { pathElements: Buffer[]; pathIndices: number[] } {
    if (index >= this.leaves.length) {
      throw new Error("Leaf index out of range");
    }

    const pathElements: Buffer[] = [];
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
      pathIndices.push(currentIndex % 2); // 0 if left child, 1 if right child

      // Build next level
      const nextLevel: Buffer[] = [];
      for (let i = 0; i < Math.ceil(currentLevel.length / 2); i++) {
        const left = currentLevel[i * 2];
        const right =
          i * 2 + 1 < currentLevel.length
            ? currentLevel[i * 2 + 1]
            : this.zeros[level];
        nextLevel.push(hashPair(left, right));
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

function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([left, right]))
    .digest();
}
