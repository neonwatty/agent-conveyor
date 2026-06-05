import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  findRolloutPathForPid,
  listRegisteredSessionsSync,
  registerSessionSync,
  readSessionMeta,
  sessionRow,
} from "../runtime/codex-session.js";
import { managerConfigSync, type ManagerConfigRecord } from "../runtime/manager-config.js";
import {
  activeBindingForTaskSync,
  bindSessionsSync,
  createTaskSync,
  listTasksSync,
  unbindTaskSync,
  type TaskRecord,
} from "../runtime/tasks.js";
import {
  captureTmuxTargetWithRunner,
  captureTranscriptTmuxTargetWithRunner,
  currentPaneIdWithRunner,
  killTmuxSessionWithRunner,
  sendEnterToTmuxSessionWithRunner,
  sendTextToSessionWithRunner,
  sessionExists,
  startTmuxSessionWithRunner,
  tmuxCommandFailureMessage,
  tmuxSession,
  tmuxSessionRunning,
  type TmuxRunner,
} from "../runtime/tmux.js";
import {
  captureMetaPath,
  configPath,
  defaultDbPath,
  eventsPath,
  loadJsonSync,
  stateRoot,
  statusPath,
  transcriptPath,
  writeJsonSync,
} from "../state/files.js";
import { latestStatusSync } from "../state/status.js";
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
const DEFAULT_HISTORY_LINES = 200;
const DEFAULT_STATUS_STALE_SECONDS = 300;
const DEFAULT_TERMINAL_STALE_SECONDS = 300;
type TerminalChoice = "auto" | "ghostty" | "terminal";
type TranscriptCaptureMode = "excerpt" | "full" | "metadata" | "segment" | "snapshot";
const VALID_WORKER_STATUS_STATES = new Set([
  "planning",
  "editing",
  "running_tests",
  "blocked",
  "waiting",
  "done",
  "unknown",
]);

interface SpawnedCodexSessionDiscovery {
  cli_version?: string;
  codex_session_id: string;
  codex_session_path: string;
  cwd?: string;
  native_pid: number;
  originator?: string;
}

interface SpawnedCodexSessionDiscoveryOptions {
  acceptTrust: boolean;
  childrenForPid?: (pid: number) => number[];
  lsofForPid?: (pid: number) => string;
  minimumSessionTimestamp: Date;
  sleepMilliseconds?: (milliseconds: number) => void;
  timeoutSeconds: number;
  tmuxRunner?: TmuxRunner;
  tmuxSessionName: string;
}

type TypescriptRuntimeOptions = {
  args: readonly string[];
  codexCommandResolver?: (name: string) => string | null;
  cwd?: string;
  discoverSpawnedCodexSession?: (options: SpawnedCodexSessionDiscoveryOptions) => SpawnedCodexSessionDiscovery;
  env?: NodeJS.ProcessEnv;
  childrenForPid?: (pid: number) => number[];
  lsofForPid?: (pid: number) => string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  sleepMilliseconds?: (milliseconds: number) => void;
  terminalRunner?: (args: string[]) => { status: number; stderr?: string; stdout?: string };
  tmuxRunner?: TmuxRunner;
};

export function runTypescriptRuntimeCommand(options: TypescriptRuntimeOptions): TypescriptRuntimeResult {
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
    if (parsed.command === "create-disposable-binding") {
      return runCreateDisposableBindingCommand(parsed, options);
    }
    if (parsed.command === "finish-task") {
      return runLifecycleTaskCommand(parsed, options, true);
    }
    if (parsed.command === "stop-task") {
      return runLifecycleTaskCommand(parsed, options, false);
    }
    if (parsed.command === "start-worker") {
      return runStartSessionCommand(parsed, options, "worker");
    }
    if (parsed.command === "start-manager") {
      return runStartSessionCommand(parsed, options, "manager");
    }
    if (parsed.command === "open") {
      return runOpenCommand(parsed, options);
    }
    if (parsed.command === "open-worker") {
      return runOpenTaskSessionCommand(parsed, options, "worker");
    }
    if (parsed.command === "open-manager") {
      return runOpenTaskSessionCommand(parsed, options, "manager");
    }
    if (parsed.command === "stop") {
      return runStopCommand(parsed, options);
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
    if (parsed.command === "transcript-capture") {
      return runTranscriptCaptureCommand(parsed, options);
    }
    if (parsed.command === "capture") {
      return runCaptureCommand(parsed, options);
    }
    if (parsed.command === "status") {
      return runStatusCommand(parsed, options);
    }
    if (parsed.command === "idle-check") {
      return runIdleCheckCommand(parsed, options);
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
    currentIteration: number;
    cwd: string | null;
    dryRun: boolean;
    eventType: string | null;
    file: string | null;
    goal: string | null;
    keepLatest: number;
    lines: number;
    limit: number | null;
    names: string[];
    nextAction: string | null;
    output: string | null;
    path: string | null;
    pid: number | null;
    role: ReplayRole;
    roleProvided: boolean;
    refresh: boolean;
    sessionRole: "manager" | "worker" | null;
    sessionState: "active" | "all" | "gone" | null;
    statusAgeSeconds: number;
    statusState: string | null;
    statusStaleSeconds: number;
    subtype: string | null;
    summary: string | null;
    taskName: string | null;
    terminal: TerminalChoice;
    text: string | null;
    terminalStaleSeconds: number;
    tmuxSession: string | null;
    transcriptMode: TranscriptCaptureMode;
    requireSegment: boolean;
    worker: string | null;
    manager: string | null;
    maxIterations: number | null;
    zip: boolean;
    requiredBeforeContinue: string[];
    runName: string | null;
    seedPromptSha256: string | null;
    sessionDir: string | null;
    template: string | null;
    adversarial: boolean;
    cleanupPolicy: string;
    captureTranscriptBeforeStop: boolean;
    captureTranscriptLines: number;
    captureTranscriptMode: TranscriptCaptureMode;
    decisionId: number | null;
    force: boolean;
    message: string | null;
    reason: string | null;
    requireAcks: boolean;
    requireAdversarialProof: boolean;
    requireCriteriaAudit: boolean;
    requireEpilogue: boolean;
    requireTranscriptSegment: boolean;
    sandbox: string | null;
    stopManager: boolean;
    stopWorker: boolean;
    strictDecisions: boolean;
    taskGoal: string | null;
    timeoutSeconds: number;
    acceptTrust: boolean;
    askForApproval: string | null;
    codexProfile: string | null;
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
    currentIteration: 1,
    cwd: null,
    dryRun: false,
    eventType: null,
    file: null,
    goal: null,
    keepLatest: 20,
    lines: DEFAULT_HISTORY_LINES,
    limit: null,
    names: [],
    nextAction: null,
    output: null,
    path: null,
    pid: null,
    role: "all",
    roleProvided: false,
    refresh: true,
    sessionRole: null,
    sessionState: null,
    statusAgeSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    statusState: null,
    statusStaleSeconds: DEFAULT_STATUS_STALE_SECONDS,
    subtype: null,
    summary: null,
    taskName: null,
    terminal: "auto",
    text: null,
    terminalStaleSeconds: DEFAULT_TERMINAL_STALE_SECONDS,
    tmuxSession: null,
    transcriptMode: "segment",
    requireSegment: false,
    worker: null,
    manager: null,
    maxIterations: null,
    zip: false,
    requiredBeforeContinue: [],
    runName: null,
    seedPromptSha256: null,
    sessionDir: null,
    template: null,
    adversarial: false,
    cleanupPolicy: "clear",
    captureTranscriptBeforeStop: false,
    captureTranscriptLines: DEFAULT_HISTORY_LINES,
    captureTranscriptMode: "segment",
    decisionId: null,
    force: false,
    message: null,
    reason: null,
    requireAcks: false,
    requireAdversarialProof: false,
    requireCriteriaAudit: false,
    requireEpilogue: false,
    requireTranscriptSegment: false,
    sandbox: null,
    stopManager: false,
    stopWorker: false,
    strictDecisions: false,
    taskGoal: null,
    timeoutSeconds: 15,
    acceptTrust: false,
    askForApproval: null,
    codexProfile: null,
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
    } else if (arg === "--force") {
      if (command !== "open") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --force", explicit, flags, task };
      }
      flags.force = true;
    } else if (arg === "--terminal") {
      if (command !== "open" && command !== "open-worker" && command !== "open-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --terminal", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = parsedValue.value;
      if (!isTerminalChoice(value)) {
        return { command, enabled, error: `Unsupported terminal: ${value}`, explicit, flags, task };
      }
      flags.terminal = value;
      index += 1;
    } else if (arg === "--accept-trust") {
      if (command !== "start-worker" && command !== "start-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --accept-trust", explicit, flags, task };
      }
      flags.acceptTrust = true;
    } else if (arg === "--stop-manager") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --stop-manager", explicit, flags, task };
      }
      flags.stopManager = true;
    } else if (arg === "--stop-worker") {
      if (command !== "finish-task" && command !== "stop-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --stop-worker", explicit, flags, task };
      }
      flags.stopWorker = true;
    } else if (arg === "--strict-decisions") {
      if (command !== "finish-task" && command !== "stop-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --strict-decisions", explicit, flags, task };
      }
      flags.strictDecisions = true;
    } else if (arg === "--capture-transcript-before-stop") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --capture-transcript-before-stop", explicit, flags, task };
      }
      flags.captureTranscriptBeforeStop = true;
    } else if (arg === "--require-transcript-segment") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-transcript-segment", explicit, flags, task };
      }
      flags.requireTranscriptSegment = true;
    } else if (arg === "--require-criteria-audit") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-criteria-audit", explicit, flags, task };
      }
      flags.requireCriteriaAudit = true;
    } else if (arg === "--require-acks") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-acks", explicit, flags, task };
      }
      flags.requireAcks = true;
    } else if (arg === "--require-epilogue") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-epilogue", explicit, flags, task };
      }
      flags.requireEpilogue = true;
    } else if (arg === "--require-adversarial-proof") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-adversarial-proof", explicit, flags, task };
      }
      flags.requireAdversarialProof = true;
    } else if (arg === "--adversarial") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --adversarial", explicit, flags, task };
      }
      flags.adversarial = true;
    } else if (arg === "--require-segment") {
      if (command !== "transcript-capture") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-segment", explicit, flags, task };
      }
      flags.requireSegment = true;
    } else if (arg === "--no-refresh") {
      if (command !== "status" && command !== "idle-check") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --no-refresh", explicit, flags, task };
      }
      flags.refresh = false;
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
    } else if (arg === "--sandbox") {
      if (command !== "start-worker" && command !== "start-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --sandbox", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.sandbox = value.value;
      index += 1;
    } else if (arg === "--ask-for-approval") {
      if (command !== "start-worker" && command !== "start-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --ask-for-approval", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.askForApproval = value.value;
      index += 1;
    } else if (arg === "--codex-profile") {
      if (command !== "start-worker" && command !== "start-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --codex-profile", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.codexProfile = value.value;
      index += 1;
    } else if (arg === "--session-dir") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --session-dir", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.sessionDir = value.value;
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
    } else if (arg === "--task-goal") {
      if (command !== "start-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --task-goal", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.taskGoal = value.value;
      index += 1;
    } else if (arg === "--worker") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.worker = value.value;
      index += 1;
    } else if (arg === "--reason") {
      if (command !== "finish-task" && command !== "stop-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --reason", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.reason = value.value;
      index += 1;
    } else if (arg === "--message") {
      if (command !== "finish-task" && command !== "stop-task" && command !== "stop") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --message", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.message = value.value;
      index += 1;
    } else if (arg === "--decision-id") {
      if (command !== "finish-task" && command !== "stop-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --decision-id", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--decision-id must be an integer.", explicit, flags, task };
      }
      flags.decisionId = value;
      index += 1;
    } else if (arg === "--manager") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.manager = value.value;
      index += 1;
    } else if (arg === "--template") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --template", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.template = value.value;
      index += 1;
    } else if (arg === "--run-name") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --run-name", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.runName = value.value;
      index += 1;
    } else if (arg === "--seed-prompt-sha256") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --seed-prompt-sha256", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.seedPromptSha256 = value.value;
      index += 1;
    } else if (arg === "--required-before-continue") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --required-before-continue", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.requiredBeforeContinue.push(value.value);
      index += 1;
    } else if (arg === "--cleanup-policy") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --cleanup-policy", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.cleanupPolicy = value.value;
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
    } else if (arg === "--mode") {
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = parsedValue.value;
      if (!isTranscriptCaptureMode(value)) {
        return { command, enabled, error: `Unsupported transcript capture mode: ${value}`, explicit, flags, task };
      }
      flags.transcriptMode = value;
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
    } else if (arg === "--lines") {
      if (command !== "capture" && command !== "status" && command !== "idle-check" && command !== "transcript-capture") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --lines", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--lines must be an integer.", explicit, flags, task };
      }
      flags.lines = value;
      index += 1;
    } else if (arg === "--status-stale-seconds") {
      if (command !== "idle-check") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --status-stale-seconds", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--status-stale-seconds must be an integer.", explicit, flags, task };
      }
      flags.statusStaleSeconds = value;
      index += 1;
    } else if (arg === "--terminal-stale-seconds") {
      if (command !== "idle-check") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --terminal-stale-seconds", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--terminal-stale-seconds must be an integer.", explicit, flags, task };
      }
      flags.terminalStaleSeconds = value;
      index += 1;
    } else if (arg === "--capture-transcript-lines") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --capture-transcript-lines", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--capture-transcript-lines must be an integer.", explicit, flags, task };
      }
      flags.captureTranscriptLines = value;
      index += 1;
    } else if (arg === "--capture-transcript-mode") {
      if (command !== "finish-task") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --capture-transcript-mode", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = parsedValue.value;
      if (!isTranscriptCaptureMode(value)) {
        return { command, enabled, error: `Unsupported transcript capture mode: ${value}`, explicit, flags, task };
      }
      flags.captureTranscriptMode = value;
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
    } else if (arg === "--max-iterations") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --max-iterations", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--max-iterations must be an integer.", explicit, flags, task };
      }
      flags.maxIterations = value;
      index += 1;
    } else if (arg === "--current-iteration") {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --current-iteration", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--current-iteration must be an integer.", explicit, flags, task };
      }
      flags.currentIteration = value;
      index += 1;
    } else if (arg === "--timeout-seconds") {
      if (command !== "start-worker" && command !== "start-manager") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --timeout-seconds", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value <= 0) {
        return { command, enabled, error: "--timeout-seconds must be a positive integer.", explicit, flags, task };
      }
      flags.timeoutSeconds = value;
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

function runCreateDisposableBindingCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedCreateDisposableBindingOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (parsed.flags.template !== null) {
    loopTemplate(parsed.flags.template);
  }
  const taskName = requireTask(parsed);
  const dbPath = runtimeDbPath(parsed, options);
  const sessionDir = resolve(parsed.flags.sessionDir ?? join(dirname(dbPath), "disposable-sessions"));
  const cwd = resolve(parsed.flags.cwd ?? options.cwd ?? process.cwd());
  const workerName = parsed.flags.worker ?? `${taskName}-worker`;
  const managerName = parsed.flags.manager ?? `${taskName}-manager`;
  const requiredBeforeContinue = uniqueRequiredEvidence([
    ...parsed.flags.requiredBeforeContinue,
    ...(parsed.flags.adversarial ? ["adversarial_check"] : []),
  ]);
  const database = openRuntimeDatabase(parsed, options);
  try {
    let task = taskRowForLifecycle(database, taskName);
    const createdTask = task === null;
    if (createdTask) {
      const taskId = createTaskSync(database, {
        goal: parsed.flags.goal ?? "Disposable no-tmux Ralph-loop task.",
        name: taskName,
        summary: parsed.flags.summary,
      });
      task = taskRowById(database, taskId);
    }
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    database.prepare("update tasks set state = 'managed', updated_at = ? where id = ?")
      .run(new Date().toISOString(), task.id);
    task = taskRowById(database, task.id);

    const workerRollout = writeDisposableRollout(sessionDir, workerName, cwd);
    const managerRollout = writeDisposableRollout(sessionDir, managerName, cwd);
    const worker = registerSessionSync(database, {
      codexSessionPath: workerRollout.path,
      cwd,
      name: workerName,
      pid: process.pid,
      role: "worker",
      tmuxSession: null,
    });
    const manager = registerSessionSync(database, {
      codexSessionPath: managerRollout.path,
      cwd,
      name: managerName,
      pid: process.pid,
      role: "manager",
      tmuxSession: null,
    });
    const bindingId = bindSessionsSync(database, {
      managerSessionName: managerName,
      taskName: task.name,
      workerSessionName: workerName,
    });
    const run = createDisposablePolicyRunSync(database, {
      cleanupPolicy: parsed.flags.cleanupPolicy,
      currentIteration: parsed.flags.currentIteration,
      maxIterations: parsed.flags.maxIterations,
      requiredBeforeContinue,
      runName: parsed.flags.runName,
      seedPromptSha256: parsed.flags.seedPromptSha256,
      taskId: task.id,
      taskName: task.name,
      templateName: parsed.flags.template,
    });
    insertEventSync(database, {
      payload: {
        binding_id: bindingId,
        manager: managerName,
        run: run?.name ?? null,
        worker: workerName,
      },
      taskId: task.id,
      type: "disposable_binding_created",
    });
    const result = {
      binding: { id: bindingId },
      db_path: dbPath,
      manager: {
        communication: disposableSessionCommunication("manager", task.name, dbPath),
        id: manager.session_id,
        name: managerName,
        rollout_path: managerRollout.path,
        tmux_session: null,
      },
      replay_commands: disposableReplayCommands({
        adversarial: parsed.flags.adversarial,
        dbPath,
        managerName,
        requiredBeforeContinue,
        runName: run?.name ?? null,
        sessionDir,
        taskName: task.name,
        templateName: parsed.flags.template,
        workerName,
      }),
      run,
      task: {
        created: createdTask,
        id: task.id,
        name: task.name,
        state: task.state,
      },
      worker: {
        communication: disposableSessionCommunication("worker", task.name, dbPath),
        id: worker.session_id,
        name: workerName,
        rollout_path: workerRollout.path,
        tmux_session: null,
      },
      worker_handoff: disposableWorkerHandoff(task.name, run?.name ?? null, dbPath),
    };
    if (parsed.flags.json) {
      return jsonResult(result);
    }
    return { exitCode: 0, handled: true, stdout: renderDisposableBindingText(result) };
  } finally {
    database.close();
  }
}

function runLifecycleTaskCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
  finish: boolean,
): TypescriptRuntimeResult {
  const unsupported = unsupportedLifecycleTaskOptions(parsed, finish);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const commandType = finish ? "finish_task" : "stop_task";
  const eventPrefix = finish ? "finish_task" : "stop_task";
  const reason = parsed.flags.reason ?? (finish ? "Task finished by operator." : "Task stopped by operator.");
  const stopManager = finish ? parsed.flags.stopManager : true;
  const stopWorker = parsed.flags.stopWorker;
  const message = parsed.flags.message;
  const captureTranscriptBeforeStop = finish && parsed.flags.captureTranscriptBeforeStop;
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForLifecycle(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    if (task.state === "done" || task.state === "failed") {
      throw new Error(`Task ${task.name} is already ${task.state}`);
    }
    const binding = activeLifecycleBinding(database, task.id);
    const requireCriteriaAudit = finish && parsed.flags.requireCriteriaAudit;
    const requireAcks = finish && parsed.flags.requireAcks;
    const requireEpilogue = finish && parsed.flags.requireEpilogue;
    const requireAdversarialProof = finish && parsed.flags.requireAdversarialProof;
    if (requireAdversarialProof && !taskHasSatisfiedAdversarialProofSync(database, task.id)) {
      return lifecycleWorkerErrorResult(adversarialProofError(task.name));
    }
    const managerDecision = assessManagerDecisionSync(database, {
      decisionId: parsed.flags.decisionId,
      taskId: task.id,
    });
    const decisionError = strictManagerDecisionError(commandType, managerDecision, parsed.flags.strictDecisions);
    if (decisionError !== null) {
      return lifecycleWorkerErrorResult(decisionError);
    }
    const finalAudit = finish ? finalCriteriaAuditSync(database, task.id, requireCriteriaAudit) : null;
    const finalAckAudit = finish ? finalAckAuditSync(database, task.id, requireAcks) : null;
    const finalEpilogueAudit = finish ? finalEpilogueAuditSync(database, task.id, requireEpilogue) : null;
    if (finish && finalAudit && requireCriteriaAudit) {
      const auditError = finalCriteriaAuditError(finalAudit, task.name);
      if (auditError !== null) {
        return failLifecycleGateSync(database, {
          audit: finalAudit,
          auditKey: "final_audit",
          commandType,
          error: auditError,
          eventPrefix,
          failureStage: "final_criteria_audit",
          finish,
          reason,
          stopManager,
          taskId: task.id,
          taskName: task.name,
        });
      }
    }
    if (finish && finalAckAudit && requireAcks) {
      const ackError = finalAckAuditError(finalAckAudit, task.name);
      if (ackError !== null) {
        return failLifecycleGateSync(database, {
          audit: finalAckAudit,
          auditKey: "final_ack_audit",
          commandType,
          error: ackError,
          eventPrefix,
          failureStage: "final_ack_audit",
          finish,
          reason,
          stopManager,
          taskId: task.id,
          taskName: task.name,
        });
      }
    }
    if (finish && finalEpilogueAudit && requireEpilogue) {
      const epilogueError = finalEpilogueAuditError(finalEpilogueAudit, task.name);
      if (epilogueError !== null) {
        return failLifecycleGateSync(database, {
          audit: finalEpilogueAudit,
          auditKey: "final_epilogue_audit",
          commandType,
          error: epilogueError,
          eventPrefix,
          failureStage: "final_epilogue_audit",
          finish,
          reason,
          stopManager,
          taskId: task.id,
          taskName: task.name,
        });
      }
    }
    const payload = {
      ...(finish && finalAckAudit ? { final_ack_audit: finalAckAudit } : {}),
      ...(finish && finalAudit ? { final_audit: finalAudit } : {}),
      ...(finish && finalEpilogueAudit ? { final_epilogue_audit: finalEpilogueAudit } : {}),
      already_done_followup: false,
      capture_transcript_before_stop: captureTranscriptBeforeStop,
      capture_transcript_lines: parsed.flags.captureTranscriptLines,
      capture_transcript_mode: parsed.flags.captureTranscriptMode,
      finish,
      manager_decision: managerDecision,
      manager_session: binding?.manager_session_name ?? null,
      message,
      reason,
      stop_manager: stopManager,
      stop_worker: stopWorker,
      task: task.name,
      worker: binding?.worker_session_name ?? null,
      worker_session: binding?.worker_session_name ?? null,
    };
    const commandId = createCommandSync(database, {
      commandType,
      payload,
      taskId: task.id,
    });
    const finalDecisionId = finish
      ? insertFinalManagerDecisionSync(database, {
        commandId,
        reason,
        taskId: task.id,
      })
      : null;
    const finalObservationId = finish
      ? insertFinalAgentObservationSync(database, {
        commandId,
        decisionId: finalDecisionId,
        message: reason,
        taskId: task.id,
      })
      : null;
    insertEventSync(database, {
      commandId,
      payload: {
        ...(finish && finalAckAudit ? { final_ack_audit: finalAckAudit } : {}),
        ...(finish && finalAudit ? { final_audit: finalAudit } : {}),
        ...(finish && finalEpilogueAudit ? { final_epilogue_audit: finalEpilogueAudit } : {}),
        capture_transcript_before_stop: captureTranscriptBeforeStop,
        capture_transcript_lines: parsed.flags.captureTranscriptLines,
        capture_transcript_mode: parsed.flags.captureTranscriptMode,
        final_decision_id: finalDecisionId,
        final_observation_id: finalObservationId,
        finish,
        manager_decision: managerDecision,
        message,
        reason,
        stop_manager: stopManager,
        stop_worker: stopWorker,
      },
      taskId: task.id,
      type: `${eventPrefix}_intent`,
    });
    markImmediateCommandAttemptedSync(database, commandId);
    try {
      if (finish && finalAudit) {
        insertEventSync(database, {
          commandId,
          payload: finalAudit,
          taskId: task.id,
          type: "finish_task_criteria_audit",
        });
      }
      const runner = options.tmuxRunner ?? defaultTmuxRunner;
      const workerContext = stopWorker ? sessionTranscriptCaptureContext(database, task.name, "worker", options) : null;
      const managerContext = stopManager ? sessionTranscriptCaptureContext(database, task.name, "manager", options) : null;
      const preStopTranscriptCaptures: TranscriptCaptureCommandCapture[] = [];
      if (captureTranscriptBeforeStop && parsed.flags.requireTranscriptSegment) {
        const missing: string[] = [];
        if (stopWorker && workerContext === null) {
          missing.push("worker");
        }
        if (stopManager && managerContext === null) {
          missing.push("manager");
        }
        if (missing.length > 0) {
          throw new Error(`no non-empty transcript segment captured for role(s): ${missing.join(", ")}`);
        }
      }
      if (captureTranscriptBeforeStop) {
        for (const context of [workerContext, managerContext]) {
          if (context === null) {
            continue;
          }
          preStopTranscriptCaptures.push(captureTaskTerminalSync(database, {
            context,
            historyLines: parsed.flags.captureTranscriptLines,
            mode: parsed.flags.captureTranscriptMode,
            now: nowIsoSeconds(options),
            parsed,
            runner,
            runtimeOptions: options,
            source: "finish_task_pre_stop",
          }));
        }
        if (parsed.flags.requireTranscriptSegment) {
          const missing = preStopTranscriptCaptures
            .filter((capture) => "error" in capture || !capture.transcript_segment || (capture.transcript_segment.line_count ?? 0) <= 0)
            .map((capture) => capture.role);
          if (missing.length > 0) {
            throw new Error(`no non-empty transcript segment captured for role(s): ${missing.join(", ")}`);
          }
        }
        if (preStopTranscriptCaptures.length > 0) {
          insertEventSync(database, {
            commandId,
            payload: {
              captures: preStopTranscriptCaptures,
              lines: parsed.flags.captureTranscriptLines,
              mode: parsed.flags.captureTranscriptMode,
            },
            taskId: task.id,
            type: "finish_task_pre_stop_transcript_captured",
          });
        }
      }
      let killedWorker = false;
      let killedManager = false;
      if (stopWorker && workerContext?.session.tmux_session) {
        if (message !== null) {
          sendTextToSessionWithRunner(workerContext.session, message, runner);
        }
        killTmuxSessionWithRunner(workerContext.session.tmux_session, runner);
        killedWorker = true;
      }
      if (stopManager && managerContext?.session.tmux_session) {
        killTmuxSessionWithRunner(managerContext.session.tmux_session, runner);
        killedManager = true;
      }
      const stoppedAt = new Date().toISOString();
      if (stopWorker && workerContext?.session.id && killedWorker) {
        database.prepare("update sessions set state = 'gone', last_heartbeat_at = ? where id = ?")
          .run(stoppedAt, workerContext.session.id);
      }
      if (stopManager && managerContext?.session.id && killedManager) {
        database.prepare("update sessions set state = 'gone', last_heartbeat_at = ? where id = ?")
          .run(stoppedAt, managerContext.session.id);
      }
      endActiveBindingForTaskSync(database, task.id, stoppedAt);
      database.prepare("update tasks set state = 'done', updated_at = ? where id = ?")
        .run(stoppedAt, task.id);
      const finishedRun = finishActiveRunForTaskSync(database, {
        status: finish ? "finished" : "abandoned",
        taskId: task.id,
        timestamp: stoppedAt,
      });
      const result = {
        ...(finish && finalAckAudit ? { final_ack_audit: finalAckAudit } : {}),
        ...(finish && finalAudit ? { final_audit: finalAudit } : {}),
        ...(finish && finalEpilogueAudit ? { final_epilogue_audit: finalEpilogueAudit } : {}),
        already_done_followup: false,
        command_id: commandId,
        final_decision_id: finalDecisionId,
        final_observation_id: finalObservationId,
        finish,
        killed_manager: killedManager,
        killed_worker: killedWorker,
        manager_decision: managerDecision,
        manager_session: binding?.manager_session_name ?? null,
        pre_stop_transcript_captures: preStopTranscriptCaptures,
        reason,
        stop_manager: stopManager,
        stop_worker: stopWorker,
        task: task.name,
        worker: binding?.worker_session_name ?? null,
        worker_session: binding?.worker_session_name ?? null,
      };
      finishImmediateCommandSync(database, {
        commandId,
        result,
        state: "succeeded",
        timestamp: stoppedAt,
      });
      insertEventSync(database, {
        commandId,
        payload: result,
        taskId: task.id,
        type: `${eventPrefix}_succeeded`,
      });
      emitTelemetrySync(database, {
        actor: "workerctl",
        attributes: {
          already_done_followup: false,
          killed_manager: killedManager,
          killed_worker: killedWorker,
          reason,
          run_status: finishedRun?.status ?? null,
          stop_manager: stopManager,
          stop_worker: stopWorker,
        },
        correlation: {
          command_id: commandId,
          run_id: finishedRun?.id ?? null,
        },
        eventType: finish ? "task_finished" : "task_stopped",
        severity: "info",
        summary: `${finish ? "Finished" : "Stopped"} task ${task.name}.`,
        taskId: task.id,
        timestamp: stoppedAt,
      });
      return jsonResult(result);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const messageText = error instanceof Error ? error.message : String(error);
      const result = {
        already_done_followup: false,
        command_id: commandId,
        error: messageText,
        error_type: "WorkerError",
        expected_failure: true,
        failure_stage: "live_lifecycle_side_effects",
        finish,
        manager_decision: managerDecision,
        manager_session: binding?.manager_session_name ?? null,
        reason,
        stop_manager: stopManager,
        stop_worker: stopWorker,
        task: task.name,
        worker: binding?.worker_session_name ?? null,
        worker_session: binding?.worker_session_name ?? null,
      };
      finishImmediateCommandSync(database, {
        commandId,
        error: messageText,
        result,
        state: "failed",
        timestamp: failedAt,
      });
      insertEventSync(database, {
        commandId,
        payload: result,
        taskId: task.id,
        type: `${eventPrefix}_failed`,
      });
      return lifecycleWorkerErrorResult(messageText);
    }
  } finally {
    database.close();
  }
}

function runStartSessionCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
  role: "manager" | "worker",
): TypescriptRuntimeResult {
  const unsupported = unsupportedStartSessionOptions(parsed, role);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.flags.names[0];
  if (!name) {
    return errorResult(`start-${role} requires --name.`);
  }
  const cwd = parsed.flags.cwd ?? options.cwd ?? process.cwd();
  const tmuxSessionName = tmuxSession(name);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const existing = database.prepare("select id from sessions where name = ?").get(name) as { id: string } | undefined;
    if (existing) {
      return lifecycleWorkerErrorResult(
        `a session named ${JSON.stringify(name)} is already registered; choose a different name or \`conveyor deregister ${name}\` first`,
      );
    }
    const runner = options.tmuxRunner ?? defaultTmuxRunner;
    if (sessionExists(name, runner)) {
      return lifecycleWorkerErrorResult(
        `tmux session ${JSON.stringify(tmuxSessionName)} already exists; choose a different name or \`tmux kill-session -t ${tmuxSessionName}\` first`,
      );
    }
    const startup = resolveCodexStartupOptions({
      askForApproval: parsed.flags.askForApproval,
      profile: parsed.flags.codexProfile,
      sandbox: parsed.flags.sandbox,
    });
    const initialPrompt = role === "manager"
      ? startManagerBootstrapPrompt(database, {
        cwd,
        managerName: name,
        taskGoal: parsed.flags.taskGoal,
        taskName: parsed.flags.taskName,
        workerName: parsed.flags.worker,
      })
      : parsed.flags.taskName;
    const codexExecutable = options.codexCommandResolver?.("codex") ?? "codex";
    const codexArgs = [codexExecutable];
    if (startup.sandbox) {
      codexArgs.push("--sandbox", startup.sandbox);
    }
    if (startup.askForApproval) {
      codexArgs.push("--ask-for-approval", startup.askForApproval);
    }
    if (initialPrompt) {
      codexArgs.push(initialPrompt);
    }
    const shellCommand = codexTmuxShellCommand(codexArgs);
    const minimumSessionTimestamp = options.now?.() ?? new Date();
    startTmuxSessionWithRunner({ cwd, shellCommand, tmuxSessionName }, runner);
    if (parsed.flags.acceptTrust) {
      sendEnterToTmuxSessionWithRunner(tmuxSessionName, runner);
    }
    let discovery: SpawnedCodexSessionDiscovery;
    try {
      discovery = (options.discoverSpawnedCodexSession ?? defaultDiscoverSpawnedCodexSession)({
        acceptTrust: parsed.flags.acceptTrust,
        childrenForPid: options.childrenForPid,
        lsofForPid: options.lsofForPid,
        minimumSessionTimestamp,
        sleepMilliseconds: options.sleepMilliseconds,
        timeoutSeconds: parsed.flags.timeoutSeconds,
        tmuxRunner: runner,
        tmuxSessionName,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return lifecycleWorkerErrorResult(
        `${detail}\nRecovery: tmux session ${JSON.stringify(tmuxSessionName)} may still be alive. `
        + `Inspect it with \`tmux attach -t ${tmuxSessionName}\`. If Codex is visible, submit a prompt or press Enter, `
        + `then register it with \`conveyor register-${role} --name ${name} --pid <pid> --codex-session <rollout.jsonl> `
        + `--cwd ${shellQuote(cwd)} --tmux-session ${tmuxSessionName}\`. To clean up, run `
        + `\`tmux kill-session -t ${tmuxSessionName}\` and \`conveyor deregister ${name}\` if it was registered.`,
      );
    }
    const registered = registerSessionSync(database, {
      codexSessionPath: discovery.codex_session_path,
      cwd,
      name,
      pid: discovery.native_pid,
      role,
      tmuxSession: tmuxSessionName,
    });
    insertEventSync(database, {
      payload: {
        codex_session_id: registered.codex_session_id,
        name,
        pid: registered.pid,
        role,
        session_id: registered.session_id,
        via: `start-${role}`,
      },
      type: "session_registered",
    });
    return jsonResult({
      codex_session_id: registered.codex_session_id,
      codex_session_path: registered.codex_session_path,
      cwd: registered.cwd,
      name: registered.name,
      pid: registered.pid,
      role: registered.role,
      session_id: registered.session_id,
      tmux_session: registered.tmux_session,
    });
  } finally {
    database.close();
  }
}

function runOpenCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  const unsupported = unsupportedOpenOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task;
  if (!name) {
    return errorResult("open requires a worker name.");
  }
  try {
    requireWorkerConfig(name, options);
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    return lifecycleWorkerErrorResult("conveyor open is currently implemented for macOS only.");
  }
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  const tmuxSessionName = tmuxSession(name);
  try {
    if (!sessionExists(name, runner)) {
      return lifecycleWorkerErrorResult(`tmux session is not running for worker ${name}: ${tmuxSessionName}`);
    }
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  const priorOpen = lastOpenCompatibilityEvent(name, options);
  if (priorOpen && !parsed.flags.force) {
    const priorAction = priorOpen.type === "open_attempt" ? "terminal launch attempted" : "terminal opened";
    const time = typeof priorOpen.time === "string" ? priorOpen.time : "unknown time";
    return lifecycleWorkerErrorResult(
      `Worker ${name} already had a ${priorAction} at ${time}. `
      + `Attach manually with \`${attachSessionCommand(tmuxSessionName)}\` or rerun with --force if you intentionally want another window.`,
    );
  }

  const selectedTerminal = resolveTerminal(parsed.flags.terminal);
  const command = terminalOpenCommand(tmuxSessionName, selectedTerminal);
  const result: Record<string, unknown> = {
    attach_command: attachSessionCommand(tmuxSessionName),
    dry_run: parsed.flags.dryRun,
    force: parsed.flags.force,
    name,
    terminal: selectedTerminal,
    tmux_session: tmuxSessionName,
  };
  if (parsed.flags.dryRun) {
    result.command = command;
    return jsonResult(result);
  }
  appendCompatibilityEvent(name, "open_attempt", { forced: parsed.flags.force, terminal: selectedTerminal }, options);
  try {
    runTerminalCommand(command, options);
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  appendCompatibilityEvent(name, "open", { forced: parsed.flags.force, terminal: selectedTerminal }, options);
  return jsonResult(result);
}

function runOpenTaskSessionCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
  role: "manager" | "worker",
): TypescriptRuntimeResult {
  const unsupported = unsupportedOpenTaskSessionOptions(parsed, role);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return errorResult(`open-${role} requires a task.`);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const snapshot = taskSnapshot(database, parsed.task);
    const binding = activeBindingForTaskSync(database, parsed.task);
    const sessionName = role === "worker" ? binding.worker_session_name : binding.manager_session_name;
    const session = sessionRow(database, sessionName, role);
    if (!session.tmux_session) {
      return lifecycleWorkerErrorResult(`Task ${snapshot.name} has no active ${role}`);
    }
    const opened = openTmuxSessionWindow(session.tmux_session, parsed, options);
    if (opened.exitCode !== 0) {
      return opened;
    }
    const result = JSON.parse(opened.stdout ?? "{}") as Record<string, unknown>;
    result.task = snapshot.name;
    result[role] = session.name;
    return jsonResult(result);
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  } finally {
    database.close();
  }
}

function openTmuxSessionWindow(
  sessionName: string,
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  if ((options.platform ?? process.platform) !== "darwin") {
    return lifecycleWorkerErrorResult("conveyor terminal opening commands are currently implemented for macOS only.");
  }
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  try {
    if (!tmuxSessionRunning(sessionName, runner)) {
      return lifecycleWorkerErrorResult(`tmux session is not running: ${sessionName}`);
    }
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }

  const selectedTerminal = resolveTerminal(parsed.flags.terminal);
  const command = terminalOpenCommand(sessionName, selectedTerminal);
  const result: Record<string, unknown> = {
    attach_command: attachSessionCommand(sessionName),
    dry_run: parsed.flags.dryRun,
    terminal: selectedTerminal,
    tmux_session: sessionName,
  };
  if (parsed.flags.dryRun) {
    result.command = command;
    return jsonResult(result);
  }
  try {
    runTerminalCommand(command, options);
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  return jsonResult(result);
}

function runStopCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  const unsupported = unsupportedStopOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task;
  if (!name) {
    return errorResult("stop requires a worker or session name.");
  }
  let config: LiveWorkerConfig;
  try {
    config = workerConfigOrSession(name, parsed, options);
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  if (config._workerctl_lookup_source === "legacy") {
    return stopLegacyWorker(name, parsed, options, config, runner);
  }
  return stopRegisteredSession(name, parsed, options, config, runner);
}

function stopLegacyWorker(
  name: string,
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
  config: LiveWorkerConfig,
  runner: TmuxRunner,
): TypescriptRuntimeResult {
  try {
    if (parsed.flags.message && sessionExistsForConfig(name, config, { tmuxRunner: runner })) {
      sendTextToLegacyWorker(name, parsed.flags.message, runner);
      appendCompatibilityEvent(name, "stop_message", { message: parsed.flags.message }, options);
    }
    if (sessionExistsForConfig(name, config, { tmuxRunner: runner })) {
      killTmuxSessionWithRunner(tmuxTargetForConfig(name, config), runner);
      appendCompatibilityEvent(name, "stop", { killed_session: true }, options);
      return { exitCode: 0, handled: true, stdout: `stopped ${name}\n` };
    }
    appendCompatibilityEvent(name, "stop", { killed_session: false }, options);
    return { exitCode: 0, handled: true, stdout: `${name} was not running\n` };
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
}

function stopRegisteredSession(
  name: string,
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
  config: LiveWorkerConfig,
  runner: TmuxRunner,
): TypescriptRuntimeResult {
  const target = tmuxTargetForConfig(name, config);
  let running: boolean;
  try {
    running = sessionExistsForConfig(name, config, { tmuxRunner: runner });
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }

  if (parsed.flags.message && running) {
    const database = openRuntimeDatabase(parsed, options);
    try {
      const session = sessionRow(database, name);
      sendTextToSessionWithRunner(session, parsed.flags.message, runner, { now: () => nowIsoSeconds(options) });
      insertEventSync(database, {
        payload: {
          role: config.role,
          session: name,
          target,
          text_length: parsed.flags.message.length,
        },
        type: "session_stop_message",
      });
    } catch (error) {
      return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
    } finally {
      database.close();
    }
  }

  let killed = false;
  try {
    if (running) {
      killTmuxSessionWithRunner(target, runner);
      killed = true;
    }
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }

  const stoppedAt = nowIsoSeconds(options);
  const database = openRuntimeDatabase(parsed, options);
  try {
    database.prepare("update sessions set state = 'gone', last_heartbeat_at = ? where name = ?")
      .run(stoppedAt, name);
    insertEventSync(database, {
      payload: {
        killed_session: killed,
        role: config.role,
        session: name,
        target,
      },
      type: "session_stopped",
    });
  } finally {
    database.close();
  }
  appendCompatibilityEvent(name, "stop", {
    killed_session: killed,
    lookup_source: "session",
    role: config.role,
    target,
  }, options);
  return {
    exitCode: 0,
    handled: true,
    stdout: killed ? `stopped ${name}\n` : `${name} was not running\n`,
  };
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

function runTranscriptCaptureCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedTranscriptCaptureOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const task = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const roles: Array<"manager" | "worker"> = parsed.flags.role === "all"
      ? ["worker", "manager"]
      : [parsed.flags.role as "manager" | "worker"];
    const captures: TranscriptCaptureCommandCapture[] = [];
    for (const role of roles) {
      try {
        const context = sessionTranscriptCaptureContext(database, task, role, options);
        if (!context) {
          throw new Error(`transcript-capture ${role} role requires a session-bound ${role} binding.`);
        }
        captures.push(captureTaskTerminalSync(database, {
          context,
          historyLines: parsed.flags.lines,
          mode: parsed.flags.transcriptMode,
          now: nowIsoSeconds(options),
          parsed,
          runner: options.tmuxRunner ?? defaultTmuxRunner,
          runtimeOptions: options,
          source: "transcript_capture",
        }));
      } catch (error) {
        if (parsed.flags.role !== "all") {
          throw error;
        }
        captures.push({
          error: error instanceof Error ? error.message : String(error),
          role,
        });
      }
    }
    if (parsed.flags.requireSegment) {
      const missing = captures
        .filter((capture) => {
          if ("error" in capture) {
            return true;
          }
          return !capture.transcript_segment || Number(capture.transcript_segment.line_count ?? 0) <= 0;
        })
        .map((capture) => capture.role);
      if (missing.length > 0) {
        throw new Error(`no non-empty transcript segment captured for role(s): ${missing.join(", ")}`);
      }
    }
    const result = {
      captures,
      mode: parsed.flags.transcriptMode,
      role: parsed.flags.role,
      task,
    };
    if (parsed.flags.json) {
      return jsonResult(parsed.flags.includeContent ? result : redactCaptureResult(result));
    }
    return { exitCode: 0, handled: true, stdout: renderTranscriptCaptureText(captures) };
  } finally {
    database.close();
  }
}

function runCaptureCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedCaptureOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "capture requires a worker or session name.");
  }
  const { output } = captureOutputForConfig(parsed.task, workerConfigOrSession(parsed.task, parsed, options), parsed.flags.lines, parsed, options);
  if (parsed.flags.includeContent) {
    return { exitCode: 0, handled: true, stdout: output ? `${output}\n` : "" };
  }
  const captureMeta = loadJsonSync<Record<string, unknown>>(captureMetaPath(parsed.task, options), {});
  return jsonResult({
    byte_count: Buffer.byteLength(output),
    content_redacted: true,
    history_lines: parsed.flags.lines,
    line_count: pythonSplitlinesCount(output),
    name: parsed.task,
    sha256: captureMeta.sha256 ?? null,
    transcript_path: transcriptPath(parsed.task, options),
  });
}

function runStatusCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedStatusOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "status requires a worker or session name.");
  }
  const config = workerConfigOrSession(parsed.task, parsed, options);
  const status = latestStatusSync(parsed.task, options);
  let captureMeta = loadJsonSync<Record<string, unknown>>(captureMetaPath(parsed.task, options), {});
  let terminalCaptureError: string | null = null;
  let running: boolean;
  try {
    running = sessionExistsForConfig(parsed.task, config, options);
  } catch (error) {
    running = false;
    terminalCaptureError = error instanceof Error ? error.message : String(error);
  }
  if (running && parsed.flags.refresh) {
    try {
      captureOutputForConfig(parsed.task, config, parsed.flags.lines, parsed, options);
      captureMeta = loadJsonSync<Record<string, unknown>>(captureMetaPath(parsed.task, options), {});
    } catch (error) {
      terminalCaptureError = error instanceof Error ? error.message : String(error);
      captureMeta = { error: terminalCaptureError };
    }
  } else if (terminalCaptureError === null && typeof captureMeta.error === "string") {
    terminalCaptureError = captureMeta.error;
  }
  const state = typeof status.state === "string" && VALID_WORKER_STATUS_STATES.has(status.state)
    ? status.state
    : "unknown";
  return jsonResult({
    blocker: status.blocker ?? null,
    current_task: status.current_task ?? null,
    name: parsed.task,
    next_action: status.next_action ?? null,
    running,
    startup: stringOrNull(config.startup),
    startup_reason: stringOrNull(config.startup_reason),
    startup_recommended_action: stringOrNull(config.startup_recommended_action),
    state,
    status_last_update: status.last_update ?? null,
    terminal_capture_error: terminalCaptureError,
    terminal_captured_at: stringOrNull(captureMeta.captured_at),
    terminal_changed_at: stringOrNull(captureMeta.changed_at),
    tmux_session: stringOrNull(config.tmux_session),
  });
}

function runIdleCheckCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedIdleCheckOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return unsupportedRuntimeResult(parsed, "idle-check requires a worker or session name.");
  }
  return jsonResult(idleSummary(parsed.task, parsed, options));
}

function openRuntimeDatabase(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const database = openDatabaseSync(runtimeDbPath(parsed, options));
  initializeDatabaseSync(database);
  return database;
}

function runtimeDbPath(parsed: ParsedRuntimeArgs, options: { cwd?: string; env?: NodeJS.ProcessEnv }): string {
  return resolve(parsed.flags.path ?? defaultDbPath({ cwd: options.cwd, env: options.env }));
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
    || command === "create-disposable-binding"
    || command === "finish-task"
    || command === "stop-task"
    || command === "start-worker"
    || command === "start-manager"
    || command === "open"
    || command === "open-worker"
    || command === "open-manager"
    || command === "stop"
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
    || command === "transcript-capture"
    || command === "capture"
    || command === "status"
    || command === "idle-check"
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

function unsupportedCreateDisposableBindingOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.create !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.codexSession !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.taskName !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for create-disposable-binding.";
  }
  return null;
}

function unsupportedLifecycleTaskOptions(parsed: ParsedRuntimeArgs, finish: boolean): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.create !== null
    || parsed.flags.dryRun
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
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.codexSession !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
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
    return `Unsupported TypeScript runtime option for ${finish ? "finish-task" : "stop-task"}.`;
  }
  if (!finish && (
    parsed.flags.captureTranscriptBeforeStop
    || parsed.flags.captureTranscriptLines !== DEFAULT_HISTORY_LINES
    || parsed.flags.captureTranscriptMode !== "segment"
    || parsed.flags.requireTranscriptSegment
  )) {
    return "Unsupported TypeScript runtime option for stop-task.";
  }
  return null;
}

