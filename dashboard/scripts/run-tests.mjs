import { spawnSync } from "node:child_process";

const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== "--runInBand");

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
