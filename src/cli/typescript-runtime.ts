import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { taskAuditSync } from "../runtime/audit.js";
import { classifyBusyWait, classifyStartupOutput } from "../runtime/classify.js";
import { exportTaskAuditSubsetSync } from "../runtime/export.js";
import { ingestSessionSync } from "../runtime/ingest.js";
import {
  acceptanceCriteriaForTaskSync,
  recordAdversarialLoopEvidenceSync,
  recordLoopEvidenceSync,
  recordVisualDiffLoopEvidenceSync,
  type AcceptanceCriterionRecord,
  type AcceptanceCriterionSource,
  type AcceptanceCriterionStatus,
} from "../runtime/loop-evidence.js";
import {
  renderReplayText,
  replayResultFromAudit,
  type ReplayMode,
  type ReplayRole,
} from "../runtime/replay.js";
import {
  claimNextDispatchCommandSync,
  claimableDispatchCommandsSync,
  createCommandSync,
  finishCommandAttemptSync,
  recoverStaleDispatchClaimsSync,
  type ClaimedCommand,
} from "../runtime/commands.js";
import { executeDispatchCommandSync } from "../runtime/dispatch.js";
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
  normalizeManagerPermissions,
  type ManagerPermissionCategory,
  type ManagerPermissions,
} from "../runtime/manager-permissions.js";
import {
  deferRoutedNotificationBeforeSideEffectSync,
  deliveryModeForTargetSessionSync,
  finishRoutedNotificationSync,
  insertRoutedNotificationSync,
  markRoutedNotificationSideEffectStartedSync,
} from "../runtime/notifications.js";
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
  validateWorkerName,
  workerDir,
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
const DEFAULT_WAIT_READY_SECONDS = 30;
const DEFAULT_STATUS_STALE_SECONDS = 300;
const DEFAULT_TERMINAL_STALE_SECONDS = 300;
const START_PASSTHROUGH_FLAGS_WITH_VALUES = new Set([
  "--add-dir",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--image",
  "--model",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "--sandbox",
  "-C",
  "-a",
  "-c",
  "-i",
  "-m",
  "-p",
  "-s",
]);
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
const RUN_STATUSES = new Set(["active", "finished", "failed", "abandoned"]);

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
  dispatchRunner?: (command: string[], options: { cwd: string }) => { pid: number | null };
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
    if (parsed.command === "criteria") {
      return runCriteriaCommand(parsed, options);
    }
    if (parsed.command === "criteria-plan") {
      return runCriteriaPlanCommand(parsed, options);
    }
    if (parsed.command === "runs") {
      return runRunsCommand(parsed, options);
    }
    if (parsed.command === "loop-evidence") {
      return runLoopEvidenceCommand(parsed, options);
    }
    if (parsed.command === "loop-templates") {
      return runLoopTemplatesCommand(parsed, options);
    }
    if (parsed.command === "ralph-loop-presets") {
      return runRalphLoopPresetsCommand(parsed, options);
    }
    if (parsed.command === "loop-triggers") {
      return runLoopTriggersCommand(parsed, options);
    }
    if (parsed.command === "loop-status") {
      return runLoopStatusCommand(parsed, options);
    }
    if (parsed.command === "tasks") {
      return runTasksCommand(parsed, options);
    }
    if (parsed.command === "start") {
      return runLegacyStartCommand(parsed, options);
    }
    if (parsed.command === "create") {
      return runLegacyCreateCommand(parsed, options);
    }
    if (parsed.command === "start-test") {
      return runLegacyStartTestCommand(parsed, options);
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
    if (parsed.command === "pair") {
      return runPairCommand(parsed, options);
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
    if (parsed.command === "commands") {
      return runCommandsCommand(parsed, options);
    }
    if (parsed.command === "enqueue-notify-manager") {
      return runEnqueueCommand(parsed, options, "notify_manager");
    }
    if (parsed.command === "enqueue-nudge-worker") {
      return runEnqueueCommand(parsed, options, "nudge_worker");
    }
    if (parsed.command === "enqueue-continue-iteration") {
      return runEnqueueCommand(parsed, options, "continue_iteration");
    }
    if (parsed.command === "dispatch") {
      return runDispatchCommand(parsed, options);
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
    attempts: boolean;
    json: boolean;
    includeLegacy: boolean;
    redactIdentityToken: boolean;
    active: boolean;
    add: boolean;
    blocker: string | null;
    busyWaitSeconds: number;
    candidate: string | null;
    check: string | null;
    classifyPrompt: string | null;
    codexSession: string | null;
    create: string | null;
    createRun: string | null;
    criterion: string | null;
    currentTask: string | null;
    currentIteration: number;
    currentIterationProvided: boolean;
    cwd: string | null;
    deferCriterion: number | null;
    diffOutput: string | null;
    dryRun: boolean;
    evidenceJson: string | null;
    evidenceType: string | null;
    eventType: string | null;
    file: string | null;
    finishRun: string | null;
    fromText: string | null;
    fromWorkerResponse: string | null;
    fromStdin: boolean;
    failureMode: string | null;
    goal: string | null;
    keepLatest: number;
    list: boolean;
    lines: number;
    limit: number | null;
    metadataJson: string | null;
    names: string[];
    nextAction: string | null;
    output: string | null;
    path: string | null;
    pid: number | null;
    preset: string | null;
    role: ReplayRole;
    roleProvided: boolean;
    refresh: boolean;
    reference: string | null;
    rejectCriterion: number | null;
    reportOutput: string | null;
    result: string | null;
    sessionRole: "manager" | "worker" | null;
    sessionState: "active" | "all" | "gone" | null;
    show: string | null;
    showRun: string | null;
    satisfyCriterion: number | null;
    statusAgeSeconds: number;
    statusState: string | null;
    statuses: string[];
    statusStaleSeconds: number;
    subtype: string | null;
    summary: string | null;
    source: string | null;
    proof: string | null;
    purpose: string | null;
    rationale: string | null;
    taskName: string | null;
    terminal: TerminalChoice;
    text: string | null;
    terminalStaleSeconds: number;
    threshold: number | null;
    tmuxSession: string | null;
    transcriptMode: TranscriptCaptureMode;
    requireSegment: boolean;
    worker: string | null;
    acceptCriterion: number | null;
    manager: string | null;
    maxIterations: number | null;
    zip: boolean;
    requiredBeforeContinue: string[];
    run: string | null;
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
    correlationId: string | null;
    dispatcherId: string | null;
    dispatchType: string | null;
    idempotencyKey: string | null;
    intervalSeconds: number;
    leaseSeconds: number;
    loopRun: string | null;
    managerAllowMergeGreen: boolean;
    managerAllowPr: boolean;
    managerAllowWorkerCompactClear: boolean;
    managerAcceptance: string[];
    managerEpilogue: string[];
    managerGuideline: string[];
    managerMode: string | null;
    managerName: string | null;
    managerNudgeOnCompletion: string | null;
    managerObjective: string | null;
    managerPermissionsJson: string | null;
    managerPermit: string[];
    managerReference: string[];
    managerRequireAcks: boolean;
    managerTool: string[];
    noDispatch: boolean;
    once: boolean;
    requiredPermission: string | null;
    requestedIteration: number | null;
    taskPrompt: string | null;
    taskSummary: string | null;
    workerName: string | null;
    reuse: boolean;
    initialPrompt: boolean;
    startPrompt: boolean;
    waitReady: boolean;
    waitReadyTimeout: number;
    verify: boolean;
    verifyTimeout: number;
    open: boolean;
    forceOpen: boolean;
    stopAfter: boolean;
    watch: boolean;
    watchIterations: number | null;
  };
  defaultRuntime?: boolean;
  explicit: boolean;
  passthroughArgs?: string[];
  task: string | null;
}

type RuntimeFlagKey = keyof ParsedRuntimeArgs["flags"];

function parseRuntimeArgs(args: readonly string[], env: NodeJS.ProcessEnv): ParsedRuntimeArgs {
  const flags: ParsedRuntimeArgs["flags"] = {
    format: "timeline",
    includeContent: false,
    includeFullTranscripts: false,
    includeTranscripts: false,
    all: false,
    attempts: false,
    json: false,
    includeLegacy: false,
    redactIdentityToken: false,
    active: false,
    add: false,
    blocker: null,
    busyWaitSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    candidate: null,
    check: null,
    classifyPrompt: null,
    codexSession: null,
    create: null,
    createRun: null,
    criterion: null,
    currentTask: null,
    currentIteration: 1,
    currentIterationProvided: false,
    cwd: null,
    deferCriterion: null,
    diffOutput: null,
    dryRun: false,
    evidenceJson: null,
    evidenceType: null,
    eventType: null,
    failureMode: null,
    file: null,
    finishRun: null,
    fromStdin: false,
    fromText: null,
    fromWorkerResponse: null,
    goal: null,
    keepLatest: 20,
    list: false,
    lines: DEFAULT_HISTORY_LINES,
    limit: null,
    metadataJson: null,
    names: [],
    nextAction: null,
    output: null,
    path: null,
    pid: null,
    preset: null,
    role: "all",
    roleProvided: false,
    refresh: true,
    reference: null,
    rejectCriterion: null,
    reportOutput: null,
    result: null,
    sessionRole: null,
    sessionState: null,
    show: null,
    showRun: null,
    satisfyCriterion: null,
    statusAgeSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    statusState: null,
    statuses: [],
    statusStaleSeconds: DEFAULT_STATUS_STALE_SECONDS,
    subtype: null,
    summary: null,
    source: null,
    proof: null,
    purpose: null,
    rationale: null,
    taskName: null,
    terminal: "auto",
    text: null,
    terminalStaleSeconds: DEFAULT_TERMINAL_STALE_SECONDS,
    threshold: null,
    tmuxSession: null,
    transcriptMode: "segment",
    requireSegment: false,
    worker: null,
    acceptCriterion: null,
    manager: null,
    maxIterations: null,
    zip: false,
    requiredBeforeContinue: [],
    run: null,
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
    correlationId: null,
    dispatcherId: null,
    dispatchType: null,
    idempotencyKey: null,
    intervalSeconds: 2.0,
    leaseSeconds: 60,
    loopRun: null,
    managerAllowMergeGreen: false,
    managerAllowPr: false,
    managerAllowWorkerCompactClear: false,
    managerAcceptance: [],
    managerEpilogue: [],
    managerGuideline: [],
    managerMode: null,
    managerName: null,
    managerNudgeOnCompletion: null,
    managerObjective: null,
    managerPermissionsJson: null,
    managerPermit: [],
    managerReference: [],
    managerRequireAcks: false,
    managerTool: [],
    noDispatch: false,
    once: false,
    requiredPermission: null,
    requestedIteration: null,
    taskPrompt: null,
    taskSummary: null,
    workerName: null,
    reuse: false,
    initialPrompt: true,
    startPrompt: true,
    waitReady: false,
    waitReadyTimeout: DEFAULT_WAIT_READY_SECONDS,
    verify: false,
    verifyTimeout: 60,
    open: false,
    forceOpen: false,
    stopAfter: false,
    watch: false,
    watchIterations: null,
  };
  const queue = [...args];
  const passthroughArgs: string[] = [];
  let explicit = false;
  let enabled = env.AGENT_CONVEYOR_TS_RUNTIME === "1";
  if (queue[0] === "--ts-runtime") {
    explicit = true;
    enabled = true;
    queue.shift();
  }
  const command = queue.shift() ?? null;
  if (command === "pair") {
    flags.dispatcherId = "dispatch-pair";
    flags.timeoutSeconds = 60;
  }
  let task: string | null = null;
  for (let index = 0; index < queue.length; index += 1) {
    const arg = queue[index];
    if (command === "start" && isHelpArg(arg)) {
      return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, passthroughArgs, task };
    }
    if (command === "start" && arg !== "--cwd" && arg !== "--no-start-prompt" && arg !== "--" && isStartPassthroughFlag(arg)) {
      passthroughArgs.push(arg);
      if (startPassthroughFlagTakesValue(arg) && queue[index + 1] && !queue[index + 1].startsWith("--")) {
        passthroughArgs.push(queue[index + 1]);
        index += 1;
      }
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--all") {
      flags.all = true;
    } else if (arg === "--active") {
      flags.active = true;
    } else if (arg === "--add") {
      if (command !== "criteria") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --add", explicit, flags, passthroughArgs, task };
      }
      flags.add = true;
    } else if (arg === "--list") {
      if (
        command !== "criteria"
        && command !== "runs"
        && command !== "loop-templates"
        && command !== "ralph-loop-presets"
        && command !== "loop-triggers"
      ) {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --list", explicit, flags, passthroughArgs, task };
      }
      flags.list = true;
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
    } else if (arg === "--attempts") {
      if (command !== "commands") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --attempts", explicit, flags, passthroughArgs, task };
      }
      flags.attempts = true;
    } else if (arg === "--once") {
      if (command !== "dispatch") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --once", explicit, flags, passthroughArgs, task };
      }
      flags.once = true;
    } else if (arg === "--watch") {
      if (command !== "dispatch") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --watch", explicit, flags, passthroughArgs, task };
      }
      flags.watch = true;
    } else if (arg === "--force") {
      if (command !== "open") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --force", explicit, flags, passthroughArgs, task };
      }
      flags.force = true;
    } else if (arg === "--terminal") {
      if (command !== "open" && command !== "open-worker" && command !== "open-manager" && command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --terminal", explicit, flags, passthroughArgs, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, passthroughArgs, task };
      }
      const value = parsedValue.value;
      if (!isTerminalChoice(value)) {
        return { command, enabled, error: `Unsupported terminal: ${value}`, explicit, flags, passthroughArgs, task };
      }
      flags.terminal = value;
      index += 1;
    } else if (arg === "--accept-trust") {
      if (command !== "start-worker" && command !== "start-manager" && command !== "pair" && command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --accept-trust", explicit, flags, passthroughArgs, task };
      }
      flags.acceptTrust = true;
    } else if (arg === "--reuse") {
      if (command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --reuse", explicit, flags, passthroughArgs, task };
      }
      flags.reuse = true;
    } else if (arg === "--no-initial-prompt" || arg === "--no-send-contract") {
      if (command !== "create") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, passthroughArgs, task };
      }
      flags.initialPrompt = false;
    } else if (arg === "--no-start-prompt") {
      if (command !== "start") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --no-start-prompt", explicit, flags, passthroughArgs, task };
      }
      flags.startPrompt = false;
    } else if (arg === "--wait-ready") {
      if (command !== "create") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --wait-ready", explicit, flags, passthroughArgs, task };
      }
      flags.waitReady = true;
    } else if (arg === "--verify") {
      if (command !== "create") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --verify", explicit, flags, passthroughArgs, task };
      }
      flags.verify = true;
    } else if (arg === "--open") {
      if (command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --open", explicit, flags, passthroughArgs, task };
      }
      flags.open = true;
    } else if (arg === "--force-open") {
      if (command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --force-open", explicit, flags, passthroughArgs, task };
      }
      flags.forceOpen = true;
    } else if (arg === "--stop-after") {
      if (command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --stop-after", explicit, flags, passthroughArgs, task };
      }
      flags.stopAfter = true;
    } else if (arg === "--no-dispatch") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --no-dispatch", explicit, flags, task };
      }
      flags.noDispatch = true;
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
    } else if (arg === "--show") {
      if (command !== "runs" && command !== "loop-templates" && command !== "ralph-loop-presets") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --show", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (command === "runs") {
        flags.showRun = value.value;
      } else {
        flags.show = value.value;
      }
      index += 1;
    } else if (arg === "--create-run") {
      if (command !== "loop-templates" && command !== "ralph-loop-presets") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --create-run", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.createRun = value.value;
      index += 1;
    } else if (arg === "--finish") {
      if (command !== "runs") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --finish", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.finishRun = value.value;
      index += 1;
    } else if (arg === "--goal") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.goal = value.value;
      index += 1;
    } else if (arg === "--criterion") {
      if (command !== "criteria") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --criterion", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.criterion = value.value;
      index += 1;
    } else if (arg === "--source") {
      if (command !== "criteria" && command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --source", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.source = value.value;
      index += 1;
    } else if (arg === "--proof") {
      if (command !== "criteria" && command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --proof", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.proof = value.value;
      index += 1;
    } else if (arg === "--rationale") {
      if (command !== "criteria") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --rationale", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.rationale = value.value;
      index += 1;
    } else if (arg === "--evidence-json") {
      if (command !== "criteria") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --evidence-json", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.evidenceJson = value.value;
      index += 1;
    } else if (arg === "--metadata-json") {
      if (command !== "runs" && command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --metadata-json", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.metadataJson = value.value;
      index += 1;
    } else if (arg === "--accept" || arg === "--satisfy" || arg === "--defer" || arg === "--reject") {
      if (command !== "criteria") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: `${arg} must be an integer.`, explicit, flags, task };
      }
      if (arg === "--accept") {
        flags.acceptCriterion = value;
      } else if (arg === "--satisfy") {
        flags.satisfyCriterion = value;
      } else if (arg === "--defer") {
        flags.deferCriterion = value;
      } else {
        flags.rejectCriterion = value;
      }
      index += 1;
    } else if (arg === "--purpose") {
      if (command !== "runs") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --purpose", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.purpose = value.value;
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
      if (command !== "start-worker" && command !== "start-manager" && command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --sandbox", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.sandbox = value.value;
      index += 1;
    } else if (arg === "--ask-for-approval") {
      if (command !== "start-worker" && command !== "start-manager" && command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --ask-for-approval", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.askForApproval = value.value;
      index += 1;
    } else if (arg === "--codex-profile") {
      if (command !== "start-worker" && command !== "start-manager" && command !== "pair") {
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
    } else if (arg === "--classify") {
      if (command !== "loop-triggers") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --classify", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.classifyPrompt = value.value;
      index += 1;
    } else if (arg === "--from-text") {
      if (command !== "criteria-plan") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --from-text", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.fromText = value.value;
      index += 1;
    } else if (arg === "--from-worker-response") {
      if (command !== "criteria-plan") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --from-worker-response", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.fromWorkerResponse = value.value;
      index += 1;
    } else if (arg === "--from-stdin") {
      if (command !== "criteria-plan") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --from-stdin", explicit, flags, task };
      }
      flags.fromStdin = true;
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
      if (command !== "start-manager" && command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --task-goal", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.taskGoal = value.value;
      index += 1;
    } else if (arg === "--task-prompt") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --task-prompt", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.taskPrompt = value.value;
      index += 1;
    } else if (arg === "--task-summary") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --task-summary", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.taskSummary = value.value;
      index += 1;
    } else if (arg === "--worker-name") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --worker-name", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.workerName = value.value;
      index += 1;
    } else if (arg === "--manager-name") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-name", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerName = value.value;
      index += 1;
    } else if (arg === "--dispatcher-id") {
      if (command !== "pair" && command !== "dispatch") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --dispatcher-id", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.dispatcherId = value.value;
      index += 1;
    } else if (arg === "--manager-mode") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-mode", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerMode = value.value;
      index += 1;
    } else if (arg === "--manager-objective") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-objective", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerObjective = value.value;
      index += 1;
    } else if (arg === "--manager-guideline") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-guideline", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerGuideline.push(value.value);
      index += 1;
    } else if (arg === "--manager-acceptance") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-acceptance", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerAcceptance.push(value.value);
      index += 1;
    } else if (arg === "--manager-reference") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-reference", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerReference.push(value.value);
      index += 1;
    } else if (arg === "--manager-permit") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-permit", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerPermit.push(value.value);
      index += 1;
    } else if (arg === "--manager-tool") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-tool", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerTool.push(value.value);
      index += 1;
    } else if (arg === "--manager-epilogue") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-epilogue", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerEpilogue.push(value.value);
      index += 1;
    } else if (arg === "--manager-nudge-on-completion") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-nudge-on-completion", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerNudgeOnCompletion = value.value;
      index += 1;
    } else if (arg === "--manager-require-acks") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-require-acks", explicit, flags, task };
      }
      flags.managerRequireAcks = true;
    } else if (arg === "--manager-allow-pr") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-allow-pr", explicit, flags, task };
      }
      flags.managerAllowPr = true;
    } else if (arg === "--manager-allow-merge-green") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-allow-merge-green", explicit, flags, task };
      }
      flags.managerAllowMergeGreen = true;
    } else if (arg === "--manager-allow-worker-compact-clear") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-allow-worker-compact-clear", explicit, flags, task };
      }
      flags.managerAllowWorkerCompactClear = true;
    } else if (arg === "--manager-permissions-json") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-permissions-json", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerPermissionsJson = value.value;
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
      if (
        command !== "finish-task"
        && command !== "stop-task"
        && command !== "stop"
        && command !== "enqueue-notify-manager"
        && command !== "enqueue-nudge-worker"
        && command !== "enqueue-continue-iteration"
      ) {
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
    } else if (arg === "--manager-decision-id") {
      if (command !== "enqueue-continue-iteration") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-decision-id", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--manager-decision-id must be an integer.", explicit, flags, task };
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
      if (command !== "create-disposable-binding" && command !== "loop-templates") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --template", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.template = value.value;
      index += 1;
    } else if (arg === "--preset") {
      if (command !== "ralph-loop-presets") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --preset", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.preset = value.value;
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
      if (command !== "create-disposable-binding" && command !== "loop-templates" && command !== "ralph-loop-presets") {
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
      if (command === "commands") {
        if (!["pending", "attempted", "succeeded", "failed", "blocked"].includes(value)) {
          return { command, enabled, error: `Unsupported command state: ${value}`, explicit, flags, task };
        }
        flags.statusState = value;
      } else if (command === "update-status") {
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
    } else if (arg === "--status") {
      if (command !== "criteria" && command !== "runs" && command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --status", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      if (command === "criteria") {
        flags.statuses.push(parsedValue.value);
      } else {
        flags.statusState = parsedValue.value;
      }
      index += 1;
    } else if (arg === "--type") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (command === "dispatch") {
        if (!["notify_manager", "nudge_worker", "continue_iteration", "worker_task_complete"].includes(value.value)) {
          return { command, enabled, error: "dispatch --type supports notify_manager, nudge_worker, continue_iteration, and worker_task_complete", explicit, flags, task };
        }
        flags.dispatchType = value.value;
      } else if (command === "commands") {
        flags.dispatchType = value.value;
      } else {
        flags.eventType = value.value;
      }
      index += 1;
    } else if (arg === "--iteration") {
      if (command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --iteration", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--iteration must be an integer.", explicit, flags, task };
      }
      flags.currentIteration = value;
      index += 1;
    } else if (arg === "--evidence-type") {
      if (command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --evidence-type", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.evidenceType = value.value;
      index += 1;
    } else if (arg === "--artifact-path") {
      if (command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --artifact-path", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.output = value.value;
      index += 1;
    } else if (arg === "--reference" || arg === "--candidate" || arg === "--diff-output" || arg === "--report-output") {
      if (command !== "loop-evidence") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (arg === "--reference") {
        flags.reference = value.value;
      } else if (arg === "--candidate") {
        flags.candidate = value.value;
      } else if (arg === "--diff-output") {
        flags.diffOutput = value.value;
      } else {
        flags.reportOutput = value.value;
      }
      index += 1;
    } else if (arg === "--threshold") {
      if (command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --threshold", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isFinite(value)) {
        return { command, enabled, error: "--threshold must be a number.", explicit, flags, task };
      }
      flags.threshold = value;
      index += 1;
    } else if (arg === "--failure-mode" || arg === "--check" || arg === "--result") {
      if (command !== "loop-evidence") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (arg === "--failure-mode") {
        flags.failureMode = value.value;
      } else if (arg === "--check") {
        flags.check = value.value;
      } else {
        flags.result = value.value;
      }
      index += 1;
    } else if (arg === "--required-permission") {
      if (command !== "enqueue-notify-manager" && command !== "enqueue-nudge-worker" && command !== "enqueue-continue-iteration") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --required-permission", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.requiredPermission = value.value;
      index += 1;
    } else if (arg === "--idempotency-key") {
      if (command !== "enqueue-notify-manager" && command !== "enqueue-nudge-worker" && command !== "enqueue-continue-iteration") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --idempotency-key", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.idempotencyKey = value.value;
      index += 1;
    } else if (arg === "--correlation-id") {
      if (
        command !== "enqueue-notify-manager"
        && command !== "enqueue-nudge-worker"
        && command !== "enqueue-continue-iteration"
        && command !== "loop-evidence"
      ) {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --correlation-id", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.correlationId = value.value;
      index += 1;
    } else if (arg === "--loop-run") {
      if (command !== "enqueue-continue-iteration" && command !== "loop-evidence") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --loop-run", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.loopRun = value.value;
      index += 1;
    } else if (arg === "--run") {
      if (command !== "loop-status") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --run", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.run = value.value;
      index += 1;
    } else if (arg === "--requested-iteration") {
      if (command !== "enqueue-continue-iteration") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --requested-iteration", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--requested-iteration must be an integer.", explicit, flags, task };
      }
      flags.requestedIteration = value;
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
    } else if (arg === "--interval") {
      if (command !== "dispatch") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --interval", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isFinite(value)) {
        return { command, enabled, error: "--interval must be a number.", explicit, flags, task };
      }
      flags.intervalSeconds = value;
      index += 1;
    } else if (arg === "--watch-iterations") {
      if (command !== "dispatch") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --watch-iterations", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--watch-iterations must be an integer.", explicit, flags, task };
      }
      flags.watchIterations = value;
      index += 1;
    } else if (arg === "--lease-seconds") {
      if (command !== "dispatch") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --lease-seconds", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--lease-seconds must be an integer.", explicit, flags, task };
      }
      flags.leaseSeconds = value;
      index += 1;
    } else if (arg === "--max-iterations") {
      if (command !== "create-disposable-binding" && command !== "loop-templates" && command !== "ralph-loop-presets") {
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
      if (command !== "create-disposable-binding" && command !== "loop-templates" && command !== "ralph-loop-presets") {
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
      flags.currentIterationProvided = true;
      index += 1;
    } else if (arg === "--timeout-seconds") {
      if (command !== "start-worker" && command !== "start-manager" && command !== "pair") {
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
    } else if (arg === "--wait-ready-timeout") {
      if (command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --wait-ready-timeout", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value <= 0) {
        return { command, enabled, error: "--wait-ready-timeout must be a positive integer.", explicit, flags, task };
      }
      flags.waitReadyTimeout = value;
      index += 1;
    } else if (arg === "--verify-timeout") {
      if (command !== "create" && command !== "start-test") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --verify-timeout", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value <= 0) {
        return { command, enabled, error: "--verify-timeout must be a positive integer.", explicit, flags, task };
      }
      flags.verifyTimeout = value;
      index += 1;
    } else if (arg === "--" && command === "start") {
      passthroughArgs.push(...queue.slice(index + 1));
      break;
    } else if (arg.startsWith("--")) {
      if (command === "start") {
        passthroughArgs.push(arg);
        if (startPassthroughFlagTakesValue(arg) && queue[index + 1] && !queue[index + 1].startsWith("--")) {
          passthroughArgs.push(queue[index + 1]);
          index += 1;
        }
        continue;
      }
      return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
    } else if (command === "start" && isStartPassthroughFlag(arg)) {
      passthroughArgs.push(arg);
      if (startPassthroughFlagTakesValue(arg) && queue[index + 1] && !queue[index + 1].startsWith("--")) {
        passthroughArgs.push(queue[index + 1]);
        index += 1;
      }
    } else if (command === "loop-evidence" && flags.subtype === null) {
      if (!["add", "visual-diff", "visual_diff", "adversarial-check", "adversarial_check"].includes(arg)) {
        return { command, enabled, error: `Unsupported loop-evidence action: ${arg}`, explicit, flags, task };
      }
      flags.subtype = arg;
    } else if (task === null) {
      task = arg;
    } else if (command === "start") {
      passthroughArgs.push(arg);
    } else {
      return { command, enabled, error: `Unexpected argument: ${arg}`, explicit, flags, task };
    }
  }
  return { command, enabled, explicit, flags, passthroughArgs, task };
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

function runCriteriaCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const actionCount = [
    parsed.flags.list,
    parsed.flags.add,
    parsed.flags.acceptCriterion !== null,
    parsed.flags.satisfyCriterion !== null,
    parsed.flags.deferCriterion !== null,
    parsed.flags.rejectCriterion !== null,
  ].filter(Boolean).length;
  if (actionCount !== 1) {
    return unsupportedRuntimeResult(parsed, "criteria requires exactly one action: --list, --add, --accept, --satisfy, --defer, or --reject.");
  }
  const taskName = requireTask(parsed);
  const evidence = jsonObjectArg(parsed.flags.evidenceJson, "--evidence-json");
  const database = openRuntimeDatabase(parsed, options);
  let criteriaMutation = false;
  try {
    const taskRow = taskRowForLifecycle(database, taskName);
    if (taskRow === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    let affected: AcceptanceCriterionRecord | null = null;
    if (parsed.flags.add) {
      if (!parsed.flags.criterion) {
        return errorResult("--criterion is required with criteria --add");
      }
      if (!parsed.flags.source) {
        return errorResult("--source is required with criteria --add");
      }
      if (parsed.flags.statuses.length > 1) {
        return errorResult("criteria --add accepts at most one --status");
      }
      const status = parseCriterionStatus(parsed.flags.statuses[0] ?? "proposed");
      const source = parseCriterionSource(parsed.flags.source);
      beginImmediateSync(database);
      criteriaMutation = true;
      affected = insertAcceptanceCriterionFromCliSync(database, {
        criterion: parsed.flags.criterion,
        evidence,
        proof: parsed.flags.proof,
        rationale: parsed.flags.rationale,
        source,
        status,
        taskId: taskRow.id,
      });
    } else if (!parsed.flags.list) {
      if (parsed.flags.statuses.length > 0) {
        return errorResult("--status is only supported with criteria --list or --add");
      }
      const transition = criteriaTransition(parsed);
      if (transition === null) {
        return errorResult("criteria update requires --accept, --satisfy, --defer, or --reject.");
      }
      beginImmediateSync(database);
      criteriaMutation = true;
      affected = updateAcceptanceCriterionFromCliSync(database, {
        criterionId: transition.criterionId,
        evidence: parsed.flags.evidenceJson === null ? null : evidence,
        proof: parsed.flags.proof,
        rationale: parsed.flags.rationale,
        status: transition.status,
        taskId: taskRow.id,
        taskName: taskRow.name,
      });
    }
    const statuses = parsed.flags.list && parsed.flags.statuses.length > 0
      ? parsed.flags.statuses.map(parseCriterionStatus)
      : undefined;
    const result = jsonResult(criteriaResponseSync(database, { affected, statuses, task: taskRow }));
    if (criteriaMutation) {
      database.exec("COMMIT");
      criteriaMutation = false;
    }
    return result;
  } catch (error) {
    if (criteriaMutation) {
      rollbackSync(database);
    }
    throw error;
  } finally {
    database.close();
  }
}

function runCriteriaPlanCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const inputCount = [
    parsed.flags.fromText !== null,
    parsed.flags.fromWorkerResponse !== null,
    parsed.flags.fromStdin,
  ].filter(Boolean).length;
  if (inputCount !== 1) {
    return unsupportedRuntimeResult(parsed, "criteria-plan requires exactly one of --from-text, --from-worker-response, or --from-stdin.");
  }
  if (parsed.flags.fromStdin) {
    return unsupportedRuntimeResult(parsed, "criteria-plan --from-stdin is handled by the Python runtime until CLI stdin plumbing is migrated.");
  }
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const taskRow = taskRowForLifecycle(database, taskName);
    if (taskRow === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const text = parsed.flags.fromText ?? readFileSync(resolve(expandUserPath(parsed.flags.fromWorkerResponse ?? "")), "utf8");
    const result = planCriteriaCommands(taskRow.name, text, {
      path: parsed.flags.path ? resolve(expandUserPath(parsed.flags.path)) : null,
    });
    if (parsed.flags.json) {
      return jsonResult(result);
    }
    return { exitCode: 0, handled: true, stdout: renderCriteriaPlanText(result) };
  } finally {
    database.close();
  }
}

function runRunsCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const actionCount = [
    parsed.flags.create !== null,
    parsed.flags.list,
    parsed.flags.showRun !== null,
    parsed.flags.finishRun !== null,
  ].filter(Boolean).length;
  if (actionCount !== 1) {
    return unsupportedRuntimeResult(parsed, "runs requires exactly one action: --create, --list, --show, or --finish.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    if (parsed.flags.create !== null) {
      const task = taskRowForLifecycle(database, parsed.flags.create);
      if (task === null) {
        throw new Error(`Unknown task: ${parsed.flags.create}`);
      }
      const metadata = jsonObjectArg(parsed.flags.metadataJson, "--metadata-json");
      const purpose = parsed.flags.purpose;
      if (purpose === "ralph_loop" || metadata.kind === "ralph_loop") {
        if (!("max_iterations" in metadata)) {
          throw new Error("ralph_loop run metadata requires max_iterations");
        }
        const maxIterations = integerMetadataField(metadata.max_iterations, "ralph_loop run metadata requires integer max_iterations and current_iteration");
        const currentIteration = integerMetadataField(metadata.current_iteration ?? 0, "ralph_loop run metadata requires integer max_iterations and current_iteration");
        validateRalphLoopIterationPolicy({ currentIteration, maxIterations });
        const required = metadata.required_before_continue;
        if (required !== undefined && !Array.isArray(required)) {
          throw new Error("ralph_loop run metadata required_before_continue must be a JSON array");
        }
        const run = createRalphLoopRunSync(database, {
          cleanupPolicy: typeof metadata.cleanup_policy === "string" ? metadata.cleanup_policy : null,
          currentIteration,
          maxIterations,
          metadata,
          preset: typeof metadata.preset === "string" ? metadata.preset : null,
          requiredBeforeContinue: requiredBeforeContinueMetadataList(metadata.required_before_continue),
          runName: parsed.flags.names[0] ?? null,
          seedPromptSha256: typeof metadata.seed_prompt_sha256 === "string" ? metadata.seed_prompt_sha256 : null,
          stopConditions: asStringArray(metadata.stop_conditions),
          taskId: task.id,
          taskName: task.name,
        });
        return jsonResult(run);
      }
      return jsonResult(createRunFromCliSync(database, {
        metadata,
        name: parsed.flags.names[0] ?? null,
        purpose,
        task,
      }));
    }
    if (parsed.flags.showRun !== null) {
      return jsonResult(runRowSync(database, parsed.flags.showRun));
    }
    if (parsed.flags.finishRun !== null) {
      return jsonResult(finishRunFromCliSync(database, {
        run: parsed.flags.finishRun,
        status: parsed.flags.statusState ?? "finished",
      }));
    }
    const taskId = parsed.flags.taskName ? taskIdForTask(database, parsed.flags.taskName) : null;
    if (parsed.flags.statusState !== null && !RUN_STATUSES.has(parsed.flags.statusState)) {
      throw new Error(`invalid run status: ${parsed.flags.statusState}; expected one of: ${[...RUN_STATUSES].join(", ")}`);
    }
    return jsonResult(listRunsFromCliSync(database, {
      status: parsed.flags.statusState,
      taskId,
    }));
  } finally {
    database.close();
  }
}

function runLoopEvidenceCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const action = parsed.flags.subtype;
  if (!action) {
    return unsupportedRuntimeResult(parsed, "loop-evidence requires an action: add, visual-diff, or adversarial-check.");
  }
  const task = requireTask(parsed);
  if (!parsed.flags.loopRun) {
    return errorResult("--loop-run is required.");
  }
  const source = parseCriterionSource(parsed.flags.source ?? "manager_inferred");
  const database = openRuntimeDatabase(parsed, options);
  try {
    if (action === "add") {
      if (!parsed.flags.evidenceType) {
        return errorResult("--evidence-type is required.");
      }
      const result = recordLoopEvidenceSync(database, {
        artifactPath: parsed.flags.output,
        correlationId: parsed.flags.correlationId,
        evidenceType: parsed.flags.evidenceType,
        iteration: parsed.flags.currentIteration,
        loopRunId: parsed.flags.loopRun,
        metadata: jsonObjectArg(parsed.flags.metadataJson, "--metadata-json"),
        proof: parsed.flags.proof,
        source,
        status: parsed.flags.statusState ?? "pass",
        task,
      });
      return jsonResult(result);
    }
    if (action === "adversarial-check" || action === "adversarial_check") {
      const result = recordAdversarialLoopEvidenceSync(database, {
        artifactPath: parsed.flags.output,
        check: parsed.flags.check ?? "",
        correlationId: parsed.flags.correlationId,
        failureMode: parsed.flags.failureMode ?? "",
        iteration: parsed.flags.currentIteration,
        loopRunId: parsed.flags.loopRun,
        result: parsed.flags.result ?? "",
        source,
        status: parsed.flags.statusState ?? "pass",
        task,
      });
      return jsonResult(result);
    }
    if (action === "visual-diff" || action === "visual_diff") {
      if (parsed.flags.statusState !== null) {
        return errorResult("loop-evidence visual-diff does not support --status.");
      }
      if (!parsed.flags.reference || !parsed.flags.candidate || parsed.flags.threshold === null) {
        return errorResult("loop-evidence visual-diff requires --reference, --candidate, and --threshold.");
      }
      return jsonResult(recordVisualDiffLoopEvidenceSync(database, {
        candidatePath: resolve(expandUserPath(parsed.flags.candidate)),
        correlationId: parsed.flags.correlationId,
        diffOutput: parsed.flags.diffOutput ? resolve(expandUserPath(parsed.flags.diffOutput)) : null,
        iteration: parsed.flags.currentIteration,
        loopRunId: parsed.flags.loopRun,
        referencePath: resolve(expandUserPath(parsed.flags.reference)),
        reportOutput: parsed.flags.reportOutput ? resolve(expandUserPath(parsed.flags.reportOutput)) : null,
        source,
        task,
        threshold: parsed.flags.threshold,
      }));
    }
    return unsupportedRuntimeResult(parsed, `Unsupported loop-evidence action: ${action}`);
  } finally {
    database.close();
  }
}

function runLoopTemplatesCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const unsupportedOptions = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set<RuntimeFlagKey>([
      "createRun",
      "currentIteration",
      "currentIterationProvided",
      "json",
      "list",
      "maxIterations",
      "names",
      "path",
      "seedPromptSha256",
      "show",
      "template",
    ]),
    commandName: "loop-templates",
  });
  if (unsupportedOptions) {
    return unsupportedRuntimeResult(parsed, unsupportedOptions);
  }
  const rejected = rejectLoopCreateOnlyOptions(parsed, { selector: parsed.flags.template, selectorFlag: "--template" });
  if (rejected) {
    return rejected;
  }
  const actionCount = [parsed.flags.list, parsed.flags.show !== null, parsed.flags.createRun !== null].filter(Boolean).length;
  if (actionCount !== 1) {
    return errorResult("Choose one of --list, --show, or --create-run");
  }
  if (parsed.flags.list) {
    return jsonResult({ templates: listLoopTemplates() });
  }
  if (parsed.flags.show !== null) {
    return jsonResult(loopTemplateSummary(parsed.flags.show));
  }
  if (!parsed.flags.template) {
    return errorResult("--create-run requires --template");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    return jsonResult(createLoopPolicyRunSync(database, {
      metadata: loopTemplateMetadata(parsed.flags.template, {
        currentIteration: parsed.flags.currentIterationProvided ? parsed.flags.currentIteration : 0,
        maxIterations: parsed.flags.maxIterations,
        seedPromptSha256: parsed.flags.seedPromptSha256,
      }),
      name: lastParsedName(parsed),
      taskRef: parsed.flags.createRun ?? "",
    }));
  } finally {
    database.close();
  }
}

function runRalphLoopPresetsCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const unsupportedOptions = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set<RuntimeFlagKey>([
      "createRun",
      "currentIteration",
      "currentIterationProvided",
      "json",
      "list",
      "maxIterations",
      "names",
      "path",
      "preset",
      "seedPromptSha256",
      "show",
    ]),
    commandName: "ralph-loop-presets",
  });
  if (unsupportedOptions) {
    return unsupportedRuntimeResult(parsed, unsupportedOptions);
  }
  const rejected = rejectLoopCreateOnlyOptions(parsed, { selector: parsed.flags.preset, selectorFlag: "--preset" });
  if (rejected) {
    return rejected;
  }
  const actionCount = [parsed.flags.list, parsed.flags.show !== null, parsed.flags.createRun !== null].filter(Boolean).length;
  if (actionCount !== 1) {
    return errorResult("Choose one of --list, --show, or --create-run");
  }
  if (parsed.flags.list) {
    return jsonResult({ presets: listLoopTemplates() });
  }
  if (parsed.flags.show !== null) {
    return jsonResult(ralphLoopPresetSummary(parsed.flags.show));
  }
  if (!parsed.flags.preset) {
    return errorResult("--create-run requires --preset");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    return jsonResult(createLoopPolicyRunSync(database, {
      metadata: ralphLoopPresetMetadata(parsed.flags.preset, {
        currentIteration: parsed.flags.currentIterationProvided ? parsed.flags.currentIteration : 0,
        maxIterations: parsed.flags.maxIterations,
        seedPromptSha256: parsed.flags.seedPromptSha256,
      }),
      name: lastParsedName(parsed),
      taskRef: parsed.flags.createRun ?? "",
    }));
  } finally {
    database.close();
  }
}

function runLoopTriggersCommand(
  parsed: ParsedRuntimeArgs,
  _options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const unsupportedOptions = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set<RuntimeFlagKey>(["classifyPrompt", "json", "list"]),
    commandName: "loop-triggers",
  });
  if (unsupportedOptions) {
    return unsupportedRuntimeResult(parsed, unsupportedOptions);
  }
  const actionCount = [parsed.flags.list, parsed.flags.classifyPrompt !== null].filter(Boolean).length;
  if (actionCount > 1) {
    return errorResult("Choose only one of --list or --classify");
  }
  if (parsed.flags.classifyPrompt !== null) {
    const result = classifyLoopTrigger(parsed.flags.classifyPrompt);
    if (parsed.flags.json) {
      return jsonResult(result);
    }
    if (result.matched && result.matched_trigger) {
      const trigger = result.matched_trigger;
      const actions = trigger.operator_actions.map((action) => `- ${action}`).join("\n");
      return {
        exitCode: 0,
        handled: true,
        stdout: `Matched ${trigger.name}: ${trigger.canonical_phrase}\nIntent: ${trigger.intent}\nOperator actions:\n${actions}\n`,
      };
    }
    return { exitCode: 0, handled: true, stdout: `${result.guidance}\n` };
  }
  const payload = { triggers: listLoopTriggers() };
  if (parsed.flags.json) {
    return jsonResult(payload);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: `Controlled loop triggers:\n${payload.triggers.map((trigger) => `- ${trigger.name}: ${trigger.canonical_phrase}`).join("\n")}\n`,
  };
}

function runLoopStatusCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedMigratedProofCliOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const unsupportedOptions = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set<RuntimeFlagKey>(["json", "path", "run"]),
    allowTask: true,
    commandName: "loop-status",
  });
  if (unsupportedOptions) {
    return unsupportedRuntimeResult(parsed, unsupportedOptions);
  }
  const taskRef = requireTask(parsed);
  if (!parsed.flags.run) {
    return errorResult("loop-status requires --run");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForLifecycle(database, taskRef);
    if (task === null) {
      throw new Error(`Unknown task: ${taskRef}`);
    }
    const run = ralphLoopRunForTaskSync(database, { runRef: parsed.flags.run, task });
    const result = loopStatusSummarySync(database, { run, task });
    if (parsed.flags.json) {
      return jsonResult(result);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderLoopStatusText(result),
    };
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

function runLegacyStartCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  if (!parsed.task) {
    return errorResult("start requires a session.");
  }
  const unsupported = unsupportedLegacyStartOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const codexPreflight = ensureRequiredTool("codex", options);
  if (codexPreflight) {
    return codexPreflight;
  }
  const sessionName = parsed.task;
  validateWorkerName(sessionName);
  let cwd: string;
  try {
    cwd = resolveExistingDirectory(parsed.flags.cwd ?? options.cwd ?? process.cwd(), "Session cwd");
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  const tmuxPreflight = ensureTmuxAvailable(runner);
  if (tmuxPreflight) {
    return tmuxPreflight;
  }
  if (tmuxSessionRunning(sessionName, runner)) {
    return lifecycleWorkerErrorResult(`tmux session already exists: ${sessionName}`);
  }
  const rawCodexArgs = [...(parsed.passthroughArgs ?? [])];
  if (rawCodexArgs[0] === "--") {
    rawCodexArgs.shift();
  }
  const promptPath = parsed.flags.startPrompt
    ? join(stateRoot(options), "artifacts", "start-prompts", `${sessionName}.md`)
    : null;
  let shellCommand = `${legacyCliPathPrefix()} codex --cd ${shellQuote(cwd)} --no-alt-screen`;
  if (rawCodexArgs.length > 0) {
    shellCommand = `${shellCommand} ${rawCodexArgs.map(shellQuote).join(" ")}`;
  }
  if (promptPath !== null) {
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, legacyRawWorkerStartPrompt(sessionName, cwd, rawCodexArgs));
    shellCommand = `${shellCommand} "$(cat ${shellQuote(promptPath)})"`;
  }
  runTmuxCommandWithRunner(["tmux", "new-session", "-d", "-s", sessionName, shellCommand], runner);
  return jsonResult({
    attach_command: attachSessionCommand(sessionName),
    bind_command_template: "conveyor bind --task <task-name> --worker <worker-name> --manager <manager-name>",
    cwd,
    manager_config_questions_command_template: "conveyor manager-config <task-name> --questions",
    register_worker_command_template: `${workerctlCli()} register-worker --name <worker-name> --pid <pid> --codex-session <rollout.jsonl> --cwd ${shellQuote(cwd)} --tmux-session ${sessionName}`,
    session: sessionName,
    start_manager_command_template: `${workerctlCli()} start-manager --name <manager-name> --cwd ${shellQuote(cwd)}${codexArgSuffix(rawCodexArgs)}`,
    start_prompt_path: promptPath,
    start_prompt_sent: promptPath !== null,
  });
}

function runLegacyCreateCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  if (!parsed.task) {
    return errorResult("create requires a worker name.");
  }
  const unsupported = unsupportedLegacyCreateOptions(parsed, false);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  return createLegacyWorker({
    acceptTrust: parsed.flags.acceptTrust,
    cwd: parsed.flags.cwd ?? options.cwd ?? process.cwd(),
    forceOpen: parsed.flags.forceOpen,
    initialPrompt: parsed.flags.initialPrompt,
    name: parsed.task,
    open: parsed.flags.open,
    parsed,
    reuse: parsed.flags.reuse,
    runtimeOptions: options,
    stopAfter: parsed.flags.stopAfter,
    task: parsed.flags.taskName,
    terminal: parsed.flags.terminal,
    verify: parsed.flags.verify,
    verifyTimeout: parsed.flags.verifyTimeout,
    waitReady: parsed.flags.waitReady,
    waitReadyTimeout: parsed.flags.waitReadyTimeout,
  });
}

function runLegacyStartTestCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  const unsupported = unsupportedLegacyCreateOptions(parsed, true);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task ?? "live-test";
  const task = parsed.flags.taskName
    ?? `Read README.md and run conveyor update-status ${name} with a short summary. Do not edit tracked files.`;
  return createLegacyWorker({
    acceptTrust: parsed.flags.acceptTrust,
    cwd: parsed.flags.cwd ?? options.cwd ?? process.cwd(),
    forceOpen: parsed.flags.forceOpen,
    initialPrompt: true,
    name,
    open: parsed.flags.open,
    parsed,
    reuse: parsed.flags.reuse,
    runtimeOptions: options,
    stopAfter: parsed.flags.stopAfter,
    task,
    terminal: parsed.flags.terminal,
    verify: true,
    verifyTimeout: parsed.flags.verifyTimeout,
    waitReady: true,
    waitReadyTimeout: parsed.flags.waitReadyTimeout,
  });
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

function runPairCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  const unsupported = unsupportedPairOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = parsed.flags.taskName;
  const workerName = parsed.flags.workerName;
  const managerName = parsed.flags.managerName;
  if (!taskName || !workerName || !managerName) {
    return unsupportedRuntimeResult(parsed, "pair requires --task, --worker-name, and --manager-name.");
  }
  const dbPath = runtimeDbPath(parsed, options);
  const dispatch = pairDispatchPayload(parsed, dbPath);
  const packageRoot = packageRootFromRuntimeModule();
  if (parsed.flags.dryRun) {
    return jsonResult({
      dispatch_command: dispatch.dispatchCommand,
      ensure_dispatch: dispatch.ensureDispatch,
      manager: managerName,
      task: taskName,
      worker: workerName,
    });
  }
  const cwd = parsed.flags.cwd ?? options.cwd ?? process.cwd();
  const database = openRuntimeDatabase(parsed, options);
  let taskId: string | null = null;
  let taskCreated = false;
  let bindingId: string | null = null;
  let runId: string | null = null;
  let workerInfo: PairSpawnResult | null = null;
  let managerInfo: PairSpawnResult | null = null;
  try {
    const timestamp = nowIsoSeconds(options);
    let task = taskRowForPair(database, taskName);
    if (task === null) {
      if (!parsed.flags.taskGoal) {
        throw new Error(`Task ${JSON.stringify(taskName)} does not exist. Pass --task-goal to create it, or run \`conveyor tasks --create ...\` first.`);
      }
      taskId = createTaskSync(database, {
        goal: parsed.flags.taskGoal,
        name: taskName,
        now: timestamp,
        summary: parsed.flags.taskSummary,
      });
      taskCreated = true;
      task = taskRowForPair(database, taskName);
    } else {
      taskId = task.id;
    }
    if (task === null || taskId === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    emitPairTelemetry(database, {
      attributes: {
        cwd,
        task_created: taskCreated,
        task_goal_provided: parsed.flags.taskGoal !== null,
      },
      eventType: "pair_started",
      managerName,
      summary: `Started pair setup for task ${taskName}.`,
      taskId,
      taskName,
      timestamp,
      workerName,
    });
    emitPairTelemetry(database, {
      attributes: { created: taskCreated },
      eventType: "pair_task_resolved",
      managerName,
      summary: `${taskCreated ? "Created" : "Resolved"} task ${taskName}.`,
      taskId,
      taskName,
      timestamp,
      workerName,
    });

    const managerSeed = ensurePairManagerConfig(database, {
      managerAllowMergeGreen: parsed.flags.managerAllowMergeGreen,
      managerAllowPr: parsed.flags.managerAllowPr,
      managerAllowWorkerCompactClear: parsed.flags.managerAllowWorkerCompactClear,
      managerAcceptance: parsed.flags.managerAcceptance,
      managerEpilogue: parsed.flags.managerEpilogue,
      managerGuideline: parsed.flags.managerGuideline,
      managerMode: parsed.flags.managerMode,
      managerNudgeOnCompletion: parsed.flags.managerNudgeOnCompletion,
      managerObjective: parsed.flags.managerObjective,
      managerPermissionsJson: parsed.flags.managerPermissionsJson,
      managerPermit: parsed.flags.managerPermit,
      managerReference: parsed.flags.managerReference,
      managerRequireAcks: parsed.flags.managerRequireAcks,
      managerTool: parsed.flags.managerTool,
      taskId,
      timestamp,
    });
    if (managerSeed.seededByPair) {
      insertEventSync(database, {
        payload: {
          acceptance_count: managerSeed.config.acceptance_criteria.length,
          guideline_count: managerSeed.config.guidelines.length,
          reference_count: managerSeed.config.reference_paths.length,
          nudge_on_completion: managerSeed.config.nudge_on_completion,
          source: "pair",
          supervision_mode: managerSeed.config.supervision_mode,
        },
        taskId,
        type: "manager_config_recorded",
      });
      emitPairTelemetry(database, {
        attributes: {
          acceptance_count: managerSeed.config.acceptance_criteria.length,
          guideline_count: managerSeed.config.guidelines.length,
          reference_count: managerSeed.config.reference_paths.length,
          nudge_on_completion: managerSeed.config.nudge_on_completion,
          supervision_mode: managerSeed.config.supervision_mode,
        },
        eventType: "pair_manager_config_seeded",
        managerName,
        summary: `Seeded manager config for task ${taskName}.`,
        taskId,
        taskName,
        timestamp,
        workerName,
      });
    }
    const managerAcceptanceCriteriaSeeded = seedPairManagerAcceptanceCriteria(database, {
      criteria: managerSeed.config.acceptance_criteria,
      taskId,
      timestamp,
    });

    const startup = resolveCodexStartupOptions({
      askForApproval: parsed.flags.askForApproval,
      profile: parsed.flags.codexProfile,
      sandbox: parsed.flags.sandbox,
    });
    workerInfo = spawnCodexAndRegisterPairSession(database, parsed, options, {
      acceptTrust: parsed.flags.acceptTrust,
      askForApproval: startup.askForApproval,
      cwd,
      initialPrompt: workerAckTaskPrompt(taskName, parsed.flags.taskPrompt),
      name: workerName,
      role: "worker",
      sandbox: startup.sandbox,
      timeoutSeconds: parsed.flags.timeoutSeconds,
    });
    emitPairTelemetry(database, {
      attributes: {
        codex_session_id: workerInfo.codex_session_id,
        codex_session_path: workerInfo.codex_session_path,
        pid: workerInfo.pid,
        tmux_session: workerInfo.tmux_session,
      },
      correlationExtra: { worker_session_id: workerInfo.session_id },
      eventType: "pair_worker_spawned",
      managerName,
      summary: `Spawned worker session ${workerName}.`,
      taskId,
      taskName,
      timestamp,
      workerName,
    });

    managerInfo = spawnCodexAndRegisterPairSession(database, parsed, options, {
      acceptTrust: parsed.flags.acceptTrust,
      askForApproval: startup.askForApproval,
      cwd,
      initialPrompt: startManagerBootstrapPrompt(database, {
        cwd,
        managerName,
        taskGoal: task.goal,
        taskName,
        workerName,
      }),
      name: managerName,
      role: "manager",
      sandbox: startup.sandbox,
      timeoutSeconds: parsed.flags.timeoutSeconds,
    });
    emitPairTelemetry(database, {
      attributes: {
        codex_session_id: managerInfo.codex_session_id,
        codex_session_path: managerInfo.codex_session_path,
        pid: managerInfo.pid,
        tmux_session: managerInfo.tmux_session,
      },
      correlationExtra: { manager_session_id: managerInfo.session_id },
      eventType: "pair_manager_spawned",
      managerName,
      summary: `Spawned manager session ${managerName}.`,
      taskId,
      taskName,
      timestamp,
      workerName,
    });

    bindingId = bindSessionsSync(database, {
      managerSessionName: managerName,
      now: timestamp,
      taskName,
      workerSessionName: workerName,
    });
    insertEventSync(database, {
      payload: {
        binding_id: bindingId,
        manager: managerName,
        task: taskName,
        worker: workerName,
      },
      taskId,
      type: "binding_created",
    });
    emitPairTelemetry(database, {
      attributes: {
        manager_session_id: managerInfo.session_id,
        worker_session_id: workerInfo.session_id,
      },
      bindingId,
      eventType: "pair_binding_created",
      managerName,
      summary: `Bound worker ${workerName} and manager ${managerName}.`,
      taskId,
      taskName,
      timestamp,
      workerName,
    });

    runId = createPairRunSync(database, {
      bindingId,
      managerConfigSeeded: managerSeed.config !== null,
      managerConfigSeededByPair: managerSeed.seededByPair,
      managerName,
      purpose: task.goal,
      taskId,
      timestamp,
      workerName,
    });
    insertEventSync(database, {
      payload: { run_id: runId, source: "pair" },
      taskId,
      type: "run_created",
    });
    emitPairTelemetry(database, {
      attributes: {
        manager_acceptance_criteria_seeded: managerAcceptanceCriteriaSeeded,
        manager_config_seeded: managerSeed.config !== null,
        manager_config_seeded_by_pair: managerSeed.seededByPair,
      },
      bindingId,
      eventType: "pair_run_created",
      managerName,
      runId,
      summary: `Created active telemetry run for pair task ${taskName}.`,
      taskId,
      taskName,
      timestamp,
      workerName,
    });

    const dispatchResult = {
      command: dispatch.dispatchCommand,
      ensure: dispatch.ensureDispatch,
      pid: null as number | null,
      started: false,
    };
    if (dispatch.ensureDispatch && dispatch.dispatchCommand) {
      if (!recentActiveDispatchHeartbeat(database, {
        dispatcherId: parsed.flags.dispatcherId,
        now: options.now?.() ?? new Date(),
      })) {
        const dispatchProcess = (options.dispatchRunner ?? defaultDispatchRunner)(dispatch.dispatchCommand, { cwd: packageRoot });
        dispatchResult.pid = dispatchProcess.pid;
        dispatchResult.started = true;
      }
    }

    return jsonResult({
      binding_id: bindingId,
      dispatch: dispatchResult,
      dispatch_command: dispatch.dispatchCommand,
      ensure_dispatch: dispatch.ensureDispatch,
      manager: managerInfo,
      manager_acceptance_criteria_seeded: managerAcceptanceCriteriaSeeded,
      manager_config_seeded: managerSeed.config !== null,
      manager_config_seeded_by_pair: managerSeed.seededByPair,
      run_id: runId,
      task: { created: taskCreated, id: taskId, name: taskName },
      worker: workerInfo,
    });
  } catch (error) {
    if (taskId !== null) {
      try {
        emitPairTelemetry(database, {
          attributes: {
            binding_created: bindingId !== null,
            error: error instanceof Error ? error.message : String(error),
            error_type: error instanceof Error ? error.name : "Error",
            manager_spawned: managerInfo !== null,
            run_created: runId !== null,
            worker_spawned: workerInfo !== null,
          },
          eventType: "pair_failed",
          managerName,
          severity: "error",
          summary: `Pair setup failed for task ${taskName}.`,
          taskId,
          taskName,
          timestamp: nowIsoSeconds(options),
          workerName,
        });
      } catch {
        // Preserve the original failure.
      }
    }
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  } finally {
    database.close();
  }
}

interface PairSpawnResult {
  codex_session_id: string;
  codex_session_path: string;
  cwd: string;
  name: string;
  pid: number;
  role: "manager" | "worker";
  session_id: string;
  tmux_session: string | null;
}

interface PairTaskRow {
  goal: string;
  id: string;
  name: string;
  state: string;
  summary: string | null;
}

function taskRowForPair(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskName: string,
): PairTaskRow | null {
  const row = database.prepare(`
    select id, name, goal, summary, state
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(taskName, taskName) as PairTaskRow | undefined;
  return row ?? null;
}

function pairDispatchPayload(
  parsed: ParsedRuntimeArgs,
  dbPath: string,
): { dispatchCommand: string[] | null; ensureDispatch: boolean } {
  const dispatcherId = parsed.flags.dispatcherId;
  const ensureDispatch = dispatcherId !== null && !parsed.flags.noDispatch;
  const packageRoot = packageRootFromRuntimeModule();
  return {
    dispatchCommand: ensureDispatch
      ? [
        join(packageRoot, "scripts", "workerctl"),
        "dispatch",
        "--watch",
        "--dispatcher-id",
        dispatcherId,
        "--path",
        resolve(dbPath),
      ]
      : null,
    ensureDispatch,
  };
}

function emitPairTelemetry(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    attributes: Record<string, unknown>;
    bindingId?: string | null;
    correlationExtra?: Record<string, unknown>;
    eventType: string;
    managerName: string;
    runId?: string | null;
    severity?: "debug" | "info" | "warning" | "error";
    summary: string;
    taskId: string;
    taskName: string;
    timestamp: string;
    workerName: string;
  },
): void {
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: options.attributes,
    correlation: {
      binding_id: options.bindingId ?? null,
      manager: options.managerName,
      source: "pair",
      task: options.taskName,
      worker: options.workerName,
      ...(options.correlationExtra ?? {}),
    },
    eventType: options.eventType,
    runId: options.runId ?? null,
    severity: options.severity ?? "info",
    summary: options.summary,
    taskId: options.taskId,
    timestamp: options.timestamp,
  });
}

function ensurePairManagerConfig(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    managerAllowMergeGreen: boolean;
    managerAllowPr: boolean;
    managerAllowWorkerCompactClear: boolean;
    managerAcceptance: string[];
    managerEpilogue: string[];
    managerGuideline: string[];
    managerMode: string | null;
    managerNudgeOnCompletion: string | null;
    managerObjective: string | null;
    managerPermissionsJson: string | null;
    managerPermit: string[];
    managerReference: string[];
    managerRequireAcks: boolean;
    managerTool: string[];
    taskId: string;
    timestamp: string;
  },
): { config: ManagerConfigRecord; seededByPair: boolean } {
  const existing = managerConfigSync(database, options.taskId);
  const requested = options.managerMode !== null
    || options.managerObjective !== null
    || options.managerGuideline.length > 0
    || options.managerAcceptance.length > 0
    || options.managerReference.length > 0
    || options.managerPermit.length > 0
    || options.managerTool.length > 0
    || options.managerEpilogue.length > 0
    || options.managerNudgeOnCompletion !== null
    || options.managerRequireAcks
    || options.managerPermissionsJson !== null
    || options.managerAllowPr
    || options.managerAllowMergeGreen
    || options.managerAllowWorkerCompactClear;
  if (!requested && existing !== null) {
    return { config: existing, seededByPair: false };
  }

  const supervisionMode = options.managerMode ?? existing?.supervision_mode ?? "guided";
  if (supervisionMode !== "light" && supervisionMode !== "guided" && supervisionMode !== "strict") {
    throw new Error("manager_mode must be light, guided, or strict");
  }
  const objective = options.managerObjective !== null ? options.managerObjective : existing?.objective ?? null;
  const guidelines = options.managerGuideline.length > 0 ? options.managerGuideline : existing?.guidelines ?? [];
  const acceptanceCriteria = options.managerAcceptance.length > 0
    ? options.managerAcceptance
    : existing?.acceptance_criteria ?? [];
  const referencePaths = options.managerReference.length > 0 ? options.managerReference : existing?.reference_paths ?? [];
  let permissions = cloneManagerPermissions(existing?.permissions ?? normalizeManagerPermissions(null));
  permissions = addManagerPermissionFlags(permissions, [
    ...(options.managerAllowPr ? ["create_pr"] : []),
    ...(options.managerAllowMergeGreen ? ["merge_green_pr"] : []),
    ...(options.managerAllowWorkerCompactClear ? ["worker_compact_clear"] : []),
    ...options.managerPermit,
  ]);
  permissions = applyManagerPermissionOverrides(permissions, parsePairPermissionsJson(options.managerPermissionsJson));
  const tools = cleanPairManagerTools(options.managerTool.length > 0 ? options.managerTool : existing?.tools ?? []);
  const epilogues = cleanPairEpilogueSteps(options.managerEpilogue.length > 0 ? options.managerEpilogue : existing?.epilogues ?? []);
  const nudgeOnCompletion = cleanPairNudgeOnCompletion(options.managerNudgeOnCompletion ?? existing?.nudge_on_completion ?? "ask-operator");
  const requireAcks = options.managerRequireAcks || (existing?.require_acks ?? false);

  database.prepare(`
    insert into manager_configs(
      task_id, supervision_mode, objective, guidelines_json,
      acceptance_criteria_json, reference_paths_json, permissions_json,
      tools_json, epilogues_json, nudge_on_completion, require_acks,
      revision, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    on conflict(task_id) do update set
      supervision_mode = excluded.supervision_mode,
      objective = excluded.objective,
      guidelines_json = excluded.guidelines_json,
      acceptance_criteria_json = excluded.acceptance_criteria_json,
      reference_paths_json = excluded.reference_paths_json,
      permissions_json = excluded.permissions_json,
      tools_json = excluded.tools_json,
      epilogues_json = excluded.epilogues_json,
      nudge_on_completion = excluded.nudge_on_completion,
      require_acks = excluded.require_acks,
      revision = case when
        manager_configs.supervision_mode is not excluded.supervision_mode or
        manager_configs.objective is not excluded.objective or
        manager_configs.guidelines_json is not excluded.guidelines_json or
        manager_configs.acceptance_criteria_json is not excluded.acceptance_criteria_json or
        manager_configs.reference_paths_json is not excluded.reference_paths_json or
        manager_configs.permissions_json is not excluded.permissions_json or
        manager_configs.tools_json is not excluded.tools_json or
        manager_configs.epilogues_json is not excluded.epilogues_json or
        manager_configs.nudge_on_completion is not excluded.nudge_on_completion or
        manager_configs.require_acks is not excluded.require_acks
      then manager_configs.revision + 1 else manager_configs.revision end,
      updated_at = excluded.updated_at
  `).run(
    options.taskId,
    supervisionMode,
    objective,
    stableJson(guidelines),
    stableJson(acceptanceCriteria),
    stableJson(referencePaths),
    stableJson(permissions),
    stableJson(tools),
    stableJson(epilogues),
    nudgeOnCompletion,
    requireAcks ? 1 : 0,
    options.timestamp,
    options.timestamp,
  );

  const config = managerConfigSync(database, options.taskId);
  if (config === null) {
    throw new Error(`manager config was not recorded for task ${options.taskId}`);
  }
  return { config, seededByPair: true };
}

const PAIR_EPILOGUE_STEPS = new Set(["run-tools", "draft-pr", "subagent-review", "record-handoff"]);
const PAIR_NUDGE_ON_COMPLETION_MODES = new Set(["off", "ask-operator", "auto-review", "auto-proceed"]);
const MANAGER_PERMISSION_CATEGORIES: ManagerPermissionCategory[] = [
  "communication",
  "context",
  "repo",
  "verification",
  "worker_session",
];

function cloneManagerPermissions(permissions: ManagerPermissions): ManagerPermissions {
  return {
    communication: [...permissions.communication],
    context: [...permissions.context],
    repo: [...permissions.repo],
    verification: [...permissions.verification],
    worker_session: [...permissions.worker_session],
  };
}

function addManagerPermissionFlags(permissions: ManagerPermissions, flags: string[]): ManagerPermissions {
  let updated = cloneManagerPermissions(permissions);
  for (const flag of flags) {
    updated = mergeManagerPermissions(updated, normalizeManagerPermissions({ [flag]: true }));
  }
  return updated;
}

function applyManagerPermissionOverrides(
  permissions: ManagerPermissions,
  overrides: Record<string, unknown> | null,
): ManagerPermissions {
  const updated = cloneManagerPermissions(permissions);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (isManagerPermissionCategoryName(key) && Array.isArray(value)) {
      updated[key] = normalizeManagerPermissions({ [key]: value })[key];
      continue;
    }
    const normalized = normalizeManagerPermissions({ [key]: true });
    if (value) {
      mergeManagerPermissionsInto(updated, normalized);
    } else {
      revokeManagerPermissions(updated, normalized);
    }
  }
  return updated;
}

function mergeManagerPermissions(base: ManagerPermissions, extra: ManagerPermissions): ManagerPermissions {
  const updated = cloneManagerPermissions(base);
  mergeManagerPermissionsInto(updated, extra);
  return updated;
}

function mergeManagerPermissionsInto(base: ManagerPermissions, extra: ManagerPermissions): void {
  for (const category of MANAGER_PERMISSION_CATEGORIES) {
    for (const action of extra[category]) {
      if (!base[category].includes(action)) {
        base[category].push(action);
        base[category].sort();
      }
    }
  }
}

function revokeManagerPermissions(base: ManagerPermissions, extra: ManagerPermissions): void {
  for (const category of MANAGER_PERMISSION_CATEGORIES) {
    base[category] = base[category].filter((action) => !extra[category].includes(action));
  }
}

function parsePairPermissionsJson(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("--manager-permissions-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function cleanPairManagerTools(values: string[]): string[] {
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const value of values) {
    const tool = value.trim();
    if (tool && !seen.has(tool)) {
      seen.add(tool);
      tools.push(tool);
    }
  }
  return tools;
}

function cleanPairEpilogueSteps(values: string[]): string[] {
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const value of values) {
    const step = value.trim();
    if (!step) {
      continue;
    }
    if (!PAIR_EPILOGUE_STEPS.has(step)) {
      throw new Error(`unknown epilogue step: ${step}`);
    }
    if (!seen.has(step)) {
      seen.add(step);
      steps.push(step);
    }
  }
  return steps;
}

function cleanPairNudgeOnCompletion(value: string): string {
  if (!PAIR_NUDGE_ON_COMPLETION_MODES.has(value)) {
    throw new Error("--manager-nudge-on-completion must be one of: off, ask-operator, auto-review, auto-proceed");
  }
  return value;
}

function isManagerPermissionCategoryName(value: string): value is ManagerPermissionCategory {
  return MANAGER_PERMISSION_CATEGORIES.includes(value as ManagerPermissionCategory);
}

function seedPairManagerAcceptanceCriteria(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { criteria: string[]; taskId: string; timestamp: string },
): number {
  const inserted: number[] = [];
  const seen = new Set<string>();
  for (const raw of options.criteria) {
    const criterion = raw.trim();
    if (!criterion || seen.has(criterion)) {
      continue;
    }
    seen.add(criterion);
    const existing = database.prepare(`
      select id
      from acceptance_criteria
      where task_id = ? and criterion = ?
      limit 1
    `).get(options.taskId, criterion) as { id: number } | undefined;
    if (existing) {
      continue;
    }
    const result = database.prepare(`
      insert into acceptance_criteria(
        task_id, criterion, status, source, proof, rationale,
        evidence_json, created_at, updated_at
      )
      values (?, ?, 'accepted', 'manager_inferred', null, ?, ?, ?, ?)
    `).run(
      options.taskId,
      criterion,
      "Seeded from manager acceptance configuration.",
      stableJson({ source: "manager_config" }),
      options.timestamp,
      options.timestamp,
    );
    const criterionId = Number(result.lastInsertRowid);
    inserted.push(criterionId);
    emitTelemetrySync(database, {
      actor: "workerctl",
      attributes: {
        criterion,
        has_evidence: true,
        has_proof: false,
        status: "accepted",
      },
      correlation: { criterion_id: criterionId, source: "manager_inferred" },
      eventType: "acceptance_criterion_added",
      severity: "info",
      summary: "Added acceptance criterion.",
      taskId: options.taskId,
      timestamp: options.timestamp,
    });
  }
  if (inserted.length > 0) {
    insertEventSync(database, {
      payload: {
        criterion_ids: inserted,
        source: "manager_config",
      },
      taskId: options.taskId,
      type: "manager_acceptance_criteria_seeded",
    });
  }
  return inserted.length;
}

function spawnCodexAndRegisterPairSession(
  database: ReturnType<typeof openRuntimeDatabase>,
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
  params: {
    acceptTrust: boolean;
    askForApproval: string | null;
    cwd: string;
    initialPrompt: string | null;
    name: string;
    role: "manager" | "worker";
    sandbox: string | null;
    timeoutSeconds: number;
  },
): PairSpawnResult {
  const existing = database.prepare("select id from sessions where name = ?").get(params.name) as { id: string } | undefined;
  if (existing) {
    throw new Error(
      `a session named ${JSON.stringify(params.name)} is already registered; `
      + `choose a different name or \`conveyor deregister ${params.name}\` first`,
    );
  }
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  const tmuxSessionName = tmuxSession(params.name);
  if (sessionExists(params.name, runner)) {
    throw new Error(
      `tmux session ${JSON.stringify(tmuxSessionName)} already exists; `
      + `choose a different name or \`tmux kill-session -t ${tmuxSessionName}\` first`,
    );
  }

  const codexExecutable = options.codexCommandResolver?.("codex") ?? "codex";
  const codexArgs = [codexExecutable];
  if (params.sandbox) {
    codexArgs.push("--sandbox", params.sandbox);
  }
  if (params.askForApproval) {
    codexArgs.push("--ask-for-approval", params.askForApproval);
  }
  if (params.initialPrompt) {
    codexArgs.push(params.initialPrompt);
  }
  const minimumSessionTimestamp = options.now?.() ?? new Date();
  startTmuxSessionWithRunner({
    cwd: params.cwd,
    shellCommand: codexTmuxShellCommand(codexArgs),
    tmuxSessionName,
  }, runner);
  if (params.acceptTrust) {
    sendEnterToTmuxSessionWithRunner(tmuxSessionName, runner);
  }

  let discovery: SpawnedCodexSessionDiscovery;
  try {
    discovery = (options.discoverSpawnedCodexSession ?? defaultDiscoverSpawnedCodexSession)({
      acceptTrust: params.acceptTrust,
      childrenForPid: options.childrenForPid,
      lsofForPid: options.lsofForPid,
      minimumSessionTimestamp,
      sleepMilliseconds: options.sleepMilliseconds,
      timeoutSeconds: params.timeoutSeconds,
      tmuxRunner: runner,
      tmuxSessionName,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}\nRecovery: tmux session ${JSON.stringify(tmuxSessionName)} may still be alive. `
      + `Inspect it with \`tmux attach -t ${tmuxSessionName}\`. If Codex is visible, submit a prompt or press Enter, `
      + `then register it with \`conveyor register-${params.role} --name ${params.name} --pid <pid> --codex-session <rollout.jsonl> `
      + `--cwd ${shellQuote(params.cwd)} --tmux-session ${tmuxSessionName}\`. To clean up, run `
      + `\`tmux kill-session -t ${tmuxSessionName}\` and \`conveyor deregister ${params.name}\` if it was registered.`,
      { cause: error },
    );
  }

  const registered = registerSessionSync(database, {
    codexSessionPath: discovery.codex_session_path,
    cwd: params.cwd,
    name: params.name,
    pid: discovery.native_pid,
    role: params.role,
    tmuxSession: tmuxSessionName,
  });
  insertEventSync(database, {
    payload: {
      codex_session_id: registered.codex_session_id,
      name: params.name,
      pid: registered.pid,
      role: params.role,
      session_id: registered.session_id,
      via: "pair",
    },
    type: "session_registered",
  });
  return {
    codex_session_id: registered.codex_session_id,
    codex_session_path: registered.codex_session_path,
    cwd: registered.cwd,
    name: registered.name,
    pid: registered.pid,
    role: registered.role,
    session_id: registered.session_id,
    tmux_session: registered.tmux_session,
  };
}

