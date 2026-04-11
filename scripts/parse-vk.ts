// Converts snarkjs verification_key.json to Rust byte arrays for groth16-solana
import { readFileSync } from "fs";

const inputPath = process.argv[2] ?? "build/verification_key.json";
const vk = JSON.parse(readFileSync(inputPath, "utf8"));

function bigintToBytes32BE(val: string): number[] {
  const bn = BigInt(val);
  const hex = bn.toString(16).padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}

function formatBytes(bytes: number[]): string {
  return bytes.map((b) => b.toString()).join(", ");
}

function g1Point(point: string[]): number[] {
  return [...bigintToBytes32BE(point[0]), ...bigintToBytes32BE(point[1])];
}

function g2Point(point: string[][]): number[] {
  // G2 points: (x.c1, x.c0, y.c1, y.c0) for groth16-solana
  return [
    ...bigintToBytes32BE(point[0][1]),
    ...bigintToBytes32BE(point[0][0]),
    ...bigintToBytes32BE(point[1][1]),
    ...bigintToBytes32BE(point[1][0]),
  ];
}

function icPoint(point: string[]): number[] {
  return g1Point(point);
}

console.log(`// Auto-generated from ${inputPath.split("/").pop()}`);
console.log("// Do not edit manually");
console.log("");
console.log(`pub const VK_ALPHA_G1: [u8; 64] = [${formatBytes(g1Point(vk.vk_alpha_1))}];`);
console.log("");
console.log(`pub const VK_BETA_G2: [u8; 128] = [${formatBytes(g2Point(vk.vk_beta_2))}];`);
console.log("");
console.log(`pub const VK_GAMMA_G2: [u8; 128] = [${formatBytes(g2Point(vk.vk_gamma_2))}];`);
console.log("");
console.log(`pub const VK_DELTA_G2: [u8; 128] = [${formatBytes(g2Point(vk.vk_delta_2))}];`);
console.log("");

const icArrays = vk.IC.map((ic: string[], i: number) => {
  return `    [${formatBytes(icPoint(ic))}]`;
});

console.log(`pub const VK_IC: [[u8; 64]; ${vk.IC.length}] = [`);
console.log(icArrays.join(",\n"));
console.log("];");