function unsupportedStartSessionOptions(parsed: ParsedRuntimeArgs, role: "manager" | "worker"): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (parsed.flags.names.length !== 1) {
    return `start-${role} requires exactly one --name.`;
  }
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.captureTranscriptBeforeStop
    || parsed.flags.captureTranscriptLines !== DEFAULT_HISTORY_LINES
    || parsed.flags.captureTranscriptMode !== "segment"
    || parsed.flags.cleanupPolicy !== "clear"
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.decisionId !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.manager !== null
    || parsed.flags.maxIterations !== null
    || parsed.flags.message !== null
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.reason !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.requiredBeforeContinue.length > 0
    || parsed.flags.requireAcks
    || parsed.flags.requireAdversarialProof
    || parsed.flags.requireCriteriaAudit
    || parsed.flags.requireEpilogue
    || parsed.flags.requireSegment
    || parsed.flags.requireTranscriptSegment
    || parsed.flags.roleProvided
    || parsed.flags.runName !== null
    || parsed.flags.seedPromptSha256 !== null
    || parsed.flags.sessionDir !== null
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusState !== null
    || parsed.flags.stopManager
    || parsed.flags.stopWorker
    || parsed.flags.strictDecisions
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.template !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.zip
  ) {
    return `Unsupported TypeScript runtime option for start-${role}.`;
  }
  if (role === "worker" && (parsed.flags.taskGoal !== null || parsed.flags.worker !== null)) {
    return "Unsupported TypeScript runtime option for start-worker.";
  }
  return null;
}

function unsupportedOpenOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.captureTranscriptBeforeStop
    || parsed.flags.captureTranscriptLines !== DEFAULT_HISTORY_LINES
    || parsed.flags.captureTranscriptMode !== "segment"
    || parsed.flags.cleanupPolicy !== "clear"
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.cwd !== null
    || parsed.flags.decisionId !== null
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
    || parsed.flags.manager !== null
    || parsed.flags.maxIterations !== null
    || parsed.flags.message !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.reason !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.requiredBeforeContinue.length > 0
    || parsed.flags.requireAcks
    || parsed.flags.requireAdversarialProof
    || parsed.flags.requireCriteriaAudit
    || parsed.flags.requireEpilogue
    || parsed.flags.requireSegment
    || parsed.flags.requireTranscriptSegment
    || parsed.flags.roleProvided
    || parsed.flags.runName !== null
    || parsed.flags.seedPromptSha256 !== null
    || parsed.flags.sessionDir !== null
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusStaleSeconds !== DEFAULT_STATUS_STALE_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.strictDecisions
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskGoal !== null
    || parsed.flags.taskName !== null
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for open.";
  }
  return null;
}

function unsupportedOpenTaskSessionOptions(parsed: ParsedRuntimeArgs, role: "manager" | "worker"): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.captureTranscriptBeforeStop
    || parsed.flags.captureTranscriptLines !== DEFAULT_HISTORY_LINES
    || parsed.flags.captureTranscriptMode !== "segment"
    || parsed.flags.cleanupPolicy !== "clear"
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.cwd !== null
    || parsed.flags.decisionId !== null
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.force
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.limit !== null
    || parsed.flags.manager !== null
    || parsed.flags.maxIterations !== null
    || parsed.flags.message !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.reason !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.requiredBeforeContinue.length > 0
    || parsed.flags.requireAcks
    || parsed.flags.requireAdversarialProof
    || parsed.flags.requireCriteriaAudit
    || parsed.flags.requireEpilogue
    || parsed.flags.requireSegment
    || parsed.flags.requireTranscriptSegment
    || parsed.flags.roleProvided
    || parsed.flags.runName !== null
    || parsed.flags.seedPromptSha256 !== null
    || parsed.flags.sessionDir !== null
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusStaleSeconds !== DEFAULT_STATUS_STALE_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.strictDecisions
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskGoal !== null
    || parsed.flags.taskName !== null
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.zip
  ) {
    return `Unsupported TypeScript runtime option for open-${role}.`;
  }
  return null;
}

function unsupportedStopOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.captureTranscriptBeforeStop
    || parsed.flags.captureTranscriptLines !== DEFAULT_HISTORY_LINES
    || parsed.flags.captureTranscriptMode !== "segment"
    || parsed.flags.cleanupPolicy !== "clear"
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
    || parsed.flags.cwd !== null
    || parsed.flags.decisionId !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.force
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.limit !== null
    || parsed.flags.manager !== null
    || parsed.flags.maxIterations !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.reason !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.requiredBeforeContinue.length > 0
    || parsed.flags.requireAcks
    || parsed.flags.requireAdversarialProof
    || parsed.flags.requireCriteriaAudit
    || parsed.flags.requireEpilogue
    || parsed.flags.requireSegment
    || parsed.flags.requireTranscriptSegment
    || parsed.flags.roleProvided
    || parsed.flags.runName !== null
    || parsed.flags.seedPromptSha256 !== null
    || parsed.flags.sessionDir !== null
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusStaleSeconds !== DEFAULT_STATUS_STALE_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.strictDecisions
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskGoal !== null
    || parsed.flags.taskName !== null
    || parsed.flags.terminal !== "auto"
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for stop.";
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

function unsupportedCaptureOptions(parsed: ParsedRuntimeArgs): string | null {
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
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || !parsed.flags.refresh
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusStaleSeconds !== DEFAULT_STATUS_STALE_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for capture.";
  }
  return null;
}

function unsupportedStatusOptions(parsed: ParsedRuntimeArgs): string | null {
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
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.limit !== null
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
    || parsed.flags.statusStaleSeconds !== DEFAULT_STATUS_STALE_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for status.";
  }
  return null;
}

function unsupportedIdleCheckOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.codexSession !== null
    || parsed.flags.create !== null
    || parsed.flags.currentTask !== null
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
    return "Unsupported TypeScript runtime option for idle-check.";
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

function unsupportedTranscriptCaptureOptions(parsed: ParsedRuntimeArgs): string | null {
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
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.statusState !== null
    || parsed.flags.statusStaleSeconds !== DEFAULT_STATUS_STALE_SECONDS
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskName !== null
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for transcript-capture.";
  }
  if (parsed.flags.role !== "all" && parsed.flags.role !== "manager" && parsed.flags.role !== "worker") {
    return "TypeScript runtime transcript-capture supports --role all, --role manager, or --role worker only.";
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
  options: {
    commandId?: string | null;
    managerId?: string | null;
    payload: Record<string, unknown>;
    taskId?: string | null;
    type: string;
    workerId?: string | null;
  },
): void {
  database.prepare(`
    insert into events(created_at, actor, worker_id, manager_id, task_id, command_id, type, payload_json)
    values (?, 'workerctl', ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    options.workerId ?? null,
    options.managerId ?? null,
    options.taskId ?? null,
    options.commandId ?? null,
    options.type,
    stableJson(options.payload),
  );
}

interface DisposableRollout {
  codexSessionId: string;
  path: string;
}

interface LifecycleTaskRow {
  id: string;
  name: string;
  state: string;
}

interface LifecycleBindingRow {
  manager_session_name: string | null;
  worker_session_name: string | null;
}

interface RalphLoopRunRow {
  ended_at: string | null;
  id: string;
  metadata: Record<string, unknown>;
  name: string;
  purpose: string | null;
  started_at: string;
  status: string;
  task_id: string;
}

function taskRowForLifecycle(database: ReturnType<typeof openRuntimeDatabase>, taskName: string): LifecycleTaskRow | null {
  const row = database.prepare(`
    select id, name, state
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(taskName, taskName) as LifecycleTaskRow | undefined;
  return row ?? null;
}

function taskRowById(database: ReturnType<typeof openRuntimeDatabase>, taskId: string): LifecycleTaskRow {
  const row = database.prepare("select id, name, state from tasks where id = ?")
    .get(taskId) as LifecycleTaskRow | undefined;
  if (!row) {
    throw new Error(`Unknown task id: ${taskId}`);
  }
  return row;
}

function disposableSessionSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "session";
}

function writeDisposableRollout(sessionDir: string, sessionName: string, cwd: string): DisposableRollout {
  mkdirSync(sessionDir, { recursive: true });
  const slug = disposableSessionSlug(sessionName);
  const codexSessionId = `codex-${slug}`;
  const path = join(sessionDir, `rollout-${slug}.jsonl`);
  writeFileSync(
    path,
    `${stableJson({
      payload: {
        cwd,
        id: codexSessionId,
        originator: "conveyor create-disposable-binding",
      },
      type: "session_meta",
    })}\n`,
  );
  return { codexSessionId, path };
}

function uniqueRequiredEvidence(items: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const evidence = item.trim();
    if (!evidence) {
      throw new Error("required evidence entries must be non-empty");
    }
    if (!seen.has(evidence)) {
      seen.add(evidence);
      result.push(evidence);
    }
  }
  return result;
}

function createDisposablePolicyRunSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    cleanupPolicy: string;
    currentIteration: number;
    maxIterations: number | null;
    requiredBeforeContinue: string[];
    runName: string | null;
    seedPromptSha256: string | null;
    taskId: string;
    taskName: string;
    templateName: string | null;
  },
): RalphLoopRunRow | null {
  if (options.templateName === null && options.requiredBeforeContinue.length === 0) {
    return null;
  }
  const metadata = options.templateName === null
    ? customDisposablePolicyMetadata(options)
    : templateDisposablePolicyMetadata(options);
  return createRalphLoopRunSync(database, {
    cleanupPolicy: asString(metadata.cleanup_policy),
    currentIteration: asInteger(metadata.current_iteration, "current_iteration"),
    maxIterations: asInteger(metadata.max_iterations, "max_iterations"),
    metadata,
    preset: typeof metadata.preset === "string" ? metadata.preset : null,
    requiredBeforeContinue: asStringArray(metadata.required_before_continue),
    runName: options.runName,
    seedPromptSha256: typeof metadata.seed_prompt_sha256 === "string" ? metadata.seed_prompt_sha256 : null,
    stopConditions: asStringArray(metadata.stop_conditions),
    taskId: options.taskId,
    taskName: options.taskName,
  });
}

function customDisposablePolicyMetadata(options: {
  cleanupPolicy: string;
  currentIteration: number;
  maxIterations: number | null;
  requiredBeforeContinue: string[];
  seedPromptSha256: string | null;
}): Record<string, unknown> {
  return {
    cleanup_policy: options.cleanupPolicy,
    current_iteration: options.currentIteration,
    kind: "ralph_loop",
    max_iterations: options.maxIterations ?? 2,
    required_before_continue: options.requiredBeforeContinue,
    seed_prompt_sha256: options.seedPromptSha256,
    source: "create-disposable-binding",
    stop_conditions: ["max_iterations", "required_evidence"],
  };
}

function templateDisposablePolicyMetadata(options: {
  currentIteration: number;
  maxIterations: number | null;
  requiredBeforeContinue: string[];
  seedPromptSha256: string | null;
  templateName: string | null;
}): Record<string, unknown> {
  if (options.templateName === null) {
    throw new Error("template name is required.");
  }
  const template = loopTemplate(options.templateName);
  const maxIterations = options.maxIterations ?? template.maxIterations;
  if (maxIterations < 1) {
    throw new Error("max_iterations must be at least 1");
  }
  if (options.currentIteration < 0) {
    throw new Error("current_iteration must be non-negative");
  }
  if (options.currentIteration > maxIterations) {
    throw new Error("current_iteration must not exceed max_iterations");
  }
  return {
    artifact_requirements: structuredClone(template.artifactRequirements),
    cleanup_policy: template.cleanupPolicy,
    current_iteration: options.currentIteration,
    kind: "ralph_loop",
    max_iterations: maxIterations,
    preset: template.name,
    recommended_tools: [...template.recommendedTools],
    required_before_continue: uniqueRequiredEvidence([
      ...template.requiredBeforeContinue,
      ...options.requiredBeforeContinue,
    ]),
    seed_prompt_sha256: options.seedPromptSha256,
    stop_conditions: [...template.stopConditions],
    tags: [...template.tags],
    template: template.name,
  };
}

function createRalphLoopRunSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    cleanupPolicy: string;
    currentIteration: number;
    maxIterations: number;
    metadata: Record<string, unknown>;
    preset: string | null;
    requiredBeforeContinue: string[];
    runName: string | null;
    seedPromptSha256: string | null;
    stopConditions: string[];
    taskId: string;
    taskName: string;
  },
): RalphLoopRunRow {
  const active = database.prepare(`
    select id
    from runs
    where task_id = ? and status = 'active'
    order by started_at desc, id desc
    limit 1
  `).get(options.taskId) as { id: string } | undefined;
  if (active) {
    throw new Error(`task ${JSON.stringify(options.taskName)} already has active run ${JSON.stringify(active.id)}`);
  }
  const timestamp = new Date().toISOString();
  const runId = `run-${randomUUID()}`;
  const runName = options.runName ?? `${options.taskName}-${timestamp.replace(/:/g, "").replace(/\./g, "-")}`;
  const metadata = {
    ...options.metadata,
    cleanup_policy: options.cleanupPolicy,
    current_iteration: options.currentIteration,
    kind: "ralph_loop",
    max_iterations: options.maxIterations,
    policy_record: true,
    preset: options.preset,
    required_before_continue: options.requiredBeforeContinue,
    seed_prompt_sha256: options.seedPromptSha256,
    stop_conditions: options.stopConditions,
  };
  database.prepare(`
    insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
    values (?, ?, ?, 'ralph_loop', 'finished', ?, ?, ?)
  `).run(runId, options.taskId, runName, timestamp, timestamp, stableJson(metadata));
  return runRowSync(database, runId);
}

interface LoopTemplateDefinition {
  artifactRequirements: Record<string, Record<string, unknown>>;
  cleanupPolicy: string;
  maxIterations: number;
  name: string;
  recommendedTools: string[];
  requiredBeforeContinue: string[];
  stopConditions: string[];
  tags: string[];
}

const ADVERSARIAL_CHECK_REQUIREMENT = {
  description: "Structured proof that the manager or worker tried to disprove the iteration before continuing.",
  properties: {
    check: {
      description: "Command, test, trace, screenshot, audit, diff, or inspection used.",
      type: "string",
    },
    failure_mode: {
      description: "Strongest realistic failure mode considered.",
      type: "string",
    },
    result: {
      description: "Why the check rules out the failure mode or what remains unresolved.",
      type: "string",
    },
  },
  required: ["failure_mode", "check", "result"],
  type: "object",
} satisfies Record<string, unknown>;

const LOOP_TEMPLATES: Record<string, LoopTemplateDefinition> = {
  build_then_clear: {
    artifactRequirements: {},
    cleanupPolicy: "clear",
    maxIterations: 2,
    name: "build_then_clear",
    recommendedTools: [],
    requiredBeforeContinue: ["build_passed", "cleanup"],
    stopConditions: ["max_iterations", "required_evidence"],
    tags: ["build", "context"],
  },
  compact_then_continue: {
    artifactRequirements: {},
    cleanupPolicy: "compact",
    maxIterations: 4,
    name: "compact_then_continue",
    recommendedTools: [],
    requiredBeforeContinue: ["worker_completion", "cleanup"],
    stopConditions: ["max_iterations", "required_evidence"],
    tags: ["context"],
  },
  pr_ci_merge_loop: {
    artifactRequirements: { adversarial_check: ADVERSARIAL_CHECK_REQUIREMENT },
    cleanupPolicy: "clear",
    maxIterations: 2,
    name: "pr_ci_merge_loop",
    recommendedTools: ["gh", "verification.run_tests"],
    requiredBeforeContinue: ["pr_url", "ci_green", "merge", "adversarial_check"],
    stopConditions: ["max_iterations", "required_evidence"],
    tags: ["repo", "ci"],
  },
  test_coverage_loop: {
    artifactRequirements: { adversarial_check: ADVERSARIAL_CHECK_REQUIREMENT },
    cleanupPolicy: "clear",
    maxIterations: 3,
    name: "test_coverage_loop",
    recommendedTools: ["coverage", "verification.run_tests"],
    requiredBeforeContinue: ["test_coverage", "adversarial_check"],
    stopConditions: ["max_iterations", "required_evidence"],
    tags: ["tests"],
  },
  visual_diff_loop: {
    artifactRequirements: {
      adversarial_check: ADVERSARIAL_CHECK_REQUIREMENT,
      candidate_screenshot: {
        description: "Screenshot captured from the worker-produced HTML or app view.",
        type: "path",
      },
      diff_score: {
        description: "Numeric diff score where lower means closer to the reference.",
        type: "number",
      },
      reference_artifact: {
        description: "Desired UX screenshot or reference image path.",
        type: "path",
      },
      viewport: {
        description: "Viewport used for the candidate screenshot, such as 1440x900.",
        type: "string",
      },
      visual_diff_report: {
        description: "Readable report describing visual differences and screenshots compared.",
        type: "path",
      },
    },
    cleanupPolicy: "compact",
    maxIterations: 4,
    name: "visual_diff_loop",
    recommendedTools: ["browser", "playwright", "pixelmatch"],
    requiredBeforeContinue: [
      "reference_artifact",
      "candidate_screenshot",
      "visual_diff_report",
      "diff_below_threshold",
      "adversarial_check",
    ],
    stopConditions: ["max_iterations", "required_evidence", "manager_accepts"],
    tags: ["visual", "frontend", "qa"],
  },
};

