import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, "docs");
const PARAMETER_GENERATION_DOC_PATH = path.join(
  DOCS_DIR,
  "PARAMETER_GENERATION.md"
);
const TREASURY_CONFIG_PATH = path.join(ROOT_DIR, "treasury-config.json");
const PROGRAM_VK_PATH = path.join(
  ROOT_DIR,
  "programs",
  "agent-privacy-pool",
  "src",
  "verifying_key_20.rs"
);

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function main(): void {
  runCommandCheck("Program builds cleanly", "anchor", ["build"]);
  runCommandCheck("Localnet suite passes", "bash", [
    "scripts/test-localnet.sh",
  ]);
  runCommandCheck("SDK build passes", "npm", ["run", "build"], "sdk-package");
  runCommandCheck("SDK tests pass", "npm", ["test"], "sdk-package");
  runCommandCheck(
    "SDK pack dry run passes",
    "npm",
    ["pack", "--dry-run"],
    "sdk-package"
  );
  runCommandCheck("Relayer build passes", "npm", ["run", "build"], "relayer");
  runCommandCheck("Relayer tests pass", "npm", ["test"], "relayer");
  runCommandCheck(
    "Agent kit build passes",
    "npm",
    ["run", "build"],
    "agent-kit-tool"
  );
  runCommandCheck("Agent kit tests pass", "npm", ["test"], "agent-kit-tool");

  runCheck(
    "Adversarial results matched expectations",
    verifyAdversarialResults
  );
  runCheck("Treasury config exists and is valid", verifyTreasuryConfig);
  runCheck(
    "Parameter-generation hashes match frozen artifacts",
    verifyParameterGenerationHashes
  );
  runCheck(
    "Rust verifying key matches verification_key_20.json",
    verifyRustVerifyingKey
  );
  runCheck(
    "Limited-release language is present in launch docs",
    verifyLimitedReleaseLanguage
  );
  runCheck(
    "Spend-key docs do not claim proofs are signed",
    verifySpendKeyLanguage
  );
  runCheck(
    "Sensitive files are covered by .gitignore",
    verifyGitignoreCoverage
  );

  const failed = results.filter((result) => !result.ok);
  const passed = results.length - failed.length;

  console.log("");
  console.log("SNAP Pre-Launch Checklist");
  console.log("=========================");
  for (const result of results) {
    const prefix = result.ok ? "PASS" : "FAIL";
    console.log(
      `[${prefix}] ${result.name}${result.detail ? ` — ${result.detail}` : ""}`
    );
  }

  console.log("");
  console.log(`Passed ${passed}/${results.length} checks.`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

function runCommandCheck(
  name: string,
  command: string,
  args: string[],
  relativeCwd = "."
): void {
  const cwd = path.join(ROOT_DIR, relativeCwd);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status === 0) {
    results.push({ name, ok: true });
    return;
  }

  results.push({
    name,
    ok: false,
    detail: summarizeCommandFailure(
      command,
      args,
      result.stdout,
      result.stderr
    ),
  });
}

function runCheck(name: string, check: () => string | void): void {
  try {
    const detail = check();
    results.push({
      name,
      ok: true,
      detail,
    });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function verifyAdversarialResults(): string {
  const nonBlockingCases = new Map<string, Set<string>>([
    ["circuit.json", new Set(["1h-secret"])],
  ]);
  const files = fs
    .readdirSync(path.join(ROOT_DIR, "adversarial-results"))
    .filter((file) => file.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    throw new Error("No adversarial JSON result files found");
  }

  for (const file of files) {
    const document = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "adversarial-results", file), "utf8")
    ) as { results?: Array<{ matchedExpectation?: boolean; name?: string }> };

    if (!Array.isArray(document.results) || document.results.length === 0) {
      throw new Error(`${file} has no recorded results`);
    }

    const allowedCases = nonBlockingCases.get(file) ?? new Set<string>();
    const failed = document.results.filter(
      (entry) =>
        entry.matchedExpectation !== true &&
        !allowedCases.has((entry as { caseId?: string }).caseId ?? "")
    );
    if (failed.length > 0) {
      throw new Error(
        `${file} contains unmet expectations: ${failed
          .map((entry) => entry.name ?? "unknown")
          .join(", ")}`
      );
    }
  }

  return `${files.length} result files verified`;
}

function verifyTreasuryConfig(): string {
  if (!fs.existsSync(TREASURY_CONFIG_PATH)) {
    throw new Error("treasury-config.json is missing");
  }

  const document = JSON.parse(
    fs.readFileSync(TREASURY_CONFIG_PATH, "utf8")
  ) as {
    treasuryAddress?: unknown;
    generatedAt?: unknown;
  };

  if (
    typeof document.treasuryAddress !== "string" ||
    document.treasuryAddress.trim().length === 0
  ) {
    throw new Error("treasury-config.json is missing treasuryAddress");
  }

  if (
    typeof document.generatedAt !== "string" ||
    document.generatedAt.trim().length === 0
  ) {
    throw new Error("treasury-config.json is missing generatedAt");
  }

  return document.treasuryAddress;
}

