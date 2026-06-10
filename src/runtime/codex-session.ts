import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

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
  timestamp?: string;
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

export interface RegisteredSessionRecord {
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  codex_session_id: string | null;
  codex_session_path: string | null;
  communication: SessionCommunication;
  cwd: string;
  id: string;
  identity_token: string;
  last_heartbeat_at: string | null;
  last_ingest_offset?: number | null;
  name: string;
  pid: number | null;
  registered_at: string;
  role: "manager" | "worker";
  state: "active" | "gone";
  tmux_pane_id: string | null;
  tmux_session: string | null;
}

interface SessionCommunication {
  can_receive_pull: boolean;
  can_receive_push: boolean;
  delivery_mode: "pull_required" | "push";
  detection_source: "codex_session_without_tmux" | "missing_tmux_session" | "tmux_session";
  poll_command?: string | null;
  poll_command_template: string | null;
  receive_style: "pull" | "push";
  requires_polling: boolean;
  session_kind: "codex_app" | "no_tmux" | "tmux";
  tmux_session: string | null;
}

export interface RegisterSessionResult {
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  codex_session_id: string;
  codex_session_path: string;
  communication: SessionCommunication;
  cwd: string;
  name: string;
  pid: number;
  role: "manager" | "worker";
  session_id: string;
  tmux_session: string | null;
}

