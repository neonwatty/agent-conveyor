import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_ROOT_DIR = ".codex-workers";
export const VALID_WORKER_STATES = new Set([
  "planning",
  "editing",
  "running_tests",
  "blocked",
  "waiting",
  "done",
  "unknown",
]);

export class WorkerctlStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerctlStateError";
  }
}

export function stateRoot(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = options.env ?? process.env;
  if (env.WORKERCTL_STATE_ROOT) {
    return env.WORKERCTL_STATE_ROOT;
  }
  return join(options.cwd ?? process.cwd(), STATE_ROOT_DIR);
}

export function validateWorkerName(name: string): void {
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new WorkerctlStateError("Worker names may contain only letters, numbers, hyphens, and underscores.");
  }
}

export function workerDir(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  validateWorkerName(name);
  return join(stateRoot(options), name);
}

export function configPath(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return join(workerDir(name, options), "config.json");
}

export function statusPath(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return join(workerDir(name, options), "status.json");
}

export function eventsPath(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return join(workerDir(name, options), "events.jsonl");
}

export function transcriptPath(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return join(workerDir(name, options), "transcript.txt");
}

export function captureMetaPath(name: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return join(workerDir(name, options), "capture-meta.json");
}

export function defaultDbPath(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return join(stateRoot(options), "workerctl.db");
}

export function loadJsonSync<T>(path: string, defaultValue: T): T {
  if (!existsSync(path)) {
    return defaultValue;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WorkerctlStateError(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

export function writeJsonSync(path: string, payload: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortJson(payload), null, 2)}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