function loopTemplate(name: string): LoopTemplateDefinition {
  const template = LOOP_TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown loop template: ${name}; expected one of: ${Object.keys(LOOP_TEMPLATES).sort().join(", ")}`);
  }
  return template;
}

function asInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function runRowSync(database: ReturnType<typeof openRuntimeDatabase>, run: string): RalphLoopRunRow {
  const row = database.prepare(`
    select id, task_id, name, purpose, status, started_at, ended_at, metadata_json
    from runs
    where id = ? or name = ?
    order by started_at desc, id desc
    limit 1
  `).get(run, run) as {
    ended_at: string | null;
    id: string;
    metadata_json: string;
    name: string;
    purpose: string | null;
    started_at: string;
    status: string;
    task_id: string;
  } | undefined;
  if (!row) {
    throw new Error(`Unknown run: ${run}`);
  }
  return {
    ended_at: row.ended_at,
    id: row.id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    name: row.name,
    purpose: row.purpose,
    started_at: row.started_at,
    status: row.status,
    task_id: row.task_id,
  };
}

function activeLifecycleBinding(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): LifecycleBindingRow | null {
  const row = database.prepare(`
    select ws.name as worker_session_name,
           ms.name as manager_session_name
    from bindings b
    left join sessions ws on ws.id = b.worker_session_id
    left join sessions ms on ms.id = b.manager_session_id
    where b.task_id = ?
      and b.state in ('active', 'ending')
    order by b.created_at desc, b.id desc
    limit 1
  `).get(taskId) as LifecycleBindingRow | undefined;
  return row ?? null;
}

function missingManagerDecisionCheck(): Record<string, unknown> {
  return {
    allowed_decisions: ["stop"],
    decision: null,
    decision_id: null,
    ok: false,
    warnings: ["missing_decision_id"],
  };
}

function assessManagerDecisionSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { decisionId: number | null; taskId: string },
): Record<string, unknown> {
  if (options.decisionId === null) {
    return missingManagerDecisionCheck();
  }
  const row = database.prepare(`
    select id, task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
    from manager_decisions
    where id = ?
  `).get(options.decisionId) as {
    created_at: string;
    decision: string;
    id: number;
    manager_cycle_id: number | null;
    manager_id: string | null;
    reason: string;
    task_id: string;
  } | undefined;
  if (!row) {
    return {
      allowed_decisions: ["stop"],
      decision: null,
      decision_id: options.decisionId,
      ok: false,
      warnings: ["decision_not_found"],
    };
  }
  const warnings: string[] = [];
  if (row.task_id !== options.taskId) {
    warnings.push("decision_task_mismatch");
  }
  if (row.decision !== "stop") {
    warnings.push("decision_mismatch");
  }
  const createdAt = Date.parse(row.created_at);
  let ageSeconds: number | null = null;
  if (Number.isNaN(createdAt)) {
    warnings.push("decision_timestamp_invalid");
  } else {
    ageSeconds = Math.trunc((Date.now() - createdAt) / 1000);
    if (ageSeconds > 900) {
      warnings.push("decision_stale");
    }
  }
  return {
    age_seconds: ageSeconds,
    allowed_decisions: ["stop"],
    decision: {
      created_at: row.created_at,
      decision: row.decision,
      id: row.id,
      manager_cycle_id: row.manager_cycle_id,
      manager_id: row.manager_id,
      reason: row.reason,
      task_id: row.task_id,
    },
    decision_id: options.decisionId,
    max_age_seconds: 900,
    ok: warnings.length === 0,
    warnings,
  };
}

function strictManagerDecisionError(
  commandType: string,
  decisionCheck: Record<string, unknown>,
  strict: boolean,
): string | null {
  if (!strict || decisionCheck.ok === true) {
    return null;
  }
  return `strict manager decision validation failed: ${stableJson({
    command_type: commandType,
    error: "manager_decision_validation_failed",
    manager_decision: decisionCheck,
  })}`;
}

function finalCriteriaAuditSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
  requireCriteriaAudit: boolean,
): Record<string, unknown> {
  const rows = database.prepare(`
    select id, criterion, status
    from acceptance_criteria
    where task_id = ?
    order by id
  `).all(taskId) as Array<{ criterion: string; id: number; status: string }>;
  const summary: Record<string, number> = {
    accepted: 0,
    deferred: 0,
    proposed: 0,
    rejected: 0,
    satisfied: 0,
  };
  for (const row of rows) {
    summary[row.status] = (summary[row.status] ?? 0) + 1;
  }
  return {
    open_criteria: rows
      .filter((row) => row.status === "accepted")
      .map((row) => ({ criterion: row.criterion, id: row.id })),
    require_criteria_audit: requireCriteriaAudit,
    summary,
    total: rows.length,
  };
}

function finalCriteriaAuditError(finalAudit: Record<string, unknown>, taskName: string): string | null {
  const openCriteria = Array.isArray(finalAudit.open_criteria) ? finalAudit.open_criteria : [];
  if (openCriteria.length === 0) {
    return null;
  }
  const details = openCriteria
    .map((criterion) => {
      const row = criterion as { criterion?: unknown; id?: unknown };
      return `#${String(row.id)}: ${String(row.criterion)}`;
    })
    .join("; ");
  return `Task ${taskName} has accepted acceptance criteria still open; satisfy, defer, or reject them before finishing: ${details}`;
}

function finalAckAuditSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
  requireAcks: boolean,
): Record<string, unknown> {
  const workerAck = latestAckIdForRole(database, taskId, "worker");
  const managerAck = latestAckIdForRole(database, taskId, "manager");
  const missing = [
    ...(workerAck === null ? ["worker"] : []),
    ...(managerAck === null ? ["manager"] : []),
  ];
  return {
    manager_ack_id: managerAck,
    missing,
    ok: missing.length === 0,
    require_acks: requireAcks,
    worker_ack_id: workerAck,
  };
}

function finalAckAuditError(finalAckAudit: Record<string, unknown>, taskName: string): string | null {
  const missing = Array.isArray(finalAckAudit.missing) ? finalAckAudit.missing : [];
  if (missing.length === 0) {
    return null;
  }
  return `Task ${taskName} is missing required acknowledgement(s): ${missing.join(", ")}`;
}

function latestAckIdForRole(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
  role: "manager" | "worker",
): number | null {
  const row = database.prepare(`
    select id
    from task_acknowledgements
    where task_id = ? and role = ?
    order by revision desc, id desc
    limit 1
  `).get(taskId, role) as { id: number } | undefined;
  return row?.id ?? null;
}

function finalEpilogueAuditSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
  requireEpilogue: boolean,
): Record<string, unknown> {
  const config = database.prepare("select epilogues_json from manager_configs where task_id = ?")
    .get(taskId) as { epilogues_json: string } | undefined;
  const requiredSteps = asStringArray(config ? JSON.parse(config.epilogues_json) as unknown : []);
  const steps = requiredSteps.map((step) => {
    const run = latestEpilogueRunForStepSync(database, taskId, step);
    return {
      latest_run: run,
      ok: run?.state === "succeeded",
      state: run?.state ?? "pending",
      step_name: step,
    };
  });
  const missingOrIncomplete = steps
    .filter((step) => !step.ok)
    .map((step) => step.step_name);
  return {
    missing_or_incomplete: missingOrIncomplete,
    ok: missingOrIncomplete.length === 0,
    require_epilogue: requireEpilogue,
    required_steps: requiredSteps,
    steps,
  };
}

function latestEpilogueRunForStepSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
  stepName: string,
): Record<string, unknown> | null {
  const row = database.prepare(`
    select id, task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
    from epilogue_runs
    where task_id = ? and step_name = ?
    order by id desc
    limit 1
  `).get(taskId, stepName) as {
    correlation_id: string | null;
    error: string | null;
    finished_at: string | null;
    id: number;
    result_json: string | null;
    started_at: string;
    state: string;
    step_name: string;
    task_id: string;
  } | undefined;
  if (!row) {
    return null;
  }
  return {
    correlation_id: row.correlation_id,
    error: row.error,
    finished_at: row.finished_at,
    id: row.id,
    result: row.result_json ? JSON.parse(row.result_json) as unknown : null,
    started_at: row.started_at,
    state: row.state,
    step_name: row.step_name,
    task_id: row.task_id,
  };
}

function finalEpilogueAuditError(finalEpilogueAudit: Record<string, unknown>, taskName: string): string | null {
  const missing = Array.isArray(finalEpilogueAudit.missing_or_incomplete)
    ? finalEpilogueAudit.missing_or_incomplete
    : [];
  if (missing.length === 0) {
    return null;
  }
  return `Task ${taskName} has incomplete required epilogue step(s): ${missing.join(", ")}`;
}

const FAILING_ADVERSARIAL_PROOF_STATUSES = new Set(["error", "errored", "fail", "failed", "failure", "rejected"]);

function taskHasSatisfiedAdversarialProofSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): boolean {
  const rows = database.prepare(`
    select evidence_json
    from acceptance_criteria
    where task_id = ? and status = 'satisfied'
    order by id
  `).all(taskId) as Array<{ evidence_json: string }>;
  return rows.some((row) => isStructuredAdversarialProof(JSON.parse(row.evidence_json) as Record<string, unknown>));
}

function isStructuredAdversarialProof(evidence: Record<string, unknown>): boolean {
  if (evidence.evidence_type !== "adversarial_check") {
    return false;
  }
  for (const key of ["failure_mode", "check", "result"] as const) {
    const value = evidence[key];
    if (typeof value !== "string" || value.trim() === "") {
      return false;
    }
  }
  if (evidence.status === undefined || evidence.status === null) {
    return true;
  }
  if (typeof evidence.status !== "string") {
    return false;
  }
  return !FAILING_ADVERSARIAL_PROOF_STATUSES.has(evidence.status.trim().toLowerCase());
}

function adversarialProofError(taskName: string): string {
  return `Task ${taskName}: adversarial proof is required before finish; record satisfied evidence_type=adversarial_check with non-empty failure_mode, check, result, and a non-failing evidence status`;
}

function failLifecycleGateSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    audit: Record<string, unknown>;
    auditKey: "final_ack_audit" | "final_audit" | "final_epilogue_audit";
    commandType: string;
    error: string;
    eventPrefix: string;
    failureStage: string;
    finish: boolean;
    reason: string;
    stopManager: boolean;
    taskId: string;
    taskName: string;
  },
): TypescriptRuntimeResult {
  const payload = {
    [options.auditKey]: options.audit,
    capture_transcript_before_stop: false,
    expected_failure: true,
    failure_stage: options.failureStage,
    finish: options.finish,
    message: null,
    reason: options.reason,
    stop_manager: options.stopManager,
    stop_worker: false,
    task: options.taskName,
  };
  const commandId = createCommandSync(database, {
    commandType: options.commandType,
    payload,
    taskId: options.taskId,
  });
  markImmediateCommandAttemptedSync(database, commandId);
  const result = {
    [options.auditKey]: options.audit,
    command_id: commandId,
    expected_failure: true,
    failure_stage: options.failureStage,
    finish: options.finish,
    task: options.taskName,
  };
  finishImmediateCommandSync(database, {
    commandId,
    error: options.error,
    result,
    state: "failed",
    timestamp: new Date().toISOString(),
  });
  insertEventSync(database, {
    commandId,
    payload: {
      ...result,
      error: options.error,
      error_type: "WorkerError",
    },
    taskId: options.taskId,
    type: `${options.eventPrefix}_failed`,
  });
  return lifecycleWorkerErrorResult(options.error);
}

function lifecycleWorkerErrorResult(message: string): TypescriptRuntimeResult {
  return {
    exitCode: 1,
    handled: true,
    stderr: `${message}\n`,
  };
}

function insertFinalManagerDecisionSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { commandId: string; reason: string; taskId: string },
): number {
  const timestamp = new Date().toISOString();
  const result = database.prepare(`
    insert into manager_decisions(
      task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
    )
    values (?, null, null, 'stop', ?, ?, ?)
  `).run(
    options.taskId,
    options.reason,
    timestamp,
    stableJson({ command_id: options.commandId, source: "finish_task" }),
  );
  const decisionId = Number(result.lastInsertRowid);
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      decision: "stop",
      payload: { command_id: options.commandId, source: "finish_task" },
      reason: options.reason,
    },
    correlation: {
      decision_id: decisionId,
      manager_cycle_id: null,
      manager_id: null,
    },
    eventType: "manager_decision_recorded",
    severity: "info",
    summary: "Recorded manager decision stop.",
    taskId: options.taskId,
    timestamp,
  });
  return decisionId;
}

function insertFinalAgentObservationSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { commandId: string; decisionId: number | null; message: string; taskId: string },
): number {
  const result = database.prepare(`
    insert into agent_observations(
      task_id, worker_id, manager_id, role, observation_type, severity,
      source_capture_id, command_id, created_at, message, payload_json
    )
    values (?, null, null, 'manager', 'decision', 'info', null, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.commandId,
    new Date().toISOString(),
    options.message,
    stableJson({
      decision: "stop",
      decision_id: options.decisionId,
      source: "finish_task",
    }),
  );
  return Number(result.lastInsertRowid);
}

function markImmediateCommandAttemptedSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  commandId: string,
): void {
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
  if (!row) {
    return;
  }
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      manager_id: row.manager_id,
      state: row.state,
      worker_id: row.worker_id,
    },
    correlation: {
      command_id: commandId,
      command_type: row.type,
    },
    eventType: "command_attempted",
    severity: "info",
    summary: `Attempted command ${row.type}.`,
    taskId: row.task_id,
    timestamp,
  });
}

function finishImmediateCommandSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    commandId: string;
    error?: string | null;
    result: Record<string, unknown>;
    state: "failed" | "succeeded";
    timestamp: string;
  },
): void {
  database.prepare(`
    update commands
    set state = ?, updated_at = ?, result_json = ?, error = ?
    where id = ?
  `).run(
    options.state,
    options.timestamp,
    stableJson(options.result),
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
  if (!row) {
    return;
  }
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      error: options.error ?? null,
      manager_id: row.manager_id,
      result: options.result,
      state: row.state,
      worker_id: row.worker_id,
    },
    correlation: {
      command_id: options.commandId,
      command_type: row.type,
    },
    eventType: `command_${options.state}`,
    severity: options.state === "failed" ? "error" : "info",
    summary: `Command ${row.type} ${options.state}.`,
    taskId: row.task_id,
    timestamp: options.timestamp,
  });
}

function endActiveBindingForTaskSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
  timestamp: string,
): void {
  database.prepare(`
    update bindings
    set state = 'ended', ended_at = ?
    where task_id = ?
      and state in ('active', 'ending')
  `).run(timestamp, taskId);
}

function finishActiveRunForTaskSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { status: "abandoned" | "finished"; taskId: string; timestamp: string },
): RalphLoopRunRow | null {
  const active = database.prepare(`
    select id, name
    from runs
    where task_id = ? and status = 'active'
    order by started_at desc, id desc
    limit 1
  `).get(options.taskId) as { id: string; name: string } | undefined;
  if (!active) {
    return null;
  }
  database.prepare("update runs set status = ?, ended_at = ? where id = ?")
    .run(options.status, options.timestamp, active.id);
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: { status: options.status },
    correlation: {
      run_id: active.id,
      run_name: active.name,
    },
    eventType: "run_finished",
    runId: active.id,
    severity: "info",
    summary: `Run ${active.name} marked ${options.status}.`,
    taskId: options.taskId,
    timestamp: options.timestamp,
  });
  return runRowSync(database, active.id);
}

function disposableSessionCommunication(
  role: "manager" | "worker",
  taskName: string,
  dbPath: string,
): Record<string, unknown> {
  return {
    can_receive_pull: true,
    can_receive_push: false,
    delivery_mode: "pull_required",
    detection_source: "codex_session_without_tmux",
    poll_command: sessionPollCommand(role, taskName, dbPath),
    poll_command_template: sessionPollCommand(role, null, dbPath),
    receive_style: "pull",
    requires_polling: true,
    session_kind: "codex_app",
    tmux_session: null,
  };
}

function disposableReplayCommands(options: {
  adversarial: boolean;
  dbPath: string;
  managerName: string;
  requiredBeforeContinue: string[];
  runName: string | null;
  sessionDir: string;
  taskName: string;
  templateName: string | null;
  workerName: string;
}): string[] {
  const pathSuffix = ` --path ${shellQuote(options.dbPath)}`;
  const setupParts = [
    "scripts/workerctl",
    "create-disposable-binding",
    shellQuote(options.taskName),
    "--worker",
    shellQuote(options.workerName),
    "--manager",
    shellQuote(options.managerName),
    "--session-dir",
    shellQuote(options.sessionDir),
  ];
  if (options.templateName) {
    setupParts.push("--template", shellQuote(options.templateName));
  }
  for (const evidence of options.requiredBeforeContinue) {
    setupParts.push("--required-before-continue", shellQuote(evidence));
  }
  if (options.adversarial && !options.requiredBeforeContinue.includes("adversarial_check")) {
    setupParts.push("--adversarial");
  }
  if (options.runName) {
    setupParts.push("--run-name", shellQuote(options.runName));
  }
  setupParts.push("--json", "--path", shellQuote(options.dbPath));
  const commands = [setupParts.join(" ")];
  if (options.runName) {
    const loopFlag = ` --loop-run ${shellQuote(options.runName)}`;
    commands.push(
      `scripts/workerctl enqueue-continue-iteration ${shellQuote(options.taskName)}${loopFlag} --requested-iteration 2 --message ${shellQuote("Run the next iteration.")}${pathSuffix}`,
      `scripts/workerctl dispatch --once --type continue_iteration${pathSuffix}`,
      `scripts/workerctl worker-inbox ${shellQuote(options.taskName)} --consume-next --wait${pathSuffix} --json`,
      `scripts/workerctl loop-status ${shellQuote(options.taskName)} --run ${shellQuote(options.runName)}${pathSuffix} --json`,
    );
  } else {
    commands.push(
      `scripts/workerctl session-inbox WORKER_SESSION --wait${pathSuffix} --json`,
      `scripts/workerctl manager-inbox MANAGER_SESSION --wait${pathSuffix} --json`,
    );
  }
  return commands;
}

function disposableWorkerHandoff(taskName: string, runName: string | null, dbPath: string): string {
  const loopClause = runName
    ? ` for Ralph loop run ${runName}`
    : " for this disposable no-tmux binding";
  return [
    "Use the manage-codex-workers skill.",
    "",
    `You are the worker for task ${taskName}${loopClause}.`,
    "Keep polling your Conveyor worker inbox until there are no items left or the loop reaches max_iterations. Consume the next item now, treat each consumed item as the manager's next instruction, complete the requested work, and report changed files, exact commands run, evidence, and any residual risk.",
    "",
    `Run: ${sessionPollCommand("worker", taskName, dbPath)}`,
  ].join("\n");
}

function renderDisposableBindingText(result: {
  manager: { name: string; rollout_path: string };
  replay_commands: string[];
  run: { name: string } | null;
  task: { name: string };
  worker: { name: string; rollout_path: string };
  worker_handoff: string;
}): string {
  const lines = [
    `Created disposable binding for task ${JSON.stringify(result.task.name)}.`,
    `Worker: ${result.worker.name} (${result.worker.rollout_path})`,
    `Manager: ${result.manager.name} (${result.manager.rollout_path})`,
  ];
  if (result.run) {
    lines.push(`Ralph loop run: ${result.run.name}`);
  }
  lines.push("Replay commands:");
  lines.push(...result.replay_commands.map((command) => `  ${command}`));
  lines.push("Worker handoff:");
  lines.push(result.worker_handoff);
  return `${lines.join("\n")}\n`;
}

function sessionPollCommand(role: "manager" | "worker", taskName: string | null, dbPath: string): string {
  const inbox = role === "worker" ? "worker-inbox" : "manager-inbox";
  const task = taskName ? shellQuote(taskName) : "<task>";
  return `conveyor ${inbox} ${task} --consume-next --wait --timeout 60 --path ${shellQuote(dbPath)} --json`;
}

function resolveCodexStartupOptions(options: {
  askForApproval: string | null;
  profile: string | null;
  sandbox: string | null;
}): { askForApproval: string | null; sandbox: string | null } {
  const defaults = {
    askForApproval: options.askForApproval ?? "never",
    sandbox: options.sandbox ?? "danger-full-access",
  };
  if (options.profile === null) {
    return defaults;
  }
  if (options.profile !== "yolo") {
    throw new Error(`Unknown Codex startup profile: ${options.profile}`);
  }
  return {
    askForApproval: options.askForApproval ?? "never",
    sandbox: options.sandbox ?? "danger-full-access",
  };
}

function codexTmuxShellCommand(codexArgs: string[]): string {
  const codexCommand = codexArgs.map(shellQuoteLikePython).join(" ");
  const npmEnvCleanup = "for name in $(env | awk -F= '/^(npm|NPM)_/ {print $1}'); do unset \"$name\"; done; unset PNPM_SCRIPT_SRC_DIR";
  return `${npmEnvCleanup}; exec ${codexCommand}`;
}

function shellQuoteLikePython(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return shellQuote(value);
}

function defaultDiscoverSpawnedCodexSession(
  options: SpawnedCodexSessionDiscoveryOptions,
): SpawnedCodexSessionDiscovery {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const childrenForPid = options.childrenForPid ?? defaultChildrenForPid;
  const lsofForPid = options.lsofForPid ?? defaultLsofForPid;
  const sleepMilliseconds = options.sleepMilliseconds ?? sleepSync;
  const tmuxRunner = options.tmuxRunner ?? defaultTmuxRunner;
  let lastError = "no discovery attempt completed";
  while (Date.now() < deadline) {
    try {
      const discovery = discoverCodexSessionInTmuxOnce({
        childrenForPid,
        lsofForPid,
        minimumSessionTimestamp: options.minimumSessionTimestamp,
        tmuxRunner,
        tmuxSessionName: options.tmuxSessionName,
      });
      return discovery;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (options.acceptTrust && Date.now() < deadline) {
        try {
          sendEnterToTmuxSessionWithRunner(options.tmuxSessionName, tmuxRunner);
        } catch (enterError) {
          lastError = enterError instanceof Error ? enterError.message : String(enterError);
        }
      }
      sleepMilliseconds(500);
    }
  }
  throw new Error(
    `codex did not write session_meta within ${options.timeoutSeconds}s `
    + `in tmux session ${JSON.stringify(options.tmuxSessionName)}: ${lastError}`,
  );
}

function discoverCodexSessionInTmuxOnce(options: {
  childrenForPid: (pid: number) => number[];
  lsofForPid: (pid: number) => string;
  minimumSessionTimestamp: Date;
  tmuxRunner: TmuxRunner;
  tmuxSessionName: string;
}): SpawnedCodexSessionDiscovery {
  const panePidResult = options.tmuxRunner(["tmux", "list-panes", "-t", options.tmuxSessionName, "-F", "#{pane_pid}"], { check: false });
  if (panePidResult.status !== 0) {
    const detail = (panePidResult.stderr || panePidResult.stdout || `exit code ${panePidResult.status}`).trim();
    throw new Error(`tmux list-panes failed: ${detail}`);
  }
  const shellPidText = (panePidResult.stdout ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  if (!shellPidText) {
    throw new Error("tmux pane has no pid yet");
  }
  const shellPid = Number(shellPidText);
  if (!Number.isInteger(shellPid)) {
    throw new Error(`tmux pane pid is not an integer: ${JSON.stringify(shellPidText)}`);
  }

  const queue = [shellPid];
  const visited = new Set<number>();
  let lastError = "no codex rollout open in tmux pane process tree yet";
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    try {
      const rolloutPath = findRolloutPathForPid(pid, options.lsofForPid);
      const meta = readSessionMeta(rolloutPath);
      const timestamp = parseRolloutTimestamp(meta.timestamp);
      if (timestamp === null) {
        lastError = `found codex rollout ${rolloutPath} without parseable session timestamp; waiting for fresh session_meta`;
        continue;
      }
      if (timestamp < options.minimumSessionTimestamp) {
        lastError = `found stale codex rollout ${rolloutPath} from ${timestamp.toISOString()}; waiting for fresh session_meta`;
        continue;
      }
      return {
        cli_version: meta.cli_version ?? "",
        codex_session_id: meta.id,
        codex_session_path: rolloutPath,
        cwd: meta.cwd ?? "",
        native_pid: pid,
        originator: meta.originator ?? "",
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      queue.push(...options.childrenForPid(pid));
    }
  }
  throw new Error(lastError);
}

function parseRolloutTimestamp(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function defaultChildrenForPid(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value));
}

function defaultLsofForPid(pid: number): string {
  const result = spawnSync("lsof", ["-p", String(pid)], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `lsof failed for pid ${pid}`).trim());
  }
  return result.stdout;
}

function startManagerBootstrapPrompt(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    cwd: string;
    managerName: string;
    taskGoal: string | null;
    taskName: string | null;
    workerName: string | null;
  },
): string {
  const context = startManagerTaskContext(database, options.taskName);
  const taskLine = options.taskName ?? "<unbound-task>";
  const goalLine = options.taskGoal ?? context?.goal ?? "No task goal supplied yet.";
  const workerLine = options.workerName ?? "No worker session supplied yet.";
  const workerctl = "conveyor";
  const setupCommand = options.taskName
    ? `${workerctl} manager-config ${taskLine} --questions`
    : `${workerctl} manager-config <task> --questions`;
  const cycleCommand = options.taskName ? `${workerctl} cycle ${taskLine}` : `${workerctl} cycle <task>`;
  const managerAckCommand = options.taskName
    ? `${workerctl} manager-ack ${taskLine} --from-stdin`
    : `${workerctl} manager-ack <task> --from-stdin`;
  const workerAckCommand = options.taskName
    ? `${workerctl} worker-ack ${taskLine} --json`
    : `${workerctl} worker-ack <task> --json`;
  const config = context ? managerConfigSync(database, context.id) : null;
  const initialSetup = config
    ? seededManagerConfigSetup({ config, cycleCommand, managerAckCommand, workerAckCommand })
    : [
      "Initial setup:",
      `1. Run \`${setupCommand}\`.`,
      "2. Ask the user the returned setup questions in this manager Codex chat.",
      `3. Persist the answers with \`${workerctl} manager-config\`.`,
      "4. Use `conveyor manager-config --interactive` only when a human is directly running conveyor in a terminal.",
      "",
      "Acknowledgement:",
      `- Before your first cycle, record the supervision contract you are committing to with \`${managerAckCommand}\`.`,
      `- Before nudging or finishing, inspect the worker acknowledgement with \`${workerAckCommand}\` when available.`,
    ].join("\n");
  return [
    "You are a Codex manager session for Agent Conveyor.",
    "",
    `Working directory: ${options.cwd}`,
    `Manager session name: ${options.managerName}`,
    `Task: ${taskLine}`,
    `Task goal: ${goalLine}`,
    `Worker session: ${workerLine}`,
    "",
    "Your role is to supervise, not to implement the worker task.",
    "",
    initialSetup,
    "",
    "Supervision loop:",
    `- Start observations with \`${cycleCommand}\`.`,
    "- Read `manager_context.manager_config` in cycle output before nudging.",
    "- Treat acceptance criteria as living supervision state.",
    "- Inspect `manager_context.acceptance_criteria` each cycle.",
    "- If worker progress reveals new edge cases, tests, polish, or scope boundaries, ask the worker to propose must-have vs follow-up criteria.",
    "- Before finishing, compare worker receipts/verification against accepted open criteria.",
    `- When all accepted criteria are satisfied, deferred, or rejected, finish the task with \`${workerctl} finish-task ${taskLine} --reason "Accepted criteria satisfied" --require-criteria-audit\`.`,
    "- Communicate with the worker only through conveyor session/task commands.",
    "- Do not edit project files unless the user explicitly asks this manager session to change Agent Conveyor itself.",
  ].join("\n");
}

function seededManagerConfigSetup(options: {
  config: ManagerConfigRecord;
  cycleCommand: string;
  managerAckCommand: string;
  workerAckCommand: string;
}): string {
  const lines = [
    "Initial setup:",
    "- Manager config has already been recorded for this task.",
    `- Start with \`${options.cycleCommand}\` and inspect \`manager_context.manager_config\`.`,
    "- Ask setup questions only if the cycle output shows missing or unsuitable manager config.",
  ];
  if (options.config.tools.length > 0) {
    lines.push(`Expected tools: ${options.config.tools.join(", ")}.`);
  }
  lines.push(
    "",
    "Acknowledgement:",
    `- Before your first cycle, record the supervision contract you are committing to with \`${options.managerAckCommand}\`.`,
    `- Before nudging or finishing, inspect the worker acknowledgement with \`${options.workerAckCommand}\` when available.`,
  );
  return lines.join("\n");
}

