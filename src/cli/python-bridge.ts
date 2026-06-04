import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

export type CliProgram = "conveyor" | "workerctl";

export interface PythonEntrypoint {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
}

export function programNameFromArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): CliProgram {
  const override = env.CONVEYOR_CLI_PROG;
  if (override === "conveyor" || override === "workerctl") {
    return override;
  }

  const invokedAs = basename(argv[1] ?? "");
  if (invokedAs === "workerctl") {
    return "workerctl";
  }
  return "conveyor";
}

export function packageRootFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}

export function buildPythonEntrypoint(options: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  program: CliProgram;
}): PythonEntrypoint {
  return {
    args: [...options.args],
    command: join(options.packageRoot, "scripts", "workerctl"),
    env: options.program === "conveyor"
      ? { ...options.env, CONVEYOR_CLI_PROG: "conveyor" }
      : { ...options.env },
  };
}

export function runPythonEntrypoint(entrypoint: PythonEntrypoint): number {
  const result = spawnSync(entrypoint.command, entrypoint.args, {
    env: entrypoint.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    return 127;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return result.signal ? 1 : 0;
}
