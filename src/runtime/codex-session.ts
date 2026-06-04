import { readFileSync } from "node:fs";

class CodexSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSessionError";
  }
}

export interface CodexSessionMeta {
  cli_version?: string;
  cwd?: string;
  id: string;
  originator?: string;
}

export interface CodexSessionDiscovery {
  cli_version: string;
  codex_session_id: string;
  codex_session_path: string;
  cwd: string;
  native_pid: number;
  originator: string;
  pid: number;
}

export function readSessionMeta(path: string): CodexSessionMeta {
  let firstLine: string;
  try {
    [firstLine = ""] = readFileSync(path, "utf8").split(/\r?\n/, 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexSessionError(`rollout file not found: ${path}`);
    }
    throw error;
  }
  if (!firstLine) {
    throw new CodexSessionError(`rollout file is empty: ${path}`);
  }

  let record: unknown;
  try {
    record = JSON.parse(firstLine);
  } catch {
    throw new CodexSessionError(`rollout file first line is not JSON: ${path}`);
  }
  if (!isRecord(record) || record.type !== "session_meta") {
    throw new CodexSessionError(`rollout file first record is not session_meta: ${path}`);
  }
  if (!isRecord(record.payload)) {
    throw new CodexSessionError(`rollout session_meta payload is not an object: ${path}`);
  }
  if (typeof record.payload.id !== "string") {
    throw new CodexSessionError(`rollout session_meta payload is missing id: ${path}`);
  }
  return record.payload as unknown as CodexSessionMeta;
}

export function findNativeCodexPid(pid: number, children: number[]): number {
  return children[0] ?? pid;
}

export function findRolloutPathInLsof(output: string, pid: number): string {
  for (const line of output.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || !stripped.endsWith(".jsonl")) {
      continue;
    }
    const parts = stripped.split(/\s+/);
    const path = parts.at(-1) ?? "";
    if (path.includes("/sessions/") && path.includes("/rollout-") && path.endsWith(".jsonl")) {
      return path;
    }
  }
  throw new CodexSessionError(`no rollout-*.jsonl file open for pid ${pid}`);
}

export function findRolloutPathForPid(pid: number, lsofForPid: (pid: number) => string): string {
  return findRolloutPathInLsof(lsofForPid(pid), pid);
}

export function discoverSession(options: {
  childrenForPid: (pid: number) => number[];
  lsofForPid: (pid: number) => string;
  pid: number;
}): CodexSessionDiscovery {
  const nativePid = findNativeCodexPid(options.pid, options.childrenForPid(options.pid));
  const rolloutPath = findRolloutPathForPid(nativePid, options.lsofForPid);
  const meta = readSessionMeta(rolloutPath);
  return {
    cli_version: meta.cli_version ?? "",
    codex_session_id: meta.id,
    codex_session_path: rolloutPath,
    cwd: meta.cwd ?? "",
    native_pid: nativePid,
    originator: meta.originator ?? "",
    pid: options.pid,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