function startManagerTaskContext(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskName: string | null,
): { goal: string; id: string; name: string } | null {
  if (!taskName) {
    return null;
  }
  const row = database.prepare("select id, name, goal from tasks where id = ? or name = ? order by created_at desc limit 1")
    .get(taskName, taskName) as { goal: string; id: string; name: string } | undefined;
  return row ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function emitTelemetrySync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    actor: string;
    attributes: Record<string, unknown>;
    correlation: Record<string, unknown>;
    eventType: string;
    runId?: string | null;
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
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    options.runId ?? null,
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
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    options.taskId ?? null,
    options.runId ?? null,
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

interface SessionTranscriptCaptureContext {
  bindingId: string | null;
  binding: {
    binding_id: string;
    created_at: string;
    ended_at: string | null;
    manager_session_id: string;
    manager_session_name: string;
    state: string;
    task_id: string;
    worker_session_id: string;
    worker_session_name: string;
  };
  legacyWorkerConfig?: LiveWorkerConfig;
  managerId: string | null;
  role: "manager" | "worker";
  session: {
    id: string;
    name: string;
    role: "manager" | "worker";
    state: string;
    tmux_pane_id: string | null;
    tmux_session: string | null;
  };
  source: "legacy_manager" | "legacy_worker" | "session";
  task: { id: string; name: string; state: string };
  workerIdentityToken?: string;
  workerId: string | null;
}

interface TerminalCaptureRecord {
  classifier: {
    busy_wait: ReturnType<typeof classifyBusyWait>;
    startup: ReturnType<typeof classifyStartupOutput>;
  };
  content_sha256: string;
  history_lines: number;
  id: number;
  line_count: number;
  output: string;
  source: string;
}

interface TranscriptSegmentSummary {
  id: number;
  line_count: number;
  mode: TranscriptCaptureMode;
  previous_capture_id: number | null;
  segment_kind: string;
  source_capture_id: number;
}

type TranscriptCaptureCommandCapture =
  | {
    binding_id: string | null;
    capture: TerminalCaptureRecord;
    observation_id: number;
    role: "manager" | "worker";
    task: { id: string; name: string; state: string };
    transcript_segment: TranscriptSegmentSummary | null;
    manager?: {
      id: string;
      name: string;
      state: string;
      tmux_pane_id: string | null;
      tmux_session: string | null;
    };
    worker?: {
      id: string;
      name: string;
      state: string;
      tmux_pane_id: string | null;
      tmux_session: string | null;
    };
  }
  | {
    error: string;
    role: "manager" | "worker";
  };

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

function sessionTranscriptCaptureContext(
  database: ReturnType<typeof openRuntimeDatabase>,
  task: string,
  role: "manager" | "worker",
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): SessionTranscriptCaptureContext | null {
  const snapshot = taskSnapshot(database, task);
  if (role === "worker") {
    const legacyWorker = legacyWorkerTranscriptCaptureContext(database, snapshot, options);
    if (legacyWorker) {
      return legacyWorker;
    }
  } else {
    const legacyManager = legacyManagerTranscriptCaptureContext(database, snapshot);
    if (legacyManager) {
      return legacyManager;
    }
  }
  const binding = database.prepare(`
    select
      b.id as binding_id,
      b.task_id as task_id,
      b.worker_session_id as worker_session_id,
      b.manager_session_id as manager_session_id,
      ws.name as worker_session_name,
      ms.name as manager_session_name,
      b.state as state,
      b.created_at as created_at,
      b.ended_at as ended_at
    from bindings b
    join sessions ws on ws.id = b.worker_session_id
    join sessions ms on ms.id = b.manager_session_id
    where b.task_id = ?
      and b.worker_session_id is not null
      and b.manager_session_id is not null
    order by case when b.state in ('active', 'ending') then 0 else 1 end,
             b.created_at desc
    limit 1
  `).get(snapshot.id) as SessionTranscriptCaptureContext["binding"] | undefined;
  if (!binding) {
    return null;
  }
  const sessionId = role === "worker" ? binding.worker_session_id : binding.manager_session_id;
  const session = database.prepare(`
    select id, name, role, state, tmux_session, tmux_pane_id
    from sessions
    where id = ?
  `).get(sessionId) as SessionTranscriptCaptureContext["session"] | undefined;
  if (!session || session.role !== role) {
    return null;
  }
  return {
    binding,
    bindingId: null,
    managerId: null,
    role,
    session,
    source: "session",
    task: snapshot,
    workerId: null,
  };
}

function legacyWorkerTranscriptCaptureContext(
  database: ReturnType<typeof openRuntimeDatabase>,
  snapshot: { id: string; name: string; state: string },
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): SessionTranscriptCaptureContext | null {
  const row = database.prepare(`
    select tasks.id as task_id, tasks.name as task_name, tasks.state as task_state,
           bindings.id as binding_id, bindings.state as binding_state,
           workers.id as worker_id, workers.name as worker_name,
           workers.tmux_session, workers.tmux_pane_id, workers.identity_token,
           workers.cwd, workers.state as worker_state
    from tasks
    left join bindings on bindings.task_id = tasks.id and bindings.state in ('active', 'ending')
    left join workers on workers.id = bindings.worker_id
    where tasks.id = ?
    order by tasks.created_at desc
    limit 1
  `).get(snapshot.id) as {
    binding_id: string | null;
    binding_state: string | null;
    cwd: string | null;
    identity_token: string | null;
    task_id: string;
    task_name: string;
    task_state: string;
    tmux_pane_id: string | null;
    tmux_session: string | null;
    worker_id: string | null;
    worker_name: string | null;
    worker_state: string | null;
  } | undefined;
  if (!row?.worker_id || !row.worker_name || !row.tmux_session || !row.identity_token || !row.worker_state) {
    return null;
  }
  const config = requireWorkerConfig(row.worker_name, options);
  return {
    binding: {
      binding_id: row.binding_id ?? "",
      created_at: "",
      ended_at: null,
      manager_session_id: "",
      manager_session_name: "",
      state: row.binding_state ?? "",
      task_id: row.task_id,
      worker_session_id: "",
      worker_session_name: row.worker_name,
    },
    legacyWorkerConfig: { ...config, _workerctl_lookup_source: "legacy" },
    bindingId: row.binding_id,
    managerId: null,
    role: "worker",
    session: {
      id: row.worker_id,
      name: row.worker_name,
      role: "worker",
      state: row.worker_state,
      tmux_pane_id: row.tmux_pane_id,
      tmux_session: row.tmux_session,
    },
    source: "legacy_worker",
    task: snapshot,
    workerIdentityToken: row.identity_token,
    workerId: row.worker_id,
  };
}

function legacyManagerTranscriptCaptureContext(
  database: ReturnType<typeof openRuntimeDatabase>,
  snapshot: { id: string; name: string; state: string },
): SessionTranscriptCaptureContext | null {
  const row = database.prepare(`
    select id, name, tmux_session, tmux_pane_id, state
    from managers
    where task_id = ? and state in ('starting', 'ready', 'stopping')
    order by started_at desc
    limit 1
  `).get(snapshot.id) as {
    id: string;
    name: string;
    state: string;
    tmux_pane_id: string | null;
    tmux_session: string | null;
  } | undefined;
  if (!row?.tmux_session) {
    return null;
  }
  return {
    binding: {
      binding_id: "",
      created_at: "",
      ended_at: null,
      manager_session_id: "",
      manager_session_name: row.name,
      state: "",
      task_id: snapshot.id,
      worker_session_id: "",
      worker_session_name: "",
    },
    bindingId: null,
    managerId: row.id,
    role: "manager",
    session: {
      id: row.id,
      name: row.name,
      role: "manager",
      state: row.state,
      tmux_pane_id: row.tmux_pane_id,
      tmux_session: row.tmux_session,
    },
    source: "legacy_manager",
    task: snapshot,
    workerId: null,
  };
}

function captureTaskTerminalSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    context: SessionTranscriptCaptureContext;
    historyLines: number;
    mode: TranscriptCaptureMode;
    now: string;
    parsed: ParsedRuntimeArgs;
    runner: TmuxRunner;
    runtimeOptions: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner };
    source: string;
  },
): Extract<TranscriptCaptureCommandCapture, { capture: TerminalCaptureRecord }> {
  const paneId = verifySessionCaptureIdentity(options.context, options.runner);
  const tmuxSessionName = options.context.session.tmux_session;
  if (!tmuxSessionName) {
    throw new Error(`Session identity verification failed for ${options.context.session.name}: tmux_session_missing`);
  }
  const output = options.context.source === "legacy_worker"
    ? captureOutputForConfig(
      options.context.session.name,
      options.context.legacyWorkerConfig ?? workerConfigOrSession(options.context.session.name, options.parsed, options.runtimeOptions),
      options.historyLines,
      options.parsed,
      options.runtimeOptions,
    ).output
    : captureTranscriptTmuxTargetWithRunner(tmuxSessionName, options.historyLines, options.runner);
  const contentSha256 = createHash("sha256").update(output).digest("hex");
  const startup = classifyStartupOutput(output);
  const classifier = {
    busy_wait: classifyBusyWait(output, 10 ** 9, 0),
    startup,
  };
  const previousCapture = latestTerminalCaptureForRoleSync(database, {
    role: options.context.role,
    taskId: options.context.task.id,
  });
  const captureId = insertTerminalCaptureSync(database, {
    classifier,
    contentSha256,
    historyLines: options.historyLines,
    managerId: options.context.managerId,
    output,
    role: options.context.role,
    source: options.source,
    taskId: options.context.task.id,
    timestamp: options.now,
    tmuxPaneId: paneId ?? options.context.session.tmux_pane_id,
    tmuxSession: tmuxSessionName,
    workerId: options.context.workerId,
  });
  const transcriptSegment = recordTranscriptSegmentSync(database, {
    content: output,
    contentSha256,
    mode: options.mode,
    previousCapture,
    role: options.context.role,
    sourceCaptureId: captureId,
    taskId: options.context.task.id,
    timestamp: options.now,
  });
  insertEventSync(database, {
    managerId: options.context.managerId,
    payload: {
      capture_id: captureId,
      content_sha256: contentSha256,
      history_lines: options.historyLines,
      source: options.source,
    },
    taskId: options.context.task.id,
    type: `${options.context.role}_terminal_captured`,
    workerId: options.context.workerId,
  });
  if (options.context.role === "manager" && options.context.managerId) {
    markManagerSeenSync(database, {
      contentSha256,
      managerId: options.context.managerId,
      timestamp: options.now,
    });
  }
  const observationId = insertAgentObservationSync(database, {
    managerId: options.context.managerId,
    message: `${options.context.role} terminal captured`,
    payload: {
      content_sha256: contentSha256,
      history_lines: options.historyLines,
      source: options.source,
      transcript_segment_id: transcriptSegment?.id ?? null,
    },
    role: options.context.role,
    sourceCaptureId: captureId,
    taskId: options.context.task.id,
    timestamp: options.now,
    workerId: options.context.workerId,
  });
  const sessionPayload = {
    id: options.context.session.id,
    name: options.context.session.name,
    state: options.context.session.state,
    tmux_pane_id: paneId ?? options.context.session.tmux_pane_id,
    tmux_session: tmuxSessionName,
  };
  const result = {
    binding_id: null,
    capture: {
      classifier,
      content_sha256: contentSha256,
      history_lines: options.historyLines,
      id: captureId,
      line_count: pythonSplitlinesCount(output),
      output,
      source: options.source,
    },
    observation_id: observationId,
    role: options.context.role,
    task: options.context.task,
    transcript_segment: transcriptSegment,
  };
  return options.context.role === "manager"
    ? { ...result, binding_id: options.context.bindingId, manager: sessionPayload }
    : { ...result, binding_id: options.context.bindingId, worker: sessionPayload };
}

function verifySessionCaptureIdentity(
  context: SessionTranscriptCaptureContext,
  runner: TmuxRunner,
): string | null {
  const sessionName = context.session.tmux_session;
  const mismatches: string[] = [];
  let livePaneId: string | null = null;
  if (!sessionName) {
    mismatches.push("tmux_session_missing");
  } else {
    const live = tmuxSessionRunning(sessionName, runner);
    if (live) {
      livePaneId = currentPaneIdWithRunner(sessionName, runner);
    } else {
      mismatches.push(context.source === "legacy_manager" ? "manager_session_missing" : "tmux_session_missing");
    }
  }
  if (context.session.tmux_pane_id && livePaneId && context.session.tmux_pane_id !== livePaneId) {
    mismatches.push(context.source === "legacy_manager" ? "manager_pane_mismatch" : "tmux_pane_mismatch");
  }
  if (context.source === "legacy_worker") {
    const config = context.legacyWorkerConfig;
    const configToken = typeof config?.identity_token === "string" ? config.identity_token : null;
    const configSession = typeof config?.tmux_session === "string" ? config.tmux_session : null;
    const configPane = typeof config?.tmux_pane_id === "string" ? config.tmux_pane_id : null;
    if (!configToken) {
      mismatches.push("config_identity_token_missing");
    }
    if (configToken && configToken !== context.workerIdentityToken) {
      mismatches.push("identity_token_mismatch");
    }
    if (configSession !== context.session.tmux_session) {
      mismatches.push("tmux_session_mismatch");
    }
    if (configPane && context.session.tmux_pane_id && configPane !== context.session.tmux_pane_id) {
      mismatches.push("config_pane_mismatch");
    }
  }
  if (mismatches.length > 0) {
    if (context.source === "legacy_manager") {
      throw new Error(
        `Manager identity verification failed for ${context.session.name}: ${mismatches.join(", ")}`,
      );
    }
    if (context.source === "legacy_worker") {
      throw new Error(
        `Worker identity verification failed for ${context.session.name}: ${mismatches.join(", ")}`,
      );
    }
    throw new Error(
      `Session identity verification failed for ${context.session.name}: ${mismatches.join(", ")}`,
    );
  }
  return livePaneId;
}

function latestTerminalCaptureForRoleSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { role: "manager" | "worker"; taskId: string },
): { content: string | null; content_sha256: string; id: number } | null {
  const row = database.prepare(`
    select id, content_sha256, content
    from terminal_captures
    where task_id = ? and role = ?
    order by id desc
    limit 1
  `).get(options.taskId, options.role) as { content: string | null; content_sha256: string; id: number } | undefined;
  return row ?? null;
}

function insertTerminalCaptureSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    classifier: TerminalCaptureRecord["classifier"];
    contentSha256: string;
    historyLines: number;
    managerId: string | null;
    output: string;
    role: "manager" | "worker";
    source: string;
    taskId: string;
    timestamp: string;
    tmuxPaneId: string | null;
    tmuxSession: string;
    workerId: string | null;
  },
): number {
  const result = database.prepare(`
    insert into terminal_captures(
      task_id, worker_id, manager_id, role, tmux_session, tmux_pane_id,
      command_id, captured_at, history_lines, content_sha256, content,
      content_path, byte_count, line_count, classifier_json, source
    )
    values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, null, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.workerId,
    options.managerId,
    options.role,
    options.tmuxSession,
    options.tmuxPaneId,
    options.timestamp,
    options.historyLines,
    options.contentSha256,
    options.output,
    Buffer.byteLength(options.output),
    pythonSplitlinesCount(options.output),
    stableJson(options.classifier),
    options.source,
  );
  const captureId = Number(result.lastInsertRowid);
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      byte_count: Buffer.byteLength(options.output),
      classifier: options.classifier,
      content_path: null,
      history_lines: options.historyLines,
      line_count: pythonSplitlinesCount(options.output),
      tmux_pane_id: options.tmuxPaneId,
      tmux_session: options.tmuxSession,
    },
    correlation: {
      capture_id: captureId,
      command_id: null,
      manager_id: options.managerId,
      role: options.role,
      source: options.source,
      worker_id: options.workerId,
    },
    eventType: "terminal_capture_recorded",
    severity: "info",
    summary: `Recorded ${options.role} terminal capture.`,
    taskId: options.taskId,
    timestamp: options.timestamp,
  });
  return captureId;
}

function markManagerSeenSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { contentSha256: string; managerId: string; timestamp: string },
): void {
  database.prepare(`
    update managers
    set last_seen_at = ?,
        last_capture_sha256 = coalesce(?, last_capture_sha256)
    where id = ?
  `).run(options.timestamp, options.contentSha256, options.managerId);
}

function recordTranscriptSegmentSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    content: string;
    contentSha256: string;
    mode: TranscriptCaptureMode;
    previousCapture: { content: string | null; content_sha256: string; id: number } | null;
    role: "manager" | "worker";
    sourceCaptureId: number;
    taskId: string;
    timestamp: string;
  },
): TranscriptSegmentSummary | null {
  if (
    options.previousCapture
    && options.previousCapture.content_sha256 === options.contentSha256
    && options.mode !== "metadata"
  ) {
    return null;
  }
  const delta = segmentTextDelta(options.previousCapture?.content ?? null, options.content);
  let segmentText = delta.segmentText;
  let startLine = delta.startLine;
  let endLine = delta.endLine;
  let segmentKind = delta.segmentKind;
  if (segmentText === null && options.mode !== "metadata") {
    return null;
  }
  if (options.mode === "metadata") {
    segmentText = null;
    startLine = null;
    endLine = null;
    segmentKind = "metadata";
  } else if (options.mode === "excerpt") {
    const sourceLines = (segmentText ?? options.content).split(/\r?\n/);
    const excerptLines = sourceLines.slice(-40);
    segmentText = excerptLines.join("\n");
    endLine ??= pythonSplitlinesCount(options.content);
    startLine = Math.max(1, (endLine || 0) - excerptLines.length + 1);
    segmentKind = "excerpt";
  } else if (options.mode === "snapshot") {
    segmentText = options.content;
    startLine = 1;
    endLine = pythonSplitlinesCount(options.content);
    segmentKind = "snapshot";
  } else if (options.mode === "full") {
    segmentKind = segmentKind === "reset" ? "reset" : "segment";
  }
  const result = database.prepare(`
    insert into transcript_segments(
      task_id, role, source_capture_id, previous_capture_id, captured_at,
      content_sha256, segment_text, segment_start_line, segment_end_line,
      byte_count, line_count, retention_class, segment_kind, created_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hot', ?, ?)
  `).run(
    options.taskId,
    options.role,
    options.sourceCaptureId,
    options.previousCapture?.id ?? null,
    options.timestamp,
    options.contentSha256,
    segmentText,
    startLine,
    endLine,
    Buffer.byteLength(segmentText ?? ""),
    pythonSplitlinesCount(segmentText ?? ""),
    segmentKind,
    options.timestamp,
  );
  const segmentId = Number(result.lastInsertRowid);
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      byte_count: Buffer.byteLength(segmentText ?? ""),
      line_count: pythonSplitlinesCount(segmentText ?? ""),
      retention_class: "hot",
      segment_end_line: endLine,
      segment_kind: segmentKind,
      segment_start_line: startLine,
    },
    correlation: {
      previous_capture_id: options.previousCapture?.id ?? null,
      role: options.role,
      segment_id: segmentId,
      source_capture_id: options.sourceCaptureId,
    },
    eventType: "transcript_segment_recorded",
    severity: "info",
    summary: `Recorded ${options.role} transcript segment.`,
    taskId: options.taskId,
    timestamp: options.timestamp,
  });
  return {
    id: segmentId,
    line_count: pythonSplitlinesCount(segmentText ?? ""),
    mode: options.mode,
    previous_capture_id: options.previousCapture?.id ?? null,
    segment_kind: segmentKind,
    source_capture_id: options.sourceCaptureId,
  };
}

function segmentTextDelta(
  previous: string | null,
  current: string,
): { endLine: number | null; segmentKind: string; segmentText: string | null; startLine: number | null } {
  const currentLines = current.split(/\r?\n/).filter((_, index, lines) => index < lines.length - 1 || lines[index] !== "");
  if (previous === null) {
    if (currentLines.length === 0) {
      return { endLine: 0, segmentKind: "reset", segmentText: "", startLine: 1 };
    }
    return { endLine: currentLines.length, segmentKind: "reset", segmentText: current, startLine: 1 };
  }
  const previousLines = previous.split(/\r?\n/).filter((_, index, lines) => index < lines.length - 1 || lines[index] !== "");
  if (JSON.stringify(previousLines) === JSON.stringify(currentLines)) {
    return { endLine: null, segmentKind: "metadata", segmentText: null, startLine: null };
  }
  const maxOverlap = Math.min(previousLines.length, currentLines.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    const previousTail = previousLines.slice(previousLines.length - size);
    const currentHead = currentLines.slice(0, size);
    if (JSON.stringify(previousTail) === JSON.stringify(currentHead)) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) {
    const newLines = currentLines.slice(overlap);
    if (newLines.length === 0) {
      return { endLine: null, segmentKind: "metadata", segmentText: null, startLine: null };
    }
    return {
      endLine: currentLines.length,
      segmentKind: "segment",
      segmentText: newLines.join("\n"),
      startLine: overlap + 1,
    };
  }
  return { endLine: currentLines.length, segmentKind: "reset", segmentText: current, startLine: 1 };
}

function insertAgentObservationSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    message: string;
    managerId: string | null;
    payload: Record<string, unknown>;
    role: "manager" | "worker";
    sourceCaptureId: number;
    taskId: string;
    timestamp: string;
    workerId: string | null;
  },
): number {
  const result = database.prepare(`
    insert into agent_observations(
      task_id, worker_id, manager_id, role, observation_type, severity,
      source_capture_id, command_id, created_at, message, payload_json
    )
    values (?, ?, ?, ?, 'capture', 'info', ?, null, ?, ?, ?)
  `).run(
    options.taskId,
    options.workerId,
    options.managerId,
    options.role,
    options.sourceCaptureId,
    options.timestamp,
    options.message,
    stableJson(options.payload),
  );
  return Number(result.lastInsertRowid);
}

function redactCaptureResult(result: {
  captures: TranscriptCaptureCommandCapture[];
  mode: TranscriptCaptureMode;
  role: ReplayRole;
  task: string;
}): unknown {
  return {
    ...result,
    captures: result.captures.map((capture) => {
      if ("error" in capture || typeof capture.capture.output !== "string") {
        return capture;
      }
      const { output, ...capturePayload } = capture.capture;
      return {
        ...capture,
        capture: {
          ...capturePayload,
          output_byte_count: Buffer.byteLength(output),
          output_line_count: pythonSplitlinesCount(output),
          output_redacted: true,
        },
      };
    }),
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

function renderTranscriptCaptureText(captures: TranscriptCaptureCommandCapture[]): string {
  return captures.map((capture) => {
    if ("error" in capture) {
      return `${capture.role}: ${capture.error}`;
    }
    const segment = capture.transcript_segment;
    const segmentText = segment === null
      ? "no new transcript segment"
      : `segment ${segment.id} (${segment.segment_kind}, ${segment.line_count} lines)`;
    return `${capture.role}: capture ${capture.capture.id} ${segmentText}`;
  }).join("\n") + (captures.length > 0 ? "\n" : "");
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

function lastOpenCompatibilityEvent(
  name: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Record<string, unknown> | null {
  const events = readCompatibilityEvents(name, options).events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "open" || event?.type === "open_attempt") {
      return event;
    }
  }
  return null;
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

function resolveTerminal(terminal: TerminalChoice): Exclude<TerminalChoice, "auto"> {
  if (terminal !== "auto") {
    return terminal;
  }
  return existsSync("/Applications/Ghostty.app") ? "ghostty" : "terminal";
}

function attachSessionCommand(sessionName: string): string {
  return `tmux attach -t ${sessionName}`;
}

function terminalOpenCommand(sessionName: string, terminal: Exclude<TerminalChoice, "auto">): string[] {
  if (terminal === "ghostty") {
    return ["open", "-na", "Ghostty.app", "--args", "-e", "tmux", "attach", "-t", sessionName];
  }
  return [
    "osascript",
    "-e",
    'tell application "Terminal" to activate',
    "-e",
    `tell application "Terminal" to do script "${attachSessionCommand(sessionName)}"`,
  ];
}

function runTerminalCommand(
  command: string[],
  options: { terminalRunner?: (args: string[]) => { status: number; stderr?: string; stdout?: string } },
): void {
  const result = (options.terminalRunner ?? defaultTerminalRunner)(command);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(`${command.join(" ")} failed: ${detail}`);
  }
}

function sendTextToLegacyWorker(name: string, text: string, runner: TmuxRunner): void {
  const target = tmuxSession(name);
  if (!sessionExists(name, runner)) {
    throw new Error(`tmux session is not running for worker ${name}: ${target}`);
  }
  const bufferName = `workerctl-${name}`;
  try {
    runTmuxCommandWithRunner(["tmux", "set-buffer", "-b", bufferName, text], runner);
    runTmuxCommandWithRunner(["tmux", "paste-buffer", "-b", bufferName, "-t", target], runner);
    runTmuxCommandWithRunner(["tmux", "send-keys", "-t", target, "C-m"], runner);
  } finally {
    runner(["tmux", "delete-buffer", "-b", bufferName], { check: false });
  }
}

function runTmuxCommandWithRunner(args: string[], runner: TmuxRunner): void {
  const result = runner(args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(tmuxCommandFailureMessage(args, detail));
  }
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

interface LiveWorkerConfig extends Record<string, unknown> {
  _workerctl_lookup_source: "legacy" | "session";
}

function workerConfigOrSession(
  name: string,
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): LiveWorkerConfig {
  if (existsSync(configPath(name, options))) {
    return { ...requireWorkerConfig(name, options), _workerctl_lookup_source: "legacy" };
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const session = sessionRow(database, name);
    return { ...session, _workerctl_lookup_source: "session" };
  } finally {
    database.close();
  }
}

function tmuxTargetForConfig(name: string, config: LiveWorkerConfig): string {
  if (config._workerctl_lookup_source === "legacy") {
    return tmuxSession(name);
  }
  if (typeof config.tmux_session !== "string" || !config.tmux_session) {
    throw new Error(`tmux session is not registered for worker ${name}`);
  }
  return config.tmux_session;
}

function sessionExistsForConfig(
  name: string,
  config: LiveWorkerConfig,
  options: { tmuxRunner?: TmuxRunner },
): boolean {
  const target = tmuxTargetForConfig(name, config);
  return tmuxSessionRunning(target, options.tmuxRunner ?? defaultTmuxRunner);
}

function captureOutputForConfig(
  name: string,
  config: LiveWorkerConfig,
  historyLines: number,
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): { changed: boolean; changedAt: string; digest: string; output: string; workerId: string } {
  const target = tmuxTargetForConfig(name, config);
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  if (!sessionExistsForConfig(name, config, { tmuxRunner: runner })) {
    throw new Error(`tmux session is not running for worker ${name}: ${target}`);
  }
  const output = captureTmuxTargetWithRunner(target, historyLines, runner);
  const digest = createHash("sha256").update(output).digest("hex");
  const meta = loadJsonSync<Record<string, unknown>>(captureMetaPath(name, options), {});
  const previousDigest = typeof meta.sha256 === "string" ? meta.sha256 : null;
  const previousChangedAt = typeof meta.changed_at === "string" ? meta.changed_at : null;
  const capturedAt = nowIsoSeconds(options);
  const changed = digest !== previousDigest;
  const changedAt = changed ? capturedAt : previousChangedAt ?? capturedAt;
  writeJsonSync(captureMetaPath(name, options), {
    captured_at: capturedAt,
    changed_at: changedAt,
    history_lines: historyLines,
    sha256: digest,
  });
  writeFileSync(transcriptPath(name, options), output ? `${output}\n` : "");

  const database = openRuntimeDatabase(parsed, options);
  try {
    const paneId = typeof config.tmux_pane_id === "string" && config.tmux_pane_id
      ? config.tmux_pane_id
      : currentPaneIdWithRunner(target, runner);
    const workerId = upsertWorkerSync(database, {
      config: {
        ...config,
        tmux_pane_id: paneId,
        tmux_session: target,
      },
      name,
      timestamp: capturedAt,
    });
    insertTranscriptCaptureSync(database, {
      capturedAt,
      changed,
      changedAt,
      digest,
      historyLines,
      output,
      workerId,
    });
    return { changed, changedAt, digest, output, workerId };
  } finally {
    database.close();
  }
}

function insertTranscriptCaptureSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    capturedAt: string;
    changed: boolean;
    changedAt: string;
    digest: string;
    historyLines: number;
    output: string;
    workerId: string;
  },
): number {
  const result = database.prepare(`
    insert into transcript_captures(
      worker_id, sha256, content, captured_at, changed_at, history_lines,
      byte_count, line_count, capture_kind, retention_class
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hot')
  `).run(
    options.workerId,
    options.digest,
    options.changed ? options.output : null,
    options.capturedAt,
    options.changedAt,
    options.historyLines,
    Buffer.byteLength(options.output),
    pythonSplitlinesCount(options.output),
    options.changed ? "changed" : "metadata_only",
  );
  const captureId = Number(result.lastInsertRowid);
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      byte_count: Buffer.byteLength(options.output),
      changed: options.changed,
      history_lines: options.historyLines,
      line_count: pythonSplitlinesCount(options.output),
      retention_class: "hot",
    },
    correlation: { capture_id: captureId, worker_id: options.workerId },
    eventType: "transcript_capture_recorded",
    severity: "info",
    summary: "Recorded transcript capture metadata.",
    taskId: null,
    timestamp: options.capturedAt,
  });
  return captureId;
}

function idleSummary(
  name: string,
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): Record<string, unknown> {
  const config = workerConfigOrSession(name, parsed, options);
  const status = latestStatusSync(name, options);
  let captureMeta = loadJsonSync<Record<string, unknown>>(captureMetaPath(name, options), {});
  let captureError: string | null = null;
  let running: boolean;
  try {
    running = sessionExistsForConfig(name, config, options);
  } catch (error) {
    running = false;
    captureError = error instanceof Error ? error.message : String(error);
  }

  if (running && parsed.flags.refresh) {
    try {
      captureOutputForConfig(name, config, parsed.flags.lines, parsed, options);
      captureMeta = loadJsonSync<Record<string, unknown>>(captureMetaPath(name, options), {});
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error);
    }
  }

  const state = typeof status.state === "string" && VALID_WORKER_STATUS_STATES.has(status.state)
    ? status.state
    : "unknown";
  const now = options.now?.() ?? new Date();
  const statusAge = ageSecondsAt(status.last_update, now);
  const terminalAge = ageSecondsAt(stringOrNull(captureMeta.changed_at) ?? undefined, now);
  const statusIsStale = statusAge === null || statusAge >= parsed.flags.statusStaleSeconds;
  const terminalIsStale = terminalAge === null || terminalAge >= parsed.flags.terminalStaleSeconds;
  let terminalOutput = "";
  let terminalFresh = true;
  if (running) {
    try {
      terminalOutput = captureTmuxTargetWithRunner(
        tmuxTargetForConfig(name, config),
        parsed.flags.lines,
        options.tmuxRunner ?? defaultTmuxRunner,
      );
    } catch (error) {
      terminalFresh = false;
      captureError ??= error instanceof Error ? error.message : String(error);
      const transcriptFile = transcriptPath(name, options);
      terminalOutput = existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : "";
    }
  }
  if (captureError !== null) {
    terminalFresh = false;
  }
  const busyWait = classifyBusyWait(terminalOutput, statusAge, parsed.flags.busyWaitSeconds);

  let health: string;
  let recommendedAction: string;
  let reason: string;
  if (!running) {
    health = "stopped";
    recommendedAction = "none";
    reason = "tmux session is not running";
  } else if (state === "blocked") {
    health = "blocked";
    recommendedAction = "read_blocker";
    reason = "worker status.json reports blocked";
  } else if (state === "done") {
    health = "done";
    recommendedAction = "review_result";
    reason = "worker status.json reports done";
  } else if (captureError) {
    health = "unknown";
    recommendedAction = "inspect_terminal";
    reason = captureError;
  } else if (busyWait) {
    health = "busy_wait";
    recommendedAction = busyWait.recommended_action;
    reason = busyWait.reason;
  } else if (terminalIsStale && statusIsStale) {
    health = "stale";
    recommendedAction = "ask_for_status";
    reason = "terminal output and status.json are both stale";
  } else if (terminalIsStale) {
    health = "quiet";
    recommendedAction = "wait";
    reason = "terminal output is stale but status.json is fresh";
  } else if (statusIsStale) {
    health = "status_stale";
    recommendedAction = "wait";
    reason = "terminal output changed recently but status.json is stale";
  } else {
    health = "active";
    recommendedAction = "none";
    reason = "terminal output and status.json are fresh";
  }

  return {
    blocker: status.blocker ?? null,
    busy_wait_pattern: busyWait?.pattern ?? null,
    busy_wait_seconds: parsed.flags.busyWaitSeconds,
    capture_error: captureError,
    current_task: status.current_task ?? null,
    health,
    name,
    next_action: status.next_action ?? null,
    reason,
    recommended_action: recommendedAction,
    running,
    state,
    status_age_seconds: statusAge,
    status_last_update: status.last_update ?? null,
    status_stale_seconds: parsed.flags.statusStaleSeconds,
    terminal_age_seconds: terminalAge,
    terminal_changed_at: stringOrNull(captureMeta.changed_at),
    terminal_fresh: terminalFresh,
    terminal_stale_seconds: parsed.flags.terminalStaleSeconds,
    tmux_session: stringOrNull(config.tmux_session),
  };
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

function nowIsoSeconds(options: { now?: () => Date } = {}): string {
  return (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ageSecondsAt(value: string | undefined, now: Date): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value.replace(/Z$/, "+00:00"));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return Math.max(0, Math.trunc((now.getTime() - parsed.getTime()) / 1000));
}

function defaultTmuxRunner(args: string[]): { status: number; stderr?: string; stdout?: string } {
  const result = spawnSync(args[0] ?? "", args.slice(1), { encoding: "utf8" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if ((args[0] ?? "") === "tmux" && code === "ENOENT") {
      return { status: 127, stderr: "tmux is not installed or is not available on PATH" };
    }
    if ((args[0] ?? "") === "tmux" && code === "EACCES") {
      return { status: 126, stderr: result.error.message };
    }
    return { status: 127, stderr: result.error.message };
  }
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function defaultTerminalRunner(args: string[]): { status: number; stderr?: string; stdout?: string } {
  const result = spawnSync(args[0] ?? "", args.slice(1), { encoding: "utf8" });
  if (result.error) {
    return { status: 127, stderr: result.error.message };
  }
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stderr: result.stderr,
    stdout: result.stdout,
  };
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

function isTerminalChoice(value: string): value is TerminalChoice {
  return value === "auto" || value === "ghostty" || value === "terminal";
}

function isSessionRole(value: string): value is "manager" | "worker" {
  return value === "manager" || value === "worker";
}

function isSessionState(value: string): value is "active" | "all" | "gone" {
  return value === "active" || value === "all" || value === "gone";
}

function isTranscriptCaptureMode(value: string): value is TranscriptCaptureMode {
  return value === "metadata" || value === "excerpt" || value === "snapshot" || value === "segment" || value === "full";
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
