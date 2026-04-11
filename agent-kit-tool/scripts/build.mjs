import fs from "fs";
import path from "path";
import ts from "typescript";

const PACKAGE_DIR = process.cwd();
const SRC_DIR = path.join(PACKAGE_DIR, "src");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");

const transpileOptions = {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    resolveJsonModule: true,
    strict: true,
  },
};

main();

function main() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const sourceFiles = walkTypescriptFiles(SRC_DIR);
  for (const sourcePath of sourceFiles) {
    const relativePath = path.relative(SRC_DIR, sourcePath);
    const outputBase = path.join(
      DIST_DIR,
      relativePath.replace(/\.ts$/, ""),
    );
    fs.mkdirSync(path.dirname(outputBase), { recursive: true });

    const source = fs.readFileSync(sourcePath, "utf8");
    const jsResult = ts.transpileModule(source, {
      ...transpileOptions,
      fileName: sourcePath,
    });
    writeOutput(`${outputBase}.js`, jsResult.outputText);

    const declarationResult = ts.transpileDeclaration(source, {
      compilerOptions: {
        ...transpileOptions.compilerOptions,
        declaration: true,
        emitDeclarationOnly: true,
      },
      fileName: sourcePath,
    });
    writeOutput(`${outputBase}.d.ts`, declarationResult.outputText);
  }
}

function walkTypescriptFiles(dirPath) {
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return walkTypescriptFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    })
    .sort();
}

function writeOutput(outputPath, content) {
  fs.writeFileSync(outputPath, content, "utf8");
}
