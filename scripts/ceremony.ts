import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const ROOT_DIR = process.cwd();
const BUILD_DIR = path.join(ROOT_DIR, "build");
const DOCS_DIR = path.join(ROOT_DIR, "docs");
const RELAYER_ASSETS_DIR = path.join(ROOT_DIR, "relayer", "assets");
const SDK_ASSETS_DIR = path.join(ROOT_DIR, "sdk-package", "assets");

const CIRCUIT_PATH = path.join(ROOT_DIR, "circuits", "withdraw_20.circom");
const PTAU_PATH = path.join(BUILD_DIR, "powersOfTau28_hez_final_15.ptau");
const R1CS_PATH = path.join(BUILD_DIR, "withdraw_20.r1cs");
const WASM_PATH = path.join(BUILD_DIR, "withdraw_20_js", "withdraw_20.wasm");
const INITIAL_ZKEY_PATH = path.join(BUILD_DIR, "withdraw_20_0000.zkey");
const FINAL_ZKEY_PATH = path.join(BUILD_DIR, "withdraw_20_final.zkey");
const BUILD_VERIFICATION_KEY_PATH = path.join(
  BUILD_DIR,
  "verification_key_20.json"
);
const PROGRAM_VERIFICATION_KEY_PATH = path.join(
  ROOT_DIR,
  "programs",
  "agent-privacy-pool",
  "src",
  "verifying_key_20.rs"
);
const RELAYER_VERIFICATION_KEY_PATH = path.join(
  RELAYER_ASSETS_DIR,
  "verification_key_20.json"
);
const SDK_ZKEY_PATH = path.join(SDK_ASSETS_DIR, "withdraw_20_final.zkey");
const SDK_WASM_PATH = path.join(SDK_ASSETS_DIR, "withdraw_20.wasm");
const PARAMETER_GENERATION_DOC_PATH = path.join(
  DOCS_DIR,
  "PARAMETER_GENERATION.md"
);
const PTAU_URL =
  "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function runCommand(
  command: string,
  args: string[],
  options: {
    captureOutput?: boolean;
    acceptedExitCodes?: number[];
    description: string;
  }
): string {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: options.captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  const acceptedExitCodes = new Set([0, ...(options.acceptedExitCodes ?? [])]);
  if (!acceptedExitCodes.has(result.status ?? 1)) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const details = [stderr, stdout].filter(Boolean).join("\n");
    fail(
      `Failed while ${options.description}.\n` +
        `${command} ${args.join(" ")}\n` +
        `${details}`
    );
  }

  return options.captureOutput ? result.stdout ?? "" : "";
}