function workerAckTaskPrompt(taskName: string | null, taskPrompt: string | null): string | null {
  if (taskPrompt === null) {
    return null;
  }
  const taskRef = taskName ?? "<task>";
  return [
    taskPrompt,
    "",
    "Before editing files or running implementation work, acknowledge the task contract:",
    "",
    `conveyor worker-ack ${taskRef} --from-stdin`,
    "",
    "Use a JSON object with goal_restatement, proposed_criteria, expected_tools,",
    "open_questions, and ready_to_start.",
  ].join("\n");
}

function createPairRunSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    bindingId: string;
    managerConfigSeeded: boolean;
    managerConfigSeededByPair: boolean;
    managerName: string;
    purpose: string;
    taskId: string;
    timestamp: string;
    workerName: string;
  },
): string {
  const active = database.prepare(`
    select id
    from runs
    where task_id = ? and status = 'active'
    order by started_at desc, id desc
    limit 1
  `).get(options.taskId) as { id: string } | undefined;
  if (active) {
    throw new Error(`task ${JSON.stringify(options.taskId)} already has active run ${JSON.stringify(active.id)}`);
  }
  const runId = `run-${randomUUID()}`;
  database.prepare(`
    insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
    values (?, ?, ?, ?, 'active', ?, null, ?)
  `).run(
    runId,
    options.taskId,
    `${options.taskId}-pair`,
    options.purpose,
    options.timestamp,
    stableJson({
      binding_id: options.bindingId,
      manager: options.managerName,
      manager_config_seeded: options.managerConfigSeeded,
      manager_config_seeded_by_pair: options.managerConfigSeededByPair,
      source: "pair",
      worker: options.workerName,
    }),
  );
  return runId;
}

function recentActiveDispatchHeartbeat(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { dispatcherId: string | null; now: Date; staleSeconds?: number },
): boolean {
  const rows = database.prepare(`
    select timestamp, correlation_json, attributes_json
    from telemetry_events
    where actor = 'dispatch' and event_type = 'dispatch_watch_heartbeat'
    order by timestamp desc, id desc
    limit 25
  `).all() as Array<{ attributes_json: string; correlation_json: string; timestamp: string }>;
  const staleSeconds = options.staleSeconds ?? 10;
  for (const row of rows) {
    const timestamp = new Date(row.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      continue;
    }
    const ageSeconds = (options.now.getTime() - timestamp.getTime()) / 1000;
    if (ageSeconds > staleSeconds) {
      break;
    }
    const attributes = JSON.parse(row.attributes_json) as Record<string, unknown>;
    if (attributes.dry_run === true) {
      continue;
    }
    const correlation = JSON.parse(row.correlation_json) as Record<string, unknown>;
    if (options.dispatcherId !== null && correlation.dispatcher_id !== options.dispatcherId) {
      continue;
    }
    return true;
  }
  return false;
}

function defaultDispatchRunner(command: string[], options: { cwd: string }): { pid: number | null } {
  const child = spawn(command[0] ?? "", command.slice(1), {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? null };
}

function packageRootFromRuntimeModule(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

function runCommandsCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedCommandsOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const records = commandRowsForCli(database, {
      attempts: parsed.flags.attempts,
      commandType: parsed.flags.dispatchType,
      managerId: parsed.flags.manager,
      state: parsed.flags.statusState,
      task: parsed.flags.taskName,
      workerId: parsed.flags.worker,
    });
    if (parsed.flags.json) {
      return jsonResult(records);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderCommandsText(records),
    };
  } finally {
    database.close();
  }
}

function runEnqueueCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  commandType: "continue_iteration" | "notify_manager" | "nudge_worker",
): TypescriptRuntimeResult {
  const unsupported = unsupportedEnqueueOptions(parsed, commandType);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const message = parsed.flags.message ?? "";
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForLifecycle(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const payload: Record<string, unknown> = { message };
    let loopPolicy: Record<string, unknown> | null = null;
    if (commandType === "continue_iteration") {
      if (parsed.flags.requestedIteration === null || parsed.flags.loopRun === null) {
        throw new Error("enqueue-continue-iteration requires --loop-run and --requested-iteration.");
      }
      if (parsed.flags.requestedIteration < 1) {
        throw new Error("requested_iteration must be at least 1");
      }
      const run = ralphLoopRunForEnqueue(database, parsed.flags.loopRun);
      if (run.task_id !== task.id) {
        throw new Error("Ralph loop run does not belong to the requested task");
      }
      if (parsed.flags.requestedIteration <= run.current_iteration) {
        throw new Error("requested_iteration must be greater than current_iteration for the loop run");
      }
      loopPolicy = enqueueLoopPolicyPayload(run);
      payload.ralph_loop = {
        requested_iteration: parsed.flags.requestedIteration,
        run_id: run.id,
      };
      payload.loop_policy = loopPolicy;
      if (parsed.flags.decisionId !== null) {
        payload.manager_decision = { decision_id: parsed.flags.decisionId };
      }
    }
    const commandId = createCommandSync(database, {
      commandType,
      correlationId: parsed.flags.correlationId,
      idempotencyKey: parsed.flags.idempotencyKey,
      payload,
      requiredPermission: parsed.flags.requiredPermission,
      taskId: task.id,
    });
    const command = database.prepare("select correlation_id from commands where id = ?").get(commandId) as {
      correlation_id: string | null;
    };
    const result: Record<string, unknown> = {
      command_id: commandId,
      command_type: commandType,
      correlation_id: command.correlation_id,
      required_permission: parsed.flags.requiredPermission,
      task: taskName,
    };
    if (commandType === "continue_iteration") {
      result.loop_policy = loopPolicy;
      result.loop_run_id = parsed.flags.loopRun;
      result.manager_decision_id = parsed.flags.decisionId;
      result.requested_iteration = parsed.flags.requestedIteration;
    }
    if (parsed.flags.json) {
      return jsonResult(result);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: `queued ${commandType} command ${commandId}\n`,
    };
  } finally {
    database.close();
  }
}

function runDispatchCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedDispatchOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const dispatcherId = parsed.flags.dispatcherId ?? "dispatch-local";
  const dryRun = parsed.flags.dryRun;
  const watch = parsed.flags.watch;
  const intervalSeconds = Math.max(0, parsed.flags.intervalSeconds);
  const watchIterations = parsed.flags.watchIterations;
  const limit = Math.max(1, parsed.flags.limit ?? 10);
  const leaseSeconds = Math.max(1, parsed.flags.leaseSeconds);
  const processed: unknown[] = [];
  let iterations = 0;
  while (true) {
    iterations += 1;
    const batch = dispatchOncePass(parsed, options, {
      dispatcherId,
      dryRun,
      leaseSeconds,
      limit,
    });
    processed.push(...batch);
    if (watch) {
      const database = openRuntimeDatabase(parsed, options);
      try {
        emitTelemetrySync(database, {
          actor: "dispatch",
          attributes: { dry_run: dryRun, processed_count: batch.length },
          correlation: { dispatcher_id: dispatcherId, iteration: iterations },
          eventType: "dispatch_watch_heartbeat",
          severity: "info",
          summary: `Dispatch watch heartbeat ${iterations}.`,
          timestamp: nowIsoSeconds(options),
        });
      } finally {
        database.close();
      }
    }
    if (!watch || (watchIterations !== null && iterations >= watchIterations)) {
      break;
    }
    (options.sleepMilliseconds ?? sleepSync)(intervalSeconds * 1000);
  }
  const output = {
    dispatcher_id: dispatcherId,
    dry_run: dryRun,
    iterations,
    processed,
    processed_count: processed.length,
    watch,
  };
  if (parsed.flags.json) {
    return jsonResult(output);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: `dispatch processed ${processed.length} item(s)\n`,
  };
}

function dispatchOncePass(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void; tmuxRunner?: TmuxRunner },
  dispatchOptions: {
    dispatcherId: string;
    dryRun: boolean;
    leaseSeconds: number;
    limit: number;
  },
): unknown[] {
  const commandTypes = dispatchCommandTypes(parsed.flags.dispatchType);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const processed: unknown[] = [];
    let remaining = dispatchOptions.limit;
    if (commandTypes.length > 0) {
      if (dispatchOptions.dryRun) {
        const planned = claimableDispatchCommandsSync(database, {
          commandTypes,
          limit: remaining,
        }).map((command) => ({
          command_id: command.id,
          command_type: command.type,
          correlation_id: command.correlation_id,
          dry_run: true,
          state: "planned",
          task: command.task_id,
        }));
        processed.push(...planned);
        remaining = Math.max(0, dispatchOptions.limit - processed.length);
      } else {
        const recovered = recoverStaleDispatchClaimsSync(database, {
          commandTypes,
          dispatcherId: dispatchOptions.dispatcherId,
          limit: remaining,
        });
        processed.push(...recovered);
        remaining = Math.max(0, dispatchOptions.limit - processed.length);
      }
    }
    while (!dispatchOptions.dryRun && commandTypes.length > 0 && remaining > 0) {
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes,
        dispatcherId: dispatchOptions.dispatcherId,
        leaseSeconds: dispatchOptions.leaseSeconds,
      });
      if (claimed === null) {
        break;
      }
      processed.push(executeDispatchClaim(database, claimed, dispatchOptions.dispatcherId, options));
      remaining = Math.max(0, dispatchOptions.limit - processed.length);
    }
    if (remaining > 0 && dispatchWorkerCompletionEnabled(parsed.flags.dispatchType)) {
      processed.push(...dispatchWorkerCompletionPass(database, {
        dispatcherId: dispatchOptions.dispatcherId,
        dryRun: dispatchOptions.dryRun,
        leaseSeconds: dispatchOptions.leaseSeconds,
        limit: remaining,
        now: nowIsoSeconds(options),
        sleep: options.sleepMilliseconds,
        tmuxRunner: options.tmuxRunner ?? defaultTmuxRunner,
      }));
    }
    return processed;
  } finally {
    database.close();
  }
}

function executeDispatchClaim(
  database: ReturnType<typeof openRuntimeDatabase>,
  claimed: ClaimedCommand,
  dispatcherId: string,
  options: { now?: () => Date; tmuxRunner?: TmuxRunner },
): unknown {
  try {
    return executeDispatchCommandSync(database, {
      claimed,
      dispatcherId,
      now: nowIsoSeconds(options),
      tmuxRunner: options.tmuxRunner ?? defaultTmuxRunner,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = {
      attempt_id: claimed.attempt.id,
      command_id: claimed.command.id,
      command_type: claimed.command.type,
      correlation_id: claimed.command.correlation_id,
      dispatcher_id: dispatcherId,
      error: message,
      error_type: error instanceof Error ? error.name : typeof error,
      notification_id: null,
      required_permission: claimed.command.required_permission,
      side_effect_completed: false,
      side_effect_started: false,
      state: "failed",
    };
    finishCommandAttemptSync(database, {
      attemptId: claimed.attempt.id,
      error: message,
      now: nowIsoSeconds(options),
      result,
      sideEffectCompleted: false,
      sideEffectStarted: false,
      state: "failed",
    });
    return result;
  }
}

function dispatchCommandTypes(dispatchType: string | null): string[] {
  if (dispatchType === "worker_task_complete") {
    return [];
  }
  if (dispatchType === "notify_manager" || dispatchType === "nudge_worker" || dispatchType === "continue_iteration") {
    return [dispatchType];
  }
  return ["notify_manager", "nudge_worker", "continue_iteration"];
}

function dispatchWorkerCompletionEnabled(dispatchType: string | null): boolean {
  return dispatchType === null || dispatchType === "worker_task_complete";
}

interface WorkerCompletionEventRow {
  binding_id: string;
  manager_session_name: string;
  source_event_id: number;
  source_event_timestamp: string;
  source_payload_json: string;
  source_session_id: string;
  target_session_id: string;
  task_id: string;
  task_name: string;
  worker_session_name: string;
}

interface ClaimedCompletionNotificationRow {
  binding_id: string;
  correlation_id: string;
  dedupe_key: string;
  manager_session_name: string;
  notification_id: number;
  notification_payload_json: string;
  source_event_id: number | null;
  source_event_timestamp: string | null;
  source_session_id: string;
  target_session_id: string;
  task_id: string;
  task_name: string;
  worker_session_name: string;
}

function dispatchWorkerCompletionPass(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    dispatcherId: string;
    dryRun: boolean;
    leaseSeconds: number;
    limit: number;
    now: string;
    sleep?: (milliseconds: number) => void;
    tmuxRunner: TmuxRunner;
  },
): unknown[] {
  const processed: unknown[] = [];
  let remaining = options.limit;
  if (!options.dryRun) {
    const stale = failStaleStartedRoutedNotificationsSync(database, { limit: remaining, now: options.now });
    for (const notification of stale) {
      emitTelemetrySync(database, {
        actor: "dispatch",
        attributes: {
          claim_expires_at: notification.claim_expires_at,
          claimed_by: notification.claimed_by,
          error: notification.error,
          side_effect_risk: true,
        },
        correlation: {
          binding_id: notification.binding_id,
          correlation_id: notification.correlation_id,
          dispatcher_id: options.dispatcherId,
          routed_notification_id: notification.notification_id,
          source_event_id: notification.source_event_id,
          signal_type: notification.signal_type,
        },
        eventType: "dispatch_signal_failed",
        severity: "error",
        summary: "Dispatch found stale pending completion notification with side-effect risk.",
        taskId: typeof notification.task_id === "string" ? notification.task_id : null,
        timestamp: options.now,
      });
    }
    processed.push(...stale);
    remaining = Math.max(0, options.limit - processed.length);
    if (remaining > 0) {
      for (const row of claimPendingRoutedCompletionNotificationsSync(database, options)) {
        processed.push(deliverClaimedWorkerCompletion(database, row, options));
        remaining = Math.max(0, options.limit - processed.length);
        if (remaining <= 0) {
          break;
        }
      }
    }
  }
  if (remaining <= 0) {
    return processed;
  }
  for (const row of unroutedWorkerCompletionEventsSync(database, { limit: remaining })) {
    processed.push(routeWorkerCompletion(database, row, options));
  }
  return processed;
}

function unroutedWorkerCompletionEventsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { limit: number },
): WorkerCompletionEventRow[] {
  if (options.limit <= 0) {
    return [];
  }
  return database.prepare(`
    select
      ce.id as source_event_id,
      ce.timestamp as source_event_timestamp,
      ce.session_id as source_session_id,
      ce.payload_json as source_payload_json,
      b.id as binding_id,
      b.task_id as task_id,
      b.manager_session_id as target_session_id,
      ws.name as worker_session_name,
      ms.name as manager_session_name,
      t.name as task_name
    from codex_events ce
    join bindings b on b.worker_session_id = ce.session_id
    join sessions ws on ws.id = b.worker_session_id
    join sessions ms on ms.id = b.manager_session_id
    join tasks t on t.id = b.task_id
    left join routed_notifications rn on rn.source_event_id = ce.id
    where ce.subtype = 'task_complete'
      and b.state in ('active', 'ending')
      and rn.id is null
    order by ce.id asc
    limit ?
  `).all(options.limit) as unknown as WorkerCompletionEventRow[];
}

function claimPendingRoutedCompletionNotificationsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { dispatcherId: string; leaseSeconds: number; limit: number; now: string },
): ClaimedCompletionNotificationRow[] {
  if (options.limit <= 0) {
    return [];
  }
  const expiresAt = addSecondsIsoSeconds(options.now, options.leaseSeconds);
  const candidates = database.prepare(`
    select id
    from routed_notifications
    where state = 'pending'
      and signal_type = 'worker_task_complete'
      and side_effect_started = 0
      and (claim_expires_at is null or claim_expires_at <= ?)
    order by created_at, id
    limit ?
  `).all(options.now, options.limit) as Array<{ id: number }>;
  const claimedIds: number[] = [];
  for (const row of candidates) {
    const result = database.prepare(`
      update routed_notifications
      set claimed_by = ?, claimed_at = ?, claim_expires_at = ?
      where id = ?
        and state = 'pending'
        and side_effect_started = 0
        and (claim_expires_at is null or claim_expires_at <= ?)
    `).run(options.dispatcherId, options.now, expiresAt, row.id, options.now);
    if (result.changes > 0) {
      claimedIds.push(row.id);
    }
  }
  if (claimedIds.length === 0) {
    return [];
  }
  const placeholders = claimedIds.map(() => "?").join(",");
  return database.prepare(`
    select
      rn.id as notification_id,
      rn.task_id as task_id,
      rn.binding_id as binding_id,
      rn.correlation_id as correlation_id,
      rn.source_session_id as source_session_id,
      rn.target_session_id as target_session_id,
      rn.source_event_id as source_event_id,
      rn.source_event_timestamp as source_event_timestamp,
      rn.dedupe_key as dedupe_key,
      rn.payload_json as notification_payload_json,
      ws.name as worker_session_name,
      ms.name as manager_session_name,
      t.name as task_name
    from routed_notifications rn
    join sessions ws on ws.id = rn.source_session_id
    join sessions ms on ms.id = rn.target_session_id
    join tasks t on t.id = rn.task_id
    where rn.id in (${placeholders})
    order by rn.created_at, rn.id
  `).all(...claimedIds) as unknown as ClaimedCompletionNotificationRow[];
}

function failStaleStartedRoutedNotificationsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { limit: number; now: string },
): Array<Record<string, unknown>> {
  if (options.limit <= 0) {
    return [];
  }
  const rows = database.prepare(`
    select id, task_id, binding_id, correlation_id, source_event_id, signal_type,
           claimed_by, claim_expires_at
    from routed_notifications
    where state = 'pending'
      and signal_type = 'worker_task_complete'
      and side_effect_started = 1
      and side_effect_completed = 0
      and claim_expires_at is not null
      and claim_expires_at <= ?
    order by claim_expires_at, id
    limit ?
  `).all(options.now, options.limit) as Array<{
    binding_id: string;
    claim_expires_at: string | null;
    claimed_by: string | null;
    correlation_id: string;
    id: number;
    signal_type: string;
    source_event_id: number | null;
    task_id: string;
  }>;
  const failed: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const error = "stale pending completion notification had started side effect; not retrying automatically";
    database.prepare(`
      update routed_notifications
      set state = 'failed', error = ?
      where id = ? and state = 'pending'
    `).run(error, row.id);
    failed.push({
      binding_id: row.binding_id,
      claim_expires_at: row.claim_expires_at,
      claimed_by: row.claimed_by,
      correlation_id: row.correlation_id,
      error,
      notification_id: row.id,
      signal_type: row.signal_type,
      source_event_id: row.source_event_id,
      state: "failed",
      task_id: row.task_id,
    });
  }
  return failed;
}

function routeWorkerCompletion(
  database: ReturnType<typeof openRuntimeDatabase>,
  row: WorkerCompletionEventRow,
  options: { dispatcherId: string; dryRun: boolean; leaseSeconds: number; now: string; sleep?: (milliseconds: number) => void; tmuxRunner: TmuxRunner },
): Record<string, unknown> {
  const dedupeKey = `${row.binding_id}:worker_task_complete:${row.source_session_id}:${row.source_event_id}`;
  const correlationId = `dispatch-${randomUUID()}`;
  const message = dispatchCompletionMessage(row.worker_session_name, row.task_name);
  const sourcePayload = parseJsonObject(row.source_payload_json);
  const workerReceipt = {
    completed_at: sourcePayload.completed_at ?? null,
    duration_ms: sourcePayload.duration_ms ?? null,
    last_agent_message: sourcePayload.last_agent_message ?? null,
    source_event_id: row.source_event_id,
    source_event_timestamp: row.source_event_timestamp,
    source_session: row.worker_session_name,
    time_to_first_token_ms: sourcePayload.time_to_first_token_ms ?? null,
    turn_id: sourcePayload.turn_id ?? null,
  };
  const payload = {
    dispatcher_id: options.dispatcherId,
    message,
    signal: "worker_task_complete",
    source_event_id: row.source_event_id,
    source_session: row.worker_session_name,
    target_session: row.manager_session_name,
    task: row.task_name,
    worker_receipt: workerReceipt,
  };
  const result: Record<string, unknown> = {
    binding_id: row.binding_id,
    correlation_id: correlationId,
    dedupe_key: dedupeKey,
    dry_run: options.dryRun,
    signal_type: "worker_task_complete",
    source_event_id: row.source_event_id,
    target_session: row.manager_session_name,
    task: row.task_name,
  };
  if (options.dryRun) {
    result.state = "planned";
    return result;
  }
  const notificationId = insertCompletionNotification(database, {
    bindingId: row.binding_id,
    claimExpiresAt: addSecondsIsoSeconds(options.now, options.leaseSeconds),
    claimedAt: options.now,
    claimedBy: options.dispatcherId,
    correlationId,
    dedupeKey,
    payload,
    sourceEventId: row.source_event_id,
    sourceEventTimestamp: row.source_event_timestamp,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    taskId: row.task_id,
  }, result, {
    managerSessionName: row.manager_session_name,
    sourceEventId: row.source_event_id,
    taskName: row.task_name,
    workerSessionName: row.worker_session_name,
  });
  if (notificationId === null) {
    return result;
  }
  emitTelemetrySync(database, {
    actor: "dispatch",
    attributes: {
      delivery_mode: result.delivery_mode,
      source_session: row.worker_session_name,
      target_session: row.manager_session_name,
    },
    correlation: {
      binding_id: row.binding_id,
      correlation_id: correlationId,
      dispatcher_id: options.dispatcherId,
      source_event_id: row.source_event_id,
      signal_type: "worker_task_complete",
    },
    eventType: "dispatch_signal_detected",
    severity: "info",
    summary: `Dispatch detected worker completion for ${row.task_name}.`,
    taskId: row.task_id,
    timestamp: options.now,
  });
  return deliverWorkerCompletionNotification(database, {
    bindingId: row.binding_id,
    correlationId,
    managerSessionName: row.manager_session_name,
    message,
    notificationId,
    recovered: false,
    result,
    sourceEventId: row.source_event_id,
    taskId: row.task_id,
  }, options);
}

function deliverClaimedWorkerCompletion(
  database: ReturnType<typeof openRuntimeDatabase>,
  row: ClaimedCompletionNotificationRow,
  options: { dispatcherId: string; leaseSeconds: number; now: string; sleep?: (milliseconds: number) => void; tmuxRunner: TmuxRunner },
): Record<string, unknown> {
  const payload = parseJsonObject(row.notification_payload_json);
  const message = typeof payload.message === "string" && payload.message.trim()
    ? payload.message
    : dispatchCompletionMessage(row.worker_session_name, row.task_name);
  const result: Record<string, unknown> = {
    binding_id: row.binding_id,
    correlation_id: row.correlation_id,
    dedupe_key: row.dedupe_key,
    dry_run: false,
    notification_id: row.notification_id,
    recovered: true,
    signal_type: "worker_task_complete",
    source_event_id: row.source_event_id,
    target_session: row.manager_session_name,
    task: row.task_name,
  };
  const deliveryMode = deliveryModeForTargetSessionSync(database, row.target_session_id);
  database.prepare("update routed_notifications set delivery_mode = ? where id = ?").run(deliveryMode, row.notification_id);
  result.delivery_mode = deliveryMode;
  emitTelemetrySync(database, {
    actor: "dispatch",
    attributes: { delivery_mode: deliveryMode, target_session: row.manager_session_name },
    correlation: {
      binding_id: row.binding_id,
      correlation_id: row.correlation_id,
      dispatcher_id: options.dispatcherId,
      routed_notification_id: row.notification_id,
      source_event_id: row.source_event_id,
      signal_type: "worker_task_complete",
    },
    eventType: "dispatch_signal_recovered",
    severity: "info",
    summary: `Dispatch recovered pending worker completion notification for ${row.task_name}.`,
    taskId: row.task_id,
    timestamp: options.now,
  });
  return deliverWorkerCompletionNotification(database, {
    bindingId: row.binding_id,
    correlationId: row.correlation_id,
    managerSessionName: row.manager_session_name,
    message,
    notificationId: row.notification_id,
    recovered: true,
    result,
    sourceEventId: row.source_event_id,
    taskId: row.task_id,
  }, options);
}

function insertCompletionNotification(
  database: ReturnType<typeof openRuntimeDatabase>,
  notification: {
    bindingId: string;
    claimExpiresAt: string;
    claimedAt: string;
    claimedBy: string;
    correlationId: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    sourceEventId: number;
    sourceEventTimestamp: string;
    sourceSessionId: string;
    targetSessionId: string;
    taskId: string;
  },
  result: Record<string, unknown>,
  context: { managerSessionName: string; sourceEventId: number; taskName: string; workerSessionName: string },
): number | null {
  const deliveryMode = deliveryModeForTargetSessionSync(database, notification.targetSessionId);
  result.delivery_mode = deliveryMode;
  try {
    return insertRoutedNotificationSync(database, {
      bindingId: notification.bindingId,
      claimExpiresAt: notification.claimExpiresAt,
      claimedAt: notification.claimedAt,
      claimedBy: notification.claimedBy,
      correlationId: notification.correlationId,
      dedupeKey: notification.dedupeKey,
      deliveryMode,
      now: notification.claimedAt,
      payload: { ...notification.payload, delivery_mode: deliveryMode },
      signalType: "worker_task_complete",
      sourceEventId: notification.sourceEventId,
      sourceEventTimestamp: notification.sourceEventTimestamp,
      sourceSessionId: notification.sourceSessionId,
      targetSessionId: notification.targetSessionId,
      taskId: notification.taskId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("UNIQUE constraint failed")) {
      throw error;
    }
    result.state = "suppressed";
    emitTelemetrySync(database, {
      actor: "dispatch",
      attributes: {
        dedupe_key: notification.dedupeKey,
        error: message,
        source_session: context.workerSessionName,
        target_session: context.managerSessionName,
      },
      correlation: {
        binding_id: notification.bindingId,
        correlation_id: notification.correlationId,
        dispatcher_id: notification.claimedBy,
        source_event_id: context.sourceEventId,
        signal_type: "worker_task_complete",
      },
      eventType: "dispatch_signal_suppressed",
      severity: "info",
      summary: `Dispatch suppressed duplicate worker_task_complete for ${context.taskName}.`,
      taskId: notification.taskId,
      timestamp: notification.claimedAt,
    });
    return null;
  }
}

function deliverWorkerCompletionNotification(
  database: ReturnType<typeof openRuntimeDatabase>,
  delivery: {
    bindingId: string;
    correlationId: string;
    managerSessionName: string;
    message: string;
    notificationId: number;
    recovered: boolean;
    result: Record<string, unknown>;
    sourceEventId: number | null;
    taskId: string;
  },
  options: { dispatcherId: string; leaseSeconds: number; now: string; sleep?: (milliseconds: number) => void; tmuxRunner: TmuxRunner },
): Record<string, unknown> {
  const deliveryMode = String(delivery.result.delivery_mode ?? "push");
  if (deliveryMode === "pull_required") {
    finishRoutedNotificationSync(database, {
      notificationId: delivery.notificationId,
      now: options.now,
      sideEffectCompleted: false,
      state: "delivered",
    });
    emitTelemetrySync(database, {
      actor: "dispatch",
      attributes: {
        delivery_mode: deliveryMode,
        ...(delivery.recovered ? { recovered: true } : {}),
        target_session: delivery.managerSessionName,
      },
      correlation: {
        binding_id: delivery.bindingId,
        correlation_id: delivery.correlationId,
        dispatcher_id: options.dispatcherId,
        routed_notification_id: delivery.notificationId,
        source_event_id: delivery.sourceEventId,
        signal_type: "worker_task_complete",
      },
      eventType: "dispatch_signal_pull_required",
      severity: "info",
      summary: delivery.recovered
        ? `Dispatch recorded pull-required recovered worker completion for ${delivery.managerSessionName}.`
        : `Dispatch recorded pull-required worker completion for ${delivery.managerSessionName}.`,
      taskId: delivery.taskId,
      timestamp: options.now,
    });
    Object.assign(delivery.result, {
      delivery_mode: deliveryMode,
      notification_id: delivery.notificationId,
      state: "pull_required",
    });
    return delivery.result;
  }
  const sideEffectAudit = { side_effect_completed: false, side_effect_started: false };
  try {
    const managerSession = sessionRow(database, delivery.managerSessionName, "manager");
    const claimExpiresAt = addSecondsIsoSeconds(options.now, options.leaseSeconds);
    const sendResult = sendTextToSessionWithRunner(managerSession, delivery.message, options.tmuxRunner, {
      now: () => options.now,
      sideEffectAudit,
      sideEffectStartedCallback: () => {
        markRoutedNotificationSideEffectStartedSync(database, {
          claimExpiresAt,
          claimedBy: options.dispatcherId,
          notificationId: delivery.notificationId,
          now: options.now,
        });
      },
      sleep: options.sleep,
    });
    markRoutedNotificationSideEffectStartedSync(database, { notificationId: delivery.notificationId });
    finishRoutedNotificationSync(database, {
      notificationId: delivery.notificationId,
      now: options.now,
      state: "delivered",
    });
    emitTelemetrySync(database, {
      actor: "dispatch",
      attributes: {
        ...(delivery.recovered ? { recovered: true } : {}),
        target: sendResult.target,
        target_session: delivery.managerSessionName,
      },
      correlation: {
        binding_id: delivery.bindingId,
        correlation_id: delivery.correlationId,
        dispatcher_id: options.dispatcherId,
        routed_notification_id: delivery.notificationId,
        source_event_id: delivery.sourceEventId,
        signal_type: "worker_task_complete",
      },
      eventType: "dispatch_signal_routed",
      severity: "info",
      summary: `Dispatch notified manager ${delivery.managerSessionName}.`,
      taskId: delivery.taskId,
      timestamp: options.now,
    });
    Object.assign(delivery.result, {
      delivery_mode: deliveryMode,
      notification_id: delivery.notificationId,
      state: "delivered",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (sideEffectAudit.side_effect_started) {
      markRoutedNotificationSideEffectStartedSync(database, { notificationId: delivery.notificationId });
      finishRoutedNotificationSync(database, {
        error: message,
        notificationId: delivery.notificationId,
        now: options.now,
        state: "failed",
      });
    } else {
      deferRoutedNotificationBeforeSideEffectSync(database, {
        error: message,
        notificationId: delivery.notificationId,
      });
    }
    emitTelemetrySync(database, {
      actor: "dispatch",
      attributes: {
        error: message,
        error_type: error instanceof Error ? error.name : typeof error,
        ...(delivery.recovered ? { recovered: true } : {}),
        target_session: delivery.managerSessionName,
      },
      correlation: {
        binding_id: delivery.bindingId,
        correlation_id: delivery.correlationId,
        dispatcher_id: options.dispatcherId,
        routed_notification_id: delivery.notificationId,
        source_event_id: delivery.sourceEventId,
        signal_type: "worker_task_complete",
      },
      eventType: "dispatch_signal_failed",
      severity: "error",
      summary: `Dispatch failed to notify manager ${delivery.managerSessionName}.`,
      taskId: delivery.taskId,
      timestamp: options.now,
    });
    Object.assign(delivery.result, {
      error: message,
      notification_id: delivery.notificationId,
      state: "failed",
    });
  }
  return delivery.result;
}

function dispatchCompletionMessage(workerName: string, taskName: string): string {
  return `Worker ${workerName} appears to have completed a turn for task ${taskName}. `
    + "Run/inspect conveyor cycle, review evidence and acceptance criteria, then decide "
    + "whether to finish, request fixes, or continue observing.";
}

function addSecondsIsoSeconds(now: string, seconds: number): string {
  const parsed = new Date(now.replace(/Z$/, "+00:00"));
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return new Date(base.getTime() + Math.max(1, seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function commandRowsForCli(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    attempts: boolean;
    commandType: string | null;
    managerId: string | null;
    state: string | null;
    task: string | null;
    workerId: string | null;
  },
): Array<Record<string, unknown>> {
  const clauses: string[] = [];
  const params: Array<number | string> = [];
  if (options.task !== null) {
    clauses.push("(commands.task_id = ? or tasks.name = ?)");
    params.push(options.task, options.task);
  }
  if (options.state !== null) {
    clauses.push("commands.state = ?");
    params.push(options.state);
  }
  if (options.commandType !== null) {
    clauses.push("commands.type = ?");
    params.push(options.commandType);
  }
  if (options.workerId !== null) {
    clauses.push("commands.worker_id = ?");
    params.push(options.workerId);
  }
  if (options.managerId !== null) {
    clauses.push("commands.manager_id = ?");
    params.push(options.managerId);
  }
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const rows = database.prepare(`
    select commands.id, commands.idempotency_key, commands.created_at, commands.updated_at,
           commands.task_id, tasks.name as task_name, commands.worker_id, commands.manager_id,
           commands.correlation_id, commands.type, commands.state, commands.available_at,
           commands.claimed_by, commands.claimed_at, commands.claim_expires_at,
           commands.attempts, commands.max_attempts, commands.payload_json,
           commands.required_permission, commands.result_json, commands.error
    from commands
    left join tasks on tasks.id = commands.task_id
    ${where}
    order by commands.created_at, commands.id
  `).all(...params) as Array<{
    attempts: number;
    available_at: string | null;
    claim_expires_at: string | null;
    claimed_at: string | null;
    claimed_by: string | null;
    correlation_id: string | null;
    created_at: string;
    error: string | null;
    id: string;
    idempotency_key: string;
    manager_id: string | null;
    max_attempts: number;
    payload_json: string;
    required_permission: string | null;
    result_json: string | null;
    state: string;
    task_id: string | null;
    task_name: string | null;
    type: string;
    updated_at: string;
    worker_id: string | null;
  }>;
  return rows.map((row) => {
    const record: Record<string, unknown> = {
      attempts: row.attempts,
      available_at: row.available_at,
      claim_expires_at: row.claim_expires_at,
      claimed_at: row.claimed_at,
      claimed_by: row.claimed_by,
      correlation_id: row.correlation_id,
      created_at: row.created_at,
      error: row.error,
      id: row.id,
      idempotency_key: row.idempotency_key,
      manager_id: row.manager_id,
      max_attempts: row.max_attempts,
      payload: parseJsonObject(row.payload_json),
      required_permission: row.required_permission,
      result: row.result_json ? parseJsonObject(row.result_json) : null,
      state: row.state,
      task_id: row.task_id,
      task_name: row.task_name,
      type: row.type,
      updated_at: row.updated_at,
      worker_id: row.worker_id,
    };
    if (options.attempts) {
      record.attempt_history = commandAttemptRowsForCli(database, row.id);
    }
    return record;
  });
}

function commandAttemptRowsForCli(database: ReturnType<typeof openRuntimeDatabase>, commandId: string): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    select id, command_id, correlation_id, dispatcher_id, started_at, finished_at,
           state, result_json, error, side_effect_started, side_effect_completed
    from command_attempts
    where command_id = ?
    order by id
  `).all(commandId) as Array<{
    command_id: string;
    correlation_id: string;
    dispatcher_id: string;
    error: string | null;
    finished_at: string | null;
    id: number;
    result_json: string | null;
    side_effect_completed: number;
    side_effect_started: number;
    started_at: string;
    state: string;
  }>;
  return rows.map((row) => ({
    command_id: row.command_id,
    correlation_id: row.correlation_id,
    dispatcher_id: row.dispatcher_id,
    error: row.error,
    finished_at: row.finished_at,
    id: row.id,
    result: row.result_json ? parseJsonObject(row.result_json) : null,
    side_effect_completed: Boolean(row.side_effect_completed),
    side_effect_started: Boolean(row.side_effect_started),
    started_at: row.started_at,
    state: row.state,
  }));
}

function renderCommandsText(records: Array<Record<string, unknown>>): string {
  if (records.length === 0) {
    return "";
  }
  return records.map((record) => {
    const suffix = Array.isArray(record.attempt_history) ? `\tattempts=${record.attempt_history.length}` : "";
    return `${record.id}\t${record.state}\t${record.type}\t${record.task_name ?? record.task_id ?? ""}${suffix}`;
  }).join("\n") + "\n";
}

interface EnqueueRalphLoopRun {
  cleanup_policy: string | null;
  current_iteration: number;
  id: string;
  max_iterations: number;
  metadata: Record<string, unknown>;
  preset: string | null;
  required_before_continue: string[];
  seed_prompt_sha256: string | null;
  stop_conditions: string[];
  task_id: string;
}

function ralphLoopRunForEnqueue(database: ReturnType<typeof openRuntimeDatabase>, run: string): EnqueueRalphLoopRun {
  const row = runRowSync(database, run);
  if (row.metadata.kind !== "ralph_loop" && row.purpose !== "ralph_loop") {
    throw new Error(`Run ${JSON.stringify(run)} is not a Ralph loop run`);
  }
  const currentIteration = integerValue(row.metadata.current_iteration);
  const maxIterations = integerValue(row.metadata.max_iterations);
  if (currentIteration === null || maxIterations === null) {
    throw new Error(`Ralph loop run ${JSON.stringify(run)} is missing iteration policy`);
  }
  return {
    cleanup_policy: typeof row.metadata.cleanup_policy === "string" ? row.metadata.cleanup_policy : null,
    current_iteration: currentIteration,
    id: row.id,
    max_iterations: maxIterations,
    metadata: row.metadata,
    preset: typeof row.metadata.preset === "string" ? row.metadata.preset : null,
    required_before_continue: asStringArray(row.metadata.required_before_continue).map((item) => item.trim()).filter(Boolean),
    seed_prompt_sha256: typeof row.metadata.seed_prompt_sha256 === "string" ? row.metadata.seed_prompt_sha256 : null,
    stop_conditions: asStringArray(row.metadata.stop_conditions),
    task_id: row.task_id,
  };
}

function enqueueLoopPolicyPayload(run: EnqueueRalphLoopRun): Record<string, unknown> {
  return {
    artifact_requirements: isPlainRecord(run.metadata.artifact_requirements) ? run.metadata.artifact_requirements : {},
    cleanup_policy: run.cleanup_policy,
    current_iteration: run.current_iteration,
    max_iterations: run.max_iterations,
    preset: run.preset,
    recommended_tools: Array.isArray(run.metadata.recommended_tools) ? run.metadata.recommended_tools : [],
    required_before_continue: run.required_before_continue,
    run_id: run.id,
    seed_prompt_sha256: run.seed_prompt_sha256,
    stop_conditions: run.stop_conditions,
    tags: Array.isArray(run.metadata.tags) ? run.metadata.tags : [],
    template: run.metadata.template ?? run.preset,
  };
}

function integerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function integerMetadataField(value: unknown, message: string): number {
  const parsed = integerValue(value);
  if (parsed === null) {
    throw new Error(message);
  }
  return parsed;
}

function beginImmediateSync(database: ReturnType<typeof openRuntimeDatabase>): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollbackSync(database: ReturnType<typeof openRuntimeDatabase>): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the primary criteria mutation error.
  }
}

function jsonObjectArg(value: string | null, flag: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isPlainRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  throw new Error(`${flag} must be a JSON object`);
}

function parseCriterionStatus(status: string): AcceptanceCriterionStatus {
  if (["accepted", "deferred", "proposed", "rejected", "satisfied"].includes(status)) {
    return status as AcceptanceCriterionStatus;
  }
  throw new Error(`Invalid acceptance criterion status: ${status}`);
}

function parseCriterionSource(source: string): AcceptanceCriterionSource {
  if (["final_audit", "manager_inferred", "user_requested", "worker_proposed"].includes(source)) {
    return source as AcceptanceCriterionSource;
  }
  throw new Error(`Invalid acceptance criterion source: ${source}`);
}

function criteriaTransition(parsed: ParsedRuntimeArgs): { criterionId: number; status: AcceptanceCriterionStatus } | null {
  if (parsed.flags.acceptCriterion !== null) {
    return { criterionId: parsed.flags.acceptCriterion, status: "accepted" };
  }
  if (parsed.flags.satisfyCriterion !== null) {
    return { criterionId: parsed.flags.satisfyCriterion, status: "satisfied" };
  }
  if (parsed.flags.deferCriterion !== null) {
    return { criterionId: parsed.flags.deferCriterion, status: "deferred" };
  }
  if (parsed.flags.rejectCriterion !== null) {
    return { criterionId: parsed.flags.rejectCriterion, status: "rejected" };
  }
  return null;
}

function criteriaResponseSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    affected: AcceptanceCriterionRecord | null;
    statuses?: AcceptanceCriterionStatus[];
    task: LifecycleTaskRow;
  },
): Record<string, unknown> {
  const allCriteria = acceptanceCriteriaForTaskSync(database, { taskId: options.task.id });
  const criteria = options.statuses === undefined
    ? allCriteria
    : acceptanceCriteriaForTaskSync(database, { statuses: options.statuses, taskId: options.task.id });
  const response: Record<string, unknown> = {
    criteria,
    summary: criteriaSummary(allCriteria),
    task: { id: options.task.id, name: options.task.name },
  };
  if (options.affected !== null) {
    response.affected_criterion = options.affected;
  }
  return response;
}

function criteriaSummary(criteria: AcceptanceCriterionRecord[]): Record<AcceptanceCriterionStatus, number> {
  const summary: Record<AcceptanceCriterionStatus, number> = {
    accepted: 0,
    deferred: 0,
    proposed: 0,
    rejected: 0,
    satisfied: 0,
  };
  for (const criterion of criteria) {
    summary[criterion.status] += 1;
  }
  return summary;
}

function insertAcceptanceCriterionFromCliSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    criterion: string;
    evidence: Record<string, unknown>;
    proof: string | null;
    rationale: string | null;
    source: AcceptanceCriterionSource;
    status: AcceptanceCriterionStatus;
    taskId: string;
  },
): AcceptanceCriterionRecord {
  const existing = database.prepare(`
    select id
    from acceptance_criteria
    where task_id = ? and source = ? and criterion = ?
  `).get(options.taskId, options.source, options.criterion) as { id: number } | undefined;
  if (existing) {
    return criterionByIdSync(database, existing.id);
  }
  const timestamp = new Date().toISOString();
  const result = database.prepare(`
    insert into acceptance_criteria(
      task_id, criterion, status, source, proof, rationale,
      evidence_json, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.criterion,
    options.status,
    options.source,
    options.proof,
    options.rationale,
    stableJson(options.evidence),
    timestamp,
    timestamp,
  );
  const criterion = criterionByIdSync(database, Number(result.lastInsertRowid));
  insertEventSync(database, {
    payload: acceptanceCriterionEventPayload(criterion, { created: true, taskId: options.taskId }),
    taskId: options.taskId,
    type: "acceptance_criterion_added",
  });
  insertWorkerctlTelemetrySync(database, {
    attributes: {
      criterion: options.criterion,
      has_evidence: Object.keys(options.evidence).length > 0,
      has_proof: options.proof !== null,
      status: options.status,
    },
    correlation: { criterion_id: criterion.id, source: options.source },
    eventType: "acceptance_criterion_added",
    severity: "info",
    summary: "Added acceptance criterion.",
    taskId: options.taskId,
    timestamp,
  });
  return criterion;
}

function updateAcceptanceCriterionFromCliSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    criterionId: number;
    evidence: Record<string, unknown> | null;
    proof: string | null;
    rationale: string | null;
    status: AcceptanceCriterionStatus;
    taskId: string;
    taskName: string;
  },
): AcceptanceCriterionRecord {
  const existing = criterionByIdForTaskSync(database, options.criterionId, options.taskId, options.taskName);
  const timestamp = new Date().toISOString();
  database.prepare(`
    update acceptance_criteria
    set status = ?,
        evidence_json = ?,
        proof = ?,
        rationale = ?,
        updated_at = ?
    where id = ?
  `).run(
    options.status,
    stableJson(options.evidence ?? existing.evidence),
    options.proof ?? existing.proof,
    options.rationale ?? existing.rationale,
    timestamp,
    options.criterionId,
  );
  const criterion = criterionByIdSync(database, options.criterionId);
  insertEventSync(database, {
    payload: acceptanceCriterionEventPayload(criterion, { previous: existing, taskId: options.taskId }),
    taskId: options.taskId,
    type: "acceptance_criterion_updated",
  });
  insertWorkerctlTelemetrySync(database, {
    attributes: {
      criterion: criterion.criterion,
      has_evidence: Object.keys(criterion.evidence).length > 0,
      has_proof: criterion.proof !== null,
      previous_status: existing.status,
      status: criterion.status,
    },
    correlation: { criterion_id: criterion.id, source: criterion.source },
    eventType: "acceptance_criterion_updated",
    severity: "info",
    summary: "Updated acceptance criterion.",
    taskId: options.taskId,
    timestamp,
  });
  return criterion;
}

function criterionByIdForTaskSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  criterionId: number,
  taskId: string,
  taskName: string,
): AcceptanceCriterionRecord {
  const existing = acceptanceCriteriaForTaskSync(database, { taskId })
    .find((criterion) => criterion.id === criterionId);
  if (!existing) {
    throw new Error(`Unknown acceptance criterion for task ${taskName}: ${criterionId}`);
  }
  return existing;
}

function criterionByIdSync(database: ReturnType<typeof openRuntimeDatabase>, criterionId: number): AcceptanceCriterionRecord {
  const row = database.prepare(`
    select id, task_id, criterion, status, source, proof, rationale,
           evidence_json, created_at, updated_at
    from acceptance_criteria
    where id = ?
  `).get(criterionId) as {
    created_at: string;
    criterion: string;
    evidence_json: string;
    id: number;
    proof: string | null;
    rationale: string | null;
    source: AcceptanceCriterionSource;
    status: AcceptanceCriterionStatus;
    task_id: string;
    updated_at: string;
  } | undefined;
  if (!row) {
    throw new Error(`Unknown acceptance criterion: ${criterionId}`);
  }
  return {
    created_at: row.created_at,
    criterion: row.criterion,
    evidence: parseJsonObject(row.evidence_json),
    id: row.id,
    proof: row.proof,
    rationale: row.rationale,
    source: row.source,
    status: row.status,
    task_id: row.task_id,
    updated_at: row.updated_at,
  };
}

function acceptanceCriterionEventPayload(
  criterion: AcceptanceCriterionRecord,
  options: {
    created?: boolean;
    previous?: AcceptanceCriterionRecord;
    taskId: string;
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    criterion: criterion.criterion,
    criterion_id: criterion.id,
    evidence: criterion.evidence,
    proof: criterion.proof,
    rationale: criterion.rationale,
    source: criterion.source,
    status: criterion.status,
    task_id: options.taskId,
  };
  if (options.created !== undefined) {
    payload.created = options.created;
  }
  if (options.previous) {
    payload.previous_evidence = options.previous.evidence;
    payload.previous_proof = options.previous.proof;
    payload.previous_rationale = options.previous.rationale;
    payload.previous_status = options.previous.status;
  }
  return payload;
}

function createRunFromCliSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    metadata: Record<string, unknown>;
    name: string | null;
    purpose: string | null;
    task: LifecycleTaskRow;
  },
): RalphLoopRunRow {
  const active = database.prepare(`
    select id
    from runs
    where task_id = ? and status = 'active'
    order by started_at desc, id desc
    limit 1
  `).get(options.task.id) as { id: string } | undefined;
  if (active) {
    throw new Error(`task ${JSON.stringify(options.task.name)} already has active run ${JSON.stringify(active.id)}`);
  }
  const timestamp = new Date().toISOString();
  const runId = `run-${randomUUID()}`;
  const name = options.name ?? `${options.task.name}-${timestamp.replace(/:/g, "").replace(/\./g, "-")}`;
  database.prepare(`
    insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
    values (?, ?, ?, ?, 'active', ?, null, ?)
  `).run(runId, options.task.id, name, options.purpose, timestamp, stableJson(options.metadata));
  return runRowSync(database, runId);
}

function finishRunFromCliSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    run: string;
    status: string;
  },
): RalphLoopRunRow {
  if (!["finished", "failed", "abandoned"].includes(options.status)) {
    throw new Error("run finish status must be one of: finished, failed, abandoned");
  }
  const current = runRowSync(database, options.run);
  const timestamp = new Date().toISOString();
  database.prepare("update runs set status = ?, ended_at = ? where id = ?")
    .run(options.status, timestamp, current.id);
  insertWorkerctlTelemetrySync(database, {
    attributes: { status: options.status },
    correlation: { run_id: current.id, run_name: current.name },
    eventType: "run_finished",
    runId: current.id,
    severity: options.status === "failed" ? "error" : "info",
    summary: `Run ${current.name} marked ${options.status}.`,
    timestamp,
  });
  return runRowSync(database, current.id);
}

function listRunsFromCliSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    status: string | null;
    taskId: string | null;
  },
): RalphLoopRunRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.taskId !== null) {
    clauses.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.status !== null) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const rows = database.prepare(`
    select id
    from runs
    ${where}
    order by started_at desc, id desc
  `).all(...params) as Array<{ id: string }>;
  return rows.map((row) => runRowSync(database, row.id));
}

function insertWorkerctlTelemetrySync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    attributes: Record<string, unknown>;
    correlation: Record<string, unknown>;
    eventType: string;
    runId?: string | null;
    severity: "debug" | "error" | "info" | "warning";
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
    values (?, ?, ?, ?, 'workerctl', ?, ?, ?, ?, ?)
  `).run(
    eventId,
    options.runId ?? null,
    options.taskId ?? null,
    options.timestamp,
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
    values (?, ?, ?, 'workerctl', ?, ?, ?)
  `).run(eventId, options.taskId ?? null, options.runId ?? null, options.eventType, options.summary, attributesJson);
}

interface CriteriaSuggestion {
  criterion: string;
  rationale: string | null;
  source: "worker_proposed";
  status: "accepted" | "deferred";
}

const DEFAULT_DEFERRED_RATIONALE = "Follow-up after this QA slice.";
const ACCEPTED_HEADING_RE = /\b(must[- ]?have|current[- ]?task|accepted)\b/i;
const DEFERRED_HEADING_RE = /\b(follow[- ]?up|deferred)\b/i;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+(?<text>.+?)\s*$/;
const EMPTY_ITEM_RE = /^(?:n\/?a|none|no follow[- ]?ups?|no deferred(?: criteria)?|nothing)$/i;
const INDENTED_CONTINUATION_RE = /^\s+\S/;

function planCriteriaCommands(task: string, text: string, options: { path: string | null }): Record<string, unknown> {
  const { suggestions, warnings } = parseWorkerCriteriaResponse(text);
  return {
    suggestions: suggestions.map((suggestion) => ({
      ...suggestion,
      command: suggestionToArgv(task, suggestion, options),
    })),
    task,
    warnings,
  };
}

function parseWorkerCriteriaResponse(text: string): { suggestions: CriteriaSuggestion[]; warnings: string[] } {
  const suggestions: CriteriaSuggestion[] = [];
  const warnings: string[] = [];
  let currentStatus: "accepted" | "deferred" | null = null;
  let activeItemParts: string[] = [];
  let activeItemStatus: "accepted" | "deferred" | null = null;
  let sawHeading = false;

  const flushActiveItem = () => {
    if (activeItemStatus !== null) {
      const suggestion = makeCriteriaSuggestion(activeItemParts.join(" "), activeItemStatus);
      if (suggestion !== null) {
        suggestions.push(suggestion);
      }
    }
    activeItemParts = [];
    activeItemStatus = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushActiveItem();
      continue;
    }
    const listItem = LIST_ITEM_RE.exec(rawLine);
    if (listItem?.groups?.text && currentStatus !== null) {
      flushActiveItem();
      activeItemParts = [listItem.groups.text];
      activeItemStatus = currentStatus;
      continue;
    }
    if (activeItemStatus !== null && INDENTED_CONTINUATION_RE.test(rawLine)) {
      activeItemParts.push(line);
      continue;
    }
    const heading = headingStatus(line);
    if (heading !== null) {
      flushActiveItem();
      currentStatus = heading;
      sawHeading = true;
      continue;
    }
    flushActiveItem();
  }
  flushActiveItem();

  if (!sawHeading) {
    warnings.push(
      "No clear must-have/current-task or follow-up/deferred headings found. Ask the worker to separate current-task criteria from deferred follow-ups.",
    );
  } else if (suggestions.length === 0) {
    warnings.push("Clear criteria headings were found, but no bullet or numbered criteria items were detected.");
  }
  return { suggestions, warnings };
}

function headingStatus(line: string): "accepted" | "deferred" | null {
  const cleaned = line.trim().replace(/^#+/, "").trim().replace(/:$/, "").trim();
  if (!cleaned) {
    return null;
  }
  if (DEFERRED_HEADING_RE.test(cleaned)) {
    return "deferred";
  }
  if (ACCEPTED_HEADING_RE.test(cleaned)) {
    return "accepted";
  }
  return null;
}

function makeCriteriaSuggestion(text: string, status: "accepted" | "deferred"): CriteriaSuggestion | null {
  const criterion = text.trim().replace(/^`|`$/g, "").replace(/\s+/g, " ");
  if (!criterion || EMPTY_ITEM_RE.test(criterion.replace(/\.$/, ""))) {
    return null;
  }
  return {
    criterion,
    rationale: status === "deferred" ? DEFAULT_DEFERRED_RATIONALE : null,
    source: "worker_proposed",
    status,
  };
}

function suggestionToArgv(task: string, suggestion: CriteriaSuggestion, options: { path: string | null }): string[] {
  const argv = [
    "conveyor",
    "criteria",
    task,
    "--add",
    "--criterion",
    suggestion.criterion,
    "--source",
    suggestion.source,
    "--status",
    suggestion.status,
  ];
  if (suggestion.rationale) {
    argv.push("--rationale", suggestion.rationale);
  }
  if (options.path) {
    argv.push("--path", options.path);
  }
  return argv;
}

function renderCriteriaPlanText(result: Record<string, unknown>): string {
  const task = String(result.task ?? "");
  const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const lines = [`Suggested criteria commands for ${task}`];
  for (const suggestion of suggestions) {
    if (isPlainRecord(suggestion) && Array.isArray(suggestion.command)) {
      lines.push(suggestion.command.map((part) => shellQuote(String(part))).join(" "));
    }
  }
  for (const warning of warnings) {
    lines.push(`warning: ${String(warning)}`);
  }
  return `${lines.join("\n")}\n`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  return isPlainRecord(parsed) ? parsed : {};
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
  return resolve(expandUserPath(parsed.flags.path ?? defaultDbPath({ cwd: options.cwd, env: options.env })));
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
    || command === "criteria"
    || command === "criteria-plan"
    || command === "runs"
    || command === "loop-evidence"
    || command === "loop-status"
    || command === "loop-templates"
    || command === "loop-triggers"
    || command === "ralph-loop-presets"
    || command === "start"
    || command === "create"
    || command === "start-test"
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
    || command === "pair"
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
    || command === "commands"
    || command === "enqueue-notify-manager"
    || command === "enqueue-nudge-worker"
    || command === "enqueue-continue-iteration"
    || command === "dispatch"
  );
}

function valueAfter(args: readonly string[], index: number, flag: string): { error?: string; value: string } {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return { error: `${flag} requires a value.`, value: "" };
  }
  return { value };
}

function isHelpArg(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function startPassthroughFlagTakesValue(flag: string): boolean {
  return START_PASSTHROUGH_FLAGS_WITH_VALUES.has(flag);
}

function isStartPassthroughFlag(arg: string): boolean {
  return arg.startsWith("-") && arg !== "-";
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

function unsupportedMigratedProofCliOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.dryRun) {
    return `Unsupported TypeScript runtime option for ${parsed.command}.`;
  }
  return null;
}

function unsupportedLoopCommandOptions(
  parsed: ParsedRuntimeArgs,
  options: {
    allowedFlags: Set<RuntimeFlagKey>;
    allowTask?: boolean;
    commandName: string;
  },
): string | null {
  if (!options.allowTask && parsed.task !== null) {
    return `Unexpected argument: ${parsed.task}`;
  }
  const defaultFlags = parseRuntimeArgs(parsed.command ? [parsed.command] : [], {}).flags;
  for (const key of Object.keys(parsed.flags) as RuntimeFlagKey[]) {
    if (options.allowedFlags.has(key)) {
      continue;
    }
    if (!runtimeFlagValuesEqual(parsed.flags[key], defaultFlags[key])) {
      return `Unsupported TypeScript runtime option for ${options.commandName}.`;
    }
  }
  return null;
}

function runtimeFlagValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]));
  }
  return Object.is(left, right);
}

function unsupportedCommandsOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
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
    || parsed.flags.keepLatest !== 20
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.pid !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.roleProvided
    || parsed.flags.sessionRole !== null
    || parsed.flags.sessionState !== null
    || parsed.flags.statusAgeSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for commands.";
  }
  return null;
}

function unsupportedEnqueueOptions(
  parsed: ParsedRuntimeArgs,
  commandType: "continue_iteration" | "notify_manager" | "nudge_worker",
): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.attempts
    || parsed.flags.blocker !== null
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
    || parsed.flags.keepLatest !== 20
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
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.manager !== null
    || parsed.flags.zip
  ) {
    return `Unsupported TypeScript runtime option for ${parsed.command}.`;
  }
  if (!parsed.task) {
    return `${parsed.command} requires a task.`;
  }
  if (parsed.flags.message === null || !parsed.flags.message.trim()) {
    return `${commandType} message must be non-empty`;
  }
  if (commandType !== "continue_iteration") {
    if (parsed.flags.loopRun !== null || parsed.flags.requestedIteration !== null || parsed.flags.decisionId !== null) {
      return `Unsupported TypeScript runtime option for ${parsed.command}.`;
    }
  }
  if (commandType === "continue_iteration" && (parsed.flags.loopRun === null || parsed.flags.requestedIteration === null)) {
    return "enqueue-continue-iteration requires --loop-run and --requested-iteration.";
  }
  return null;
}

function unsupportedDispatchOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.attempts
    || parsed.flags.blocker !== null
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
    || parsed.flags.keepLatest !== 20
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
    return "Unsupported TypeScript runtime option for dispatch.";
  }
  if (parsed.flags.once && parsed.flags.watch) {
    return "dispatch accepts either --once or --watch, not both";
  }
  return null;
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

function unsupportedLegacyStartOptions(parsed: ParsedRuntimeArgs): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.create !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.force
    || parsed.flags.forceOpen
    || parsed.flags.goal !== null
    || parsed.flags.json
    || parsed.flags.limit !== null
    || parsed.flags.names.length > 0
    || parsed.flags.open
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.codexSession !== null
    || parsed.flags.reuse
    || parsed.flags.stopAfter
    || parsed.flags.taskName !== null
    || parsed.flags.terminal !== "auto"
    || parsed.flags.verify
    || parsed.flags.waitReady
  ) {
    return "Unsupported TypeScript runtime option for start.";
  }
  return null;
}