export interface DiscoverResult {
  bindings: Array<Record<string, unknown>>;
  query: string;
  sessions: RegisteredSessionRecord[];
  suggestions: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  telemetry: Array<Record<string, unknown>>;
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

export function registerSessionSync(
  database: DatabaseSync,
  options: {
    codexAppThreadId?: string | null;
    codexAppThreadTitle?: string | null;
    codexSessionPath: string;
    cwd?: string | null;
    name: string;
    now?: string;
    pid: number;
    role: "manager" | "worker";
    tmuxSession?: string | null;
  },
): RegisterSessionResult {
  const meta = readSessionMeta(options.codexSessionPath);
  const cwd = options.cwd || meta.cwd || "";
  const timestamp = options.now ?? new Date().toISOString();
  const existing = database.prepare(`
    select id, role, identity_token
    from sessions
    where name = ?
  `).get(options.name) as { id: string; identity_token: string; role: string } | undefined;
  if (existing && existing.role !== options.role) {
    throw new CodexSessionError(
      `session name ${JSON.stringify(options.name)} already exists with role ${JSON.stringify(existing.role)}; `
      + `refusing to re-register as ${JSON.stringify(options.role)}`,
    );
  }
  const sessionId = existing?.id ?? `session-${randomUUID()}`;
  const identityToken = existing?.identity_token ?? `session-token-${randomUUID()}`;
  database.prepare(`
    insert into sessions(
      id, name, role, identity_token,
      tmux_session, tmux_pane_id,
      codex_session_path, codex_session_id, pid,
      codex_app_thread_id, codex_app_thread_title,
      cwd, registered_at, last_heartbeat_at, state
    )
    values (?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    on conflict(name) do update set
      tmux_session = excluded.tmux_session,
      tmux_pane_id = coalesce(excluded.tmux_pane_id, sessions.tmux_pane_id),
      codex_session_path = excluded.codex_session_path,
      codex_session_id = excluded.codex_session_id,
      codex_app_thread_id = excluded.codex_app_thread_id,
      codex_app_thread_title = excluded.codex_app_thread_title,
      pid = excluded.pid,
      cwd = excluded.cwd,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_ingest_offset = null,
      state = 'active'
  `).run(
    sessionId,
    options.name,
    options.role,
    identityToken,
    options.tmuxSession ?? null,
    options.codexSessionPath,
    meta.id,
    options.pid,
    options.codexAppThreadId ?? null,
    options.codexAppThreadTitle ?? null,
    cwd,
    timestamp,
    timestamp,
  );
  const session = sessionRow(database, options.name, options.role);
  return {
    codex_app_thread_id: session.codex_app_thread_id,
    codex_app_thread_title: session.codex_app_thread_title,
    codex_session_id: meta.id,
    codex_session_path: options.codexSessionPath,
    communication: sessionCommunication(session),
    cwd,
    name: options.name,
    pid: options.pid,
    role: options.role,
    session_id: sessionId,
    tmux_session: session.tmux_session,
  };
}

export function deregisterSessionSync(database: DatabaseSync, options: { name: string; now?: string }): void {
  const timestamp = options.now ?? new Date().toISOString();
  const existing = database.prepare("select id from sessions where name = ?")
    .get(options.name) as { id: string } | undefined;
  if (!existing) {
    throw new CodexSessionError(`no session registered with name ${JSON.stringify(options.name)}`);
  }
  const activeBinding = database.prepare(`
    select id, task_id
    from bindings
    where state in ('active', 'ending')
      and (worker_session_id = ? or manager_session_id = ?)
    limit 1
  `).get(existing.id, existing.id) as { id: string; task_id: string } | undefined;
  if (activeBinding) {
    throw new CodexSessionError(
      `cannot deregister session ${JSON.stringify(options.name)}: it is still bound to task `
      + `${JSON.stringify(activeBinding.task_id)} (binding ${JSON.stringify(activeBinding.id)}). Unbind the task first.`,
    );
  }
  database.prepare("update sessions set state = 'gone', last_heartbeat_at = ? where name = ?")
    .run(timestamp, options.name);
}

export function listRegisteredSessionsSync(
  database: DatabaseSync,
  options?: {
    dbPath?: string | null;
    includeLegacy?: boolean;
    names?: string[];
    redactIdentityToken?: boolean;
    role?: "manager" | "worker" | null;
    state?: "active" | "all" | "gone" | null;
  },
): RegisteredSessionRecord[] {
  const rows = listSessionRows(database, {
    includeLegacy: options?.includeLegacy,
    role: options?.role,
    state: options?.state,
  });
  const names = new Set(options?.names ?? []);
  return rows
    .filter((session) => names.size === 0 || names.has(session.name))
    .map((session) => {
      const record = {
        ...session,
        communication: sessionCommunication(session, { dbPath: options?.dbPath }),
      };
      if (options?.redactIdentityToken && record.identity_token !== null) {
        return { ...record, identity_token: "[REDACTED]" };
      }
      return record;
    });
}

export function discoverRegistrySync(
  database: DatabaseSync,
  options?: { all?: boolean; dbPath?: string | null; limit?: number; query?: string },
): DiscoverResult {
  const query = (options?.query ?? "").trim();
  const limit = options?.limit ?? 10;
  const tasks = listDiscoverTasks(database, { activeOnly: !(options?.all ?? false) });
  const sessions = listRegisteredSessionsSync(database, {
    dbPath: options?.dbPath,
    state: options?.all ? "all" : "active",
  });
  const bindings = activeBindings(database);
  const telemetry = query ? queryTelemetryEvents(database, { limit, search: query }) : [];
  const matchedTasks = tasks
    .filter((task) => rowMatchesQuery(task, query, ["name", "goal", "summary", "state"]))
    .slice(0, limit);
  const matchedSessions = sessions
    .filter((session) => rowMatchesQuery(session as unknown as Record<string, unknown>, query, ["name", "role", "state", "cwd", "tmux_session", "codex_session_id"]))
    .slice(0, limit);
  const matchedBindings = bindings
    .filter((binding) => rowMatchesQuery(binding, query, ["task_name", "task_goal", "worker_name", "manager_name", "state"]))
    .slice(0, limit);
  return {
    bindings: matchedBindings,
    query,
    sessions: matchedSessions,
    suggestions: discoverSuggestions(matchedTasks, matchedSessions, matchedBindings),
    tasks: matchedTasks,
    telemetry: telemetry.slice(0, limit),
  };
}

export function sessionRow(
  database: DatabaseSync,
  name: string,
  role?: "manager" | "worker" | null,
): Omit<RegisteredSessionRecord, "communication"> {
  const row = database.prepare("select * from sessions where name = ?").get(name) as SessionRow | undefined;
  if (!row) {
    throw new CodexSessionError(`no session registered with name ${JSON.stringify(name)}`);
  }
  if (role && row.role !== role) {
    throw new CodexSessionError(`session ${JSON.stringify(name)} has role ${JSON.stringify(row.role)}, expected ${JSON.stringify(role)}`);
  }
  return sessionRecord(row);
}

function listSessionRows(
  database: DatabaseSync,
  options?: {
    includeLegacy?: boolean;
    role?: "manager" | "worker" | null;
    state?: "active" | "all" | "gone" | null;
  },
): Array<Omit<RegisteredSessionRecord, "communication">> {
  const state = options?.state ?? null;
  if (state !== null && state !== "active" && state !== "gone" && state !== "all") {
    throw new CodexSessionError(`invalid state filter: ${JSON.stringify(state)}`);
  }
  const clauses: string[] = [];
  const params: string[] = [];
  if (options?.role) {
    clauses.push("role = ?");
    params.push(options.role);
  }
  if (state === "gone") {
    clauses.push("state = 'gone'");
  } else if (state !== "all") {
    clauses.push("state != 'gone'");
  }
  if (state === null && !options?.includeLegacy) {
    clauses.push("pid is not null");
  } else if (state === "active") {
    clauses.push("pid is not null");
  }
  const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
  const rows = database.prepare(`select * from sessions${where} order by registered_at`).all(...params) as unknown as SessionRow[];
  return rows.map(sessionRecord);
}

function sessionCommunication(
  session: { codex_session_id: string | null; codex_session_path: string | null; role: string; tmux_session: string | null },
  options?: { dbPath?: string | null; taskName?: string | null },
): SessionCommunication {
  const hasTmux = Boolean(session.tmux_session);
  const hasCodexIdentity = Boolean(session.codex_session_path || session.codex_session_id);
  const pollCommand = sessionPollCommand(session.role, { dbPath: options?.dbPath, taskName: options?.taskName });
  return {
    can_receive_pull: pollCommand !== null,
    can_receive_push: hasTmux,
    delivery_mode: hasTmux ? "push" : "pull_required",
    detection_source: hasTmux ? "tmux_session" : hasCodexIdentity ? "codex_session_without_tmux" : "missing_tmux_session",
    ...(options?.taskName !== undefined ? { poll_command: pollCommand } : {}),
    poll_command_template: sessionPollCommand(session.role, { dbPath: options?.dbPath }),
    receive_style: hasTmux ? "push" : "pull",
    requires_polling: !hasTmux,
    session_kind: hasTmux ? "tmux" : hasCodexIdentity ? "codex_app" : "no_tmux",
    tmux_session: session.tmux_session,
  };
}

function sessionPollCommand(
  role: string | null,
  options?: { dbPath?: string | null; taskName?: string | null },
): string | null {
  if (role === "worker") {
    return `${conveyorPollInvocation()} worker-inbox ${pollTaskArg(options?.taskName)} --consume-next --wait --timeout 60${pollPathSuffix(options?.dbPath)} --json`;
  }
  if (role === "manager") {
    return `${conveyorPollInvocation()} manager-inbox ${pollTaskArg(options?.taskName)} --consume-next --wait --timeout 60${pollPathSuffix(options?.dbPath)} --json`;
  }
  return null;
}

function conveyorPollInvocation(): string {
  const binDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "bin");
  return pathIsExecutable(join(binDir, "conveyor")) ? `PATH=${shellQuote(binDir)}:$PATH conveyor` : "conveyor";
}

function pathIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pollTaskArg(taskName?: string | null): string {
  return taskName ? shellQuote(taskName) : "<task>";
}

function pollPathSuffix(dbPath?: string | null): string {
  return dbPath ? ` --path ${shellQuote(dbPath)}` : "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

interface SessionRow {
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  codex_session_id: string | null;
  codex_session_path: string | null;
  cwd: string;
  id: string;
  identity_token: string;
  last_heartbeat_at: string | null;
  last_ingest_offset?: number | null;
  name: string;
  pid: number | null;
  registered_at: string;
  role: "manager" | "worker";
  state: "active" | "gone";
  tmux_pane_id: string | null;
  tmux_session: string | null;
}

function sessionRecord(row: SessionRow): Omit<RegisteredSessionRecord, "communication"> {
  return {
    codex_app_thread_id: row.codex_app_thread_id,
    codex_app_thread_title: row.codex_app_thread_title,
    codex_session_id: row.codex_session_id,
    codex_session_path: row.codex_session_path,
    cwd: row.cwd,
    id: row.id,
    identity_token: row.identity_token,
    last_heartbeat_at: row.last_heartbeat_at,
    ...(Object.hasOwn(row, "last_ingest_offset") ? { last_ingest_offset: row.last_ingest_offset ?? null } : {}),
    name: row.name,
    pid: row.pid,
    registered_at: row.registered_at,
    role: row.role,
    state: row.state,
    tmux_pane_id: row.tmux_pane_id,
    tmux_session: row.tmux_session,
  };
}

function listDiscoverTasks(database: DatabaseSync, options?: { activeOnly?: boolean }): Array<Record<string, unknown>> {
  const where = options?.activeOnly ? "where tasks.state in ('candidate', 'managed', 'paused')" : "";
  const rows = database.prepare(`
    select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
           tasks.created_at, tasks.updated_at,
           budgets.max_nudges, budgets.nudges_used, budgets.expires_at
    from tasks
    left join budgets on budgets.task_id = tasks.id
    ${where}
    order by tasks.created_at, tasks.id
  `).all() as Array<{
    created_at: string;
    expires_at: string | null;
    goal: string;
    id: string;
    max_nudges: number | null;
    name: string;
    nudges_used: number | null;
    state: string;
    summary: string | null;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    budget: row.max_nudges === null ? null : {
      expires_at: row.expires_at,
      max_nudges: row.max_nudges,
      nudges_remaining: row.max_nudges - (row.nudges_used ?? 0),
      nudges_used: row.nudges_used,
    },
    created_at: row.created_at,
    goal: row.goal,
    id: row.id,
    name: row.name,
    state: row.state,
    summary: row.summary,
    updated_at: row.updated_at,
  }));
}

