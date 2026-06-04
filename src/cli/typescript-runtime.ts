import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { taskAuditSync } from "../runtime/audit.js";
import { classifyBusyWait, classifyStartupOutput } from "../runtime/classify.js";
import { exportTaskAuditSubsetSync } from "../runtime/export.js";
import { ingestSessionSync } from "../runtime/ingest.js";
import {
  renderReplayText,
  replayResultFromAudit,
  type ReplayMode,
  type ReplayRole,
} from "../runtime/replay.js";
import {
  createCommandSync,
} from "../runtime/commands.js";
import {
  deregisterSessionSync,
  discoverRegistrySync,
  listRegisteredSessionsSync,
  registerSessionSync,
  sessionRow,
} from "../runtime/codex-session.js";
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

const DEFAULT_BUSY_WAIT_SECONDS = 90;

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
    if (parsed.command === "register-worker") {
      return runRegisterSessionCommand(parsed, options, "worker");
    }
    if (parsed.command === "register-manager") {
      return runRegisterSessionCommand(parsed, options, "manager");
    }
    if (parsed.command === "sessions") {
      return runSessionsCommand(parsed, options);
    }
    if (parsed.command === "deregister") {
      return runDeregisterCommand(parsed, options);
    }
    if (parsed.command === "discover" || parsed.command === "search") {
      return runDiscoverCommand(parsed, options);
    }
    if (parsed.command === "classify") {
      return runClassifyCommand(parsed);
    }
    if (parsed.command === "ingest") {
      return runIngestCommand(parsed, options);
    }
    if (parsed.command === "tail") {
      return runTailCommand(parsed, options);
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
    all: boolean;
    json: boolean;
    includeLegacy: boolean;
    redactIdentityToken: boolean;
    active: boolean;
    busyWaitSeconds: number;
    codexSession: string | null;
    create: string | null;
    cwd: string | null;
    file: string | null;
    goal: string | null;
    limit: number | null;
    names: string[];
    output: string | null;
    path: string | null;
    pid: number | null;
    role: ReplayRole;
    sessionRole: "manager" | "worker" | null;
    sessionState: "active" | "all" | "gone" | null;
    statusAgeSeconds: number;
    subtype: string | null;
    summary: string | null;
    taskName: string | null;
    text: string | null;
    tmuxSession: string | null;
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
    all: false,
    json: false,
    includeLegacy: false,
    redactIdentityToken: false,
    active: false,
    busyWaitSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    codexSession: null,
    create: null,
    cwd: null,
    file: null,
    goal: null,
    limit: null,
    names: [],
    output: null,
    path: null,
    pid: null,
    role: "all",
    sessionRole: null,
    sessionState: null,
    statusAgeSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    subtype: null,
    summary: null,
    taskName: null,
    text: null,
    tmuxSession: null,
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
    } else if (arg === "--all") {
      flags.all = true;
    } else if (arg === "--active") {
      flags.active = true;
    } else if (arg === "--include-legacy") {
      flags.includeLegacy = true;
    } else if (arg === "--redact-identity-token") {
      flags.redactIdentityToken = true;
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
    } else if (arg === "--name") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.names.push(value.value);
      index += 1;
    } else if (arg === "--pid") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--pid must be an integer.", explicit, flags, task };
      }
      flags.pid = value;
      index += 1;
    } else if (arg === "--codex-session") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.codexSession = value.value;
      index += 1;
    } else if (arg === "--cwd") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.cwd = value.value;
      index += 1;
    } else if (arg === "--file") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.file = value.value;
      index += 1;
    } else if (arg === "--text") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.text = value.value;
      index += 1;
    } else if (arg === "--tmux-session") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.tmuxSession = value.value;
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
      if (command === "sessions") {
        if (!isSessionRole(value)) {
          return { command, enabled, error: `Unsupported sessions role: ${value}`, explicit, flags, task };
        }
        flags.sessionRole = value;
      } else if (!isReplayRole(value)) {
        return { command, enabled, error: `Unsupported replay role: ${value}`, explicit, flags, task };
      } else {
        flags.role = value;
      }
      index += 1;
    } else if (arg === "--state") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = parsedValue.value;
      if (!isSessionState(value)) {
        return { command, enabled, error: `Unsupported sessions state: ${value}`, explicit, flags, task };
      }
      flags.sessionState = value;
      index += 1;
    } else if (arg === "--subtype") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.subtype = value.value;
      index += 1;
    } else if (arg === "--status-age-seconds") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--status-age-seconds must be an integer.", explicit, flags, task };
      }
      flags.statusAgeSeconds = value;
      index += 1;
    } else if (arg === "--busy-wait-seconds") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--busy-wait-seconds must be an integer.", explicit, flags, task };
      }
      flags.busyWaitSeconds = value;
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

function runRegisterSessionCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  role: "manager" | "worker",
): TypescriptRuntimeResult {
  const unsupported = unsupportedRegisterSessionOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = singleName(parsed);
  if (!name || parsed.flags.pid === null || !parsed.flags.codexSession) {
    return unsupportedRuntimeResult(parsed, `register-${role} requires --name, --pid, and --codex-session for the TypeScript runtime.`);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const result = registerSessionSync(database, {
      codexSessionPath: parsed.flags.codexSession,
      cwd: parsed.flags.cwd,
      name,
      pid: parsed.flags.pid,
      role,
      tmuxSession: parsed.flags.tmuxSession,
    });
    insertEventSync(database, {
      payload: {
        codex_session_id: result.codex_session_id,
        name,
        pid: parsed.flags.pid,
        role,
        session_id: result.session_id,
      },
      type: "session_registered",
    });
    return jsonResult(result);
  } finally {
    database.close();
  }
}

function runSessionsCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedSessionsOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    return jsonResult(listRegisteredSessionsSync(database, {
      includeLegacy: parsed.flags.includeLegacy,
      names: parsed.flags.names,
      redactIdentityToken: parsed.flags.redactIdentityToken,
      role: parsed.flags.sessionRole,
      state: parsed.flags.sessionState,
    }));
  } finally {
    database.close();
  }
}

function runDeregisterCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedDeregisterOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "deregister requires a session name.");
  }
  const database = openRuntimeDatabase(parsed, options);
  let commandId: string | null = null;
  let taskId: string | null = null;
  let activeBinding: Record<string, unknown> | null = null;
  try {
    const session = sessionRow(database, parsed.task);
    activeBinding = activeBindingForSession(database, session.id);
    taskId = typeof activeBinding?.task_id === "string" ? activeBinding.task_id : null;
    commandId = createCommandSync(database, {
      commandType: "deregister_session",
      payload: {
        active_binding: activeBinding,
        expected_failure: activeBinding !== null,
        name: parsed.task,
        role: session.role,
      },
      taskId,
    });
    markCommandAttemptedSync(database, commandId);
    deregisterSessionSync(database, { name: parsed.task });
    insertEventSync(database, {
      commandId,
      payload: { name: parsed.task },
      taskId,
      type: "session_deregistered",
    });
    finishCommandSync(database, {
      commandId,
      result: { command_id: commandId, name: parsed.task, state: "gone" },
      state: "succeeded",
    });
    return deregisterJsonResult(parsed.task);
  } catch (error) {
    if (commandId) {
      const message = error instanceof Error ? error.message : String(error);
      finishCommandSync(database, {
        commandId,
        error: message,
        result: {
          active_binding: activeBinding,
          command_id: commandId,
          expected_failure: activeBinding !== null,
          name: parsed.task,
        },
        state: "failed",
      });
      insertEventSync(database, {
        commandId,
        payload: {
          active_binding: activeBinding,
          error: message,
          error_type: error instanceof Error ? error.name : typeof error,
          expected_failure: activeBinding !== null,
          name: parsed.task,
        },
        taskId,
        type: "session_deregister_failed",
      });
    }
    throw error;
  } finally {
    database.close();
  }
}

function runDiscoverCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedDiscoverOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    return jsonResult(discoverRegistrySync(database, {
      all: parsed.flags.all,
      dbPath: parsed.flags.path,
      limit: parsed.flags.limit ?? 10,
      query: parsed.task ?? "",
    }));
  } finally {
    database.close();
  }
}

function runClassifyCommand(parsed: ParsedRuntimeArgs): TypescriptRuntimeResult {
  const unsupported = unsupportedClassifyOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (parsed.flags.text === null && parsed.flags.file === null) {
    return unsupportedRuntimeResult(parsed, "TypeScript runtime classify requires --text or --file.");
  }
  const output = parsed.flags.text ?? readFileSync(parsed.flags.file ?? "", "utf8");
  const [startup, startupReason] = classifyStartupOutput(output);
  return jsonResult({
    busy_wait: classifyBusyWait(output, parsed.flags.statusAgeSeconds, parsed.flags.busyWaitSeconds),
    busy_wait_seconds: parsed.flags.busyWaitSeconds,
    startup,
    startup_reason: startupReason,
    status_age_seconds: parsed.flags.statusAgeSeconds,
  });
}

function runIngestCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedIngestOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "ingest requires a session name.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    return jsonResult({ session: parsed.task, ...ingestSessionSync(database, { sessionName: parsed.task }) });
  } finally {
    database.close();
  }
}

function runTailCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedTailOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "tail requires a session name.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const session = sessionRow(database, parsed.task);
    const rows = latestCodexEventsForSession(database, {
      includeContent: parsed.flags.includeContent,
      limit: parsed.flags.limit ?? 50,
      sessionId: session.id,
      subtype: parsed.flags.subtype,
    });
    emitTelemetrySync(database, {
      actor: "workerctl",
      attributes: {
        limit: parsed.flags.limit ?? 50,
        returned_count: rows.length,
        subtype: parsed.flags.subtype,
      },
      correlation: { session: parsed.task, session_id: session.id },
      eventType: "codex_events_tail_read",
      severity: "info",
      summary: `Read recent Codex events for session ${parsed.task}.`,
      taskId: null,
      timestamp: new Date().toISOString(),
    });
    return jsonResult(rows);
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
    || command === "register-worker"
    || command === "register-manager"
    || command === "sessions"
    || command === "deregister"
    || command === "discover"
    || command === "search"
    || command === "classify"
    || command === "ingest"
    || command === "tail"
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

function deregisterJsonResult(name: string): TypescriptRuntimeResult {
  return {
    exitCode: 0,
    handled: true,
    stdout: `{"name": ${JSON.stringify(name)}, "state": "gone"}\n`,
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

function unsupportedRegisterSessionOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.create !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeLegacy
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.output !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
    || parsed.flags.includeContent
    || parsed.flags.includeTranscripts
    || parsed.flags.includeFullTranscripts
  ) {
    return `Unsupported TypeScript runtime option for ${parsed.command ?? "register-session"}.`;
  }
  if (parsed.flags.pid !== null && !parsed.flags.codexSession) {
    return "TypeScript runtime does not yet discover --codex-session from --pid alone.";
  }
  return null;
}

function unsupportedSessionsOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.goal !== null
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
    || parsed.flags.includeContent
    || parsed.flags.includeTranscripts
    || parsed.flags.includeFullTranscripts
  ) {
    return "Unsupported TypeScript runtime option for sessions.";
  }
  return null;
}

function unsupportedDeregisterOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeLegacy
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
    || parsed.flags.includeContent
    || parsed.flags.includeTranscripts
    || parsed.flags.includeFullTranscripts
  ) {
    return "Unsupported TypeScript runtime option for deregister.";
  }
  return null;
}

function unsupportedDiscoverOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeLegacy
    || parsed.flags.json
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
    || parsed.flags.includeContent
    || parsed.flags.includeTranscripts
    || parsed.flags.includeFullTranscripts
  ) {
    return "Unsupported TypeScript runtime option for discover.";
  }
  return null;
}

function unsupportedClassifyOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for classify.";
  }
  return null;
}

function unsupportedIngestOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for ingest.";
  }
  return null;
}

function unsupportedTailOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for tail.";
  }
  return null;
}

function singleName(parsed: ParsedRuntimeArgs): string | null {
  return parsed.flags.names.length === 1 ? parsed.flags.names[0] : null;
}

function activeBindingForSession(
  database: ReturnType<typeof openRuntimeDatabase>,
  sessionId: string,
): Record<string, unknown> | null {
  return database.prepare(`
    select bindings.id, bindings.task_id
    from bindings
    where bindings.state in ('active', 'ending')
      and (bindings.worker_session_id = ? or bindings.manager_session_id = ?)
    limit 1
  `).get(sessionId, sessionId) as Record<string, unknown> | undefined ?? null;
}

function markCommandAttemptedSync(database: ReturnType<typeof openRuntimeDatabase>, commandId: string): void {
  const timestamp = new Date().toISOString();
  database.prepare(`
    update commands
    set state = 'attempted', updated_at = ?
    where id = ? and state = 'pending'
  `).run(timestamp, commandId);
  const row = database.prepare(`
    select task_id, worker_id, manager_id, type, state
    from commands
    where id = ?
  `).get(commandId) as {
    manager_id: string | null;
    state: string;
    task_id: string | null;
    type: string;
    worker_id: string | null;
  } | undefined;
  if (row) {
    emitTelemetrySync(database, {
      actor: "workerctl",
      attributes: {
        manager_id: row.manager_id,
        state: row.state,
        worker_id: row.worker_id,
      },
      correlation: { command_id: commandId, command_type: row.type },
      eventType: "command_attempted",
      severity: "info",
      summary: `Attempted command ${row.type}.`,
      taskId: row.task_id,
      timestamp,
    });
  }
}

function finishCommandSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    commandId: string;
    error?: string | null;
    result?: Record<string, unknown> | null;
    state: "failed" | "succeeded";
  },
): void {
  const timestamp = new Date().toISOString();
  database.prepare(`
    update commands
    set state = ?, updated_at = ?, result_json = ?, error = ?
    where id = ?
  `).run(
    options.state,
    timestamp,
    options.result ? stableJson(options.result) : null,
    options.error ?? null,
    options.commandId,
  );
  const row = database.prepare(`
    select task_id, worker_id, manager_id, type, state
    from commands
    where id = ?
  `).get(options.commandId) as {
    manager_id: string | null;
    state: string;
    task_id: string | null;
    type: string;
    worker_id: string | null;
  } | undefined;
  if (row) {
    emitTelemetrySync(database, {
      actor: "workerctl",
      attributes: {
        error: options.error ?? null,
        manager_id: row.manager_id,
        result: options.result ?? {},
        state: row.state,
        worker_id: row.worker_id,
      },
      correlation: { command_id: options.commandId, command_type: row.type },
      eventType: `command_${options.state}`,
      severity: options.state === "failed" ? "error" : "info",
      summary: `Command ${row.type} ${options.state}.`,
      taskId: row.task_id,
      timestamp,
    });
  }
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
  options: { commandId?: string | null; payload: Record<string, unknown>; taskId?: string | null; type: string },
): void {
  database.prepare(`
    insert into events(created_at, actor, task_id, command_id, type, payload_json)
    values (?, 'workerctl', ?, ?, ?, ?)
  `).run(new Date().toISOString(), options.taskId ?? null, options.commandId ?? null, options.type, stableJson(options.payload));
}

function emitTelemetrySync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    actor: string;
    attributes: Record<string, unknown>;
    correlation: Record<string, unknown>;
    eventType: string;
    severity: string;
    summary: string;
    taskId?: string | null;
    timestamp: string;
  },
): void {
  const eventId = `telemetry-${randomUUID()}`;
  const attributesJson = stableJson(options.attributes);
  database.prepare(`
    insert into telemetry_events(
      id, run_id, task_id, timestamp, actor, event_type, severity,
      summary, correlation_json, attributes_json
    )
    values (?, null, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    options.taskId ?? null,
    options.timestamp,
    options.actor,
    options.eventType,
    options.severity,
    options.summary,
    stableJson(options.correlation),
    attributesJson,
  );
  database.prepare(`
    insert into telemetry_events_fts(
      event_id, task_id, run_id, actor, event_type, summary, attributes
    )
    values (?, ?, null, ?, ?, ?, ?)
  `).run(
    eventId,
    options.taskId ?? null,
    options.actor,
    options.eventType,
    options.summary,
    attributesJson,
  );
}

function latestCodexEventsForSession(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { includeContent: boolean; limit: number; sessionId: string; subtype: string | null },
): Array<Record<string, unknown>> {
  const clauses = ["session_id = ?"];
  const params: Array<number | string> = [options.sessionId];
  if (options.subtype !== null) {
    clauses.push("subtype = ?");
    params.push(options.subtype);
  }
  params.push(options.limit);
  const rows = database.prepare(`
    select id, timestamp, type, subtype, byte_offset, payload_json
    from codex_events
    where ${clauses.join(" and ")}
    order by id desc
    limit ?
  `).all(...params) as Array<{
    byte_offset: number;
    id: number;
    payload_json: string;
    subtype: string | null;
    timestamp: string;
    type: string;
  }>;
  return rows.map((row) => ({
    byte_offset: row.byte_offset,
    id: row.id,
    payload: options.includeContent ? JSON.parse(row.payload_json) : redactPayload(JSON.parse(row.payload_json)),
    subtype: row.subtype,
    timestamp: row.timestamp,
    type: row.type,
  }));
}

const CONTENT_KEYS = new Set(["content", "message", "output", "segment_text", "text"]);

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactPayload);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CONTENT_KEYS.has(key) && typeof child === "string") {
      redacted[`${key}_redacted`] = true;
      redacted[`${key}_byte_count`] = Buffer.byteLength(child);
      redacted[`${key}_line_count`] = pythonSplitlinesCount(child);
      continue;
    }
    redacted[key] = redactPayload(child);
  }
  return redacted;
}

function pythonSplitlinesCount(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const lineBreaks = value.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/(?:\r\n|\r|\n)$/.test(value) ? 0 : 1);
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

function isSessionRole(value: string): value is "manager" | "worker" {
  return value === "manager" || value === "worker";
}

function isSessionState(value: string): value is "active" | "all" | "gone" {
  return value === "active" || value === "all" || value === "gone";
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
