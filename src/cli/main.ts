#!/usr/bin/env node
import {
  buildPythonEntrypoint,
  packageRootFromModuleUrl,
  programNameFromArgv,
  runPythonEntrypoint,
} from "./python-bridge.js";
import { runTypescriptRuntimeCommand } from "./typescript-runtime.js";

const args = process.argv.slice(2);
const typescriptRuntime = runTypescriptRuntimeCommand({
  args,
  cwd: process.cwd(),
  env: process.env,
});

if (typescriptRuntime.handled) {
  if (typescriptRuntime.stdout) {
    process.stdout.write(typescriptRuntime.stdout);
  }
  if (typescriptRuntime.stderr) {
    process.stderr.write(typescriptRuntime.stderr);
  }
  process.exitCode = typescriptRuntime.exitCode;
} else {
  const entrypoint = buildPythonEntrypoint({
    args,
    env: process.env,
    packageRoot: packageRootFromModuleUrl(import.meta.url),
    program: programNameFromArgv(process.argv, process.env),
  });

  process.exitCode = runPythonEntrypoint(entrypoint);
}