function activeBindings(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare(`
    select bindings.id, bindings.state, bindings.created_at,
           tasks.name as task_name, tasks.goal as task_goal,
           ws.name as worker_name, ws.state as worker_state, ws.tmux_session as worker_tmux_session,
           ms.name as manager_name, ms.state as manager_state, ms.tmux_session as manager_tmux_session
    from bindings
    join tasks on tasks.id = bindings.task_id
    left join sessions ws on ws.id = bindings.worker_session_id
    left join sessions ms on ms.id = bindings.manager_session_id
    where bindings.state in ('active', 'ending')
    order by bindings.created_at desc
  `).all() as Array<Record<string, unknown>>;
}

function discoverSuggestions(
  tasks: Array<Record<string, unknown>>,
  sessions: RegisteredSessionRecord[],
  bindings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const suggestions: Array<Record<string, unknown>> = [];
  const activeBoundTasks = new Set(bindings.map((binding) => binding.task_name).filter(Boolean));
  const workers = sessions.filter((session) => session.role === "worker" && session.state === "active");
  const managers = sessions.filter((session) => session.role === "manager" && session.state === "active");
  for (const task of tasks) {
    if (!["candidate", "managed", "paused"].includes(String(task.state))) {
      continue;
    }
    if (activeBoundTasks.has(task.name)) {
      continue;
    }
    if (workers.length > 0 && managers.length > 0) {
      suggestions.push({
        command: `conveyor bind --task ${shellQuote(String(task.name))} --worker ${shellQuote(workers[0].name)} --manager ${shellQuote(managers[0].name)}`,
        kind: "bind",
        manager: managers[0].name,
        task: task.name,
        worker: workers[0].name,
      });
      break;
    }
  }
  if (workers.length === 0) {
    suggestions.push({
      kind: "register-worker",
      prompt: "Open the intended worker Codex session and ask it to use the manage-codex-workers skill to register as the worker for this dashboard setup.",
    });
  }
  if (managers.length === 0) {
    suggestions.push({
      kind: "register-manager",
      prompt: "Open the intended manager Codex session and ask it to use the manage-codex-workers skill to register as the manager for this dashboard setup.",
    });
  }
  return suggestions;
}

function queryTelemetryEvents(
  database: DatabaseSync,
  options: { limit: number; search: string },
): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    select te.id, te.run_id, te.task_id, te.timestamp, te.actor,
           te.event_type, te.severity, te.summary,
           te.correlation_json, te.attributes_json
    from telemetry_events te
    where (
      te.id in (
        select event_id
        from telemetry_events_fts
        where telemetry_events_fts match ?
      )
      or te.event_type = ?
    )
    order by te.timestamp asc, te.rowid asc
    limit ?
  `).all(telemetryFtsQuery(options.search), options.search, options.limit) as Array<{
    actor: string;
    attributes_json: string;
    correlation_json: string;
    event_type: string;
    id: number;
    run_id: string | null;
    severity: string;
    summary: string;
    task_id: string | null;
    timestamp: string;
  }>;
  return rows.map((row) => ({
    actor: row.actor,
    attributes: JSON.parse(row.attributes_json),
    correlation: JSON.parse(row.correlation_json),
    event_type: row.event_type,
    id: row.id,
    run_id: row.run_id,
    severity: row.severity,
    summary: row.summary,
    task_id: row.task_id,
    timestamp: row.timestamp,
  }));
}

function telemetryFtsQuery(search: string): string {
  return search.split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" ");
}

function rowMatchesQuery(row: Record<string, unknown>, query: string, fields: string[]): boolean {
  return fields.some((field) => matchesQuery(row[field], query));
}

function matchesQuery(value: unknown, query: string): boolean {
  if (!query) {
    return true;
  }
  if (value === null || value === undefined) {
    return false;
  }
  const haystack = typeof value === "object" ? JSON.stringify(value, Object.keys(value).sort()) : String(value);
  return haystack.toLowerCase().includes(query.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
