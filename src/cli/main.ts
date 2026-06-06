#!/usr/bin/env node
import { programNameFromArgv } from "./program-name.js";
import { runTypescriptRuntimeCommand } from "./typescript-runtime.js";

const args = process.argv.slice(2);
const program = programNameFromArgv(process.argv, process.env);
const typescriptRuntime = runTypescriptRuntimeCommand({
  args,
  cwd: process.cwd(),
  env: process.env,
  program,
});

if (typescriptRuntime.stdout) {
  process.stdout.write(typescriptRuntime.stdout);
}
if (typescriptRuntime.stderr) {
  process.stderr.write(typescriptRuntime.stderr);
}
process.exitCode = typescriptRuntime.exitCode;
