import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
import {
  configPath,
  defaultDbPath,
  eventsPath,
  loadJsonSync,
  stateRoot,
  statusPath,
  writeJsonSync,
} from "../state/files.js";
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
const VALID_WORKER_STATUS_STATES = new Set([
  "planning",
  "editing",
  "running_tests",
  "blocked",
  "waiting",
  "done",
  "unknown",
]);

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
    if (parsed.command === "events") {
      return runEventsCommand(parsed, options);
    }
    if (parsed.command === "update-status") {
      return runUpdateStatusCommand(parsed, options);
    }
    if (parsed.command === "transcript-show") {
      return runTranscriptShowCommand(parsed, options);
    }
    if (parsed.command === "transcript-prune") {
      return runTranscriptPruneCommand(parsed, options);
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
    blocker: string | null;
    busyWaitSeconds: number;
    codexSession: string | null;
    create: string | null;
    currentTask: string | null;
    cwd: string | null;
    dryRun: boolean;
    eventType: string | null;
    file: string | null;
    goal: string | null;
    keepLatest: number;
    limit: number | null;
    names: string[];
    nextAction: string | null;
    output: string | null;
    path: string | null;
    pid: number | null;
    role: ReplayRole;
    roleProvided: boolean;
    sessionRole: "manager" | "worker" | null;
    sessionState: "active" | "all" | "gone" | null;
    statusAgeSeconds: number;
    statusState: string | null;
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
    blocker: null,
    busyWaitSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    codexSession: null,
    create: null,
    currentTask: null,
    cwd: null,
    dryRun: false,
    eventType: null,
    file: null,
    goal: null,
    keepLatest: 20,
    limit: null,
    names: [],
    nextAction: null,
    output: null,
    path: null,
    pid: null,
    role: "all",
    roleProvided: false,
    sessionRole: null,
    sessionState: null,
    statusAgeSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    statusState: null,
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
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
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
    } else if (arg === "--current-task") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.currentTask = value.value;
      index += 1;
    } else if (arg === "--next-action") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.nextAction = value.value;
      index += 1;
    } else if (arg === "--blocker") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.blocker = value.value;
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
      flags.roleProvided = true;
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
      if (command === "update-status") {
        if (!VALID_WORKER_STATUS_STATES.has(value)) {
          return { command, enabled, error: `Unsupported worker status state: ${value}`, explicit, flags, task };
        }
        flags.statusState = value;
      } else if (!isSessionState(value)) {
        return { command, enabled, error: `Unsupported sessions state: ${value}`, explicit, flags, task };
      } else {
        flags.sessionState = value;
      }
      index += 1;
    } else if (arg === "--type") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.eventType = value.value;
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
    } else if (arg === "--keep-latest") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--keep-latest must be an integer.", explicit, flags, task };
      }
      flags.keepLatest = value;
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

function runEventsCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedEventsOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "events requires a worker or session name.");
  }
  requireWorkerConfigOrSession(parsed.task, parsed, options);
  const { events, skipped } = readCompatibilityEvents(parsed.task, options);
  const filtered = parsed.flags.eventType
    ? events.filter((event) => event.type === parsed.flags.eventType)
    : events;
  const limited = parsed.flags.limit ? filtered.slice(-parsed.flags.limit) : filtered;
  return {
    exitCode: 0,
    handled: true,
    stderr: skipped > 0 ? `workerctl: ${skipped} malformed event line(s) skipped\n` : undefined,
    stdout: limited.map((event) => `${JSON.stringify(sortJson(event))}\n`).join(""),
  };
}

function runUpdateStatusCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedUpdateStatusOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task || !parsed.flags.statusState || !parsed.flags.currentTask || !parsed.flags.nextAction) {
    return unsupportedRuntimeResult(parsed, "update-status requires a name, --state, --current-task, and --next-action.");
  }
  const config = requireWorkerConfig(parsed.task, options);
  const timestamp = nowIsoSeconds();
  const payload = {
    blocker: parsed.flags.blocker,
    current_task: parsed.flags.currentTask,
    last_update: timestamp,
    next_action: parsed.flags.nextAction,
    state: parsed.flags.statusState,
  };
  const eventPayload = {
    blocker: parsed.flags.blocker,
    current_task: parsed.flags.currentTask,
    next_action: parsed.flags.nextAction,
    state: parsed.flags.statusState,
  };
  const database = openRuntimeDatabase(parsed, options);
  try {
    const workerId = upsertWorkerSync(database, {
      config,
      name: parsed.task,
      timestamp,
    });
    database.prepare(`
      insert into statuses(worker_id, state, current_task, next_action, blocker, created_at)
      values (?, ?, ?, ?, ?, ?)
    `).run(
      workerId,
      payload.state,
      payload.current_task,
      payload.next_action,
      payload.blocker,
      timestamp,
    );
    database.prepare(`
      insert into events(created_at, actor, worker_id, type, payload_json)
      values (?, 'workerctl', ?, 'status_updated', ?)
    `).run(timestamp, workerId, stableJson(eventPayload));
  } finally {
    database.close();
  }
  writeJsonSync(statusPath(parsed.task, options), payload);
  appendCompatibilityEvent(parsed.task, "status_updated", eventPayload, options, timestamp);
  return jsonResult(payload);
}

function runTranscriptShowCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedTranscriptShowOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const task = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const result = transcriptSegmentsSync(database, {
      limit: parsed.flags.limit,
      role: transcriptRole(parsed),
      task,
    });
    if (parsed.flags.json) {
      return jsonResult(parsed.flags.includeContent ? result : redactTranscriptSegments(result));
    }
    const lines = result.segments.flatMap((segment) => {
      const timestamp = segment.captured_at.split("T", 2).at(1)?.replace(/Z$/, "") ?? segment.captured_at;
      const header = `--- ${segment.role} transcript segment ${segment.id} ${timestamp} (${segment.segment_kind}) ---`;
      if (segment.segment_text && parsed.flags.includeContent) {
        return [header, segment.segment_text];
      }
      if (segment.segment_text) {
        return [
          header,
          `[content redacted: ${pythonSplitlinesCount(segment.segment_text)} lines, ${Buffer.byteLength(segment.segment_text)} bytes]`,
        ];
      }
      return [header, "[metadata only]"];
    });
    return { exitCode: 0, handled: true, stdout: lines.length ? `${lines.join("\n")}\n` : "" };
  } finally {
    database.close();
  }
}

function runTranscriptPruneCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedTranscriptPruneOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const task = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const snapshot = taskSnapshot(database, task);
    const rows = database.prepare(`
      select id, role
      from transcript_segments
      where task_id = ? and segment_text is not null
      order by role, id desc
    `).all(snapshot.id) as Array<{ id: number; role: string }>;
    const seen = new Map<string, number>();
    const pruneIds: number[] = [];
    for (const row of rows) {
      const count = (seen.get(row.role) ?? 0) + 1;
      seen.set(row.role, count);
      if (count > parsed.flags.keepLatest) {
        pruneIds.push(row.id);
      }
    }
    if (pruneIds.length > 0 && !parsed.flags.dryRun) {
      const update = database.prepare(`
        update transcript_segments
        set segment_text = null, retention_class = 'cold', segment_kind = 'metadata'
        where id = ?
      `);
      for (const segmentId of pruneIds) {
        update.run(segmentId);
      }
      insertEventSync(database, {
        payload: { keep_latest: parsed.flags.keepLatest, segment_ids: pruneIds },
        taskId: snapshot.id,
        type: "transcript_segments_pruned",
      });
    }
    return jsonResult({
      dry_run: parsed.flags.dryRun,
      keep_latest: parsed.flags.keepLatest,
      pruned_count: parsed.flags.dryRun ? 0 : pruneIds.length,
      would_prune_count: pruneIds.length,
    });
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
    || command === "events"
    || command === "update-status"
    || command === "transcript-show"
    || command === "transcript-prune"
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

function unsupportedEventsOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.cwd !== null
    || parsed.flags.dryRun
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for events.";
  }
  return null;
}

function unsupportedUpdateStatusOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.cwd !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
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
    return "Unsupported TypeScript runtime option for update-status.";
  }
  return null;
}

function unsupportedTranscriptShowOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.cwd !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.keepLatest !== 20
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for transcript-show.";
  }
  if (!["all", "worker", "manager"].includes(parsed.flags.role)) {
    return "Unsupported TypeScript runtime role for transcript-show.";
  }
  return null;
}

function unsupportedTranscriptPruneOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.cwd !== null
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for transcript-prune.";
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

interface TranscriptSegmentRecord {
  byte_count: number;
  captured_at: string;
  content_sha256: string;
  created_at: string;
  id: number;
  line_count: number;
  previous_capture_id: number | null;
  redacted: boolean;
  retention_class: string;
  role: string;
  segment_end_line: number | null;
  segment_kind: string;
  segment_start_line: number | null;
  segment_text: string | null;
  source_capture_id: number;
  task_id: string;
}

interface TranscriptSegmentsResult {
  segments: TranscriptSegmentRecord[];
  task: { id: string; name: string; state: string };
}

function transcriptSegmentsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { limit: number | null; role: "all" | "manager" | "worker"; task: string },
): TranscriptSegmentsResult {
  const snapshot = taskSnapshot(database, options.task);
  const clauses = ["task_id = ?"];
  const params: Array<number | string> = [snapshot.id];
  if (options.role !== "all") {
    clauses.push("role = ?");
    params.push(options.role);
  }
  const limitClause = options.limit ? "limit ?" : "";
  if (options.limit) {
    params.push(options.limit);
  }
  const rows = database.prepare(`
    select *
    from (
      select id, task_id, role, source_capture_id, previous_capture_id,
             captured_at, content_sha256, segment_text, segment_start_line,
             segment_end_line, byte_count, line_count, retention_class,
             segment_kind, redacted, created_at
      from transcript_segments
      where ${clauses.join(" and ")}
      order by id desc
      ${limitClause}
    )
    order by id
  `).all(...params) as Array<{
    byte_count: number;
    captured_at: string;
    content_sha256: string;
    created_at: string;
    id: number;
    line_count: number;
    previous_capture_id: number | null;
    redacted: 0 | 1;
    retention_class: string;
    role: string;
    segment_end_line: number | null;
    segment_kind: string;
    segment_start_line: number | null;
    segment_text: string | null;
    source_capture_id: number;
    task_id: string;
  }>;
  return {
    segments: rows.map((row) => ({
      byte_count: row.byte_count,
      captured_at: row.captured_at,
      content_sha256: row.content_sha256,
      created_at: row.created_at,
      id: row.id,
      line_count: row.line_count,
      previous_capture_id: row.previous_capture_id,
      redacted: Boolean(row.redacted),
      retention_class: row.retention_class,
      role: row.role,
      segment_end_line: row.segment_end_line,
      segment_kind: row.segment_kind,
      segment_start_line: row.segment_start_line,
      segment_text: row.segment_text,
      source_capture_id: row.source_capture_id,
      task_id: row.task_id,
    })),
    task: snapshot,
  };
}

function redactTranscriptSegments(result: TranscriptSegmentsResult): unknown {
  return {
    segments: result.segments.map((segment) => {
      const { segment_text: segmentText, ...rest } = segment;
      if (typeof segmentText !== "string") {
        return rest;
      }
      return {
        ...rest,
        segment_text_byte_count: Buffer.byteLength(segmentText),
        segment_text_line_count: pythonSplitlinesCount(segmentText),
        segment_text_redacted: true,
      };
    }),
    task: result.task,
  };
}

function taskSnapshot(
  database: ReturnType<typeof openRuntimeDatabase>,
  task: string,
): { id: string; name: string; state: string } {
  const row = database.prepare(`
    select id, name, state
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(task, task) as { id: string; name: string; state: string } | undefined;
  if (!row) {
    throw new Error(`Unknown task: ${task}`);
  }
  return row;
}

function transcriptRole(parsed: ParsedRuntimeArgs): "all" | "manager" | "worker" {
  if (parsed.flags.role === "manager" || parsed.flags.role === "worker") {
    return parsed.flags.role;
  }
  return "all";
}

function readCompatibilityEvents(
  name: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): { events: Array<Record<string, unknown>>; skipped: number } {
  const path = eventsPath(name, options);
  if (!existsSync(path)) {
    return { events: [], skipped: 0 };
  }
  const events: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      if (event !== null && typeof event === "object" && !Array.isArray(event)) {
        events.push(event as Record<string, unknown>);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

function appendCompatibilityEvent(
  name: string,
  type: string,
  payload: Record<string, unknown>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  timestamp = nowIsoSeconds(),
): void {
  const path = eventsPath(name, options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortJson({ time: timestamp, type, ...payload }))}\n`, { flag: "a" });
}

function requireWorkerConfig(
  name: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Record<string, unknown> {
  const path = configPath(name, options);
  const config = loadJsonSync<Record<string, unknown> | null>(path, null);
  if (config === null) {
    throw new Error(`Unknown worker: ${name}`);
  }
  return config;
}

function requireWorkerConfigOrSession(
  name: string,
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): void {
  if (existsSync(configPath(name, options))) {
    return;
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    sessionRow(database, name);
  } finally {
    database.close();
  }
}

function upsertWorkerSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { config: Record<string, unknown>; name: string; timestamp: string },
): string {
  const existing = database.prepare("select id, identity_token from workers where name = ?")
    .get(options.name) as { id: string; identity_token: string } | undefined;
  const workerId = existing?.id ?? `worker-${randomUUID()}`;
  const identityToken = typeof options.config.identity_token === "string"
    ? options.config.identity_token
    : existing?.identity_token ?? `workerctl-${randomUUID()}`;
  database.prepare(`
    insert into workers(
      id, name, tmux_session, tmux_pane_id, identity_token, cwd, state, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    on conflict(name) do update set
      tmux_session = excluded.tmux_session,
      tmux_pane_id = coalesce(excluded.tmux_pane_id, workers.tmux_pane_id),
      cwd = excluded.cwd,
      state = excluded.state,
      updated_at = excluded.updated_at,
      exit_detected_at = null,
      exit_reason = null
  `).run(
    workerId,
    options.name,
    typeof options.config.tmux_session === "string" ? options.config.tmux_session : `codex-${options.name}`,
    typeof options.config.tmux_pane_id === "string" ? options.config.tmux_pane_id : null,
    identityToken,
    typeof options.config.cwd === "string" ? options.config.cwd : "",
    options.timestamp,
    options.timestamp,
  );
  const row = database.prepare("select id from workers where name = ?").get(options.name) as { id: string };
  return row.id;
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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
