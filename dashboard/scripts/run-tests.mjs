import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["--test", "--import", "tsx", "dashboard/**/*.test.ts"],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
