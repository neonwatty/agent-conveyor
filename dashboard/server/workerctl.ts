import { spawn } from "node:child_process";

export type DashboardCommand =
  | "audit"
  | "bind"
  | "cycle"
  | "create-task"
  | "discover"
  | "export"
  | "finish"
  | "interrupt"
  | "nudge"
  | "pair"
  | "replay"
  | "sessions"
  | "snapshot"
  | "start-manager"
  | "start-worker"
  | "telemetry"
  | "tasks";

export interface ServerOptions {
  dbPath?: string;
  host: string;
  port: number;
  task?: string;
  workerctlPath: string;
}

export interface PartialServerOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  task?: string;
  workerctlPath?: string;
}

export interface WorkerctlCommandOptions {
  askForApproval?: string;
  command: DashboardCommand;
  cwd?: string;
  dryRun?: boolean;
  followup?: string;
  includeAll?: boolean;
  includeContent?: boolean;
  includeFullTranscripts?: boolean;
  includeTranscripts?: boolean;
  key?: string;
  limit?: number;
  manager?: string;
  managerAcceptance?: string[];
  managerGuideline?: string[];
  managerMode?: "light" | "guided" | "strict";
  managerName?: string;
  managerObjective?: string;
  managerReference?: string[];
  outputDir?: string;
  telemetryActor?: "dispatch" | "manager" | "operator" | "system" | "worker" | "workerctl";
  telemetryEventType?: string;
  telemetryNewest?: boolean;
  requireCriteriaAudit?: boolean;
  replayFormat?: "compact" | "timeline" | "transcript" | "full-transcript";
  replayRole?: "all" | "worker" | "manager" | "reviewer" | "workerctl";
  sandbox?: string;
  session?: string;
  task?: string;
  taskGoal?: string;
  taskPrompt?: string;
  taskSummary?: string;
  text?: string;
  timeoutSeconds?: number;
  tsRuntime?: boolean;
  worker?: string;
  workerName?: string;
  workerctlPath: string;
  dbPath?: string;
  zip?: boolean;
}

export function normalizeServerOptions(options: PartialServerOptions): ServerOptions {
  return {
    dbPath: options.dbPath,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8797,
    task: options.task,
    workerctlPath: options.workerctlPath ?? "scripts/workerctl",
  };
}

