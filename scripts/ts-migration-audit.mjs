#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const packJsonArg = process.argv.find((arg) => arg.startsWith("--pack-json="));
const requireZeroPython = args.has("--require-zero-python");

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

function archivedPythonParserCommands() {
  return JSON.parse(readText("docs/archive/python-runtime/cli-command-inventory.json")).sort();
}

function defaultTypescriptRuntimeCommands() {
  const text = readText("src/cli/typescript-runtime.ts");
  const start = text.indexOf("function isDefaultRuntimeCommand");
  const end = text.indexOf("\n}\n\nfunction valueAfter", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate isDefaultRuntimeCommand");
  }
  return [...text.slice(start, end).matchAll(/command === "([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
}

function packageInventory() {
  if (packJsonArg) {
    return JSON.parse(readFileSync(resolve(packJsonArg.slice("--pack-json=".length)), "utf8"))[0];
  }
  const result = spawnSync("npm", ["pack", "--json", "--silent", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout)[0];
}

const parserOnlyCommands = new Set(["add", "adversarial-check", "visual-diff"]);
const pythonCommands = archivedPythonParserCommands();
const tsCommands = defaultTypescriptRuntimeCommands();
const missingFromDefault = pythonCommands.filter((command) => !tsCommands.includes(command));
const unexpectedMissing = missingFromDefault.filter((command) => !parserOnlyCommands.has(command));
const extraDefaultCommands = tsCommands.filter((command) => !pythonCommands.includes(command));
const pack = packageInventory();
const packedPaths = pack.files.map((file) => file.path).sort();
const packedPythonRuntimeFiles = packedPaths.filter((path) => /^workerctl\/.*\.py$/.test(path));
const packedPythonBridgeFiles = packedPaths.filter((path) => /^dist\/cli\/python-bridge\.(?:js|d\.ts|js\.map)$/.test(path));
const packedPythonEntrypoints = packedPaths.filter((path) => path === "scripts/workerctl");
const manifest = JSON.parse(readText("package.json"));
const cliExport = manifest.exports?.["./cli"] ?? null;
const cliExportUsesPythonBridge = JSON.stringify(cliExport).includes("python-bridge");
const normalSourcePythonBridgeRefs = [
  "src/cli/main.ts",
  "src/index.ts",
  "package.json",
].filter((path) => {
  const text = readText(path);
  return text.includes("python-bridge") || text.includes("runPythonEntrypoint");
});

const fullOutcomeComplete = (
  unexpectedMissing.length === 0
  && packedPythonRuntimeFiles.length === 0
  && packedPythonBridgeFiles.length === 0
  && packedPythonEntrypoints.length === 0
  && !cliExportUsesPythonBridge
  && normalSourcePythonBridgeRefs.length === 0
);

const receipt = {
  command_inventory: {
    python_argparse_count: pythonCommands.length,
    default_typescript_count: tsCommands.length,
    missing_from_default: missingFromDefault,
    parser_only_missing: missingFromDefault.filter((command) => parserOnlyCommands.has(command)),
    unexpected_missing: unexpectedMissing,
    extra_default_commands: extraDefaultCommands,
  },
  package_inventory: {
    packed_python_runtime_file_count: packedPythonRuntimeFiles.length,
    packed_python_bridge_files: packedPythonBridgeFiles,
    packed_python_entrypoints: packedPythonEntrypoints,
    cli_export_uses_python_bridge: cliExportUsesPythonBridge,
    normal_source_python_bridge_refs: normalSourcePythonBridgeRefs,
  },
  full_outcome_complete: fullOutcomeComplete,
  require_zero_python: requireZeroPython,
};

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

if (unexpectedMissing.length > 0) {
  console.error(`Unexpected Python parser commands missing from default TS runtime: ${unexpectedMissing.join(", ")}`);
  process.exit(1);
}

if (requireZeroPython && !fullOutcomeComplete) {
  console.error("TypeScript migration final audit failed: Python runtime or bridge remains in normal package operation.");
  process.exit(1);
}
