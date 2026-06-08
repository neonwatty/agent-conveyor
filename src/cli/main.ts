#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { programNameFromArgv } from "./program-name.js";
import { runTypescriptRuntimeCommand } from "./typescript-runtime.js";

const args = process.argv.slice(2);
const program = programNameFromArgv(process.argv, process.env);
const stdin = args.includes("--from-stdin") ? readFileSync(0, "utf8") : undefined;
const typescriptRuntime = runTypescriptRuntimeCommand({
  args,
  cwd: process.cwd(),
  env: process.env,
  program,
  stdin,
});

if (typescriptRuntime.stdout) {
  process.stdout.write(typescriptRuntime.stdout);
}
if (typescriptRuntime.stderr) {
  process.stderr.write(typescriptRuntime.stderr);
}
process.exitCode = typescriptRuntime.exitCode;