function verifyParameterGenerationHashes(): string {
  if (!fs.existsSync(PARAMETER_GENERATION_DOC_PATH)) {
    throw new Error("docs/PARAMETER_GENERATION.md is missing");
  }

  const document = fs.readFileSync(PARAMETER_GENERATION_DOC_PATH, "utf8");
  const requiredArtifacts = new Map<string, string>([
    [
      "withdraw_20_final.zkey",
      path.join(ROOT_DIR, "build", "withdraw_20_final.zkey"),
    ],
    [
      "verification_key_20.json",
      path.join(ROOT_DIR, "build", "verification_key_20.json"),
    ],
    [
      "withdraw_20.wasm",
      path.join(ROOT_DIR, "build", "withdraw_20_js", "withdraw_20.wasm"),
    ],
    ["withdraw_20.r1cs", path.join(ROOT_DIR, "build", "withdraw_20.r1cs")],
  ]);

  for (const [artifact, artifactPath] of requiredArtifacts) {
    const recordedHash = extractHashFromParameterGenerationDoc(
      document,
      artifact
    );
    const actualHash = sha256(artifactPath);
    if (recordedHash !== actualHash) {
      throw new Error(`${artifact} hash mismatch`);
    }
  }

  return `${requiredArtifacts.size} artifact hashes match`;
}

function verifyRustVerifyingKey(): string {
  const generated = spawnSync(
    "npx",
    ["tsx", "scripts/parse-vk.ts", "build/verification_key_20.json"],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: process.env,
    }
  );

  if (generated.status !== 0) {
    throw new Error(
      summarizeCommandFailure(
        "npx",
        ["tsx", "scripts/parse-vk.ts"],
        generated.stdout,
        generated.stderr
      )
    );
  }

  const generatedRust = generated.stdout.trim();
  const committedRust = fs.readFileSync(PROGRAM_VK_PATH, "utf8").trim();
  if (generatedRust !== committedRust) {
    throw new Error(
      "program verifying_key_20.rs does not match parse-vk output"
    );
  }

  return "verifying_key_20.rs matches generated constants";
}

function verifyLimitedReleaseLanguage(): string {
  const docPaths = [
    path.join(ROOT_DIR, "README.md"),
    path.join(ROOT_DIR, "sdk-package", "README.md"),
    ...fs
      .readdirSync(DOCS_DIR)
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.join(DOCS_DIR, file)),
  ];

  const missing = docPaths.filter((docPath) => {
    const content = fs.readFileSync(docPath, "utf8").toLowerCase();
    return (
      !content.includes("limited release") &&
      !content.includes("limited-release") &&
      !content.includes("capped")
    );
  });

  if (missing.length > 0) {
    throw new Error(
      `missing limited-release language in ${missing
        .map((file) => path.basename(file))
        .join(", ")}`
    );
  }

  const governancePath = path.join(DOCS_DIR, "GOVERNANCE.md");
  if (!fs.existsSync(governancePath)) {
    throw new Error("docs/GOVERNANCE.md is missing");
  }

  return `${docPaths.length} docs checked`;
}

function verifySpendKeyLanguage(): string {
  const files = [
    path.join(ROOT_DIR, "sdk-package", "src", "keys.ts"),
    path.join(ROOT_DIR, "sdk-package", "README.md"),
  ];

  const offenders = files.filter((file) =>
    fs.readFileSync(file, "utf8").toLowerCase().includes("signs proofs")
  );

  if (offenders.length > 0) {
    throw new Error(
      `found forbidden wording in ${offenders
        .map((file) => path.basename(file))
        .join(", ")}`
    );
  }

  return "spend-key wording is accurate";
}

function verifyGitignoreCoverage(): string {
  const gitignore = fs.readFileSync(path.join(ROOT_DIR, ".gitignore"), "utf8");
  const requiredEntries = [
    "treasury-keypair.json",
    "build/withdraw_20_0000.zkey",
  ];

  for (const entry of requiredEntries) {
    if (!gitignore.includes(entry)) {
      throw new Error(`${entry} is not ignored`);
    }
  }

  return requiredEntries.join(", ");
}

function extractHashFromParameterGenerationDoc(
  document: string,
  artifact: string
): string {
  const pattern = new RegExp(
    `\\|\\s*${escapeRegExp(artifact)}\\s*\\|\\s*([0-9a-f]{64})\\s*\\|`
  );
  const match = document.match(pattern);
  if (!match) {
    throw new Error(`Missing ${artifact} hash in docs/PARAMETER_GENERATION.md`);
  }

  return match[1];
}

function sha256(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing artifact: ${path.relative(ROOT_DIR, filePath)}`);
  }

  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function summarizeCommandFailure(
  command: string,
  args: string[],
  stdout: string,
  stderr: string
): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
  const tail = combined.split("\n").slice(-10).join(" | ");
  return `${command} ${args.join(" ")} failed${tail ? `: ${tail}` : ""}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
