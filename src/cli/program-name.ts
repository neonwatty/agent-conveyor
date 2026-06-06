export type CliProgram = "conveyor" | "workerctl";

export function programNameFromArgv(
  argv: readonly string[],
  env: Partial<Pick<NodeJS.ProcessEnv, "CONVEYOR_CLI_PROG">> = {},
): CliProgram {
  const override = env.CONVEYOR_CLI_PROG;
  if (override === "conveyor" || override === "workerctl") {
    return override;
  }
  const invokedAs = argv[1]?.split(/[\\/]/).at(-1);
  if (invokedAs === "workerctl") {
    return "workerctl";
  }
  return "conveyor";
}
