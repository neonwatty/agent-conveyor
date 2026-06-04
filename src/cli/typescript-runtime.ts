import { join, resolve } from "node:path";

import { taskAuditSync } from "../runtime/audit.js";
import { exportTaskAuditSubsetSync } from "../runtime/export.js";
import {
  renderReplayText,
  replayResultFromAudit,
  type ReplayMode,
  type ReplayRole,
} from "../runtime/replay.js";
import {
  activeBindingForTaskSync,
  bindSessionsSync,
  createTaskSync,
  listTasksSync,
  unbindTaskSync,
  type TaskRecord,
} from "../runtime/tasks.js";
import { defaultDbPath, stateRoot } from "../state/files.js";
import {
  initializeDatabaseSync,
  openDatabaseSync,
} from "../state/database.js";

export interface TypescriptRuntimeResult {
  exitCode: number;
  handled: boolean;
  stderr?: string;
  stdout?: string;
}

export function runTypescriptRuntimeCommand(options: {
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): TypescriptRuntimeResult {
  const parsed = parseRuntimeArgs(options.args, options.env ?? process.env);
  const defaultRuntime = !parsed.enabled && isDefaultRuntimeCommand(parsed.command);
  if (defaultRuntime) {
    parsed.enabled = true;
    parsed.defaultRuntime = true;
  }
  if (!parsed.enabled) {
    return { exitCode: 0, handled: false };
  }
  if (parsed.error) {
    if (defaultRuntime) {
      return { exitCode: 0, handled: false };
    }
    return errorResult(parsed.error);
  }
  if (!parsed.command) {
    return errorResult("TypeScript runtime requires a command.");
  }

  try {
    if (parsed.command === "audit") {
      return runAuditCommand(parsed, options);
    }
    if (parsed.command === "replay") {
      return runReplayCommand(parsed, options);
    }
    if (parsed.command === "export-task") {
      return runExportTaskCommand(parsed, options);
    }
    if (parsed.command === "tasks") {
      return runTasksCommand(parsed, options);
    }
    if (parsed.command === "bind") {
      return runBindCommand(parsed, options);
    }
    if (parsed.command === "unbind") {
      return runUnbindCommand(parsed, options);
    }
    if (parsed.explicit) {
      return errorResult(`Unsupported TypeScript runtime command: ${parsed.command}`);
    }
    return { exitCode: 0, handled: false };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

interface ParsedRuntimeArgs {
  command: string | null;
  enabled: boolean;
  error?: string;
  flags: {
    format: ReplayMode;
    includeContent: boolean;
    includeFullTranscripts: boolean;
    includeTranscripts: boolean;
    json: boolean;
    active: boolean;
    create: string | null;
    goal: string | null;
    limit: number | null;
    output: string | null;
    path: string | null;
    role: ReplayRole;
    summary: string | null;
    taskName: string | null;
    worker: string | null;
    manager: string | null;
    zip: boolean;
  };
  defaultRuntime?: boolean;
  explicit: boolean;
  task: string | null;
}

function parseRuntimeArgs(args: readonly string[], env: NodeJS.ProcessEnv): ParsedRuntimeArgs {
  const flags: ParsedRuntimeArgs["flags"] = {
    format: "timeline",
    includeContent: false,
    includeFullTranscripts: false,
    includeTranscripts: false,
    json: false,
    active: false,
    create: null,
    goal: null,
    limit: null,
    output: null,
    path: null,
    role: "all",
    summary: null,
    taskName: null,
    worker: null,
    manager: null,
    zip: false,
  };
  const queue = [...args];
  let explicit = false;
  let enabled = env.AGENT_CONVEYOR_TS_RUNTIME === "1";
  if (queue[0] === "--ts-runtime") {
    explicit = true;
    enabled = true;
    queue.shift();
  }
  const command = queue.shift() ?? null;
  let task: string | null = null;
  for (let index = 0; index < queue.length; index += 1) {
    const arg = queue[index];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--active") {
      flags.active = true;
    } else if (arg === "--zip") {
      flags.zip = true;
    } else if (arg === "--include-content") {
      flags.includeContent = true;
    } else if (arg === "--include-transcripts") {
      flags.includeTranscripts = true;
    } else if (arg === "--include-full-transcripts") {
      flags.includeFullTranscripts = true;
    } else if (arg === "--path") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.path = value.value;
      index += 1;
    } else if (arg === "--output") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.output = value.value;
      index += 1;
    } else if (arg === "--create") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.create = value.value;
      index += 1;
    } else if (arg === "--goal") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.goal = value.value;
      index += 1;
    } else if (arg === "--summary") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.summary = value.value;
      index += 1;
    } else if (arg === "--task") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.taskName = value.value;
      index += 1;
    } else if (arg === "--worker") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.worker = value.value;
      index += 1;
    } else if (arg === "--manager") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.manager = value.value;
      index += 1;
    } else if (arg === "--format") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = parsedValue.value;
      if (!isReplayMode(value)) {
        return { command, enabled, error: `Unsupported replay format: ${value}`, explicit, flags, task };
      }
      flags.format = value;
      index += 1;
    } else if (arg === "--role") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = parsedValue.value;
      if (!isReplayRole(value)) {
        return { command, enabled, error: `Unsupported replay role: ${value}`, explicit, flags, task };
      }
      flags.role = value;
      index += 1;
    } else if (arg === "--limit") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value < 0) {
        return { command, enabled, error: "--limit must be a non-negative integer.", explicit, flags, task };
      }
      flags.limit = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
    } else if (task === null) {
      task = arg;
    } else {
      return { command, enabled, error: `Unexpected argument: ${arg}`, explicit, flags, task };
    }
  }
  return { command, enabled, explicit, flags, task };
}

function runAuditCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const task = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const audit = taskAuditSync(database, task);
    if (parsed.flags.json) {
      return jsonResult(audit);
    }
    const lines = [
      `${audit.task.name}\t${audit.task.state}\t${audit.task.goal}`,
      ...audit.events.map((event) => {
        const command = event.command_id ? `\tcommand=${event.command_id}` : "";
        return `${event.created_at}\t${event.type}\tactor=${event.actor}${command}`;
      }),
    ];
    return { exitCode: 0, handled: true, stdout: `${lines.join("\n")}\n` };
  } finally {
    database.close();
  }
}

function runReplayCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const task = requireTask(parsed);
  if (parsed.flags.format === "full-transcript" && !parsed.flags.includeContent) {
    return errorResult(
      "full-transcript replay prints stored terminal content; rerun with --include-content only when stdout is redirected or you intentionally want verbatim transcript output.",
    );
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const audit = taskAuditSync(database, task);
    const replay = replayResultFromAudit(audit, {
      limit: parsed.flags.limit,
      mode: parsed.flags.format,
      role: parsed.flags.role,
    });
    return parsed.flags.json
      ? jsonResult(replay)
      : { exitCode: 0, handled: true, stdout: `${renderReplayText(replay)}\n` };
  } finally {
    database.close();
  }
}

function runExportTaskCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const task = requireTask(parsed);
  if (parsed.flags.zip || parsed.flags.includeTranscripts || parsed.flags.includeFullTranscripts) {
    if (parsed.defaultRuntime) {
      return { exitCode: 0, handled: false };
    }
    return errorResult(
      "TypeScript runtime export currently supports the migrated audit subset only; omit --zip and transcript flags or use the Python runtime.",
    );
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const audit = taskAuditSync(database, task);
    const outputDir = parsed.flags.output
      ? resolve(parsed.flags.output)
      : join(stateRoot({ cwd: options.cwd, env: options.env }), "artifacts", "tasks", audit.task.id, "export");
    return jsonResult(exportTaskAuditSubsetSync(database, { outputDir, task }));
  } finally {
    database.close();
  }
}

function runTasksCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  if (parsed.task) {
    return errorResult(`Unexpected argument: ${parsed.task}`);
  }
  if (parsed.flags.create && !parsed.flags.goal) {
    return errorResult("--goal is required with tasks --create");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    if (parsed.flags.create) {
      const taskId = createTaskSync(database, {
        goal: parsed.flags.goal ?? "",
        name: parsed.flags.create,
        summary: parsed.flags.summary,
      });
      return jsonResult({ created: true, id: taskId, name: parsed.flags.create });
    }
    const tasks = listTasksSync(database, { activeOnly: parsed.flags.active });
    if (parsed.flags.json) {
      return jsonResult(tasks);
    }
    return { exitCode: 0, handled: true, stdout: renderTasksText(tasks) };
  } finally {
    database.close();
  }
}

function runBindCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedBindOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.flags.taskName || !parsed.flags.worker || !parsed.flags.manager) {
    return unsupportedRuntimeResult(parsed, "bind requires --task, --worker, and --manager.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const bindingId = bindSessionsSync(database, {
      managerSessionName: parsed.flags.manager,
      taskName: parsed.flags.taskName,
      workerSessionName: parsed.flags.worker,
    });
    const binding = activeBindingForTaskSync(database, parsed.flags.taskName);
    insertEventSync(database, {
      payload: {
        binding_id: bindingId,
        manager: parsed.flags.manager,
        task: parsed.flags.taskName,
        worker: parsed.flags.worker,
      },
      taskId: binding.task_id,
      type: "binding_created",
    });
    return jsonResult({
      binding_id: bindingId,
      manager: parsed.flags.manager,
      task: parsed.flags.taskName,
      worker: parsed.flags.worker,
    });
  } finally {
    database.close();
  }
}

function runUnbindCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedUnbindOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.flags.taskName) {
    return unsupportedRuntimeResult(parsed, "unbind requires --task.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const taskId = taskIdForTask(database, parsed.flags.taskName);
    unbindTaskSync(database, { taskName: parsed.flags.taskName });
    insertEventSync(database, {
      payload: { task: parsed.flags.taskName },
      taskId,
      type: "binding_ended",
    });
    return unbindJsonResult(parsed.flags.taskName);
  } finally {
    database.close();
  }
}

function openRuntimeDatabase(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const database = openDatabaseSync(parsed.flags.path ?? defaultDbPath({ cwd: options.cwd, env: options.env }));
  initializeDatabaseSync(database);
  return database;
}

function requireTask(parsed: ParsedRuntimeArgs): string {
  if (!parsed.task) {
    throw new Error(`${parsed.command ?? "runtime"} command requires a task.`);
  }
  return parsed.task;
}

function isDefaultRuntimeCommand(command: string | null): boolean {
  return (
    command === "audit"
    || command === "replay"
    || command === "export-task"
    || command === "tasks"
    || command === "bind"
    || command === "unbind"
  );
}

function valueAfter(args: readonly string[], index: number, flag: string): { error?: string; value: string } {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return { error: `${flag} requires a value.`, value: "" };
  }
  return { value };
}

function jsonResult(payload: unknown): TypescriptRuntimeResult {
  return {
    exitCode: 0,
    handled: true,
    stdout: `${JSON.stringify(sortJson(payload), null, 2)}\n`,
  };
}

function unbindJsonResult(taskName: string): TypescriptRuntimeResult {
  return {
    exitCode: 0,
    handled: true,
    stdout: `{"task": ${JSON.stringify(taskName)}, "state": "ended"}\n`,
  };
}

function errorResult(message: string): TypescriptRuntimeResult {
  return {
    exitCode: 2,
    handled: true,
    stderr: `${message}\n`,
  };
}

function unsupportedRuntimeResult(parsed: ParsedRuntimeArgs, message: string): TypescriptRuntimeResult {
  if (parsed.defaultRuntime) {
    return { exitCode: 0, handled: false };
  }
  return errorResult(message);
}

function unsupportedBindOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (
    parsed.flags.active
    || parsed.flags.create !== null
    || parsed.flags.goal !== null
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.output !== null
    || parsed.flags.summary !== null
    || parsed.flags.zip
    || parsed.flags.includeContent
    || parsed.flags.includeTranscripts
    || parsed.flags.includeFullTranscripts
  ) {
    return "Unsupported TypeScript runtime option for bind.";
  }
  return null;
}

function unsupportedUnbindOptions(parsed: ParsedRuntimeArgs): string | null {
  const unsupported = unsupportedBindOptions(parsed);
  if (unsupported) {
    return unsupported;
  }
  if (parsed.flags.path !== null) {
    return "Unsupported TypeScript runtime option for unbind: --path";
  }
  if (parsed.flags.worker !== null || parsed.flags.manager !== null) {
    return "Unsupported TypeScript runtime option for unbind.";
  }
  return null;
}

function taskIdForTask(database: ReturnType<typeof openRuntimeDatabase>, taskName: string): string {
  const row = database.prepare(`
    select id
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(taskName, taskName) as { id: string } | undefined;
  if (!row) {
    throw new Error(`Unknown task: ${taskName}`);
  }
  return row.id;
}

function insertEventSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { payload: Record<string, unknown>; taskId: string; type: string },
): void {
  database.prepare(`
    insert into events(created_at, actor, task_id, type, payload_json)
    values (?, 'workerctl', ?, ?, ?)
  `).run(new Date().toISOString(), options.taskId, options.type, stableJson(options.payload));
}

function stableJson(payload: unknown): string {
  return JSON.stringify(sortJson(payload));
}

function renderTasksText(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return "";
  }
  return `${tasks.map((task) => `${task.name}\t${task.state}\t${task.goal}`).join("\n")}\n`;
}

function isReplayMode(value: string): value is ReplayMode {
  return value === "compact" || value === "timeline" || value === "transcript" || value === "full-transcript";
}

function isReplayRole(value: string): value is ReplayRole {
  return value === "all" || value === "worker" || value === "manager" || value === "reviewer" || value === "workerctl";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