function unsupportedLegacyCreateOptions(parsed: ParsedRuntimeArgs, startTest: boolean): string | null {
  if (
    parsed.flags.active
    || parsed.flags.all
    || parsed.flags.blocker !== null
    || parsed.flags.busyWaitSeconds !== DEFAULT_BUSY_WAIT_SECONDS
    || parsed.flags.captureTranscriptBeforeStop
    || parsed.flags.captureTranscriptLines !== DEFAULT_HISTORY_LINES
    || parsed.flags.captureTranscriptMode !== "segment"
    || parsed.flags.cleanupPolicy !== "clear"
    || parsed.flags.create !== null
    || parsed.flags.currentIteration !== 1
    || parsed.flags.currentTask !== null
    || parsed.flags.decisionId !== null
    || parsed.flags.dryRun
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.format !== "timeline"
    || parsed.flags.force
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
    || parsed.flags.json
    || parsed.flags.keepLatest !== 20
    || parsed.flags.lines !== DEFAULT_HISTORY_LINES
    || parsed.flags.limit !== null
    || parsed.flags.manager !== null
    || parsed.flags.maxIterations !== null
    || parsed.flags.message !== null
    || parsed.flags.names.length > 0
    || parsed.flags.nextAction !== null
    || parsed.flags.output !== null
    || parsed.flags.path !== null
    || parsed.flags.pid !== null
    || parsed.flags.codexSession !== null
    || parsed.flags.reason !== null
    || parsed.flags.redactIdentityToken
    || parsed.flags.refresh === false
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
    || parsed.flags.stopManager
    || parsed.flags.stopWorker
    || parsed.flags.strictDecisions
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.taskGoal !== null
    || parsed.flags.taskPrompt !== null
    || parsed.flags.taskSummary !== null
    || parsed.flags.template !== null
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.transcriptMode !== "segment"
    || parsed.flags.worker !== null
    || parsed.flags.workerName !== null
    || parsed.flags.zip
  ) {
    return `Unsupported TypeScript runtime option for ${startTest ? "start-test" : "create"}.`;
  }
  if (startTest && (parsed.flags.waitReady || parsed.flags.verify || !parsed.flags.initialPrompt)) {
    return "Unsupported TypeScript runtime option for start-test.";
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

function unsupportedPairOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task) {
    return `Unexpected argument: ${parsed.task}`;
  }
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
    || parsed.flags.decisionId !== null
    || parsed.flags.eventType !== null
    || parsed.flags.file !== null
    || parsed.flags.goal !== null
    || parsed.flags.includeContent
    || parsed.flags.includeFullTranscripts
    || parsed.flags.includeLegacy
    || parsed.flags.includeTranscripts
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
    || parsed.flags.stopManager
    || parsed.flags.stopWorker
    || parsed.flags.strictDecisions
    || parsed.flags.subtype !== null
    || parsed.flags.summary !== null
    || parsed.flags.terminal !== "auto"
    || parsed.flags.terminalStaleSeconds !== DEFAULT_TERMINAL_STALE_SECONDS
    || parsed.flags.text !== null
    || parsed.flags.tmuxSession !== null
    || parsed.flags.worker !== null
    || parsed.flags.zip
  ) {
    return "Unsupported TypeScript runtime option for pair.";
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
    cleanupPolicy: string | null;
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
  validateRalphLoopIterationPolicy({
    currentIteration: options.currentIteration,
    maxIterations: options.maxIterations,
  });
  for (const evidence of options.requiredBeforeContinue) {
    if (!evidence.trim()) {
      throw new Error("required_before_continue entries must be non-empty strings");
    }
  }
  const timestamp = new Date().toISOString();
  const runId = `run-${randomUUID()}`;
  const runName = options.runName ?? `${options.taskName}-ralph-loop-${timestamp.replace(/:/g, "").replace(/\./g, "-")}`;
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
  description: string;
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
    description: "Require build evidence before the manager can route another iteration, then clear worker context between iterations.",
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
    description: "Require worker completion and cleanup evidence before compacting context and continuing.",
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
    description: "Require PR URL, green CI, and merge evidence before continuing a manager-led PR loop.",
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
    description: "Repeat a test-coverage analysis/fix loop until coverage evidence is recorded or max iterations is reached.",
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
    description: "Repeat screenshot-to-HTML or UX visual-diff passes until screenshot artifacts and an acceptable diff report are recorded.",
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

function loopTemplateSummary(name: string): Record<string, unknown> {
  const template = loopTemplate(name);
  return loopTemplateSummaryFromDefinition(template);
}

function loopTemplateSummaryFromDefinition(template: LoopTemplateDefinition): Record<string, unknown> {
  return {
    artifact_requirements: structuredClone(template.artifactRequirements),
    cleanup_policy: template.cleanupPolicy,
    description: template.description,
    max_iterations: template.maxIterations,
    name: template.name,
    recommended_tools: [...template.recommendedTools],
    required_before_continue: [...template.requiredBeforeContinue],
    stop_conditions: [...template.stopConditions],
    tags: [...template.tags],
  };
}

function listLoopTemplates(): Array<Record<string, unknown>> {
  return Object.keys(LOOP_TEMPLATES).sort().map((name) => loopTemplateSummary(name));
}

function loopTemplateMetadata(
  name: string,
  options: { currentIteration: number; maxIterations: number | null; seedPromptSha256: string | null },
): Record<string, unknown> {
  return templateDisposablePolicyMetadata({
    currentIteration: options.currentIteration,
    maxIterations: options.maxIterations,
    requiredBeforeContinue: [],
    seedPromptSha256: options.seedPromptSha256,
    templateName: name,
  });
}

function ralphLoopPreset(name: string): LoopTemplateDefinition {
  const template = LOOP_TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown Ralph loop preset: ${name}; expected one of: ${Object.keys(LOOP_TEMPLATES).sort().join(", ")}`);
  }
  return template;
}

function ralphLoopPresetSummary(name: string): Record<string, unknown> {
  return loopTemplateSummaryFromDefinition(ralphLoopPreset(name));
}

function ralphLoopPresetMetadata(
  name: string,
  options: { currentIteration: number; maxIterations: number | null; seedPromptSha256: string | null },
): Record<string, unknown> {
  ralphLoopPreset(name);
  return loopTemplateMetadata(name, options);
}

interface LoopTriggerDefinition {
  acceptance: string;
  canonical_phrase: string;
  intent: string;
  name: string;
  negative_controls: string[];
  operator_actions: string[];
  pattern: RegExp;
  required_before_continue: string[];
}

interface LoopTriggerSummary {
  acceptance: string;
  canonical_phrase: string;
  intent: string;
  name: string;
  negative_controls: string[];
  operator_actions: string[];
  required_before_continue: string[];
}

const LOOP_TRIGGERS: LoopTriggerDefinition[] = [
  {
    acceptance: "Create or reuse a loop policy whose required_before_continue includes adversarial_check.",
    canonical_phrase: "Run this as an adversarially gated Ralph loop.",
    intent: "create_loop_policy",
    name: "loop-gate-trigger",
    negative_controls: [
      "Run tests before declaring this done.",
      "Be adversarial in your review, but do not create a loop.",
    ],
    operator_actions: [
      "loop-triggers --classify '<prompt>' --json",
      "loop-templates --create-run <task> --template <template> --current-iteration 1",
      "enqueue-continue-iteration <task> --loop-run <run> --requested-iteration 2",
    ],
    pattern: /\brun this as an adversarial(?:ly)? gated (?:ralph )?loop\b/,
    required_before_continue: ["adversarial_check"],
  },
  {
    acceptance: "Dispatch blocks continue_iteration before worker delivery until structured adversarial_check proof exists.",
    canonical_phrase: "Do not send the worker another iteration until adversarial proof exists.",
    intent: "gate_next_iteration",
    name: "iteration-gate-trigger",
    negative_controls: [
      "Ask the worker for another iteration.",
      "Wait for tests before sending a note.",
    ],
    operator_actions: [
      "enqueue-continue-iteration <task> --loop-run <run> --requested-iteration <next>",
      "dispatch --once --type continue_iteration",
      "loop-evidence adversarial-check <task> --loop-run <run> --iteration <previous>",
    ],
    pattern: /\b(?:do not send the worker another iteration until adversarial proof exists|require adversarial proof before (?:the worker gets another iteration|another worker iteration))\b/,
    required_before_continue: ["adversarial_check"],
  },
  {
    acceptance: "finish-task uses --require-adversarial-proof and fails closed before structured proof exists.",
    canonical_phrase: "Do not mark this done until you have tried to disprove it.",
    intent: "require_finish_adversarial_proof",
    name: "finish-gate-trigger",
    negative_controls: [
      "Summarize risks before finishing.",
      "Do not mark this done until tests pass.",
    ],
    operator_actions: [
      "finish-task <task> --require-adversarial-proof",
      "criteria <task> --satisfy <criterion> --evidence-json <structured adversarial_check>",
    ],
    pattern: /\b(?:do not mark this done until you have tried to disprove it|do not finish until you have tried to disprove it|do not let this finish until the manager has tried to disprove it)\b/,
    required_before_continue: [],
  },
  {
    acceptance: "Worker response must contain failure_mode, check, and result, then be recorded as worker_proposed adversarial_check evidence.",
    canonical_phrase: "Ask the worker to identify the strongest realistic failure mode and prove it is handled.",
    intent: "request_worker_adversarial_proof",
    name: "worker-directed-trigger",
    negative_controls: [
      "Ask the worker to summarize what changed.",
      "Ask the worker to run the tests.",
    ],
    operator_actions: [
      "session-nudge <worker> 'Reply with failure_mode, check, result'",
      "loop-evidence adversarial-check <task> --source worker_proposed",
    ],
    pattern: /\b(?:ask the worker to identify the strongest realistic failure mode and prove it is handled|before continuing, record the strongest realistic failure mode, the check, and the result)\b/,
    required_before_continue: [],
  },
  {
    acceptance: "Manager records manager_inferred criteria that require negative Dispatch/evidence checks, not only happy-path tests.",
    canonical_phrase: "Each loop must include adversarial acceptance criteria from manager to worker.",
    intent: "create_adversarial_acceptance_criteria",
    name: "acceptance-criteria-trigger",
    negative_controls: [
      "Each loop should have acceptance criteria.",
      "Ask the worker for a checklist.",
    ],
    operator_actions: [
      "criteria <task> --add --source manager_inferred --status accepted",
      "audit <task> && replay <task> && commands --task <task> --attempts",
    ],
    pattern: /\beach loop must include adversarial acceptance criteria from manager to worker\b/,
    required_before_continue: [],
  },
];

function loopTriggerSummary(trigger: LoopTriggerDefinition): LoopTriggerSummary {
  return {
    acceptance: trigger.acceptance,
    canonical_phrase: trigger.canonical_phrase,
    intent: trigger.intent,
    name: trigger.name,
    negative_controls: [...trigger.negative_controls],
    operator_actions: [...trigger.operator_actions],
    required_before_continue: [...trigger.required_before_continue],
  };
}

function listLoopTriggers(): LoopTriggerSummary[] {
  return LOOP_TRIGGERS.map(loopTriggerSummary);
}

function normalizeLoopTriggerPrompt(prompt: string): string {
  return prompt.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function classifyLoopTrigger(prompt: string): {
  guidance: string;
  matched: boolean;
  matched_trigger: LoopTriggerSummary | null;
  prompt: string;
} {
  const normalized = normalizeLoopTriggerPrompt(prompt);
  for (const trigger of LOOP_TRIGGERS) {
    if (trigger.pattern.test(normalized)) {
      return {
        guidance: "Approved loop trigger matched. Follow the operator_actions exactly and preserve the correlation receipt.",
        matched: true,
        matched_trigger: loopTriggerSummary(trigger),
        prompt,
      };
    }
  }
  return {
    guidance: "No approved loop trigger matched; treat this as ordinary manager guidance and do not create loop policy or continuation gates automatically.",
    matched: false,
    matched_trigger: null,
    prompt,
  };
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

function validateRalphLoopIterationPolicy(options: {
  currentIteration: number;
  maxIterations: number;
}): void {
  if (options.maxIterations < 1) {
    throw new Error("max_iterations must be at least 1");
  }
  if (options.currentIteration < 0) {
    throw new Error("current_iteration must be non-negative");
  }
  if (options.currentIteration > options.maxIterations) {
    throw new Error("current_iteration must not exceed max_iterations");
  }
}

function requiredBeforeContinueMetadataList(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("ralph_loop run metadata required_before_continue must be a JSON array");
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("required_before_continue entries must be non-empty strings");
    }
    result.push(item.trim());
  }
  return result;
}

function runRowSync(database: ReturnType<typeof openRuntimeDatabase>, run: string): RalphLoopRunRow {
  const exact = database.prepare(`
    select id, task_id, name, purpose, status, started_at, ended_at, metadata_json
    from runs
    where id = ?
    limit 1
  `).get(run) as {
    ended_at: string | null;
    id: string;
    metadata_json: string;
    name: string;
    purpose: string | null;
    started_at: string;
    status: "abandoned" | "active" | "failed" | "finished";
    task_id: string;
  } | undefined;
  const row = exact ?? database.prepare(`
    select id, task_id, name, purpose, status, started_at, ended_at, metadata_json
    from runs
    where name = ?
    order by started_at desc, id desc
    limit 1
  `).get(run) as {
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

function rejectLoopCreateOnlyOptions(
  parsed: ParsedRuntimeArgs,
  options: { selector: string | null; selectorFlag: string },
): TypescriptRuntimeResult | null {
  if (parsed.flags.createRun !== null) {
    return null;
  }
  const createOnlyOptions: Array<[boolean, string]> = [
    [options.selector !== null, options.selectorFlag],
    [parsed.flags.names.length > 0, "--name"],
    [parsed.flags.maxIterations !== null, "--max-iterations"],
    [parsed.flags.currentIterationProvided, "--current-iteration"],
    [parsed.flags.seedPromptSha256 !== null, "--seed-prompt-sha256"],
    [parsed.flags.path !== null, "--path"],
  ];
  const rejected = createOnlyOptions.find(([present]) => present);
  return rejected ? errorResult(`${rejected[1]} is only valid with --create-run`) : null;
}

function lastParsedName(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.names.length === 0) {
    return null;
  }
  return parsed.flags.names[parsed.flags.names.length - 1] ?? null;
}

function createLoopPolicyRunSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { metadata: Record<string, unknown>; name: string | null; taskRef: string },
): RalphLoopRunRow {
  const task = taskRowForLifecycle(database, options.taskRef);
  if (task === null) {
    throw new Error(`Unknown task: ${options.taskRef}`);
  }
  return createRalphLoopRunSync(database, {
    cleanupPolicy: typeof options.metadata.cleanup_policy === "string" ? options.metadata.cleanup_policy : null,
    currentIteration: asInteger(options.metadata.current_iteration, "current_iteration"),
    maxIterations: asInteger(options.metadata.max_iterations, "max_iterations"),
    metadata: options.metadata,
    preset: typeof options.metadata.preset === "string" ? options.metadata.preset : null,
    requiredBeforeContinue: asStringArray(options.metadata.required_before_continue),
    runName: options.name,
    seedPromptSha256: typeof options.metadata.seed_prompt_sha256 === "string" ? options.metadata.seed_prompt_sha256 : null,
    stopConditions: asStringArray(options.metadata.stop_conditions),
    taskId: task.id,
    taskName: task.name,
  });
}

function mappingRunId(mapping: Record<string, unknown>): string | null {
  for (const key of ["ralph_loop", "loop_policy"]) {
    const value = mapping[key];
    if (isPlainRecord(value) && typeof value.run_id === "string" && value.run_id) {
      return value.run_id;
    }
  }
  for (const key of ["ralph_loop_run_id", "loop_run_id", "run_id"]) {
    const value = mapping[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
}

function commandRowMatchesRun(row: { payload_json: string | null; result_json: string | null }, runId: string): boolean {
  const payload = row.payload_json ? parseJsonObject(row.payload_json) : {};
  const result = row.result_json ? parseJsonObject(row.result_json) : {};
  return mappingRunId(payload) === runId || mappingRunId(result) === runId;
}

function notificationPayloadRunId(payload: Record<string, unknown>): string | null {
  return mappingRunId(payload);
}

function notificationRowMatchesRun(row: { payload_json: string }, runId: string): boolean {
  return notificationPayloadRunId(parseJsonObject(row.payload_json)) === runId;
}

function ralphLoopRunForTaskSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { runRef: string; task: LifecycleTaskRow },
): EnqueueRalphLoopRun & { name: string; status: string } {
  const row = database.prepare(`
    select id
    from runs
    where task_id = ?
      and (id = ? or name = ?)
    order by started_at desc, id desc
    limit 1
  `).get(options.task.id, options.runRef, options.runRef) as { id: string } | undefined;
  if (!row) {
    throw new Error(`run ${JSON.stringify(options.runRef)} does not belong to task ${JSON.stringify(options.task.name)}`);
  }
  const run = runRowSync(database, row.id);
  if (run.metadata.kind !== "ralph_loop" && run.purpose !== "ralph_loop") {
    throw new Error(`Run ${JSON.stringify(options.runRef)} is not a Ralph loop run`);
  }
  const currentIteration = integerValue(run.metadata.current_iteration);
  const maxIterations = integerValue(run.metadata.max_iterations);
  if (currentIteration === null || maxIterations === null) {
    throw new Error(`Ralph loop run ${JSON.stringify(options.runRef)} is missing iteration policy`);
  }
  return {
    cleanup_policy: typeof run.metadata.cleanup_policy === "string" ? run.metadata.cleanup_policy : null,
    current_iteration: currentIteration,
    id: run.id,
    max_iterations: maxIterations,
    metadata: run.metadata,
    name: run.name,
    preset: typeof run.metadata.preset === "string" ? run.metadata.preset : null,
    required_before_continue: asStringArray(run.metadata.required_before_continue).map((item) => item.trim()).filter(Boolean),
    seed_prompt_sha256: typeof run.metadata.seed_prompt_sha256 === "string" ? run.metadata.seed_prompt_sha256 : null,
    status: run.status,
    stop_conditions: asStringArray(run.metadata.stop_conditions),
    task_id: run.task_id,
  };
}

function loopStatusSummarySync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { run: EnqueueRalphLoopRun & { name: string; status: string }; task: LifecycleTaskRow },
): Record<string, unknown> {
  const commandRows = database.prepare(`
    select id, state, payload_json, result_json
    from commands
    where task_id = ?
    order by created_at, id
  `).all(options.task.id) as Array<{
    id: string;
    payload_json: string | null;
    result_json: string | null;
    state: string;
  }>;
  const matchingCommands = commandRows.filter((row) => commandRowMatchesRun(row, options.run.id));
  const commandStates = countBy(matchingCommands.map((row) => row.state));

  const notificationRows = database.prepare(`
    select state, payload_json
    from routed_notifications
    where task_id = ?
    order by created_at, id
  `).all(options.task.id) as Array<{ payload_json: string; state: string }>;
  const matchingNotifications = notificationRows.filter((row) => notificationRowMatchesRun(row, options.run.id));
  const notificationStates = countBy(matchingNotifications.map((row) => row.state));

  let workerInbox: number;
  try {
    const binding = activeBindingForTaskSync(database, options.task.name);
    const inboxRows = database.prepare(`
      select payload_json
      from routed_notifications
      where task_id = ?
        and target_session_id = ?
        and state = 'delivered'
        and consumed_at is null
      order by created_at, id
    `).all(options.task.id, binding.worker_session_id) as Array<{ payload_json: string }>;
    workerInbox = inboxRows.filter((row) => notificationRowMatchesRun(row, options.run.id)).length;
  } catch {
    workerInbox = 0;
  }

  const criteria = acceptanceCriteriaForTaskSync(database, { taskId: options.task.id });
  const evidenceItems = criteria
    .map((criterion) => criterion.evidence)
    .filter((evidence): evidence is Record<string, unknown> => isPlainRecord(evidence) && evidence.ralph_loop_run_id === options.run.id);
  const evidenceTypes = [...new Set(evidenceItems
    .map((evidence) => evidence.evidence_type)
    .filter((value): value is string => typeof value === "string" && value.length > 0))].sort();

  const telemetryEvents = telemetryEventsForRunSync(database, { runId: options.run.id, taskId: options.task.id });
  const telemetryByType = countBy(telemetryEvents.map((event) => event.event_type));
  const failedCommandCount = commandStates.failed ?? 0;
  const failureCounts = loopFailureCountsSync(database, {
    failedCommandCount,
    runId: options.run.id,
    taskId: options.task.id,
  });
  const recommendation = failureCounts.alerts > 0
    ? "inspect_failures"
    : workerInbox > 0
      ? "worker_should_consume_inbox"
      : "ready_for_manager_review";

  return {
    commands: {
      states: sortJson(commandStates),
      total: matchingCommands.length,
    },
    evidence: {
      total: evidenceItems.length,
      types: evidenceTypes,
    },
    failures: failureCounts,
    inbox: {
      worker_unconsumed: workerInbox,
    },
    notifications: {
      delivered: notificationStates.delivered ?? 0,
      total: matchingNotifications.length,
    },
    policy: {
      cleanup_policy: options.run.cleanup_policy,
      current_iteration: options.run.current_iteration,
      max_iterations: options.run.max_iterations,
      required_before_continue: options.run.required_before_continue,
      template: typeof options.run.metadata.template === "string" ? options.run.metadata.template : options.run.preset,
    },
    recommendation,
    run: {
      id: options.run.id,
      name: options.run.name,
      status: options.run.status,
    },
    task: {
      id: options.task.id,
      name: options.task.name,
      state: options.task.state,
    },
    telemetry: {
      by_event_type: sortJson(telemetryByType),
      dispatch_inbox_consumed: telemetryByType.dispatch_inbox_consumed ?? 0,
      total: telemetryEvents.length,
    },
  };
}

function telemetryEventsForRunSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { runId: string; taskId: string },
): Array<{ event_type: string }> {
  return database.prepare(`
    select event_type
    from telemetry_events
    where task_id = ?
      and run_id = ?
    order by timestamp, id
    limit 1000
  `).all(options.taskId, options.runId) as Array<{ event_type: string }>;
}

function loopFailureCountsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { failedCommandCount: number; runId: string; taskId: string },
): {
  alerts: number;
  failed_commands: number;
  failed_cycles: number;
  ingest_errors: number;
  open_accepted_criteria: number;
  pane_capture_failures: number;
} {
  const failedCycles = database.prepare(`
    select count(distinct mc.id) as count
    from manager_cycles mc
    where mc.task_id = ?
      and mc.state = 'failed'
      and exists (
        select 1
        from manager_cycle_spans mcs
        where mcs.manager_cycle_id = mc.id
          and mcs.run_id = ?
      )
  `).get(options.taskId, options.runId) as { count: number } | undefined;
  const paneFailures = database.prepare(`
    select count(distinct mc.id) as count
    from manager_cycles mc
    where mc.task_id = ?
      and json_extract(mc.status_json, '$.pane_signal.captured') = 0
      and exists (
        select 1
        from manager_cycle_spans mcs
        where mcs.manager_cycle_id = mc.id
          and mcs.run_id = ?
      )
  `).get(options.taskId, options.runId) as { count: number } | undefined;
  const ingestEventErrors = database.prepare(`
    select count(*) as count
    from telemetry_events
    where task_id = ?
      and run_id = ?
      and (event_type like '%ingest%' or event_type = 'codex_events_ingested')
      and severity in ('warning', 'error')
  `).get(options.taskId, options.runId) as { count: number } | undefined;
  const ingestCycleErrors = database.prepare(`
    select count(distinct mc.id) as count
    from manager_cycles mc
    where mc.task_id = ?
      and mc.state = 'failed'
      and (
        mc.error like '%Ingest%'
        or json_extract(mc.status_json, '$.error_type') like '%Ingest%'
      )
      and exists (
        select 1
        from manager_cycle_spans mcs
        where mcs.manager_cycle_id = mc.id
          and mcs.run_id = ?
      )
  `).get(options.taskId, options.runId) as { count: number } | undefined;
  const openAcceptedCriteria = database.prepare(`
    select count(*) as count
    from acceptance_criteria
    where task_id = ?
      and status = 'accepted'
      and json_extract(evidence_json, '$.ralph_loop_run_id') = ?
  `).get(options.taskId, options.runId) as { count: number } | undefined;
  const counts = {
    failed_commands: options.failedCommandCount,
    failed_cycles: failedCycles?.count ?? 0,
    ingest_errors: (ingestEventErrors?.count ?? 0) + (ingestCycleErrors?.count ?? 0),
    open_accepted_criteria: openAcceptedCriteria?.count ?? 0,
    pane_capture_failures: paneFailures?.count ?? 0,
  };
  return {
    alerts: [
      counts.failed_commands,
      counts.failed_cycles,
      counts.ingest_errors,
      counts.open_accepted_criteria,
      counts.pane_capture_failures,
    ].filter((value) => value > 0).length,
    ...counts,
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function renderLoopStatusText(result: Record<string, unknown>): string {
  const task = result.task as Record<string, unknown>;
  const run = result.run as Record<string, unknown>;
  const policy = result.policy as Record<string, unknown>;
  const commands = result.commands as Record<string, unknown>;
  const notifications = result.notifications as Record<string, unknown>;
  const inbox = result.inbox as Record<string, unknown>;
  const telemetry = result.telemetry as Record<string, unknown>;
  return [
    `task: ${task.name} (${task.state})`,
    `run: ${run.name || run.id} (${run.status})`,
    `policy: ${policy.template} iteration ${policy.current_iteration}/${policy.max_iterations}`,
    `commands: ${JSON.stringify(commands.states ?? {})}`,
    `notifications: ${notifications.delivered}/${notifications.total} delivered`,
    `worker_unconsumed: ${inbox.worker_unconsumed}`,
    `dispatch_inbox_consumed: ${telemetry.dispatch_inbox_consumed}`,
    `failures: ${JSON.stringify(result.failures ?? {})}`,
    `recommendation: ${result.recommendation}`,
  ].join("\n") + "\n";
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
  options: { config: Record<string, unknown>; name: string; state?: string; timestamp: string },
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
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    options.state ?? "active",
    options.timestamp,
    options.timestamp,
  );
  const row = database.prepare("select id from workers where name = ?").get(options.name) as { id: string };
  return row.id;
}

interface LegacyCreateWorkerOptions {
  acceptTrust: boolean;
  cwd: string;
  forceOpen: boolean;
  initialPrompt: boolean;
  name: string;
  open: boolean;
  parsed: ParsedRuntimeArgs;
  reuse: boolean;
  runtimeOptions: TypescriptRuntimeOptions;
  stopAfter: boolean;
  task: string | null;
  terminal: TerminalChoice;
  verify: boolean;
  verifyTimeout: number;
  waitReady: boolean;
  waitReadyTimeout: number;
}

function createLegacyWorker(options: LegacyCreateWorkerOptions): TypescriptRuntimeResult {
  if (options.open && options.stopAfter) {
    return lifecycleWorkerErrorResult("--open cannot be combined with --stop-after");
  }
  const codexPreflight = ensureRequiredTool("codex", options.runtimeOptions);
  if (codexPreflight) {
    return codexPreflight;
  }
  validateWorkerName(options.name);
  let cwd: string;
  try {
    cwd = resolveExistingDirectory(options.cwd, "Worker cwd");
  } catch (error) {
    return lifecycleWorkerErrorResult(error instanceof Error ? error.message : String(error));
  }
  const runner = options.runtimeOptions.tmuxRunner ?? defaultTmuxRunner;
  const tmuxPreflight = ensureTmuxAvailable(runner);
  if (tmuxPreflight) {
    return tmuxPreflight;
  }
  const stateOptions = statePathOptions(options.runtimeOptions);
  const name = options.name;
  const tmuxSessionName = tmuxSession(name);
  const createdAt = nowIsoSeconds(options.runtimeOptions);

  if (existsSync(configPath(name, stateOptions)) && !options.reuse) {
    return lifecycleWorkerErrorResult(`Worker already exists: ${name}. Use --reuse to reuse its state directory.`);
  }
  if (sessionExists(name, runner)) {
    return lifecycleWorkerErrorResult(`tmux session already exists: ${tmuxSessionName}`);
  }

  const database = openRuntimeDatabase(options.parsed, options.runtimeOptions);
  try {
    const existingWorker = database.prepare("select id, tmux_session from workers where name = ?")
      .get(name) as { id: string; tmux_session: string } | undefined;
    if (existingWorker && !options.reuse) {
      return lifecycleWorkerErrorResult(
        `Worker ${name} already exists as worker id ${existingWorker.id} in tmux session ${existingWorker.tmux_session}. `
        + "Use --reuse only if continuing that worker is intentional.",
      );
    }
    if (existingWorker && existingWorker.tmux_session !== tmuxSessionName) {
      return lifecycleWorkerErrorResult(
        `Worker ${name} already exists as worker id ${existingWorker.id} in tmux session ${existingWorker.tmux_session}; `
        + `create would use ${tmuxSessionName}.`,
      );
    }

    mkdirSync(workerDir(name, stateOptions), { recursive: true });
    const identityToken = `workerctl-${randomUUID()}`;
    let config: Record<string, unknown> = {
      created_at: createdAt,
      cwd,
      identity_token: identityToken,
      name,
      startup: "launched",
      startup_reason: "worker session created",
      state_dir: workerDir(name, stateOptions),
      tmux_session: tmuxSessionName,
      tmux_target: tmuxSessionName,
    };
    writeJsonSync(configPath(name, stateOptions), config);
    const initialStatus = initialLegacyStatus(options.task, options.runtimeOptions);
    writeJsonSync(statusPath(name, stateOptions), initialStatus);
    writeFileSync(transcriptPath(name, stateOptions), "", { flag: "a" });

    const workerId = upsertWorkerSync(database, {
      config,
      name,
      state: "candidate",
      timestamp: stringOrNull(initialStatus.last_update) ?? createdAt,
    });
    insertStatusSync(database, {
      blocker: initialStatus.blocker,
      currentTask: initialStatus.current_task,
      nextAction: initialStatus.next_action,
      state: initialStatus.state,
      timestamp: stringOrNull(initialStatus.last_update) ?? createdAt,
      workerId,
    });
    insertEventSync(database, {
      payload: { cwd, name, tmux_session: tmuxSessionName },
      type: "worker_create_recorded",
      workerId,
    });
    config = { ...config, worker_id: workerId };
    writeJsonSync(configPath(name, stateOptions), config);

    const contractPath = writeLegacyWorkerContract(name, options.task, identityToken, stateOptions);
    const shellCommand = options.initialPrompt
      ? `${legacyCliPathPrefix()} codex --cd ${shellQuote(cwd)} --no-alt-screen "$(cat ${shellQuote(contractPath)})"`
      : `${legacyCliPathPrefix()} codex --cd ${shellQuote(cwd)} --no-alt-screen`;
    runTmuxCommandWithRunner(["tmux", "new-session", "-d", "-s", tmuxSessionName, shellCommand], runner);
    const tmuxPaneId = currentPaneIdWithRunner(tmuxSessionName, runner);
    config = {
      ...loadJsonSync<Record<string, unknown>>(configPath(name, stateOptions), {}),
      ...(tmuxPaneId ? { tmux_pane_id: tmuxPaneId } : {}),
    };
    writeJsonSync(configPath(name, stateOptions), config);
    upsertWorkerSync(database, {
      config,
      name,
      state: "active",
      timestamp: nowIsoSeconds(options.runtimeOptions),
    });
    database.prepare("update workers set state = 'active', updated_at = ? where id = ?")
      .run(nowIsoSeconds(options.runtimeOptions), workerId);
    insertEventSync(database, {
      payload: { tmux_pane_id: tmuxPaneId, tmux_session: tmuxSessionName },
      type: "worker_tmux_started",
      workerId,
    });
    appendCompatibilityEvent(name, "create", {
      contract_path: contractPath,
      cwd,
      initial_prompt: options.initialPrompt,
      task: options.task,
    }, stateOptions);

    let startup: Record<string, unknown> | null = null;
    if (options.waitReady) {
      startup = waitLegacyReady(name, {
        acceptTrust: options.acceptTrust,
        runtimeOptions: options.runtimeOptions,
        stateOptions,
        timeoutSeconds: options.waitReadyTimeout,
        tmuxRunner: runner,
      });
      config = {
        ...loadJsonSync<Record<string, unknown>>(configPath(name, stateOptions), {}),
        startup: startup.startup,
        startup_checked_at: nowIsoSeconds(options.runtimeOptions),
        startup_reason: startup.reason,
        startup_recommended_action: startup.recommended_action,
      };
      writeJsonSync(configPath(name, stateOptions), config);
      appendCompatibilityEvent(name, "wait_ready", startup, stateOptions);
    } else if (options.acceptTrust) {
      sendEnterToTmuxSessionWithRunner(tmuxSessionName, runner);
      appendCompatibilityEvent(name, "accept_trust", {}, stateOptions);
    }

    const lines = [
      `created ${name}`,
      `tmux session: ${tmuxSessionName}`,
      `state dir: ${workerDir(name, stateOptions)}`,
      options.initialPrompt
        ? "contract provided as initial Codex prompt"
        : "contract saved but not provided; run conveyor nudge to provide instructions",
    ];
    if (options.acceptTrust) {
      lines.push(options.waitReady && startup
        ? `trust handling: accepted=${startup.trust_accepted}`
        : "sent Enter for initial trust prompt");
    }
    if (startup) {
      lines.push(`startup: ${startup.startup} (${startup.reason})`);
      if (startup.recommended_action !== "none") {
        lines.push(`recommended action: ${startup.recommended_action}`);
      }
    }
    if (options.verify) {
      const verification = waitForLegacyStatusUpdate(name, {
        initialCurrentTask: stringOrNull(initialStatus.current_task),
        initialLastUpdate: stringOrNull(initialStatus.last_update),
        parsed: options.parsed,
        runtimeOptions: options.runtimeOptions,
        stateOptions,
        timeoutSeconds: options.verifyTimeout,
        tmuxRunner: runner,
      });
      lines.push(`verification: ${verification.ok ? "ok" : "not verified"} (${verification.reason})`);
      const status = verification.status;
      lines.push(`state: ${stringOrNull(status.state) ?? "unknown"}`);
      const currentTask = stringOrNull(status.current_task);
      if (currentTask) {
        lines.push(`current task: ${currentTask}`);
      }
    }
    lines.push("", "Attach:", `  ${attachSessionCommand(tmuxSessionName)}`, "", "Stop:", `  conveyor stop ${name}`);
    if (options.open) {
      const opened = openLegacyWorkerWindow(name, {
        force: options.forceOpen,
        parsed: options.parsed,
        runtimeOptions: options.runtimeOptions,
        stateOptions,
        terminal: options.terminal,
        tmuxRunner: runner,
      });
      lines.push("", `opened ${opened.terminal} window for ${name}`);
    }
    if (options.stopAfter) {
      if (sessionExists(name, runner)) {
        killTmuxSessionWithRunner(tmuxSessionName, runner);
        appendCompatibilityEvent(name, "stop", { killed_session: true, reason: "stop_after" }, stateOptions);
        lines.push("", `stopped ${name} (--stop-after)`);
      }
    }
    return { exitCode: 0, handled: true, stdout: `${lines.join("\n")}\n` };
  } finally {
    database.close();
  }
}

function statePathOptions(options: { cwd?: string; env?: NodeJS.ProcessEnv }): { cwd?: string; env?: NodeJS.ProcessEnv } {
  return { cwd: options.cwd, env: options.env };
}

function resolveExistingDirectory(path: string, label: string): string {
  const directory = resolve(expandUserPath(path));
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${directory}`);
  }
  return directory;
}

function expandUserPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function initialLegacyStatus(task: string | null, options: { now?: () => Date }): Record<string, unknown> {
  return {
    blocker: null,
    current_task: task ?? "Start worker Codex session.",
    last_update: nowIsoSeconds(options),
    next_action: "Wait for manager instruction or begin assigned task.",
    state: "waiting",
  };
}

function insertStatusSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    blocker: unknown;
    currentTask: unknown;
    nextAction: unknown;
    state: unknown;
    timestamp: string;
    workerId: string;
  },
): void {
  database.prepare(`
    insert into statuses(worker_id, state, current_task, next_action, blocker, created_at)
    values (?, ?, ?, ?, ?, ?)
  `).run(
    options.workerId,
    stringOrNull(options.state) ?? "unknown",
    stringOrNull(options.currentTask),
    stringOrNull(options.nextAction),
    stringOrNull(options.blocker),
    options.timestamp,
  );
}

function writeLegacyWorkerContract(
  name: string,
  task: string | null,
  identityToken: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): string {
  const path = join(workerDir(name, options), "contract.txt");
  writeFileSync(path, legacyWorkerContract(name, task, identityToken, options));
  return path;
}

function legacyWorkerContract(
  name: string,
  task: string | null,
  identityToken: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): string {
  const taskText = task ?? "Wait for a task from the manager.";
  return `You are a worker Codex session supervised by a manager Codex session.

Task:
${taskText}

Worker identity token:
${identityToken}

Keep this token unchanged. It lets workerctl verify that task-scoped manager
commands are targeting the intended worker session.

Report status whenever you start a new phase, become blocked, begin long-running
verification, or finish. Use Agent Conveyor as the primary status path:

conveyor update-status ${name} \\
  --state planning \\
  --current-task "short description" \\
  --next-action "short description"

Allowed state values:
planning, editing, running_tests, blocked, waiting, done, unknown

If you are blocked, include --blocker:

conveyor update-status ${name} \\
  --state blocked \\
  --current-task "short description" \\
  --next-action "wait for direction" \\
  --blocker "what is blocking progress"

workerctl also exports this compatibility file for existing tooling:
${statusPath(name, options)}

Dispatcher inbox:
- If this worker is registered without a tmux session, manager nudges are
  pull-required dispatcher signals. Poll for them with:

  conveyor worker-inbox <task-name> --consume-next --wait --timeout 60 --json

- Keep polling this inbox through the bounded manager loop until there are no
  items left or the loop reaches max_iterations. The manager is responsible for
  queueing only policy-approved continuation items.

- Treat a consumed inbox item as the next manager instruction, then update
  status with conveyor. Each consumed item records dispatch_inbox_consumed
  telemetry so the dispatcher-to-session handoff is auditable.

Compatibility JSON shape:
{
  "state": "planning | editing | running_tests | blocked | waiting | done",
  "current_task": "short description",
  "last_update": "ISO-8601 timestamp",
  "next_action": "short description",
  "blocker": null
}

Do not perform destructive git actions unless the user explicitly asks.
If you are blocked or need direction, set state to blocked and explain the blocker.
`;
}

function waitLegacyReady(
  name: string,
  options: {
    acceptTrust: boolean;
    runtimeOptions: TypescriptRuntimeOptions;
    stateOptions: { cwd?: string; env?: NodeJS.ProcessEnv };
    timeoutSeconds: number;
    tmuxRunner: TmuxRunner;
  },
): Record<string, unknown> {
  let trustAccepted = false;
  let lastState = "starting";
  let lastReason = "waiting for terminal output";
  const attempts = Math.max(1, options.timeoutSeconds);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!sessionExists(name, options.tmuxRunner)) {
      return {
        reason: "tmux session exited during startup",
        startup: "exited",
        trust_accepted: trustAccepted,
      };
    }
    const output = captureTmuxTargetWithRunner(tmuxSession(name), 80, options.tmuxRunner);
    const [startup, reason] = classifyStartupOutput(output);
    lastState = startup;
    lastReason = reason;
    if (lastState === "needs_trust" && options.acceptTrust && !trustAccepted) {
      sendEnterToTmuxSessionWithRunner(tmuxSession(name), options.tmuxRunner);
      trustAccepted = true;
      appendCompatibilityEvent(name, "accept_trust", {}, options.stateOptions);
      sleepWithRuntimeOptions(options.runtimeOptions, 1000);
      continue;
    }
    if (lastState === "ready" || lastState === "working" || lastState === "needs_trust" || lastState === "error") {
      break;
    }
    sleepWithRuntimeOptions(options.runtimeOptions, 1000);
  }
  return {
    reason: lastReason,
    recommended_action: lastState === "needs_trust" && !options.acceptTrust
      ? "rerun with --accept-trust if this directory is trusted"
      : lastState === "starting"
        ? "inspect terminal capture"
        : "none",
    startup: lastState,
    timeout_seconds: options.timeoutSeconds,
    trust_accepted: trustAccepted,
  };
}

function waitForLegacyStatusUpdate(
  name: string,
  options: {
    initialCurrentTask: string | null;
    initialLastUpdate: string | null;
    parsed: ParsedRuntimeArgs;
    runtimeOptions: TypescriptRuntimeOptions;
    stateOptions: { cwd?: string; env?: NodeJS.ProcessEnv };
    timeoutSeconds: number;
    tmuxRunner: TmuxRunner;
  },
): { ok: boolean; reason: string; status: Record<string, unknown> } {
  let lastStatus = loadJsonSync<Record<string, unknown>>(statusPath(name, options.stateOptions), {});
  const attempts = Math.max(1, options.timeoutSeconds);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastStatus = loadJsonSync<Record<string, unknown>>(statusPath(name, options.stateOptions), {});
    if (
      lastStatus.last_update !== options.initialLastUpdate
      || lastStatus.current_task !== options.initialCurrentTask
      || ["planning", "editing", "running_tests", "blocked", "done"].includes(stringOrNull(lastStatus.state) ?? "")
    ) {
      appendCompatibilityEvent(name, "verify", {
        ok: true,
        reason: "status update observed",
        state: lastStatus.state,
      }, options.stateOptions);
      return { ok: true, reason: "status update observed", status: lastStatus };
    }
    if (sessionExists(name, options.tmuxRunner)) {
      try {
        captureTmuxTargetWithRunner(tmuxSession(name), 80, options.tmuxRunner);
      } catch (error) {
        appendCompatibilityEvent(name, "capture_failed", {
          error: error instanceof Error ? error.message : String(error),
          phase: "wait_for_status_update",
        }, options.stateOptions);
      }
    }
    sleepWithRuntimeOptions(options.runtimeOptions, 1000);
  }
  appendCompatibilityEvent(name, "verify", {
    ok: false,
    reason: "timed out waiting for status update",
    timeout_seconds: options.timeoutSeconds,
  }, options.stateOptions);
  return { ok: false, reason: "timed out waiting for status update", status: lastStatus };
}

function openLegacyWorkerWindow(
  name: string,
  options: {
    force: boolean;
    parsed: ParsedRuntimeArgs;
    runtimeOptions: TypescriptRuntimeOptions;
    stateOptions: { cwd?: string; env?: NodeJS.ProcessEnv };
    terminal: TerminalChoice;
    tmuxRunner: TmuxRunner;
  },
): { terminal: Exclude<TerminalChoice, "auto"> } {
  if ((options.runtimeOptions.platform ?? process.platform) !== "darwin") {
    throw new Error("conveyor open is currently implemented for macOS only.");
  }
  if (!sessionExists(name, options.tmuxRunner)) {
    throw new Error(`tmux session is not running for worker ${name}: ${tmuxSession(name)}`);
  }
  const priorOpen = lastOpenCompatibilityEvent(name, options.stateOptions);
  if (priorOpen && !options.force) {
    const time = typeof priorOpen.time === "string" ? priorOpen.time : "unknown time";
    throw new Error(`Worker ${name} already had a terminal launch at ${time}.`);
  }
  const terminal = resolveTerminal(options.terminal);
  appendCompatibilityEvent(name, "open_attempt", { forced: options.force, terminal }, options.stateOptions);
  runTerminalCommand(terminalOpenCommand(tmuxSession(name), terminal), options.runtimeOptions);
  appendCompatibilityEvent(name, "open", { forced: options.force, terminal }, options.stateOptions);
  return { terminal };
}

function legacyCliPathPrefix(): string {
  return `PATH=${shellQuote(join(packageRootFromRuntimeModule(), "bin"))}:$PATH`;
}

function sleepWithRuntimeOptions(options: { sleepMilliseconds?: (milliseconds: number) => void }, milliseconds: number): void {
  (options.sleepMilliseconds ?? sleepSync)(milliseconds);
}

function workerctlCli(): string {
  const conveyor = join(packageRootFromRuntimeModule(), "bin", "conveyor");
  return existsSync(conveyor) ? shellQuote(conveyor) : "conveyor";
}

function codexArgSuffix(codexArgs: string[]): string {
  return codexArgs.length === 0 ? "" : ` -- ${codexArgs.map(shellQuote).join(" ")}`;
}

function legacyRawWorkerStartPrompt(sessionName: string, cwd: string, managerCodexArgs: string[]): string {
  const workerctl = workerctlCli();
  const managerSuffix = codexArgSuffix(managerCodexArgs);
  return `You are a raw worker candidate running inside Agent Conveyor tmux session ${sessionName}.

Current working directory: ${cwd}

You are not registered as a worker yet.

The supported manager/worker setup is session-based:

1. Register this session as a worker after identifying the Codex process pid and
   rollout JSONL:

   ${workerctl} register-worker --name <worker-name> --pid <pid> --codex-session <rollout.jsonl> --cwd ${shellQuote(cwd)} --tmux-session ${sessionName}

2. Create or select a task:

   ${workerctl} tasks --create <task-name> --goal "<goal>"

3. Start a manager:

   ${workerctl} start-manager --name <manager-name> --cwd ${shellQuote(cwd)}${managerSuffix}

4. Bind the sessions:

   ${workerctl} bind --task <task-name> --worker <worker-name> --manager <manager-name>

5. Configure manager supervision:

   ${workerctl} manager-config <task-name> --questions

6. After the task is bound and before editing files for the task, record your
   acknowledgement:

   ${workerctl} worker-ack <task-name> --from-stdin

   The JSON should include goal_restatement, proposed_criteria,
   expected_tools, open_questions, and ready_to_start. Proposed criteria should
   separate must-have and follow-up criteria.

Required fields:
- worker name
- manager name
- task name
- goal

If any required field is missing, ask the user for it. Do not invent worker
name, manager name, task name, or goal values unless the user explicitly asks
you to choose them.

If the user asks to see the manager or worker terminal for your task, run:

${workerctl} open-manager <task-name>
${workerctl} open-worker <task-name>
`;
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

function ensureRequiredTool(name: string, options: TypescriptRuntimeOptions): TypescriptRuntimeResult | null {
  if (options.codexCommandResolver) {
    return options.codexCommandResolver(name) ? null : lifecycleWorkerErrorResult(`Required tool not found on PATH: ${name}`);
  }
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(name)}`], {
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error || result.status !== 0) {
    return lifecycleWorkerErrorResult(`Required tool not found on PATH: ${name}`);
  }
  return null;
}

function ensureTmuxAvailable(runner: TmuxRunner): TypescriptRuntimeResult | null {
  const result = runner(["tmux", "-V"], { check: false });
  if (result.status === 0) {
    return null;
  }
  if (result.status === 127) {
    return lifecycleWorkerErrorResult("Required tool not found on PATH: tmux");
  }
  const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
  return lifecycleWorkerErrorResult(tmuxCommandFailureMessage(["tmux", "-V"], detail));
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
