import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const passthroughArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== "--runInBand")
  .map((arg) => {
    if (arg.startsWith("-")) {
      return arg;
    }
    try {
      if (statSync(arg).isDirectory()) {
        return `${arg.replace(/\/+$/, "")}/**/*.test.ts`;
      }
    } catch {
      // Leave non-filesystem arguments untouched for node --test.
    }
    return arg;
  });

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--import",
    "tsx",
    "dashboard/**/*.test.ts",
    "src/**/*.test.ts",
    ...passthroughArgs,
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
