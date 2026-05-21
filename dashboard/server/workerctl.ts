import { spawn } from "node:child_process";

export type DashboardCommand =
  | "bind"
  | "cycle"
  | "export"
  | "finish"
  | "interrupt"
  | "nudge"
  | "sessions"
  | "snapshot"
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
  command: DashboardCommand;
  dryRun?: boolean;
  followup?: string;
  key?: string;
  manager?: string;
  requireCriteriaAudit?: boolean;
  session?: string;
  task?: string;
  text?: string;
  worker?: string;
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
  if (options.command === "snapshot") {
    if (!options.task) {
      throw new Error("Snapshot command requires a task.");
    }
    args.push("telemetry", "snapshot", "--task", options.task, "--json");
  } else if (options.command === "sessions") {
    args.push("sessions");
  } else if (options.command === "tasks") {
    args.push("tasks", "--json");
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
    if (options.zip) {
      args.push("--zip");
    }
  }
  if (options.dbPath && commandSupportsPath(options.command)) {
    args.push("--path", options.dbPath);
  }
  return args;
}

function commandSupportsPath(command: DashboardCommand): boolean {
  return ["bind", "cycle", "export", "finish", "interrupt", "nudge", "sessions", "snapshot", "tasks"].includes(command);
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