async function downloadPtauIfMissing(): Promise<void> {
  if (existsSync(PTAU_PATH)) {
    console.log(`Using existing Powers of Tau file: ${PTAU_PATH}`);
    return;
  }

  console.log("Downloading Powers of Tau file...");
  const response = await fetch(PTAU_URL);
  if (!response.ok || !response.body) {
    fail(`Failed to download Powers of Tau file from ${PTAU_URL}`);
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const fileStream = createWriteStream(PTAU_PATH);
  await pipeline(Readable.fromWeb(response.body as never), fileStream);
  console.log(`Downloaded Powers of Tau file to ${PTAU_PATH}`);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseConstraintCount(r1csInfoOutput: string): string {
  const clean = stripAnsi(r1csInfoOutput);
  const match = clean.match(/# of Constraints:\s+([0-9]+)/);
  if (!match) {
    fail("Unable to parse the constraint count from snarkjs r1cs info output.");
  }
  return match[1];
}

function sha256(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function renderParameterGenerationRecord(input: {
  date: string;
  constraintCount: string;
  hashes: Record<string, string>;
}): string {
  return `# SNAP Parameter Generation Record

## Scope
Groth16 proving and verification parameters for the SNAP withdraw circuit (depth-20), generated with supplied entropy.

## Status
Limited-release proving parameters. These artifacts were not produced through a public multi-party parameter-generation process.
A public transcript-based process, or a transparent proving system, is required before increasing pool denomination caps.

## Date
${input.date}

## Circuit
- File: circuits/withdraw_20.circom
- Depth: 20
- Constraint count: ${input.constraintCount}

## Powers of Tau
- Source: powersOfTau28_hez_final_15.ptau
- Mirror: storage.googleapis.com/zkevm/ptau/

## Artifact Hashes (SHA-256)
| Artifact | Hash |
|----------|------|
| withdraw_20_final.zkey | ${input.hashes["withdraw_20_final.zkey"]} |
| verification_key_20.json | ${input.hashes["verification_key_20.json"]} |
| withdraw_20.wasm | ${input.hashes["withdraw_20.wasm"]} |
| withdraw_20.r1cs | ${input.hashes["withdraw_20.r1cs"]} |

## Process
1. Circuit compiled with circom 2.2.3
2. Initial zkey generated from r1cs + ptau
3. Entropy supplied with snarkjs zkey contribute
4. Verification key exported
5. zkey verified against r1cs and ptau
6. Intermediate zkey (withdraw_20_0000.zkey) securely deleted
7. Verifying key constants generated for the Rust program

## Honest Assessment
- The current proving parameters were generated outside a public multi-party process
- There is no independently auditable evidence that toxic waste was destroyed
- If toxic waste was retained, proofs can be forged and pools drained
- For a capped rollout with small denominations, this risk is bounded
`;
}

function secureDeleteIntermediateZkey(): void {
  if (!existsSync(INITIAL_ZKEY_PATH)) {
    return;
  }

  if (process.platform === "darwin") {
    runCommand("rm", ["-P", INITIAL_ZKEY_PATH], {
      description: "securely deleting the intermediate zkey on macOS",
    });
  } else if (process.platform === "linux") {
    runCommand("shred", ["-u", INITIAL_ZKEY_PATH], {
      description: "securely deleting the intermediate zkey on Linux",
    });
  } else {
    rmSync(INITIAL_ZKEY_PATH, { force: true });
  }

  if (existsSync(INITIAL_ZKEY_PATH)) {
    fail(`Intermediate zkey still exists after deletion: ${INITIAL_ZKEY_PATH}`);
  }
}

function copyOutputsIntoRuntimeAssets(): void {
  mkdirSync(RELAYER_ASSETS_DIR, { recursive: true });
  mkdirSync(SDK_ASSETS_DIR, { recursive: true });

  copyFileSync(BUILD_VERIFICATION_KEY_PATH, RELAYER_VERIFICATION_KEY_PATH);
  copyFileSync(FINAL_ZKEY_PATH, SDK_ZKEY_PATH);
  copyFileSync(WASM_PATH, SDK_WASM_PATH);
}

function regenerateRustVerifyingKey(): void {
  const rustConstants = runCommand(
    "npx",
    ["tsx", "scripts/parse-vk.ts", BUILD_VERIFICATION_KEY_PATH],
    {
      captureOutput: true,
      description: "generating the Rust verifying key constants",
    }
  );

  writeFileSync(PROGRAM_VERIFICATION_KEY_PATH, rustConstants);
}

async function main(): Promise<void> {
  console.log("SNAP Groth16 Parameter Generation");
  console.log("");
  console.log(
    "This will generate the depth-20 proving and verification artifacts."
  );
  console.log(
    "You will be prompted by snarkjs for random entropy during the contribution step."
  );
  console.log(
    "The intermediate zkey contains toxic-waste-sensitive state and will be securely deleted."
  );
  console.log("");

  mkdirSync(BUILD_DIR, { recursive: true });
  mkdirSync(DOCS_DIR, { recursive: true });

  const circomVersion = runCommand("circom", ["--version"], {
    captureOutput: true,
    description: "checking circom version",
  }).trim();
  console.log(circomVersion);

  const snarkjsVersion = runCommand("npx", ["snarkjs", "--version"], {
    captureOutput: true,
    acceptedExitCodes: [99],
    description: "checking snarkjs version",
  }).trim();
  console.log(snarkjsVersion.split("\n")[0]);

  await downloadPtauIfMissing();

  console.log("");
  console.log("Compiling depth-20 circuit...");
  runCommand(
    "circom",
    [CIRCUIT_PATH, "--r1cs", "--wasm", "--sym", "--output", BUILD_DIR],
    { description: "compiling the depth-20 circuit" }
  );

  if (!existsSync(R1CS_PATH) || !existsSync(WASM_PATH)) {
    fail(
      "Circuit compilation completed, but the expected depth-20 artifacts are missing."
    );
  }

  rmSync(INITIAL_ZKEY_PATH, { force: true });
  rmSync(FINAL_ZKEY_PATH, { force: true });
  rmSync(BUILD_VERIFICATION_KEY_PATH, { force: true });

  console.log("");
  console.log("Generating initial zkey...");
  runCommand(
    "npx",
    ["snarkjs", "groth16", "setup", R1CS_PATH, PTAU_PATH, INITIAL_ZKEY_PATH],
    { description: "generating the initial zkey" }
  );

  console.log("");
  console.log("Contribution step starting.");
  console.log(
    "When snarkjs prompts for entropy, type random characters and submit the prompt."
  );
  runCommand(
    "npx",
    ["snarkjs", "zkey", "contribute", INITIAL_ZKEY_PATH, FINAL_ZKEY_PATH],
    { description: "contributing operator entropy to the zkey" }
  );

  console.log("");
  console.log("Exporting verification key...");
  runCommand(
    "npx",
    [
      "snarkjs",
      "zkey",
      "export",
      "verificationkey",
      FINAL_ZKEY_PATH,
      BUILD_VERIFICATION_KEY_PATH,
    ],
    { description: "exporting the verification key" }
  );

  console.log("");
  console.log("Verifying final zkey against the circuit and Powers of Tau...");
  runCommand(
    "npx",
    ["snarkjs", "zkey", "verify", R1CS_PATH, PTAU_PATH, FINAL_ZKEY_PATH],
    { description: "verifying the final zkey" }
  );

  const r1csInfoOutput = runCommand(
    "npx",
    ["snarkjs", "r1cs", "info", R1CS_PATH],
    {
      captureOutput: true,
      description: "reading the circuit constraint count",
    }
  );
  const constraintCount = parseConstraintCount(r1csInfoOutput);

  regenerateRustVerifyingKey();
  copyOutputsIntoRuntimeAssets();
  secureDeleteIntermediateZkey();

  const hashes = {
    "withdraw_20_final.zkey": sha256(FINAL_ZKEY_PATH),
    "verification_key_20.json": sha256(BUILD_VERIFICATION_KEY_PATH),
    "withdraw_20.wasm": sha256(WASM_PATH),
    "withdraw_20.r1cs": sha256(R1CS_PATH),
  };

  const record = renderParameterGenerationRecord({
    date: new Date().toISOString(),
    constraintCount,
    hashes,
  });
  writeFileSync(PARAMETER_GENERATION_DOC_PATH, record);

  console.log("");
  console.log("Parameter generation complete.");
  console.log("");
  console.log("Generated artifacts:");
  console.log(`  ${FINAL_ZKEY_PATH} (${statSync(FINAL_ZKEY_PATH).size} bytes)`);
  console.log(`  ${BUILD_VERIFICATION_KEY_PATH}`);
  console.log(`  ${WASM_PATH}`);
  console.log(`  ${R1CS_PATH}`);
  console.log(`  ${PARAMETER_GENERATION_DOC_PATH}`);
  console.log("");
  console.log("Next review steps:");
  console.log("  1. Review docs/PARAMETER_GENERATION.md.");
  console.log("  2. Confirm the SHA-256 hashes were written.");
  console.log(
    "  3. Review the toxic-waste risk disclosure before raising caps."
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