export function buildWorkerctlArgs(options: WorkerctlCommandOptions): string[] {
  const args = [options.workerctlPath];
  if (options.tsRuntime) {
    if (!commandSupportsTypescriptRuntime(options.command)) {
      throw new Error(`${options.command} command does not support the TypeScript runtime yet.`);
    }
    args.push("--ts-runtime");
  }
  if (options.command === "snapshot") {
    if (!options.task) {
      throw new Error("Snapshot command requires a task.");
    }
    args.push("telemetry", "snapshot", "--task", options.task, "--json");
    if (options.limit) {
      args.push("--limit", String(options.limit));
    }
  } else if (options.command === "telemetry") {
    args.push("telemetry");
    if (options.task) {
      args.push("--task", options.task);
    }
    if (options.telemetryActor) {
      args.push("--actor", options.telemetryActor);
    }
    if (options.telemetryEventType) {
      args.push("--event-type", options.telemetryEventType);
    }
    if (options.limit) {
      args.push("--limit", String(options.limit));
    }
    if (options.telemetryNewest) {
      args.push("--newest");
    }
    args.push("--json");
  } else if (options.command === "audit") {
    if (!options.task) {
      throw new Error("Audit command requires a task.");
    }
    args.push("audit", options.task, "--json");
    if (options.includeContent) {
      args.push("--include-content");
    }
  } else if (options.command === "replay") {
    if (!options.task) {
      throw new Error("Replay command requires a task.");
    }
    args.push("replay", options.task, "--json");
    if (options.replayFormat) {
      args.push("--format", options.replayFormat);
    }
    if (options.replayRole) {
      args.push("--role", options.replayRole);
    }
    if (options.limit) {
      args.push("--limit", String(options.limit));
    }
    if (options.includeContent) {
      args.push("--include-content");
    }
  } else if (options.command === "sessions") {
    args.push("sessions");
  } else if (options.command === "tasks") {
    args.push("tasks", "--json");
  } else if (options.command === "discover") {
    args.push("discover");
    if (options.task) {
      args.push(options.task);
    }
    if (options.includeAll) {
      args.push("--all");
    }
    if (options.limit) {
      args.push("--limit", String(options.limit));
    }
  } else if (options.command === "create-task") {
    requireFields(options, ["task", "taskGoal"]);
    args.push("tasks", "--create", options.task!, "--goal", options.taskGoal!);
    if (options.taskSummary) {
      args.push("--summary", options.taskSummary);
    }
  } else if (options.command === "cycle") {
    if (!options.task) {
      throw new Error("Cycle command requires a task.");
    }
    args.push("cycle", options.task);
  } else if (options.command === "bind") {
    requireFields(options, ["task", "worker", "manager"]);
    args.push("bind", "--task", options.task!, "--worker", options.worker!, "--manager", options.manager!);
  } else if (options.command === "nudge") {
    requireFields(options, ["session", "text"]);
    args.push("session-nudge", options.session!, options.text!);
    if (options.dryRun) {
      args.push("--dry-run");
    }
  } else if (options.command === "interrupt") {
    requireFields(options, ["session"]);
    args.push("session-interrupt", options.session!, "--key", options.key ?? "C-c");
    if (options.followup) {
      args.push("--followup", options.followup);
    }
    if (options.dryRun) {
      args.push("--dry-run");
    }
  } else if (options.command === "finish") {
    requireFields(options, ["task"]);
    args.push("finish-task", options.task!);
    if (options.requireCriteriaAudit) {
      args.push("--require-criteria-audit");
    }
  } else if (options.command === "export") {
    requireFields(options, ["task"]);
    args.push("export-task", options.task!);
    if (options.outputDir) {
      args.push("--output", options.outputDir);
    }
    if (options.zip) {
      args.push("--zip");
    }
    if (options.includeTranscripts) {
      args.push("--include-transcripts");
    }
    if (options.includeFullTranscripts) {
      args.push("--include-full-transcripts");
    }
  } else if (options.command === "start-worker") {
    requireFields(options, ["workerName"]);
    args.push("start-worker", "--name", options.workerName!);
    appendCodexStartArgs(args, options);
    if (options.taskPrompt) {
      args.push("--task", options.taskPrompt);
    }
  } else if (options.command === "start-manager") {
    requireFields(options, ["managerName"]);
    args.push("start-manager", "--name", options.managerName!);
    appendCodexStartArgs(args, options);
  } else if (options.command === "pair") {
    requireFields(options, ["task", "workerName", "managerName"]);
    args.push("pair", "--task", options.task!, "--worker-name", options.workerName!, "--manager-name", options.managerName!);
    appendCodexStartArgs(args, options);
    if (options.taskPrompt) {
      args.push("--task-prompt", options.taskPrompt);
    }
    if (options.taskGoal) {
      args.push("--task-goal", options.taskGoal);
    }
    if (options.taskSummary) {
      args.push("--task-summary", options.taskSummary);
    }
    if (options.managerMode) {
      args.push("--manager-mode", options.managerMode);
    }
    if (options.managerObjective) {
      args.push("--manager-objective", options.managerObjective);
    }
    for (const guideline of options.managerGuideline ?? []) {
      args.push("--manager-guideline", guideline);
    }
    for (const acceptance of options.managerAcceptance ?? []) {
      args.push("--manager-acceptance", acceptance);
    }
    for (const reference of options.managerReference ?? []) {
      args.push("--manager-reference", reference);
    }
  }
  if (options.dbPath && commandSupportsPath(options.command)) {
    args.push("--path", options.dbPath);
  }
  return args;
}

function commandSupportsPath(command: DashboardCommand): boolean {
  return [
    "bind",
    "create-task",
    "cycle",
    "discover",
    "audit",
    "export",
    "finish",
    "interrupt",
    "nudge",
    "pair",
    "replay",
    "snapshot",
    "telemetry",
    "tasks",
  ].includes(command);
}

function commandSupportsTypescriptRuntime(command: DashboardCommand): boolean {
  return ["audit", "export", "replay"].includes(command);
}

function appendCodexStartArgs(args: string[], options: WorkerctlCommandOptions): void {
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  if (options.askForApproval) {
    args.push("--ask-for-approval", options.askForApproval);
  }
  if (options.timeoutSeconds) {
    args.push("--timeout-seconds", String(options.timeoutSeconds));
  }
}

function requireFields(options: WorkerctlCommandOptions, fields: Array<keyof WorkerctlCommandOptions>): void {
  for (const field of fields) {
    if (!options[field]) {
      throw new Error(`${options.command} command requires ${String(field)}.`);
    }
  }
}

export function buildPtyAttachArgs(options: { session: string }): string[] {
  if (!/^[A-Za-z0-9_.:@%+-]+$/.test(options.session)) {
    throw new Error(`Unsafe tmux session name: ${options.session}`);
  }
  return ["tmux", "attach", "-t", options.session];
}

export async function runWorkerctlJson(options: WorkerctlCommandOptions): Promise<unknown> {
  const [command, ...args] = buildWorkerctlArgs(options);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `workerctl exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export interface WorkerctlReceipt {
  command: string[];
  exitCode: number | null;
  json: unknown | null;
  stderr: string;
  stdout: string;
}

export async function runWorkerctlReceipt(options: WorkerctlCommandOptions): Promise<WorkerctlReceipt> {
  const [command, ...args] = buildWorkerctlArgs(options);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const trimmed = stdout.trim();
      let json: unknown | null = null;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = null;
        }
      }
      resolve({
        command: [command, ...args],
        exitCode,
        json,
        stderr,
        stdout,
      });
    });
  });
}
