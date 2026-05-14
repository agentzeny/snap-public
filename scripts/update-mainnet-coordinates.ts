import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const DEPLOYMENT_PATH = path.join(ROOT_DIR, "mainnet-deployment.json");

interface Deployment {
  programId: string;
  network: string;
}

const FILES_TO_UPDATE: Array<{
  relative: string;
  description: string;
}> = [
  {
    relative: "programs/agent-privacy-pool/src/lib.rs",
    description: "Anchor declare_id!",
  },
  { relative: "Anchor.toml", description: "Anchor config" },
  { relative: "sdk-package/src/constants.ts", description: "SDK constant" },
  { relative: "sdk-package/src/idl.json", description: "IDL metadata" },
  { relative: "README.md", description: "Root README" },
  { relative: "sdk-package/README.md", description: "SDK README" },
  { relative: "scripts/health-check.ts", description: "Health check script" },
  { relative: "scripts/test-harness.ts", description: "Test harness" },
  {
    relative: "scripts/devnet-phase14a-validation.ts",
    description: "Phase 14a validation",
  },
  {
    relative: "ops/FUNDED_DEVNET_CANARY.md",
    description: "Devnet canary doc",
  },
];

function fail(message: string): never {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function main(): void {
  console.log("=== SNAP Mainnet Coordinate Update ===");
  console.log("");

  if (!existsSync(DEPLOYMENT_PATH)) {
    fail(
      "mainnet-deployment.json not found. Run mainnet-deploy.ts first."
    );
  }

  const deployment: Deployment = JSON.parse(
    readFileSync(DEPLOYMENT_PATH, "utf8")
  );

  if (
    !deployment.programId ||
    deployment.programId.length < 32 ||
    deployment.programId.length > 44
  ) {
    fail(`Invalid program ID in deployment file: ${deployment.programId}`);
  }

  const oldProgramId = "AB4LhsmXkPQE97mHX2eLuX9AR43yzjWoNjCB6Bevi7M3";
  const newProgramId = deployment.programId;

  if (oldProgramId === newProgramId) {
    console.log(
      "Program ID is unchanged from devnet. No coordinate update needed."
    );
    console.log("Adding [programs.mainnet-beta] section to Anchor.toml...");

    const anchorTomlPath = path.join(ROOT_DIR, "Anchor.toml");
    let anchorToml = readFileSync(anchorTomlPath, "utf8");
    if (!anchorToml.includes("[programs.mainnet-beta]")) {
      anchorToml += `\n[programs.mainnet-beta]\nagent_privacy_pool = "${newProgramId}"\n`;
      writeFileSync(anchorTomlPath, anchorToml);
      console.log("[OK] Anchor.toml — added mainnet-beta section");
    } else {
      console.log("[OK] Anchor.toml — mainnet-beta section already exists");
    }

    console.log("");
    console.log("Done. Rebuild with: anchor build && cd sdk-package && npm run build");
    return;
  }

  console.log(`Old program ID: ${oldProgramId}`);
  console.log(`New program ID: ${newProgramId}`);
  console.log("");

  let updated = 0;
  let skipped = 0;

  for (const file of FILES_TO_UPDATE) {
    const filePath = path.join(ROOT_DIR, file.relative);

    if (!existsSync(filePath)) {
      console.log(`[SKIP] ${file.relative} — file not found`);
      skipped++;
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    if (!content.includes(oldProgramId)) {
      console.log(`[SKIP] ${file.relative} — old ID not found`);
      skipped++;
      continue;
    }

    const newContent = content.replaceAll(oldProgramId, newProgramId);
    writeFileSync(filePath, newContent);
    const count = (content.match(new RegExp(oldProgramId, "g")) ?? []).length;
    console.log(
      `[OK]   ${file.relative} — ${count} replacement${count > 1 ? "s" : ""} (${file.description})`
    );
    updated++;
  }

  const anchorTomlPath = path.join(ROOT_DIR, "Anchor.toml");
  let anchorToml = readFileSync(anchorTomlPath, "utf8");
  if (!anchorToml.includes("[programs.mainnet-beta]")) {
    anchorToml += `\n[programs.mainnet-beta]\nagent_privacy_pool = "${newProgramId}"\n`;
    writeFileSync(anchorTomlPath, anchorToml);
    console.log("[OK]   Anchor.toml — added mainnet-beta section");
  }

  console.log("");
  console.log(`Updated ${updated} files, skipped ${skipped}.`);
  console.log("");
  console.log("IMPORTANT: Rebuild after updating coordinates:");
  console.log("  anchor build");
  console.log("  cd sdk-package && npm run build && cd ..");
  console.log("");
  console.log("Then proceed to: npx tsx scripts/create-mainnet-pools.ts");
}

main();
