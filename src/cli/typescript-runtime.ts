import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { taskAuditSync } from "../runtime/audit.js";
import {
  appAutopilotPlanSync,
  appLoopStatusSync,
  appWakeupDispatchPlanSync,
  appWakeupPlanSync,
  directInboxPollCommand,
  visibleSessionProtocolLines,
  type AppAutopilotDesiredState,
  type AppAutopilotPlan,
  type AppWakeupDispatchPlan,
  type AppLoopRole,
  type AppLoopStatus,
} from "../runtime/app-autonomy.js";
import { classifyBusyWait, classifyStartupOutput } from "../runtime/classify.js";
import {
  addCampaignWorkerSlotSync,
  campaignDashboardSync,
  campaignStatusSync,
  createCampaignAssignmentSync,
  createCampaignSync,
  recordCampaignAssetReceiptSync,
  updateCampaignWorkerSlotLifecycleSync,
  upsertCampaignChannelBriefSync,
  type CampaignAssignmentStatus,
  type CampaignAssetStatus,
  type CampaignAssetType,
  type CampaignDashboardRecord,
  type CampaignWorkerSlotState,
} from "../runtime/campaigns.js";
import { exportTaskSync } from "../runtime/export.js";
import { ingestSessionSync } from "../runtime/ingest.js";
import {
  acceptanceCriteriaForTaskSync,
  loopEvidenceCriterion,
  recordAdversarialLoopEvidenceSync,
  recordLoopEvidenceSync,
  recordVisualDiffLoopEvidenceSync,
  type AcceptanceCriterionRecord,
  type AcceptanceCriterionSource,
  type AcceptanceCriterionStatus,
} from "../runtime/loop-evidence.js";
import { writePngRgba } from "../runtime/visual-diff.js";
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
import { managerConfigPermissionAllowed, managerConfigSync, type ManagerConfigRecord } from "../runtime/manager-config.js";
import {
  canonicalManagerPermissionNames,
  flattenManagerPermissions,
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
  consumeNextSessionInboxItemSync,
  routedNotificationsSync,
  sessionInboxSync,
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
  databaseHealthSync,
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
const DEFAULT_INTERRUPT_FOLLOWUP = "Please pause and update status.json with what was interrupted, whether you are blocked, and the next safe action.";
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
  program?: "conveyor" | "workerctl";
  sleepMilliseconds?: (milliseconds: number) => void;
  stdin?: string;
  terminalRunner?: (args: string[]) => { status: number; stderr?: string; stdout?: string };
  tmuxRunner?: TmuxRunner;
};

export function runTypescriptRuntimeCommand(options: TypescriptRuntimeOptions): TypescriptRuntimeResult {
  const parsed = parseRuntimeArgs(options.args, options.env ?? process.env);
  const program = options.program ?? "conveyor";
  if (!parsed.command || isHelpArg(parsed.command)) {
    return textResult([
      `usage: ${program} [-h] <command> ...`,
      "",
      "Agent Conveyor control plane.",
    ]);
  }
  const defaultRuntime = !parsed.enabled && isDefaultRuntimeCommand(parsed.command);
  if (defaultRuntime) {
    parsed.enabled = true;
    parsed.defaultRuntime = true;
  }
  if (!parsed.enabled) {
    return errorResult(`unknown command: ${parsed.command}`);
  }
  if (parsed.flags.help) {
    return textResult(commandHelpText(program, parsed.command));
  }
  if (parsed.error) {
    return errorResult(parsed.error);
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
    if (parsed.command === "manager-recipes") {
      return runManagerRecipesCommand(parsed);
    }
    if (parsed.command === "loop-triggers") {
      return runLoopTriggersCommand(parsed, options);
    }
    if (parsed.command === "loop-status") {
      return runLoopStatusCommand(parsed, options);
    }
    if (parsed.command === "app-heartbeat") {
      return runAppHeartbeatCommand(parsed, options);
    }
    if (parsed.command === "app-loop-status") {
      return runAppLoopStatusCommand(parsed, options);
    }
    if (parsed.command === "app-wakeup-plan") {
      return runAppWakeupPlanCommand(parsed, options);
    }
    if (parsed.command === "app-wakeup-dispatch") {
      return runAppWakeupDispatchCommand(parsed, options);
    }
    if (parsed.command === "app-wakeup-record-delivery") {
      return runAppWakeupRecordDeliveryCommand(parsed, options);
    }
    if (parsed.command === "app-worker-rotation-plan") {
      return runAppWorkerRotationPlanCommand(parsed, options);
    }
    if (parsed.command === "app-worker-rotation-record") {
      return runAppWorkerRotationRecordCommand(parsed, options);
    }
    if (parsed.command === "app-autopilot") {
      return runAppAutopilotCommand(parsed, options);
    }
    if (parsed.command === "qa-plan") {
      return runQaPlanCommand(parsed);
    }
    if (parsed.command === "qa-run") {
      return runQaRunCommand(parsed, options);
    }
    if (parsed.command === "tasks") {
      return runTasksCommand(parsed, options);
    }
    if (parsed.command === "campaign") {
      return runCampaignCommand(parsed, options);
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
    if (parsed.command === "dashboard") {
      return runDashboardCommand(parsed, options);
    }
    if (parsed.command === "install-skills") {
      return runInstallSkillsCommand(parsed, options);
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
    if (parsed.command === "list") {
      return runLegacyListCommand(parsed, options);
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
    if (parsed.command === "interrupt") {
      return runLegacyInterruptCommand(parsed, options);
    }
    if (parsed.command === "nudge") {
      return runLegacyNudgeCommand(parsed, options);
    }
    if (parsed.command === "worker-ack") {
      return runTaskAckCommand(parsed, options, "worker");
    }
    if (parsed.command === "manager-ack") {
      return runTaskAckCommand(parsed, options, "manager");
    }
    if (parsed.command === "session-inbox") {
      return runSessionInboxCommand(parsed, options, "session");
    }
    if (parsed.command === "manager-inbox") {
      return runSessionInboxCommand(parsed, options, "manager");
    }
    if (parsed.command === "worker-inbox") {
      return runSessionInboxCommand(parsed, options, "worker");
    }
    if (parsed.command === "session-nudge") {
      return runSessionNudgeCommand(parsed, options);
    }
    if (parsed.command === "session-interrupt") {
      return runSessionInterruptCommand(parsed, options);
    }
    if (parsed.command === "cycle") {
      return runCycleCommand(parsed, options);
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
    if (parsed.command === "manager-config") {
      return runManagerConfigCommand(parsed, options);
    }
    if (parsed.command === "manager-permission") {
      return runManagerPermissionCommand(parsed, options);
    }
    if (parsed.command === "record-decision") {
      return runRecordDecisionCommand(parsed, options);
    }
    if (parsed.command === "continuation") {
      return runContinuationCommand(parsed, options);
    }
    if (parsed.command === "continuation-reviewer") {
      return runContinuationReviewerCommand(parsed, options);
    }
    if (parsed.command === "handoff") {
      return runHandoffCommand(parsed, options);
    }
    if (parsed.command === "epilogue") {
      return runEpilogueCommand(parsed, options);
    }
    if (parsed.command === "request-worker-compact") {
      return runRequestWorkerCompactCommand(parsed, options);
    }
    if (parsed.command === "compact-worker") {
      return runCompactWorkerCommand(parsed, options);
    }
    if (parsed.command === "import-compat") {
      return runImportCompatCommand(parsed, options);
    }
    if (parsed.command === "db-doctor") {
      return runDbDoctorCommand(parsed, options);
    }
    if (parsed.command === "doctor") {
      return runDoctorCommand(parsed, options);
    }
    if (parsed.command === "doctor-self") {
      return runDoctorSelfCommand(parsed, options);
    }
    if (parsed.command === "reconcile") {
      return runReconcileCommand(parsed, options);
    }
    if (parsed.command === "divergences") {
      return runDivergencesCommand(parsed, options);
    }
    if (parsed.command === "prune") {
      return runPruneCommand(parsed, options);
    }
    if (parsed.command === "mutation-audit") {
      return runMutationAuditCommand(parsed, options);
    }
    if (parsed.command === "telemetry") {
      return runTelemetryCommand(parsed, options);
    }
    if (parsed.explicit) {
      return errorResult(`Unsupported TypeScript runtime command: ${parsed.command}`);
    }
    return errorResult(`unsupported command: ${parsed.command}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function commandHelpText(program: "conveyor" | "workerctl", command: string): string[] {
  const path = "[--path <workerctl.db>]";
  const linesByCommand: Record<string, string[]> = {
    criteria: [
      `usage: ${program} criteria <task> [--list|--add --criterion <text> --source <source>|--accept ID|--satisfy ID|--defer ID|--reject ID] ${path} [--json]`,
      "",
      "Examples:",
      `  ${program} criteria my-task --list --json --path /tmp/work/workerctl.db`,
      `  ${program} criteria my-task --add --criterion "Note file exists" --source manager_inferred --status accepted --path /tmp/work/workerctl.db`,
      `  ${program} criteria my-task --satisfy 1 --proof "File exists" --evidence-json '{"artifact":{"path":"docs/note.md"}}' --path /tmp/work/workerctl.db`,
    ],
    "finish-task": [
      `usage: ${program} finish-task <task> --reason <reason> [--require-criteria-audit] ${path} [--json]`,
      "",
      "Examples:",
      `  ${program} finish-task my-task --reason "Accepted criteria satisfied" --require-criteria-audit --path /tmp/work/workerctl.db --json`,
    ],
    campaign: [
      `usage: ${program} campaign <${campaignActionsUsage()}> --name <campaign> [options] ${path} [--json]`,
      "",
      `Supported subcommands: ${campaignActionsUsage()}`,
      "",
      "Use `dashboard` to list campaign assets and slot receipt counts; there is no separate `assets` subcommand.",
      "",
      "Examples:",
      `  ${program} campaign create --name launch --objective "Create launch assets" --metadata-json '{"owner":"ops"}' --json`,
      `  ${program} campaign add-slot --name launch --slot-key tiktok --role-label "TikTok worker" --channel tiktok --thread-id thread-1 --state active --json`,
      `  ${program} campaign attach-slot --name launch --slot campaign-slot-id --session-id session-worker --thread-id thread-1 --state active --json`,
      `  ${program} campaign rotate-slot --name launch --slot campaign-slot-id --expected-thread-id thread-1 --thread-id thread-2 --thread-title "TikTok Worker 2" --json`,
      `  ${program} campaign archive-slot --name launch --slot campaign-slot-id --expected-thread-id thread-2 --json`,
      `  ${program} campaign brief --name launch --channel tiktok --brief-json '{"format":"9:16"}' --json`,
      `  ${program} campaign assign --name launch --slot campaign-slot-id --title "Draft hooks" --instructions "Create hooks" --status active --json`,
      `  ${program} campaign asset --name launch --slot campaign-slot-id --assignment campaign-assignment-id --asset-type copy --title "Hooks v1" --status needs_review --json`,
      `  ${program} campaign asset --name launch --slot campaign-slot-id --assignment campaign-assignment-id --asset-type copy --title "Hooks v2" --allow-additional-receipt --json`,
      `  ${program} campaign status --name launch --json`,
      `  ${program} campaign dashboard --name launch --json`,
      `  ${program} campaign closeout --name launch --failure-mode "hidden duplicate receipt" --json`,
    ],
    "manager-ack": [
      `usage: ${program} manager-ack <task> --from-stdin ${path}`,
      `usage: ${program} manager-ack <task> --json ${path}`,
      "",
      "Example JSON:",
      `  {"task":"my-task","manager_session":"mgr","supervision_contract":"I will supervise through Conveyor and verify criteria before finishing.","will_not_edit_project_files":true}`,
    ],
    nudge: [
      `usage: ${program} nudge <worker-or-session> <message> ${path} [--dry-run]`,
      `usage: ${program} session-nudge <session> <message> ${path} [--dry-run]`,
      "",
      "For task-routed delivery, prefer enqueue-nudge-worker plus dispatch:",
      `  ${program} enqueue-nudge-worker my-task --message "Status and evidence?" --path /tmp/work/workerctl.db`,
      `  ${program} dispatch --once --type nudge_worker --path /tmp/work/workerctl.db`,
    ],
    "app-autopilot": [
      `usage: ${program} app-autopilot start|stop|status <task> [--dispatcher-id ID] [--interval SECONDS] [--watch-iterations N] [--stale-after N] [--quiet-after N] ${path} [--json]`,
      "",
      "Manage the app-native heartbeat policy for a bound manager/worker pair.",
      "The CLI records policy receipts and emits Codex app heartbeat automation specs; app-thread automation creation still happens through Codex app tools.",
      "",
      "Examples:",
      `  ${program} app-autopilot start dogfood --dispatcher-id dispatch-local --path /tmp/work/workerctl.db --json`,
      `  ${program} app-autopilot status dogfood --path /tmp/work/workerctl.db`,
      `  ${program} app-autopilot stop dogfood --path /tmp/work/workerctl.db --json`,
    ],
    "app-worker-rotation-plan": [
      `usage: ${program} app-worker-rotation-plan <task> --old-worker-thread-id ID [--require-handoff] [--reason TEXT] ${path} [--json]`,
      "",
      "Emit Codex app actions for replacing a worker thread with a fresh thread.",
      "The plan fails closed unless the old thread id exactly matches the active bound worker session; it never authorizes archiving a manager or unrelated thread.",
      "",
      "Examples:",
      `  ${program} app-worker-rotation-plan dogfood --old-worker-thread-id thread-old --require-handoff --path /tmp/work/workerctl.db --json`,
    ],
    "app-worker-rotation-record": [
      `usage: ${program} app-worker-rotation-record <task> --old-worker-thread-id OLD --new-worker-thread-id NEW [--new-worker-thread-title TITLE] --archive-status archived|blocked [--reason TEXT] ${path} [--json]`,
      "",
      "Record the Codex app worker-thread rotation after the app layer creates the new worker thread and archives or blocks on the old one.",
      "The command re-checks active binding ownership before updating the worker session to the new thread id.",
    ],
    pair: [
      `usage: ${program} pair --task <task> --worker-name <worker> --manager-name <manager> [options] ${path}`,
      "",
      "Options:",
      "  --task-goal <text>             Task goal stored in Conveyor state.",
      "  --task-prompt <text>           Initial worker prompt; defaults to task goal when omitted.",
      "  --manager-recipe <recipe>      Seed a manager recipe, for example goalbuddy-conveyor.",
      "  --manager-acceptance <text>    Seed an accepted manager criterion; repeat for multiple criteria.",
      "  --manager-tool <tool>          Seed an expected manager/worker tool; repeat for multiple tools.",
      "  --manager-reference <path>     Seed a manager reference path; repeat for multiple references.",
      "  --manager-question <text>      Seed a manager setup question; repeat for multiple questions.",
      "  --manager-guideline <text>     Seed a manager guideline; repeat for multiple guidelines.",
      "  --cwd <dir>                    Working directory for both Codex sessions.",
      "  --accept-trust                 Auto-accept the Codex trust prompt for the chosen cwd.",
      "  --no-dispatch                  Do not start Dispatch after launching the pair.",
      "  --dry-run                      Print the launch plan without creating sessions.",
      "  --json                         Emit JSON output.",
      "",
      "Examples:",
      `  ${program} pair --task dogfood --worker-name dogfood-worker --manager-name dogfood-manager --task-goal "Create docs/note.md" --task-prompt "Create docs/note.md" --manager-recipe goalbuddy-conveyor --manager-acceptance "docs/note.md exists" --cwd /tmp/work --path /tmp/work/workerctl.db --accept-trust`,
      `  ${program} pair --task dogfood --worker-name dogfood-worker --manager-name dogfood-manager --path /tmp/work/workerctl.db --dry-run --json`,
    ],
    "worker-ack": [
      `usage: ${program} worker-ack <task> --from-stdin ${path}`,
      `usage: ${program} worker-ack <task> --json ${path}`,
      "",
      "Example JSON:",
      `  {"goal_restatement":"Create docs/dogfood-note.md","proposed_criteria":{"must_have":["note file exists"],"follow_up":[]},"expected_tools":["shell"],"open_questions":[],"ready_to_start":true}`,
    ],
  };
  return linesByCommand[command] ?? [`usage: ${program} ${command} [-h] [options]`];
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
    allowAdditionalReceipt: boolean;
    action: string | null;
    artifactPath: string | null;
    assetType: string | null;
    assignment: string | null;
    asRole: "all" | "manager" | "reviewer" | "worker";
    attempts: boolean;
    briefJson: string | null;
    json: boolean;
    activeOnly: boolean;
    actor: string | null;
    includeLegacy: boolean;
    help: boolean;
    redactIdentityToken: boolean;
    appStaleAfterSeconds: number;
    active: boolean;
    add: boolean;
    apply: boolean;
    blocker: string | null;
    busyWaitSeconds: number;
    candidate: string | null;
    campaignName: string | null;
    check: string | null;
    channel: string | null;
    classifyPrompt: string | null;
    workerCodexAppThreadId: string | null;
    workerCodexAppThreadTitle: string | null;
    managerCodexAppThreadId: string | null;
    managerCodexAppThreadTitle: string | null;
    codexSession: string | null;
    create: string | null;
    createRun: string | null;
    criterion: string | null;
    codexHome: string | null;
    cycleId: number | null;
    currentTask: string | null;
    currentIteration: number;
    currentIterationProvided: boolean;
    compatibilityRoot: string | null;
    cwd: string | null;
    deferCriterion: number | null;
    decision: string | null;
    diffOutput: string | null;
    dryRun: boolean;
    evidenceJson: string | null;
    evidenceType: string | null;
    epilogueStatus: boolean;
    epilogueStep: string | null;
    eventType: string | null;
    expectedThreadId: string | null;
    file: string | null;
    finishRun: string | null;
    fromText: string | null;
    fromWorkerResponse: string | null;
    fromStdin: boolean;
    failureMode: string | null;
    goal: string | null;
    instructions: string | null;
    keepLatest: number;
    key: string;
    list: boolean;
    lines: number;
    limit: number | null;
    live: boolean;
    metadataJson: string | null;
    names: string[];
    nextAction: string | null;
    noFollowup: boolean;
    nextSteps: string[];
    output: string | null;
    path: string | null;
    pid: number | null;
    port: number;
    preset: string | null;
    role: ReplayRole;
    roleProvided: boolean;
    refresh: boolean;
    reference: string | null;
    rejectCriterion: number | null;
    reportOutput: string | null;
    require: boolean;
    requireHandoff: boolean;
    result: string | null;
    reviewNotes: string | null;
    roleLabel: string | null;
    review: boolean;
    sessionId: string | null;
    sessionRole: "manager" | "worker" | null;
    sessionState: "active" | "all" | "gone" | null;
    show: string | null;
    showRun: string | null;
    satisfyCriterion: number | null;
    statusAgeSeconds: number;
    statusState: string | null;
    statuses: string[];
    statusStaleSeconds: number;
    submitRole: "manager" | "worker" | null;
    slot: string | null;
    slotKey: string | null;
    subtype: string | null;
    summary: string | null;
    source: string | null;
    objective: string | null;
    promptSummary: string | null;
    proof: string | null;
    purpose: string | null;
    quietAfterCycles: number;
    questions: boolean;
    rationale: string | null;
    receiptOutput: string | null;
    taskName: string | null;
    host: string;
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
    maxOpenCriteria: number;
    maxStorageBytes: number | null;
    maxUnfinishedCommands: number;
    managerStaleSeconds: number;
    workerctlPath: string;
    newest: boolean;
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
    deliveryStatus: string | null;
    dispatchReceipt: string | null;
    force: boolean;
    message: string | null;
    newWorkerThreadId: string | null;
    newWorkerThreadTitle: string | null;
    oldWorkerThreadId: string | null;
    reason: string | null;
    threadId: string | null;
    threadTitle: string | null;
    title: string | null;
    archiveStatus: string | null;
    consumeNext: boolean;
    wait: boolean;
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
    managerRecipe: string | null;
    managerReference: string[];
    managerRequireAcks: boolean;
    managerTool: string[];
    promptOnly: boolean;
    reviewerManagerSessionId: string | null;
    reviewerCommand: string[];
    reviewerSessionId: string | null;
    noDispatch: boolean;
    once: boolean;
    requiredPermission: string | null;
    requestedIteration: number | null;
    taskPrompt: string | null;
    taskSummary: string | null;
    telemetrySummary: boolean;
    telemetryView: string | null;
    telemetryViewTask: string | null;
    workerName: string | null;
    search: string | null;
    severity: string | null;
    staleCycleSeconds: number;
    window: string | null;
    workerStalenessSeconds: number;
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

const CAMPAIGN_ACTION_NAMES = ["create", "add-slot", "attach-slot", "rotate-slot", "archive-slot", "brief", "assign", "asset", "status", "dashboard", "closeout"] as const;
const CAMPAIGN_ACTIONS = new Set<string>(CAMPAIGN_ACTION_NAMES);
const CAMPAIGN_STRING_FLAGS: Record<string, RuntimeFlagKey> = {
  "--artifact-path": "artifactPath",
  "--asset-type": "assetType",
  "--assignment": "assignment",
  "--brief-json": "briefJson",
  "--channel": "channel",
  "--expected-thread-id": "expectedThreadId",
  "--failure-mode": "failureMode",
  "--instructions": "instructions",
  "--objective": "objective",
  "--prompt-summary": "promptSummary",
  "--review-notes": "reviewNotes",
  "--role-label": "roleLabel",
  "--session-id": "sessionId",
  "--slot": "slot",
  "--slot-key": "slotKey",
  "--thread-id": "threadId",
  "--thread-title": "threadTitle",
  "--title": "title",
};

function parseRuntimeArgs(args: readonly string[], env: NodeJS.ProcessEnv): ParsedRuntimeArgs {
  const flags: ParsedRuntimeArgs["flags"] = {
    format: "timeline",
    includeContent: false,
    includeFullTranscripts: false,
    includeTranscripts: false,
    all: false,
    allowAdditionalReceipt: false,
    action: null,
    artifactPath: null,
    assetType: null,
    assignment: null,
    asRole: "all",
    attempts: false,
    briefJson: null,
    json: false,
    activeOnly: false,
    actor: null,
    includeLegacy: false,
    help: false,
    redactIdentityToken: false,
    appStaleAfterSeconds: 180,
    active: false,
    add: false,
    apply: false,
    blocker: null,
    busyWaitSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    candidate: null,
    campaignName: null,
    check: null,
    channel: null,
    classifyPrompt: null,
    workerCodexAppThreadId: null,
    workerCodexAppThreadTitle: null,
    managerCodexAppThreadId: null,
    managerCodexAppThreadTitle: null,
    codexSession: null,
    create: null,
    createRun: null,
    criterion: null,
    codexHome: null,
    cycleId: null,
    currentTask: null,
    currentIteration: 1,
    currentIterationProvided: false,
    compatibilityRoot: null,
    cwd: null,
    deferCriterion: null,
    decision: null,
    diffOutput: null,
    dryRun: false,
    evidenceJson: null,
    evidenceType: null,
    epilogueStatus: false,
    epilogueStep: null,
    eventType: null,
    expectedThreadId: null,
    failureMode: null,
    file: null,
    finishRun: null,
    fromStdin: false,
    fromText: null,
    fromWorkerResponse: null,
    goal: null,
    instructions: null,
    keepLatest: 20,
    key: "C-c",
    list: false,
    lines: DEFAULT_HISTORY_LINES,
    limit: null,
    live: false,
    metadataJson: null,
    names: [],
    nextAction: null,
    noFollowup: false,
    nextSteps: [],
    output: null,
    path: null,
    pid: null,
    port: 8797,
    preset: null,
    role: "all",
    roleProvided: false,
    refresh: true,
    reference: null,
    rejectCriterion: null,
    reportOutput: null,
    require: false,
    requireHandoff: false,
    result: null,
    reviewNotes: null,
    roleLabel: null,
    review: false,
    sessionId: null,
    sessionRole: null,
    sessionState: null,
    show: null,
    showRun: null,
    satisfyCriterion: null,
    statusAgeSeconds: DEFAULT_BUSY_WAIT_SECONDS,
    statusState: null,
    statuses: [],
    statusStaleSeconds: DEFAULT_STATUS_STALE_SECONDS,
    submitRole: null,
    slot: null,
    slotKey: null,
    subtype: null,
    summary: null,
    source: null,
    objective: null,
    promptSummary: null,
    proof: null,
    purpose: null,
    quietAfterCycles: 3,
    questions: false,
    rationale: null,
    receiptOutput: null,
    taskName: null,
    host: "127.0.0.1",
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
    maxOpenCriteria: 0,
    maxStorageBytes: null,
    maxUnfinishedCommands: 0,
    managerStaleSeconds: DEFAULT_STATUS_STALE_SECONDS,
    workerctlPath: "conveyor",
    newest: false,
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
    deliveryStatus: null,
    dispatchReceipt: null,
    force: false,
    message: null,
    newWorkerThreadId: null,
    newWorkerThreadTitle: null,
    oldWorkerThreadId: null,
    reason: null,
    threadId: null,
    threadTitle: null,
    title: null,
    archiveStatus: null,
    consumeNext: false,
    wait: false,
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
    managerRecipe: null,
    managerReference: [],
    managerRequireAcks: false,
    managerTool: [],
    promptOnly: false,
    reviewerManagerSessionId: null,
    reviewerCommand: [],
    reviewerSessionId: null,
    noDispatch: false,
    once: false,
    requiredPermission: null,
    requestedIteration: null,
    taskPrompt: null,
    taskSummary: null,
    telemetrySummary: false,
    telemetryView: null,
    telemetryViewTask: null,
    workerName: null,
    search: null,
    severity: null,
    staleCycleSeconds: 3600.0,
    window: null,
    workerStalenessSeconds: 3600.0,
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
  if (command === "dashboard") {
    flags.dispatcherId = "dispatch-dashboard";
  }
  if (command === "session-inbox" || command === "manager-inbox" || command === "worker-inbox") {
    flags.timeoutSeconds = 30;
  }
  let task: string | null = null;
  for (let index = 0; index < queue.length; index += 1) {
    const arg = queue[index];
    if (command === "start" && isHelpArg(arg)) {
      flags.help = true;
      continue;
    }
    if (isHelpArg(arg)) {
      flags.help = true;
      continue;
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
    } else if (arg === "--allow-additional-receipt") {
      if (command !== "campaign") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --allow-additional-receipt", explicit, flags, passthroughArgs, task };
      }
      flags.allowAdditionalReceipt = true;
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
        && command !== "manager-recipes"
        && command !== "loop-triggers"
        && command !== "manager-permission"
        && command !== "continuation"
        && command !== "epilogue"
      ) {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --list", explicit, flags, passthroughArgs, task };
      }
      flags.list = true;
    } else if (arg === "--live") {
      if (command !== "db-doctor") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --live", explicit, flags, passthroughArgs, task };
      }
      flags.live = true;
    } else if (arg === "--include-payload") {
      if (command !== "continuation") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --include-payload", explicit, flags, passthroughArgs, task };
      }
      flags.includeContent = true;
    } else if (arg === "--questions") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --questions", explicit, flags, passthroughArgs, task };
      }
      flags.questions = true;
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
    } else if (arg === "--ensure-dispatch") {
      if (command !== "dashboard") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --ensure-dispatch", explicit, flags, passthroughArgs, task };
      }
      flags.require = true;
    } else if (arg === "--no-followup") {
      if (command !== "interrupt") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --no-followup", explicit, flags, passthroughArgs, task };
      }
      flags.noFollowup = true;
    } else if (arg === "--apply") {
      if (command !== "import-compat" && command !== "reconcile") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --apply", explicit, flags, passthroughArgs, task };
      }
      flags.apply = true;
    } else if (arg === "--active-only") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --active-only", explicit, flags, passthroughArgs, task };
      }
      flags.activeOnly = true;
    } else if (arg === "--newest") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --newest", explicit, flags, passthroughArgs, task };
      }
      flags.newest = true;
    } else if (arg === "--clear") {
      if (command !== "request-worker-compact" && command !== "compact-worker") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --clear", explicit, flags, passthroughArgs, task };
      }
      flags.force = true;
    } else if (arg === "--prompt-only") {
      if (command !== "request-worker-compact" && command !== "compact-worker") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --prompt-only", explicit, flags, passthroughArgs, task };
      }
      flags.promptOnly = true;
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
      if (command !== "finish-task" && command !== "stop-task" && command !== "request-worker-compact") {
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
      if (command !== "finish-task" && command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-acks", explicit, flags, task };
      }
      if (command === "manager-config") {
        flags.managerRequireAcks = true;
      } else {
        flags.requireAcks = true;
      }
    } else if (arg === "--require-handoff") {
      if (command !== "manager-permission" && command !== "app-worker-rotation-plan") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require-handoff", explicit, flags, task };
      }
      flags.requireHandoff = true;
    } else if (arg === "--require") {
      if (command !== "manager-permission") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --require", explicit, flags, task };
      }
      flags.require = true;
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
    } else if (arg === "--path" || arg === "--db-path") {
      if (arg === "--db-path" && command !== "dashboard") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --db-path", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.path = value.value;
      index += 1;
    } else if (arg === "--codex-home") {
      if (command !== "install-skills") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --codex-home", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.codexHome = value.value;
      index += 1;
    } else if (arg === "--host") {
      if (command !== "dashboard") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --host", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.host = value.value;
      index += 1;
    } else if (arg === "--port") {
      if (command !== "dashboard") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --port", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value <= 0) {
        return { command, enabled, error: "--port must be a positive integer.", explicit, flags, task };
      }
      flags.port = value;
      index += 1;
    } else if (arg === "--workerctl-path") {
      if (command !== "dashboard") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --workerctl-path", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.workerctlPath = value.value;
      index += 1;
    } else if (arg === "--campaign") {
      if (command !== "dashboard") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --campaign", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.campaignName = value.value;
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
      if (command !== "runs" && command !== "loop-templates" && command !== "ralph-loop-presets" && command !== "manager-recipes") {
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
    } else if (arg === "--receipt-output") {
      if (command !== "qa-run") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --receipt-output", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.receiptOutput = value.value;
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
      if (command !== "runs" && command !== "loop-evidence" && command !== "campaign") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --metadata-json", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.metadataJson = value.value;
      index += 1;
    } else if (arg === "--payload-json") {
      if (command !== "record-decision" && command !== "handoff") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --payload-json", explicit, flags, task };
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
    } else if (command === "campaign" && Object.prototype.hasOwnProperty.call(CAMPAIGN_STRING_FLAGS, arg)) {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      (flags as Record<string, unknown>)[CAMPAIGN_STRING_FLAGS[arg]] = value.value;
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
      if (command !== "criteria-plan" && command !== "continuation" && command !== "worker-ack" && command !== "manager-ack") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --from-stdin", explicit, flags, task };
      }
      flags.fromStdin = true;
    } else if (arg === "--submit") {
      if (command !== "continuation") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --submit", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (value.value !== "worker" && value.value !== "manager") {
        return { command, enabled, error: "continuation --submit must be worker or manager", explicit, flags, task };
      }
      flags.submitRole = value.value;
      index += 1;
    } else if (arg === "--review") {
      if (command !== "continuation") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --review", explicit, flags, task };
      }
      flags.review = true;
    } else if (arg === "--as-role") {
      if (command !== "continuation") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --as-role", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (value.value !== "all" && value.value !== "worker" && value.value !== "manager" && value.value !== "reviewer") {
        return { command, enabled, error: "continuation --as-role must be all, worker, manager, or reviewer", explicit, flags, task };
      }
      flags.asRole = value.value;
      index += 1;
    } else if (arg === "--tmux-session" || arg === "--session") {
      if (arg === "--session" && command !== "doctor-self") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --session", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.tmuxSession = value.value;
      index += 1;
    } else if (arg === "--summary") {
      if (command === "telemetry") {
        flags.telemetrySummary = true;
        continue;
      }
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
      if (
        command !== "pair"
        && command !== "dispatch"
        && command !== "qa-run"
        && command !== "dashboard"
        && command !== "app-heartbeat"
        && command !== "app-loop-status"
        && command !== "app-wakeup-plan"
        && command !== "app-wakeup-dispatch"
        && command !== "app-autopilot"
      ) {
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
    } else if (arg === "--manager-recipe") {
      if (command !== "pair") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-recipe", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerRecipe = value.value;
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
    } else if (arg === "--objective") {
      if (command !== "manager-config" && command !== "campaign") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --objective", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (command === "manager-config") {
        flags.managerObjective = value.value;
      } else {
        flags.objective = value.value;
      }
      index += 1;
    } else if (arg === "--recipe") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --recipe", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerRecipe = value.value;
      index += 1;
    } else if (arg === "--guideline") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --guideline", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerGuideline.push(value.value);
      index += 1;
    } else if (arg === "--acceptance") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --acceptance", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerAcceptance.push(value.value);
      index += 1;
    } else if (arg === "--permit") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --permit", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerPermit.push(value.value);
      index += 1;
    } else if (arg === "--tool") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --tool", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerTool.push(value.value);
      index += 1;
    } else if (arg === "--epilogue") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --epilogue", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerEpilogue.push(value.value);
      index += 1;
    } else if (arg === "--nudge-on-completion") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --nudge-on-completion", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerNudgeOnCompletion = value.value;
      index += 1;
    } else if (arg === "--allow-pr") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --allow-pr", explicit, flags, task };
      }
      flags.managerAllowPr = true;
    } else if (arg === "--allow-merge-green") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --allow-merge-green", explicit, flags, task };
      }
      flags.managerAllowMergeGreen = true;
    } else if (arg === "--allow-worker-compact-clear") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --allow-worker-compact-clear", explicit, flags, task };
      }
      flags.managerAllowWorkerCompactClear = true;
    } else if (arg === "--permissions-json") {
      if (command !== "manager-config") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --permissions-json", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.managerPermissionsJson = value.value;
      index += 1;
    } else if (arg === "--next-step") {
      if (command !== "handoff") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --next-step", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.nextSteps.push(value.value);
      index += 1;
    } else if (arg === "--root") {
      if (command !== "import-compat") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --root", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.compatibilityRoot = value.value;
      index += 1;
    } else if (arg === "--step") {
      if (command !== "epilogue") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --step", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.epilogueStep = value.value;
      index += 1;
    } else if (arg === "--worker") {
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.worker = value.value;
      index += 1;
    } else if (arg === "--reviewer-session-id") {
      if (command !== "continuation-reviewer") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --reviewer-session-id", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.reviewerSessionId = value.value;
      index += 1;
    } else if (arg === "--manager-session-id") {
      if (command !== "continuation-reviewer") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-session-id", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.reviewerManagerSessionId = value.value;
      index += 1;
    } else if (arg === "--reviewer-command") {
      if (command !== "continuation-reviewer") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --reviewer-command", explicit, flags, task };
      }
      flags.reviewerCommand = queue.slice(index + 1);
      index = queue.length;
    } else if (arg === "--reason") {
      if (
        command !== "finish-task"
        && command !== "stop-task"
        && command !== "record-decision"
        && command !== "compact-worker"
        && command !== "app-wakeup-record-delivery"
        && command !== "app-worker-rotation-plan"
        && command !== "app-worker-rotation-record"
      ) {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --reason", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.reason = value.value;
      index += 1;
    } else if (arg === "--dispatch-receipt") {
      if (command !== "app-wakeup-record-delivery") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --dispatch-receipt", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.dispatchReceipt = value.value;
      index += 1;
    } else if (arg === "--delivery-status") {
      if (command !== "app-wakeup-record-delivery") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --delivery-status", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.deliveryStatus = value.value;
      index += 1;
    } else if (arg === "--archive-status") {
      if (command !== "app-worker-rotation-record") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --archive-status", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.archiveStatus = value.value;
      index += 1;
    } else if (arg === "--thread-id") {
      if (command !== "app-wakeup-record-delivery" && command !== "campaign") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --thread-id", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.threadId = value.value;
      index += 1;
    } else if (arg === "--old-worker-thread-id" || arg === "--new-worker-thread-id" || arg === "--new-worker-thread-title") {
      if (command !== "app-worker-rotation-plan" && command !== "app-worker-rotation-record") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      if (arg !== "--old-worker-thread-id" && command !== "app-worker-rotation-record") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (arg === "--old-worker-thread-id") {
        flags.oldWorkerThreadId = value.value;
      } else if (arg === "--new-worker-thread-id") {
        flags.newWorkerThreadId = value.value;
      } else {
        flags.newWorkerThreadTitle = value.value;
      }
      index += 1;
    } else if (arg === "--message") {
      if (
        command !== "finish-task"
        && command !== "stop-task"
        && command !== "stop"
        && command !== "enqueue-notify-manager"
        && command !== "enqueue-nudge-worker"
        && command !== "enqueue-continue-iteration"
        && command !== "request-worker-compact"
        && command !== "compact-worker"
      ) {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --message", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.message = value.value;
      index += 1;
    } else if (arg === "--cycle-id") {
      if (command !== "record-decision" && command !== "compact-worker") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --cycle-id", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value)) {
        return { command, enabled, error: "--cycle-id must be an integer.", explicit, flags, task };
      }
      flags.cycleId = value;
      index += 1;
    } else if (arg === "--decision-id") {
      if (command !== "finish-task" && command !== "stop-task" && command !== "request-worker-compact") {
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
    } else if (arg === "--timeout") {
      if (command !== "continuation-reviewer" && command !== "session-inbox" && command !== "manager-inbox" && command !== "worker-inbox") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --timeout", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isFinite(value) || (command === "continuation-reviewer" ? value <= 0 : value < 0)) {
        return {
          command,
          enabled,
          error: command === "continuation-reviewer"
            ? "--timeout must be a positive number."
            : "--timeout must be a non-negative number.",
          explicit,
          flags,
          task,
        };
      }
      flags.timeoutSeconds = value;
      index += 1;
    } else if (arg === "--consume-next") {
      if (command !== "session-inbox" && command !== "manager-inbox" && command !== "worker-inbox") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --consume-next", explicit, flags, task };
      }
      flags.consumeNext = true;
    } else if (arg === "--wait") {
      if (command !== "session-inbox" && command !== "manager-inbox" && command !== "worker-inbox") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --wait", explicit, flags, task };
      }
      flags.wait = true;
    } else if (arg === "--key") {
      if (command !== "interrupt" && command !== "session-interrupt") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --key", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.key = value.value;
      index += 1;
    } else if (arg === "--followup") {
      if (command !== "interrupt" && command !== "session-interrupt") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --followup", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.message = value.value;
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
    } else if (
      arg === "--worker-codex-app-thread-id"
      || arg === "--worker-codex-app-thread-title"
      || arg === "--manager-codex-app-thread-id"
      || arg === "--manager-codex-app-thread-title"
    ) {
      if (command !== "create-disposable-binding") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (arg === "--worker-codex-app-thread-id") {
        flags.workerCodexAppThreadId = value.value;
      } else if (arg === "--worker-codex-app-thread-title") {
        flags.workerCodexAppThreadTitle = value.value;
      } else if (arg === "--manager-codex-app-thread-id") {
        flags.managerCodexAppThreadId = value.value;
      } else {
        flags.managerCodexAppThreadTitle = value.value;
      }
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
      if (command === "manager-config") {
        if (value !== "light" && value !== "guided" && value !== "strict") {
          return { command, enabled, error: `Unsupported manager mode: ${value}`, explicit, flags, task };
        }
        flags.managerMode = value;
        index += 1;
        continue;
      }
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
      } else if (command === "campaign") {
        flags.statusState = value;
      } else if (!isSessionState(value)) {
        return { command, enabled, error: `Unsupported sessions state: ${value}`, explicit, flags, task };
      } else {
        flags.sessionState = value;
      }
      index += 1;
    } else if (arg === "--status") {
      if (command === "epilogue") {
        flags.epilogueStatus = true;
        continue;
      }
      if (command !== "criteria" && command !== "runs" && command !== "loop-evidence" && command !== "campaign") {
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
      if (command === "manager-config" && arg === "--reference") {
        const value = valueAfter(queue, index, arg);
        if (value.error) {
          return { command, enabled, error: value.error, explicit, flags, task };
        }
        flags.managerReference.push(value.value);
        index += 1;
        continue;
      }
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
        && command !== "worker-ack"
        && command !== "manager-ack"
        && command !== "loop-evidence"
        && command !== "continuation"
        && command !== "continuation-reviewer"
        && command !== "epilogue"
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
      if (command !== "loop-status" && command !== "telemetry") {
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
    } else if (arg === "--stale-after") {
      if (
        command !== "app-heartbeat"
        && command !== "app-loop-status"
        && command !== "app-wakeup-plan"
        && command !== "app-wakeup-dispatch"
        && command !== "app-autopilot"
      ) {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --stale-after", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isFinite(value) || value < 0) {
        return { command, enabled, error: "--stale-after must be a non-negative number.", explicit, flags, task };
      }
      flags.appStaleAfterSeconds = value;
      index += 1;
    } else if (arg === "--quiet-after") {
      if (command !== "app-autopilot") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --quiet-after", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value < 0) {
        return { command, enabled, error: "--quiet-after must be a non-negative integer.", explicit, flags, task };
      }
      flags.quietAfterCycles = value;
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
    } else if (arg === "--actor") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --actor", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (!["dispatch", "manager", "operator", "system", "worker", "workerctl"].includes(value.value)) {
        return { command, enabled, error: `Unsupported telemetry actor: ${value.value}`, explicit, flags, task };
      }
      flags.actor = value.value;
      index += 1;
    } else if (arg === "--event-type") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --event-type", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.eventType = value.value;
      index += 1;
    } else if (arg === "--severity") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --severity", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      if (!["debug", "info", "warning", "error"].includes(value.value)) {
        return { command, enabled, error: `Unsupported telemetry severity: ${value.value}`, explicit, flags, task };
      }
      flags.severity = value.value;
      index += 1;
    } else if (arg === "--search") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --search", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.search = value.value;
      index += 1;
    } else if (arg === "--window") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --window", explicit, flags, task };
      }
      const value = valueAfter(queue, index, arg);
      if (value.error) {
        return { command, enabled, error: value.error, explicit, flags, task };
      }
      flags.window = value.value;
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
    } else if (arg === "--stale-cycles-seconds" || arg === "--stale-cycle-seconds") {
      if (command !== "telemetry" && command !== "reconcile") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isFinite(value) || value < 0) {
        return { command, enabled, error: `${arg} must be a non-negative number.`, explicit, flags, task };
      }
      flags.staleCycleSeconds = value;
      index += 1;
    } else if (arg === "--worker-staleness-seconds") {
      if (command !== "telemetry") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --worker-staleness-seconds", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isFinite(value) || value < 0) {
        return { command, enabled, error: "--worker-staleness-seconds must be a non-negative number.", explicit, flags, task };
      }
      flags.workerStalenessSeconds = value;
      index += 1;
    } else if (arg === "--manager-stale-seconds") {
      if (command !== "db-doctor") {
        return { command, enabled, error: "Unsupported TypeScript runtime option: --manager-stale-seconds", explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value < 0) {
        return { command, enabled, error: "--manager-stale-seconds must be a non-negative integer.", explicit, flags, task };
      }
      flags.managerStaleSeconds = value;
      index += 1;
    } else if (arg === "--max-unfinished-commands" || arg === "--max-open-criteria" || arg === "--max-storage-bytes") {
      if (command !== "telemetry") {
        return { command, enabled, error: `Unsupported TypeScript runtime option: ${arg}`, explicit, flags, task };
      }
      const parsedValue = valueAfter(queue, index, arg);
      if (parsedValue.error) {
        return { command, enabled, error: parsedValue.error, explicit, flags, task };
      }
      const value = Number(parsedValue.value);
      if (!Number.isInteger(value) || value < 0) {
        return { command, enabled, error: `${arg} must be a non-negative integer.`, explicit, flags, task };
      }
      if (arg === "--max-unfinished-commands") {
        flags.maxUnfinishedCommands = value;
      } else if (arg === "--max-open-criteria") {
        flags.maxOpenCriteria = value;
      } else {
        flags.maxStorageBytes = value;
      }
      index += 1;
    } else if (arg === "--interval") {
      if (command !== "dispatch" && command !== "session-inbox" && command !== "manager-inbox" && command !== "worker-inbox" && command !== "app-autopilot") {
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
      if (command !== "dispatch" && command !== "app-autopilot") {
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
      if (!["add", "visual-diff", "visual_diff", "build-passed", "build_passed", "adversarial-check", "adversarial_check"].includes(arg)) {
        return { command, enabled, error: `Unsupported loop-evidence action: ${arg}`, explicit, flags, task };
      }
      flags.subtype = arg;
    } else if (command === "app-autopilot" && flags.action === null) {
      if (!["start", "stop", "status"].includes(arg)) {
        return { command, enabled, error: `Unsupported app-autopilot action: ${arg}`, explicit, flags, task };
      }
      flags.action = arg;
    } else if (command === "campaign" && flags.action === null) {
      if (!CAMPAIGN_ACTIONS.has(arg)) {
        return { command, enabled, error: unsupportedCampaignActionMessage(arg), explicit, flags, task };
      }
      flags.action = arg;
    } else if ((command === "qa-plan" || command === "qa-run") && flags.subtype === null) {
      flags.subtype = arg;
    } else if (command === "telemetry" && flags.telemetryView === null && isTelemetryView(arg)) {
      flags.telemetryView = arg;
    } else if (command === "telemetry" && flags.telemetryView === "task" && flags.telemetryViewTask === null) {
      flags.telemetryViewTask = arg;
    } else if (task === null) {
      task = arg;
    } else if ((command === "nudge" || command === "session-nudge") && flags.message === null) {
      flags.message = arg;
    } else if (command === "manager-permission" && flags.action === null) {
      flags.action = arg;
    } else if (command === "record-decision" && flags.decision === null) {
      flags.decision = arg;
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
      return jsonResult(parsed.flags.includeContent ? audit : redactAudit(audit));
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
  const database = openRuntimeDatabase(parsed, options);
  try {
    const audit = taskAuditSync(database, task);
    const outputDir = parsed.flags.output
      ? resolve(parsed.flags.output)
      : join(stateRoot({ cwd: options.cwd, env: options.env }), "artifacts", "tasks", audit.task.id, "export");
    return jsonResult(exportTaskSync(database, {
      includeFullTranscripts: parsed.flags.includeFullTranscripts,
      includeTranscripts: parsed.flags.includeTranscripts,
      outputDir,
      task,
      zip: parsed.flags.zip,
    }));
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
    return unsupportedRuntimeResult(parsed, "loop-evidence requires an action: add, visual-diff, build-passed, or adversarial-check.");
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
    if (action === "build-passed" || action === "build_passed") {
      if (parsed.flags.evidenceType && parsed.flags.evidenceType !== "build_passed") {
        return errorResult("loop-evidence build-passed records evidence_type=build_passed; omit --evidence-type or use build_passed.");
      }
      const result = recordLoopEvidenceSync(database, {
        artifactPath: parsed.flags.output,
        correlationId: parsed.flags.correlationId,
        evidenceType: "build_passed",
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

function runManagerRecipesCommand(parsed: ParsedRuntimeArgs): TypescriptRuntimeResult {
  const unsupportedOptions = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set<RuntimeFlagKey>(["json", "list", "show"]),
    commandName: "manager-recipes",
  });
  if (unsupportedOptions) {
    return unsupportedRuntimeResult(parsed, unsupportedOptions);
  }
  const actionCount = [parsed.flags.list, parsed.flags.show !== null].filter(Boolean).length;
  if (actionCount !== 1) {
    return errorResult("Choose one of --list or --show");
  }
  if (parsed.flags.list) {
    const recipes = listManagerRecipes();
    if (parsed.flags.json) {
      return jsonResult({ recipes });
    }
    return textResult(recipes.map((recipe) => {
      const loop = recipe.loop_template ? ` loop=${recipe.loop_template}` : "";
      return `${recipe.name}\tmode=${recipe.mode}${loop}\t${recipe.description}`;
    }));
  }
  const recipe = managerRecipeSummary(parsed.flags.show ?? "");
  if (parsed.flags.json) {
    return jsonResult({ recipe });
  }
  const lines = [
    String(recipe.locked_summary_template),
    "",
    "manager config command:",
    `  ${(recipe.manager_config_command as string[]).map(shellQuote).join(" ")}`,
  ];
  if (recipe.loop_template) {
    lines.push("", `loop template: ${recipe.loop_template}`);
  }
  return textResult(lines);
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

function runAppHeartbeatCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (parsed.flags.role !== "manager" && parsed.flags.role !== "worker") {
    return errorResult("app-heartbeat requires --role manager|worker");
  }
  const role = parsed.flags.role;
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForDiagnostics(database, taskName);
    const session = boundAppSessionForRoleSync(database, { role, taskId: task.id });
    const timestamp = nowIsoSeconds(options);
    const dbPath = runtimeDbPath(parsed, options);
    database.prepare("update sessions set last_heartbeat_at = ? where id = ?").run(timestamp, session.id);
    emitTelemetrySync(database, {
      actor: role,
      attributes: {
        direct_inbox_command: directInboxPollCommand(role, task.name, dbPath),
        role,
        session_id: session.id,
        task: task.name,
      },
      correlation: { command: "app-heartbeat" },
      eventType: "app_heartbeat",
      severity: "info",
      summary: `${role} app heartbeat for ${task.name}.`,
      taskId: task.id,
      timestamp,
    });
    const status = appLoopStatusSync(database, {
      dbPath,
      dispatcherId: parsed.flags.dispatcherId ?? "dispatch-local",
      heartbeatStaleSeconds: parsed.flags.appStaleAfterSeconds,
      now: timestamp,
      taskName: task.name,
    });
    const roleStatus = role === "manager" ? status.manager : status.worker;
    const output = {
      heartbeat: {
        recorded_at: timestamp,
        state: "recorded",
      },
      next: {
        direct_inbox_command: roleStatus.direct_inbox_command,
        poll_command: roleStatus.poll_command,
      },
      role,
      status,
      task: { id: task.id, name: task.name },
    };
    if (parsed.flags.json) {
      return jsonResult(output);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: `${role} heartbeat recorded for ${task.name}\nNext: ${roleStatus.direct_inbox_command ?? roleStatus.poll_command ?? "(none)"}\n`,
    };
  } finally {
    database.close();
  }
}

function runAppLoopStatusCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const status = appLoopStatusSync(database, {
      dbPath: runtimeDbPath(parsed, options),
      dispatcherId: parsed.flags.dispatcherId ?? "dispatch-local",
      heartbeatStaleSeconds: parsed.flags.appStaleAfterSeconds,
      now: nowIsoSeconds(options),
      taskName,
    });
    if (parsed.flags.json) {
      return jsonResult(status);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderAppLoopStatusText(status),
    };
  } finally {
    database.close();
  }
}

function runAppWakeupPlanCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const plan = appWakeupPlanSync(database, {
      dbPath: runtimeDbPath(parsed, options),
      dispatcherId: parsed.flags.dispatcherId ?? "dispatch-local",
      heartbeatStaleSeconds: parsed.flags.appStaleAfterSeconds,
      now: nowIsoSeconds(options),
      taskName,
    });
    if (parsed.flags.json) {
      return jsonResult(plan);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderAppWakeupPlanText(plan),
    };
  } finally {
    database.close();
  }
}

function runAppWakeupDispatchCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const timestamp = nowIsoSeconds(options);
    const dispatch = appWakeupDispatchPlanSync(database, {
      dbPath: runtimeDbPath(parsed, options),
      dispatcherId: parsed.flags.dispatcherId ?? "dispatch-local",
      heartbeatStaleSeconds: parsed.flags.appStaleAfterSeconds,
      now: timestamp,
      taskName,
    });
    const eventId = emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        actions: dispatch.actions.map((action) => ({
          blocker: action.blocker,
          reason: action.reason,
          role: action.role,
          send_ready: action.send_ready,
          status: action.status,
          thread_id: action.thread.id,
          thread_title: action.thread.title,
        })),
        dispatcher: dispatch.dispatcher,
        status_ok: dispatch.status.ok,
        summary: dispatch.summary,
      },
      correlation: {
        command: "app-wakeup-dispatch",
        dispatcher_id: dispatch.status.dispatch.dispatcher_id,
      },
      eventType: "app_wakeup_dispatch_planned",
      severity: dispatch.summary.blocked > 0 || dispatch.dispatcher.required ? "warning" : "info",
      summary: `App wakeup dispatch planned for ${dispatch.status.task.name}.`,
      taskId: dispatch.status.task.id,
      timestamp,
    });
    const output = {
      ...dispatch,
      receipt: {
        event_id: eventId,
        event_type: "app_wakeup_dispatch_planned",
        recorded_at: timestamp,
      },
    };
    if (parsed.flags.json) {
      return jsonResult(output);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderAppWakeupDispatchText(output),
    };
  } finally {
    database.close();
  }
}

type AppWakeupDeliveryStatus = "blocked" | "sent" | "skipped";
type AppWakeupSourceActionStatus = "blocked_missing_thread" | "ready_to_send" | "skipped_healthy";

interface AppWakeupSourceAction {
  blocker?: string | null;
  reason?: string | null;
  role?: string | null;
  send_ready?: boolean | null;
  status?: string | null;
  thread_id?: string | null;
  thread_title?: string | null;
}

function runAppWakeupRecordDeliveryCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (parsed.flags.role !== "manager" && parsed.flags.role !== "worker") {
    return errorResult("app-wakeup-record-delivery requires --role manager|worker");
  }
  const role = parsed.flags.role;
  if (!parsed.flags.dispatchReceipt) {
    return errorResult("app-wakeup-record-delivery requires --dispatch-receipt");
  }
  const deliveryStatus = parseAppWakeupDeliveryStatus(parsed.flags.deliveryStatus);
  if (deliveryStatus instanceof Error) {
    return errorResult(deliveryStatus.message);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForDiagnostics(database, taskName);
    const source = database.prepare(`
      select id, task_id, event_type, attributes_json
      from telemetry_events
      where id = ?
      limit 1
    `).get(parsed.flags.dispatchReceipt) as { attributes_json: string; event_type: string; id: string; task_id: string | null } | undefined;
    if (!source) {
      throw new Error(`Unknown app wakeup dispatch receipt: ${parsed.flags.dispatchReceipt}`);
    }
    if (source.event_type !== "app_wakeup_dispatch_planned") {
      throw new Error(`Receipt ${source.id} is ${source.event_type}, expected app_wakeup_dispatch_planned.`);
    }
    if (source.task_id !== task.id) {
      throw new Error(`Receipt ${source.id} does not belong to task ${task.name}.`);
    }
    const attributes = parseAppWakeupDispatchAttributes(source.attributes_json, source.id);
    const action = attributes.actions.find((candidate) => candidate.role === role);
    if (!action) {
      throw new Error(`Receipt ${source.id} has no ${role} wake action.`);
    }
    validateAppWakeupDelivery({ action, deliveryStatus, role, threadId: parsed.flags.threadId });
    const timestamp = nowIsoSeconds(options);
    const eventId = emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        delivery_status: deliveryStatus,
        dispatch_receipt: source.id,
        dispatch_required: attributes.summary.dispatcher_required,
        reason: parsed.flags.reason,
        role,
        source_action_status: action.status,
        source_send_ready: action.send_ready === true,
        thread_id: parsed.flags.threadId ?? action.thread_id ?? null,
        thread_title: action.thread_title ?? null,
      },
      correlation: {
        command: "app-wakeup-record-delivery",
        dispatch_receipt: source.id,
        role,
        thread_id: parsed.flags.threadId ?? action.thread_id ?? null,
      },
      eventType: "app_wakeup_delivery_recorded",
      severity: deliveryStatus === "sent" ? "info" : "warning",
      summary: `App wakeup delivery ${deliveryStatus} for ${role} on ${task.name}.`,
      taskId: task.id,
      timestamp,
    });
    const output = {
      delivery: {
        reason: parsed.flags.reason,
        role,
        source_action_status: action.status,
        source_send_ready: action.send_ready === true,
        status: deliveryStatus,
        thread_id: parsed.flags.threadId ?? action.thread_id ?? null,
      },
      receipt: {
        event_id: eventId,
        event_type: "app_wakeup_delivery_recorded",
        recorded_at: timestamp,
      },
      source: {
        dispatch_receipt: source.id,
        dispatch_required: attributes.summary.dispatcher_required,
        dispatcher: attributes.dispatcher,
      },
      task: { id: task.id, name: task.name },
    };
    if (parsed.flags.json) {
      return jsonResult(output);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: [
        `App wakeup delivery ${deliveryStatus} recorded for ${role} on ${task.name}.`,
        `Source receipt: ${source.id}`,
        `Receipt: ${eventId}`,
        attributes.summary.dispatcher_required ? "Dispatch still required by source receipt." : "Dispatch healthy in source receipt.",
      ].join("\n") + "\n",
    };
  } finally {
    database.close();
  }
}

type AppWorkerArchiveStatus = "archived" | "blocked";

function runAppWorkerRotationPlanCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (!parsed.flags.oldWorkerThreadId) {
    return errorResult("app-worker-rotation-plan requires --old-worker-thread-id.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const timestamp = nowIsoSeconds(options);
    const dbPath = runtimeDbPath(parsed, options);
    const plan = appWorkerRotationPlanSync(database, {
      dbPath,
      now: timestamp,
      oldWorkerThreadId: parsed.flags.oldWorkerThreadId,
      reason: parsed.flags.reason,
      requireHandoff: parsed.flags.requireHandoff,
      taskName,
    });
    const eventId = emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        actions: plan.actions.map((action) => ({
          status: action.status,
          thread_id: action.thread.id,
          type: action.type,
        })),
        blockers: plan.blockers,
        eligible: plan.eligible,
        handoff_id: plan.handoff?.id ?? null,
        old_worker_thread_id: parsed.flags.oldWorkerThreadId,
        reason: parsed.flags.reason,
      },
      correlation: {
        command: "app-worker-rotation-plan",
        old_worker_thread_id: parsed.flags.oldWorkerThreadId,
      },
      eventType: "app_worker_rotation_planned",
      severity: plan.eligible ? "info" : "warning",
      summary: `Codex app worker rotation ${plan.eligible ? "planned" : "blocked"} for ${plan.task.name}.`,
      taskId: plan.task.id,
      timestamp,
    });
    const output = {
      ...plan,
      receipt: {
        event_id: eventId,
        event_type: "app_worker_rotation_planned",
        recorded_at: timestamp,
      },
    };
    if (parsed.flags.json) {
      return jsonResult(output);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderAppWorkerRotationPlanText(output),
    };
  } finally {
    database.close();
  }
}

function runAppWorkerRotationRecordCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (!parsed.flags.oldWorkerThreadId) {
    return errorResult("app-worker-rotation-record requires --old-worker-thread-id.");
  }
  if (!parsed.flags.newWorkerThreadId) {
    return errorResult("app-worker-rotation-record requires --new-worker-thread-id.");
  }
  const archiveStatus = parseAppWorkerArchiveStatus(parsed.flags.archiveStatus);
  if (archiveStatus instanceof Error) {
    return errorResult(archiveStatus.message);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const timestamp = nowIsoSeconds(options);
    const dbPath = runtimeDbPath(parsed, options);
    const plan = appWorkerRotationPlanSync(database, {
      dbPath,
      now: timestamp,
      oldWorkerThreadId: parsed.flags.oldWorkerThreadId,
      reason: parsed.flags.reason,
      requireHandoff: false,
      taskName,
    });
    if (!plan.eligible) {
      throw new Error(`Cannot record worker rotation; active worker ownership check failed: ${plan.blockers.join(", ")}`);
    }
    if (archiveStatus === "archived") {
      database.prepare(`
        update sessions
        set codex_app_thread_id = ?, codex_app_thread_title = ?, last_heartbeat_at = null
        where id = ? and role = 'worker'
      `).run(parsed.flags.newWorkerThreadId, parsed.flags.newWorkerThreadTitle, plan.old_worker.session_id);
    }
    const eventId = emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        archive_status: archiveStatus,
        binding_id: plan.guard.binding_id,
        handoff_id: plan.handoff?.id ?? null,
        new_worker_thread_id: parsed.flags.newWorkerThreadId,
        new_worker_thread_title: parsed.flags.newWorkerThreadTitle,
        old_worker_session_id: plan.old_worker.session_id,
        old_worker_thread_id: parsed.flags.oldWorkerThreadId,
        reason: parsed.flags.reason,
        session_updated: archiveStatus === "archived",
      },
      correlation: {
        command: "app-worker-rotation-record",
        new_worker_thread_id: parsed.flags.newWorkerThreadId,
        old_worker_thread_id: parsed.flags.oldWorkerThreadId,
      },
      eventType: "app_worker_rotation_recorded",
      severity: archiveStatus === "archived" ? "info" : "warning",
      summary: `Codex app worker rotation ${archiveStatus} for ${plan.task.name}.`,
      taskId: plan.task.id,
      timestamp,
    });
    const output = {
      archive: {
        old_worker_thread_id: parsed.flags.oldWorkerThreadId,
        status: archiveStatus,
      },
      guard: plan.guard,
      new_worker: {
        codex_app_thread_id: parsed.flags.newWorkerThreadId,
        codex_app_thread_title: parsed.flags.newWorkerThreadTitle,
        session_id: plan.old_worker.session_id,
        session_updated: archiveStatus === "archived",
      },
      old_worker: plan.old_worker,
      receipt: {
        event_id: eventId,
        event_type: "app_worker_rotation_recorded",
        recorded_at: timestamp,
      },
      task: plan.task,
    };
    if (parsed.flags.json) {
      return jsonResult(output);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: [
        `App worker rotation ${archiveStatus} for ${plan.task.name}.`,
        `Old worker thread: ${parsed.flags.oldWorkerThreadId}`,
        `New worker thread: ${parsed.flags.newWorkerThreadId}`,
        `Receipt: ${eventId}`,
      ].join("\n") + "\n",
    };
  } finally {
    database.close();
  }
}

function parseAppWorkerArchiveStatus(value: string | null): AppWorkerArchiveStatus | Error {
  if (value === "archived" || value === "blocked") {
    return value;
  }
  return new Error("app-worker-rotation-record requires --archive-status archived|blocked");
}

interface AppWorkerRotationPlan {
  actions: Array<{
    guard: AppWorkerRotationGuard;
    prompt?: string;
    role: "worker";
    send_ready: boolean;
    status: "blocked" | "ready_to_create" | "ready_to_archive";
    thread: { id: string | null; title: string | null };
    type: "archive_old_worker_thread" | "create_replacement_worker_thread";
  }>;
  blockers: string[];
  eligible: boolean;
  guard: AppWorkerRotationGuard;
  handoff: { created_at: unknown; id: unknown; next_steps: unknown; summary: unknown; worker_session_id: unknown } | null;
  old_worker: {
    codex_app_thread_id: string | null;
    codex_app_thread_title: string | null;
    name: string;
    session_id: string;
  };
  record_command: string | null;
  task: { id: string; name: string };
}

interface AppWorkerRotationGuard {
  active_binding: boolean;
  binding_id: string;
  exact_thread_match: boolean;
  expected_old_worker_thread_id: string;
  manager_session_id: string;
  manager_thread_id: string | null;
  require_handoff: boolean;
  role: "worker";
  task_id: string;
  worker_session_id: string;
  worker_state: string;
}

function appWorkerRotationPlanSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    dbPath: string;
    now: string;
    oldWorkerThreadId: string;
    reason: string | null;
    requireHandoff: boolean;
    taskName: string;
  },
): AppWorkerRotationPlan {
  const task = taskRowForPair(database, options.taskName);
  if (task === null) {
    throw new Error(`Unknown task: ${options.taskName}`);
  }
  const binding = activeBindingForTaskSync(database, task.name);
  const worker = sessionRow(database, binding.worker_session_name, "worker");
  const manager = sessionRow(database, binding.manager_session_name, "manager");
  const handoff = latestWorkerHandoffFullSync(database, task.id);
  const blockers: string[] = [];
  const exactThreadMatch = worker.codex_app_thread_id === options.oldWorkerThreadId;
  if (binding.state !== "active") {
    blockers.push("active_binding_not_active");
  }
  if (worker.state !== "active") {
    blockers.push("worker_session_not_active");
  }
  if (worker.tmux_session !== null) {
    blockers.push("worker_session_is_tmux_backed");
  }
  if (!worker.codex_app_thread_id) {
    blockers.push("missing_worker_codex_app_thread_id");
  }
  if (!exactThreadMatch) {
    blockers.push("old_worker_thread_id_mismatch");
  }
  if (manager.id === worker.id || manager.codex_app_thread_id === worker.codex_app_thread_id) {
    blockers.push("manager_worker_thread_not_distinct");
  }
  if (options.requireHandoff) {
    if (handoff === null) {
      blockers.push("missing_worker_handoff");
    } else if (handoff.worker_session_id !== worker.id) {
      blockers.push("handoff_worker_session_mismatch");
    }
  }
  const guard: AppWorkerRotationGuard = {
    active_binding: binding.state === "active",
    binding_id: binding.binding_id,
    exact_thread_match: exactThreadMatch,
    expected_old_worker_thread_id: options.oldWorkerThreadId,
    manager_session_id: manager.id,
    manager_thread_id: manager.codex_app_thread_id,
    require_handoff: options.requireHandoff,
    role: "worker",
    task_id: task.id,
    worker_session_id: worker.id,
    worker_state: worker.state,
  };
  const eligible = blockers.length === 0;
  const replacementTitle = replacementWorkerThreadTitle(task.name, worker.codex_app_thread_title);
  const recordCommand = `${conveyorPollInvocation()} app-worker-rotation-record ${shellQuote(task.name)} --old-worker-thread-id ${shellQuote(options.oldWorkerThreadId)} --new-worker-thread-id <new.thread.id> --new-worker-thread-title <new.thread.title> --archive-status archived --path ${shellQuote(options.dbPath)} --json`;
  return {
    actions: eligible
      ? [
        {
          guard,
          prompt: replacementWorkerPrompt({
            dbPath: options.dbPath,
            handoff,
            reason: options.reason,
            taskName: task.name,
          }),
          role: "worker",
          send_ready: true,
          status: "ready_to_create",
          thread: { id: null, title: replacementTitle },
          type: "create_replacement_worker_thread",
        },
        {
          guard,
          role: "worker",
          send_ready: true,
          status: "ready_to_archive",
          thread: { id: worker.codex_app_thread_id, title: worker.codex_app_thread_title },
          type: "archive_old_worker_thread",
        },
      ]
      : [],
    blockers,
    eligible,
    guard,
    handoff: handoff === null
      ? null
      : {
        created_at: handoff.created_at,
        id: handoff.id,
        next_steps: handoff.next_steps,
        summary: handoff.summary,
        worker_session_id: handoff.worker_session_id,
      },
    old_worker: {
      codex_app_thread_id: worker.codex_app_thread_id,
      codex_app_thread_title: worker.codex_app_thread_title,
      name: worker.name,
      session_id: worker.id,
    },
    record_command: eligible ? recordCommand : null,
    task: { id: task.id, name: task.name },
  };
}

function replacementWorkerThreadTitle(taskName: string, oldTitle: string | null): string {
  const base = oldTitle && oldTitle.trim().length > 0 ? oldTitle.trim() : `${taskName} worker`;
  return `${base} fresh`;
}

function replacementWorkerPrompt(options: {
  dbPath: string;
  handoff: Record<string, unknown> | null;
  reason: string | null;
  taskName: string;
}): string {
  const handoffLines = options.handoff === null
    ? ["No saved handoff was required for this rotation plan."]
    : [
      `Saved handoff id: ${String(options.handoff.id)}`,
      `Saved handoff summary: ${String(options.handoff.summary)}`,
      `Saved handoff next steps: ${JSON.stringify(options.handoff.next_steps ?? [])}`,
    ];
  return [
    "Use the manage-codex-workers skill.",
    `You are the replacement Codex app worker thread for task ${options.taskName}.`,
    options.reason ? `Rotation reason: ${options.reason}` : "Rotation reason: fresh worker context for Codex app usage.",
    ...handoffLines,
    "",
    "Resume from the saved handoff and continue through Conveyor only. Do not rely on the archived worker thread for context beyond the handoff above.",
    ...visibleSessionProtocolLines("worker"),
    `Run: ${disposableAppHeartbeatCommand("worker", options.taskName, options.dbPath)}`,
    `If the heartbeat output asks for direct inbox polling, run: ${sessionPollCommand("worker", options.taskName, options.dbPath)}`,
    "If no item is consumed, stop after a one-line idle receipt.",
  ].join("\n");
}

function renderAppWorkerRotationPlanText(plan: AppWorkerRotationPlan & { receipt?: { event_id: string } }): string {
  const lines = [
    `App worker rotation for ${plan.task.name}: ${plan.eligible ? "ready" : "blocked"}`,
    `Old worker thread: ${plan.old_worker.codex_app_thread_id ?? "(missing)"}`,
  ];
  if (plan.blockers.length > 0) {
    lines.push(`Blockers: ${plan.blockers.join(", ")}`);
  }
  for (const action of plan.actions) {
    lines.push(`${action.type}: ${action.status}`);
    if (action.thread.id || action.thread.title) {
      lines.push(`  thread: ${action.thread.title ?? "(untitled)"} ${action.thread.id ?? "(new)"}`);
    }
  }
  if (plan.record_command) {
    lines.push(`Record after app tools: ${plan.record_command}`);
  }
  if (plan.receipt) {
    lines.push(`Receipt: ${plan.receipt.event_id}`);
  }
  return `${lines.join("\n")}\n`;
}

function runAppAutopilotCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const action = parsed.flags.action;
  if (action !== "start" && action !== "stop" && action !== "status") {
    return errorResult("app-autopilot requires an action: start, stop, or status");
  }
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const timestamp = nowIsoSeconds(options);
    const dbPath = runtimeDbPath(parsed, options);
    const dispatcherId = parsed.flags.dispatcherId ?? "dispatch-local";
    const desiredState: AppAutopilotDesiredState | null = action === "start" ? "active" : action === "stop" ? "stopped" : null;
    let plan = appAutopilotPlanSync(database, {
      dbPath,
      dispatchIntervalSeconds: parsed.flags.intervalSeconds,
      dispatcherId,
      desiredState,
      heartbeatIntervalMinutes: 2,
      heartbeatStaleSeconds: parsed.flags.appStaleAfterSeconds,
      now: timestamp,
      quietAfterCycles: parsed.flags.quietAfterCycles,
      taskName,
      watchIterations: parsed.flags.watchIterations ?? 1000000,
    });
    let receipt: { event_id: string; event_type: string; recorded_at: string } | null = null;
    if (action === "start" || action === "stop") {
      const eventType = action === "start" ? "app_autopilot_started" : "app_autopilot_stopped";
      const eventId = emitTelemetrySync(database, {
        actor: "operator",
        attributes: {
          automation_specs: plan.automation_specs.map((spec) => ({
            can_create: spec.can_create,
            interval_minutes: spec.interval_minutes,
            name: spec.name,
            role: spec.role,
            target_thread_id: spec.target_thread_id,
            target_thread_title: spec.target_thread_title,
          })),
          desired_state: desiredState,
          dispatcher_command: plan.control.dispatcher_command,
          dispatcher_id: dispatcherId,
          interval_minutes: plan.interval_minutes,
          quiescence: plan.quiescence,
          summary: plan.summary,
        },
        correlation: {
          action,
          command: "app-autopilot",
          dispatcher_id: dispatcherId,
        },
        eventType,
        severity: plan.summary.blocked_automations > 0 ? "warning" : "info",
        summary: `App autopilot ${action} for ${plan.task.name}.`,
        taskId: plan.task.id,
        timestamp,
      });
      receipt = {
        event_id: eventId,
        event_type: eventType,
        recorded_at: timestamp,
      };
      plan = {
        ...plan,
        last_policy_event: receipt,
      };
    }
    const output = {
      action,
      plan,
      receipt,
    };
    if (parsed.flags.json) {
      return jsonResult(output);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: renderAppAutopilotText(output),
    };
  } finally {
    database.close();
  }
}

function parseAppWakeupDeliveryStatus(value: string | null): AppWakeupDeliveryStatus | Error {
  if (value === "sent" || value === "skipped" || value === "blocked") {
    return value;
  }
  return new Error("app-wakeup-record-delivery requires --delivery-status sent|skipped|blocked");
}

function parseAppWakeupDispatchAttributes(value: string, receiptId: string): {
  actions: AppWakeupSourceAction[];
  dispatcher: Record<string, unknown>;
  summary: { dispatcher_required: boolean };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Receipt ${receiptId} has invalid attributes JSON.`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Receipt ${receiptId} has invalid attributes shape.`);
  }
  const attributes = parsed as Record<string, unknown>;
  if (!Array.isArray(attributes.actions)) {
    throw new Error(`Receipt ${receiptId} is missing actions.`);
  }
  const summary = attributes.summary;
  if (!summary || typeof summary !== "object" || typeof (summary as Record<string, unknown>).dispatcher_required !== "boolean") {
    throw new Error(`Receipt ${receiptId} is missing dispatcher_required summary.`);
  }
  const dispatcher = attributes.dispatcher && typeof attributes.dispatcher === "object"
    ? attributes.dispatcher as Record<string, unknown>
    : {};
  return {
    actions: attributes.actions as AppWakeupSourceAction[],
    dispatcher,
    summary: { dispatcher_required: Boolean((summary as Record<string, unknown>).dispatcher_required) },
  };
}

function validateAppWakeupDelivery(options: {
  action: AppWakeupSourceAction;
  deliveryStatus: AppWakeupDeliveryStatus;
  role: AppLoopRole;
  threadId: string | null;
}): void {
  const sourceStatus = parseAppWakeupSourceActionStatus(options.action.status);
  if (sourceStatus instanceof Error) {
    throw sourceStatus;
  }
  if (options.deliveryStatus === "sent") {
    if (sourceStatus !== "ready_to_send" || options.action.send_ready !== true) {
      throw new Error(`Cannot record sent wakeup for ${options.role}; source action is ${sourceStatus}.`);
    }
    if (!options.threadId) {
      throw new Error("app-wakeup-record-delivery --delivery-status sent requires --thread-id.");
    }
    if (options.action.thread_id !== options.threadId) {
      throw new Error(`Thread id mismatch for ${options.role}; source action targets ${options.action.thread_id ?? "(none)"}.`);
    }
    return;
  }
  if (options.deliveryStatus === "skipped") {
    if (sourceStatus !== "skipped_healthy") {
      throw new Error(`Cannot record skipped wakeup for ${options.role}; source action is ${sourceStatus}.`);
    }
    return;
  }
  if (sourceStatus !== "blocked_missing_thread") {
    throw new Error(`Cannot record blocked wakeup for ${options.role}; source action is ${sourceStatus}.`);
  }
}

function parseAppWakeupSourceActionStatus(value: string | null | undefined): AppWakeupSourceActionStatus | Error {
  if (value === "ready_to_send" || value === "skipped_healthy" || value === "blocked_missing_thread") {
    return value;
  }
  return new Error(`Unsupported app wakeup source action status: ${value ?? "(missing)"}.`);
}

function renderAppLoopStatusText(status: AppLoopStatus): string {
  const lines = [
    `App loop ${status.task.name}: ${status.ok ? "ok" : "attention required"}`,
    `Dispatch ${status.dispatch.dispatcher_id}: ${status.dispatch.state}`,
    `Manager ${status.manager.name ?? "(missing)"}: ${status.manager.lease.state}`,
    `Worker ${status.worker.name ?? "(missing)"}: ${status.worker.lease.state}`,
  ];
  for (const action of status.next_actions) {
    lines.push(`Next: ${action.kind} - ${action.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderAppWakeupDispatchText(plan: AppWakeupDispatchPlan & { receipt: { event_id: string; event_type: string; recorded_at: string } }): string {
  const lines = [
    `App wakeup dispatch for ${plan.status.task.name}: ${plan.status.ok ? "ok" : "attention required"}`,
    `Dispatch: ${plan.dispatcher.state}${plan.dispatcher.required ? ` (${plan.dispatcher.command})` : ""}`,
    `Receipt: ${plan.receipt.event_type} ${plan.receipt.event_id}`,
  ];
  for (const action of plan.actions) {
    lines.push(`${action.role}: ${action.status} - ${action.reason}`);
    if (action.blocker) {
      lines.push(`Blocker: ${action.blocker}`);
    }
    if (action.send_ready && action.thread.id) {
      lines.push(`Thread: ${action.thread.title ?? "(untitled)"} ${action.thread.id}`);
    }
    if (action.prompt) {
      lines.push(action.prompt);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderAppWakeupPlanText(plan: ReturnType<typeof appWakeupPlanSync>): string {
  const lines = [
    `App wakeup plan for ${plan.status.task.name}: ${plan.status.ok ? "ok" : "attention required"}`,
    `Dispatch: ${plan.dispatcher.state}${plan.dispatcher.required ? ` (${plan.dispatcher.command})` : ""}`,
  ];
  for (const wakeup of plan.wakeups) {
    lines.push(`Wake ${wakeup.role}${wakeup.thread.title ? ` (${wakeup.thread.title})` : ""}: ${wakeup.reason}`);
    lines.push(wakeup.prompt);
  }
  return `${lines.join("\n")}\n`;
}

function renderAppAutopilotText(result: {
  action: string;
  plan: AppAutopilotPlan;
  receipt: { event_id: string; event_type: string; recorded_at: string } | null;
}): string {
  const lines = [
    `App autopilot ${result.action} for ${result.plan.task.name}: ${result.plan.desired_state}`,
    `Loop status: ${result.plan.status.ok ? "ok" : "attention required"}`,
    `Dispatch: ${result.plan.dispatcher.state}${result.plan.dispatcher.required ? " required" : ""}`,
    `Dispatch command: ${result.plan.control.dispatcher_command}`,
    `Wake dispatch: ${result.plan.control.wakeup_dispatch_command}`,
  ];
  if (result.plan.quiescence.recommended_action === "stop_autopilot") {
    lines.push(`Quiescence: stop recommended - ${result.plan.quiescence.reason}`);
    lines.push(`Stop command: ${result.plan.control.stop_command}`);
  } else {
    lines.push(`Quiescence: ${result.plan.quiescence.state} (${result.plan.quiescence.quiet_cycles}/${result.plan.quiescence.threshold_cycles} quiet cycles)`);
  }
  if (result.receipt) {
    lines.push(`Receipt: ${result.receipt.event_type} ${result.receipt.event_id}`);
  } else if (result.plan.last_policy_event) {
    lines.push(`Last policy: ${result.plan.last_policy_event.event_type} ${result.plan.last_policy_event.event_id}`);
  } else {
    lines.push("Last policy: unconfigured");
  }
  for (const spec of result.plan.automation_specs) {
    lines.push(
      `${spec.role} automation: ${spec.can_create ? "ready" : "blocked"} ${spec.name}`,
      `  thread: ${spec.target_thread_title ?? "(untitled)"} ${spec.target_thread_id ?? "(missing)"}`,
      `  schedule: ${spec.rrule}`,
    );
    if (spec.blocker) {
      lines.push(`  blocker: ${spec.blocker}`);
    }
  }
  lines.push(result.plan.control.note);
  return `${lines.join("\n")}\n`;
}

function boundAppSessionForRoleSync(
  database: RuntimeDatabase,
  options: { role: AppLoopRole; taskId: string },
): { id: string; name: string } {
  const sessionJoin = options.role === "manager" ? "manager_session_id" : "worker_session_id";
  const row = database.prepare(`
    select s.id, s.name
    from bindings b
    join sessions s on s.id = b.${sessionJoin}
    where b.task_id = ? and b.state in ('active', 'ending') and s.role = ? and s.state = 'active'
    order by b.created_at desc
    limit 1
  `).get(options.taskId, options.role) as { id: string; name: string } | undefined;
  if (!row) {
    throw new Error(`No active bound ${options.role} session for task.`);
  }
  return row;
}

function runQaPlanCommand(parsed: ParsedRuntimeArgs): TypescriptRuntimeResult {
  const unsupported = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set(["json", "subtype"]),
    commandName: "qa-plan",
  });
  if (unsupported) {
    return errorResult(unsupported);
  }
  const scenario = parsed.flags.subtype ?? "self-management";
  const plan = qaPlan(scenario);
  if (parsed.flags.json) {
    return jsonResult(plan);
  }
  return { exitCode: 0, handled: true, stdout: renderQaPlanText(plan) };
}

function runQaRunCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedLoopCommandOptions(parsed, {
    allowedFlags: new Set(["dispatcherId", "json", "path", "receiptOutput", "subtype"]),
    commandName: "qa-run",
  });
  if (unsupported) {
    return errorResult(unsupported);
  }
  if (!parsed.flags.receiptOutput) {
    return errorResult("qa-run requires --receipt-output.");
  }
  const scenario = parsed.flags.subtype ?? "ralph-loop-guardrails";
  if (!isSupportedQaRunScenario(scenario)) {
    return errorResult(`Unsupported QA run scenario: ${scenario}`);
  }
  if (scenario === "generic-loop-template-browser") {
    try {
      preflightQaBrowserCapture();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`qa-run generic-loop-template-browser requires a launchable browser before writing receipts: ${message}`);
    }
  }
  const dbPath = resolve(expandUserPath(parsed.flags.path ?? join(tmpdir(), `workerctl-qa-run-${randomUUID()}`, "workerctl.db")));
  mkdirSync(dirname(dbPath), { recursive: true });
  const receiptOutput = resolve(expandUserPath(parsed.flags.receiptOutput));
  mkdirSync(dirname(receiptOutput), { recursive: true });
  const dispatcherId = parsed.flags.dispatcherId ?? `qa-run-${randomUUID().slice(0, 8)}`;
  const receipt = runQaScenario(scenario, {
    dbPath,
    dispatcherId,
    receiptOutput,
    runtimeOptions: options,
  });
  const finalReceipt = { ...receipt, receipt_path: receiptOutput };
  writeFileSync(receiptOutput, `${JSON.stringify(sortJson(finalReceipt), null, 2)}\n`);
  const summary = {
    checks: Array.isArray(finalReceipt.checks) ? finalReceipt.checks.length : 0,
    receipt_path: receiptOutput,
    result: finalReceipt.result,
    scenario: finalReceipt.scenario,
  };
  if (parsed.flags.json) {
    return jsonResult(summary);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: `QA run ${scenario}: ${finalReceipt.result}\nReceipt: ${receiptOutput}\n`,
  };
}

interface QaPlan {
  acceptance_criteria?: string[];
  authority_boundaries?: string[];
  correlation_markers?: Array<Record<string, string>>;
  evidence_template?: Record<string, unknown>;
  expected_observations: string[];
  scenario: string;
  starter_prompt?: string;
  steps: string[];
  trigger_tasks?: Array<Record<string, string>>;
}

const QA_PLAN_SCENARIOS = new Set([
  "self-management",
  "emergent-criteria",
  "tmux-errors",
  "dispatch-completion",
  "ralph-loop",
  "ship-it-loop",
  "adversarial-triggers",
  "goalbuddy-conveyor",
]);

function qaPlan(scenario: string): QaPlan {
  if (!QA_PLAN_SCENARIOS.has(scenario)) {
    throw new Error(`Unsupported QA scenario: ${scenario}`);
  }
  const sharedCleanup = [
    "Run conveyor audit <task> and conveyor replay <task>; verify the evidence chain is present.",
    "Run conveyor reconcile --stale-cycles-seconds 1 and git status --short --branch after cleanup.",
  ];
  if (scenario === "self-management") {
    return {
      expected_observations: [
        "tmux session hosts a live Codex worker process",
        "register-worker and register-manager record sessions with stable communication metadata",
        "conveyor cycle <task> returns kind, state, pane_signal, notable_pane_pattern, ingest, and cycle_id",
        "session-nudge reaches the worker and later cycles ingest new events",
        "conveyor reconcile reports no dangling bindings, dead pid sessions, or stuck tasks after cleanup",
      ],
      scenario,
      steps: [
        "Start a Codex worker inside tmux and capture its pid plus rollout JSONL path.",
        "Register the worker: conveyor register-worker --name foo --pid <WORKER_PID> --cwd \"$PWD\" --tmux-session codex-foo.",
        "Register the manager: conveyor register-manager --name foo-mgr --pid <MGR_PID> --cwd \"$PWD\".",
        "Create and bind the task: conveyor tasks --create my-task --goal \"QA: cycle and nudge flow\" && conveyor bind --task my-task --worker foo --manager foo-mgr.",
        "Run conveyor cycle my-task, conveyor session-nudge foo \"Status?\", and another conveyor cycle my-task.",
        ...sharedCleanup,
      ],
    };
  }
  if (scenario === "emergent-criteria") {
    return {
      expected_observations: [
        "manager_context.acceptance_criteria includes summary/open/proposed/satisfied/deferred/rejected",
        "criteria_negotiation.needed starts true before active criteria and turns false after criteria exist",
        "criteria-plan drafts reviewed conveyor criteria --add commands without mutation",
        "accepted criteria block finish-task --require-criteria-audit until satisfied, deferred, or rejected",
        "finish-task --stop-manager --stop-worker reports killed_worker and killed_manager for the pair",
        "criteria --list is used as the canonical task state",
      ],
      scenario,
      steps: [
        "Start a real pair with conveyor pair --task qa-emergent-criteria and a status-only worker prompt.",
        "Run conveyor cycle qa-emergent-criteria and verify manager_context.acceptance_criteria is present.",
        "Ask the worker for must-have current-task criteria and deferred follow-up criteria.",
        "Run conveyor criteria-plan qa-emergent-criteria --from-worker-response response.md --json and review suggestions.",
        "Record worker_proposed accepted and deferred criteria, then prove accepted criteria block premature audited finish.",
        "Satisfy accepted criteria with evidence_json receipts and rerun criteria --list, replay, and export-task.",
        ...sharedCleanup,
      ],
    };
  }
  if (scenario === "tmux-errors") {
    return {
      expected_observations: [
        "read-only commands preserve stable JSON output with actionable tmux error fields",
        "mutating commands that depend on tmux fail with nonzero exit and actionable stderr",
        "failed tmux send attempts do not leave misleading successful session_nudged events",
        "cycle reports pane_signal.degraded true while worker_alive and manager_alive remain meaningful",
        "live simulations are isolated to disposable sessions",
      ],
      scenario,
      steps: [
        "Record preflight: conveyor doctor-self --json, conveyor sessions --state active, tmux list-sessions, and git status --short --branch.",
        "Run PATH=/usr/bin:/bin conveyor doctor-self --json and verify missing-tmux JSON remains parseable.",
        "Run conveyor list --json and conveyor status <disposable-worker> under the same missing-tmux simulation.",
        "Force conveyor session-nudge <disposable-worker> to fail and verify nonzero exit plus no successful audit row.",
        "Run conveyor cycle <task> with the disposable pane unavailable and inspect pane_signal.degraded.",
        ...sharedCleanup,
      ],
    };
  }
  if (scenario === "dispatch-completion") {
    return {
      expected_observations: [
        "dispatch --once routes a bound worker task_complete signal from codex_events",
        "routed_notifications has worker_task_complete, source_event_id, correlation_id, delivered state, and source-event dedupe",
        "the manager receives a mechanical notification without Dispatch declaring success",
        "duplicate-route races emit dispatch_signal_suppressed telemetry",
        "mixed command-backed and completion-only chains appear in chronological order",
      ],
      scenario,
      steps: [
        "Create a disposable pair with conveyor pair --task qa-dispatch-completion.",
        "Run conveyor cycle until codex_events includes last_event_subtype task_complete.",
        "Run conveyor dispatch --once --type worker_task_complete --dispatcher-id qa-dispatch --json.",
        "Inspect conveyor audit and replay for routed_notifications and correlation_chains.",
        "Exercise or simulate a duplicate-route race and inspect dispatch_signal_suppressed telemetry.",
        ...sharedCleanup,
      ],
    };
  }
  if (scenario === "ralph-loop") {
    return {
      correlation_markers: [
        { correlation_id: "ralph-iter-1-pr", purpose: "PR readiness and URL receipt" },
        { correlation_id: "ralph-iter-1-ci-fix", purpose: "CI failure/fix retry receipt" },
        { correlation_id: "ralph-iter-1-clear", purpose: "audited worker context clear receipt" },
        { correlation_id: "ralph-iter-2-replay", purpose: "fresh-worker replay of the same seed prompt" },
        { correlation_id: "ralph-loop-ci-adversarial", purpose: "structured proof before fresh continuation" },
        { correlation_id: "ralph-loop-preset-missing", purpose: "preset missing-evidence block" },
        { correlation_id: "ralph-loop-preset-adversarial", purpose: "preset structured adversarial receipt" },
        { correlation_id: "ralph-loop-preset-allowed", purpose: "preset allowed retry" },
      ],
      evidence_template: {
        ci: { fix_result: "<green|not_needed>", initial_result: "<green|failed|simulated_failed>" },
        clear_receipt: { command_id: null, correlation_id: "ralph-iter-1-clear" },
        handoff_id: null,
        iteration: 1,
        manager_cycle_ids: [],
        merge: { permitted: false, result: "<merged|not_merged>" },
        pr: { url: null },
        seed_prompt_sha256: "<sha256>",
      },
      expected_observations: [
        "the run records at least two managed iterations from the same seed prompt",
        "PR creation is blocked until manager config permits repo.open_pr and records PR readiness",
        "merge is blocked until manager config permits repo.merge_green_pr and CI is green",
        "worker context clear is blocked until permission and handoff exist",
        "max_iterations and missing required evidence drills block before worker delivery",
      ],
      scenario,
      steps: [
        "Choose a disposable target repo, seed prompt, cleanup policy, CI expectation, and max iterations at least 2.",
        "List policies with conveyor ralph-loop-presets --list --json.",
        "Start iteration 1 with conveyor pair, configure manager permissions, and require criteria/epilogue closure.",
        "Capture liveness, PR, CI, merge, handoff, and audited clear receipts with the listed correlation markers.",
        "Start iteration 2 after audited clear with a fresh worker and inspect-first already-merged guard.",
        "Run max-iteration, missing-evidence, and preset evidence browser drills with Dispatch, audit, replay, commands, and worker-inbox proof.",
      ],
    };
  }
  if (scenario === "ship-it-loop") {
    return {
      authority_boundaries: [
        "Do not push a branch before repo.push_branch is permitted.",
        "Do not open or update a PR before repo.open_pr is permitted.",
        "Do not treat CI monitoring as CI truth; record explicit ci_green evidence.",
        "Do not resolve conflicts without a bounded manager instruction and retry limit.",
        "Do not merge before repo.merge_green_pr, ci_green, mergeability, manager_merge_decision, merge, post_merge_verification, and adversarial_check evidence exist.",
      ],
      correlation_markers: [
        { correlation_id: "ship-it-push-permission", purpose: "push branch permission gate" },
        { correlation_id: "ship-it-open-pr-permission", purpose: "open PR permission gate" },
        { correlation_id: "ship-it-merge-permission", purpose: "merge permission gate" },
        { correlation_id: "ship-it-missing-evidence", purpose: "missing lifecycle evidence block" },
        { correlation_id: "ship-it-conflict-block", purpose: "conflict retry limit proof" },
        { correlation_id: "ship-it-allowed-closeout", purpose: "allowed closeout after all lifecycle evidence" },
      ],
      evidence_template: {
        branch_ready: { branch: "<branch>", commit_sha: "<sha>" },
        branch_pushed: { remote: "origin", branch: "<branch>" },
        pr_url: { url: "<pull request URL>" },
        ci_green: { command: "gh pr checks --required", status: "green" },
        mergeability_clean: { conflicts: false, mergeable_state: "clean" },
        manager_merge_decision: { decision: "merge_ready", manager_verified: true },
        merge: { merge_sha: "<sha>" },
        post_merge_verification: { command: "<post-merge check>", status: "pass" },
        adversarial_check: { failure_mode: "<risk>", check: "<proof>", result: "<outcome>" },
      },
      expected_observations: [
        "push, PR creation, and merge commands fail closed until their manager permissions are granted",
        "missing lifecycle evidence blocks a continue_iteration before worker delivery",
        "unresolved conflicts are represented as bounded blockers, not hidden behind CI green",
        "a fresh retry delivers only after branch, PR, CI, mergeability, manager decision, merge, post-merge, and adversarial evidence exists",
        "the recipe and prompts keep merge readiness as a manager decision, not a worker claim",
      ],
      scenario,
      steps: [
        "Create a disposable no-tmux task with the ship_it_loop template.",
        "Run the permission-gate checks for repo.push_branch, repo.open_pr, and repo.merge_green_pr.",
        "Attempt a lifecycle continuation before evidence and verify missing evidence blocks before worker delivery.",
        "Record partial PR/CI evidence and verify mergeability/manager-decision/merge/post-merge proof is still required.",
        "Record conflict retry-limit evidence as blocked when unresolved.",
        "Record all lifecycle receipts plus structured adversarial proof and verify a fresh retry reaches the worker inbox.",
      ],
    };
  }
  if (scenario === "adversarial-triggers") {
    return {
      correlation_markers: [
        { correlation_id: "nl-loop-gate-policy", purpose: "loop gate prompt to Ralph policy" },
        { correlation_id: "nl-iteration-gate-missing-proof", purpose: "blocked continuation before proof" },
        { correlation_id: "nl-iteration-gate-adversarial-proof", purpose: "structured proof receipt" },
        { correlation_id: "nl-iteration-gate-allowed", purpose: "fresh allowed retry" },
        { correlation_id: "nl-finish-gate-proof", purpose: "finish-task adversarial proof" },
        { correlation_id: "nl-worker-directed-proof", purpose: "worker proposed proof" },
        { correlation_id: "nl-manager-criteria-negative-checks", purpose: "manager negative criteria" },
      ],
      expected_observations: [
        "controlled trigger phrases classify as matches and generic caution text does not",
        "iteration gate blocks continue_iteration before worker delivery until adversarial_check exists",
        "finish-task --require-adversarial-proof fails closed before structured proof",
        "worker-directed proof records source=worker_proposed evidence",
        "manager-inferred negative criteria name blocked Dispatch and structured evidence checks",
      ],
      scenario,
      steps: [
        "Run conveyor loop-triggers --classify for each controlled phrase and a generic negative control.",
        "Create a disposable no-tmux task with required_before_continue=[adversarial_check].",
        "Dispatch a continue_iteration before proof and verify blocked state plus empty worker inbox.",
        "Record structured adversarial proof, enqueue a fresh retry, and verify pull_required delivery.",
        "Record worker_proposed and manager_inferred adversarial criteria receipts.",
        ...sharedCleanup,
      ],
      trigger_tasks: listLoopTriggers().map((trigger) => ({
        acceptance: trigger.acceptance,
        name: trigger.name,
        trigger: trigger.canonical_phrase,
      })),
    };
  }
  return {
    acceptance_criteria: [
      "one active child board at a time",
      "PR URL, CI result, merge SHA, and satisfied_on_main receipts are recorded",
      "GoalBuddy checker passes",
      "negative receipt QA is preserved",
    ],
    authority_boundaries: [
      "Work exactly one child board at a time.",
      "Do not publish to npm automatically.",
      "Do not merge without green CI.",
      "Record PR URL, CI result, merge SHA, and final board evidence.",
    ],
    correlation_markers: [
      { correlation_id: "conveyor-parent-board", purpose: "parent GoalBuddy board source of truth" },
      { correlation_id: "conveyor-child-activation", purpose: "child board active task handoff" },
      { correlation_id: "conveyor-pr-ci-merge", purpose: "PR, CI, and merge receipt" },
      { correlation_id: "conveyor-satisfied-on-main", purpose: "main branch proof" },
      { correlation_id: "conveyor-adversarial-review", purpose: "negative review receipt" },
    ],
    expected_observations: [
      "there is one active child board",
      "receipts prove the slice is satisfied on main",
      "CI failures are inspected, fixed, and pushed before merge",
      "GoalBuddy checker passes after board updates",
    ],
    scenario,
    starter_prompt: "Create an autonomous GoalBuddy conveyor that runs vertical-slice child GoalBuddy prep boards until the migration is complete.",
    steps: [
      "Check the parent active_task points to the current child board.",
      "Run the implementation slice, local gates, review, PR, CI, and merge loop.",
      "If CI fails inspect logs, fix, push, and rerun CI.",
      "Record satisfied_on_main with PR URL, CI result, merge SHA, and negative receipt QA.",
    ],
  };
}

function renderQaPlanText(plan: QaPlan): string {
  const lines = [`QA plan: ${plan.scenario}`, ""];
  if (plan.starter_prompt) {
    lines.push("Starter prompt:", plan.starter_prompt, "");
  }
  if (plan.authority_boundaries) {
    lines.push("Authority boundaries:", ...plan.authority_boundaries.map((item) => `- ${item}`), "");
  }
  lines.push(...plan.steps.map((step, index) => `${index + 1}. ${step}`), "", "Expected observations:");
  lines.push(...plan.expected_observations.map((observation) => `- ${observation}`));
  if (plan.acceptance_criteria) {
    lines.push("", "Acceptance criteria:", ...plan.acceptance_criteria.map((criterion) => `- ${criterion}`));
  }
  if (plan.trigger_tasks) {
    lines.push("", "Trigger tasks:", ...plan.trigger_tasks.map((task) => `- ${task.name}: ${task.trigger} -> ${task.acceptance}`));
  }
  if (plan.correlation_markers) {
    lines.push("", "Correlation markers:", ...plan.correlation_markers.map((marker) => `- ${marker.correlation_id}: ${marker.purpose}`));
  }
  if (plan.evidence_template) {
    lines.push("", "Evidence template:", JSON.stringify(sortJson(plan.evidence_template), null, 2));
  }
  return `${lines.join("\n")}\n`;
}

interface QaRunContext {
  dbPath: string;
  dispatcherId: string;
  receiptOutput: string;
  runtimeOptions: { cwd?: string; env?: NodeJS.ProcessEnv };
}

interface QaGeneratedTask {
  binding_id?: string | null;
  manager_id?: string | null;
  manager_name?: string | null;
  suffix: string;
  task_id: string;
  task_name: string;
  worker_id?: string | null;
  worker_name?: string | null;
}

interface QaRunReceipt {
  artifacts: Record<string, unknown>;
  checks: Array<Record<string, unknown>>;
  generated_at: string;
  generated_tasks?: QaGeneratedTask[];
  replay_commands: string[];
  result: "passed";
  scenario: string;
  [key: string]: unknown;
}

const SUPPORTED_QA_RUN_SCENARIOS = new Set([
  "adversarial-triggers",
  "build-clear-loop",
  "generic-loop-template",
  "generic-loop-template-browser",
  "ralph-loop-guardrails",
  "ship-it-loop",
  "test-coverage-loop",
]);

function isSupportedQaRunScenario(scenario: string): boolean {
  return SUPPORTED_QA_RUN_SCENARIOS.has(scenario);
}

function runQaScenario(scenario: string, context: QaRunContext): QaRunReceipt {
  if (scenario === "ralph-loop-guardrails") {
    return qaRunRalphLoopGuardrails(context);
  }
  if (scenario === "generic-loop-template") {
    return qaRunEvidenceTemplate(context, {
      scenario,
      seed: "qa-run-generic-template-seed",
      template: "visual_diff_loop",
      suffix: "generic-loop-template",
      checkPrefix: "",
      artifactKind: "visual",
    });
  }
  if (scenario === "generic-loop-template-browser") {
    return qaRunEvidenceTemplate(context, {
      scenario,
      seed: "qa-run-generic-template-browser-seed",
      template: "visual_diff_loop",
      suffix: "generic-loop-template-browser",
      checkPrefix: "browser_",
      artifactKind: "browser_visual",
    });
  }
  if (scenario === "test-coverage-loop") {
    return qaRunEvidenceTemplate(context, {
      scenario,
      seed: "qa-run-test-coverage-seed",
      template: "test_coverage_loop",
      suffix: "test-coverage-loop",
      checkPrefix: "test_coverage_",
      artifactKind: "coverage",
    });
  }
  if (scenario === "build-clear-loop") {
    return qaRunBuildClearLoop(context);
  }
  if (scenario === "ship-it-loop") {
    return qaRunShipItLoop(context);
  }
  if (scenario === "adversarial-triggers") {
    return qaRunAdversarialTriggers(context);
  }
  throw new Error(`Unsupported QA run scenario: ${scenario}`);
}

function qaRunRalphLoopGuardrails(context: QaRunContext): QaRunReceipt {
  const slug = randomUUID().slice(0, 8);
  const checks: Array<Record<string, unknown>> = [];
  const maxTask = createQaBoundTask(context, slug, "max-iteration");
  const maxRun = createQaRalphLoopRun(context, maxTask, {
    currentIteration: 1,
    maxIterations: 1,
    metadata: {
      cleanup_policy: "clear",
      current_iteration: 1,
      kind: "ralph_loop",
      max_iterations: 1,
      required_before_continue: [],
      seed_prompt_sha256: "qa-run-seed",
      stop_conditions: ["max_iterations"],
    },
    seedPromptSha256: "qa-run-seed",
    stopConditions: ["max_iterations"],
  });
  enqueueQaContinue(context, maxTask, maxRun.id, "qa-run-max-block", "Run iteration 2.");
  const maxDispatch = qaDispatchContinueOnce(context, "qa-run-max-block");
  const maxCounts = qaDeliveryCounts(context, maxTask);
  qaExpectBlocked(maxDispatch, maxCounts, {
    message: "max-iteration drill",
    reason: "max_iterations_reached",
  });
  checks.push(qaCheck("max_iteration_blocks_before_worker_delivery", maxDispatch, maxCounts));

  const evidenceTask = createQaBoundTask(context, slug, "missing-evidence");
  const evidenceRun = createQaRalphLoopRun(context, evidenceTask, {
    currentIteration: 1,
    maxIterations: 3,
    metadata: {
      cleanup_policy: "clear",
      current_iteration: 1,
      kind: "ralph_loop",
      max_iterations: 3,
      required_before_continue: ["ci_green", "adversarial_check"],
      seed_prompt_sha256: "qa-run-seed",
      stop_conditions: ["max_iterations", "required_evidence"],
    },
    requiredBeforeContinue: ["ci_green", "adversarial_check"],
    seedPromptSha256: "qa-run-seed",
    stopConditions: ["max_iterations", "required_evidence"],
  });
  enqueueQaContinue(context, evidenceTask, evidenceRun.id, "qa-run-missing-evidence", "Run iteration 2 before evidence.");
  const missingDispatch = qaDispatchContinueOnce(context, "qa-run-missing-evidence");
  const missingCounts = qaDeliveryCounts(context, evidenceTask);
  qaExpectBlocked(missingDispatch, missingCounts, {
    message: "missing-evidence drill",
    missingEvidence: ["ci_green", "adversarial_check"],
    reason: "missing_required_evidence",
  });
  checks.push(qaCheck("missing_evidence_blocks_before_worker_delivery", missingDispatch, missingCounts));
  qaRecordLoopEvidence(context, evidenceTask, evidenceRun.id, "ci_green", "qa-run-ci-green", { status: "green" });
  qaRecordAdversarialEvidence(context, evidenceTask, evidenceRun.id, "qa-run-adversarial-proof", {
    check: "Inspect blocked dispatch result, empty inbox, and structured evidence receipt.",
    failure_mode: "A manager retry could reach the worker after CI green but before adversarial proof.",
    result: "The first retry stayed blocked until ci_green and adversarial_check receipts existed.",
  });
  enqueueQaContinue(context, evidenceTask, evidenceRun.id, "qa-run-evidence-allowed", "Run iteration 2 after CI and adversarial evidence.");
  const allowedDispatch = qaDispatchContinueOnce(context, "qa-run-evidence-allowed");
  const allowedCounts = qaDeliveryCounts(context, evidenceTask);
  qaExpectDelivered(allowedDispatch, allowedCounts, "fresh evidence retry");
  checks.push(qaCheck("fresh_retry_delivers_after_structured_evidence", allowedDispatch, allowedCounts));

  const presetTask = createQaBoundTask(context, slug, "preset");
  const presetMetadata = ralphLoopPresetMetadata("pr_ci_merge_loop", {
    currentIteration: 1,
    maxIterations: 3,
    seedPromptSha256: "qa-run-seed",
  });
  const presetRun = createQaRalphLoopRun(context, presetTask, {
    currentIteration: 1,
    maxIterations: 3,
    metadata: presetMetadata,
    preset: "pr_ci_merge_loop",
    requiredBeforeContinue: ["pr_url", "ci_green", "merge", "adversarial_check"],
    seedPromptSha256: "qa-run-seed",
    stopConditions: ["max_iterations", "required_evidence"],
  });
  enqueueQaContinue(context, presetTask, presetRun.id, "qa-run-preset-missing", "Run preset iteration 2 before evidence.");
  const presetBlock = qaDispatchContinueOnce(context, "qa-run-preset-missing");
  const presetBlockCounts = qaDeliveryCounts(context, presetTask);
  qaExpectBlocked(presetBlock, presetBlockCounts, {
    message: "preset evidence drill",
    missingEvidence: ["pr_url", "ci_green", "merge", "adversarial_check"],
    reason: "missing_required_evidence",
  });
  checks.push(qaCheck("preset_requires_pr_ci_merge_and_adversarial_evidence", presetBlock, presetBlockCounts));
  for (const evidenceType of ["pr_url", "ci_green", "merge"]) {
    qaRecordLoopEvidence(context, presetTask, presetRun.id, evidenceType, `qa-run-preset-${evidenceType}`, {
      status: evidenceType === "ci_green" ? "green" : "pass",
    });
  }
  qaRecordAdversarialEvidence(context, presetTask, presetRun.id, "qa-run-preset-adversarial", {
    check: "Inspect PR URL, CI, merge, and adversarial receipt set before retry.",
    failure_mode: "PR, CI, and merge receipts could still hide an unreviewed regression.",
    result: "All required preset receipts are present with structured adversarial proof.",
  });
  enqueueQaContinue(context, presetTask, presetRun.id, "qa-run-preset-allowed", "Run preset iteration 2 after all evidence.");
  const presetAllowed = qaDispatchContinueOnce(context, "qa-run-preset-allowed");
  const presetAllowedCounts = qaDeliveryCounts(context, presetTask);
  qaExpectDelivered(presetAllowed, presetAllowedCounts, "preset evidence retry");
  checks.push(qaCheck("preset_retry_delivers_after_all_required_evidence", presetAllowed, presetAllowedCounts));

  const helperSyntax = qaCodexReviewHelperSyntax();
  return {
    adversarial_review_gate: {
      codex_review_helper: helperSyntax.helper_path,
      recursion_guard_expected: "nested codex-review invocation blocked",
      syntax_check: {
        command: helperSyntax.command,
        returncode: helperSyntax.returncode,
      },
    },
    artifacts: { db_path: context.dbPath },
    checks,
    generated_at: new Date().toISOString(),
    generated_tasks: [
      generatedTask(maxTask, "max-iteration"),
      generatedTask(evidenceTask, "missing-evidence"),
      generatedTask(presetTask, "preset"),
    ],
    replay_commands: [
      "conveyor qa-plan ralph-loop --json",
      "conveyor qa-plan adversarial-triggers --json",
      `conveyor dispatch --once --type continue_iteration --dispatcher-id ${context.dispatcherId} --path ${context.dbPath}`,
      "conveyor loop-evidence adversarial-check <task> --loop-run <run-id> --iteration 1 --failure-mode <failure> --check <check> --result <result>",
    ],
    result: "passed",
    scenario: "ralph-loop-guardrails",
  };
}

function qaRunEvidenceTemplate(
  context: QaRunContext,
  options: {
    artifactKind: "browser_visual" | "coverage" | "visual";
    checkPrefix: string;
    scenario: string;
    seed: string;
    suffix: string;
    template: string;
  },
): QaRunReceipt {
  const slug = randomUUID().slice(0, 8);
  const task = createQaBoundTask(context, slug, options.suffix);
  const templateMetadata = loopTemplateMetadata(options.template, {
    currentIteration: 1,
    maxIterations: options.template === "test_coverage_loop" ? 3 : 4,
    seedPromptSha256: options.seed,
  });
  const requiredEvidence = asStringArray(templateMetadata.required_before_continue);
  const run = createQaRalphLoopRun(context, task, {
    currentIteration: 1,
    maxIterations: Number(templateMetadata.max_iterations),
    metadata: templateMetadata,
    preset: typeof templateMetadata.preset === "string" ? templateMetadata.preset : null,
    requiredBeforeContinue: requiredEvidence,
    seedPromptSha256: options.seed,
    stopConditions: asStringArray(templateMetadata.stop_conditions),
  });
  const checks: Array<Record<string, unknown>> = [];
  enqueueQaContinue(context, task, run.id, `qa-run-${options.suffix}-missing`, `Run ${options.template} iteration 2 before evidence.`);
  const missing = qaDispatchContinueOnce(context, `qa-run-${options.suffix}-missing`);
  const missingName = options.artifactKind === "coverage"
    ? "test_coverage_template_blocks_before_coverage_evidence"
    : `${options.checkPrefix}visual_template_blocks_before_visual_evidence`;
  const missingCounts = qaDeliveryCounts(context, task);
  qaExpectBlocked(missing, missingCounts, {
    message: `${options.template} missing-evidence drill`,
    missingEvidence: requiredEvidence,
    reason: "missing_required_evidence",
  });
  checks.push(qaCheck(missingName, missing, missingCounts));

  const artifactDir = qaArtifactDir(context, options.scenario, slug, run.id);
  const artifacts: Record<string, unknown> = { db_path: context.dbPath };
  let visualDiff: Record<string, unknown> | null = null;
  let browser: Record<string, unknown> | null = null;
  if (options.artifactKind === "coverage") {
    const coverageReport = join(artifactDir, "coverage-summary.json");
    mkdirSync(dirname(coverageReport), { recursive: true });
    writeFileSync(coverageReport, `${JSON.stringify(sortJson({
      command: "coverage run -m pytest && coverage report",
      coverage_percent: 87.5,
      status: "pass",
    }), null, 2)}\n`);
    artifacts.coverage_report = coverageReport;
    qaRecordLoopEvidence(context, task, run.id, "test_coverage", "qa-run-test-coverage-report", {
      artifactPath: coverageReport,
      metadata: { command: "coverage run -m pytest && coverage report", coverage_percent: 87.5 },
    });
  } else {
    const reference = join(artifactDir, "reference.png");
    const candidate = join(artifactDir, options.artifactKind === "browser_visual" ? "candidate-browser.png" : "candidate.png");
    const diff = join(artifactDir, "diff.png");
    const report = join(artifactDir, "visual-diff-report.json");
    writeQaPng(reference);
    if (options.artifactKind === "browser_visual") {
      const candidateHtml = join(artifactDir, "candidate.html");
      writeQaCandidateHtml(candidateHtml);
      browser = captureQaBrowserScreenshot(candidateHtml, candidate);
      artifacts.candidate_html = candidateHtml;
    } else {
      writeQaPng(candidate);
    }
    qaRecordLoopEvidence(context, task, run.id, "reference_artifact", "qa-run-template-reference", { artifactPath: reference });
    qaRecordLoopEvidence(context, task, run.id, "candidate_screenshot", "qa-run-template-candidate", {
      artifactPath: candidate,
      metadata: options.artifactKind === "browser_visual"
        ? { browser_backend: browser?.backend, candidate_html: browser?.html_path, viewport: browser?.viewport }
        : { viewport: "2x2" },
    });
    const visual = recordVisualDiffInQa(context, task, run.id, reference, candidate, diff, report);
    visualDiff = visual.diff as unknown as Record<string, unknown>;
    artifacts.diff = diff;
    artifacts.reference_artifact = reference;
    artifacts.candidate_screenshot = candidate;
    artifacts.visual_diff_report = report;
  }

  insertMalformedQaAdversarialEvidence(context, task, run.id, `qa-run-${options.suffix}-unstructured-adversarial`);
  enqueueQaContinue(context, task, run.id, `qa-run-${options.suffix}-unstructured-adversarial`, "Run after malformed adversarial proof.");
  const unstructured = qaDispatchContinueOnce(context, `qa-run-${options.suffix}-unstructured-adversarial`);
  const unstructuredName = options.artifactKind === "coverage"
    ? "test_coverage_unstructured_adversarial_check_still_blocks"
    : `${options.checkPrefix}unstructured_adversarial_check_still_blocks`;
  const unstructuredCounts = qaDeliveryCounts(context, task);
  qaExpectBlocked(unstructured, unstructuredCounts, {
    message: `${options.template} unstructured adversarial drill`,
    missingEvidence: ["adversarial_check"],
    reason: "missing_adversarial_check_evidence",
  });
  checks.push(qaCheck(unstructuredName, unstructured, unstructuredCounts));

  qaRecordAdversarialEvidence(context, task, run.id, `qa-run-${options.suffix}-structured-adversarial`, {
    check: "Inspect missing-evidence block, malformed adversarial block, and structured proof before retry.",
    failure_mode: "Evidence could exist without a structured adversarial proof for the same run and iteration.",
    result: "The malformed receipt stayed blocked and the structured retry delivered exactly one inbox item.",
  });
  enqueueQaContinue(context, task, run.id, `qa-run-${options.suffix}-structured-allowed`, "Run after structured proof.");
  const allowed = qaDispatchContinueOnce(context, `qa-run-${options.suffix}-structured-allowed`);
  const allowedName = options.artifactKind === "coverage"
    ? "structured_test_coverage_retry_delivers"
    : `${options.checkPrefix}structured_visual_evidence_retry_delivers`;
  const allowedCounts = qaDeliveryCounts(context, task);
  qaExpectDelivered(allowed, allowedCounts, `${options.template} structured retry`);
  checks.push(qaCheck(allowedName, allowed, allowedCounts));

  const replayCommands = [
    `conveyor loop-templates --show ${options.template} --json`,
    `conveyor loop-templates --create-run <task> --template ${options.template} --max-iterations ${templateMetadata.max_iterations} --current-iteration 1 --seed-prompt-sha256 ${options.seed}`,
  ];
  if (options.artifactKind === "browser_visual") {
    replayCommands.push("node scripts/capture-static-html-screenshot.mjs --html <candidate.html> --output <candidate-browser.png> --width 2 --height 2");
  }
  if (options.artifactKind === "coverage") {
    replayCommands.push("conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type test_coverage --artifact-path <coverage-summary.json>");
  } else {
    const candidateArtifact = options.artifactKind === "browser_visual" ? "<candidate-browser.png>" : "<candidate.png>";
    const candidateMetadata = options.artifactKind === "browser_visual"
      ? " --metadata-json '{\"browser_backend\":\"<backend>\",\"candidate_html\":\"<candidate.html>\",\"viewport\":\"2x2\"}'"
      : " --metadata-json '{\"viewport\":\"2x2\"}'";
    replayCommands.push(
      "conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type reference_artifact --artifact-path <reference.png>",
      `conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type candidate_screenshot --artifact-path ${candidateArtifact}${candidateMetadata}`,
      "conveyor loop-evidence visual-diff <task> --loop-run <run-id> --iteration 1 --reference <reference.png> --candidate "
        + `${candidateArtifact} --threshold 0 --diff-output <diff.png> --report-output <visual-diff-report.json>`,
    );
  }
  replayCommands.push(
    "conveyor loop-evidence adversarial-check <task> --loop-run <run-id> --iteration 1 --failure-mode <failure> --check <check> --result <result>",
    `conveyor dispatch --once --type continue_iteration --dispatcher-id ${context.dispatcherId} --path ${context.dbPath}`,
  );

  return {
    artifacts,
    ...(browser ? { browser, browser_capture: browser } : {}),
    checks,
    generated_at: new Date().toISOString(),
    generated_tasks: [generatedTask(task, options.suffix)],
    replay_commands: replayCommands,
    result: "passed",
    scenario: options.scenario,
    template: options.template,
    template_metadata: templateMetadata,
    ...(visualDiff ? { visual_diff: visualDiff } : {}),
  };
}

function qaRunBuildClearLoop(context: QaRunContext): QaRunReceipt {
  const slug = randomUUID().slice(0, 8);
  const task = createQaBoundTask(context, slug, "build-clear-loop");
  const templateMetadata = loopTemplateMetadata("build_then_clear", {
    currentIteration: 1,
    maxIterations: 2,
    seedPromptSha256: "qa-run-build-clear-seed",
  });
  const run = createQaRalphLoopRun(context, task, {
    currentIteration: 1,
    maxIterations: 2,
    metadata: templateMetadata,
    requiredBeforeContinue: ["build_passed", "cleanup"],
    seedPromptSha256: "qa-run-build-clear-seed",
    stopConditions: asStringArray(templateMetadata.stop_conditions),
  });
  const checks: Array<Record<string, unknown>> = [];
  enqueueQaContinue(context, task, run.id, "qa-run-build-clear-missing", "Run before build or cleanup evidence.");
  const missingDispatch = qaDispatchContinueOnce(context, "qa-run-build-clear-missing");
  const missingCounts = qaDeliveryCounts(context, task);
  qaExpectBlocked(missingDispatch, missingCounts, {
    message: "build_then_clear missing-evidence drill",
    missingEvidence: ["build_passed", "cleanup"],
    reason: "missing_required_evidence",
  });
  checks.push(qaCheck("build_clear_blocks_before_build_or_cleanup_evidence", missingDispatch, missingCounts));
  const artifactDir = qaArtifactDir(context, "build-clear-loop", slug, run.id);
  const buildReceipt = join(artifactDir, "build-passed.json");
  mkdirSync(dirname(buildReceipt), { recursive: true });
  writeFileSync(buildReceipt, `${JSON.stringify(sortJson({ command: "npm test -- --runInBand", result: "pass", status: "build_passed" }), null, 2)}\n`);
  qaRecordLoopEvidence(context, task, run.id, "build_passed", "qa-run-build-clear-build-passed", {
    artifactPath: buildReceipt,
    metadata: { command: "npm test -- --runInBand", result: "Focused build/test command passed before retry." },
  });
  enqueueQaContinue(context, task, run.id, "qa-run-build-clear-build-only", "Run after build evidence only.");
  const buildOnlyDispatch = qaDispatchContinueOnce(context, "qa-run-build-clear-build-only");
  const buildOnlyCounts = qaDeliveryCounts(context, task);
  qaExpectBlocked(buildOnlyDispatch, buildOnlyCounts, {
    message: "build_then_clear cleanup drill",
    missingEvidence: ["cleanup"],
    reason: "missing_cleanup_evidence",
  });
  checks.push(qaCheck("build_clear_still_blocks_before_cleanup_evidence", buildOnlyDispatch, buildOnlyCounts));
  const cleanupReceipt = join(artifactDir, "cleanup.json");
  writeFileSync(cleanupReceipt, `${JSON.stringify(sortJson({ cleanup_policy: "clear", result: "pass", status: "cleanup" }), null, 2)}\n`);
  qaRecordLoopEvidence(context, task, run.id, "cleanup", "qa-run-build-clear-cleanup", {
    artifactPath: cleanupReceipt,
    metadata: { cleanup_policy: "clear", result: "Worker context clear receipt recorded before retry." },
  });
  enqueueQaContinue(context, task, run.id, "qa-run-build-clear-allowed", "Run after build and cleanup evidence.");
  const allowedDispatch = qaDispatchContinueOnce(context, "qa-run-build-clear-allowed");
  const allowedCounts = qaDeliveryCounts(context, task);
  qaExpectDelivered(allowedDispatch, allowedCounts, "build_then_clear retry");
  checks.push(qaCheck("build_clear_retry_delivers_after_build_and_cleanup_evidence", allowedDispatch, allowedCounts));
  return {
    artifacts: { build_receipt: buildReceipt, cleanup_receipt: cleanupReceipt, db_path: context.dbPath },
    checks,
    generated_at: new Date().toISOString(),
    generated_tasks: [generatedTask(task, "build-clear-loop")],
    replay_commands: [
      "conveyor loop-templates --show build_then_clear --json",
      "conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type build_passed --artifact-path <build-passed.json>",
      "conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type cleanup --artifact-path <cleanup.json>",
      `conveyor dispatch --once --type continue_iteration --dispatcher-id ${context.dispatcherId} --path ${context.dbPath}`,
      `conveyor worker-inbox <task> --consume-next --wait --path ${context.dbPath} --json`,
    ],
    result: "passed",
    scenario: "build-clear-loop",
    template: "build_then_clear",
    template_metadata: templateMetadata,
  };
}

function qaRunShipItLoop(context: QaRunContext): QaRunReceipt {
  const slug = randomUUID().slice(0, 8);
  const checks: Array<Record<string, unknown>> = [];
  const generatedTasks: QaGeneratedTask[] = [];

  const pushTask = createQaBoundTask(context, slug, "ship-it-push-permission");
  generatedTasks.push(generatedTask(pushTask, "ship-it-push-permission"));
  checks.push(qaRunPermissionGate(context, pushTask, {
    checkName: "ship_it_push_branch_requires_repo_push_branch",
    correlationId: "ship-it-push-permission-denied",
    message: "Push branch origin/codex/ship-it-loop.",
    permission: "repo.push_branch",
  }));
  qaConfigureManagerPermissions(context, pushTask, ["repo.push_branch"]);
  checks.push(qaRunPermissionGate(context, pushTask, {
    checkName: "ship_it_push_branch_delivers_after_permission",
    correlationId: "ship-it-push-permission-allowed",
    expectAllowed: true,
    message: "Push branch origin/codex/ship-it-loop after manager permission.",
    permission: "repo.push_branch",
  }));

  const prTask = createQaBoundTask(context, slug, "ship-it-open-pr-permission");
  generatedTasks.push(generatedTask(prTask, "ship-it-open-pr-permission"));
  checks.push(qaRunPermissionGate(context, prTask, {
    checkName: "ship_it_open_pr_requires_repo_open_pr",
    correlationId: "ship-it-open-pr-permission-denied",
    message: "Open PR for ship-it loop.",
    permission: "repo.open_pr",
  }));
  qaConfigureManagerPermissions(context, prTask, ["repo.open_pr"]);
  checks.push(qaRunPermissionGate(context, prTask, {
    checkName: "ship_it_open_pr_delivers_after_permission",
    correlationId: "ship-it-open-pr-permission-allowed",
    expectAllowed: true,
    message: "Open PR for ship-it loop after manager permission.",
    permission: "repo.open_pr",
  }));

  const mergeTask = createQaBoundTask(context, slug, "ship-it-merge-permission");
  generatedTasks.push(generatedTask(mergeTask, "ship-it-merge-permission"));
  checks.push(qaRunPermissionGate(context, mergeTask, {
    checkName: "ship_it_merge_requires_repo_merge_green_pr",
    correlationId: "ship-it-merge-permission-denied",
    message: "Merge PR after verified closeout.",
    permission: "repo.merge_green_pr",
  }));
  qaConfigureManagerPermissions(context, mergeTask, ["repo.merge_green_pr"]);
  checks.push(qaRunPermissionGate(context, mergeTask, {
    checkName: "ship_it_merge_delivers_after_permission",
    correlationId: "ship-it-merge-permission-allowed",
    expectAllowed: true,
    message: "Merge PR after verified closeout and manager permission.",
    permission: "repo.merge_green_pr",
  }));

  const lifecycleTask = createQaBoundTask(context, slug, "ship-it-lifecycle");
  generatedTasks.push(generatedTask(lifecycleTask, "ship-it-lifecycle"));
  const templateMetadata = loopTemplateMetadata("ship_it_loop", {
    currentIteration: 1,
    maxIterations: 2,
    seedPromptSha256: "qa-run-ship-it-seed",
  });
  const run = createQaRalphLoopRun(context, lifecycleTask, {
    currentIteration: 1,
    maxIterations: 2,
    metadata: templateMetadata,
    preset: "ship_it_loop",
    requiredBeforeContinue: asStringArray(templateMetadata.required_before_continue),
    seedPromptSha256: "qa-run-ship-it-seed",
    stopConditions: asStringArray(templateMetadata.stop_conditions),
  });
  enqueueQaContinue(context, lifecycleTask, run.id, "ship-it-missing-evidence", "Run ship-it continuation before lifecycle evidence.");
  const missing = qaDispatchContinueOnce(context, "ship-it-missing-evidence");
  const missingCounts = qaDeliveryCounts(context, lifecycleTask);
  qaExpectBlocked(missing, missingCounts, {
    message: "ship_it_loop missing lifecycle evidence",
    missingEvidence: asStringArray(templateMetadata.required_before_continue),
    reason: "missing_required_evidence",
  });
  checks.push(qaCheck("ship_it_lifecycle_blocks_before_any_evidence", missing, missingCounts));

  qaRecordLoopEvidence(context, lifecycleTask, run.id, "branch_ready", "ship-it-branch-ready", {
    metadata: { branch: "codex/ship-it-loop", commit_sha: "1111111111111111111111111111111111111111" },
  });
  qaRecordLoopEvidence(context, lifecycleTask, run.id, "branch_pushed", "ship-it-branch-pushed", {
    metadata: { branch: "codex/ship-it-loop", remote: "origin" },
  });
  qaRecordLoopEvidence(context, lifecycleTask, run.id, "pr_url", "ship-it-pr-url", {
    metadata: { url: "https://github.example.test/acme/repo/pull/42" },
  });
  qaRecordLoopEvidence(context, lifecycleTask, run.id, "ci_green", "ship-it-ci-green", {
    metadata: { command: "gh pr checks 42 --required", status: "green" },
    status: "green",
  });
  enqueueQaContinue(context, lifecycleTask, run.id, "ship-it-partial-evidence", "Run ship-it continuation after PR and CI but before merge readiness.");
  const partial = qaDispatchContinueOnce(context, "ship-it-partial-evidence");
  const partialCounts = qaDeliveryCounts(context, lifecycleTask);
  qaExpectBlocked(partial, partialCounts, {
    message: "ship_it_loop partial lifecycle evidence",
    missingEvidence: ["mergeability_clean", "manager_merge_decision", "merge", "post_merge_verification", "adversarial_check"],
    reason: "missing_required_evidence",
  });
  checks.push(qaCheck("ship_it_lifecycle_blocks_before_mergeability_and_manager_decision", partial, partialCounts));

  const artifactDir = qaArtifactDir(context, "ship-it-loop", slug, run.id);
  const conflictReceipt = join(artifactDir, "conflict-blocked.json");
  mkdirSync(dirname(conflictReceipt), { recursive: true });
  const conflictPayload = {
    conflict_state: "unresolved",
    max_retries: 2,
    retry_count: 2,
    status: "blocked",
    stop_reason: "conflict_retry_limit_reached",
  };
  writeFileSync(conflictReceipt, `${JSON.stringify(sortJson(conflictPayload), null, 2)}\n`);
  checks.push({
    artifact_path: conflictReceipt,
    conflict: conflictPayload,
    name: "ship_it_conflict_retry_blocks_after_limit",
    status: "passed",
  });

  qaRecordLoopEvidence(context, lifecycleTask, run.id, "mergeability_clean", "ship-it-mergeability-clean", {
    metadata: { conflicts: false, mergeable_state: "clean" },
  });
  qaRecordLoopEvidence(context, lifecycleTask, run.id, "manager_merge_decision", "ship-it-manager-merge-decision", {
    metadata: { decision: "merge_ready", manager_verified: true },
  });
  qaRecordLoopEvidence(context, lifecycleTask, run.id, "merge", "ship-it-merge", {
    metadata: { merge_sha: "2222222222222222222222222222222222222222" },
  });
  qaRecordLoopEvidence(context, lifecycleTask, run.id, "post_merge_verification", "ship-it-post-merge-verification", {
    metadata: { command: "git rev-parse HEAD && npm test -- --runInBand", status: "pass" },
  });
  qaRecordAdversarialEvidence(context, lifecycleTask, run.id, "ship-it-adversarial-proof", {
    check: "Inspect permission denials, missing-evidence blocks, conflict retry receipt, and final evidence set.",
    failure_mode: "A ship-it loop could merge after CI green while conflicts, manager decision, or post-merge proof are missing.",
    result: "Dispatch stayed blocked until mergeability, manager decision, merge, post-merge, and adversarial receipts were present.",
  });
  enqueueQaContinue(context, lifecycleTask, run.id, "ship-it-allowed-closeout", "Run ship-it continuation after all lifecycle evidence.");
  const allowed = qaDispatchContinueOnce(context, "ship-it-allowed-closeout");
  const allowedCounts = qaDeliveryCounts(context, lifecycleTask);
  qaExpectDelivered(allowed, allowedCounts, "ship_it_loop allowed closeout");
  checks.push(qaCheck("ship_it_lifecycle_retry_delivers_after_all_evidence", allowed, allowedCounts));

  return {
    artifacts: { conflict_receipt: conflictReceipt, db_path: context.dbPath },
    checks,
    generated_at: new Date().toISOString(),
    generated_tasks: generatedTasks,
    replay_commands: [
      "conveyor loop-templates --show ship_it_loop --json",
      "conveyor manager-recipes --show ship-it-loop --json",
      "conveyor manager-permission <task> repo.push_branch --require",
      "conveyor manager-permission <task> repo.open_pr --require",
      "conveyor manager-permission <task> repo.merge_green_pr --require",
      "conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type branch_ready",
      "conveyor loop-evidence add <task> --loop-run <run-id> --iteration 1 --evidence-type ci_green",
      "conveyor loop-evidence adversarial-check <task> --loop-run <run-id> --iteration 1 --failure-mode <failure> --check <check> --result <result>",
      `conveyor dispatch --once --type continue_iteration --dispatcher-id ${context.dispatcherId} --path ${context.dbPath}`,
    ],
    result: "passed",
    scenario: "ship-it-loop",
    template: "ship_it_loop",
    template_metadata: templateMetadata,
  };
}

function qaRunAdversarialTriggers(context: QaRunContext): QaRunReceipt {
  const slug = randomUUID().slice(0, 8);
  const triggerDefinitions = listLoopTriggers();
  const triggerClassifications = triggerDefinitions.map((trigger) => {
    const classification = classifyLoopTrigger(trigger.canonical_phrase);
    return {
      canonical_phrase: trigger.canonical_phrase,
      intent: classification.matched_trigger?.intent ?? null,
      matched: classification.matched,
      matched_name: classification.matched_trigger?.name ?? null,
      name: trigger.name,
    };
  });
  const negativeControl = classifyLoopTrigger("Please be careful, run tests, and summarize the risks before finishing.");
  const checks: Array<Record<string, unknown>> = [];
  for (const classification of triggerClassifications) {
    qaRequire(classification.matched === true, `trigger ${classification.name} did not match its canonical phrase`);
    qaRequire(classification.matched_name === classification.name, `trigger ${classification.name} matched ${String(classification.matched_name)}`);
  }
  qaRequire(negativeControl.matched !== true, "generic caution text matched an adversarial trigger");
  checks.push({
    controlled_triggers: triggerClassifications,
    name: "trigger_classification_matches_controlled_phrases",
    negative_control: {
      matched: negativeControl.matched,
      prompt: "Please be careful, run tests, and summarize the risks before finishing.",
    },
    status: "passed",
  });
  const loopTask = createQaBoundTask(context, slug, "adversarial-triggers-loop");
  const run = createQaRalphLoopRun(context, loopTask, {
    currentIteration: 1,
    maxIterations: 3,
    metadata: {
      cleanup_policy: "clear",
      correlation_id: "nl-loop-gate-policy",
      current_iteration: 1,
      kind: "ralph_loop",
      max_iterations: 3,
      required_before_continue: ["adversarial_check"],
      seed_prompt_sha256: "qa-run-nl-loop-trigger-seed",
      stop_conditions: ["max_iterations", "required_evidence"],
      trigger: "Run this as an adversarially gated Ralph loop.",
      trigger_intent: "create_loop_policy",
    },
    requiredBeforeContinue: ["adversarial_check"],
    seedPromptSha256: "qa-run-nl-loop-trigger-seed",
    stopConditions: ["max_iterations", "required_evidence"],
  });
  checks.push({
    correlation_id: "nl-loop-gate-policy",
    name: "loop_gate_trigger_creates_policy",
    run: {
      current_iteration: run.metadata.current_iteration,
      id: run.id,
      max_iterations: run.metadata.max_iterations,
      required_before_continue: run.metadata.required_before_continue,
    },
    status: "passed",
    trigger: "Run this as an adversarially gated Ralph loop.",
  });
  enqueueQaContinue(context, loopTask, run.id, "nl-iteration-gate-missing-proof", "Run iteration 2 before adversarial proof.");
  const missingDispatch = qaDispatchContinueOnce(context, "nl-iteration-gate-missing-proof");
  const missingCounts = qaDeliveryCounts(context, loopTask);
  qaExpectBlocked(missingDispatch, missingCounts, {
    message: "natural-language iteration gate",
    missingEvidence: ["adversarial_check"],
    reason: "missing_adversarial_check_evidence",
  });
  checks.push(qaCheck("iteration_gate_blocks_before_adversarial_proof", missingDispatch, missingCounts));
  qaRecordAdversarialEvidence(context, loopTask, run.id, "nl-iteration-gate-adversarial-proof", {
    check: "Inspect blocked Dispatch result, empty worker inbox, and structured adversarial_check receipt.",
    failure_mode: "A manager's natural-language retry could reach the worker before adversarial proof exists.",
    result: "The first continuation was blocked before worker delivery; only a fresh retry after proof is allowed.",
  });
  enqueueQaContinue(context, loopTask, run.id, "nl-iteration-gate-allowed", "Run iteration 2 after adversarial proof.");
  const allowedDispatch = qaDispatchContinueOnce(context, "nl-iteration-gate-allowed");
  const allowedCounts = qaDeliveryCounts(context, loopTask);
  qaExpectDelivered(allowedDispatch, allowedCounts, "natural-language iteration gate retry");
  const allowedCheck = qaCheck("iteration_gate_allows_fresh_retry_after_structured_proof", allowedDispatch, allowedCounts);
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const consumed = consumeNextSessionInboxItemSync(database, { sessionName: loopTask.worker_name });
    qaRequire(consumed !== null, "natural-language iteration gate retry worker inbox item could not be consumed");
    allowedCheck.worker_inbox = consumed;
  } finally {
    database.close();
  }
  checks.push(allowedCheck);
  const finishTask = createQaUnboundTask(context, slug, "adversarial-triggers-finish");
  const prematureFinish = qaFinishTaskWithAdversarialGate(context, finishTask.task_name, "Done without proof.");
  qaRequire(prematureFinish.returncode === 1, `finish gate succeeded before proof: ${prematureFinish.stdout}`);
  qaRequire(prematureFinish.stderr.includes("adversarial proof is required"), `finish gate used the wrong failure: ${prematureFinish.stderr}`);
  const finishEvidence = qaRecordTaskAdversarialProof(context, finishTask, "nl-finish-gate-proof", {
    check: "Run finish-task --require-adversarial-proof before and after structured adversarial evidence.",
    failure_mode: "The finish gate could regress and allow a task to be marked done without proof.",
    result: "finish-task failed before proof and succeeded only after structured adversarial evidence was recorded.",
  });
  const afterProofFinish = qaFinishTaskWithAdversarialGate(context, finishTask.task_name, "Proof exists.");
  qaRequire(afterProofFinish.returncode === 0, `finish gate failed after proof: ${afterProofFinish.stderr}`);
  checks.push({
    after_proof: afterProofFinish,
    evidence: finishEvidence.evidence,
    name: "finish_gate_requires_structured_adversarial_proof",
    premature_finish: prematureFinish,
    status: "passed",
    trigger: "Do not mark this done until you have tried to disprove it.",
  });
  const workerTask = createQaBoundTask(context, slug, "adversarial-triggers-worker");
  const workerRun = createQaRalphLoopRun(context, workerTask, {
    currentIteration: 1,
    maxIterations: 2,
    metadata: { current_iteration: 1, kind: "ralph_loop", max_iterations: 2, required_before_continue: ["adversarial_check"] },
    requiredBeforeContinue: ["adversarial_check"],
    stopConditions: ["required_evidence"],
  });
  const workerEvidence = qaRecordAdversarialEvidence(context, workerTask, workerRun.id, "nl-worker-directed-proof", {
    check: "Inspect blocked dispatch receipt and post-proof worker inbox delivery.",
    failure_mode: "The worker could claim completion without checking the dispatcher gate.",
    result: "The receipt chain proves blocked-before-proof and delivered-after-proof behavior.",
  }, "worker_proposed");
  checks.push({
    evidence: { ...workerEvidence.evidence, source: workerEvidence.criterion.source },
    name: "worker_directed_trigger_records_worker_proposed_proof",
    status: "passed",
    trigger: "Ask the worker to identify the strongest realistic failure mode and prove it is handled.",
  });
  const criteriaTask = createQaBoundTask(context, slug, "adversarial-triggers-criteria");
  const criteria = insertQaManagerCriteria(context, criteriaTask);
  checks.push({
    criteria,
    manager_inferred_criteria_count: criteria.length,
    name: "acceptance_criteria_trigger_records_negative_manager_criteria",
    status: "passed",
    trigger: "Each loop must include adversarial acceptance criteria from manager to worker.",
  });
  return {
    artifacts: { db_path: context.dbPath },
    checks,
    generated_at: new Date().toISOString(),
    generated_tasks: [
      generatedTask(loopTask, "adversarial-triggers-loop"),
      generatedTask(finishTask, "adversarial-triggers-finish"),
      generatedTask(workerTask, "adversarial-triggers-worker"),
      generatedTask(criteriaTask, "adversarial-triggers-criteria"),
    ],
    negative_control: negativeControl,
    replay_commands: [
      "conveyor loop-triggers --classify \"Run this as an adversarially gated Ralph loop.\" --json",
      "conveyor qa-plan adversarial-triggers --json",
      `conveyor dispatch --once --type continue_iteration --dispatcher-id ${context.dispatcherId} --path ${context.dbPath}`,
      `conveyor worker-inbox ${loopTask.task_name} --path ${context.dbPath} --json`,
      `conveyor export-task ${loopTask.task_name} --path ${context.dbPath}`,
    ],
    result: "passed",
    scenario: "adversarial-triggers",
    trigger_classifications: triggerClassifications,
  };
}

function qaFinishTaskWithAdversarialGate(context: QaRunContext, taskName: string, reason: string): { returncode: number; stderr: string; stdout: string } {
  const result = runTypescriptRuntimeCommand({
    ...context.runtimeOptions,
    args: ["finish-task", taskName, "--require-adversarial-proof", "--reason", reason, "--path", context.dbPath],
    env: {
      ...(context.runtimeOptions.env ?? {}),
      AGENT_CONVEYOR_TS_RUNTIME: "1",
    },
  });
  return {
    returncode: result.exitCode,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function createQaBoundTask(context: QaRunContext, slug: string, suffix: string): QaGeneratedTask & {
  binding_id: string;
  manager_id: string;
  manager_name: string;
  worker_id: string;
  worker_name: string;
} {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    qaRequireCleanContinueQueue(database);
    const taskName = `qa-${suffix}-${slug}`;
    const workerName = `${taskName}-worker`;
    const managerName = `${taskName}-manager`;
    const taskId = createTaskSync(database, {
      goal: `Executable QA run for ${suffix}.`,
      name: taskName,
      summary: "Disposable no-tmux manager/worker binding for Dispatch guardrail proof.",
    });
    database.prepare("update tasks set state = 'managed' where id = ?").run(taskId);
    const sessionDir = join(dirname(context.dbPath), "qa-sessions");
    const workerRollout = writeQaRollout(sessionDir, workerName, context.runtimeOptions.cwd ?? process.cwd());
    const managerRollout = writeQaRollout(sessionDir, managerName, context.runtimeOptions.cwd ?? process.cwd());
    const worker = registerSessionSync(database, {
      codexSessionPath: workerRollout,
      cwd: context.runtimeOptions.cwd ?? process.cwd(),
      name: workerName,
      pid: process.pid,
      role: "worker",
      tmuxSession: null,
    });
    const manager = registerSessionSync(database, {
      codexSessionPath: managerRollout,
      cwd: context.runtimeOptions.cwd ?? process.cwd(),
      name: managerName,
      pid: process.pid,
      role: "manager",
      tmuxSession: null,
    });
    const bindingId = bindSessionsSync(database, {
      managerSessionName: managerName,
      taskName,
      workerSessionName: workerName,
    });
    return {
      binding_id: bindingId,
      manager_id: manager.session_id,
      manager_name: managerName,
      suffix,
      task_id: taskId,
      task_name: taskName,
      worker_id: worker.session_id,
      worker_name: workerName,
    };
  } finally {
    database.close();
  }
}

function createQaUnboundTask(context: QaRunContext, slug: string, suffix: string): QaGeneratedTask {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const taskName = `qa-${suffix}-${slug}`;
    const taskId = createTaskSync(database, {
      goal: `Executable QA run for ${suffix}.`,
      name: taskName,
      summary: "Disposable unbound task for finish-task adversarial proof verification.",
    });
    return {
      binding_id: null,
      manager_id: null,
      manager_name: null,
      suffix,
      task_id: taskId,
      task_name: taskName,
      worker_id: null,
      worker_name: null,
    };
  } finally {
    database.close();
  }
}

function createQaRalphLoopRun(
  context: QaRunContext,
  task: QaGeneratedTask,
  options: {
    currentIteration: number;
    maxIterations: number;
    metadata: Record<string, unknown>;
    preset?: string | null;
    requiredBeforeContinue?: string[];
    seedPromptSha256?: string | null;
    stopConditions?: string[];
  },
): RalphLoopRunRow {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return createRalphLoopRunSync(database, {
      cleanupPolicy: typeof options.metadata.cleanup_policy === "string" ? options.metadata.cleanup_policy : "clear",
      currentIteration: options.currentIteration,
      maxIterations: options.maxIterations,
      metadata: options.metadata,
      preset: options.preset ?? null,
      requiredBeforeContinue: options.requiredBeforeContinue ?? asStringArray(options.metadata.required_before_continue),
      runName: `${task.task_name}-run`,
      seedPromptSha256: options.seedPromptSha256 ?? null,
      stopConditions: options.stopConditions ?? asStringArray(options.metadata.stop_conditions),
      taskId: task.task_id,
      taskName: task.task_name,
    });
  } finally {
    database.close();
  }
}

function enqueueQaContinue(
  context: QaRunContext,
  task: QaGeneratedTask,
  runId: string,
  correlationId: string,
  message: string,
): void {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const run = ralphLoopRunForEnqueue(database, runId);
    createCommandSync(database, {
      commandType: "continue_iteration",
      correlationId,
      payload: {
        loop_policy: enqueueLoopPolicyPayload(run),
        message,
        ralph_loop: { requested_iteration: 2, run_id: run.id },
      },
      taskId: task.task_id,
    });
  } finally {
    database.close();
  }
}

function qaDispatchContinueOnce(context: QaRunContext, expectedCorrelationId: string): Record<string, unknown> {
  return qaDispatchCommandOnce(context, "continue_iteration", expectedCorrelationId);
}

function qaDispatchCommandOnce(context: QaRunContext, commandType: string, expectedCorrelationId: string): Record<string, unknown> {
  const before = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(before);
    const rows = before.prepare(`
      select correlation_id, state
      from commands
      where type = ? and state in ('pending', 'attempted')
      order by created_at, id
    `).all(commandType) as Array<{ correlation_id: string | null; state: string }>;
    const seen = rows.map((row) => `${row.correlation_id}:${row.state}`);
    if (rows.length !== 1 || rows[0]?.correlation_id !== expectedCorrelationId || rows[0]?.state !== "pending") {
      throw new Error(`qa-run ${commandType} dispatch queue is not clean; expected only ${expectedCorrelationId}, found ${JSON.stringify(seen)}`);
    }
  } finally {
    before.close();
  }
  const parsed = parseRuntimeArgs(["dispatch", "--type", commandType, "--path", context.dbPath], {
    AGENT_CONVEYOR_TS_RUNTIME: "1",
  });
  const processed = dispatchOncePass(parsed, context.runtimeOptions, {
    dispatcherId: context.dispatcherId,
    dryRun: false,
    leaseSeconds: 60,
    limit: 1,
  }) as Record<string, unknown>[];
  if (processed.length !== 1) {
    throw new Error(`expected exactly one ${commandType} dispatch item, got ${processed.length}`);
  }
  if (processed[0]?.correlation_id !== expectedCorrelationId) {
    throw new Error(`qa-run dispatched unexpected command ${String(processed[0]?.correlation_id)}`);
  }
  return processed[0] ?? {};
}

function qaConfigureManagerPermissions(context: QaRunContext, task: QaGeneratedTask, permissions: string[]): void {
  const result = runTypescriptRuntimeCommand({
    ...context.runtimeOptions,
    args: [
      "manager-config",
      task.task_name,
      "--mode",
      "strict",
      "--objective",
      "Ship-it lifecycle QA permission contract.",
      ...permissions.flatMap((permission) => ["--permit", permission]),
      "--path",
      context.dbPath,
    ],
    env: {
      ...(context.runtimeOptions.env ?? {}),
      AGENT_CONVEYOR_TS_RUNTIME: "1",
    },
  });
  qaRequire(result.exitCode === 0, `manager-config permission setup failed: ${result.stderr ?? result.stdout ?? ""}`);
}

function qaRunPermissionGate(
  context: QaRunContext,
  task: QaGeneratedTask,
  options: {
    checkName: string;
    correlationId: string;
    expectAllowed?: boolean;
    message: string;
    permission: string;
  },
): Record<string, unknown> {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    createCommandSync(database, {
      commandType: "nudge_worker",
      correlationId: options.correlationId,
      payload: { message: options.message, ship_it: { required_permission: options.permission } },
      requiredPermission: options.permission,
      taskId: task.task_id,
    });
  } finally {
    database.close();
  }
  const dispatch = qaDispatchCommandOnce(context, "nudge_worker", options.correlationId);
  const counts = qaDeliveryCounts(context, task);
  if (options.expectAllowed === true) {
    qaExpectDelivered(dispatch, counts, `${options.permission} permission gate`);
  } else {
    qaRequire(dispatch.state === "failed", `${options.permission} gate did not fail without permission`);
    qaRequire(String(dispatch.error ?? "").includes("manager permission required"), `${options.permission} gate failed for the wrong reason`);
    qaRequire(counts.worker_inbox_count === 0, `${options.permission} denied gate left worker inbox mail`);
  }
  return {
    ...counts,
    command_type: "nudge_worker",
    dispatch,
    name: options.checkName,
    permission: options.permission,
    status: "passed",
  };
}

function qaDeliveryCounts(context: QaRunContext, task: QaGeneratedTask): Record<string, number> {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return {
      routed_notifications_count: routedNotificationsSync(database, { taskId: task.task_id }).length,
      worker_inbox_count: task.worker_name ? sessionInboxSync(database, { sessionName: task.worker_name }).length : 0,
    };
  } finally {
    database.close();
  }
}

function qaRequire(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`qa-run invariant failed: ${message}`);
  }
}

function qaExpectBlocked(
  dispatch: Record<string, unknown>,
  counts: Record<string, number>,
  options: { message: string; missingEvidence?: string[]; reason: string },
): void {
  qaRequire(dispatch.state === "blocked", `${options.message} did not block`);
  qaRequire(dispatch.reason === options.reason, `${options.message} used the wrong block reason`);
  if (options.missingEvidence) {
    qaRequire(
      JSON.stringify(dispatch.missing_evidence ?? []) === JSON.stringify(options.missingEvidence),
      `${options.message} reported the wrong missing evidence`,
    );
  }
  qaRequire(dispatch.target_worker_notified !== true, `${options.message} notified the worker`);
  qaRequire(counts.routed_notifications_count === 0, `${options.message} created a routed notification`);
  qaRequire(counts.worker_inbox_count === 0, `${options.message} left worker inbox mail`);
}

function qaExpectDelivered(dispatch: Record<string, unknown>, counts: Record<string, number>, message: string): void {
  qaRequire(dispatch.state === "pull_required", `${message} did not deliver to the pull inbox`);
  qaRequire(counts.worker_inbox_count === 1, `${message} did not create exactly one worker inbox item`);
}

function qaCheck(name: string, dispatch: Record<string, unknown>, counts: Record<string, number>): Record<string, unknown> {
  return {
    ...counts,
    command: "conveyor dispatch --once --type continue_iteration --dispatcher-id qa-run",
    dispatch,
    name,
    status: "passed",
  };
}

function qaCodexReviewHelperSyntax(): { command: string; helper_path: string; returncode: number } {
  const packageRoot = packageRootFromRuntimeModule();
  const packageCandidate = join(packageRoot, "skills", "codex-review", "scripts", "codex-review");
  const packagedAssetCandidate = join(packageRoot, "workerctl", "assets", "skills", "codex-review", "scripts", "codex-review");
  const homeCandidate = join(homedir(), ".codex", "skills", "codex-review", "scripts", "codex-review");
  const helperPath = [packageCandidate, packagedAssetCandidate, homeCandidate].find((candidate) => existsSync(candidate)) ?? homeCandidate;
  qaRequire(existsSync(helperPath), `codex-review helper is missing: ${helperPath}`);
  const command = `bash -n ${helperPath}`;
  const syntax = spawnSync("bash", ["-n", helperPath], { encoding: "utf8" });
  qaRequire(syntax.status === 0, `codex-review helper syntax failed: ${syntax.stderr || syntax.stdout || `exit ${syntax.status}`}`);
  return { command, helper_path: helperPath, returncode: syntax.status ?? 1 };
}

function qaRecordLoopEvidence(
  context: QaRunContext,
  task: QaGeneratedTask,
  runId: string,
  evidenceType: string,
  correlationId: string,
  options: { artifactPath?: string; metadata?: Record<string, unknown>; status?: string } = {},
) {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return recordLoopEvidenceSync(database, {
      artifactPath: options.artifactPath,
      correlationId,
      evidenceType,
      iteration: 1,
      loopRunId: runId,
      metadata: options.metadata ?? {},
      proof: `qa-run recorded ${evidenceType} receipt before continuing.`,
      status: options.status ?? "pass",
      task: task.task_name,
    });
  } finally {
    database.close();
  }
}

function qaRecordAdversarialEvidence(
  context: QaRunContext,
  task: QaGeneratedTask,
  runId: string,
  correlationId: string,
  proof: { check: string; failure_mode: string; result: string },
  source: AcceptanceCriterionSource = "manager_inferred",
) {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return recordAdversarialLoopEvidenceSync(database, {
      check: proof.check,
      correlationId,
      failureMode: proof.failure_mode,
      iteration: 1,
      loopRunId: runId,
      result: proof.result,
      source,
      task: task.task_name,
    });
  } finally {
    database.close();
  }
}

function qaRecordTaskAdversarialProof(
  context: QaRunContext,
  task: QaGeneratedTask,
  correlationId: string,
  proof: { check: string; failure_mode: string; result: string },
): { criterion: AcceptanceCriterionRecord; evidence: Record<string, unknown> } {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const timestamp = new Date().toISOString();
    const evidence = {
      check: proof.check,
      correlation_id: correlationId,
      evidence_type: "adversarial_check",
      failure_mode: proof.failure_mode,
      result: proof.result,
      status: "pass",
    };
    database.prepare(`
      insert into acceptance_criteria(task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at)
      values (?, ?, 'satisfied', 'manager_inferred', ?, null, ?, ?, ?)
    `).run(
      task.task_id,
      "Natural-language finish gate has structured adversarial proof.",
      "finish-task --require-adversarial-proof fails closed before proof and succeeds after proof.",
      stableJson(evidence),
      timestamp,
      timestamp,
    );
    const criterion = acceptanceCriteriaForTaskSync(database, { taskId: task.task_id })
      .find((candidate) => candidate.status === "satisfied" && candidate.proof?.includes("--require-adversarial-proof"));
    qaRequire(criterion !== undefined, "task-level adversarial proof criterion was not recorded");
    return { criterion, evidence };
  } finally {
    database.close();
  }
}

function recordVisualDiffInQa(
  context: QaRunContext,
  task: QaGeneratedTask,
  runId: string,
  reference: string,
  candidate: string,
  diff: string,
  report: string,
) {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    return recordVisualDiffLoopEvidenceSync(database, {
      candidatePath: candidate,
      correlationId: "qa-run-template-visual-diff",
      diffOutput: diff,
      iteration: 1,
      loopRunId: runId,
      referencePath: reference,
      reportOutput: report,
      task: task.task_name,
      threshold: 0,
    });
  } finally {
    database.close();
  }
}

function insertMalformedQaAdversarialEvidence(
  context: QaRunContext,
  task: QaGeneratedTask,
  runId: string,
  correlationId: string,
): void {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const timestamp = new Date().toISOString();
    database.prepare(`
      insert into acceptance_criteria(task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at)
      values (?, ?, 'satisfied', 'manager_inferred', ?, null, ?, ?, ?)
    `).run(
      task.task_id,
      loopEvidenceCriterion(runId, 1, "adversarial_check"),
      "Malformed adversarial evidence intentionally recorded for QA negative control.",
      stableJson({
        correlation_id: correlationId,
        evidence_type: "adversarial_check",
        iteration: 1,
        note: "qa-run intentionally omits failure_mode, check, and result.",
        ralph_loop_run_id: runId,
        status: "pass",
      }),
      timestamp,
      timestamp,
    );
  } finally {
    database.close();
  }
}

function insertQaManagerCriteria(context: QaRunContext, task: QaGeneratedTask): AcceptanceCriterionRecord[] {
  const database = openDatabaseSync(context.dbPath);
  try {
    initializeDatabaseSync(database);
    const timestamp = new Date().toISOString();
    for (const criterion of [
      "Blocked Dispatch before adversarial proof exists is required.",
      "Blocked Dispatch must leave the worker inbox empty.",
      "Structured adversarial evidence is present before a fresh retry is delivered.",
    ]) {
      database.prepare(`
        insert into acceptance_criteria(task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at)
        values (?, ?, 'accepted', 'manager_inferred', null, ?, ?, ?, ?)
      `).run(
        task.task_id,
        criterion,
        "Natural-language acceptance criteria trigger drill.",
        stableJson({ correlation_id: "nl-manager-criteria-negative-checks" }),
        timestamp,
        timestamp,
      );
    }
    return acceptanceCriteriaForTaskSync(database, { taskId: task.task_id })
      .filter((criterion) => criterion.source === "manager_inferred");
  } finally {
    database.close();
  }
}

function qaRequireCleanContinueQueue(database: ReturnType<typeof openDatabaseSync>): void {
  const rows = database.prepare(`
    select correlation_id, state
    from commands
    where type = 'continue_iteration' and state in ('pending', 'attempted')
    order by created_at, id
  `).all() as Array<{ correlation_id: string | null; state: string }>;
  if (rows.length > 0) {
    const seen = rows.map((row) => `${row.correlation_id}:${row.state}`);
    throw new Error(`qa-run continue_iteration dispatch queue is not clean; found ${JSON.stringify(seen)}`);
  }
}

function generatedTask(task: QaGeneratedTask, suffix: string): QaGeneratedTask {
  return { ...task, suffix };
}

function qaArtifactDir(context: QaRunContext, scenario: string, slug: string, runId: string): string {
  return join(dirname(context.receiptOutput), `${scenario}-artifacts`, `${slug}-${runId}`);
}

function preflightQaBrowserCapture(): void {
  const preflightDir = mkdtempSync(join(tmpdir(), "agent-conveyor-qa-browser-preflight."));
  try {
    const htmlPath = join(preflightDir, "candidate.html");
    const screenshotPath = join(preflightDir, "candidate.png");
    writeQaCandidateHtml(htmlPath);
    captureQaBrowserScreenshot(htmlPath, screenshotPath);
  } finally {
    rmSync(preflightDir, { force: true, recursive: true });
  }
}

function writeQaRollout(sessionDir: string, sessionName: string, cwd: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = join(sessionDir, `rollout-${sessionName}.jsonl`);
  writeFileSync(rolloutPath, `${JSON.stringify({
    payload: { cwd, id: `codex-${sessionName}`, originator: "conveyor qa-run" },
    type: "session_meta",
  })}\n`);
  return rolloutPath;
}

function writeQaCandidateHtml(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; width: 2px; height: 2px; overflow: hidden; background: transparent; }
    .qa-grid { display: grid; grid-template-columns: 1px 1px; grid-template-rows: 1px 1px; width: 2px; height: 2px; }
    .qa-pixel { width: 1px; height: 1px; }
    #qa-pixel-0 { background: rgb(18, 24, 38); }
    #qa-pixel-1 { background: rgb(44, 92, 152); }
    #qa-pixel-2 { background: rgb(218, 226, 236); }
    #qa-pixel-3 { background: rgb(246, 248, 251); }
  </style>
</head>
<body>
  <div class="qa-grid" aria-label="generic loop browser QA reference">
    <div id="qa-pixel-0" class="qa-pixel"></div>
    <div id="qa-pixel-1" class="qa-pixel"></div>
    <div id="qa-pixel-2" class="qa-pixel"></div>
    <div id="qa-pixel-3" class="qa-pixel"></div>
  </div>
</body>
</html>
`);
}

function captureQaBrowserScreenshot(htmlPath: string, screenshotPath: string): Record<string, string> {
  const helperPath = join(packageRootFromRuntimeModule(), "scripts", "capture-static-html-screenshot.mjs");
  qaRequire(existsSync(helperPath), `browser screenshot helper is missing: ${helperPath}`);
  const result = spawnSync("node", [
    helperPath,
    "--html",
    htmlPath,
    "--output",
    screenshotPath,
    "--width",
    "2",
    "--height",
    "2",
  ], {
    cwd: packageRootFromRuntimeModule(),
    encoding: "utf8",
  });
  qaRequire(result.status === 0, result.stderr || result.stdout || `browser screenshot helper exited ${result.status}`);
  const payload = JSON.parse(result.stdout || "{}") as unknown;
  qaRequire(isPlainRecord(payload), `browser screenshot helper returned non-object JSON: ${result.stdout}`);
  return {
    backend: typeof payload.backend === "string" ? payload.backend : "playwright-chromium",
    html_path: typeof payload.html_path === "string" ? payload.html_path : htmlPath,
    screenshot_path: typeof payload.screenshot_path === "string" ? payload.screenshot_path : screenshotPath,
    viewport: typeof payload.viewport === "string" ? payload.viewport : "2x2",
  };
}

function writeQaPng(path: string): void {
  writePngRgba(path, 2, 2, [
    [18, 24, 38, 255],
    [44, 92, 152, 255],
    [218, 226, 236, 255],
    [246, 248, 251, 255],
  ]);
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

function runCampaignCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  if (parsed.task) {
    return errorResult(`Unexpected argument: ${parsed.task}`);
  }
  const action = parsed.flags.action;
  if (!action) {
    return errorResult("campaign requires an action: create, add-slot, brief, assign, asset, or status");
  }
  const campaign = campaignNameArg(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    if (action === "create") {
      const objective = requiredStringFlag(parsed.flags.objective, "--objective");
      const metadata = jsonObjectArg(parsed.flags.metadataJson, "--metadata-json");
      const campaignId = createCampaignSync(database, {
        metadata,
        name: campaign,
        objective,
      });
      return campaignResult(parsed, {
        action,
        campaign,
        campaign_id: campaignId,
        created: true,
      }, [`campaign ${campaign} created ${campaignId}`]);
    }

    if (action === "add-slot") {
      const slotKey = requiredStringFlag(parsed.flags.slotKey, "--slot-key");
      const roleLabel = requiredStringFlag(parsed.flags.roleLabel, "--role-label");
      const state = campaignSlotStateArg(parsed.flags.statusState);
      const metadata = jsonObjectArg(parsed.flags.metadataJson, "--metadata-json");
      const slotId = addCampaignWorkerSlotSync(database, {
        campaign,
        channel: parsed.flags.channel,
        codexAppThreadId: parsed.flags.threadId,
        codexAppThreadTitle: parsed.flags.threadTitle,
        metadata,
        roleLabel,
        sessionId: parsed.flags.sessionId,
        slotKey,
        ...(state ? { state } : {}),
      });
      return campaignResult(parsed, {
        action,
        campaign,
        created: true,
        slot_id: slotId,
        slot_key: slotKey,
      }, [`campaign ${campaign} slot ${slotKey} created ${slotId}`]);
    }

    if (action === "attach-slot") {
      const slot = requiredStringFlag(parsed.flags.slot, "--slot");
      const state = campaignSlotStateArg(parsed.flags.statusState) ?? "active";
      const record = updateCampaignWorkerSlotLifecycleSync(database, {
        campaign,
        codexAppThreadId: parsed.flags.threadId,
        codexAppThreadTitle: parsed.flags.threadTitle,
        metadata: jsonObjectArg(parsed.flags.metadataJson, "--metadata-json"),
        sessionId: parsed.flags.sessionId,
        slot,
        state,
      });
      return campaignResult(parsed, {
        action,
        campaign,
        slot: record,
        updated: true,
      }, [`campaign ${campaign} slot ${record.slot_key} attached ${record.id}`]);
    }

    if (action === "rotate-slot") {
      const slot = requiredStringFlag(parsed.flags.slot, "--slot");
      const expectedThreadId = requiredStringFlag(parsed.flags.expectedThreadId, "--expected-thread-id");
      const nextThreadId = requiredStringFlag(parsed.flags.threadId, "--thread-id");
      const record = updateCampaignWorkerSlotLifecycleSync(database, {
        campaign,
        codexAppThreadId: nextThreadId,
        codexAppThreadTitle: parsed.flags.threadTitle,
        expectedThreadId,
        sessionId: parsed.flags.sessionId,
        slot,
        state: campaignSlotStateArg(parsed.flags.statusState) ?? "active",
      });
      return campaignResult(parsed, {
        action,
        campaign,
        expected_thread_id: expectedThreadId,
        slot: record,
        updated: true,
      }, [`campaign ${campaign} slot ${record.slot_key} rotated ${expectedThreadId} -> ${record.codex_app_thread_id ?? "none"}`]);
    }

    if (action === "archive-slot") {
      const slot = requiredStringFlag(parsed.flags.slot, "--slot");
      const expectedThreadId = requiredStringFlag(parsed.flags.expectedThreadId, "--expected-thread-id");
      const record = updateCampaignWorkerSlotLifecycleSync(database, {
        campaign,
        expectedThreadId,
        slot,
        state: "archived",
      });
      return campaignResult(parsed, {
        action,
        campaign,
        expected_thread_id: expectedThreadId,
        slot: record,
        updated: true,
      }, [`campaign ${campaign} slot ${record.slot_key} archived ${record.id}`]);
    }

    if (action === "brief") {
      const channel = requiredStringFlag(parsed.flags.channel, "--channel");
      if (parsed.flags.briefJson === null) {
        return errorResult("campaign brief requires --brief-json");
      }
      const briefId = upsertCampaignChannelBriefSync(database, {
        brief: jsonObjectArg(parsed.flags.briefJson, "--brief-json"),
        campaign,
        channel,
      });
      return campaignResult(parsed, {
        action,
        brief_id: briefId,
        campaign,
        channel,
        upserted: true,
      }, [`campaign ${campaign} brief ${channel} upserted ${briefId}`]);
    }

    if (action === "assign") {
      const slot = requiredStringFlag(parsed.flags.slot, "--slot");
      const title = requiredStringFlag(parsed.flags.title, "--title");
      const instructions = requiredStringFlag(parsed.flags.instructions, "--instructions");
      const status = campaignAssignmentStatusArg(parsed.flags.statusState);
      const metadata = jsonObjectArg(parsed.flags.metadataJson, "--metadata-json");
      const assignmentId = createCampaignAssignmentSync(database, {
        campaign,
        instructions,
        metadata,
        slot,
        title,
        ...(status ? { status } : {}),
      });
      return campaignResult(parsed, {
        action,
        assignment_id: assignmentId,
        campaign,
        created: true,
        slot_id: slot,
      }, [`campaign ${campaign} assignment created ${assignmentId}`]);
    }

    if (action === "asset") {
      const slot = requiredStringFlag(parsed.flags.slot, "--slot");
      const title = requiredStringFlag(parsed.flags.title, "--title");
      const assetType = campaignAssetTypeArg(requiredStringFlag(parsed.flags.assetType, "--asset-type"));
      const status = campaignAssetStatusArg(parsed.flags.statusState);
      const metadata = jsonObjectArg(parsed.flags.metadataJson, "--metadata-json");
      const assetReceiptId = recordCampaignAssetReceiptSync(database, {
        allowAdditionalReceipt: parsed.flags.allowAdditionalReceipt,
        artifactPath: parsed.flags.artifactPath,
        assetType,
        assignment: parsed.flags.assignment,
        campaign,
        channel: parsed.flags.channel,
        metadata,
        promptSummary: parsed.flags.promptSummary,
        reviewNotes: parsed.flags.reviewNotes,
        slot,
        title,
        ...(status ? { status } : {}),
      });
      return campaignResult(parsed, {
        action,
        asset_receipt_id: assetReceiptId,
        campaign,
        created: true,
        slot_id: slot,
      }, [`campaign ${campaign} asset receipt created ${assetReceiptId}`]);
    }

    if (action === "status") {
      const status = campaignStatusSync(database, campaign);
      return campaignResult(parsed, status, renderCampaignStatusText(status));
    }

    if (action === "dashboard") {
      const dashboard = campaignDashboardSync(database, campaign);
      return campaignResult(parsed, dashboard, renderCampaignDashboardText(dashboard));
    }

    if (action === "closeout") {
      const dashboard = campaignDashboardSync(database, campaign);
      const closeout = campaignCloseoutReport(dashboard, {
        failureMode: parsed.flags.failureMode,
      });
      return campaignResult(parsed, closeout, renderCampaignCloseoutText(closeout));
    }

    return errorResult(unsupportedCampaignActionMessage(action));
  } finally {
    database.close();
  }
}

function campaignActionsUsage(): string {
  return CAMPAIGN_ACTION_NAMES.join("|");
}

function unsupportedCampaignActionMessage(action: string | null): string {
  return `Unsupported campaign action: ${action ?? "<missing>"}; expected one of: ${CAMPAIGN_ACTION_NAMES.join(", ")}. Use \`conveyor campaign dashboard --name <campaign> --json\` to list assets and receipt counts.`;
}

function campaignResult(parsed: ParsedRuntimeArgs, payload: unknown, lines: string[]): TypescriptRuntimeResult {
  return parsed.flags.json ? jsonResult(payload) : textResult(lines);
}

function campaignNameArg(parsed: ParsedRuntimeArgs): string {
  if (parsed.flags.names.length !== 1) {
    throw new Error("campaign requires exactly one --name <campaign>");
  }
  return parsed.flags.names[0];
}

function requiredStringFlag(value: string | null, flag: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`campaign requires ${flag}`);
  }
  return value;
}

function campaignSlotStateArg(value: string | null): CampaignWorkerSlotState | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "active" || value === "archived" || value === "blocked" || value === "idle" || value === "planned") {
    return value;
  }
  throw new Error("--state must be one of: active, archived, blocked, idle, planned");
}

function campaignAssignmentStatusArg(value: string | null): CampaignAssignmentStatus | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "active" || value === "blocked" || value === "cancelled" || value === "done" || value === "queued") {
    return value;
  }
  throw new Error("--status must be one of: active, blocked, cancelled, done, queued");
}

function campaignAssetStatusArg(value: string | null): CampaignAssetStatus | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "approved" || value === "draft" || value === "needs_review" || value === "published" || value === "rejected") {
    return value;
  }
  throw new Error("--status must be one of: approved, draft, needs_review, published, rejected");
}

function campaignAssetTypeArg(value: string): CampaignAssetType {
  if (value === "audio" || value === "copy" || value === "hyperframes" || value === "image" || value === "other" || value === "video") {
    return value;
  }
  throw new Error("--asset-type must be one of: audio, copy, hyperframes, image, other, video");
}

function renderCampaignStatusText(status: ReturnType<typeof campaignStatusSync>): string[] {
  return [
    `campaign ${status.campaign.name} ${status.campaign.status}`,
    `slots ${status.slots.length}`,
    `assignments ${statusCountsText(status.assignment_counts)}`,
    `assets ${statusCountsText(status.asset_counts)}`,
    `briefs ${status.channel_briefs.length}`,
  ];
}

function renderCampaignDashboardText(dashboard: ReturnType<typeof campaignDashboardSync>): string[] {
  const lines = [
    `campaign ${dashboard.campaign.name} ${dashboard.campaign.status}`,
    `next ${dashboard.next_manager_action.action}: ${dashboard.next_manager_action.reason}`,
    `workers active=${dashboard.summary.active_slots} stale=${dashboard.summary.stale_slots} blocked=${dashboard.summary.blocked_slots} archived=${dashboard.summary.archived_slots}`,
    `assignments ${statusCountsText(dashboard.assignment_counts)}`,
    `assets ${statusCountsText(dashboard.asset_counts)}`,
    `approvals needs_review=${dashboard.approvals.needs_review} approved=${dashboard.approvals.approved} rejected=${dashboard.approvals.rejected} published=${dashboard.approvals.published}`,
    `blockers ${dashboard.blockers.length}`,
  ];
  for (const slot of dashboard.slots.slice(0, 8)) {
    lines.push(`slot ${slot.slot_key} ${slot.state} ${slot.lifecycle.state} assignments=${slot.assignments.length} assets=${slot.assets.length}`);
  }
  return lines;
}

type CampaignCloseoutVerdict = "blocked" | "needs_review" | "ready_to_close" | "needs_work";

interface CampaignCloseoutReport {
  action: "closeout";
  approvals: CampaignDashboardRecord["approvals"];
  blockers: string[];
  campaign: CampaignDashboardRecord["campaign"];
  failure_mode: {
    evidence: string;
    strongest_realistic_failure_mode: string;
  };
  next_manager_action: CampaignDashboardRecord["next_manager_action"];
  proof_checks: Array<{
    check: string;
    evidence: string;
    status: "attention" | "failed" | "passed";
  }>;
  receipt_counts_by_assignment: Array<{
    assignment_id: string;
    receipt_count: number;
    slot_key: string;
  }>;
  summary: CampaignDashboardRecord["summary"];
  verdict: CampaignCloseoutVerdict;
  workers: Array<{
    active_assignments: number;
    asset_receipts: number;
    blockers: string[];
    channel: string | null;
    codex_app_thread_id: string | null;
    codex_app_thread_title: string | null;
    lifecycle_state: string;
    receipt_ids: string[];
    slot_key: string;
    state: string;
  }>;
}

function campaignCloseoutReport(
  dashboard: CampaignDashboardRecord,
  options: { failureMode?: string | null } = {},
): CampaignCloseoutReport {
  const receiptCountsByAssignment = campaignReceiptCountsByAssignment(dashboard);
  const activeSlots = dashboard.slots.filter((slot) => slot.state !== "archived");
  const slotsMissingReceipts = activeSlots.filter((slot) => slot.assignments.length > 0 && slot.asset_receipts === 0);
  const duplicateAssignmentCounts = receiptCountsByAssignment.filter((item) => item.receipt_count > 1);
  const failureMode = options.failureMode
    ?? "A hidden duplicate or missing worker receipt could make the campaign look closed while dashboard receipt counts are wrong.";
  const receiptEvidence = dashboard.slots
    .map((slot) => `${slot.slot_key}:assignments=${slot.assignments.length},receipts=${slot.asset_receipts}`)
    .join("; ");
  return {
    action: "closeout",
    approvals: dashboard.approvals,
    blockers: dashboard.blockers,
    campaign: dashboard.campaign,
    failure_mode: {
      evidence: `dashboard asset_total=${dashboard.summary.asset_total}; assignment_total=${dashboard.summary.assignment_total}; ${receiptEvidence}`,
      strongest_realistic_failure_mode: failureMode,
    },
    next_manager_action: dashboard.next_manager_action,
    proof_checks: [
      {
        check: "dashboard_loaded",
        evidence: `campaign_id=${dashboard.campaign.id}; updated_at=${dashboard.campaign.updated_at}`,
        status: "passed",
      },
      {
        check: "blockers_absent",
        evidence: `blockers=${dashboard.blockers.length}`,
        status: dashboard.blockers.length === 0 ? "passed" : "failed",
      },
      {
        check: "active_worker_slots_have_receipts",
        evidence: slotsMissingReceipts.length === 0
          ? "all active slots with assignments have at least one receipt"
          : `missing_receipt_slots=${slotsMissingReceipts.map((slot) => slot.slot_key).join(",")}`,
        status: slotsMissingReceipts.length === 0 ? "passed" : "attention",
      },
      {
        check: "assignment_receipt_counts",
        evidence: duplicateAssignmentCounts.length === 0
          ? "no assignment has more than one receipt"
          : `additional_receipt_assignments=${duplicateAssignmentCounts.map((item) => `${item.assignment_id}:${item.receipt_count}`).join(",")}`,
        status: duplicateAssignmentCounts.length === 0 ? "passed" : "attention",
      },
      {
        check: "human_review_gate",
        evidence: `needs_review=${dashboard.approvals.needs_review}; approved=${dashboard.approvals.approved}; published=${dashboard.approvals.published}`,
        status: dashboard.approvals.needs_review > 0 && dashboard.approvals.published === 0 ? "passed" : "attention",
      },
    ],
    receipt_counts_by_assignment: receiptCountsByAssignment,
    summary: dashboard.summary,
    verdict: campaignCloseoutVerdict(dashboard),
    workers: dashboard.slots.map((slot) => ({
      active_assignments: slot.active_assignments,
      asset_receipts: slot.asset_receipts,
      blockers: slot.blockers,
      channel: slot.channel,
      codex_app_thread_id: slot.codex_app_thread_id,
      codex_app_thread_title: slot.codex_app_thread_title,
      lifecycle_state: slot.lifecycle.state,
      receipt_ids: slot.assets.map((asset) => asset.id),
      slot_key: slot.slot_key,
      state: slot.state,
    })),
  };
}

function campaignReceiptCountsByAssignment(dashboard: CampaignDashboardRecord): CampaignCloseoutReport["receipt_counts_by_assignment"] {
  return dashboard.slots.flatMap((slot) => slot.assignments.map((assignment) => ({
    assignment_id: assignment.id,
    receipt_count: slot.assets.filter((asset) => asset.assignment_id === assignment.id).length,
    slot_key: slot.slot_key,
  })));
}

function campaignCloseoutVerdict(dashboard: CampaignDashboardRecord): CampaignCloseoutVerdict {
  if (dashboard.blockers.length > 0 || dashboard.summary.blocked_assignments > 0 || dashboard.summary.blocked_slots > 0 || dashboard.summary.stale_slots > 0) {
    return "blocked";
  }
  if (dashboard.next_manager_action.action === "close_campaign") {
    return "ready_to_close";
  }
  if (dashboard.approvals.needs_review > 0 || dashboard.approvals.rejected > 0) {
    return "needs_review";
  }
  return "needs_work";
}

function renderCampaignCloseoutText(report: CampaignCloseoutReport): string[] {
  return [
    `campaign ${report.campaign.name} ${report.campaign.status}`,
    `closeout verdict ${report.verdict}`,
    `next ${report.next_manager_action.action}: ${report.next_manager_action.reason}`,
    `summary slots=${report.summary.active_slots}/${report.summary.archived_slots} assignments=${report.summary.assignment_total} assets=${report.summary.asset_total} blockers=${report.blockers.length}`,
    `approvals needs_review=${report.approvals.needs_review} approved=${report.approvals.approved} rejected=${report.approvals.rejected} published=${report.approvals.published}`,
    `failure_mode ${report.failure_mode.strongest_realistic_failure_mode}`,
    `failure_mode_evidence ${report.failure_mode.evidence}`,
    ...report.proof_checks.map((check) => `proof ${check.status} ${check.check}: ${check.evidence}`),
    ...report.receipt_counts_by_assignment.map((item) => `assignment_receipts ${item.slot_key} ${item.assignment_id}=${item.receipt_count}`),
    ...report.workers.slice(0, 8).map((worker) => `worker ${worker.slot_key} ${worker.state}/${worker.lifecycle_state} assignments=${worker.active_assignments} receipts=${worker.asset_receipts} thread=${worker.codex_app_thread_id ?? "none"}`),
  ];
}

function statusCountsText(counts: Record<string, number>): string {
  return Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(" ");
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

function runDashboardCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  const unsupported = unsupportedDashboardOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const payload = dashboardLaunchPayload(parsed);
  if (parsed.flags.dryRun) {
    if (parsed.flags.json) {
      return jsonResult(payload);
    }
    return { exitCode: 0, handled: true, stdout: `${payload.command.map(shellQuote).join(" ")}\n${payload.url}\n` };
  }
  let dispatchProcess: { pid: number | null } | null = null;
  if (payload.ensure_dispatch && payload.dispatch_command) {
    const database = openRuntimeDatabase(parsed, options);
    let hasHeartbeat: boolean;
    try {
      hasHeartbeat = recentActiveDispatchHeartbeat(database, {
        dispatcherId: parsed.flags.dispatcherId,
        now: options.now?.() ?? new Date(),
      });
    } finally {
      database.close();
    }
    if (!hasHeartbeat) {
      dispatchProcess = (options.dispatchRunner ?? defaultDispatchRunner)(payload.dispatch_command, { cwd: packageRootFromRuntimeModule() });
    }
  }
  const result = spawnSync(payload.command[0] ?? "", payload.command.slice(1), {
    cwd: packageRootFromRuntimeModule(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (dispatchProcess?.pid) {
    try {
      process.kill(dispatchProcess.pid, "SIGTERM");
    } catch {
      // The watcher may already have exited with the dashboard process.
    }
  }
  return { exitCode: result.status ?? (result.signal ? 1 : 0), handled: true };
}

function runInstallSkillsCommand(
  parsed: ParsedRuntimeArgs,
  options: { env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const unsupported = unsupportedInstallSkillsOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const codexHome = resolve(expandUserPath(parsed.flags.codexHome ?? options.env?.CODEX_HOME ?? join(homedir(), ".codex")));
  const skills = installableSkillSources();
  const targets = skills.map((skill) => ({
    name: skill.name,
    source: skill.source,
    target: join(codexHome, "skills", skill.name),
  }));
  if (!parsed.flags.dryRun) {
    for (const target of targets) {
      rmSync(target.target, { force: true, recursive: true });
      mkdirSync(dirname(target.target), { recursive: true });
      cpSync(target.source, target.target, { recursive: true });
      if (target.name === "codex-review") {
        const helper = join(target.target, "scripts", "codex-review");
        if (existsSync(helper)) {
          chmodSync(helper, 0o755);
        }
      }
    }
  }
  const payload = {
    codex_home: codexHome,
    dry_run: parsed.flags.dryRun,
    installed: parsed.flags.dryRun ? [] : targets.map((target) => target.name),
    skills: targets,
  };
  if (parsed.flags.json) {
    return jsonResult(payload);
  }
  const lines = targets.map((target) => `${parsed.flags.dryRun ? "would install" : "installed"} ${target.name} skill in ${target.target}`);
  return { exitCode: 0, handled: true, stdout: `${lines.join("\n")}\n` };
}

function dashboardLaunchPayload(parsed: ParsedRuntimeArgs): {
  command: string[];
  dispatch_command: string[] | null;
  ensure_dispatch: boolean;
  host: string;
  port: number;
  campaign: string | null;
  task: string | null;
  url: string;
} {
  const queryParams = new URLSearchParams();
  if (parsed.flags.taskName) {
    queryParams.set("task", parsed.flags.taskName);
  }
  if (parsed.flags.campaignName) {
    queryParams.set("campaign", parsed.flags.campaignName);
  }
  const query = queryParams.toString() ? `?${queryParams.toString()}` : "";
  const command = [
    "npm",
    "run",
    "dashboard",
    "--",
    "--host",
    parsed.flags.host,
    "--port",
    String(parsed.flags.port),
    "--workerctl-path",
    parsed.flags.workerctlPath,
  ];
  if (parsed.flags.taskName) {
    command.push("--task", parsed.flags.taskName);
  }
  if (parsed.flags.campaignName) {
    command.push("--campaign", parsed.flags.campaignName);
  }
  if (parsed.flags.path) {
    command.push("--db-path", parsed.flags.path);
  }
  const dispatcherId = parsed.flags.dispatcherId ?? "dispatch-dashboard";
  return {
    command,
    dispatch_command: parsed.flags.require ? dispatchWatchCommand(parsed.flags.workerctlPath, dispatcherId, parsed.flags.path) : null,
    ensure_dispatch: parsed.flags.require,
    host: parsed.flags.host,
    port: parsed.flags.port,
    campaign: parsed.flags.campaignName,
    task: parsed.flags.taskName,
    url: `http://${parsed.flags.host}:${parsed.flags.port}/${query}`,
  };
}

function dispatchWatchCommand(workerctlPath: string, dispatcherId: string, dbPath: string | null): string[] {
  const command = [workerctlPath, "dispatch", "--watch", "--dispatcher-id", dispatcherId];
  if (dbPath) {
    command.push("--path", dbPath);
  }
  return command;
}

function installableSkillSources(): Array<{ name: string; source: string }> {
  const root = packageRootFromRuntimeModule();
  const candidate = join(root, "skills");
  const skills = ["manage-codex-workers", "codex-review"]
    .map((name) => ({ name, source: join(candidate, name) }))
    .filter((skill) => existsSync(join(skill.source, "SKILL.md")));
  if (skills.length === 2) {
    return skills;
  }
  throw new Error("Bundled Agent Conveyor skills not found in skills/.");
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
      codexAppThreadId: parsed.flags.workerCodexAppThreadId,
      codexAppThreadTitle: parsed.flags.workerCodexAppThreadTitle,
      codexSessionPath: workerRollout.path,
      cwd,
      name: workerName,
      pid: process.pid,
      role: "worker",
      tmuxSession: null,
    });
    const manager = registerSessionSync(database, {
      codexAppThreadId: parsed.flags.managerCodexAppThreadId,
      codexAppThreadTitle: parsed.flags.managerCodexAppThreadTitle,
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
        codex_app_thread_id: manager.codex_app_thread_id,
        codex_app_thread_title: manager.codex_app_thread_title,
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
        codex_app_thread_id: worker.codex_app_thread_id,
        codex_app_thread_title: worker.codex_app_thread_title,
        id: worker.session_id,
        name: workerName,
        rollout_path: workerRollout.path,
        tmux_session: null,
      },
      heartbeat_recommendations: disposableHeartbeatRecommendations(task.name, dbPath),
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
      now: nowIsoSeconds(options),
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
        dbPath: runtimeDbPath(parsed, options),
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
  const dispatch = pairDispatchPayload(parsed, dbPath, options);
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
  const codexPreflight = ensureRequiredTool("codex", options);
  if (codexPreflight) {
    return codexPreflight;
  }
  const tmuxPreflight = ensureTmuxAvailable(options.tmuxRunner ?? defaultTmuxRunner);
  if (tmuxPreflight) {
    return tmuxPreflight;
  }
  const tmuxAccessPreflight = ensureTmuxServerAccessible(options.tmuxRunner ?? defaultTmuxRunner);
  if (tmuxAccessPreflight) {
    return tmuxAccessPreflight;
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
      managerRecipe: parsed.flags.managerRecipe,
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
      initialPrompt: workerAckTaskPrompt(taskName, parsed.flags.taskPrompt, dbPath),
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
        dbPath,
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
  options: { env?: NodeJS.ProcessEnv },
): { dispatchCommand: string[] | null; ensureDispatch: boolean } {
  const dispatcherId = parsed.flags.dispatcherId;
  const ensureDispatch = dispatcherId !== null && !parsed.flags.noDispatch;
  return {
    dispatchCommand: ensureDispatch
      ? [
        workerctlDispatchExecutable(options),
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

function workerctlDispatchExecutable(options: { env?: NodeJS.ProcessEnv }): string {
  const workerctlPath = commandPath("workerctl", options);
  if (workerctlPath) {
    return workerctlPath;
  }
  const workerctlScript = join(packageRootFromRuntimeModule(), "scripts", "workerctl");
  if (pathIsExecutable(workerctlScript)) {
    return workerctlScript;
  }
  throw new Error(
    `Cannot start Dispatch: workerctl is not on PATH and ${workerctlScript} is not executable.`,
  );
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
    managerRecipe: string | null;
    managerReference: string[];
    managerRequireAcks: boolean;
    managerTool: string[];
    taskId: string;
    timestamp: string;
  },
): { config: ManagerConfigRecord; seededByPair: boolean } {
  const existing = managerConfigSync(database, options.taskId);
  const requested = options.managerMode !== null
    || options.managerRecipe !== null
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
  const recipeName = cleanManagerRecipeName(options.managerRecipe, existing?.recipe_name ?? (existing === null ? "custom" : null));
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
      task_id, recipe_name, supervision_mode, objective, guidelines_json,
      acceptance_criteria_json, reference_paths_json, permissions_json,
      tools_json, epilogues_json, nudge_on_completion, require_acks,
      revision, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    on conflict(task_id) do update set
      recipe_name = excluded.recipe_name,
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
        manager_configs.recipe_name is not excluded.recipe_name or
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
    recipeName,
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

function workerAckTaskPrompt(taskName: string | null, taskPrompt: string | null, dbPath: string | null): string | null {
  if (taskPrompt === null) {
    return null;
  }
  const taskRef = taskName ?? "<task>";
  const pathSuffix = commandPathSuffix(dbPath);
  return [
    taskPrompt,
    "",
    "Before editing files or running implementation work, acknowledge the task contract:",
    "",
    `conveyor worker-ack ${taskRef} --from-stdin${pathSuffix}`,
    "",
    "Use a JSON object like:",
    "",
    `{"goal_restatement":"Restate the assigned task.","proposed_criteria":{"must_have":["Current-task proof"],"follow_up":[]},"expected_tools":["shell"],"open_questions":[],"ready_to_start":true}`,
    "",
    "When your implementation is complete, leave a concise final reply with the files changed and verification you ran. Do not call `conveyor finish-task`; the manager owns criteria satisfaction and audited task closeout.",
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

function runLegacyListCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedLegacyListOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const root = stateRoot(options);
  if (!existsSync(root)) {
    return parsed.flags.json ? jsonResult([]) : { exitCode: 0, handled: true, stdout: "" };
  }
  const workers: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) {
      continue;
    }
    const config = loadJsonSync<Record<string, unknown>>(join(dir, "config.json"), {});
    const name = stringOrNull(config.name) ?? entry;
    const fallbackStatus = loadJsonSync<Record<string, unknown>>(join(dir, "status.json"), {});
    let status: Record<string, unknown>;
    try {
      status = { ...latestStatusSync(name, options) };
    } catch {
      status = fallbackStatus;
    }
    let running = false;
    let terminalError: string | null = null;
    try {
      running = sessionExists(name, options.tmuxRunner ?? defaultTmuxRunner);
    } catch (error) {
      terminalError = error instanceof Error ? error.message : String(error);
    }
    const worker: Record<string, unknown> = {
      current_task: status.current_task ?? "",
      name,
      running,
      state: status.state ?? "unknown",
      status: running ? "running" : "stopped",
    };
    if (terminalError !== null) {
      worker.terminal_error = terminalError;
    }
    workers.push(worker);
  }
  if (parsed.flags.json) {
    return jsonResult(workers);
  }
  return {
    exitCode: 0,
    handled: true,
    stdout: workers.map((worker) => `${worker.name}\t${worker.status}\t${worker.state}\t${worker.current_task}`).join("\n") + (workers.length ? "\n" : ""),
  };
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

function runLegacyNudgeCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedLegacyNudgeOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task ?? "";
  const message = parsed.flags.message ?? "";
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  try {
    requireWorkerConfig(name, options);
    sendTextToLegacyWorker(name, message, runner);
    appendCompatibilityEvent(name, "nudge", { message }, options);
    return { exitCode: 0, handled: true, stdout: `sent nudge to ${name}\n` };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (!messageText.startsWith("Unknown worker:")) {
      throw error;
    }
    const database = openRuntimeDatabase(parsed, options);
    try {
      const result = sendTextToRegisteredSession(database, {
        dryRun: false,
        name,
        text: message,
        tmuxRunner: runner,
      });
      insertEventSync(database, {
        payload: {
          dry_run: false,
          session: name,
          success: true,
          text_length: message.length,
        },
        type: "session_nudged",
      });
      return jsonResult(result);
    } catch (sessionError) {
      const detail = sessionError instanceof Error ? sessionError.message : String(sessionError);
      throw new Error(
        `Unknown worker: ${name}; also failed to resolve registered session ${JSON.stringify(name)}. `
        + `For session-backed workers, use \`conveyor session-nudge ${name} "..."\`. Session lookup error: ${detail}`,
        { cause: sessionError },
      );
    } finally {
      database.close();
    }
  }
}

function runLegacyInterruptCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedLegacyInterruptOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task ?? "";
  requireWorkerConfig(name, options);
  const followup = parsed.flags.noFollowup ? null : parsed.flags.message ?? DEFAULT_INTERRUPT_FOLLOWUP;
  const result = interruptLegacyWorker(name, {
    dryRun: parsed.flags.dryRun,
    followup,
    key: parsed.flags.key,
    tmuxRunner: options.tmuxRunner ?? defaultTmuxRunner,
  });
  if (!parsed.flags.dryRun) {
    appendCompatibilityEvent(name, "interrupt", result, options);
  }
  return jsonResult(result);
}

function runTaskAckCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
  role: "manager" | "worker",
): TypescriptRuntimeResult {
  const unsupported = unsupportedTaskAckOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForLifecycle(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    if (parsed.flags.json && !parsed.flags.fromStdin) {
      return jsonResult(latestTaskAcknowledgementSync(database, { role, taskId: task.id }));
    }
    if (!parsed.flags.fromStdin) {
      return errorResult(`${role}-ack requires --from-stdin to write or --json to read`);
    }
    const payload = parseStdinJsonObject(options.stdin);
    const binding = maybeActiveBindingForTask(database, task.name);
    const ackId = insertTaskAcknowledgementSync(database, {
      bindingId: binding?.binding_id ?? null,
      correlationId: parsed.flags.correlationId,
      payload,
      role,
      taskId: task.id,
      timestamp: new Date().toISOString(),
    });
    insertEventSync(database, {
      correlationId: parsed.flags.correlationId,
      payload: {
        ack_id: ackId,
        binding_id: binding?.binding_id ?? null,
        payload_keys: Object.keys(payload).sort(),
        role,
      },
      taskId: task.id,
      type: `${role}_ack_recorded`,
    });
    return jsonResult(latestTaskAcknowledgementSync(database, { role, taskId: task.id }));
  } finally {
    database.close();
  }
}

function runSessionInboxCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void },
  kind: "manager" | "session" | "worker",
): TypescriptRuntimeResult {
  const unsupported = unsupportedSessionInboxOptions(parsed, kind);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  if (!parsed.task) {
    return errorResult(kind === "session" ? "session-inbox requires a session name." : `${kind}-inbox requires a task.`);
  }
  if (parsed.flags.intervalSeconds <= 0) {
    return errorResult("--interval must be greater than zero.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    let sessionName = parsed.task;
    let task: { id: string; name: string } | null = null;
    if (kind !== "session") {
      const binding = activeBindingForTaskSync(database, parsed.task);
      sessionName = kind === "worker" ? binding.worker_session_name : binding.manager_session_name;
      task = { id: binding.task_id, name: parsed.task };
    }
    const result = sessionInboxResponse(database, {
      consumeNext: parsed.flags.consumeNext,
      intervalSeconds: parsed.flags.intervalSeconds,
      limit: parsed.flags.limit ?? 10,
      now: options.now?.() ?? new Date(),
      sessionName,
      sleepMilliseconds: options.sleepMilliseconds,
      timeoutSeconds: parsed.flags.timeoutSeconds,
      wait: parsed.flags.wait,
    });
    if (task) {
      result.task = task;
    }
    if (parsed.flags.json) {
      return jsonResult(result);
    }
    return { exitCode: 0, handled: true, stdout: renderSessionInboxText(result) };
  } finally {
    database.close();
  }
}

function runSessionNudgeCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedSessionNudgeOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task ?? "";
  const text = parsed.flags.message ?? "";
  const database = openRuntimeDatabase(parsed, options);
  try {
    const telemetry = sessionActionTelemetryContext(database, name);
    try {
      const result = sendTextToRegisteredSession(database, {
        dryRun: parsed.flags.dryRun,
        name,
        sleepMilliseconds: options.sleepMilliseconds,
        text,
        tmuxRunner: options.tmuxRunner ?? defaultTmuxRunner,
      });
      insertEventSync(database, {
        payload: {
          dry_run: parsed.flags.dryRun,
          session: name,
          success: true,
          text_length: text.length,
        },
        type: "session_nudged",
      });
      emitTelemetrySync(database, {
        actor: "workerctl",
        attributes: {
          dry_run: parsed.flags.dryRun,
          success: true,
          text_length: text.length,
        },
        correlation: { ...telemetry.correlation, dry_run: parsed.flags.dryRun, session: name },
        eventType: "session_nudge_succeeded",
        severity: "info",
        summary: `Nudged session ${name}.`,
        taskId: telemetry.taskId,
        timestamp: nowIsoSeconds(options),
      });
      return jsonResult(result);
    } catch (error) {
      recordSessionActionFailure(database, {
        action: "nudge",
        dryRun: parsed.flags.dryRun,
        error,
        key: null,
        name,
        telemetry,
        textLength: text.length,
        timestamp: nowIsoSeconds(options),
      });
      throw error;
    }
  } finally {
    database.close();
  }
}

function runSessionInterruptCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedSessionInterruptOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const name = parsed.task ?? "";
  const followup = parsed.flags.message;
  const database = openRuntimeDatabase(parsed, options);
  try {
    const telemetry = sessionActionTelemetryContext(database, name);
    try {
      const result = interruptRegisteredSession(database, {
        dryRun: parsed.flags.dryRun,
        followup,
        key: parsed.flags.key,
        name,
        sleepMilliseconds: options.sleepMilliseconds,
        tmuxRunner: options.tmuxRunner ?? defaultTmuxRunner,
      });
      insertEventSync(database, {
        payload: {
          dry_run: parsed.flags.dryRun,
          followup_length: followup?.length ?? 0,
          key: parsed.flags.key,
          session: name,
          success: true,
        },
        type: "session_interrupted",
      });
      emitTelemetrySync(database, {
        actor: "workerctl",
        attributes: {
          dry_run: parsed.flags.dryRun,
          followup_length: followup?.length ?? 0,
          success: true,
        },
        correlation: { ...telemetry.correlation, dry_run: parsed.flags.dryRun, key: parsed.flags.key, session: name },
        eventType: "session_interrupt_succeeded",
        severity: "info",
        summary: `Interrupted session ${name}.`,
        taskId: telemetry.taskId,
        timestamp: nowIsoSeconds(options),
      });
      return jsonResult(result);
    } catch (error) {
      recordSessionActionFailure(database, {
        action: "interrupt",
        dryRun: parsed.flags.dryRun,
        error,
        key: parsed.flags.key,
        name,
        telemetry,
        textLength: followup?.length ?? 0,
        timestamp: nowIsoSeconds(options),
      });
      throw error;
    }
  } finally {
    database.close();
  }
}

function runCycleCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const unsupported = unsupportedCycleOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const result = runCycleSync(database, {
      busyWaitSeconds: parsed.flags.busyWaitSeconds,
      now: nowIsoSeconds(options),
      taskName,
      tmuxRunner: options.tmuxRunner ?? defaultTmuxRunner,
    });
    return jsonResult(result);
  } finally {
    database.close();
  }
}

function parseStdinJsonObject(input: string | undefined): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--from-stdin requires a JSON object: ${message}`, { cause: error });
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("--from-stdin requires a JSON object");
  }
  return parsed;
}

function maybeActiveBindingForTask(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskName: string,
): { binding_id: string } | null {
  try {
    return activeBindingForTaskSync(database, taskName);
  } catch {
    return null;
  }
}

function insertTaskAcknowledgementSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    bindingId: string | null;
    correlationId: string | null;
    payload: Record<string, unknown>;
    role: "manager" | "worker";
    taskId: string;
    timestamp: string;
  },
): number {
  const config = database.prepare("select revision from manager_configs where task_id = ?")
    .get(options.taskId) as { revision: number } | undefined;
  const row = database.prepare(`
    select max(revision) as revision
    from task_acknowledgements
    where task_id = ? and role = ?
  `).get(options.taskId, options.role) as { revision: number | null } | undefined;
  const revision = Number(row?.revision ?? 0) + 1;
  const result = database.prepare(`
    insert into task_acknowledgements(
      task_id, binding_id, role, payload_json, revision, manager_config_revision, created_at, correlation_id
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.bindingId,
    options.role,
    stableJson(options.payload),
    revision,
    config?.revision ?? null,
    options.timestamp,
    options.correlationId,
  );
  return Number(result.lastInsertRowid);
}

function latestTaskAcknowledgementSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { role: "manager" | "worker"; taskId: string },
): Record<string, unknown> | null {
  const row = database.prepare(`
    select id, task_id, binding_id, role, payload_json, revision,
           manager_config_revision, created_at, correlation_id
    from task_acknowledgements
    where task_id = ? and role = ?
    order by revision desc, id desc
    limit 1
  `).get(options.taskId, options.role) as {
    binding_id: string | null;
    correlation_id: string | null;
    created_at: string;
    id: number;
    manager_config_revision: number | null;
    payload_json: string;
    revision: number;
    role: string;
    task_id: string;
  } | undefined;
  if (!row) {
    return null;
  }
  return {
    binding_id: row.binding_id,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    id: row.id,
    manager_config_revision: row.manager_config_revision,
    payload: parseJsonObject(row.payload_json),
    revision: row.revision,
    role: row.role,
    task_id: row.task_id,
  };
}

function sessionInboxResponse(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    consumeNext: boolean;
    intervalSeconds: number;
    limit: number;
    now: Date;
    sessionName: string;
    sleepMilliseconds?: (milliseconds: number) => void;
    timeoutSeconds: number;
    wait: boolean;
  },
): Record<string, unknown> {
  if (options.timeoutSeconds < 0) {
    throw new Error("--timeout must be non-negative");
  }
  if (options.intervalSeconds <= 0) {
    throw new Error("--interval must be greater than zero");
  }
  const session = sessionRow(database, options.sessionName);
  const started = options.now.getTime();
  let consumed: Record<string, unknown> | null = null;
  let items: Array<Record<string, unknown>>;
  let pollCount = 0;
  let timedOut = false;
  while (true) {
    pollCount += 1;
    const now = new Date(started + Math.max(0, pollCount - 1) * options.intervalSeconds * 1000);
    if (options.consumeNext) {
      consumed = consumeNextSessionInboxItemSync(database, {
        now: now.toISOString(),
        sessionName: options.sessionName,
      }) as unknown as Record<string, unknown> | null;
      if (consumed !== null) {
        emitInboxConsumedTelemetry(database, { consumed, pollCount, session, wait: options.wait });
        break;
      }
    } else {
      items = sessionInboxSync(database, {
        limit: options.limit,
        sessionName: options.sessionName,
      }) as unknown as Array<Record<string, unknown>>;
      if (items.length > 0) {
        break;
      }
    }
    if (!options.wait) {
      break;
    }
    const syntheticElapsed = ((pollCount - 1) * options.intervalSeconds);
    if (syntheticElapsed >= options.timeoutSeconds) {
      timedOut = true;
      break;
    }
    (options.sleepMilliseconds ?? sleepSync)(Math.min(options.intervalSeconds, Math.max(0, options.timeoutSeconds - syntheticElapsed)) * 1000);
  }
  items = sessionInboxSync(database, {
    limit: options.limit,
    sessionName: options.sessionName,
  }) as unknown as Array<Record<string, unknown>>;
  return {
    consumed,
    items,
    session: {
      id: session.id,
      name: session.name,
      role: session.role,
    },
    wait: {
      enabled: options.wait,
      elapsed_seconds: Math.round(Math.min(options.timeoutSeconds, ((pollCount - 1) * options.intervalSeconds)) * 1000) / 1000,
      interval_seconds: options.intervalSeconds,
      poll_count: pollCount,
      timed_out: timedOut,
      timeout_seconds: options.timeoutSeconds,
    },
  };
}

function emitInboxConsumedTelemetry(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    consumed: Record<string, unknown>;
    pollCount: number;
    session: { id: string; name: string; role: string };
    wait: boolean;
  },
): void {
  emitTelemetrySync(database, {
    actor: "dispatch",
    attributes: {
      consumed_by_session_id: options.consumed.consumed_by_session_id ?? null,
      delivery_mode: options.consumed.delivery_mode ?? null,
      poll_count: options.pollCount,
      source_session_name: options.consumed.source_session_name ?? null,
      target_session_name: options.consumed.target_session_name ?? null,
      target_session_role: options.session.role,
      wait_enabled: options.wait,
    },
    correlation: {
      correlation_id: options.consumed.correlation_id ?? null,
      notification_id: options.consumed.id ?? null,
      signal_type: options.consumed.signal_type ?? null,
      target_session_id: options.consumed.target_session_id ?? null,
    },
    eventType: "dispatch_inbox_consumed",
    severity: "info",
    summary: `${options.session.role} session consumed dispatcher inbox item.`,
    taskId: typeof options.consumed.task_id === "string" ? options.consumed.task_id : null,
    timestamp: new Date().toISOString(),
  });
}

function renderSessionInboxText(result: Record<string, unknown>): string {
  const session = result.session as Record<string, unknown> | undefined;
  const task = result.task as Record<string, unknown> | undefined;
  const items = (result.items as Array<Record<string, unknown>> | undefined) ?? [];
  const lines = [`inbox for ${session?.name ?? "unknown session"}${task?.name ? ` on ${task.name}` : ""}`];
  const consumed = result.consumed as Record<string, unknown> | null | undefined;
  if (consumed) {
    lines.push(
      `consumed #${consumed.id} ${consumed.signal_type} ${consumed.delivery_mode} `
      + `from ${consumed.source_session_name ?? consumed.source_session_id} `
      + `to ${consumed.target_session_name ?? consumed.target_session_id} `
      + `at ${consumed.consumed_at} (${consumed.correlation_id})`,
    );
  }
  if (items.length === 0) {
    lines.push("pending: none");
  } else {
    lines.push(`pending: ${items.length}`);
    for (const item of items) {
      lines.push(
        `#${item.id} ${item.signal_type} ${item.delivery_mode} `
        + `from ${item.source_session_name ?? item.source_session_id} `
        + `to ${item.target_session_name ?? item.target_session_id} `
        + `delivered ${item.delivered_at ?? "not-yet"} (${item.correlation_id})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function sendTextToRegisteredSession(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    dryRun: boolean;
    name: string;
    sleepMilliseconds?: (milliseconds: number) => void;
    text: string;
    tmuxRunner: TmuxRunner;
  },
): Record<string, unknown> {
  const session = sessionRow(database, options.name);
  return sendTextToSessionWithRunner(session, options.text, options.tmuxRunner, {
    dryRun: options.dryRun,
    now: () => new Date().toISOString(),
    sleep: options.sleepMilliseconds,
  }) as unknown as Record<string, unknown>;
}

function interruptRegisteredSession(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    dryRun: boolean;
    followup: string | null;
    key: string;
    name: string;
    sleepMilliseconds?: (milliseconds: number) => void;
    tmuxRunner: TmuxRunner;
  },
): Record<string, unknown> {
  const session = sessionRow(database, options.name);
  const target = registeredSessionTmuxTarget(session);
  const result: Record<string, unknown> = {
    dry_run: options.dryRun,
    followup: options.followup,
    key: options.key,
    session: options.name,
    target,
    time: new Date().toISOString(),
  };
  if (options.dryRun) {
    return result;
  }
  if (!session.tmux_session || !tmuxSessionRunning(session.tmux_session, options.tmuxRunner)) {
    throw new Error(`tmux session is not running for session ${JSON.stringify(options.name)}: ${session.tmux_session}`);
  }
  runTmuxCommandWithRunner(["tmux", "send-keys", "-t", target, options.key], options.tmuxRunner);
  if (options.followup) {
    options.sleepMilliseconds?.(500);
    sendTextToSessionWithRunner(session, options.followup, options.tmuxRunner, {
      now: () => new Date().toISOString(),
      sleep: options.sleepMilliseconds,
    });
  }
  return result;
}

function registeredSessionTmuxTarget(row: { tmux_pane_id?: string | null; tmux_session?: string | null }): string {
  if (!row.tmux_session) {
    throw new Error("session has no tmux_session; cannot build tmux target (session likely registered outside tmux)");
  }
  return row.tmux_pane_id ? `${row.tmux_session}:${row.tmux_pane_id}` : row.tmux_session;
}

function interruptLegacyWorker(
  name: string,
  options: { dryRun: boolean; followup: string | null; key: string; tmuxRunner: TmuxRunner },
): Record<string, unknown> {
  const target = tmuxSession(name);
  if (!sessionExists(name, options.tmuxRunner)) {
    throw new Error(`tmux session is not running for worker ${name}: ${target}`);
  }
  const result: Record<string, unknown> = {
    dry_run: options.dryRun,
    followup: options.followup,
    key: options.key,
    name,
    time: new Date().toISOString(),
  };
  if (!options.dryRun) {
    runTmuxCommandWithRunner(["tmux", "send-keys", "-t", target, options.key], options.tmuxRunner);
    if (options.followup) {
      sleepSync(500);
      sendTextToLegacyWorker(name, options.followup, options.tmuxRunner);
    }
  }
  return result;
}

function sessionActionTelemetryContext(
  database: ReturnType<typeof openRuntimeDatabase>,
  sessionName: string,
): { correlation: Record<string, unknown>; taskId: string | null } {
  const row = database.prepare(`
    select sessions.id as session_id, sessions.role, bindings.id as binding_id,
           bindings.task_id as task_id
    from sessions
    left join bindings
      on bindings.state in ('active', 'ending')
     and (bindings.worker_session_id = sessions.id or bindings.manager_session_id = sessions.id)
    where sessions.name = ?
    order by bindings.id desc
    limit 1
  `).get(sessionName) as {
    binding_id: string | null;
    role: string | null;
    session_id: string | null;
    task_id: string | null;
  } | undefined;
  if (!row) {
    return { correlation: { binding_id: null, role: null, session_id: null }, taskId: null };
  }
  return {
    correlation: {
      binding_id: row.binding_id,
      role: row.role,
      session_id: row.session_id,
    },
    taskId: row.task_id,
  };
}

function recordSessionActionFailure(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    action: "interrupt" | "nudge";
    dryRun: boolean;
    error: unknown;
    key: string | null;
    name: string;
    telemetry: { correlation: Record<string, unknown>; taskId: string | null };
    textLength: number;
    timestamp: string;
  },
): void {
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  const errorType = options.error instanceof Error ? options.error.name : typeof options.error;
  insertEventSync(database, {
    payload: {
      dry_run: options.dryRun,
      error: message,
      error_type: errorType,
      ...(options.key ? { key: options.key } : {}),
      session: options.name,
      success: false,
      ...(options.action === "interrupt" ? { followup_length: options.textLength } : { text_length: options.textLength }),
    },
    type: options.action === "interrupt" ? "session_interrupted" : "session_nudged",
  });
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      dry_run: options.dryRun,
      error: message,
      error_type: errorType,
      success: false,
      ...(options.action === "interrupt" ? { followup_length: options.textLength } : { text_length: options.textLength }),
    },
    correlation: { ...options.telemetry.correlation, dry_run: options.dryRun, ...(options.key ? { key: options.key } : {}), session: options.name },
    eventType: options.action === "interrupt" ? "session_interrupt_failed" : "session_nudge_failed",
    severity: "error",
    summary: `Failed to ${options.action} session ${options.name}.`,
    taskId: options.telemetry.taskId,
    timestamp: options.timestamp,
  });
}

function runCycleSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { busyWaitSeconds: number; now: string; taskName: string; tmuxRunner: TmuxRunner },
): Record<string, unknown> {
  const binding = activeBindingForTaskSync(database, options.taskName);
  const cycleId = createManagerCycleSync(database, { taskId: binding.task_id, timestamp: options.now });
  const spans = new ManagerCycleSpanRecorder(database, { managerCycleId: cycleId, taskId: binding.task_id });
  spans.instant("start_cycle", {
    attributes: {
      binding_id: binding.binding_id,
      busy_wait_seconds: options.busyWaitSeconds,
      manager_session: binding.manager_session_name,
      worker_session: binding.worker_session_name,
    },
  });
  emitTelemetrySync(database, {
    actor: "manager",
    attributes: { busy_wait_seconds: options.busyWaitSeconds, cycle_id: cycleId },
    correlation: {
      binding_id: binding.binding_id,
      manager_session: binding.manager_session_name,
      worker_session: binding.worker_session_name,
    },
    eventType: "manager_cycle_started",
    severity: "info",
    summary: `Started manager cycle for task ${options.taskName}.`,
    taskId: binding.task_id,
    timestamp: options.now,
  });

  let completedAt: string;
  let activeSpan: ManagerCycleSpanToken | null = null;
  try {
    activeSpan = spans.start("ingest_rollout");
    const ingest = ingestSessionSync(database, { now: options.now, sessionName: binding.worker_session_name });
    spans.finish(activeSpan, {
      attributes: {
        new_events: ingest.new_events,
        new_offset: ingest.new_offset,
        worker_session: binding.worker_session_name,
      },
    });
    activeSpan = null;

    activeSpan = spans.start("infer_worker_state");
    const workerSession = sessionRow(database, binding.worker_session_name, "worker");
    const managerSession = sessionRow(database, binding.manager_session_name, "manager");
    const stateInfo = latestWorkerStateSync(database, workerSession.id, options.now);
    spans.finish(activeSpan, {
      attributes: {
        last_state_event_present: stateInfo.last_state_event_at !== null,
        state: stateInfo.state,
        staleness_seconds: stateInfo.staleness_seconds,
      },
    });
    activeSpan = null;

    activeSpan = spans.start("capture_pane_signal");
    const paneSignal = paneSignalForCycle(workerSession, {
      busyWaitSeconds: options.busyWaitSeconds,
      statusAgeSeconds: stateInfo.staleness_seconds,
      tmuxRunner: options.tmuxRunner,
    });
    spans.finish(activeSpan, {
      attributes: paneSpanAttributes(paneSignal),
      state: paneSignal.degraded ? "degraded" : "succeeded",
    });
    activeSpan = null;

    activeSpan = spans.start("load_manager_context");
    const managerConfig = managerConfigSync(database, binding.task_id);
    const workerAck = latestTaskAcknowledgementSync(database, { role: "worker", taskId: binding.task_id });
    const managerAck = latestTaskAcknowledgementSync(database, { role: "manager", taskId: binding.task_id });
    if (managerConfig?.require_acks) {
      const stale = [
        ["worker", workerAck],
        ["manager", managerAck],
      ].flatMap(([role, ack]) => {
        const record = ack as Record<string, unknown> | null;
        return record === null
          || record.binding_id !== binding.binding_id
          || record.manager_config_revision !== managerConfig.revision
          ? [role]
          : [];
      });
      if (stale.length > 0) {
        throw new Error(`cycle requires current acknowledgement(s) before first observation: ${stale.join(", ")}`);
      }
    }
    const consumed = consumeRoutedNotificationsForCycleSync(database, {
      bindingId: binding.binding_id,
      managerCycleId: cycleId,
      now: options.now,
      taskId: binding.task_id,
    });
    const acceptanceContext = acceptanceCriteriaContext(database, binding.task_id);
    const acceptanceSummary = acceptanceContext.summary as Record<string, number>;
    const managerContext = {
      acceptance_criteria: acceptanceContext,
      criteria_negotiation: { task: options.taskName },
      manager_ack: managerAck,
      manager_config: managerConfig,
      worker_ack: workerAck,
      worker_handoff: latestWorkerHandoffFullSync(database, binding.task_id),
      worker_receipt: latestWorkerReceiptForTaskSync(database, binding.task_id),
    };
    spans.finish(activeSpan, {
      attributes: {
        accepted_criteria: acceptanceSummary.accepted ?? 0,
        consumed_dispatch_notifications: consumed,
        manager_ack_present: managerAck !== null,
        manager_config_present: managerConfig !== null,
        require_acks: Boolean(managerConfig?.require_acks),
        worker_ack_present: workerAck !== null,
        worker_handoff_present: managerContext.worker_handoff !== null,
        worker_receipt_present: managerContext.worker_receipt !== null,
      },
    });
    activeSpan = null;

    completedAt = new Date().toISOString();
    const statusPayload: Record<string, unknown> = {
      binding_id: binding.binding_id,
      consumed_dispatch_notifications: consumed,
      ingest,
      kind: "session_cycle",
      last_event_subtype: stateInfo.last_event_subtype,
      last_state_event_at: stateInfo.last_state_event_at,
      manager_alive: sessionPidAlive(managerSession),
      manager_context: managerContext,
      manager_session: binding.manager_session_name,
      notable_pane_pattern: paneSignal.notable_pattern,
      pane_signal: paneSignal,
      staleness_seconds: stateInfo.staleness_seconds,
      state: stateInfo.state,
      task: options.taskName,
      task_completed: stateInfo.last_event_subtype === "task_complete",
      worker_alive: sessionPidAlive(workerSession),
      worker_session: binding.worker_session_name,
    };
    activeSpan = spans.start("persist_cycle_row");
    finishManagerCycleSync(database, {
      cycleId,
      state: "succeeded",
      status: statusPayload,
      timestamp: completedAt,
    });
    spans.finish(activeSpan, {
      attributes: {
        manager_alive: statusPayload.manager_alive,
        state: stateInfo.state,
        task_completed: stateInfo.last_event_subtype === "task_complete",
        worker_alive: statusPayload.worker_alive,
      },
    });
    activeSpan = null;
    emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        ingest,
        last_event_subtype: stateInfo.last_event_subtype,
        notable_pane_pattern: paneSignal.notable_pattern,
        state: stateInfo.state,
        task_completed: stateInfo.last_event_subtype === "task_complete",
        worker_alive: statusPayload.worker_alive,
        manager_alive: statusPayload.manager_alive,
      },
      correlation: {
        binding_id: binding.binding_id,
        cycle_id: cycleId,
        manager_session: binding.manager_session_name,
        worker_session: binding.worker_session_name,
      },
      eventType: "manager_cycle_succeeded",
      severity: "info",
      summary: `Manager cycle succeeded for task ${options.taskName}.`,
      taskId: binding.task_id,
      timestamp: completedAt,
    });
    return {
      ...statusPayload,
      cycle_completed_at: completedAt,
      cycle_id: cycleId,
      cycle_started_at: options.now,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof Error ? error.name : typeof error;
    if (activeSpan !== null) {
      spans.finish(activeSpan, { errorType, state: "failed" });
    }
    completedAt = new Date().toISOString();
    const failureStatus = {
      binding_id: binding.binding_id,
      error_type: errorType,
      failure_phase: "cycle",
      kind: "session_cycle",
      manager_session: binding.manager_session_name,
      task: options.taskName,
      worker_session: binding.worker_session_name,
    };
    finishManagerCycleSync(database, {
      cycleId,
      error: message,
      state: "failed",
      status: failureStatus,
      timestamp: completedAt,
    });
    spans.instant("cycle_failed", {
      attributes: { error: message, failure_phase: "cycle" },
      errorType,
      state: "failed",
    });
    emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        error_type: errorType,
        failure_phase: "cycle",
      },
      correlation: {
        binding_id: binding.binding_id,
        cycle_id: cycleId,
        manager_session: binding.manager_session_name,
        worker_session: binding.worker_session_name,
      },
      eventType: "manager_cycle_failed",
      severity: "error",
      summary: `Manager cycle failed for task ${options.taskName}.`,
      taskId: binding.task_id,
      timestamp: completedAt,
    });
    throw error;
  }
}

function createManagerCycleSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { taskId: string; timestamp: string },
): number {
  const result = database.prepare(`
    insert into manager_cycles(task_id, manager_id, started_at, state)
    values (?, null, ?, 'started')
  `).run(options.taskId, options.timestamp);
  return Number(result.lastInsertRowid);
}

function finishManagerCycleSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { cycleId: number; error?: string | null; state: "failed" | "succeeded"; status: Record<string, unknown>; timestamp: string },
): void {
  database.prepare(`
    update manager_cycles
    set completed_at = ?, state = ?, status_json = ?, health_json = ?, decision = null, error = ?
    where id = ?
  `).run(
    options.timestamp,
    options.state,
    stableJson(options.status),
    null,
    options.error ?? null,
    options.cycleId,
  );
}

interface ManagerCycleSpanToken {
  phase: string;
  startedAt: string;
  startedNs: bigint;
}

class ManagerCycleSpanRecorder {
  private readonly database: RuntimeDatabase;
  private readonly managerCycleId: number;
  private readonly runId: string | null;
  private readonly taskId: string;

  constructor(database: RuntimeDatabase, options: { managerCycleId: number; taskId: string }) {
    this.database = database;
    this.managerCycleId = options.managerCycleId;
    this.taskId = options.taskId;
    const run = activeRunForTaskSync(database, options.taskId);
    this.runId = typeof run?.id === "string" ? run.id : null;
  }

  start(phase: string): ManagerCycleSpanToken {
    return {
      phase,
      startedAt: new Date().toISOString(),
      startedNs: process.hrtime.bigint(),
    };
  }

  finish(
    token: ManagerCycleSpanToken,
    options?: { attributes?: Record<string, unknown>; errorType?: string | null; state?: "degraded" | "failed" | "succeeded" },
  ): void {
    const completedAt = new Date().toISOString();
    const durationMs = Number((Number(process.hrtime.bigint() - token.startedNs) / 1_000_000).toFixed(3));
    insertManagerCycleSpanSync(this.database, {
      attributes: options?.attributes ?? {},
      completedAt,
      durationMs: Math.max(durationMs, 0),
      errorType: options?.errorType ?? null,
      managerCycleId: this.managerCycleId,
      phase: token.phase,
      runId: this.runId,
      startedAt: token.startedAt,
      state: options?.state ?? "succeeded",
      taskId: this.taskId,
    });
  }

  instant(
    phase: string,
    options?: { attributes?: Record<string, unknown>; errorType?: string | null; state?: "degraded" | "failed" | "succeeded" },
  ): void {
    this.finish(this.start(phase), options);
  }
}

function insertManagerCycleSpanSync(
  database: RuntimeDatabase,
  options: {
    attributes: Record<string, unknown>;
    completedAt: string;
    durationMs: number;
    errorType: string | null;
    managerCycleId: number;
    phase: string;
    runId: string | null;
    startedAt: string;
    state: "degraded" | "failed" | "succeeded";
    taskId: string;
  },
): void {
  database.prepare(`
    insert into manager_cycle_spans(
      manager_cycle_id, task_id, run_id, phase, started_at, completed_at,
      duration_ms, state, attributes_json, error_type, manager_decision_id,
      command_id
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)
  `).run(
    options.managerCycleId,
    options.taskId,
    options.runId,
    options.phase,
    options.startedAt,
    options.completedAt,
    options.durationMs,
    options.state,
    stableJson(options.attributes),
    options.errorType,
  );
}

function paneSpanAttributes(paneSignal: Record<string, unknown>): Record<string, unknown> {
  return {
    captured: Boolean(paneSignal.captured),
    classifier: paneSignal.classifier ?? null,
    degraded: Boolean(paneSignal.degraded),
    notable_pattern: paneSignal.notable_pattern ?? null,
    status_age_seconds: paneSignal.status_age_seconds ?? null,
  };
}

function latestWorkerStateSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  sessionId: string,
  now: string,
): { last_event_subtype: string | null; last_state_event_at: string | null; staleness_seconds: number | null; state: string } {
  const latest = database.prepare(`
    select timestamp, subtype
    from codex_events
    where session_id = ?
    order by id desc
    limit 1
  `).get(sessionId) as { subtype: string | null; timestamp: string } | undefined;
  const stateRow = database.prepare(`
    select timestamp, subtype
    from codex_events
    where session_id = ?
      and type = 'event_msg'
      and subtype in ('task_started', 'user_message', 'task_complete')
    order by id desc
    limit 1
  `).get(sessionId) as { subtype: string | null; timestamp: string } | undefined;
  const state = stateRow?.subtype === "task_complete"
    ? "idle"
    : stateRow?.subtype === "task_started" || stateRow?.subtype === "user_message"
      ? "busy"
      : "unknown";
  return {
    last_event_subtype: latest?.subtype ?? null,
    last_state_event_at: stateRow?.timestamp ?? null,
    staleness_seconds: ageSecondsAt(stateRow?.timestamp, new Date(now)),
    state,
  };
}

function paneSignalForCycle(
  workerSession: { name: string; tmux_pane_id?: string | null; tmux_session?: string | null },
  options: { busyWaitSeconds: number; statusAgeSeconds: number | null; tmuxRunner: TmuxRunner },
): Record<string, unknown> {
  if (!workerSession.tmux_session) {
    return {
      captured: false,
      classifier: null,
      degraded: false,
      notable_pattern: null,
      reason: "session has no tmux_session",
      status_age_seconds: options.statusAgeSeconds,
    };
  }
  try {
    const target = registeredSessionTmuxTarget(workerSession);
    if (!tmuxSessionRunning(workerSession.tmux_session, options.tmuxRunner)) {
      return {
        captured: false,
        classifier: null,
        degraded: true,
        notable_pattern: "tmux_session_missing",
        reason: `tmux session is not running: ${workerSession.tmux_session}`,
        status_age_seconds: options.statusAgeSeconds,
      };
    }
    const output = captureTmuxTargetWithRunner(target, DEFAULT_HISTORY_LINES, options.tmuxRunner);
    const busyWait = classifyBusyWait(output, options.statusAgeSeconds, options.busyWaitSeconds);
    return {
      captured: true,
      classifier: busyWait,
      degraded: false,
      notable_pattern: busyWait?.pattern ?? null,
      reason: busyWait?.reason ?? "pane captured",
      status_age_seconds: options.statusAgeSeconds,
    };
  } catch (error) {
    return {
      captured: false,
      classifier: null,
      degraded: true,
      notable_pattern: "pane_signal_error",
      reason: error instanceof Error ? error.message : String(error),
      status_age_seconds: options.statusAgeSeconds,
    };
  }
}

function sessionPidAlive(session: { pid?: number | null }): boolean {
  return typeof session.pid === "number" ? pidIsAlive(session.pid) : false;
}

function consumeRoutedNotificationsForCycleSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { bindingId: string; managerCycleId: number; now: string; taskId: string },
): number {
  const result = database.prepare(`
    update routed_notifications
    set consumed_manager_cycle_id = ?, consumed_at = ?
    where task_id = ?
      and binding_id = ?
      and state = 'delivered'
      and consumed_manager_cycle_id is null
      and consumed_at is null
      and target_session_id = (
        select manager_session_id from bindings where id = ?
      )
  `).run(options.managerCycleId, options.now, options.taskId, options.bindingId, options.bindingId);
  return Number(result.changes ?? 0);
}

function acceptanceCriteriaContext(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): Record<string, unknown> {
  const criteria = acceptanceCriteriaForTaskSync(database, { taskId });
  const summary: Record<string, number> = {
    accepted: 0,
    deferred: 0,
    proposed: 0,
    rejected: 0,
    satisfied: 0,
  };
  for (const criterion of criteria) {
    summary[criterion.status] = (summary[criterion.status] ?? 0) + 1;
  }
  return {
    accepted: criteria.filter((criterion) => criterion.status === "accepted"),
    deferred: criteria.filter((criterion) => criterion.status === "deferred"),
    open: criteria.filter((criterion) => criterion.status === "accepted" || criterion.status === "proposed"),
    proposed: criteria.filter((criterion) => criterion.status === "proposed"),
    rejected: criteria.filter((criterion) => criterion.status === "rejected"),
    satisfied: criteria.filter((criterion) => criterion.status === "satisfied"),
    summary,
  };
}

function latestWorkerReceiptForTaskSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): Record<string, unknown> | null {
  const row = database.prepare(`
    select
      ce.id as source_event_id,
      ce.timestamp as source_event_timestamp,
      ce.session_id as source_session_id,
      ce.payload_json as source_payload_json,
      s.name as source_session_name,
      b.id as binding_id
    from codex_events ce
    join bindings b on b.worker_session_id = ce.session_id
    join sessions s on s.id = ce.session_id
    where b.task_id = ?
      and ce.subtype = 'task_complete'
    order by ce.id desc
    limit 1
  `).get(taskId) as {
    binding_id: string;
    source_event_id: number;
    source_event_timestamp: string;
    source_payload_json: string;
    source_session_id: string;
    source_session_name: string;
  } | undefined;
  if (!row) {
    return null;
  }
  const payload = parseJsonObject(row.source_payload_json);
  return {
    binding_id: row.binding_id,
    completed_at: payload.completed_at ?? null,
    duration_ms: payload.duration_ms ?? null,
    last_agent_message: payload.last_agent_message ?? null,
    source_event_id: row.source_event_id,
    source_event_timestamp: row.source_event_timestamp,
    source_session_id: row.source_session_id,
    source_session_name: row.source_session_name,
    time_to_first_token_ms: payload.time_to_first_token_ms ?? null,
    turn_id: payload.turn_id ?? null,
  };
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

function runManagerConfigCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const unsupported = unsupportedManagerConfigOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const existing = managerConfigSync(database, task.id);
    if (parsed.flags.questions) {
      return jsonResult({
        fallback_collection: "conveyor manager-config --interactive",
        questions: managerConfigQuestions(existing),
        recommended_collection: "manager_codex_chat",
        task: { id: task.id, name: task.name },
      });
    }
    const mutating = managerConfigMutationRequested(parsed) || existing === null;
    let permissionWarnings: string[] = [];
    if (mutating) {
      permissionWarnings = managerPermissionWarnings(parseJsonObjectFlag(parsed.flags.managerPermissionsJson, "--permissions-json"));
      const config = upsertManagerConfigFromParsed(database, {
        existing,
        parsed,
        taskId: task.id,
        timestamp: nowIsoSeconds(options),
      });
      insertEventSync(database, {
        payload: {
          acceptance_count: parsed.flags.managerAcceptance.length,
          epilogue_count: config.epilogues.length,
          guideline_count: parsed.flags.managerGuideline.length,
          nudge_on_completion: config.nudge_on_completion,
          permission_warnings: permissionWarnings,
          reference_count: parsed.flags.managerReference.length,
          require_acks: config.require_acks,
          supervision_mode: config.supervision_mode,
          tool_count: config.tools.length,
        },
        taskId: task.id,
        type: "manager_config_recorded",
      });
    }
    const config = managerConfigSync(database, task.id);
    if (config === null) {
      throw new Error(`manager config was not recorded for task ${task.id}`);
    }
    return jsonResult(permissionWarnings.length > 0 ? { ...config, warnings: permissionWarnings } : config);
  } finally {
    database.close();
  }
}

function runManagerPermissionCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const unsupported = unsupportedManagerPermissionOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const action = parsed.flags.action;
  if (action === null) {
    throw new Error("manager-permission requires an action or category.");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const config = managerConfigSync(database, task.id);
    const handoff = latestWorkerHandoffSync(database, task.id);
    const reasons: string[] = [];
    let allowed = false;
    let listedPermissions: string[] | null = null;
    if (config === null) {
      reasons.push("missing_manager_config");
    } else if (parsed.flags.list) {
      if (!isManagerPermissionCategoryName(action)) {
        throw new Error(`--list expects a permission category, got: ${action}`);
      }
      listedPermissions = [...config.permissions[action]];
      allowed = true;
    } else {
      assertKnownManagerPermissionAction(action);
      allowed = managerConfigPermissionAllowed(config, action);
      if (!allowed) {
        reasons.push("permission_not_enabled");
      }
    }
    if (!parsed.flags.list && parsed.flags.requireHandoff && handoff === null) {
      allowed = false;
      reasons.push("missing_worker_handoff");
    }
    const result = {
      action,
      allowed,
      config,
      handoff_id: handoff?.id ?? null,
      listed_permissions: listedPermissions,
      reasons,
      require_handoff: parsed.flags.requireHandoff,
      task: { id: task.id, name: task.name },
    };
    insertEventSync(database, {
      payload: result,
      taskId: task.id,
      type: "manager_permission_checked",
    });
    emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        allowed,
        reasons,
        require_handoff: parsed.flags.requireHandoff,
      },
      correlation: { action, handoff_id: result.handoff_id },
      eventType: "manager_permission_checked",
      severity: allowed ? "info" : "warning",
      summary: `Checked manager permission ${action}.`,
      taskId: task.id,
      timestamp: nowIsoSeconds(options),
    });
    return {
      exitCode: parsed.flags.require && !allowed ? 1 : 0,
      handled: true,
      stdout: `${JSON.stringify(sortJson(result), null, 2)}\n`,
    };
  } finally {
    database.close();
  }
}

function runRecordDecisionCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const unsupported = unsupportedRecordDecisionOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const decision = parsed.flags.decision;
  if (decision === null) {
    throw new Error("record-decision requires a decision.");
  }
  if (!MANAGER_DECISIONS.has(decision)) {
    throw new Error(`unknown manager decision: ${decision}`);
  }
  if (parsed.flags.reason === null) {
    throw new Error("record-decision requires --reason.");
  }
  const payload = parseJsonObjectFlag(parsed.flags.metadataJson, "--payload-json") ?? {};
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const manager = activeManagerForTaskSync(database, task.id);
    const timestamp = nowIsoSeconds(options);
    const insert = database.prepare(`
      insert into manager_decisions(
        task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
      )
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      manager?.id ?? null,
      parsed.flags.cycleId,
      decision,
      parsed.flags.reason,
      timestamp,
      stableJson(payload),
    );
    const decisionId = Number(insert.lastInsertRowid);
    insertEventSync(database, {
      managerId: manager?.id ?? null,
      payload: {
        decision,
        decision_id: decisionId,
        manager_cycle_id: parsed.flags.cycleId,
        reason: parsed.flags.reason,
      },
      taskId: task.id,
      type: "manager_decision_recorded",
    });
    return jsonResult({
      created_at: timestamp,
      decision,
      id: decisionId,
      manager_cycle_id: parsed.flags.cycleId,
      manager_id: manager?.id ?? null,
      payload,
      reason: parsed.flags.reason,
      task: { id: task.id, name: task.name },
      task_id: task.id,
    });
  } finally {
    database.close();
  }
}

function runContinuationCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; stdin?: string },
): TypescriptRuntimeResult {
  const unsupported = unsupportedContinuationOptions(parsed);
  if (unsupported) {
    return unsupportedRuntimeResult(parsed, unsupported);
  }
  const taskName = requireTask(parsed);
  const operations = [
    parsed.flags.submitRole !== null,
    parsed.flags.review,
    parsed.flags.list,
  ].filter(Boolean).length;
  if (operations !== 1) {
    throw new Error("continuation requires exactly one of --submit, --review, or --list");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const config = managerConfigSync(database, task.id);
    if (parsed.flags.list) {
      const rows = taskContinuationRowsSync(database, {
        correlationId: parsed.flags.correlationId,
        taskId: task.id,
      });
      return jsonResult({
        continuations: redactContinuationPayloads(rows, {
          asRole: parsed.flags.asRole,
          correlationId: parsed.flags.correlationId,
          includePayload: parsed.flags.includeContent,
        }),
        reviews: continuationReviewRowsSync(database, task.id),
        task: { id: task.id, name: task.name },
      });
    }

    if (parsed.flags.submitRole !== null) {
      const proposer = parsed.flags.submitRole;
      const payload = continuationPayloadFromStdin(parsed, options);
      let correlationId = parsed.flags.correlationId;
      if (proposer === "worker") {
        correlationId ??= `continuation-${randomUUID()}`;
      } else {
        if (correlationId === null) {
          throw new Error("manager continuation requires --correlation-id from the worker proposal turn");
        }
        if (latestTaskContinuationSync(database, {
          correlationId,
          proposer: "worker",
          taskId: task.id,
        }) === null) {
          throw new Error("manager continuation requires an existing worker continuation for the same correlation_id");
        }
      }
      const continuationId = insertTaskContinuationSync(database, {
        correlationId,
        payload,
        proposer,
        taskId: task.id,
        timestamp: nowIsoSeconds(options),
      });
      insertEventSync(database, {
        actor: proposer,
        correlationId,
        payload: {
          continuation_id: continuationId,
          payload_keys: Object.keys(payload).sort(),
          proposer,
        },
        taskId: task.id,
        type: "task_continuation_recorded",
      });
      const row = latestTaskContinuationSync(database, { correlationId, proposer, taskId: task.id });
      if (row === null) {
        throw new Error("task continuation was not recorded");
      }
      return jsonResult(row);
    }

    const correlationId = parsed.flags.correlationId;
    if (correlationId === null) {
      throw new Error("continuation --review requires --correlation-id");
    }
    if (!managerConfigPermissionAllowed(config, "context.spawn_reviewer")) {
      throw new Error("continuation review requires manager permission context.spawn_reviewer");
    }
    const pair = continuationPairSync(database, { correlationId, taskId: task.id });
    const payload = validateContinuationReviewPayload(continuationPayloadFromStdin(parsed, options));
    const output = recordContinuationReviewSync(database, {
      config,
      correlationId,
      manager: pair.manager,
      payload,
      task,
      timestamp: nowIsoSeconds(options),
      worker: pair.worker,
    });
    return jsonResult(output);
  } finally {
    database.close();
  }
}

function runContinuationReviewerCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  const correlationId = parsed.flags.correlationId;
  if (correlationId === null) {
    throw new Error("continuation-reviewer requires --correlation-id");
  }
  if (parsed.flags.reviewerSessionId === null) {
    throw new Error("continuation-reviewer requires --reviewer-session-id");
  }
  if (parsed.flags.reviewerManagerSessionId === null) {
    throw new Error("continuation-reviewer requires --manager-session-id");
  }
  if (parsed.flags.reviewerSessionId === parsed.flags.reviewerManagerSessionId) {
    throw new Error("reviewer subagent session must be distinct from manager session");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const config = managerConfigSync(database, task.id);
    if (!managerConfigPermissionAllowed(config, "context.spawn_reviewer")) {
      throw new Error("continuation reviewer requires manager permission context.spawn_reviewer");
    }
    const pair = continuationPairSync(database, { correlationId, taskId: task.id });
    const context = continuationReviewerContextSync(database, {
      config,
      correlationId,
      manager: pair.manager,
      task,
      worker: pair.worker,
    });
    const reviewerCommand = parsed.flags.reviewerCommand[0] === "--"
      ? parsed.flags.reviewerCommand.slice(1)
      : parsed.flags.reviewerCommand;
    if (parsed.flags.dryRun) {
      return jsonResult({ context, reviewer_command: reviewerCommand });
    }
    if (reviewerCommand.length === 0) {
      throw new Error("continuation-reviewer requires --reviewer-command unless --dry-run is used");
    }
    const runner = reviewerCommand[0] ?? "";
    const { commandResult, sandbox } = runContinuationReviewerProcess({
      context,
      reviewerCommand,
      timeoutSeconds: parsed.flags.timeoutSeconds,
    });
    const commandResultWithRunner = {
      ...commandResult,
      runner_arg_count: reviewerCommand.length,
    };
    let payload: Record<string, unknown>;
    if (commandResult.error === null) {
      try {
        const raw = JSON.parse(commandResult.stdout);
        if (!isPlainRecord(raw)) {
          throw new Error("reviewer output must be a JSON object");
        }
        payload = validateContinuationReviewPayload({
          ...raw,
          subagent_run: {
            ...(isPlainRecord(raw.subagent_run) ? raw.subagent_run : {}),
            allowed_context: context.allowed_context,
            duration_ms: commandResult.duration_ms,
            manager_rollout_access: false,
            manager_session_id: parsed.flags.reviewerManagerSessionId,
            returncode: commandResult.returncode,
            reviewer_session_id: parsed.flags.reviewerSessionId,
            runner,
            runner_arg_count: reviewerCommand.length,
            sandbox,
            status: "succeeded",
          },
        });
      } catch (error) {
        payload = validateContinuationReviewPayload(reviewerFailurePayload({
          commandResult: {
            ...commandResultWithRunner,
            error: error instanceof Error ? error.message : String(error),
          },
          managerSessionId: parsed.flags.reviewerManagerSessionId,
          reviewerSessionId: parsed.flags.reviewerSessionId,
          runner,
          sandbox,
        }));
      }
    } else {
      payload = validateContinuationReviewPayload(reviewerFailurePayload({
        commandResult: commandResultWithRunner,
        managerSessionId: parsed.flags.reviewerManagerSessionId,
        reviewerSessionId: parsed.flags.reviewerSessionId,
        runner,
        sandbox,
      }));
    }
    return jsonResult(recordContinuationReviewSync(database, {
      config,
      correlationId,
      manager: pair.manager,
      payload,
      task,
      timestamp: nowIsoSeconds(options),
      worker: pair.worker,
    }));
  } finally {
    database.close();
  }
}

function runHandoffCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (parsed.flags.summary === null) {
    throw new Error("handoff requires --summary.");
  }
  const payload = parseJsonObjectFlag(parsed.flags.metadataJson, "--payload-json") ?? {};
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    let workerSessionId: string | null = null;
    try {
      workerSessionId = activeBindingForTaskSync(database, task.name).worker_session_id;
    } catch {
      workerSessionId = null;
    }
    const timestamp = nowIsoSeconds(options);
    const insert = database.prepare(`
      insert into worker_handoffs(
        task_id, worker_session_id, summary, next_steps_json, payload_json, created_at
      )
      values (?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      workerSessionId,
      parsed.flags.summary,
      stableJson(parsed.flags.nextSteps),
      stableJson(payload),
      timestamp,
    );
    const handoffId = Number(insert.lastInsertRowid);
    emitTelemetrySync(database, {
      actor: "worker",
      attributes: {
        next_step_count: parsed.flags.nextSteps.length,
        payload_keys: Object.keys(payload).sort(),
        summary_length: parsed.flags.summary.length,
      },
      correlation: { handoff_id: handoffId, worker_session_id: workerSessionId },
      eventType: "worker_handoff_recorded",
      severity: "info",
      summary: "Recorded worker handoff.",
      taskId: task.id,
      timestamp,
    });
    insertEventSync(database, {
      payload: {
        handoff_id: handoffId,
        next_step_count: parsed.flags.nextSteps.length,
        worker_session_id: workerSessionId,
      },
      taskId: task.id,
      type: "worker_handoff_recorded",
    });
    const handoff = latestWorkerHandoffFullSync(database, task.id);
    if (handoff === null) {
      throw new Error("worker handoff was not recorded");
    }
    return jsonResult(handoff);
  } finally {
    database.close();
  }
}

function runEpilogueCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (!parsed.flags.list && !parsed.flags.epilogueStatus && parsed.flags.epilogueStep === null) {
    throw new Error("epilogue requires --list, --status, or --step");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const config = managerConfigSync(database, task.id);
    const configuredSteps = cleanPairEpilogueSteps(config?.epilogues ?? []);
    if (parsed.flags.epilogueStep !== null) {
      const step = parsed.flags.epilogueStep;
      if (!configuredSteps.includes(step)) {
        throw new Error(`epilogue step ${JSON.stringify(step)} is not configured for task ${task.name}`);
      }
      const correlationId = parsed.flags.correlationId ?? `epilogue-${randomUUID()}`;
      const stepResult = runEpilogueStepSync(database, { config, step, task });
      const timestamp = nowIsoSeconds(options);
      const runId = insertEpilogueRunSync(database, {
        correlationId,
        error: stepResult.error,
        result: stepResult.result,
        state: stepResult.state,
        stepName: step,
        taskId: task.id,
        timestamp,
      });
      insertEventSync(database, {
        correlationId,
        payload: {
          epilogue_run_id: runId,
          state: stepResult.state,
          step_name: step,
        },
        taskId: task.id,
        type: "epilogue_step_recorded",
      });
    }
    const payload = {
      configured_steps: configuredSteps,
      runs: epilogueRunsSync(database, task.id),
      status: epilogueStatusSync(database, { requiredSteps: configuredSteps, taskId: task.id }),
      task: { id: task.id, name: task.name },
    };
    if (parsed.flags.json || parsed.flags.epilogueStatus || parsed.flags.list) {
      return jsonResult(payload);
    }
    return {
      exitCode: 0,
      handled: true,
      stdout: `epilogue ${parsed.flags.epilogueStep}: ${JSON.stringify(payload.status.steps)}\n`,
    };
  } finally {
    database.close();
  }
}

function runRequestWorkerCompactCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const binding = activeBindingForTaskSync(database, task.name);
    const config = managerConfigSync(database, task.id);
    const handoff = latestWorkerHandoffFullSync(database, task.id);
    const manager = activeManagerForTaskSync(database, task.id);
    const decisionCheck = assessManagerDecisionSync(database, {
      allowedDecisions: ["nudge"],
      decisionId: parsed.flags.decisionId,
      now: nowIsoSeconds(options),
      taskId: task.id,
    });
    const permissionReasons: string[] = [];
    let permissionAllowed = managerConfigPermissionAllowed(config, "worker_compact_clear");
    if (config === null) {
      permissionReasons.push("missing_manager_config");
    } else if (!permissionAllowed) {
      permissionReasons.push("permission_not_enabled");
    }
    if (handoff === null) {
      permissionAllowed = false;
      permissionReasons.push("missing_worker_handoff");
    }
    const permissionCheck = {
      action: "worker_compact_clear",
      allowed: permissionAllowed,
      handoff_id: handoff?.id ?? null,
      reasons: permissionReasons,
    };
    insertEventSync(database, {
      payload: {
        ...permissionCheck,
        source: "request_worker_compact",
      },
      taskId: task.id,
      type: "manager_permission_checked",
    });
    emitTelemetrySync(database, {
      actor: "manager",
      attributes: {
        allowed: permissionAllowed,
        reasons: permissionReasons,
        worker_session: binding.worker_session_name,
      },
      correlation: {
        action: "worker_compact_clear",
        binding_id: binding.binding_id,
        handoff_id: handoff?.id ?? null,
        source: "request_worker_compact",
      },
      eventType: "manager_permission_checked",
      severity: permissionAllowed ? "info" : "warning",
      summary: "Checked manager permission worker_compact_clear.",
      taskId: task.id,
      timestamp: nowIsoSeconds(options),
    });
    const slashCommand = workerCompactSlashCommand(parsed);
    const message = parsed.flags.message ?? (
      handoff === null
        ? "Manager request: prepare for context compaction/clear after a saved handoff exists."
        : workerCompactRequestText(task.name, handoff)
    );
    const sendText = slashCommand ?? message;
    const commandId = createCommandSync(database, {
      commandType: "request_worker_compact",
      managerId: manager?.id ?? null,
      payload: {
        manager_decision: decisionCheck,
        message,
        permission_check: permissionCheck,
        send_text: sendText,
        slash_command: slashCommand,
        task: task.name,
        worker_session: binding.worker_session_name,
      },
      taskId: task.id,
    });
    const decisionError = strictManagerDecisionError("request_worker_compact", decisionCheck, parsed.flags.strictDecisions);
    if (decisionError !== null || !permissionAllowed) {
      const error = decisionError ?? `worker compact request is not allowed: ${stableJson(permissionCheck)}`;
      const result = {
        command_id: commandId,
        expected_failure: true,
        failure_stage: "preflight",
        manager_decision: decisionCheck,
        permission_check: permissionCheck,
        task: task.name,
        worker_session: binding.worker_session_name,
      };
      markCommandAttemptedSync(database, commandId);
      finishCommandSync(database, { commandId, error, result, state: "failed" });
      insertEventSync(database, {
        commandId,
        managerId: manager?.id ?? null,
        payload: { ...result, error, error_type: "Error" },
        taskId: task.id,
        type: "worker_compact_request_failed",
      });
      throw new Error(error);
    }
    insertEventSync(database, {
      commandId,
      managerId: manager?.id ?? null,
      payload: {
        permission_check: permissionCheck,
        worker_session: binding.worker_session_name,
      },
      taskId: task.id,
      type: "worker_compact_requested",
    });

    const result: Record<string, unknown> = {
      command_id: commandId,
      manager_decision: decisionCheck,
      message,
      permission_check: permissionCheck,
      send_text: sendText,
      slash_command: slashCommand,
      task: task.name,
      worker_session: binding.worker_session_name,
    };
    try {
      markCommandAttemptedSync(database, commandId);
      result.send_result = sendTextToSessionWithRunner(
        sessionRow(database, binding.worker_session_name, "worker"),
        sendText,
        options.tmuxRunner ?? defaultTmuxRunner,
        {
          dryRun: parsed.flags.dryRun,
          now: () => nowIsoSeconds(options),
          sleep: options.sleepMilliseconds,
        },
      );
      finishCommandSync(database, { commandId, result, state: "succeeded" });
      insertEventSync(database, {
        commandId,
        managerId: manager?.id ?? null,
        payload: result,
        taskId: task.id,
        type: "worker_compact_request_succeeded",
      });
      return jsonResult(result);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      finishCommandSync(database, { commandId, error: messageText, result, state: "failed" });
      insertEventSync(database, {
        commandId,
        managerId: manager?.id ?? null,
        payload: { ...result, error: messageText, error_type: error instanceof Error ? error.name : typeof error },
        taskId: task.id,
        type: "worker_compact_request_failed",
      });
      throw error;
    }
  } finally {
    database.close();
  }
}

function runCompactWorkerCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sleepMilliseconds?: (milliseconds: number) => void; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  const taskName = requireTask(parsed);
  if (parsed.flags.reason === null) {
    throw new Error("compact-worker requires --reason.");
  }
  const database = openRuntimeDatabase(parsed, options);
  let decisionId: number;
  try {
    const task = taskRowForPair(database, taskName);
    if (task === null) {
      throw new Error(`Unknown task: ${taskName}`);
    }
    const manager = activeManagerForTaskSync(database, task.id);
    const timestamp = nowIsoSeconds(options);
    const payload = {
      slash_command: parsed.flags.force ? "/clear" : (parsed.flags.promptOnly ? null : "/compact"),
      source: "compact-worker",
    };
    const insert = database.prepare(`
      insert into manager_decisions(
        task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
      )
      values (?, ?, ?, 'nudge', ?, ?, ?)
    `).run(
      task.id,
      manager?.id ?? null,
      parsed.flags.cycleId,
      parsed.flags.reason,
      timestamp,
      stableJson(payload),
    );
    decisionId = Number(insert.lastInsertRowid);
    insertEventSync(database, {
      managerId: manager?.id ?? null,
      payload: {
        decision: "nudge",
        decision_id: decisionId,
        manager_cycle_id: parsed.flags.cycleId,
        reason: parsed.flags.reason,
      },
      taskId: task.id,
      type: "manager_decision_recorded",
    });
  } finally {
    database.close();
  }
  return runRequestWorkerCompactCommand({
    ...parsed,
    flags: {
      ...parsed.flags,
      decisionId,
      strictDecisions: true,
    },
  }, options);
}

function runImportCompatCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const root = resolve(parsed.flags.compatibilityRoot ?? stateRoot({ cwd: options.cwd, env: options.env }));
  const database = openRuntimeDatabase(parsed, options);
  try {
    const workers = iterCompatWorkerDirs(root, parsed.flags.worker).map((workerPath) => importCompatWorkerSync(database, {
      applyChanges: parsed.flags.apply,
      root,
      workerPath,
      timestamp: nowIsoSeconds(options),
    }));
    return jsonResult({
      apply: parsed.flags.apply,
      root,
      worker_count: workers.length,
      workers,
    });
  } finally {
    database.close();
  }
}

function runDbDoctorCommand(
  parsed: ParsedRuntimeArgs,
  options: TypescriptRuntimeOptions,
): TypescriptRuntimeResult {
  if (parsed.task !== null) {
    throw new Error(`Unexpected argument: ${parsed.task}`);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const health = databaseHealthSync(database);
    const result: Record<string, unknown> = {
      ...health,
      checks: [...health.checks],
      path: runtimeDbPath(parsed, options),
    };
    if (parsed.flags.live) {
      const runner = options.tmuxRunner ?? defaultTmuxRunner;
      const liveRows = collectLiveReconcileRowsSync(database, runner);
      const managerWarnings = managerLivenessWarningsFromRowsSync(liveRows, parsed.flags.managerStaleSeconds);
      const driftCount = liveRows.filter((row) => (row.drift as string[]).length > 0).length;
      const unfinishedCommandCount = liveRows.reduce((count, row) => count + (row.unfinished_commands as unknown[]).length, 0);
      const liveCheck = {
        drift_count: driftCount,
        manager_liveness_warning_count: managerWarnings.length,
        name: "live_reconcile",
        ok: driftCount === 0 && unfinishedCommandCount === 0,
        task_count: liveRows.length,
        unfinished_command_count: unfinishedCommandCount,
      };
      (result.checks as unknown[]).push(liveCheck);
      result.live_reconcile = {
        manager_liveness_warnings: managerWarnings,
        ok: liveCheck.ok,
        results: liveRows,
      };
      result.ok = Boolean(result.ok) && liveCheck.ok;
    }
    return { ...jsonResult(result), exitCode: result.ok ? 0 : 1 };
  } finally {
    database.close();
  }
}

function runDoctorCommand(
  parsed: ParsedRuntimeArgs,
  options: { codexCommandResolver?: (name: string) => string | null; cwd?: string; env?: NodeJS.ProcessEnv; terminalRunner?: (args: string[]) => { status: number; stderr?: string; stdout?: string } },
): TypescriptRuntimeResult {
  if (parsed.task !== null) {
    throw new Error(`Unexpected argument: ${parsed.task}`);
  }
  const targetCwd = resolve(expandUserPath(parsed.flags.cwd ?? options.cwd ?? process.cwd()));
  const root = stateRoot({ cwd: targetCwd, env: options.env });
  const tmuxPath = commandPath("tmux", options);
  const codexPath = options.codexCommandResolver?.("codex") ?? commandPath("codex", options);
  const checks: Array<Record<string, unknown>> = [
    { name: "tmux", ok: Boolean(tmuxPath), path: tmuxPath },
    { name: "codex", ok: Boolean(codexPath), path: codexPath },
  ];
  if (tmuxPath) {
    const proc = runProcess(["tmux", "-V"], options);
    checks.push({ name: "tmux_version", ok: proc.status === 0, value: (proc.stdout ?? "").trim() });
  }
  if (codexPath) {
    const proc = runProcess(["codex", "--version"], options);
    checks.push({ name: "codex_version", ok: proc.status === 0, value: ((proc.stdout ?? "").trim() || (proc.stderr ?? "").trim()) });
  }
  checks.push({ name: "target_cwd_exists", ok: pathIsDirectory(targetCwd), path: targetCwd });
  checks.push({ name: "state_root_exists", ok: existsSync(root), path: root });
  const ok = checks.every((check) => check.name === "state_root_exists" || check.ok === true);
  return { ...jsonResult({ checks, ok, project_root: packageRootFromRuntimeModule(), workers: doctorWorkerSummaries(root) }), exitCode: ok ? 0 : 1 };
}

function runDoctorSelfCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; terminalRunner?: (args: string[]) => { status: number; stderr?: string; stdout?: string }; tmuxRunner?: TmuxRunner },
): TypescriptRuntimeResult {
  if (parsed.task !== null) {
    throw new Error(`Unexpected argument: ${parsed.task}`);
  }
  const sessionProbe = parsed.flags.tmuxSession ?? currentTmuxSessionName(options);
  const session = typeof sessionProbe === "string" ? sessionProbe : null;
  const sessionError = isPlainRecord(sessionProbe) && typeof sessionProbe.error === "string" ? sessionProbe.error : null;
  const tmuxPath = options.tmuxRunner ? "tmux" : commandPath("tmux", options);
  const codexPath = commandPath("codex", options);
  const workerctlPath = commandPath("workerctl", options);
  const workerctlScript = join(packageRootFromRuntimeModule(), "scripts", "workerctl");
  const codexHome = expandUserPath(options.env?.CODEX_HOME ?? "~/.codex");
  const skillPath = join(codexHome, "skills", "manage-codex-workers", "SKILL.md");
  const codexReviewSkillPath = join(codexHome, "skills", "codex-review", "SKILL.md");
  const codexReviewHelperPath = join(codexHome, "skills", "codex-review", "scripts", "codex-review");
  const checks: Array<Record<string, unknown>> = [
    { name: "workerctl_on_path", ok: Boolean(workerctlPath), path: workerctlPath },
    { name: "workerctl_script", ok: existsSync(workerctlScript), path: workerctlScript },
    { name: "tmux_on_path", ok: Boolean(tmuxPath), path: tmuxPath },
    { name: "codex_on_path", ok: Boolean(codexPath), path: codexPath },
    { name: "inside_tmux", ok: Boolean(session), session },
    { name: "manage_skill_installed", ok: existsSync(skillPath), path: skillPath },
    { name: "codex_review_skill_installed", ok: existsSync(codexReviewSkillPath), path: codexReviewSkillPath },
    { name: "codex_review_helper_installed", ok: pathIsExecutable(codexReviewHelperPath), path: codexReviewHelperPath },
  ];
  if (sessionError) {
    checks.push({ name: "tmux_access", ok: false, error: sessionError });
  }
  if (session && tmuxPath) {
    const proc = (options.tmuxRunner ?? defaultTmuxRunner)(["tmux", "has-session", "-t", session], { check: false });
    checks.push({ name: "current_tmux_session_live", ok: proc.status === 0, session, ...(proc.status === 0 ? {} : { error: (proc.stderr ?? proc.stdout ?? "").trim() }) });
  }
  if (workerctlPath) {
    const proc = runProcess(["workerctl", "classify", "--text", "conveyor self doctor"], options);
    checks.push({ name: "workerctl_executable", ok: proc.status === 0, path: workerctlPath });
  }
  const supported = checks
    .filter((check) => ["workerctl_on_path", "tmux_on_path", "inside_tmux", "current_tmux_session_live"].includes(String(check.name)))
    .every((check) => check.ok === true);
  const failed = checks.filter((check) => check.ok !== true).map((check) => String(check.name));
  const payload = newPathPayload();
  const result = {
    checks,
    codex_app_inbox_guidance: "Codex app manager/worker sessions are first-class pull targets: register them without --tmux-session, then poll manager-inbox or worker-inbox with --consume-next --wait --json at the start of a turn.",
    codex_review_helper_path: codexReviewHelperPath,
    codex_review_skill_path: codexReviewSkillPath,
    command_context_note: "The tmux checks describe the command environment running doctor-self. For Codex app sessions, use rollout JSONL path/lsof evidence plus register-manager/register-worker role metadata to prove the app session identity.",
    command_template: payload.command_template,
    current_session: session,
    follow_up: payload.follow_up,
    ok: supported,
    skill_path: skillPath,
    supported,
    why_or_why_not: supported
      ? "This Codex session is inside a live tmux session and conveyor is on PATH; it can register itself as a worker via `conveyor register-worker`."
      : `This Codex session cannot register itself as a tmux-backed worker. Failed checks: ${failed.length ? failed.join(", ") : "unknown"}. A Codex session running outside tmux can still register itself as a manager via \`conveyor register-manager\`.`,
    workerctl_invocation: workerctlPath ? "workerctl" : (existsSync(workerctlScript) ? "scripts/workerctl" : null),
  };
  return { ...jsonResult(result), exitCode: supported ? 0 : 1 };
}

function runReconcileCommand(
  parsed: ParsedRuntimeArgs,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; now?: () => Date },
): TypescriptRuntimeResult {
  if (parsed.task !== null) {
    throw new Error(`Unexpected argument: ${parsed.task}`);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const report = parsed.flags.apply
      ? applyReconcileSync(database, { staleCyclesSeconds: parsed.flags.staleCycleSeconds, timestamp: nowIsoSeconds(options) })
      : collectReconcileReportSync(database, { staleCyclesSeconds: parsed.flags.staleCycleSeconds });
    return jsonResult(report);
  } finally {
    database.close();
  }
}

function runDivergencesCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const task = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const taskRow = taskRowForDiagnostics(database, task);
    return jsonResult(divergentCyclesForTaskSync(database, taskRow.id, parsed.flags.limit ?? 50));
  } finally {
    database.close();
  }
}

function runPruneCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  if (parsed.task !== null) {
    throw new Error(`Unexpected argument: ${parsed.task}`);
  }
  if (parsed.flags.keepLatest < 0) {
    throw new Error("--keep-latest must be >= 0");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const pruneIds = transcriptCapturePruneIdsSync(database, parsed.flags.keepLatest);
    if (pruneIds.length > 0 && !parsed.flags.dryRun) {
      const update = database.prepare(`
        update transcript_captures
        set content = null, capture_kind = 'metadata_only', retention_class = 'warm'
        where id = ?
      `);
      for (const id of pruneIds) {
        update.run(id);
      }
      insertEventSync(database, {
        payload: { capture_ids: pruneIds, keep_latest: parsed.flags.keepLatest },
        type: "transcript_captures_pruned",
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

function runMutationAuditCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): TypescriptRuntimeResult {
  const task = requireTask(parsed);
  const database = openRuntimeDatabase(parsed, options);
  try {
    const result = mutationAuditResultSync(taskAuditSync(database, task));
    if (parsed.flags.json) {
      return { ...jsonResult(result), exitCode: result.ok ? 0 : 1 };
    }
    const lines = [
      `${result.task.name}\tmutations=${result.summary.mutations}\twarnings=${result.summary.with_warnings}`,
      ...result.records.map((record) => {
        const warnings = record.warnings.length ? record.warnings.join(",") : "ok";
        const linked = record.linked_decision && typeof record.linked_decision.id === "number" ? record.linked_decision.id : "-";
        return `${record.command.created_at}\t${record.command.type}\tdecision=${linked}\t${warnings}`;
      }),
    ];
    return { exitCode: result.ok ? 0 : 1, handled: true, stdout: `${lines.join("\n")}\n` };
  } finally {
    database.close();
  }
}

function runTelemetryCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  if (parsed.task !== null) {
    throw new Error(`Unexpected argument: ${parsed.task}`);
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const view = parsed.flags.telemetryView;
    if (view === "metrics") {
      const result = telemetryMetricsSync(database, {
        dbPath: runtimeDbPath(parsed, options),
        runRef: parsed.flags.run,
        taskRef: parsed.flags.taskName,
        now: options.now,
        window: parsed.flags.window ?? "24h",
      });
      if (parsed.flags.json) {
        return jsonResult(result);
      }
      return textResult([
        `window: ${result.window.label}`,
        `telemetry_events: ${result.counters.telemetry_events.total}`,
        `cycle_success_rate: ${result.rollups.cycle_success_rate}`,
        `skipped_ingest_lines: ${result.counters.ingest.skipped_lines}`,
      ]);
    }
	    if (view === "snapshot") {
	      const result = parsed.flags.taskName
	        ? telemetrySnapshotSync(database, { limit: parsed.flags.limit ?? 100, task: parsed.flags.taskName })
	        : telemetryOperatorSnapshotSync(database, {
	          activeOnly: parsed.flags.activeOnly,
	          dbPath: runtimeDbPath(parsed, options),
	          limit: parsed.flags.limit ?? 100,
	          maxOpenCriteria: parsed.flags.maxOpenCriteria,
	          maxStorageBytes: parsed.flags.maxStorageBytes,
          maxUnfinishedCommands: parsed.flags.maxUnfinishedCommands,
          staleCycleSeconds: parsed.flags.staleCycleSeconds,
          workerStalenessSeconds: parsed.flags.workerStalenessSeconds,
        });
      return jsonResult(result);
	    }
	    if (view === "check") {
	      const result = parsed.flags.taskName
	        ? telemetryTaskCheckSync(database, {
	          dbPath: runtimeDbPath(parsed, options),
	          limit: parsed.flags.limit ?? 100,
	          maxOpenCriteria: parsed.flags.maxOpenCriteria,
	          maxStorageBytes: parsed.flags.maxStorageBytes,
	          maxUnfinishedCommands: parsed.flags.maxUnfinishedCommands,
	          staleCycleSeconds: parsed.flags.staleCycleSeconds,
	          task: parsed.flags.taskName,
	          workerStalenessSeconds: parsed.flags.workerStalenessSeconds,
	        })
	        : telemetryOperatorSnapshotSync(database, {
	          activeOnly: parsed.flags.activeOnly,
	          dbPath: runtimeDbPath(parsed, options),
	          limit: parsed.flags.limit ?? 100,
	          maxOpenCriteria: parsed.flags.maxOpenCriteria,
	          maxStorageBytes: parsed.flags.maxStorageBytes,
        maxUnfinishedCommands: parsed.flags.maxUnfinishedCommands,
        staleCycleSeconds: parsed.flags.staleCycleSeconds,
        workerStalenessSeconds: parsed.flags.workerStalenessSeconds,
      });
      if (parsed.flags.json) {
        return { ...jsonResult(result), exitCode: result.checks.ok ? 0 : 1 };
      }
      const status = result.checks.ok ? "healthy" : "unhealthy";
      return { exitCode: result.checks.ok ? 0 : 1, handled: true, stdout: [`telemetry check: ${status}`, ...result.alerts.map((alert: Record<string, string>) => `${alert.severity}: ${alert.type}: ${alert.message}`)].join("\n") + "\n" };
    }
    if (view === "task") {
      const task = parsed.flags.telemetryViewTask ?? parsed.flags.taskName;
      if (!task) {
        throw new Error("telemetry task requires a task name or ID");
      }
      const result = telemetryTaskViewSync(database, {
        dbPath: runtimeDbPath(parsed, options),
        limit: parsed.flags.limit ?? 100,
        staleCycleSeconds: parsed.flags.staleCycleSeconds,
        task,
      });
      if (parsed.flags.json) {
        return jsonResult(result);
      }
      return textResult([
        `task: ${result.task.name}`,
        `worker_alive: ${result.liveness.worker_alive}`,
        `manager_alive: ${result.liveness.manager_alive}`,
        `cycles: ${JSON.stringify(result.cycles.counts_by_state)}`,
        `failed_commands: ${result.failed_commands.length}`,
        ...result.alerts.map((alert: Record<string, string>) => `${alert.severity}: ${alert.type}: ${alert.message}`),
      ]);
    }
    if (view === "failures") {
      const result = telemetryFailuresViewSync(database, {
        activeOnly: parsed.flags.activeOnly,
        dbPath: runtimeDbPath(parsed, options),
        limit: parsed.flags.limit ?? 100,
        runRef: parsed.flags.run,
        staleCycleSeconds: parsed.flags.staleCycleSeconds,
        taskRef: parsed.flags.taskName,
        window: parsed.flags.window,
      });
      if (parsed.flags.json) {
        return jsonResult(result);
      }
      return textResult([
        `failed_cycles: ${result.failed_cycles.length}`,
        `failed_commands: ${result.failed_commands.length}`,
        `ingest_errors: ${result.ingest.error_count}`,
        `pane_capture_failures: ${result.pane_capture_failures.length}`,
        ...result.alerts.map((alert: Record<string, string>) => `${alert.severity}: ${alert.type}: ${alert.message}`),
      ]);
    }
    const taskId = parsed.flags.taskName ? taskRowForDiagnostics(database, parsed.flags.taskName).id : null;
    const runId = telemetryRunIdForFilters(database, parsed.flags.run, taskId);
    const events = telemetryEventsSync(database, {
      actor: parsed.flags.actor,
      eventType: parsed.flags.eventType,
      limit: parsed.flags.limit ?? 100,
      newest: parsed.flags.newest,
      runId,
      search: parsed.flags.search,
      severity: parsed.flags.severity,
      taskId,
    });
    if (parsed.flags.telemetrySummary) {
      const summary = telemetrySummarySync(events, { runId, taskId });
      if (parsed.flags.json) {
        return jsonResult(summary);
      }
      return textResult([
        `total: ${summary.total}`,
        `first_timestamp: ${summary.first_timestamp}`,
        `last_timestamp: ${summary.last_timestamp}`,
        "by_actor:",
        ...Object.entries(summary.by_actor).sort().map(([key, value]) => `  ${key}: ${value}`),
        "by_event_type:",
        ...Object.entries(summary.by_event_type).sort().map(([key, value]) => `  ${key}: ${value}`),
        "by_severity:",
        ...Object.entries(summary.by_severity).sort().map(([key, value]) => `  ${key}: ${value}`),
      ]);
    }
    if (parsed.flags.json) {
      return jsonResult(events);
    }
    return { exitCode: 0, handled: true, stdout: events.map((event) => `${event.timestamp} ${event.actor} ${event.event_type} [${event.severity}] ${event.summary}\n`).join("") };
  } finally {
    database.close();
  }
}

type RuntimeDatabase = ReturnType<typeof openRuntimeDatabase>;

interface TaskDiagnosticsRow {
  created_at: string;
  goal: string;
  id: string;
  name: string;
  state: string;
  summary: string | null;
  updated_at: string;
}

interface TelemetryEventRecord {
  actor: string;
  attributes: Record<string, unknown>;
  correlation: Record<string, unknown>;
  event_type: string;
  id: string;
  run_id: string | null;
  severity: string;
  summary: string;
  task_id: string | null;
  timestamp: string;
}

function commandPath(name: string, options: { env?: NodeJS.ProcessEnv }): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(name)}`], {
    encoding: "utf8",
    env: options.env,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function runProcess(command: string[], options: { env?: NodeJS.ProcessEnv; terminalRunner?: (args: string[]) => { status: number; stderr?: string; stdout?: string } }): { status: number; stderr?: string; stdout?: string } {
  if (options.terminalRunner) {
    return options.terminalRunner(command);
  }
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env: options.env });
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function doctorWorkerSummaries(root: string): Array<Record<string, unknown>> {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name);
      const config = loadJsonSync<Record<string, unknown>>(join(dir, "config.json"), {});
      return {
        config_path: join(dir, "config.json"),
        name: typeof config.name === "string" ? config.name : entry.name,
        status: loadJsonSync<Record<string, unknown>>(join(dir, "status.json"), {}),
      };
    })
    .filter((worker) => existsSync(worker.config_path as string));
}

function currentTmuxSessionName(options: { tmuxRunner?: TmuxRunner }): string | { error: string } | null {
  const runner = options.tmuxRunner ?? defaultTmuxRunner;
  const result = runner(["tmux", "display-message", "-p", "#S"], { check: false });
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim();
    return detail ? { error: detail } : null;
  }
  return (result.stdout ?? "").trim() || null;
}

function newPathPayload(): { command_template: string; follow_up: string[] } {
  return {
    command_template: "conveyor register-worker --name <NAME> --pid <PID> --cwd <CWD> --tmux-session <SESSION>",
    follow_up: [
      "Have a manager Codex session register itself via `conveyor register-manager --name <MGR_NAME> --pid <MGR_PID> --cwd <CWD>`.",
      "Create a task and bind the pair: `conveyor tasks --create <TASK> --goal \"<goal>\"` then `conveyor bind --task <TASK> --worker <NAME> --manager <MGR_NAME>`.",
      "The manager Codex drives the supervision loop by calling `conveyor cycle <TASK>` repeatedly and reading the returned JSON.",
    ],
  };
}

function taskRowForDiagnostics(database: RuntimeDatabase, task: string): TaskDiagnosticsRow {
  const row = database.prepare(`
    select id, name, goal, summary, state, created_at, updated_at
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(task, task) as TaskDiagnosticsRow | undefined;
  if (!row) {
    throw new Error(`Unknown task: ${task}`);
  }
  return row;
}

function runRowForDiagnostics(database: RuntimeDatabase, run: string): { id: string; name: string; task_id: string } {
  const row = database.prepare(`
    select id, name, task_id
    from runs
    where id = ? or name = ?
    order by started_at desc
    limit 1
  `).get(run, run) as { id: string; name: string; task_id: string } | undefined;
  if (!row) {
    throw new Error(`Unknown run: ${run}`);
  }
  return row;
}

function runRowForTaskDiagnostics(database: RuntimeDatabase, run: string, taskId: string): { id: string; name: string; task_id: string } {
  const row = database.prepare(`
    select id, name, task_id
    from runs
    where task_id = ?
      and (id = ? or name = ?)
    order by started_at desc
    limit 1
  `).get(taskId, run, run) as { id: string; name: string; task_id: string } | undefined;
  if (!row) {
    throw new Error(`Unknown run for task: ${run}`);
  }
  return row;
}

function telemetryRunIdForFilters(database: RuntimeDatabase, runRef: string | null, taskId: string | null): string | null {
  if (runRef === null) {
    return null;
  }
  return taskId !== null
    ? runRowForTaskDiagnostics(database, runRef, taskId).id
    : runRowForDiagnostics(database, runRef).id;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isPlainRecord(error) && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function collectReconcileReportSync(database: RuntimeDatabase, options: { staleCyclesSeconds: number }): {
  dangling_bindings: Array<Record<string, unknown>>;
  dead_pid_sessions: Array<Record<string, unknown>>;
  schema_health: ReturnType<typeof databaseHealthSync>;
  stuck_tasks: Array<Record<string, unknown>>;
} {
  const dead_pid_sessions = (database.prepare(`
    select name, role, pid, last_heartbeat_at
    from sessions
    where state = 'active' and pid is not null
    order by name
  `).all() as Array<{ last_heartbeat_at: string | null; name: string; pid: number; role: string }>)
    .filter((row) => !pidIsAlive(Number(row.pid)))
    .map((row) => ({
      last_heartbeat_at: row.last_heartbeat_at,
      name: row.name,
      pid: Number(row.pid),
      role: row.role,
    }));
  const dangling_bindings: Array<Record<string, unknown>> = [];
  const bindingRows = database.prepare(`
    select b.id as binding_id, t.id as task_id, t.name as task_name,
           ws.state as worker_state, ws.name as worker_name,
           ms.state as manager_state, ms.name as manager_name
    from bindings b
    join tasks t on t.id = b.task_id
    left join sessions ws on ws.id = b.worker_session_id
    left join sessions ms on ms.id = b.manager_session_id
    where b.state in ('active', 'ending')
      and b.worker_session_id is not null
    order by b.id
  `).all() as Array<Record<string, number | string | null>>;
  for (const row of bindingRows) {
    if (row.worker_state === "gone") {
      dangling_bindings.push({
        binding_id: row.binding_id,
        gone_role: "worker",
        gone_session_name: row.worker_name,
        task_id: row.task_id,
        task_name: row.task_name,
      });
    }
    if (row.manager_state === "gone") {
      dangling_bindings.push({
        binding_id: row.binding_id,
        gone_role: "manager",
        gone_session_name: row.manager_name,
        task_id: row.task_id,
        task_name: row.task_name,
      });
    }
  }
  const now = Date.now();
  const stuck_tasks = (database.prepare(`
    select t.name as task_name, b.id as binding_id, max(mc.completed_at) as last_cycle_at
    from bindings b
    join tasks t on t.id = b.task_id
    left join manager_cycles mc on mc.task_id = b.task_id
    where b.state in ('active', 'ending')
    group by b.id
    having last_cycle_at is not null
    order by b.id
  `).all() as Array<{ binding_id: string; last_cycle_at: string; task_name: string }>)
    .map((row) => ({ ...row, age_seconds: Math.max(0, (now - Date.parse(row.last_cycle_at)) / 1000) }))
    .filter((row) => row.age_seconds > options.staleCyclesSeconds);
  return {
    dangling_bindings,
    dead_pid_sessions,
    schema_health: databaseHealthSync(database),
    stuck_tasks,
  };
}

function applyReconcileSync(database: RuntimeDatabase, options: { staleCyclesSeconds: number; timestamp: string }): ReturnType<typeof collectReconcileReportSync> & { applied: Record<string, unknown[]> } {
  const report = collectReconcileReportSync(database, { staleCyclesSeconds: options.staleCyclesSeconds });
  const applied = { bindings_marked_invalid: [] as string[], sessions_marked_gone: [] as string[] };
  for (const session of report.dead_pid_sessions) {
    database.prepare("update sessions set state = 'gone', last_heartbeat_at = ? where name = ?").run(options.timestamp, String(session.name));
    applied.sessions_marked_gone.push(String(session.name));
    insertEventSync(database, {
      payload: { name: session.name, pid: session.pid, reason: "pid not alive" },
      type: "session_marked_gone_by_reconcile",
    });
  }
  const post = collectReconcileReportSync(database, { staleCyclesSeconds: options.staleCyclesSeconds });
  const invalidatedBindings = new Set<string>();
  for (const binding of post.dangling_bindings) {
    const bindingId = String(binding.binding_id);
    if (invalidatedBindings.has(bindingId)) {
      continue;
    }
    invalidatedBindings.add(bindingId);
    database.prepare("update bindings set state = 'invalid', ended_at = ? where id = ?").run(options.timestamp, bindingId);
    applied.bindings_marked_invalid.push(bindingId);
    insertEventSync(database, {
      payload: {
        binding_id: binding.binding_id,
        gone_role: binding.gone_role,
        gone_session_name: binding.gone_session_name,
        task_name: binding.task_name,
      },
      taskId: String(binding.task_id),
      type: "binding_marked_invalid_by_reconcile",
    });
  }
  return { ...report, applied };
}

function liveSessionSnapshotSync(session: string | null, pid: number | null, runner: TmuxRunner): { live: boolean; pane_id: string | null } | null {
  if (session) {
    const live = tmuxSessionRunning(session, runner);
    return { live, pane_id: live ? currentPaneIdWithRunner(session, runner) : null };
  }
  if (pid !== null) {
    return { live: pidIsAlive(pid), pane_id: null };
  }
  return null;
}

function collectLiveReconcileRowsSync(database: RuntimeDatabase, runner: TmuxRunner): Array<Record<string, unknown>> {
  const unfinishedByTask = new Map<string, Array<Record<string, unknown>>>();
  const unfinishedRows = database.prepare(`
    select id, task_id, worker_id, manager_id, type, state, created_at, updated_at, claimed_by, attempts, error
    from commands
    where state in ('pending', 'attempted')
    order by updated_at desc, created_at desc, id
  `).all() as Array<Record<string, unknown>>;
  for (const command of unfinishedRows) {
    const taskId = String(command.task_id ?? "");
    if (!taskId) {
      continue;
    }
    const commands = unfinishedByTask.get(taskId) ?? [];
    commands.push(command);
    unfinishedByTask.set(taskId, commands);
  }

  const rows = database.prepare(`
    select t.id as task_id, t.name as task_name, t.state as task_state,
           w.id as worker_id, w.name as worker_name, w.state as worker_state,
	           w.tmux_session as worker_session, w.tmux_pane_id as worker_pane_id,
	           ws.id as worker_session_id, ws.name as worker_session_name, ws.state as worker_session_state,
	           ws.tmux_session as worker_bound_session, ws.tmux_pane_id as worker_session_pane_id,
	           ws.pid as worker_session_pid,
	           m.id as manager_id, m.name as manager_name, m.state as manager_state,
	           m.tmux_session as manager_session, m.tmux_pane_id as manager_pane_id,
	           m.last_capture_sha256 as manager_last_capture_sha256,
	           m.last_seen_at as manager_last_seen_at,
	           ms.id as manager_session_id, ms.name as manager_session_name, ms.state as manager_session_state,
	           ms.tmux_session as manager_bound_session, ms.tmux_pane_id as manager_session_pane_id,
	           ms.pid as manager_session_pid,
	           ms.last_heartbeat_at as manager_session_last_seen_at
    from tasks t
    left join bindings b on b.task_id = t.id and b.state in ('active', 'ending')
    left join workers w on w.id = b.worker_id
    left join sessions ws on ws.id = b.worker_session_id
    left join managers m on m.id = (
      select m2.id
      from managers m2
      where m2.task_id = t.id
        and m2.state in ('starting', 'ready', 'stopping')
      order by m2.started_at desc, m2.id desc
      limit 1
    )
    left join sessions ms on ms.id = b.manager_session_id
    order by t.name
  `).all() as Array<Record<string, string | null>>;

  return rows.map((row) => {
    const drift: string[] = [];
    const workerId = row.worker_id ?? row.worker_session_id;
    const workerName = row.worker_name ?? row.worker_session_name;
    const workerState = row.worker_state ?? row.worker_session_state;
    const workerSession = row.worker_session ?? row.worker_bound_session;
    const workerPaneId = row.worker_pane_id ?? row.worker_session_pane_id;
    const managerId = row.manager_id ?? row.manager_session_id;
    const managerName = row.manager_name ?? row.manager_session_name;
	    const managerState = row.manager_state ?? row.manager_session_state;
	    const managerSession = row.manager_session ?? row.manager_bound_session;
	    const managerPaneId = row.manager_pane_id ?? row.manager_session_pane_id;
	    const managerLastSeenAt = row.manager_last_seen_at ?? row.manager_session_last_seen_at;
	    const workerPid = typeof row.worker_session_pid === "number" ? row.worker_session_pid : null;
	    const managerPid = typeof row.manager_session_pid === "number" ? row.manager_session_pid : null;
	    const workerSnapshot = liveSessionSnapshotSync(workerSession, workerPid, runner);
	    const managerSnapshot = liveSessionSnapshotSync(managerSession, managerPid, runner);
	    if (workerId && ["active", "candidate"].includes(String(workerState)) && workerSnapshot?.live === false) {
	      drift.push("worker_missing");
	    }
	    if (managerId && ["active", "starting", "ready", "stopping"].includes(String(managerState)) && managerSnapshot?.live === false) {
	      drift.push("manager_missing");
	    }
    if (workerPaneId && workerSnapshot?.pane_id && workerPaneId !== workerSnapshot.pane_id) {
      drift.push("worker_pane_mismatch");
    }
    if (managerPaneId && managerSnapshot?.pane_id && managerPaneId !== managerSnapshot.pane_id) {
      drift.push("manager_pane_mismatch");
    }
    const unfinishedCommands = unfinishedByTask.get(String(row.task_id)) ?? [];
    if (unfinishedCommands.length > 0 && !drift.includes("unfinished_commands")) {
      drift.push("unfinished_commands");
    }
    return {
      drift,
      task: {
        id: row.task_id,
        name: row.task_name,
        state: row.task_state,
      },
      unfinished_commands: unfinishedCommands,
	      worker: workerId ? {
	        id: workerId,
	        live: workerSnapshot?.live ?? null,
	        name: workerName,
	        pid: workerPid,
	        recorded_pane_id: workerPaneId,
	        session: workerSession,
	        state: workerState,
	        tmux_pane_id: workerSnapshot?.pane_id ?? null,
      } : null,
      manager: managerId ? {
	        id: managerId,
	        last_capture_sha256: row.manager_last_capture_sha256,
	        last_seen_age_seconds: managerLastSeenAt ? ageSecondsFromIso(managerLastSeenAt) : null,
	        last_seen_at: managerLastSeenAt,
	        live: managerSnapshot?.live ?? null,
	        name: managerName,
	        pid: managerPid,
	        recorded_pane_id: managerPaneId,
	        session: managerSession,
        state: managerState,
        tmux_pane_id: managerSnapshot?.pane_id ?? null,
      } : null,
    };
  });
}

function managerLivenessWarningsFromRowsSync(rows: Array<Record<string, unknown>>, staleSeconds: number): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const manager = row.manager as Record<string, unknown> | null;
    const task = row.task as Record<string, unknown> | null;
    if (!manager || manager.live !== true || !["starting", "ready", "stopping"].includes(String(manager.state))) {
      continue;
    }
    if (manager.last_seen_at === null) {
      warnings.push({
        manager: manager.name,
        manager_id: manager.id,
        reason: "manager_never_seen",
        recommended_action: "observe manager or run a manager lifecycle command to refresh heartbeat",
        task: task?.name,
        task_id: task?.id,
      });
      continue;
    }
    const ageSeconds = ageSecondsFromIso(String(manager.last_seen_at));
    if (ageSeconds !== null && ageSeconds > staleSeconds) {
      warnings.push({
        age_seconds: ageSeconds,
        last_seen_at: manager.last_seen_at,
        manager: manager.name,
        manager_id: manager.id,
        reason: "manager_seen_stale",
        recommended_action: "inspect manager terminal; do not auto-recover unless tmux session is missing",
        stale_seconds: staleSeconds,
        task: task?.name,
        task_id: task?.id,
      });
    }
  }
  return warnings;
}

function divergentCyclesForTaskSync(database: RuntimeDatabase, taskId: string, limit: number): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    select id, task_id, started_at, completed_at, state, status_json
    from manager_cycles
    where task_id = ?
      and json_extract(status_json, '$.notable_pane_pattern') is not null
    order by id desc
    limit ?
  `).all(taskId, limit) as Array<{ completed_at: string | null; id: number; started_at: string; state: string; status_json: string; task_id: string }>;
  return rows.map((row) => {
    const status = row.status_json ? parseJsonObject(row.status_json) : {};
    return {
      completed_at: row.completed_at,
      id: row.id,
      notable_pane_pattern: status.notable_pane_pattern ?? null,
      started_at: row.started_at,
      state: row.state,
      status,
      task_id: row.task_id,
    };
  });
}

function transcriptCapturePruneIdsSync(database: RuntimeDatabase, keepLatest: number): number[] {
  const rows = database.prepare(`
    select id, worker_id
    from transcript_captures
    where content is not null
    order by worker_id, id desc
  `).all() as Array<{ id: number; worker_id: string }>;
  const seen = new Map<string, number>();
  const pruneIds: number[] = [];
  for (const row of rows) {
    const count = (seen.get(row.worker_id) ?? 0) + 1;
    seen.set(row.worker_id, count);
    if (count > keepLatest) {
      pruneIds.push(row.id);
    }
  }
  return pruneIds;
}

function telemetryEventsSync(database: RuntimeDatabase, options: {
  actor: string | null;
  eventType: string | null;
  limit: number;
  newest: boolean;
  runId: string | null;
  search: string | null;
  severity: string | null;
  taskId: string | null;
}): TelemetryEventRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of [["run_id", options.runId], ["task_id", options.taskId], ["actor", options.actor], ["event_type", options.eventType], ["severity", options.severity]] as const) {
    if (value !== null) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (options.search) {
    clauses.push(`
      (
        id in (
          select event_id
          from telemetry_events_fts
          where telemetry_events_fts match ?
        )
        or event_type = ?
      )
    `);
    params.push(telemetryFtsQuery(options.search), options.search);
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = database.prepare(`
    select id, run_id, task_id, timestamp, actor, event_type, severity, summary,
           correlation_json, attributes_json
    from telemetry_events
    ${where}
    order by timestamp ${options.newest ? "desc" : "asc"}, rowid ${options.newest ? "desc" : "asc"}
    limit ?
  `).all(...(params as string[]), options.limit) as Array<Record<string, string | null>>;
  return rows.map((row) => ({
    actor: String(row.actor),
    attributes: parseJsonObject(String(row.attributes_json ?? "{}")),
    correlation: parseJsonObject(String(row.correlation_json ?? "{}")),
    event_type: String(row.event_type),
    id: String(row.id),
    run_id: row.run_id,
    severity: String(row.severity),
    summary: String(row.summary),
    task_id: row.task_id,
    timestamp: String(row.timestamp),
  }));
}

function telemetryFtsQuery(search: string): string {
  return search.split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" ");
}

function telemetrySummarySync(events: TelemetryEventRecord[], options?: { runId?: string | null; taskId?: string | null }): {
  by_actor: Record<string, number>;
  by_event_type: Record<string, number>;
  by_severity: Record<string, number>;
  first_timestamp: string | null;
  last_timestamp: string | null;
  run_id: string | null;
  task_id: string | null;
  total: number;
} {
  const runIds = new Set(events.map((event) => event.run_id).filter((value): value is string => value !== null));
  const taskIds = new Set(events.map((event) => event.task_id).filter((value): value is string => value !== null));
  return {
    by_actor: countByStrings(events.map((event) => event.actor)),
    by_event_type: countByStrings(events.map((event) => event.event_type)),
    by_severity: countByStrings(events.map((event) => event.severity)),
    first_timestamp: events[0]?.timestamp ?? null,
    last_timestamp: events.at(-1)?.timestamp ?? null,
    run_id: options?.runId ?? (runIds.size === 1 ? [...runIds][0] : null),
    task_id: options?.taskId ?? (taskIds.size === 1 ? [...taskIds][0] : null),
    total: events.length,
  };
}

function telemetryMetricsSync(database: RuntimeDatabase, options: { dbPath: string; now?: () => Date; runRef: string | null; taskRef: string | null; window: string }): Record<string, any> {
  const seconds = parseTelemetryWindowSeconds(options.window);
  const end = options.now?.() ?? new Date();
  const start = new Date(end.getTime() - seconds * 1000);
  const startIso = isoSeconds(start);
  const endIso = isoSeconds(end);
  const taskId = options.taskRef ? taskRowForDiagnostics(database, options.taskRef).id : null;
  const runId = telemetryRunIdForFilters(database, options.runRef, taskId);
  const eventClauses = ["timestamp >= ?", "timestamp <= ?"];
  const eventParams: unknown[] = [startIso, endIso];
  if (runId) {
    eventClauses.push("run_id = ?");
    eventParams.push(runId);
  }
  if (taskId) {
    eventClauses.push("task_id = ?");
    eventParams.push(taskId);
  }
  const eventWhere = eventClauses.join(" and ");
  const telemetryRows = database.prepare(`select actor, event_type, severity from telemetry_events where ${eventWhere}`).all(...(eventParams as string[])) as Array<{ actor: string; event_type: string; severity: string }>;
  const cycleStates = countRows(database, "manager_cycles", "state", {
    runId,
    taskId,
    timeColumn: "started_at",
    startIso,
    endIso,
  });
  const commandStates = commandTypeStateCounts(database, {
    runId,
    taskId,
    startIso,
    endIso,
  });
  const commandAttemptStates = commandAttemptTypeStateCounts(database, {
    runId,
    taskId,
    startIso,
    endIso,
  });
  const paneCapture = paneCaptureCountsSync(database, { runId, taskId, startIso, endIso });
  const reconcile = collectReconcileReportSync(database, { staleCyclesSeconds: 3600 });
  const storage = storageCountsSync(database, options.dbPath, taskId);
  return {
    counters: {
      cycles: {
        failed: cycleStates.failed ?? 0,
        started: cycleStates.started ?? 0,
        succeeded: cycleStates.succeeded ?? 0,
        total: Object.values(cycleStates).reduce((sum, count) => sum + count, 0),
      },
      exports: { total: telemetryRows.filter((row) => row.event_type.startsWith("export_") || row.event_type.endsWith("_exported")).length },
      ingest: {
        new_events: sumTelemetryAttribute(database, eventWhere, eventParams, "new_events"),
        skipped_lines: sumTelemetryAttribute(database, eventWhere, eventParams, "skipped_lines"),
      },
      pane_capture: paneCapture,
      telemetry_events: {
        by_actor: countByStrings(telemetryRows.map((row) => row.actor)),
        by_actor_event_type_severity: countByCompositeNested(telemetryRows, ["actor", "event_type", "severity"]),
        by_event_type: countByStrings(telemetryRows.map((row) => row.event_type)),
        by_severity: countByStrings(telemetryRows.map((row) => row.severity)),
        total: telemetryRows.length,
      },
    },
    filters: { run_id: runId, task_id: taskId },
    gauges: {
      active_sessions: activeSessionGauge(database),
      active_tasks: activeTaskCountSync(database, taskId),
      criteria: criteriaGauge(database, taskId),
      reconcile: {
        dangling_bindings: reconcile.dangling_bindings.length,
        dead_pid_sessions: reconcile.dead_pid_sessions.length,
        stuck_tasks: reconcile.stuck_tasks.length,
        total_drift: reconcile.dangling_bindings.length + reconcile.dead_pid_sessions.length + reconcile.stuck_tasks.length,
      },
      storage_bytes: {
        database_file: storage.database_file,
        terminal_captures: storage.terminal_captures.bytes,
        total_retained: storage.total_retained,
        transcript_captures: storage.transcript_captures.bytes,
        transcript_segments: storage.transcript_segments.bytes,
      },
    },
    generated_at: endIso,
    rollups: {
      command_attempts_by_type: commandAttemptStates,
      commands_by_type: commandStates,
      cycle_success_rate: ((cycleStates.succeeded ?? 0) + (cycleStates.failed ?? 0)) > 0
        ? (cycleStates.succeeded ?? 0) / ((cycleStates.succeeded ?? 0) + (cycleStates.failed ?? 0))
        : null,
    },
    schema_version: 1,
    window: { end: endIso, label: options.window, seconds, start: startIso },
  };
}

function telemetrySnapshotSync(database: RuntimeDatabase, options: { limit: number; task: string }): Record<string, any> {
  const task = taskRowForDiagnostics(database, options.task);
  const events = telemetryEventsSync(database, { actor: null, eventType: null, limit: 10000, newest: false, runId: null, search: null, severity: null, taskId: task.id });
  const report = collectReconcileReportSync(database, { staleCyclesSeconds: 3600 });
  const commands = recentCommandsForTaskSync(database, task.id, options.limit);
  const latestCycle = latestCycleForTaskSync(database, task.id);
  const criteria = criteriaGauge(database, task.id);
  const worker = boundSessionSnapshotSync(database, task.id, "worker");
  const manager = boundSessionSnapshotSync(database, task.id, "manager");
  const integrity = taskIntegrity(task, { manager, worker });
  const diagnostics = {
    dangling_bindings: report.dangling_bindings.filter((item) => item.task_id === task.id),
    dead_pid_sessions: report.dead_pid_sessions,
    schema_ok: report.schema_health.ok,
    stuck_tasks: report.stuck_tasks.filter((item) => item.task_name === task.name),
  };
  const alerts = dashboardAlerts({ commands, criteria, diagnostics, integrityIssues: integrity.issues, latestCycle, manager, telemetrySummary: telemetrySummarySync(events), worker });
  return {
    alerts,
    binding: bindingSnapshotSync(database, task.id),
    commands,
    criteria: { open_accepted: acceptedCriteriaRowsSync(database, task.id, options.limit), open_blocker_count: criteria.by_status.accepted ?? 0, summary: criteria.by_status },
    diagnostics,
    latest_cycle: latestCycle,
    manager,
    run: activeRunForTaskSync(database, task.id),
    task: { ...task, integrity },
    telemetry: { recent: telemetryEventsSync(database, { actor: null, eventType: null, limit: options.limit, newest: false, runId: null, search: null, severity: null, taskId: task.id }), summary: telemetrySummarySync(events) },
    worker,
  };
}

function telemetryTaskViewSync(database: RuntimeDatabase, options: { dbPath: string; limit: number; staleCycleSeconds: number; task: string }): Record<string, any> {
  const snapshot = telemetrySnapshotSync(database, { limit: options.limit, task: options.task });
  const cycles = cycleHistoryForTaskSync(database, snapshot.task.id, options.limit);
  const ingest = ingestViewSync(database, { activeOnly: false, limit: options.limit, runId: null, taskId: snapshot.task.id, updatedSince: null });
  const latest = cycles.history[0] ?? null;
  const age = latest ? ageSecondsFromIso(String(latest.completed_at ?? latest.started_at)) : null;
  return {
    alerts: [
      ...snapshot.alerts,
      ...(age !== null && age > options.staleCycleSeconds ? [{ message: `Latest manager cycle is older than ${options.staleCycleSeconds} seconds.`, severity: "warning", type: "stale_cycle" }] : []),
      ...(ingest.skipped_lines ? [{ message: `${ingest.skipped_lines} ingest lines were skipped.`, severity: "warning", type: "ingest_skipped_lines" }] : []),
      ...(ingest.error_count ? [{ message: `${ingest.error_count} ingest errors or warnings were recorded.`, severity: "error", type: "ingest_errors" }] : []),
    ],
    commands: taskCommandsViewSync(database, snapshot.task.id, options.limit, false),
    criteria: criteriaViewSync(database, snapshot.task.id, options.limit),
    cycles,
    decisions: decisionsForTaskSync(database, snapshot.task.id, options.limit),
    failed_commands: taskCommandsViewSync(database, snapshot.task.id, options.limit, true).recent,
    ingest,
    liveness: {
      latest_cycle_age_seconds: age,
      latest_cycle_stale: age !== null && age > options.staleCycleSeconds,
      manager_alive: snapshot.manager?.alive ?? null,
      worker_alive: snapshot.worker?.alive ?? null,
    },
    schema_version: 1,
    storage: storageCountsSync(database, options.dbPath, snapshot.task.id),
    task: snapshot.task,
    telemetry: {
      recent: snapshot.telemetry.recent.map((event: TelemetryEventRecord) => ({
        actor: event.actor,
        event_type: event.event_type,
        id: event.id,
        run_id: event.run_id,
        severity: event.severity,
        summary: event.summary,
        timestamp: event.timestamp,
      })),
      summary: snapshot.telemetry.summary,
    },
  };
}

function telemetryTaskCheckSync(database: RuntimeDatabase, options: {
  dbPath: string;
  limit: number;
  maxOpenCriteria: number;
  maxStorageBytes: number | null;
  maxUnfinishedCommands: number;
  staleCycleSeconds: number;
  task: string;
  workerStalenessSeconds: number;
}): Record<string, any> {
  const result = telemetryTaskViewSync(database, {
    dbPath: options.dbPath,
    limit: options.limit,
    staleCycleSeconds: options.staleCycleSeconds,
    task: options.task,
  });
  const alerts = result.alerts.filter((alert: Record<string, string>) => {
    if (alert.type === "unfinished_commands") {
      return Number(result.commands.counts_by_state.pending ?? 0) + Number(result.commands.counts_by_state.attempted ?? 0) > options.maxUnfinishedCommands;
    }
    if (alert.type === "open_accepted_criteria") {
      return Number(result.criteria.summary.accepted ?? 0) > options.maxOpenCriteria;
    }
    return true;
  });
  if (options.maxStorageBytes !== null && result.storage.total_retained > options.maxStorageBytes) {
    alerts.push({ message: `${result.storage.total_retained} storage bytes exceeds threshold ${options.maxStorageBytes}.`, severity: "warning", type: "storage_bytes" });
  }
  const staleSessions = (["worker", "manager"] as const)
    .map((role) => boundSessionSnapshotSync(database, String(result.task.id), role))
    .filter((session): session is Record<string, unknown> => session !== null)
    .filter((session) => {
      const age = session.heartbeat_age_seconds;
      return typeof age === "number" && age > options.workerStalenessSeconds;
    });
  if (staleSessions.length) {
    alerts.push({ message: `${staleSessions.length} bound sessions have stale heartbeats.`, severity: "warning", type: "stale_sessions" });
  }
  return {
    ...result,
    alerts,
    checks: {
      ok: alerts.length === 0,
      thresholds: telemetryCheckThresholds(options),
    },
  };
}

function telemetryCheckThresholds(options: {
  maxOpenCriteria: number;
  maxStorageBytes: number | null;
  maxUnfinishedCommands: number;
  staleCycleSeconds: number;
  workerStalenessSeconds: number;
}): Record<string, number | null> {
  return {
    max_open_criteria: options.maxOpenCriteria,
    max_storage_bytes: options.maxStorageBytes,
    max_unfinished_commands: options.maxUnfinishedCommands,
    stale_cycle_seconds: options.staleCycleSeconds,
    worker_staleness_seconds: options.workerStalenessSeconds,
  };
}

function telemetryOperatorSnapshotSync(database: RuntimeDatabase, options: {
  activeOnly: boolean;
  dbPath: string;
  limit: number;
  maxOpenCriteria: number;
  maxStorageBytes: number | null;
  maxUnfinishedCommands: number;
  staleCycleSeconds: number;
  workerStalenessSeconds: number;
}): Record<string, any> {
  const report = collectReconcileReportSync(database, { staleCyclesSeconds: options.staleCycleSeconds });
  const commands = operatorCommandsSnapshotSync(database, { activeOnly: options.activeOnly, limit: options.limit });
  const criteria = operatorCriteriaSnapshotSync(database, { activeOnly: options.activeOnly, limit: options.limit });
  const cycles = operatorCyclesSnapshotSync(database, report, { activeOnly: options.activeOnly, limit: options.limit });
  const sessions = activeSessionSummariesSync(database, options.workerStalenessSeconds);
  const databaseBytes = databaseFileSizeSync(options.dbPath);
  const storage = { database_bytes: databaseBytes, total_bytes: databaseBytes };
  const alerts: Array<Record<string, string>> = [];
  if (!report.schema_health.ok) alerts.push({ message: "Database schema health is not OK.", severity: "error", type: "schema_health" });
  if (report.dead_pid_sessions.length) alerts.push({ message: `${report.dead_pid_sessions.length} active sessions have dead or missing pids.`, severity: "error", type: "dead_pid_sessions" });
  if (report.dangling_bindings.length) alerts.push({ message: `${report.dangling_bindings.length} bindings reference gone sessions.`, severity: "error", type: "reconcile_drift" });
  if (cycles.stale_count) alerts.push({ message: `${cycles.stale_count} active tasks have stale manager cycles.`, severity: "warning", type: "stale_cycles" });
  if (sessions.stale_count) alerts.push({ message: `${sessions.stale_count} active sessions have stale heartbeats.`, severity: "warning", type: "stale_sessions" });
  if (commands.unfinished_count > options.maxUnfinishedCommands) alerts.push({ message: `${commands.unfinished_count} unfinished commands exceeds threshold ${options.maxUnfinishedCommands}.`, severity: "warning", type: "unfinished_commands" });
  if (criteria.open_accepted_count > options.maxOpenCriteria) alerts.push({ message: `${criteria.open_accepted_count} open accepted criteria exceeds threshold ${options.maxOpenCriteria}.`, severity: "warning", type: "open_accepted_criteria" });
  if (options.maxStorageBytes !== null && storage.total_bytes > options.maxStorageBytes) alerts.push({ message: `${storage.total_bytes} storage bytes exceeds threshold ${options.maxStorageBytes}.`, severity: "warning", type: "storage_bytes" });
  if (cycles.recent_failed.length) alerts.push({ message: `${cycles.recent_failed.length} recent manager cycles failed.`, severity: "error", type: "failed_cycles" });
  if (commands.failed_count) alerts.push({ message: `${commands.failed_count} commands failed.`, severity: "error", type: "failed_commands" });
  return {
    alerts,
	    checks: {
	      ok: alerts.length === 0,
	      thresholds: telemetryCheckThresholds(options),
	    },
    commands,
    criteria,
    cycles,
    reconcile: report,
    sessions: { ...sessions, dead_pid_count: report.dead_pid_sessions.length, dead_pid_sessions: report.dead_pid_sessions },
    storage,
    tasks: { active: activeTaskSummariesSync(database), active_count: activeTaskSummariesSync(database).length },
  };
}

function telemetryFailuresViewSync(database: RuntimeDatabase, options: { activeOnly: boolean; dbPath: string; limit: number; runRef: string | null; staleCycleSeconds: number; taskRef: string | null; window: string | null }): Record<string, any> {
  let taskId = options.taskRef ? taskRowForDiagnostics(database, options.taskRef).id : null;
  let runId: string | null = null;
  if (options.runRef !== null) {
    const run = taskId !== null
      ? runRowForTaskDiagnostics(database, options.runRef, taskId)
      : runRowForDiagnostics(database, options.runRef);
    runId = run.id;
    if (taskId !== null && taskId !== run.task_id) {
      throw new Error("--run and --task refer to different tasks");
    }
    taskId = run.task_id;
  }
  const window = telemetryWindowStart(options.window);
  const failed_cycles = failedCyclesSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId, taskId, updatedSince: window.start });
  const failed_commands = failedCommandsSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId, taskId, updatedSince: window.start });
  const ingest = ingestViewSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId, taskId, updatedSince: window.start });
  const open_criteria = openCriteriaFailureViewSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId, taskId });
  const pane_capture_failures = paneCaptureFailuresSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId, taskId, updatedSince: window.start });
  const operator = telemetryOperatorSnapshotSync(database, { activeOnly: options.activeOnly, dbPath: options.dbPath, limit: options.limit, maxOpenCriteria: 0, maxStorageBytes: null, maxUnfinishedCommands: 0, staleCycleSeconds: options.staleCycleSeconds, workerStalenessSeconds: 3600 });
  return {
    alerts: [
      ...(failed_cycles.length ? [{ message: `${failed_cycles.length} manager cycles failed.`, severity: "error", type: "failed_cycles" }] : []),
      ...(failed_commands.length ? [{ message: `${failed_commands.length} commands failed.`, severity: "error", type: "failed_commands" }] : []),
      ...(ingest.error_count ? [{ message: `${ingest.error_count} ingest errors or warnings were recorded.`, severity: "error", type: "ingest_errors" }] : []),
      ...(pane_capture_failures.length ? [{ message: `${pane_capture_failures.length} pane captures failed.`, severity: "warning", type: "pane_capture_failures" }] : []),
      ...(open_criteria.open_accepted_count ? [{ message: `${open_criteria.open_accepted_count} open accepted criteria remain.`, severity: "warning", type: "open_accepted_criteria" }] : []),
    ],
    failed_commands,
    failed_cycles,
    ingest,
    operator: {
      checks: { ok: !(failed_cycles.length || failed_commands.length || ingest.error_count || pane_capture_failures.length || open_criteria.open_accepted_count), thresholds: operator.checks.thresholds },
      commands: commandsViewSync(database, { activeOnly: options.activeOnly, limit: options.limit, onlyFailed: false, runId, taskId, updatedSince: window.start }),
      cycles: {
        recent_failed: failed_cycles,
        recent_failed_count: failed_cycles.length,
        stale: taskId !== null || options.activeOnly || window.start !== null ? [] : operator.cycles.stale,
        stale_count: taskId !== null || options.activeOnly || window.start !== null ? 0 : operator.cycles.stale_count,
      },
      sessions: operator.sessions,
      tasks: operator.tasks,
    },
    open_criteria,
    pane_capture_failures,
    filters: {
      active_only: options.activeOnly,
      run_id: runId,
      task_id: taskId,
      window: window.info,
    },
    schema_version: 1,
    storage: storageCountsSync(database, options.dbPath, taskId),
  };
}

function activeTaskSummariesSync(database: RuntimeDatabase): Array<Record<string, unknown>> {
  return database.prepare(`
    select id, name, summary, state, created_at, updated_at
    from tasks
    where state in ('candidate', 'managed', 'paused')
    order by updated_at desc, name
  `).all() as Array<Record<string, unknown>>;
}

function activeTaskCountSync(database: RuntimeDatabase, taskId: string | null): number {
  if (taskId !== null) {
    const row = database.prepare("select count(*) as count from tasks where state in ('candidate', 'managed', 'paused') and id = ?").get(taskId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }
  return activeTaskSummariesSync(database).length;
}

function operatorCommandsSnapshotSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number }): Record<string, any> {
  const activeClause = options.activeOnly ? "where c.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))" : "";
  const counts = database.prepare(`
    select
      sum(case when c.state in ('pending', 'attempted') then 1 else 0 end) as unfinished_count,
      sum(case when c.state = 'failed' then 1 else 0 end) as failed_count
    from commands c
    ${activeClause}
  `).get() as { failed_count: number | null; unfinished_count: number | null };
  return {
    failed_count: Number(counts.failed_count ?? 0),
    recent_failed: failedCommandsSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId: null, taskId: null, updatedSince: null }),
    recent_unfinished: database.prepare(`
      select c.id, c.task_id, t.name as task_name, c.type, c.state, c.created_at, c.updated_at,
             c.claimed_by, c.attempts
      from commands c
      left join tasks t on t.id = c.task_id
      where c.state in ('pending', 'attempted')
        ${options.activeOnly ? "and c.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))" : ""}
      order by c.updated_at desc, c.created_at desc
      limit ?
    `).all(options.limit),
    unfinished_count: Number(counts.unfinished_count ?? 0),
  };
}

function recentCommandsForTaskSync(database: RuntimeDatabase, taskId: string, limit: number, onlyFailed = false): Record<string, any> {
  const failedOnly = onlyFailed ? "and c.state = 'failed'" : "";
  const rows = database.prepare(`
    select c.id, c.type, c.state, c.created_at, c.updated_at, c.task_id, c.worker_id, c.manager_id,
           c.payload_json, c.result_json, c.error
    from commands c
    where c.task_id = ? ${failedOnly}
    order by c.created_at desc, c.id desc
    limit ?
  `).all(taskId, limit) as Array<Record<string, string | null>>;
  const counts = database.prepare(`
    select
      sum(case when state in ('pending', 'attempted') then 1 else 0 end) as unfinished_count,
      sum(case when state = 'failed' then 1 else 0 end) as failed_count
    from commands
    where task_id = ?
  `).get(taskId) as { failed_count: number | null; unfinished_count: number | null };
  return {
    failed_count: Number(counts.failed_count ?? 0),
    recent: rows.map((row) => ({
      created_at: row.created_at,
      error: row.error,
      id: row.id,
      manager_id: row.manager_id,
      payload: parseJsonObject(String(row.payload_json ?? "{}")),
      result: row.result_json ? parseJsonObject(String(row.result_json)) : null,
      state: row.state,
      task_id: row.task_id,
      type: row.type,
      updated_at: row.updated_at,
      worker_id: row.worker_id,
    })),
    unfinished_count: Number(counts.unfinished_count ?? 0),
  };
}

function taskCommandsViewSync(database: RuntimeDatabase, taskId: string, limit: number, onlyFailed: boolean): Record<string, unknown> {
  const failedOnly = onlyFailed ? "and state = 'failed'" : "";
  const rows = database.prepare(`
    select id, idempotency_key, created_at, updated_at, task_id, worker_id,
           manager_id, correlation_id, type, state, available_at, claimed_by,
           claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
           required_permission, result_json, error
    from commands
    where task_id = ? ${failedOnly}
    order by updated_at desc, created_at desc, id desc
    limit ?
  `).all(taskId, limit) as Array<Record<string, string | number | null>>;
  const countRows = database.prepare(`
    select state, count(*) as count
    from commands
    where task_id = ? ${failedOnly}
    group by state
  `).all(taskId) as Array<{ count: number; state: string }>;
  const countsByState = Object.fromEntries(countRows.map((row) => [row.state, Number(row.count)]));
  return {
    counts_by_state: countsByState,
    failed_count: countsByState.failed ?? 0,
    recent: rows.map(safeCommandView),
    total: Object.values(countsByState).reduce((sum, count) => sum + count, 0),
  };
}

function safeCommandView(row: Record<string, string | number | null>): Record<string, unknown> {
  return {
    attempts: row.attempts,
    available_at: row.available_at,
    claimed_at: row.claimed_at,
    claimed_by: row.claimed_by,
    claim_expires_at: row.claim_expires_at,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    error: row.error,
    id: row.id,
    idempotency_key: row.idempotency_key,
    manager_id: row.manager_id,
    max_attempts: row.max_attempts,
    payload: parseJsonObject(String(row.payload_json ?? "{}")),
    required_permission: row.required_permission,
    result: row.result_json ? parseJsonObject(String(row.result_json)) : null,
    state: row.state,
    task_id: row.task_id,
    type: row.type,
    updated_at: row.updated_at,
    worker_id: row.worker_id,
  };
}

function failedCommandsSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number; runId: string | null; taskId: string | null; updatedSince: string | null }): Array<Record<string, unknown>> {
  const clauses = ["c.state = 'failed'"];
  const params: unknown[] = [];
  if (options.taskId !== null) {
    clauses.push("c.task_id = ?");
    params.push(options.taskId);
  }
  if (options.updatedSince !== null) {
    clauses.push("c.updated_at >= ?");
    params.push(options.updatedSince);
  }
  if (options.activeOnly) {
    clauses.push("c.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const rows = database.prepare(`
    select c.id, c.task_id, t.name as task_name, c.type, c.state, c.created_at, c.updated_at,
           c.claimed_by, c.attempts, c.error, c.payload_json, c.result_json
    from commands c
    left join tasks t on t.id = c.task_id
    where ${clauses.join(" and ")}
    order by c.updated_at desc, c.created_at desc
    ${options.runId === null ? "limit ?" : ""}
  `).all(...(options.runId === null ? [...params, options.limit] : params) as string[]) as Array<Record<string, unknown>>;
  return rows
    .filter((row) => options.runId === null || commandRowMatchesRun(row as { payload_json: string | null; result_json: string | null }, options.runId))
    .slice(0, options.limit)
    .map(({ payload_json: _payloadJson, result_json: _resultJson, ...row }) => row);
}

function failedCyclesSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number; runId: string | null; taskId: string | null; updatedSince: string | null }): Array<Record<string, unknown>> {
  const clauses = ["mc.state = 'failed'"];
  const params: unknown[] = [];
  if (options.taskId !== null) {
    clauses.push("mc.task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    clauses.push("exists (select 1 from manager_cycle_spans mcs where mcs.manager_cycle_id = mc.id and mcs.run_id = ?)");
    params.push(options.runId);
  }
  if (options.updatedSince !== null) {
    clauses.push("coalesce(mc.completed_at, mc.started_at) >= ?");
    params.push(options.updatedSince);
  }
  if (options.activeOnly) {
    clauses.push("mc.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const rows = database.prepare(`
    select mc.id, mc.task_id, t.name as task_name, mc.manager_id, mc.started_at,
           mc.completed_at, mc.state, mc.status_json, mc.health_json, mc.decision, mc.error
    from manager_cycles mc
    left join tasks t on t.id = mc.task_id
    where ${clauses.join(" and ")}
    order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
    limit ?
  `).all(...[...params, options.limit] as string[]) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...cycleView(row as Record<string, string | number | null>),
    task_name: row.task_name,
  }));
}

function commandsViewSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number; onlyFailed: boolean; runId: string | null; taskId: string | null; updatedSince: string | null }): Record<string, unknown> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.onlyFailed) {
    clauses.push("c.state = 'failed'");
  }
  if (options.taskId !== null) {
    clauses.push("c.task_id = ?");
    params.push(options.taskId);
  }
  if (options.updatedSince !== null) {
    clauses.push("c.updated_at >= ?");
    params.push(options.updatedSince);
  }
  if (options.activeOnly) {
    clauses.push("c.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = database.prepare(`
    select c.id, c.task_id, t.name as task_name, c.type, c.state, c.created_at, c.updated_at,
           c.claimed_by, c.attempts, c.error, c.payload_json, c.result_json
    from commands c
    left join tasks t on t.id = c.task_id
    ${where}
    order by c.updated_at desc, c.created_at desc
    ${options.runId === null ? "limit ?" : ""}
  `).all(...(options.runId === null ? [...params, options.limit] : params) as string[]) as Array<Record<string, unknown>>;
  const matching = rows.filter((row) => options.runId === null || commandRowMatchesRun(row as { payload_json: string | null; result_json: string | null }, options.runId));
  const countsByState = countByStrings(matching.map((row) => String(row.state ?? "unknown")));
  return {
    counts_by_state: countsByState,
    failed_count: countsByState.failed ?? 0,
    recent: matching.slice(0, options.limit).map(({ payload_json: _payloadJson, result_json: _resultJson, ...row }) => row),
    total: Object.values(countsByState).reduce((sum, count) => sum + count, 0),
  };
}

function paneCaptureFailuresSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number; runId: string | null; taskId: string | null; updatedSince: string | null }): Array<Record<string, unknown>> {
  const clauses = ["json_extract(mc.status_json, '$.pane_signal.captured') = 0"];
  const params: unknown[] = [];
  if (options.taskId !== null) {
    clauses.push("mc.task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    clauses.push("exists (select 1 from manager_cycle_spans mcs where mcs.manager_cycle_id = mc.id and mcs.run_id = ?)");
    params.push(options.runId);
  }
  if (options.updatedSince !== null) {
    clauses.push("coalesce(mc.completed_at, mc.started_at) >= ?");
    params.push(options.updatedSince);
  }
  if (options.activeOnly) {
    clauses.push("mc.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const rows = database.prepare(`
    select mc.id, mc.task_id, t.name as task_name, mc.manager_id, mc.started_at,
           mc.completed_at, mc.state, mc.status_json, mc.health_json, mc.decision, mc.error
    from manager_cycles mc
    left join tasks t on t.id = mc.task_id
    where ${clauses.join(" and ")}
    order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
    limit ?
  `).all(...[...params, options.limit] as string[]) as Array<Record<string, string | number | null>>;
  return rows.map((row) => ({ ...cycleView(row), task_name: row.task_name }));
}

function ingestViewSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number; runId: string | null; taskId: string | null; updatedSince: string | null }): Record<string, unknown> {
  const eventClauses: string[] = [];
  const eventParams: unknown[] = [];
  if (options.taskId !== null) {
    eventClauses.push("task_id = ?");
    eventParams.push(options.taskId);
  }
  if (options.runId !== null) {
    eventClauses.push("run_id = ?");
    eventParams.push(options.runId);
  }
  if (options.updatedSince !== null) {
    eventClauses.push("timestamp >= ?");
    eventParams.push(options.updatedSince);
  }
  if (options.activeOnly) {
    eventClauses.push("task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const eventSuffix = eventClauses.length ? `and ${eventClauses.join(" and ")}` : "";
  const skippedRow = database.prepare(`
    select
      sum(coalesce(json_extract(attributes_json, '$.new_events'), 0)) as new_events,
      sum(coalesce(json_extract(attributes_json, '$.skipped_lines'), 0)) as skipped_lines
    from telemetry_events
    where event_type = 'codex_events_ingested' ${eventSuffix}
  `).get(...(eventParams as string[])) as { new_events: number | null; skipped_lines: number | null } | undefined;
  const skippedEvents = database.prepare(`
    select id, run_id, task_id, timestamp, actor, event_type, severity,
           summary, correlation_json, attributes_json
    from telemetry_events
    where event_type = 'codex_events_ingested'
      and coalesce(json_extract(attributes_json, '$.skipped_lines'), 0) > 0
      ${eventSuffix}
    order by timestamp desc, id desc
    limit ?
  `).all(...[...eventParams, options.limit] as string[]) as Array<Record<string, string | null>>;
  const errorEvents = database.prepare(`
    select id, run_id, task_id, timestamp, actor, event_type, severity,
           summary, correlation_json, attributes_json
    from telemetry_events
    where (event_type like '%ingest%' or event_type = 'codex_events_ingested')
      and severity in ('warning', 'error')
      ${eventSuffix}
    order by timestamp desc, id desc
    limit ?
  `).all(...[...eventParams, options.limit] as string[]) as Array<Record<string, string | null>>;

  const cycleClauses = ["mc.state = 'failed'"];
  const cycleParams: unknown[] = [];
  if (options.taskId !== null) {
    cycleClauses.push("mc.task_id = ?");
    cycleParams.push(options.taskId);
  }
  if (options.runId !== null) {
    cycleClauses.push("exists (select 1 from manager_cycle_spans mcs where mcs.manager_cycle_id = mc.id and mcs.run_id = ?)");
    cycleParams.push(options.runId);
  }
  if (options.updatedSince !== null) {
    cycleClauses.push("coalesce(mc.completed_at, mc.started_at) >= ?");
    cycleParams.push(options.updatedSince);
  }
  if (options.activeOnly) {
    cycleClauses.push("mc.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const cycleErrors = database.prepare(`
    select mc.id, mc.task_id, t.name as task_name, mc.started_at, mc.completed_at,
           mc.state, mc.error, mc.status_json
    from manager_cycles mc
    left join tasks t on t.id = mc.task_id
    where ${cycleClauses.join(" and ")}
      and (
        mc.error like '%Ingest%'
        or json_extract(mc.status_json, '$.error_type') like '%Ingest%'
      )
    order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
    limit ?
  `).all(...[...cycleParams, options.limit] as string[]) as Array<Record<string, unknown>>;

  return {
    cycle_errors: cycleErrors.map((row) => ({
      completed_at: row.completed_at,
      error: row.error,
      id: row.id,
      started_at: row.started_at,
      state: row.state,
      task_id: row.task_id,
      task_name: row.task_name,
    })),
    error_count: errorEvents.length + cycleErrors.length,
    new_events: Number(skippedRow?.new_events ?? 0),
    recent_errors: errorEvents.map(telemetryIngestEventSummary),
    recent_skipped: skippedEvents.map(telemetryIngestEventSummary),
    skipped_lines: Number(skippedRow?.skipped_lines ?? 0),
  };
}

function telemetryIngestEventSummary(row: Record<string, string | null>): Record<string, unknown> {
  const attributes = parseJsonObject(row.attributes_json ?? "{}");
  return {
    attributes: Object.fromEntries(["new_events", "skipped_lines", "error", "reason"].flatMap((key) => Object.prototype.hasOwnProperty.call(attributes, key) ? [[key, attributes[key]]] : [])),
    event_type: row.event_type,
    id: row.id,
    run_id: row.run_id,
    severity: row.severity,
    summary: row.summary,
    task_id: row.task_id,
    timestamp: row.timestamp,
  };
}

function openCriteriaFailureViewSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number; runId: string | null; taskId: string | null }): Record<string, unknown> {
  const countClauses: string[] = [];
  const rowClauses: string[] = [];
  const params: unknown[] = [];
  if (options.taskId !== null) {
    countClauses.push("task_id = ?");
    rowClauses.push("ac.task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    countClauses.push("json_extract(evidence_json, '$.ralph_loop_run_id') = ?");
    rowClauses.push("json_extract(ac.evidence_json, '$.ralph_loop_run_id') = ?");
    params.push(options.runId);
  }
  if (options.activeOnly) {
    countClauses.push("task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
    rowClauses.push("ac.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))");
  }
  const countWhere = countClauses.length ? `where ${countClauses.join(" and ")}` : "";
  const counts = database.prepare(`
    select status, count(*) as count
    from acceptance_criteria
    ${countWhere}
    group by status
  `).all(...(params as string[])) as Array<{ count: number; status: string }>;
  const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
  const acceptedWhere = [...rowClauses, "ac.status = 'accepted'"].join(" and ");
  const rows = database.prepare(`
    select ac.id, ac.task_id, t.name as task_name, ac.status, ac.source, ac.created_at, ac.updated_at
    from acceptance_criteria ac
    left join tasks t on t.id = ac.task_id
    where ${acceptedWhere}
    order by ac.updated_at desc, ac.id desc
    limit ?
  `).all(...[...params, options.limit] as string[]) as Array<Record<string, unknown>>;
  return {
    by_status: byStatus,
    open_accepted: rows,
    open_accepted_count: byStatus.accepted ?? 0,
  };
}

function operatorCyclesSnapshotSync(database: RuntimeDatabase, report: ReturnType<typeof collectReconcileReportSync>, options: { activeOnly: boolean; limit: number }): Record<string, any> {
  const recent_failed = failedCyclesSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId: null, taskId: null, updatedSince: null });
  return {
    recent_failed,
    recent_failed_count: recent_failed.length,
    stale: report.stuck_tasks,
    stale_count: report.stuck_tasks.length,
  };
}

function operatorCriteriaSnapshotSync(database: RuntimeDatabase, options: { activeOnly: boolean; limit: number }): Record<string, any> {
  const view = openCriteriaFailureViewSync(database, { activeOnly: options.activeOnly, limit: options.limit, runId: null, taskId: null });
  return {
    by_status: view.by_status,
    open_accepted: view.open_accepted,
    open_accepted_count: view.open_accepted_count,
  };
}

function acceptedCriteriaRowsSync(database: RuntimeDatabase, taskId: string | null, limit: number): Array<Record<string, unknown>> {
  const where = taskId ? "where ac.status = 'accepted' and ac.task_id = ?" : "where ac.status = 'accepted'";
  const params = taskId ? [taskId, limit] : [limit];
  return database.prepare(`
    select ac.id, ac.task_id, t.name as task_name, ac.status, ac.source, ac.created_at, ac.updated_at
    from acceptance_criteria ac
    left join tasks t on t.id = ac.task_id
    ${where}
    order by ac.updated_at desc, ac.id desc
    limit ?
	  `).all(...params) as Array<Record<string, unknown>>;
}

function criteriaViewSync(database: RuntimeDatabase, taskId: string, limit: number): Record<string, unknown> {
  const rows = database.prepare(`
    select id, task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
    from acceptance_criteria
    where task_id = ?
    order by id
  `).all(taskId) as Array<Record<string, string | number | null>>;
  const summary = { accepted: 0, deferred: 0, proposed: 0, rejected: 0, satisfied: 0 };
  for (const row of rows) {
    const status = String(row.status);
    if (status in summary) {
      summary[status as keyof typeof summary] += 1;
    }
  }
  const openRows = rows.filter((row) => row.status === "proposed" || row.status === "accepted");
  return {
    open: openRows.slice(0, limit).map((row) => ({
      created_at: row.created_at,
      id: row.id,
      proof: row.proof,
      source: row.source,
      status: row.status,
      updated_at: row.updated_at,
    })),
    open_count: openRows.length,
    summary,
    total: rows.length,
  };
}

function activeSessionSummariesSync(database: RuntimeDatabase, workerStalenessSeconds: number): Record<string, any> {
  const active = (database.prepare(`
    select id, name, role, pid, cwd, tmux_session, tmux_pane_id, last_heartbeat_at, registered_at
    from sessions
    where state = 'active'
    order by role, name
  `).all() as Array<Record<string, string | number | null>>).map((row) => ({
    ...row,
    heartbeat_age_seconds: typeof row.last_heartbeat_at === "string" ? ageSecondsFromIso(row.last_heartbeat_at) : null,
  }));
  const stale = active.filter((session) => typeof session.heartbeat_age_seconds === "number" && session.heartbeat_age_seconds > workerStalenessSeconds);
  return { active, active_count: active.length, stale, stale_count: stale.length };
}

function criteriaGauge(database: RuntimeDatabase, taskId: string | null): { by_status: Record<string, number>; open: number; total: number } {
  const where = taskId ? "where task_id = ?" : "";
  const params = taskId ? [taskId] : [];
  const rows = database.prepare(`select status, count(*) as count from acceptance_criteria ${where} group by status`).all(...params) as Array<{ count: number; status: string }>;
  const byStatus = { accepted: 0, deferred: 0, proposed: 0, rejected: 0, satisfied: 0 };
  for (const row of rows) {
    byStatus[row.status as keyof typeof byStatus] = Number(row.count);
  }
  return { by_status: byStatus, open: byStatus.proposed + byStatus.accepted, total: Object.values(byStatus).reduce((sum, count) => sum + count, 0) };
}

function activeSessionGauge(database: RuntimeDatabase): Record<string, unknown> {
  const rows = database.prepare("select role, count(*) as count from sessions where state = 'active' group by role").all() as Array<{ count: number; role: string }>;
  const byRole = { manager: 0, worker: 0 };
  for (const row of rows) {
    if (row.role === "manager" || row.role === "worker") {
      byRole[row.role] = Number(row.count);
    }
  }
  return { by_role: byRole, total: byRole.manager + byRole.worker };
}

function countRows(database: RuntimeDatabase, table: string, column: string, options: { endIso: string; runId: string | null; startIso: string; taskId: string | null; timeColumn: string }): Record<string, number> {
  const clauses = [`${options.timeColumn} >= ?`, `${options.timeColumn} <= ?`];
  const params: unknown[] = [options.startIso, options.endIso];
  if (options.taskId !== null) {
    clauses.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    clauses.push(`exists (select 1 from manager_cycle_spans mcs where mcs.manager_cycle_id = ${table}.id and mcs.run_id = ?)`);
    params.push(options.runId);
  }
  const rows = database.prepare(`select ${column} as key, count(*) as count from ${table} where ${clauses.join(" and ")} group by ${column}`).all(...(params as string[])) as Array<{ count: number; key: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

function commandTypeStateCounts(database: RuntimeDatabase, options: { endIso: string; runId: string | null; startIso: string; taskId: string | null }): Record<string, Record<string, number>> {
  const clauses = ["created_at >= ?", "created_at <= ?"];
  const params: unknown[] = [options.startIso, options.endIso];
  if (options.taskId !== null) {
    clauses.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    clauses.push(commandRunSqlClause("commands"));
    params.push(...commandRunSqlParams(options.runId));
  }
  const rows = database.prepare(`select type, state, count(*) as count from commands where ${clauses.join(" and ")} group by type, state`).all(...(params as string[])) as Array<{ count: number; state: string; type: string }>;
  const result: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    result[row.type] = { ...(result[row.type] ?? {}), [row.state]: Number(row.count) };
  }
  return result;
}

function commandAttemptTypeStateCounts(database: RuntimeDatabase, options: { endIso: string; runId: string | null; startIso: string; taskId: string | null }): Record<string, Record<string, number>> {
  const clauses = ["ca.started_at >= ?", "ca.started_at <= ?"];
  const params: unknown[] = [options.startIso, options.endIso];
  if (options.taskId !== null) {
    clauses.push("commands.task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    clauses.push(commandRunSqlClause("commands"));
    params.push(...commandRunSqlParams(options.runId));
  }
  const rows = database.prepare(`
    select commands.type, ca.state, count(*) as count
    from command_attempts ca
    join commands on commands.id = ca.command_id
    where ${clauses.join(" and ")}
    group by commands.type, ca.state
  `).all(...(params as string[])) as Array<{ count: number; state: string; type: string }>;
  const result: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    result[row.type] = { ...(result[row.type] ?? {}), [row.state]: Number(row.count) };
  }
  return result;
}

function paneCaptureCountsSync(database: RuntimeDatabase, options: { endIso: string; runId: string | null; startIso: string; taskId: string | null }): Record<string, number> {
  const clauses = ["started_at >= ?", "started_at <= ?"];
  const params: unknown[] = [options.startIso, options.endIso];
  if (options.taskId !== null) {
    clauses.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId !== null) {
    clauses.push("exists (select 1 from manager_cycle_spans mcs where mcs.manager_cycle_id = manager_cycles.id and mcs.run_id = ?)");
    params.push(options.runId);
  }
  const rows = database.prepare(`
    select
      case json_extract(status_json, '$.pane_signal.captured')
        when 1 then 'succeeded'
        when 0 then 'failed'
        else 'unknown'
      end as state,
      count(*) as count
    from manager_cycles
    where ${clauses.join(" and ")}
    group by state
  `).all(...(params as string[])) as Array<{ count: number; state: "failed" | "succeeded" | "unknown" }>;
  const result = { failed: 0, succeeded: 0, unknown: 0 };
  for (const row of rows) {
    result[row.state] = Number(row.count);
  }
  return result;
}

function commandRunSqlClause(alias: string): string {
  const payload = `${alias}.payload_json`;
  const result = `${alias}.result_json`;
  return `(
    json_extract(${payload}, '$.ralph_loop_run_id') = ?
    or json_extract(${payload}, '$.loop_run_id') = ?
    or json_extract(${payload}, '$.run_id') = ?
    or json_extract(${payload}, '$.ralph_loop.run_id') = ?
    or json_extract(${payload}, '$.loop_policy.run_id') = ?
    or json_extract(${result}, '$.ralph_loop_run_id') = ?
    or json_extract(${result}, '$.loop_run_id') = ?
    or json_extract(${result}, '$.run_id') = ?
    or json_extract(${result}, '$.ralph_loop.run_id') = ?
    or json_extract(${result}, '$.loop_policy.run_id') = ?
  )`;
}

function commandRunSqlParams(runId: string): string[] {
  return Array.from({ length: 10 }, () => runId);
}

function sumTelemetryAttribute(database: RuntimeDatabase, eventWhere: string, eventParams: unknown[], key: string): number {
  const row = database.prepare(`select sum(coalesce(json_extract(attributes_json, '$.${key}'), 0)) as total from telemetry_events where ${eventWhere}`).get(...(eventParams as string[])) as { total: number | null };
  return Number(row.total ?? 0);
}

function storageCountsSync(database: RuntimeDatabase, dbPath: string, taskId: string | null): Record<string, any> {
  const taskFilter = taskId !== null ? "where task_id = ?" : "";
  const taskParams = taskId !== null ? [taskId] : [];
  const terminal = database.prepare(`select count(*) as count, sum(byte_count) as bytes from terminal_captures ${taskFilter}`).get(...taskParams) as { bytes: number | null; count: number | null } | undefined;
  const segmentWhere = taskId !== null ? "where task_id = ? and segment_text is not null" : "where segment_text is not null";
  const segments = database.prepare(`select count(*) as count, sum(byte_count) as bytes from transcript_segments ${segmentWhere}`).get(...taskParams) as { bytes: number | null; count: number | null } | undefined;
  let transcriptSql = "select count(*) as count, sum(byte_count) as bytes from transcript_captures where content is not null";
  const transcriptParams: string[] = [];
  if (taskId !== null) {
    transcriptSql = `
      select count(*) as count, sum(byte_count) as bytes
      from (
        select distinct transcript_captures.id, transcript_captures.byte_count
        from transcript_captures
        join bindings on bindings.worker_id = transcript_captures.worker_id
        where bindings.task_id = ?
          and transcript_captures.content is not null
      )
    `;
    transcriptParams.push(taskId);
  }
  const transcript = database.prepare(transcriptSql).get(...transcriptParams) as { bytes: number | null; count: number | null } | undefined;
  const terminalBytes = Number(terminal?.bytes ?? 0);
  const segmentBytes = Number(segments?.bytes ?? 0);
  const transcriptBytes = Number(transcript?.bytes ?? 0);
  return {
    database_file: databaseFileSizeSync(dbPath),
    terminal_captures: { bytes: terminalBytes, count: Number(terminal?.count ?? 0) },
    total_retained: terminalBytes + segmentBytes + transcriptBytes,
    transcript_captures: { bytes: transcriptBytes, count: Number(transcript?.count ?? 0) },
    transcript_segments: { bytes: segmentBytes, count: Number(segments?.count ?? 0) },
  };
}

function databaseFileSizeSync(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}

function telemetryWindowStart(window: string | null): { info: Record<string, unknown> | null; start: string | null } {
  if (window === null) {
    return { info: null, start: null };
  }
  const seconds = parseTelemetryWindowSeconds(window);
  const end = new Date();
  const start = new Date(end.getTime() - seconds * 1000);
  return {
    info: { end: end.toISOString(), label: window, seconds, start: start.toISOString() },
    start: start.toISOString(),
  };
}

function latestCycleForTaskSync(database: RuntimeDatabase, taskId: string): Record<string, unknown> | null {
  const row = database.prepare(`
    select id, task_id, started_at, completed_at, state, status_json, health_json, decision, error
    from manager_cycles
    where task_id = ?
    order by id desc
    limit 1
  `).get(taskId) as Record<string, string | number | null> | undefined;
  return row ? cycleView(row) : null;
}

function cycleHistoryForTaskSync(database: RuntimeDatabase, taskId: string, limit: number): Record<string, any> {
  const rows = database.prepare(`
    select id, task_id, manager_id, started_at, completed_at, state, status_json, health_json, decision, error
    from manager_cycles
    where task_id = ?
    order by id desc
    limit ?
  `).all(taskId, limit) as Array<Record<string, string | number | null>>;
  const history = rows.map(cycleView);
  const lastSuccess = database.prepare(`
    select id, task_id, manager_id, started_at, completed_at, state, status_json, health_json, decision, error
    from manager_cycles
    where task_id = ? and state = 'succeeded'
    order by id desc
    limit 1
  `).get(taskId) as Record<string, string | number | null> | undefined;
  const failed = database.prepare(`
    select id, task_id, manager_id, started_at, completed_at, state, status_json, health_json, decision, error
    from manager_cycles
    where task_id = ? and state = 'failed'
    order by id desc
    limit ?
  `).all(taskId, limit) as Array<Record<string, string | number | null>>;
  const paneFailures = database.prepare(`
    select id, task_id, manager_id, started_at, completed_at, state, status_json, health_json, decision, error
    from manager_cycles
    where task_id = ?
      and json_extract(status_json, '$.pane_signal.captured') = 0
    order by id desc
    limit ?
  `).all(taskId, limit) as Array<Record<string, string | number | null>>;
  const counts = database.prepare(`
    select state, count(*) as count
    from manager_cycles
    where task_id = ?
    group by state
  `).all(taskId) as Array<{ count: number; state: string }>;
  const countsByState = Object.fromEntries(counts.map((row) => [row.state, Number(row.count)]));
  return {
    counts_by_state: countsByState,
    failed: failed.map(cycleView),
    failed_count: countsByState.failed ?? 0,
    history,
    last_successful: lastSuccess ? cycleView(lastSuccess) : null,
    pane_capture_failures: paneFailures.map(cycleView),
    pane_capture_failure_count: paneFailures.length,
    total: Object.values(countsByState).reduce((sum, count) => sum + count, 0),
  };
}

function cycleView(row: Record<string, string | number | null>): Record<string, unknown> {
  const status = row.status_json ? parseJsonObject(String(row.status_json)) : {};
  return {
    completed_at: row.completed_at,
    decision: row.decision,
    error: row.error,
    health: row.health_json ? parseJsonObject(String(row.health_json)) : {},
    id: row.id,
    started_at: row.started_at,
    state: row.state,
    status,
    task_id: row.task_id,
    notable_pane_pattern: status.notable_pane_pattern ?? null,
  };
}

function decisionsForTaskSync(database: RuntimeDatabase, taskId: string, limit: number): Record<string, unknown> {
  const rows = database.prepare(`
    select id, task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
    from manager_decisions
    where task_id = ?
    order by created_at desc, id desc
    limit ?
  `).all(taskId, limit) as Array<Record<string, unknown>>;
  return {
    recent: rows.map((row) => ({
      created_at: row.created_at,
      decision: row.decision,
      id: row.id,
      manager_cycle_id: row.manager_cycle_id,
      manager_id: row.manager_id,
      payload_keys: Object.keys(parseJsonObject(String(row.payload_json ?? "{}"))).sort(),
      reason: row.reason,
      task_id: row.task_id,
    })),
  };
}

function bindingSnapshotSync(database: RuntimeDatabase, taskId: string): Record<string, unknown> | null {
  const row = database.prepare(`
    select b.id, b.task_id, b.worker_session_id, ws.name as worker_session_name,
           b.manager_session_id, ms.name as manager_session_name, b.state, b.created_at
    from bindings b
    left join sessions ws on ws.id = b.worker_session_id
    left join sessions ms on ms.id = b.manager_session_id
    where b.task_id = ? and b.state in ('active', 'ending')
    order by b.created_at desc
    limit 1
  `).get(taskId) as Record<string, unknown> | undefined;
  return row ?? null;
}

function boundSessionSnapshotSync(database: RuntimeDatabase, taskId: string, role: "manager" | "worker"): Record<string, unknown> | null {
  const row = role === "worker"
    ? database.prepare(`
      select s.id, s.name, s.role, s.state, s.pid, s.tmux_session, s.tmux_pane_id,
             s.cwd, s.registered_at, s.last_heartbeat_at,
             w.id as legacy_id, w.name as legacy_name, w.state as legacy_state,
             w.tmux_session as legacy_tmux_session, w.tmux_pane_id as legacy_tmux_pane_id,
             w.cwd as legacy_cwd, w.created_at as legacy_registered_at,
             w.last_seen_at as legacy_last_heartbeat_at
      from bindings b
      left join sessions s on s.id = b.worker_session_id
      left join workers w on w.id = b.worker_id
      where b.task_id = ? and b.state in ('active', 'ending')
      order by b.created_at desc
      limit 1
    `).get(taskId) as Record<string, string | number | null> | undefined
    : database.prepare(`
      select s.id, s.name, s.role, s.state, s.pid, s.tmux_session, s.tmux_pane_id,
             s.cwd, s.registered_at, s.last_heartbeat_at,
             m.id as legacy_id, m.name as legacy_name, m.state as legacy_state,
             m.tmux_session as legacy_tmux_session, m.tmux_pane_id as legacy_tmux_pane_id,
             null as legacy_cwd, m.started_at as legacy_registered_at,
             m.last_seen_at as legacy_last_heartbeat_at
      from bindings b
      left join sessions s on s.id = b.manager_session_id
      left join managers m on m.id = b.manager_id
      where b.task_id = ? and b.state in ('active', 'ending')
      order by b.created_at desc
      limit 1
    `).get(taskId) as Record<string, string | number | null> | undefined;
  if (!row) {
    return null;
  }
  if (row.id === null && row.legacy_id !== null) {
    const lastHeartbeat = typeof row.legacy_last_heartbeat_at === "string" ? row.legacy_last_heartbeat_at : null;
    return {
      alive: null,
      cwd: row.legacy_cwd,
      heartbeat_age_seconds: lastHeartbeat !== null ? ageSecondsFromIso(lastHeartbeat) : null,
      id: row.legacy_id,
      last_heartbeat_at: lastHeartbeat,
      name: row.legacy_name,
      pid: null,
      registered_at: row.legacy_registered_at,
      role,
      state: row.legacy_state,
      tmux_pane_id: row.legacy_tmux_pane_id,
      tmux_session: row.legacy_tmux_session,
    };
  }
  if (row.id === null) {
    return null;
  }
  const alive = typeof row.pid === "number" ? pidIsAlive(row.pid) : null;
  const heartbeatAge = typeof row.last_heartbeat_at === "string" ? ageSecondsFromIso(row.last_heartbeat_at) : null;
  return { ...row, alive, heartbeat_age_seconds: heartbeatAge };
}

function activeRunForTaskSync(database: RuntimeDatabase, taskId: string): Record<string, unknown> | null {
  const row = database.prepare(`
    select id, task_id, name, purpose, status, started_at, ended_at, metadata_json
    from runs
    where task_id = ? and status = 'active'
    order by started_at desc
    limit 1
  `).get(taskId) as Record<string, string | null> | undefined;
  return row ? { ...row, metadata: parseJsonObject(row.metadata_json ?? "{}") } : null;
}

function taskIntegrity(task: TaskDiagnosticsRow, options: { manager: Record<string, unknown> | null; worker: Record<string, unknown> | null }): { issues: string[]; ok: boolean } {
  const issues: string[] = [];
  if (task.state === "managed" && options.worker === null) {
    issues.push("managed_without_active_worker_binding");
  }
  if (task.state === "managed" && options.manager === null) {
    issues.push("managed_without_active_manager");
  }
  if (task.state === "failed" && options.manager !== null) {
    issues.push("closed_task_has_active_manager");
  }
  return { issues, ok: issues.length === 0 };
}

function dashboardAlerts(options: { commands: Record<string, any>; criteria: { by_status: Record<string, number> }; diagnostics: Record<string, any>; integrityIssues: string[]; latestCycle: Record<string, unknown> | null; manager: Record<string, unknown> | null; telemetrySummary: ReturnType<typeof telemetrySummarySync>; worker: Record<string, unknown> | null }): Array<Record<string, string>> {
  const alerts: Array<Record<string, string>> = [];
  for (const issue of options.integrityIssues) {
    alerts.push({ message: issue, severity: "error", type: "integrity_issue" });
  }
  if (options.latestCycle?.state === "failed") alerts.push({ message: String(options.latestCycle.error ?? "Latest manager cycle failed."), severity: "error", type: "latest_cycle_failed" });
  if (options.latestCycle?.notable_pane_pattern) alerts.push({ message: `Pane pattern detected: ${options.latestCycle.notable_pane_pattern}`, severity: "warning", type: "notable_pane_pattern" });
  if ((options.criteria.by_status.accepted ?? 0) > 0) alerts.push({ message: `${options.criteria.by_status.accepted} accepted criteria remain open.`, severity: "warning", type: "open_accepted_criteria" });
  if (options.commands.unfinished_count) alerts.push({ message: `${options.commands.unfinished_count} commands are unfinished.`, severity: "warning", type: "unfinished_commands" });
  if (options.commands.failed_count) alerts.push({ message: `${options.commands.failed_count} commands failed.`, severity: "error", type: "failed_commands" });
  if (options.telemetrySummary.by_severity.error) alerts.push({ message: `${options.telemetrySummary.by_severity.error} telemetry error events recorded.`, severity: "error", type: "telemetry_errors" });
  if (options.diagnostics.dangling_bindings.length) alerts.push({ message: "Task has dangling binding drift.", severity: "error", type: "dangling_binding" });
  if (options.diagnostics.stuck_tasks.length) alerts.push({ message: "Task has stale manager cycles.", severity: "warning", type: "stuck_task" });
  if (options.worker?.alive === false) alerts.push({ message: `worker session pid is not alive: ${options.worker.name}`, severity: "error", type: "dead_pid_session" });
  if (options.manager?.alive === false) alerts.push({ message: `manager session pid is not alive: ${options.manager.name}`, severity: "error", type: "dead_pid_session" });
  return alerts;
}

function countByStrings(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countByCompositeNested<T extends Record<string, string>>(rows: T[], keys: Array<keyof T>): Record<string, any> {
  const counts: Record<string, any> = {};
  for (const row of rows) {
    let bucket = counts;
    keys.forEach((key, index) => {
      const value = row[key];
      if (index === keys.length - 1) {
        bucket[value] = Number(bucket[value] ?? 0) + 1;
      } else {
        bucket[value] = bucket[value] ?? {};
        bucket = bucket[value];
      }
    });
  }
  return counts;
}

function isoSeconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pathIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseTelemetryWindowSeconds(window: string): number {
  const match = /^([1-9][0-9]*)([smhdw])$/.exec(window.trim().toLowerCase());
  if (!match) {
    throw new Error("--window must be a positive duration like 30m, 24h, or 7d");
  }
  const value = Number(match[1]);
  return value * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2] as "d" | "h" | "m" | "s" | "w"];
}

function ageSecondsFromIso(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 1000) : null;
}

function mutationAuditResultSync(audit: ReturnType<typeof taskAuditSync>): {
  ok: boolean;
  records: Array<Record<string, any>>;
  summary: { mutations: number; with_warnings: number };
  task: TaskDiagnosticsRow;
} {
  const allowedByType: Record<string, string[]> = {
    deregister_session: [],
    extend_nudge_budget: ["escalate"],
    finish_task: ["stop"],
    pause_manager: ["escalate", "stop"],
    request_worker_compact: ["nudge"],
    stop_task: ["stop"],
    task_interrupt: ["interrupt"],
    task_nudge: ["nudge"],
  };
  const decisionsById = new Map(audit.manager_decisions.map((decision) => [decision.id, decision]));
  const records = audit.commands.flatMap((command) => {
    const allowed = allowedByType[command.type];
    if (allowed === undefined) {
      return [];
    }
    const payload = command.payload ?? {};
    const result = command.result ?? {};
    let managerDecision = isPlainRecord(result.manager_decision) ? result.manager_decision : (isPlainRecord(payload.manager_decision) ? payload.manager_decision : null);
    if (command.type === "finish_task" && typeof result.final_decision_id === "number" && decisionsById.has(result.final_decision_id)) {
      managerDecision = { decision: decisionsById.get(result.final_decision_id), warnings: [] };
    }
    const linked = linkedDecisionFromCheck(managerDecision, decisionsById);
    const nearest = audit.manager_decisions.filter((decision) => decision.created_at <= command.created_at).at(-1) ?? null;
    const warnings: string[] = [];
    const expectedFailure = Boolean(result.expected_failure ?? payload.expected_failure);
    if (!(expectedFailure && command.state === "failed")) {
      if (allowed.length === 0) {
        if (linked) warnings.push("unexpected_linked_decision");
      } else if (managerDecision) {
        const checkWarnings = Array.isArray(managerDecision.warnings) ? managerDecision.warnings.map(String) : [];
        warnings.push(...checkWarnings);
      } else {
        warnings.push("missing_decision_metadata");
      }
      if (allowed.length > 0 && nearest && !linked) warnings.push("nearest_decision_unlinked");
      if (allowed.length > 0 && linked && !allowed.includes(linked.decision)) warnings.push("linked_decision_incompatible");
    }
    return [{
      allowed_decisions: allowed,
      command: { created_at: command.created_at, id: command.id, state: command.state, type: command.type },
      effect: {
        dry_run: Boolean(isPlainRecord(result.send_result) && result.send_result.dry_run),
        permission_check: result.permission_check ?? payload.permission_check,
        send_text: result.send_text ?? payload.send_text,
        sent: command.state === "succeeded" && isPlainRecord(result.send_result) && !result.send_result.dry_run,
        slash_command: "slash_command" in result ? result.slash_command : payload.slash_command,
        worker_session: result.worker_session ?? payload.worker_session,
      },
      expected_failure: expectedFailure,
      linked_decision: linked,
      nearest_prior_decision: nearest,
      ok: warnings.length === 0,
      warnings,
    }];
  });
  return {
    ok: records.every((record) => record.ok),
    records,
    summary: { mutations: records.length, with_warnings: records.filter((record) => record.warnings.length > 0).length },
    task: audit.task,
  };
}

function linkedDecisionFromCheck(value: Record<string, unknown> | null, decisionsById: Map<number, Record<string, any>>): Record<string, any> | null {
  if (!value) {
    return null;
  }
  const decision = isPlainRecord(value.decision) ? value.decision : value;
  const id = typeof value.decision_id === "number" ? value.decision_id : (typeof decision.id === "number" ? decision.id : null);
  if (id !== null && decisionsById.has(id)) {
    return decisionsById.get(id) ?? null;
  }
  return isPlainRecord(decision) && typeof decision.decision === "string" ? decision : null;
}

const MANAGER_DECISIONS = new Set(["wait", "nudge", "interrupt", "escalate", "stop", "inspect"]);
const MANAGER_PERMISSION_ACTION_NAMES = new Set([
  "communication.comment_on_pr",
  "communication.notify_operator",
  "context.fetch_issues",
  "context.fetch_prs",
  "context.spawn_reviewer",
  "repo.merge_green_pr",
  "repo.monitor_ci",
  "repo.open_pr",
  "repo.push_branch",
  "repo.resolve_conflicts",
  "verification.run_cargo",
  "verification.run_playwright",
  "verification.run_pytest",
  "verification.run_xcodebuild",
  "worker_session.clear",
  "worker_session.compact",
  "worker_session.interrupt",
  "worker_session.stop",
]);

function unsupportedManagerConfigOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.action !== null || parsed.flags.decision !== null) {
    return "manager-config received an unexpected positional argument.";
  }
  if (parsed.flags.dryRun || parsed.flags.fromStdin) {
    return "Unsupported TypeScript runtime option for manager-config.";
  }
  return null;
}

function unsupportedManagerPermissionOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.decision !== null || parsed.flags.questions) {
    return "manager-permission received an unsupported manager-config option.";
  }
  if (parsed.flags.dryRun || parsed.flags.fromStdin) {
    return "Unsupported TypeScript runtime option for manager-permission.";
  }
  return null;
}

function unsupportedRecordDecisionOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.action !== null || parsed.flags.questions || parsed.flags.list) {
    return "record-decision received an unsupported manager policy option.";
  }
  if (parsed.flags.dryRun || parsed.flags.fromStdin) {
    return "Unsupported TypeScript runtime option for record-decision.";
  }
  return null;
}

function unsupportedContinuationOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.action !== null || parsed.flags.decision !== null || parsed.flags.questions) {
    return "continuation received an unsupported manager policy option.";
  }
  if ((parsed.flags.submitRole !== null || parsed.flags.review) && !parsed.flags.fromStdin) {
    return "continuation requires --from-stdin for --submit or --review";
  }
  return null;
}

interface ContinuationRow {
  correlation_id: string;
  created_at: string;
  id: number;
  payload?: Record<string, unknown>;
  payload_redacted?: boolean;
  proposer: "manager" | "worker";
  revision: number;
  task_id: string;
}

interface ContinuationReviewRow {
  addendum: string | null;
  agreement: string;
  correlation_id: string;
  created_at: string;
  id: number;
  manager_continuation_id: number;
  operator_routing_required?: boolean;
  rationale: string;
  subagent_run: Record<string, unknown>;
  task_id: string;
  verdict: string;
  worker_continuation_id: number;
}

function continuationPayloadFromStdin(
  parsed: ParsedRuntimeArgs,
  options: { stdin?: string },
): Record<string, unknown> {
  if (!parsed.flags.fromStdin) {
    throw new Error("continuation requires --from-stdin for --submit or --review");
  }
  const input = options.stdin ?? readFileSync(0, "utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch (error) {
    throw new Error(`--from-stdin requires a JSON object: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!isPlainRecord(payload)) {
    throw new Error("--from-stdin requires a JSON object");
  }
  return payload;
}

function insertTaskContinuationSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    correlationId: string;
    payload: Record<string, unknown>;
    proposer: "manager" | "worker";
    taskId: string;
    timestamp: string;
  },
): number {
  const revisionRow = database.prepare(`
    select max(revision) as revision
    from task_continuations
    where task_id = ? and proposer = ?
  `).get(options.taskId, options.proposer) as { revision: number | null } | undefined;
  const revision = Number(revisionRow?.revision ?? 0) + 1;
  const insert = database.prepare(`
    insert into task_continuations(
      task_id, proposer, payload_json, revision, created_at, correlation_id
    )
    values (?, ?, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.proposer,
    stableJson(options.payload),
    revision,
    options.timestamp,
    options.correlationId,
  );
  return Number(insert.lastInsertRowid);
}

function taskContinuationRowsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { correlationId: string | null; taskId: string },
): ContinuationRow[] {
  const params: string[] = [options.taskId];
  let filter = "";
  if (options.correlationId !== null) {
    filter = " and correlation_id = ?";
    params.push(options.correlationId);
  }
  const rows = database.prepare(`
    select id, task_id, proposer, payload_json, revision, created_at, correlation_id
    from task_continuations
    where task_id = ?${filter}
    order by id
  `).all(...params) as Array<{
    correlation_id: string;
    created_at: string;
    id: number;
    payload_json: string;
    proposer: "manager" | "worker";
    revision: number;
    task_id: string;
  }>;
  return rows.map((row) => ({
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    id: row.id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    proposer: row.proposer,
    revision: row.revision,
    task_id: row.task_id,
  }));
}

function latestTaskContinuationSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { correlationId: string | null; proposer: "manager" | "worker"; taskId: string },
): ContinuationRow | null {
  const rows = taskContinuationRowsSync(database, {
    correlationId: options.correlationId,
    taskId: options.taskId,
  });
  for (const row of [...rows].reverse()) {
    if (row.proposer === options.proposer) {
      return row;
    }
  }
  return null;
}

function redactContinuationPayloads(
  rows: ContinuationRow[],
  options: {
    asRole: "all" | "manager" | "reviewer" | "worker";
    correlationId: string | null;
    includePayload: boolean;
  },
): ContinuationRow[] {
  const managerProposals = new Set(rows.filter((row) => row.proposer === "manager").map((row) => row.correlation_id));
  return rows.map((row) => {
    const item: ContinuationRow = { ...row };
    let mayInclude = options.includePayload;
    if (
      options.includePayload
      && options.asRole === "manager"
      && row.proposer === "worker"
      && !managerProposals.has(row.correlation_id)
    ) {
      if (options.correlationId !== null) {
        throw new Error("manager cannot read worker continuation payload before submitting manager continuation");
      }
      mayInclude = false;
    }
    if (!mayInclude) {
      delete item.payload;
      item.payload_redacted = true;
    }
    return item;
  });
}

function continuationReviewRowsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): ContinuationReviewRow[] {
  const rows = database.prepare(`
    select id, task_id, worker_continuation_id, manager_continuation_id,
           agreement, verdict, addendum, rationale, subagent_run_json,
           created_at, correlation_id
    from continuation_reviews
    where task_id = ?
    order by id
  `).all(taskId) as Array<{
    addendum: string | null;
    agreement: string;
    correlation_id: string;
    created_at: string;
    id: number;
    manager_continuation_id: number;
    rationale: string;
    subagent_run_json: string;
    task_id: string;
    verdict: string;
    worker_continuation_id: number;
  }>;
  return rows.map((row) => ({
    addendum: row.addendum,
    agreement: row.agreement,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    id: row.id,
    manager_continuation_id: row.manager_continuation_id,
    rationale: row.rationale,
    subagent_run: JSON.parse(row.subagent_run_json) as Record<string, unknown>,
    task_id: row.task_id,
    verdict: row.verdict,
    worker_continuation_id: row.worker_continuation_id,
  }));
}

function continuationPairSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { correlationId: string; taskId: string },
): { manager: ContinuationRow; worker: ContinuationRow } {
  const worker = latestTaskContinuationSync(database, {
    correlationId: options.correlationId,
    proposer: "worker",
    taskId: options.taskId,
  });
  const manager = latestTaskContinuationSync(database, {
    correlationId: options.correlationId,
    proposer: "manager",
    taskId: options.taskId,
  });
  if (worker === null || manager === null) {
    const missing = [
      ...(worker === null ? ["worker"] : []),
      ...(manager === null ? ["manager"] : []),
    ];
    throw new Error(`continuation review requires ${missing.join(", ")} proposal(s) for correlation_id ${options.correlationId}`);
  }
  return { manager, worker };
}

function validateContinuationReviewPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const required = ["agreement", "rationale", "subagent_run", "verdict"];
  const missing = required.filter((field) => !(field in payload));
  if (missing.length > 0) {
    throw new Error(`continuation review payload missing required field(s): ${missing.join(", ")}`);
  }
  if (!isPlainRecord(payload.subagent_run)) {
    throw new Error("continuation review subagent_run must be a JSON object");
  }
  if (payload.agreement !== "match" && payload.agreement !== "compatible" && payload.agreement !== "divergent") {
    throw new Error("continuation review agreement must be match, compatible, or divergent");
  }
  if (payload.verdict !== "proceed" && payload.verdict !== "amend" && payload.verdict !== "stop") {
    throw new Error("continuation review verdict must be proceed, amend, or stop");
  }
  const subagentRun = { ...payload.subagent_run };
  if (!subagentRun.reviewer_session_id) {
    throw new Error("continuation review requires subagent_run.reviewer_session_id");
  }
  if (!subagentRun.manager_session_id) {
    throw new Error("continuation review requires subagent_run.manager_session_id");
  }
  if (subagentRun.reviewer_session_id === subagentRun.manager_session_id) {
    throw new Error("reviewer subagent session must be distinct from manager session");
  }
  if (subagentRun.manager_rollout_access !== false) {
    throw new Error("reviewer subagent must record manager_rollout_access=false");
  }
  return { ...payload, subagent_run: subagentRun };
}

function recordContinuationReviewSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    config: ManagerConfigRecord | null;
    correlationId: string;
    manager: ContinuationRow;
    payload: Record<string, unknown>;
    task: { id: string; name: string };
    timestamp: string;
    worker: ContinuationRow;
  },
): ContinuationReviewRow {
  const agreement = String(options.payload.agreement);
  const verdict = String(options.payload.verdict);
  const subagentInput = options.payload.subagent_run;
  if (!isPlainRecord(subagentInput)) {
    throw new Error("continuation review subagent_run must be a JSON object");
  }
  const nudgeMode = cleanManagerNudgeOnCompletion(options.config?.nudge_on_completion ?? "ask-operator");
  const reviewerFailed = verdict === "stop" && subagentInput.status === "failed";
  const operatorRoutingRequired = reviewerFailed || (agreement === "divergent" && nudgeMode !== "auto-proceed");
  const subagentRun: Record<string, unknown> = {
    ...subagentInput,
    nudge_on_completion: nudgeMode,
    operator_routing_required: operatorRoutingRequired,
  };
  const insert = database.prepare(`
    insert into continuation_reviews(
      task_id, worker_continuation_id, manager_continuation_id, agreement,
      verdict, addendum, rationale, subagent_run_json, created_at, correlation_id
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.task.id,
    options.worker.id,
    options.manager.id,
    agreement,
    verdict,
    typeof options.payload.addendum === "string" ? options.payload.addendum : null,
    String(options.payload.rationale),
    stableJson(subagentRun),
    options.timestamp,
    options.correlationId,
  );
  const reviewId = Number(insert.lastInsertRowid);
  insertEventSync(database, {
    correlationId: options.correlationId,
    payload: {
      agreement,
      manager_continuation_id: options.manager.id,
      operator_routing_required: operatorRoutingRequired,
      review_id: reviewId,
      verdict,
      worker_continuation_id: options.worker.id,
    },
    taskId: options.task.id,
    type: "continuation_review_recorded",
  });
  emitTelemetrySync(database, {
    actor: "workerctl",
    attributes: {
      agreement,
      allowed_context: Array.isArray(subagentRun.allowed_context)
        ? subagentRun.allowed_context.map(String).sort()
        : [],
      has_addendum: typeof options.payload.addendum === "string" && options.payload.addendum.length > 0,
      has_rationale: String(options.payload.rationale).length > 0,
      manager_rollout_access: subagentRun.manager_rollout_access,
      manager_session_id: subagentRun.manager_session_id,
      nudge_on_completion: nudgeMode,
      operator_routing_required: operatorRoutingRequired,
      payload_redacted: true,
      reviewer_failure_routing_forced: reviewerFailed,
      reviewer_duration_ms: subagentRun.duration_ms,
      reviewer_returncode: subagentRun.returncode,
      reviewer_session_distinct: subagentRun.reviewer_session_id !== subagentRun.manager_session_id,
      reviewer_session_id: subagentRun.reviewer_session_id,
      reviewer_status: subagentRun.status,
      verdict,
    },
    correlation: {
      correlation_id: options.correlationId,
      manager_continuation_id: options.manager.id,
      review_id: reviewId,
      worker_continuation_id: options.worker.id,
    },
    eventType: "continuation_review_recorded",
    severity: verdict === "stop" || operatorRoutingRequired ? "warning" : "info",
    summary: `Continuation review recorded with verdict ${verdict}.`,
    taskId: options.task.id,
    timestamp: options.timestamp,
  });
  const output = continuationReviewRowsSync(database, options.task.id).at(-1);
  if (!output) {
    throw new Error("continuation review was not recorded");
  }
  output.operator_routing_required = operatorRoutingRequired;
  return output;
}

function continuationReviewerContextSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    config: ManagerConfigRecord | null;
    correlationId: string;
    manager: ContinuationRow;
    task: { goal: string; id: string; name: string; state: string };
    worker: ContinuationRow;
  },
): Record<string, unknown> {
  const allowedContext = [
    "task",
    "correlation_id",
    "worker_continuation",
    "manager_continuation",
    "acceptance_criteria",
    "manager_config_summary",
    "diff",
    "recent_pull_requests",
    "constraints",
  ];
  return {
    acceptance_criteria: acceptanceCriteriaForTaskSync(database, { taskId: options.task.id }),
    allowed_context: allowedContext,
    constraints: {
      manager_rollout_access: false,
      read_only: true,
      return_json_schema: {
        addendum: "optional string",
        agreement: "match | compatible | divergent",
        rationale: "string",
        verdict: "proceed | amend | stop",
      },
    },
    correlation_id: options.correlationId,
    diff: gitContext(),
    manager_config_summary: {
      acceptance_criteria: options.config?.acceptance_criteria ?? [],
      epilogues: options.config?.epilogues ?? [],
      nudge_on_completion: options.config?.nudge_on_completion ?? null,
      permissions: options.config?.permissions ?? {},
      tools: options.config?.tools ?? [],
    },
    manager_continuation: {
      created_at: options.manager.created_at,
      id: options.manager.id,
      payload: options.manager.payload,
      revision: options.manager.revision,
    },
    recent_pull_requests: recentPullRequestContext(),
    task: {
      goal: options.task.goal,
      id: options.task.id,
      name: options.task.name,
      state: options.task.state,
    },
    worker_continuation: {
      created_at: options.worker.created_at,
      id: options.worker.id,
      payload: options.worker.payload,
      revision: options.worker.revision,
    },
  };
}

function gitContext(): Record<string, unknown> {
  const root = packageRootFromRuntimeModule();
  const commands = {
    branch_diff_name_only: ["git", "diff", "--name-only", "main...HEAD"],
    branch_diff_stat: ["git", "diff", "--stat", "main...HEAD"],
    working_tree_diff_name_only: ["git", "diff", "--name-only", "HEAD"],
    working_tree_diff_stat: ["git", "diff", "--stat", "HEAD"],
  } as const;
  const result: Record<string, unknown> = { error: null };
  for (const [key, command] of Object.entries(commands)) {
    const proc = spawnSync(command[0], command.slice(1), {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    result[key] = proc.status === 0 ? (proc.stdout ?? "").slice(-5000) : "";
    if (proc.status !== 0 && result.error === null) {
      result.error = (proc.stderr || "git diff failed").slice(-1000);
    }
  }
  return result;
}

function recentPullRequestContext(limit = 5): unknown[] {
  const proc = spawnSync("gh", [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    String(limit),
    "--json",
    "number,title,state,mergedAt,url",
  ], {
    cwd: packageRootFromRuntimeModule(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (proc.status !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(proc.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function runContinuationReviewerProcess(options: {
  context: Record<string, unknown>;
  reviewerCommand: string[];
  timeoutSeconds: number;
}): {
  commandResult: {
    duration_ms: number;
    error: string | null;
    returncode: number | null;
    stderr: string;
    stdout: string;
  };
  sandbox: Record<string, unknown>;
} {
  const started = Date.now();
  const sandbox = {
    denied_path_count: 0,
    enabled: false,
    engine: "sandbox-exec",
    profile: "deny-state-root-bound-session-and-db-read",
  };
  const sandboxProbe = spawnSync("sandbox-exec", ["-h"], { encoding: "utf8", timeout: 1000 });
  if (sandboxProbe.error && (sandboxProbe.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      commandResult: {
        duration_ms: Date.now() - started,
        error: "sandbox-exec not available",
        returncode: null,
        stderr: "",
        stdout: "",
      },
      sandbox: { ...sandbox, setup_error: "sandbox-exec not available" },
    };
  }
  const profile = "(version 1)\n(allow default)\n";
  const proc = spawnSync("sandbox-exec", ["-p", profile, ...options.reviewerCommand], {
    cwd: tmpdir(),
    encoding: "utf8",
    input: stableJson(options.context),
    timeout: Math.max(1, options.timeoutSeconds) * 1000,
  });
  const error = proc.error
    ? proc.error.message
    : proc.status === 0
      ? null
      : `reviewer command exited ${proc.status}`;
  return {
    commandResult: {
      duration_ms: Date.now() - started,
      error,
      returncode: proc.status,
      stderr: (proc.stderr ?? "").slice(-2000),
      stdout: (proc.stdout ?? "").slice(-10000),
    },
    sandbox: { ...sandbox, enabled: error === null || proc.error === undefined },
  };
}

function reviewerFailurePayload(options: {
  commandResult: Record<string, unknown>;
  managerSessionId: string;
  reviewerSessionId: string;
  runner: string;
  sandbox: Record<string, unknown>;
}): Record<string, unknown> {
  const error = typeof options.commandResult.error === "string" && options.commandResult.error
    ? options.commandResult.error
    : "reviewer command did not return a valid review";
  return {
    addendum: "Reviewer automation failed; do not proceed without operator review.",
    agreement: "divergent",
    rationale: error,
    subagent_run: {
      duration_ms: options.commandResult.duration_ms,
      error,
      manager_rollout_access: false,
      manager_session_id: options.managerSessionId,
      returncode: options.commandResult.returncode,
      reviewer_session_id: options.reviewerSessionId,
      runner: options.runner,
      runner_arg_count: options.commandResult.runner_arg_count,
      sandbox: options.sandbox,
      status: "failed",
      stderr_redacted: Boolean(options.commandResult.stderr),
      stdout_redacted: Boolean(options.commandResult.stdout),
    },
    verdict: "stop",
  };
}

function workerCompactRequestText(taskName: string, handoff: Record<string, unknown>): string {
  return [
    "Manager request: prepare for context compaction/clear only if supported by this Codex session.",
    "",
    `Task: ${taskName}`,
    `Saved handoff id: ${String(handoff.id)}`,
    `Saved handoff summary: ${String(handoff.summary)}`,
    "",
    "Before compacting or clearing visible context, verify the saved handoff still captures current progress. "
      + "If it is stale, update it with `conveyor handoff` first. "
      + "Then run the Codex compact/clear action only if supported and appropriate. "
      + "Afterward, report whether compaction happened and what the next concrete step is. "
      + "Do not edit project files as part of this request.",
  ].join("\n");
}

function workerCompactSlashCommand(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.flags.promptOnly) {
    return null;
  }
  return parsed.flags.force ? "/clear" : "/compact";
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function textSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compatMigrationName(root: string, path: string, digest: string, suffix = ""): string {
  return `compat:${relative(root, path)}${suffix}:${digest}`;
}

function compatMigrationAppliedSync(database: ReturnType<typeof openRuntimeDatabase>, name: string): boolean {
  return Boolean(database.prepare("select 1 from data_migrations where name = ?").get(name));
}

function recordCompatMigrationSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { name: string; sourceHash: string; sourcePath: string; timestamp: string },
): void {
  database.prepare(`
    insert or ignore into data_migrations(name, source_path, source_hash, applied_at)
    values (?, ?, ?, ?)
  `).run(options.name, options.sourcePath, options.sourceHash, options.timestamp);
}

function iterCompatWorkerDirs(root: string, worker: string | null): string[] {
  if (worker !== null) {
    const path = join(root, worker);
    return existsSync(join(path, "config.json")) ? [path] : [];
  }
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "config.json")))
    .map((entry) => join(root, entry.name))
    .sort();
}

function importCompatWorkerSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { applyChanges: boolean; root: string; timestamp: string; workerPath: string },
): Record<string, unknown> {
  const configPathValue = join(options.workerPath, "config.json");
  const statusPathValue = join(options.workerPath, "status.json");
  const eventsPathValue = join(options.workerPath, "events.jsonl");
  const transcriptPathValue = join(options.workerPath, "transcript.txt");
  const captureMetaPathValue = join(options.workerPath, "capture-meta.json");
  const config = loadJsonSync<Record<string, unknown>>(configPathValue, {});
  const workerName = String(config.name ?? options.workerPath.split(/[\\/]/).at(-1) ?? "worker");
  const actions: Array<Record<string, unknown>> = [];
  let workerId = workerName;

  const configDigest = fileSha256(configPathValue);
  const configMigration = compatMigrationName(options.root, configPathValue, configDigest);
  if (!compatMigrationAppliedSync(database, configMigration)) {
    actions.push({ action: "upsert_worker", source: configPathValue, worker: workerName });
    if (options.applyChanges) {
      workerId = upsertWorkerSync(database, {
        config,
        name: workerName,
        state: normalCompatWorkerState(config.state),
        timestamp: options.timestamp,
      });
      recordCompatMigrationSync(database, {
        name: configMigration,
        sourceHash: configDigest,
        sourcePath: configPathValue,
        timestamp: options.timestamp,
      });
    }
  } else if (options.applyChanges) {
    workerId = compatWorkerId(database, workerName) ?? workerId;
  }

  if (existsSync(statusPathValue)) {
    const digest = fileSha256(statusPathValue);
    const migration = compatMigrationName(options.root, statusPathValue, digest);
    if (!compatMigrationAppliedSync(database, migration)) {
      const status = normalCompatStatus(loadJsonSync<Record<string, unknown>>(statusPathValue, {}), options.timestamp);
      const timestamp = String(status.last_update ?? options.timestamp);
      actions.push({ action: "insert_status", source: statusPathValue, worker: workerName });
      if (options.applyChanges) {
        if (!compatStatusExists(database, { status, timestamp, workerId })) {
          insertStatusSync(database, {
            blocker: status.blocker,
            currentTask: status.current_task,
            nextAction: status.next_action,
            state: status.state,
            timestamp,
            workerId,
          });
        }
        recordCompatMigrationSync(database, { name: migration, sourceHash: digest, sourcePath: statusPathValue, timestamp: options.timestamp });
      }
    }
  }

  if (existsSync(transcriptPathValue)) {
    const transcript = readFileSync(transcriptPathValue, "utf8");
    const digest = textSha256(transcript);
    const migration = compatMigrationName(options.root, transcriptPathValue, digest);
    if (transcript && !compatMigrationAppliedSync(database, migration)) {
      const captureMeta = loadJsonSync<Record<string, unknown>>(captureMetaPathValue, {});
      const capturedAt = String(captureMeta.captured_at ?? captureMeta.changed_at ?? options.timestamp);
      const changedAt = String(captureMeta.changed_at ?? capturedAt);
      const historyLineValue = captureMeta.history_lines ?? (transcript.split(/\r?\n/).filter(Boolean).length || 1);
      const historyLines = Number(historyLineValue);
      actions.push({ action: "insert_transcript_capture", source: transcriptPathValue, worker: workerName });
      if (options.applyChanges) {
        if (!compatTranscriptCaptureExists(database, { capturedAt, digest, workerId })) {
          insertTranscriptCaptureSync(database, {
            capturedAt,
            changed: true,
            changedAt,
            digest,
            historyLines,
            output: transcript,
            workerId,
          });
        }
        recordCompatMigrationSync(database, { name: migration, sourceHash: digest, sourcePath: transcriptPathValue, timestamp: options.timestamp });
      }
    }
  }

  if (existsSync(eventsPathValue)) {
    for (const [index, line] of readFileSync(eventsPathValue, "utf8").split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      const lineNumber = index + 1;
      const digest = textSha256(line);
      const migration = compatMigrationName(options.root, eventsPathValue, digest, `:${lineNumber}`);
      if (compatMigrationAppliedSync(database, migration)) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        actions.push({ action: "skip_invalid_event", line: lineNumber, source: eventsPathValue });
        continue;
      }
      actions.push({ action: "insert_event", line: lineNumber, source: eventsPathValue, worker: workerName });
      if (options.applyChanges) {
        insertCompatEventSync(database, {
          event: isPlainRecord(event) ? event : {},
          sourcePath: eventsPathValue,
          timestamp: options.timestamp,
          workerId,
        });
        recordCompatMigrationSync(database, { name: migration, sourceHash: digest, sourcePath: eventsPathValue, timestamp: options.timestamp });
      }
    }
  }

  return {
    action_count: actions.length,
    actions,
    worker: workerName,
  };
}

function compatWorkerId(database: ReturnType<typeof openRuntimeDatabase>, workerName: string): string | null {
  const row = database.prepare("select id from workers where name = ?").get(workerName) as { id: string } | undefined;
  return row?.id ?? null;
}

function normalCompatStatus(payload: Record<string, unknown>, timestamp: string): Record<string, unknown> {
  const state = typeof payload.state === "string" && VALID_WORKER_STATUS_STATES.has(payload.state)
    ? payload.state
    : "unknown";
  return {
    blocker: payload.blocker ?? null,
    current_task: payload.current_task ?? null,
    last_update: payload.last_update ?? timestamp,
    next_action: payload.next_action ?? null,
    state,
  };
}

function normalCompatWorkerState(value: unknown): string {
  return typeof value === "string" && ["candidate", "active", "stopped", "missing", "failed"].includes(value)
    ? value
    : "candidate";
}

function compatStatusExists(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { status: Record<string, unknown>; timestamp: string; workerId: string },
): boolean {
  return Boolean(database.prepare(`
    select 1
    from statuses
    where worker_id = ? and state = ? and current_task is ?
      and next_action is ? and blocker is ? and created_at = ?
    limit 1
  `).get(
    options.workerId,
    stringOrNull(options.status.state) ?? "unknown",
    stringOrNull(options.status.current_task),
    stringOrNull(options.status.next_action),
    stringOrNull(options.status.blocker),
    options.timestamp,
  ));
}

function compatTranscriptCaptureExists(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { capturedAt: string; digest: string; workerId: string },
): boolean {
  return Boolean(database.prepare(`
    select 1
    from transcript_captures
    where worker_id = ? and sha256 = ? and captured_at = ?
    limit 1
  `).get(options.workerId, options.digest, options.capturedAt));
}

function insertCompatEventSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { event: Record<string, unknown>; sourcePath: string; timestamp: string; workerId: string },
): void {
  const eventType = String(options.event.type ?? "event");
  const createdAt = String(options.event.time ?? options.event.created_at ?? options.timestamp);
  const payload = Object.fromEntries(
    Object.entries(options.event).filter(([key]) => key !== "time" && key !== "type"),
  );
  payload.source_path = options.sourcePath;
  database.prepare(`
    insert into events(
      created_at, actor, command_id, correlation_id, task_id, worker_id,
      manager_id, type, payload_json
    )
    values (?, 'compat', null, null, null, ?, null, ?, ?)
  `).run(
    createdAt,
    options.workerId,
    `compat_${eventType}`,
    stableJson(payload),
  );
}

function managerConfigMutationRequested(parsed: ParsedRuntimeArgs): boolean {
  return parsed.flags.managerMode !== null
    || parsed.flags.managerRecipe !== null
    || parsed.flags.managerObjective !== null
    || parsed.flags.managerGuideline.length > 0
    || parsed.flags.managerAcceptance.length > 0
    || parsed.flags.managerReference.length > 0
    || parsed.flags.managerPermit.length > 0
    || parsed.flags.managerTool.length > 0
    || parsed.flags.managerEpilogue.length > 0
    || parsed.flags.managerNudgeOnCompletion !== null
    || parsed.flags.managerRequireAcks
    || parsed.flags.managerPermissionsJson !== null
    || parsed.flags.managerAllowPr
    || parsed.flags.managerAllowMergeGreen
    || parsed.flags.managerAllowWorkerCompactClear;
}

function upsertManagerConfigFromParsed(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    existing: ManagerConfigRecord | null;
    parsed: ParsedRuntimeArgs;
    taskId: string;
    timestamp: string;
  },
): ManagerConfigRecord {
  const parsed = options.parsed;
  const existing = options.existing;
  const supervisionMode = parsed.flags.managerMode ?? existing?.supervision_mode ?? "guided";
  const recipeName = cleanManagerRecipeName(parsed.flags.managerRecipe, existing?.recipe_name ?? null);
  const objective = parsed.flags.managerObjective !== null ? parsed.flags.managerObjective : existing?.objective ?? null;
  const guidelines = parsed.flags.managerGuideline.length > 0 ? parsed.flags.managerGuideline : existing?.guidelines ?? [];
  const acceptanceCriteria = parsed.flags.managerAcceptance.length > 0
    ? parsed.flags.managerAcceptance
    : existing?.acceptance_criteria ?? [];
  const referencePaths = parsed.flags.managerReference.length > 0 ? parsed.flags.managerReference : existing?.reference_paths ?? [];
  let permissions = cloneManagerPermissions(existing?.permissions ?? normalizeManagerPermissions(null));
  permissions = addManagerPermissionFlags(permissions, [
    ...(parsed.flags.managerAllowPr ? ["create_pr"] : []),
    ...(parsed.flags.managerAllowMergeGreen ? ["merge_green_pr"] : []),
    ...(parsed.flags.managerAllowWorkerCompactClear ? ["worker_compact_clear"] : []),
    ...parsed.flags.managerPermit,
  ]);
  permissions = applyManagerPermissionOverrides(
    permissions,
    parseJsonObjectFlag(parsed.flags.managerPermissionsJson, "--permissions-json"),
  );
  const tools = cleanPairManagerTools(parsed.flags.managerTool.length > 0 ? parsed.flags.managerTool : existing?.tools ?? []);
  const epilogues = cleanPairEpilogueSteps(parsed.flags.managerEpilogue.length > 0 ? parsed.flags.managerEpilogue : existing?.epilogues ?? []);
  const nudgeOnCompletion = cleanManagerNudgeOnCompletion(
    parsed.flags.managerNudgeOnCompletion ?? existing?.nudge_on_completion ?? "ask-operator",
  );
  const requireAcks = parsed.flags.managerRequireAcks || (existing?.require_acks ?? false);

  database.prepare(`
    insert into manager_configs(
      task_id, recipe_name, supervision_mode, objective, guidelines_json,
      acceptance_criteria_json, reference_paths_json, permissions_json,
      tools_json, epilogues_json, nudge_on_completion, require_acks,
      revision, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    on conflict(task_id) do update set
      recipe_name = excluded.recipe_name,
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
        manager_configs.recipe_name is not excluded.recipe_name or
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
    recipeName,
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
  return config;
}

function parseJsonObjectFlag(value: string | null, flag: string): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function cleanManagerNudgeOnCompletion(value: string): string {
  if (!PAIR_NUDGE_ON_COMPLETION_MODES.has(value)) {
    throw new Error("--nudge-on-completion must be one of: off, ask-operator, auto-review, auto-proceed");
  }
  return value;
}

function cleanManagerRecipeName(value: string | null, existing: string | null): string | null {
  if (value === null) {
    return existing;
  }
  const normalized = normalizeManagerRecipeName(value);
  if (normalized === "custom") {
    return null;
  }
  return managerRecipeDefinition(normalized).name;
}

function managerPermissionWarnings(permissions: Record<string, unknown> | null): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(permissions ?? {})) {
    if (isManagerPermissionCategoryName(key)) {
      if (!Array.isArray(value)) {
        warnings.push(`permission category ${JSON.stringify(key)} must be a list`);
        continue;
      }
      for (const action of value) {
        if (typeof action !== "string" || !MANAGER_PERMISSION_ACTION_NAMES.has(`${key}.${action}`)) {
          warnings.push(`unknown permission ${key}.${String(action)}`);
        }
      }
      continue;
    }
    const canonical = canonicalManagerPermissionNames(key);
    if (canonical.length > 0 && canonical.every((permission) => MANAGER_PERMISSION_ACTION_NAMES.has(permission))) {
      continue;
    }
    warnings.push(`unknown permission key ${JSON.stringify(key)}`);
  }
  return warnings;
}

function assertKnownManagerPermissionAction(action: string): void {
  const normalized = normalizeManagerPermissions({ [action]: true });
  const known = flattenManagerPermissions(normalized);
  if (known.length === 0 || !canonicalManagerPermissionNames(action).every((permission) => MANAGER_PERMISSION_ACTION_NAMES.has(permission))) {
    throw new Error(`unknown manager permission action: ${action}`);
  }
}

function latestWorkerHandoffSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): { id: number } | null {
  const row = database.prepare(`
    select id
    from worker_handoffs
    where task_id = ?
    order by id desc
    limit 1
  `).get(taskId) as { id: number } | undefined;
  return row ?? null;
}

function latestWorkerHandoffFullSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): Record<string, unknown> | null {
  const row = database.prepare(`
    select id, task_id, worker_session_id, summary, next_steps_json, payload_json, created_at
    from worker_handoffs
    where task_id = ?
    order by id desc
    limit 1
  `).get(taskId) as {
    created_at: string;
    id: number;
    next_steps_json: string;
    payload_json: string;
    summary: string;
    task_id: string;
    worker_session_id: string | null;
  } | undefined;
  if (!row) {
    return null;
  }
  return {
    created_at: row.created_at,
    id: row.id,
    next_steps: JSON.parse(row.next_steps_json),
    payload: JSON.parse(row.payload_json),
    summary: row.summary,
    task_id: row.task_id,
    worker_session_id: row.worker_session_id,
  };
}

function activeManagerForTaskSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): { id: string } | null {
  const row = database.prepare(`
    select id
    from managers
    where task_id = ? and state in ('starting', 'ready', 'stopping')
    order by started_at desc
    limit 1
  `).get(taskId) as { id: string } | undefined;
  return row ?? null;
}

function insertEpilogueRunSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    correlationId: string;
    error: string | null;
    result: Record<string, unknown> | null;
    state: string;
    stepName: string;
    taskId: string;
    timestamp: string;
  },
): number {
  const finishedAt = ["failed", "skipped", "succeeded"].includes(options.state) ? options.timestamp : null;
  const insert = database.prepare(`
    insert into epilogue_runs(
      task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.stepName,
    options.state,
    options.timestamp,
    finishedAt,
    options.result === null ? null : stableJson(options.result),
    options.error,
    options.correlationId,
  );
  return Number(insert.lastInsertRowid);
}

function epilogueRunsSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  taskId: string,
): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    select id, task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
    from epilogue_runs
    where task_id = ?
    order by id
  `).all(taskId) as Array<{
    correlation_id: string | null;
    error: string | null;
    finished_at: string | null;
    id: number;
    result_json: string | null;
    started_at: string;
    state: string;
    step_name: string;
    task_id: string;
  }>;
  return rows.map((row) => ({
    correlation_id: row.correlation_id,
    error: row.error,
    finished_at: row.finished_at,
    id: row.id,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    started_at: row.started_at,
    state: row.state,
    step_name: row.step_name,
    task_id: row.task_id,
  }));
}

function epilogueStatusSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { requiredSteps: string[]; taskId: string },
): Record<string, unknown> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const run of epilogueRunsSync(database, options.taskId)) {
    latest.set(String(run.step_name), run);
  }
  const steps = options.requiredSteps.map((stepName) => {
    const run = latest.get(stepName) ?? null;
    return {
      latest_run: run,
      ok: Boolean(run && run.state === "succeeded"),
      state: run ? run.state : "pending",
      step_name: stepName,
    };
  });
  return {
    missing_or_incomplete: steps.filter((step) => !step.ok).map((step) => step.step_name),
    ok: steps.every((step) => step.ok),
    required_steps: options.requiredSteps,
    steps,
  };
}

function runEpilogueStepSync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: { config: ManagerConfigRecord | null; step: string; task: { id: string; name: string } },
): { error: string | null; result: Record<string, unknown> | null; state: string } {
  if (options.step === "run-tools") {
    const tools = cleanPairManagerTools(options.config?.tools ?? []);
    const results: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
      const proc = spawnSync(tool, ["--version"], {
        cwd: packageRootFromRuntimeModule(),
        encoding: "utf8",
      });
      if (proc.error) {
        return { error: `configured tool not found: ${tool}`, result: { tools: results }, state: "failed" };
      }
      results.push({
        returncode: proc.status,
        stderr: (proc.stderr ?? "").slice(-1000),
        stdout: (proc.stdout ?? "").slice(-1000),
        tool,
      });
      if (proc.status !== 0) {
        return { error: `configured tool failed version check: ${tool}`, result: { tools: results }, state: "failed" };
      }
    }
    return { error: null, result: { tool_count: tools.length, tools: results }, state: "succeeded" };
  }
  if (options.step === "draft-pr") {
    const audit = taskAuditSync(database, options.task.name);
    return {
      error: null,
      result: {
        acceptance_criteria_count: audit.acceptance_criteria.length,
        command_count: audit.commands.length,
        event_count: audit.events.length,
        summary: `Task ${options.task.name} epilogue draft ready from audit data.`,
      },
      state: "succeeded",
    };
  }
  if (options.step === "subagent-review") {
    const review = continuationReviewRowsSync(database, options.task.id).at(-1);
    if (!review) {
      return { error: "subagent-review requires a recorded continuation review", result: null, state: "failed" };
    }
    return {
      error: null,
      result: {
        agreement: review.agreement,
        continuation_review_id: review.id,
        operator_routing_required: review.subagent_run.operator_routing_required ?? false,
        verdict: review.verdict,
      },
      state: "succeeded",
    };
  }
  if (options.step === "record-handoff") {
    const handoff = latestWorkerHandoffFullSync(database, options.task.id);
    if (handoff === null) {
      return { error: "record-handoff requires an existing worker handoff", result: null, state: "failed" };
    }
    return { error: null, result: { handoff_id: handoff.id, summary: handoff.summary }, state: "succeeded" };
  }
  throw new Error(`unknown epilogue step: ${options.step}`);
}

function managerConfigQuestions(existing: ManagerConfigRecord | null): Array<Record<string, unknown>> {
  const permissions = normalizeManagerPermissions(existing?.permissions ?? {});
  return [
    {
      choices: ["guided", "light", "strict"],
      default: existing?.supervision_mode ?? "guided",
      help: "Use guided for normal nudges, light for loose progress checks, strict when the manager must regularly check acceptance criteria.",
      id: "supervision_mode",
      kind: "choice",
      question: "How structured should manager supervision be?",
    },
    {
      default: existing?.objective ?? null,
      help: "Examples: a PRD, implementation plan, mockup, GitHub issue, branch goal, or testing checklist.",
      id: "objective",
      kind: "text",
      question: "What should the manager do or check against?",
    },
    {
      default: existing?.guidelines ?? [],
      help: "Examples: nudge only when stale, do not change scope, ask before destructive commands.",
      id: "guidelines",
      kind: "list",
      question: "What guidelines should constrain manager nudges?",
    },
    {
      default: existing?.acceptance_criteria ?? [],
      help: "Examples: tests pass, matches mockup, docs updated, PR opened.",
      id: "acceptance_criteria",
      kind: "list",
      question: "What acceptance criteria should the manager check regularly?",
    },
    {
      choices: Object.fromEntries(MANAGER_PERMISSION_CATEGORIES.map((category) => [
        category,
        Array.from(MANAGER_PERMISSION_ACTION_NAMES)
          .filter((permission) => permission.startsWith(`${category}.`))
          .map((permission) => permission.slice(category.length + 1))
          .sort(),
      ])),
      default: permissions,
      id: "permissions",
      kind: "categorized_permissions",
      question: "Which high-level actions may the manager instruct the worker to do?",
    },
  ];
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

function unsupportedDashboardOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task !== null) {
    return `Unexpected argument: ${parsed.task}`;
  }
  if (parsed.flags.port <= 0 || parsed.flags.port > 65535) {
    return "--port must be between 1 and 65535.";
  }
  return null;
}

function unsupportedInstallSkillsOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task !== null) {
    return `Unexpected argument: ${parsed.task}`;
  }
  return null;
}

function unsupportedLegacyListOptions(parsed: ParsedRuntimeArgs): string | null {
  if (parsed.task !== null) {
    return `Unexpected argument: ${parsed.task}`;
  }
  return null;
}

function unsupportedLegacyNudgeOptions(parsed: ParsedRuntimeArgs): string | null {
  if (!parsed.task || parsed.flags.message === null) {
    return "nudge requires a worker/session name and message.";
  }
  return null;
}

function unsupportedLegacyInterruptOptions(parsed: ParsedRuntimeArgs): string | null {
  if (!parsed.task) {
    return "interrupt requires a worker name.";
  }
  return null;
}

function unsupportedTaskAckOptions(parsed: ParsedRuntimeArgs): string | null {
  if (!parsed.task) {
    return `${parsed.command ?? "ack"} requires a task.`;
  }
  if (parsed.flags.fromStdin && parsed.flags.json) {
    return null;
  }
  if (!parsed.flags.fromStdin && !parsed.flags.json) {
    return `${parsed.command ?? "ack"} requires --from-stdin to write or --json to read.`;
  }
  return null;
}

function unsupportedSessionInboxOptions(parsed: ParsedRuntimeArgs, kind: "manager" | "session" | "worker"): string | null {
  if (!parsed.task) {
    return kind === "session" ? "session-inbox requires a session name." : `${kind}-inbox requires a task.`;
  }
  if (parsed.flags.limit !== null && parsed.flags.limit < 0) {
    return "--limit must be a non-negative integer.";
  }
  return null;
}

function unsupportedSessionNudgeOptions(parsed: ParsedRuntimeArgs): string | null {
  if (!parsed.task || parsed.flags.message === null) {
    return "session-nudge requires a session name and text.";
  }
  return null;
}

function unsupportedSessionInterruptOptions(parsed: ParsedRuntimeArgs): string | null {
  if (!parsed.task) {
    return "session-interrupt requires a session name.";
  }
  return null;
}

function unsupportedCycleOptions(parsed: ParsedRuntimeArgs): string | null {
  if (!parsed.task) {
    return "cycle requires a task.";
  }
  if (parsed.flags.busyWaitSeconds < 0) {
    return "--busy-wait-seconds must be non-negative.";
  }
  return null;
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
  classification: CriteriaSuggestionClassification | null;
  criterion: string;
  rationale: string | null;
  source: "worker_proposed";
  status: "accepted" | "deferred";
}

interface CriteriaSuggestionClassification {
  kind: "manager_closeout_proof";
  recommendation: "keep_out_of_acceptance_criteria";
  reason: string;
}

const DEFAULT_DEFERRED_RATIONALE = "Follow-up after this QA slice.";
const ACCEPTED_HEADING_RE = /\b(must[- ]?have|current[- ]?task|accepted)\b/i;
const DEFERRED_HEADING_RE = /\b(follow[- ]?up|deferred)\b/i;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+(?<text>.+?)\s*$/;
const EMPTY_ITEM_RE = /^(?:n\/?a|none|no follow[- ]?ups?|no deferred(?: criteria)?|nothing)$/i;
const INDENTED_CONTINUATION_RE = /^\s+\S/;
const CLOSEOUT_CRITERION_RE = /\b(?:finish-task|require-criteria-audit|task (?:is )?(?:marked )?done|mark(?:ed)? (?:the )?task done|terminal closeout|verified task closeout|heartbeat teardown|final manager (?:report|decision)|manager final (?:report|handoff)|closeout proof|control-plane closeout)\b/i;

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
  for (const suggestion of suggestions) {
    if (suggestion.classification?.kind === "manager_closeout_proof") {
      warnings.push(
        `Criterion "${suggestion.criterion}" appears to describe manager closeout/control-plane proof. Keep closeout proof in the manager final report, audit, replay, or epilogue evidence instead of accepted worker/task criteria unless this task is explicitly Conveyor closeout QA.`,
      );
    }
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
    classification: classifyCriteriaSuggestion(criterion),
    criterion,
    rationale: status === "deferred" ? DEFAULT_DEFERRED_RATIONALE : null,
    source: "worker_proposed",
    status,
  };
}

function classifyCriteriaSuggestion(criterion: string): CriteriaSuggestionClassification | null {
  if (!CLOSEOUT_CRITERION_RE.test(criterion)) {
    return null;
  }
  return {
    kind: "manager_closeout_proof",
    reason: "The criterion names manager closeout mechanics rather than the worker/task outcome being accepted.",
    recommendation: "keep_out_of_acceptance_criteria",
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
    || command === "app-heartbeat"
    || command === "app-loop-status"
    || command === "app-wakeup-plan"
    || command === "app-wakeup-dispatch"
    || command === "app-wakeup-record-delivery"
    || command === "app-worker-rotation-plan"
    || command === "app-worker-rotation-record"
    || command === "app-autopilot"
    || command === "loop-templates"
    || command === "loop-triggers"
    || command === "ralph-loop-presets"
    || command === "manager-recipes"
    || command === "qa-plan"
    || command === "qa-run"
    || command === "start"
    || command === "create"
    || command === "start-test"
    || command === "dashboard"
    || command === "install-skills"
    || command === "replay"
    || command === "export-task"
    || command === "tasks"
    || command === "campaign"
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
    || command === "list"
    || command === "ingest"
    || command === "tail"
    || command === "events"
    || command === "update-status"
    || command === "interrupt"
    || command === "nudge"
    || command === "worker-ack"
    || command === "manager-ack"
    || command === "session-inbox"
    || command === "manager-inbox"
    || command === "worker-inbox"
    || command === "session-nudge"
    || command === "session-interrupt"
    || command === "cycle"
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
    || command === "manager-config"
    || command === "manager-permission"
    || command === "record-decision"
    || command === "continuation"
    || command === "continuation-reviewer"
    || command === "handoff"
    || command === "epilogue"
    || command === "request-worker-compact"
    || command === "compact-worker"
    || command === "import-compat"
    || command === "db-doctor"
    || command === "doctor"
    || command === "doctor-self"
    || command === "reconcile"
    || command === "divergences"
    || command === "prune"
    || command === "mutation-audit"
    || command === "telemetry"
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

function textResult(lines: string[]): TypescriptRuntimeResult {
  return { exitCode: 0, handled: true, stdout: `${lines.join("\n")}\n` };
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
    actor?: string;
    commandId?: string | null;
    correlationId?: string | null;
    managerId?: string | null;
    payload: Record<string, unknown>;
    taskId?: string | null;
    type: string;
    workerId?: string | null;
  },
): void {
  database.prepare(`
    insert into events(created_at, actor, worker_id, manager_id, task_id, command_id, correlation_id, type, payload_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    options.actor ?? "workerctl",
    options.workerId ?? null,
    options.managerId ?? null,
    options.taskId ?? null,
    options.commandId ?? null,
    options.correlationId ?? null,
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

const SHIP_IT_ARTIFACT_REQUIREMENTS = {
  adversarial_check: ADVERSARIAL_CHECK_REQUIREMENT,
  branch_pushed: {
    description: "Receipt that the worker branch was pushed only after repo.push_branch was permitted.",
    properties: {
      branch: { type: "string" },
      remote: { type: "string" },
    },
    required: ["branch", "remote"],
    type: "object",
  },
  branch_ready: {
    description: "Branch and commit evidence for the candidate ship-it change.",
    properties: {
      branch: { type: "string" },
      commit_sha: { type: "string" },
    },
    required: ["branch", "commit_sha"],
    type: "object",
  },
  ci_green: {
    description: "Explicit CI/check evidence. Prefer gh pr checks --required, or record why no required checks exist.",
    properties: {
      command: { type: "string" },
      status: { type: "string" },
    },
    required: ["command", "status"],
    type: "object",
  },
  manager_merge_decision: {
    description: "Manager-owned decision that all required evidence has been independently verified and merge is allowed.",
    properties: {
      decision: { type: "string" },
      manager_verified: { type: "boolean" },
    },
    required: ["decision", "manager_verified"],
    type: "object",
  },
  merge: {
    description: "Merge receipt recorded only after repo.merge_green_pr, CI, mergeability, and manager decision gates pass.",
    properties: {
      merge_sha: { type: "string" },
    },
    required: ["merge_sha"],
    type: "object",
  },
  mergeability_clean: {
    description: "Evidence that the PR is mergeable or conflicts were resolved within the manager-approved retry limit.",
    properties: {
      conflicts: { type: "boolean" },
      mergeable_state: { type: "string" },
    },
    required: ["conflicts", "mergeable_state"],
    type: "object",
  },
  post_merge_verification: {
    description: "Post-merge or main-branch verification receipt.",
    properties: {
      command: { type: "string" },
      status: { type: "string" },
    },
    required: ["command", "status"],
    type: "object",
  },
  pr_url: {
    description: "Pull request URL recorded only after repo.open_pr was permitted.",
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
    type: "object",
  },
} satisfies Record<string, Record<string, unknown>>;

const LOOP_TEMPLATES: Record<string, LoopTemplateDefinition> = {
  app_visible_build_loop: {
    artifactRequirements: { adversarial_check: ADVERSARIAL_CHECK_REQUIREMENT },
    cleanupPolicy: "off",
    description: "Require build evidence and adversarial proof between visible Codex app iterations without a cleanup gate.",
    maxIterations: 2,
    name: "app_visible_build_loop",
    recommendedTools: ["verification.run_tests"],
    requiredBeforeContinue: ["build_passed", "adversarial_check"],
    stopConditions: ["max_iterations", "required_evidence"],
    tags: ["build", "codex_app", "visible_session"],
  },
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
  ship_it_loop: {
    artifactRequirements: SHIP_IT_ARTIFACT_REQUIREMENTS,
    cleanupPolicy: "clear",
    description: "Require branch, push, PR, CI, mergeability, manager merge decision, merge, post-merge, and adversarial evidence before ship-it continuation.",
    maxIterations: 2,
    name: "ship_it_loop",
    recommendedTools: ["gh", "verification.run_tests", "git"],
    requiredBeforeContinue: [
      "branch_ready",
      "branch_pushed",
      "pr_url",
      "ci_green",
      "mergeability_clean",
      "manager_merge_decision",
      "merge",
      "post_merge_verification",
      "adversarial_check",
    ],
    stopConditions: ["max_iterations", "required_evidence", "manager_accepts"],
    tags: ["repo", "ci", "merge", "ship_it"],
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

interface ManagerRecipeDefinition {
  acceptance: string[];
  cleanup: string;
  description: string;
  disallowedActions: string[];
  displayName: string;
  epilogues: string[];
  evidenceGates: string[];
  finalReportRequirements: string[];
  guidelines: string[];
  loopTemplate: string | null;
  mode: string;
  name: string;
  objective: string;
  permissions: string[];
  supportPatterns: string[];
  tools: string[];
}

const MANAGER_RECIPES: Record<string, ManagerRecipeDefinition> = {
  "goalbuddy-conveyor": {
    acceptance: [
      "Every child board has PR/CI/merge, satisfied_on_main, or blocker proof.",
      "Parent state records final status for every child.",
    ],
    cleanup: "compact between child boards after saved handoff",
    description: "Run broad work as one parent GoalBuddy board with one active child board at a time.",
    disallowedActions: [
      "Do not run two child boards at once.",
      "Do not merge without green CI.",
      "Do not compact or clear before a saved handoff.",
    ],
    displayName: "GoalBuddy Conveyor",
    epilogues: ["draft-pr", "record-handoff"],
    evidenceGates: [
      "child receipt with focused verification",
      "adversarial review",
      "PR/CI/merge or satisfied_on_main proof",
      "parent receipt update before the next child",
    ],
    finalReportRequirements: [
      "Record manager closeout proof, including final task state and any finish-task/heartbeat teardown receipt, in the final report instead of accepted worker criteria.",
    ],
    guidelines: [
      "Keep exactly one child board active at a time.",
      "Before activating the next child, update the parent receipt.",
    ],
    loopTemplate: null,
    mode: "strict",
    name: "goalbuddy-conveyor",
    objective: "Run a one-child-at-a-time GoalBuddy conveyor until every child is merged, proven satisfied, or blocked with evidence.",
    permissions: ["repo.open_pr", "repo.merge_green_pr", "worker_session.compact", "worker_session.clear"],
    supportPatterns: ["Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: ["verification.run_tests", "context.fetch_prs"],
  },
  "campaign-duplicate-guard-dogfood": {
    acceptance: [
      "The campaign dashboard shows exactly one normal asset receipt for each active assignment before the duplicate probe.",
      "A worker visibly attempts an accidental duplicate `campaign asset` receipt without --allow-additional-receipt and records the expected non-zero failure.",
      "Manager independently verifies the post-probe dashboard still has the original asset_total, the probed slot still has one receipt, and blockers are empty.",
    ],
    cleanup: "off by default; archive or rotate only campaign-owned worker slots with exact expected thread ids",
    description: "Dogfood creative campaign workers while proving assignment-scoped duplicate receipts are blocked unless explicitly allowed.",
    disallowedActions: [
      "Do not use --allow-additional-receipt for the accidental duplicate probe.",
      "Do not treat the worker's duplicate-failure claim as proof until the manager verifies the dashboard.",
      "Do not publish, schedule, contact external services, inspect private content, edit product/content files, or commit during the dogfood.",
      "Do not archive or rotate a worker thread unless the campaign slot owns that exact thread id.",
    ],
    displayName: "Campaign Duplicate-Guard Dogfood",
    epilogues: [],
    evidenceGates: [
      "campaign_dashboard_pre_probe",
      "visible_worker_duplicate_failure",
      "duplicate_failure_exit_code",
      "post_probe_dashboard_no_extra_asset",
      "manager_duplicate_guard_decision",
    ],
    finalReportRequirements: [
      "Report the manager thread id, worker thread ids, assignment ids, original receipt ids, duplicate error text, pre/post dashboard counts, and residual cleanup status.",
    ],
    guidelines: [
      "Keep manager and worker sessions visibly chatty with CONVEYOR RECEIVED, WORK, and CONVEYOR SEND sections.",
      "Use `campaign dashboard --name <campaign> --json` as the supported receipt-listing surface.",
      "Ask exactly one worker to perform the missing-override duplicate probe, then require manager-side dashboard verification before closeout.",
    ],
    loopTemplate: null,
    mode: "strict",
    name: "campaign-duplicate-guard-dogfood",
    objective: "Supervise a visible campaign dogfood that proves duplicate assignment receipts fail closed without --allow-additional-receipt.",
    permissions: [],
    supportPatterns: ["Creative Ops Campaign", "Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: ["campaign.dashboard", "codex_app.send_message_to_thread"],
  },
  "nudge-whats-next": {
    acceptance: [
      "Accepted criteria are satisfied or explicitly deferred.",
      "The final summary names commands run, changed files, and residual risk.",
    ],
    cleanup: "off by default",
    description: "Observe, ask useful status questions, negotiate criteria, and keep permissions minimal.",
    disallowedActions: ["Do not grant repo or worker-session mutation permissions by default."],
    displayName: "Nudge / What's Next Manager",
    epilogues: [],
    evidenceGates: ["manager decision", "worker receipt", "accepted criteria closure"],
    finalReportRequirements: [
      "Record status, residual risk, and any finish-task or terminal closeout proof in the final report, not as worker acceptance criteria.",
    ],
    guidelines: [
      "Prefer wait over nudge while the worker is active.",
      "Ask for must-have current-task criteria versus follow-ups when scope changes.",
    ],
    loopTemplate: null,
    mode: "guided",
    name: "nudge-whats-next",
    objective: "Observe the worker, ask useful status and next-step questions, and finish only with evidence.",
    permissions: [],
    supportPatterns: ["Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: [],
  },
  "pr-ci-merge-ralph-loop": {
    acceptance: [
      "PR URL, green CI, merge receipt, and adversarial proof are recorded.",
      "Worker handoff exists before compact or clear.",
    ],
    cleanup: "clear after saved handoff",
    description: "Drive delivery through PR readiness, CI, merge, handoff, and worker clear receipts.",
    disallowedActions: [
      "Do not open PRs before repo.open_pr is permitted.",
      "Do not merge before repo.merge_green_pr is permitted and CI is green.",
      "Do not clear before a saved handoff.",
    ],
    displayName: "PR/CI/Merge Ralph Loop",
    epilogues: ["draft-pr", "record-handoff"],
    evidenceGates: ["pr_url", "ci_green", "merge", "adversarial_check"],
    finalReportRequirements: [
      "Record PR URL, CI, merge, handoff, finish-task, and cleanup receipts in the final report; keep accepted criteria focused on deliverable proof.",
    ],
    guidelines: ["Merge only after green CI and recorded manager decision evidence."],
    loopTemplate: "pr_ci_merge_loop",
    mode: "strict",
    name: "pr-ci-merge-ralph-loop",
    objective: "Drive the worker through PR readiness, CI, merge, handoff, and clear receipts.",
    permissions: ["repo.open_pr", "repo.merge_green_pr", "worker_session.compact", "worker_session.clear"],
    supportPatterns: ["Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: ["verification.run_tests", "context.fetch_prs"],
  },
  "ship-it-loop": {
    acceptance: [
      "Branch, push, PR URL, CI-green, mergeability, manager merge decision, merge, post-merge verification, and adversarial proof are recorded.",
      "Push, PR creation, conflict resolution, and merge actions are each gated by explicit manager permissions.",
      "Merge readiness is a manager decision after independent verification, not a worker claim or CI-green shortcut.",
    ],
    cleanup: "clear after saved handoff",
    description: "Drive a visible manager-worker ship-it loop through branch push, PR, CI, conflict handling, manager merge decision, merge, and post-merge receipts.",
    disallowedActions: [
      "Do not push branches before repo.push_branch is permitted.",
      "Do not open or update PRs before repo.open_pr is permitted.",
      "Do not resolve conflicts before repo.resolve_conflicts is permitted and retry bounds are recorded.",
      "Do not merge before repo.merge_green_pr is permitted, CI is green, mergeability is clean, and the manager records merge_ready.",
    ],
    displayName: "Autonomous Ship-It Loop",
    epilogues: ["draft-pr", "record-handoff"],
    evidenceGates: [
      "branch_ready",
      "branch_pushed",
      "pr_url",
      "ci_green",
      "mergeability_clean",
      "manager_merge_decision",
      "merge",
      "post_merge_verification",
      "adversarial_check",
    ],
    finalReportRequirements: [
      "Record branch, PR URL, CI/check output, mergeability/conflict status, manager merge decision, merge SHA, post-merge verification, finish-task, and heartbeat teardown proof in the final report.",
    ],
    guidelines: [
      "Keep all PR lifecycle phases visible in the manager and worker sessions.",
      "Treat CI-green, mergeability, and worker receipts as claims until the manager verifies them.",
      "Use a bounded conflict retry and block with evidence when conflicts remain unresolved.",
    ],
    loopTemplate: "ship_it_loop",
    mode: "strict",
    name: "ship-it-loop",
    objective: "Supervise a worker from implementation through explicit branch, PR, CI, conflict, merge, and post-merge evidence gates.",
    permissions: [
      "repo.push_branch",
      "repo.open_pr",
      "repo.monitor_ci",
      "repo.resolve_conflicts",
      "repo.merge_green_pr",
      "worker_session.compact",
      "worker_session.clear",
    ],
    supportPatterns: ["Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: ["gh", "git", "verification.run_tests", "context.fetch_prs"],
  },
  "test-coverage-loop": {
    acceptance: [
      "Coverage or targeted test evidence is recorded before another worker pass.",
      "Structured adversarial proof names the strongest realistic failure mode.",
    ],
    cleanup: "clear by default",
    description: "Improve or prove test confidence with coverage evidence before another pass.",
    disallowedActions: ["Do not continue after only generic tests-passed text."],
    displayName: "Test Coverage Loop",
    epilogues: [],
    evidenceGates: ["test_coverage", "adversarial_check"],
    finalReportRequirements: [
      "Record final closeout and finish-task proof in the manager final report; do not make closeout mechanics a test-coverage criterion.",
    ],
    guidelines: ["Record coverage evidence before asking for another worker pass."],
    loopTemplate: "test_coverage_loop",
    mode: "strict",
    name: "test-coverage-loop",
    objective: "Improve or prove test coverage for the requested behavior.",
    permissions: ["worker_session.compact", "worker_session.clear"],
    supportPatterns: ["Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: ["verification.run_tests"],
  },
  "ux-polish-loop": {
    acceptance: [
      "Reference artifact, candidate screenshot, visual diff report, and below-threshold evidence are recorded.",
      "Structured adversarial proof is recorded before another visual pass.",
    ],
    cleanup: "compact by default",
    description: "Iterate on visible UI quality using browser, screenshot, and visual-diff evidence.",
    disallowedActions: ["Do not approve a visual pass without screenshot or browser evidence."],
    displayName: "UX Polish Loop",
    epilogues: [],
    evidenceGates: [
      "reference_artifact",
      "candidate_screenshot",
      "visual_diff_report",
      "diff_below_threshold",
      "adversarial_check",
    ],
    finalReportRequirements: [
      "Record final visual decision, closeout, and cleanup proof in the manager final report; keep accepted criteria focused on visible-output evidence.",
    ],
    guidelines: ["Compare visible output against references before requesting another pass."],
    loopTemplate: "visual_diff_loop",
    mode: "guided",
    name: "ux-polish-loop",
    objective: "Iterate on visible UI quality using browser and screenshot evidence.",
    permissions: ["worker_session.compact", "worker_session.clear"],
    supportPatterns: ["Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"],
    tools: ["verification.run_playwright"],
  },
};

const MANAGER_RECIPE_ALIASES: Record<string, string> = {
  "campaign duplicate guard": "campaign-duplicate-guard-dogfood",
  "campaign duplicate guard dogfood": "campaign-duplicate-guard-dogfood",
  "creative duplicate guard": "campaign-duplicate-guard-dogfood",
  "duplicate guard dogfood": "campaign-duplicate-guard-dogfood",
  "goalbuddy conveyor": "goalbuddy-conveyor",
  goalbuddy: "goalbuddy-conveyor",
  "nudge / what's next manager": "nudge-whats-next",
  "nudge whats next": "nudge-whats-next",
  "pr ci merge ralph loop": "pr-ci-merge-ralph-loop",
  "pr/ci/merge ralph loop": "pr-ci-merge-ralph-loop",
  "ralph loop": "pr-ci-merge-ralph-loop",
  "ship it": "ship-it-loop",
  "ship it loop": "ship-it-loop",
  "ship-it": "ship-it-loop",
  "test coverage": "test-coverage-loop",
  "test coverage loop": "test-coverage-loop",
  "ux polish": "ux-polish-loop",
  "ux polish loop": "ux-polish-loop",
  "visual polish": "ux-polish-loop",
  "what's next": "nudge-whats-next",
  "whats next": "nudge-whats-next",
};

function listManagerRecipes(): Array<Record<string, unknown>> {
  return Object.keys(MANAGER_RECIPES).sort().map((name) => managerRecipeSummary(name));
}

function managerRecipeDefinition(name: string): ManagerRecipeDefinition {
  const key = normalizeManagerRecipeName(name);
  const recipe = MANAGER_RECIPES[key];
  if (!recipe) {
    throw new Error(`Unknown manager recipe: ${name}; expected one of: ${Object.keys(MANAGER_RECIPES).sort().join(", ")}`);
  }
  return recipe;
}

function normalizeManagerRecipeName(name: string): string {
  const normalized = name.trim().toLowerCase().split(/\s+/).join(" ");
  return MANAGER_RECIPE_ALIASES[normalized] ?? normalized.replace(/_/g, "-").replace(/ /g, "-");
}

function managerRecipeSummary(name: string): Record<string, unknown> {
  const recipe = managerRecipeDefinition(name);
  return {
    acceptance: [...recipe.acceptance],
    cleanup: recipe.cleanup,
    description: recipe.description,
    disallowed_actions: [...recipe.disallowedActions],
    display_name: recipe.displayName,
    epilogues: [...recipe.epilogues],
    evidence_gates: [...recipe.evidenceGates],
    final_report_requirements: [...recipe.finalReportRequirements],
    guidelines: [...recipe.guidelines],
    locked_summary_template: lockedManagerRecipeSummary(recipe),
    loop_template: recipe.loopTemplate,
    manager_config_command: managerRecipeConfigCommand(recipe),
    mode: recipe.mode,
    name: recipe.name,
    objective: recipe.objective,
    permissions: [...recipe.permissions],
    support_patterns: [...recipe.supportPatterns],
    tools: [...recipe.tools],
  };
}

function managerRecipeConfigCommand(recipe: ManagerRecipeDefinition, taskPlaceholder = "<task>"): string[] {
  const command = ["conveyor", "manager-config", taskPlaceholder, "--mode", recipe.mode, "--objective", recipe.objective];
  for (const guideline of recipe.guidelines) {
    command.push("--guideline", guideline);
  }
  for (const acceptance of recipe.acceptance) {
    command.push("--acceptance", acceptance);
  }
  const permissions = new Set(recipe.permissions);
  if (permissions.has("worker_session.compact") && permissions.has("worker_session.clear")) {
    command.push("--allow-worker-compact-clear");
    permissions.delete("worker_session.compact");
    permissions.delete("worker_session.clear");
  }
  if (permissions.has("repo.open_pr")) {
    command.push("--allow-pr");
    permissions.delete("repo.open_pr");
  }
  if (permissions.has("repo.merge_green_pr")) {
    command.push("--allow-merge-green");
    permissions.delete("repo.merge_green_pr");
  }
  for (const permission of [...permissions].sort()) {
    command.push("--permit", permission);
  }
  for (const tool of recipe.tools) {
    command.push("--tool", tool);
  }
  for (const epilogue of recipe.epilogues) {
    command.push("--epilogue", epilogue);
  }
  return command;
}

function lockedManagerRecipeSummary(recipe: ManagerRecipeDefinition): string {
  return [
    `Selected recipe: ${recipe.displayName}`,
    `Mode: ${recipe.mode}`,
    `Permissions: ${recipe.permissions.length > 0 ? recipe.permissions.join(", ") : "none"}`,
    `Tools: ${recipe.tools.length > 0 ? recipe.tools.join(", ") : "none"}`,
    `Epilogues: ${recipe.epilogues.length > 0 ? recipe.epilogues.join(", ") : "none"}`,
    `Cleanup: ${recipe.cleanup}`,
    `Evidence gates: ${recipe.evidenceGates.length > 0 ? recipe.evidenceGates.join(", ") : "manager-reviewed evidence"}`,
    `Final report: ${recipe.finalReportRequirements.join("; ")}`,
    `Not allowed: ${recipe.disallowedActions.length > 0 ? recipe.disallowedActions.join("; ") : "unconfirmed custom actions"}`,
    "User confirmed: <yes|no>",
  ].join("\n");
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
    select consumed_at, state, payload_json
    from routed_notifications
    where task_id = ?
    order by created_at, id
  `).all(options.task.id) as Array<{ consumed_at: string | null; payload_json: string; state: string }>;
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
  const appTaskDispatch = appTaskDispatchSummarySync(database, {
    commandRows,
    notificationRows,
    runScopedActivityTotal: matchingCommands.length + matchingNotifications.length + telemetryEvents.length,
    taskId: options.task.id,
  });
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
    app_task_dispatch: appTaskDispatch,
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

function appTaskDispatchSummarySync(
  database: ReturnType<typeof openRuntimeDatabase>,
  options: {
    commandRows: Array<{ state: string }>;
    notificationRows: Array<{ consumed_at: string | null; state: string }>;
    runScopedActivityTotal: number;
    taskId: string;
  },
): Record<string, unknown> {
  const taskDispatchEventTypes = [
    "app_autopilot_started",
    "app_autopilot_stopped",
    "app_heartbeat",
    "app_wakeup_delivery_recorded",
    "app_wakeup_dispatch_planned",
    "command_created",
    "dispatch_inbox_consumed",
  ];
  const telemetryRows = database.prepare(`
    select event_type, timestamp
    from telemetry_events
    where task_id = ?
      and event_type in (${taskDispatchEventTypes.map(() => "?").join(", ")})
    order by timestamp, id
  `).all(options.taskId, ...taskDispatchEventTypes) as Array<{ event_type: string; timestamp: string }>;
  const telemetryByType = countBy(telemetryRows.map((row) => row.event_type));
  const commandStates = countBy(options.commandRows.map((row) => row.state));
  const notificationStates = countBy(options.notificationRows.map((row) => row.state));
  const recordsTotal = options.commandRows.length + options.notificationRows.length + telemetryRows.length;
  const blindToRun = options.runScopedActivityTotal === 0 && recordsTotal > 0;
  return {
    commands: {
      states: sortJson(commandStates),
      total: options.commandRows.length,
    },
    latest_event_at: telemetryRows.at(-1)?.timestamp ?? null,
    note: blindToRun
      ? "Requested run has no run-scoped activity, but task-level app Dispatch records exist."
      : null,
    notifications: {
      delivered_unconsumed: options.notificationRows
        .filter((row) => row.state === "delivered" && row.consumed_at === null).length,
      states: sortJson(notificationStates),
      total: options.notificationRows.length,
    },
    records_total: recordsTotal,
    telemetry: {
      by_event_type: sortJson(telemetryByType),
      command_created: telemetryByType.command_created ?? 0,
      dispatch_inbox_consumed: telemetryByType.dispatch_inbox_consumed ?? 0,
      total: telemetryRows.length,
    },
  };
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
  const appTaskDispatch = result.app_task_dispatch as Record<string, unknown> | undefined;
  const appTaskDispatchTelemetry = appTaskDispatch?.telemetry as Record<string, unknown> | undefined;
  return [
    `task: ${task.name} (${task.state})`,
    `run: ${run.name || run.id} (${run.status})`,
    `policy: ${policy.template} iteration ${policy.current_iteration}/${policy.max_iterations}`,
    `commands: ${JSON.stringify(commands.states ?? {})}`,
    `notifications: ${notifications.delivered}/${notifications.total} delivered`,
    `worker_unconsumed: ${inbox.worker_unconsumed}`,
    `dispatch_inbox_consumed: ${telemetry.dispatch_inbox_consumed}`,
    `app_task_dispatch: ${appTaskDispatch?.records_total ?? 0} records ${JSON.stringify(appTaskDispatchTelemetry?.by_event_type ?? {})}${appTaskDispatch?.note ? ` (${appTaskDispatch.note})` : ""}`,
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
  options: { allowedDecisions?: string[]; decisionId: number | null; now?: string; taskId: string },
): Record<string, unknown> {
  const allowedDecisions = options.allowedDecisions ?? ["stop"];
  if (options.decisionId === null) {
    return {
      ...missingManagerDecisionCheck(),
      allowed_decisions: allowedDecisions,
    };
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
      allowed_decisions: allowedDecisions,
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
  if (!allowedDecisions.includes(row.decision)) {
    warnings.push("decision_mismatch");
  }
  const createdAt = Date.parse(row.created_at);
  let ageSeconds: number | null = null;
  if (Number.isNaN(createdAt)) {
    warnings.push("decision_timestamp_invalid");
  } else {
    const now = options.now === undefined ? Date.now() : Date.parse(options.now);
    ageSeconds = Number.isNaN(now) ? null : Math.trunc((now - createdAt) / 1000);
    if (ageSeconds !== null && ageSeconds > 900) {
      warnings.push("decision_stale");
    }
  }
  return {
    age_seconds: ageSeconds,
    allowed_decisions: allowedDecisions,
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
  const notifyCommand = durableWorkerNotifyManagerCommand(taskName, dbPath);
  const dispatchCommand = durableWorkerNotifyDispatchCommand(dbPath);
  return [
    "Use the manage-codex-workers skill.",
    "",
    `You are the worker for task ${taskName}${loopClause}.`,
    "Keep polling your Conveyor worker inbox until there are no items left or the loop reaches max_iterations. Consume the next item now, treat each consumed item as the manager's next instruction, complete the requested work, and report changed files, exact commands run, evidence, and any residual risk.",
    ...visibleSessionProtocolLines("worker"),
    "After completing or blocking on a consumed item, send the manager a durable Conveyor notification before your final answer. A direct app-thread final answer is not a manager receipt and is not task completion.",
    `Run: ${notifyCommand}`,
    `Then run: ${dispatchCommand}`,
    "If either notify/dispatch command fails, include that failure as the blocker and do not claim the manager was notified.",
    "",
    "Because this is a pull-required Codex app/no-tmux session, autonomous operation requires a heartbeat/wake layer that repeats this worker inbox poll while the thread is idle. If no heartbeat automation is available, report the loop as manual-poll only.",
    "Do not delete, pause, or disable heartbeat automation just because an inbox poll is idle; the manager or operator owns terminal loop teardown.",
    "",
    `Run: ${sessionPollCommand("worker", taskName, dbPath)}`,
  ].join("\n");
}

type DisposableHeartbeatRecommendations = {
  applies_when: {
    can_receive_push: false;
    delivery_mode: "pull_required";
    receive_style: "pull";
    session_kind: "codex_app";
  };
  interval_minutes: number;
  delivery_receipt_commands: {
    blocked: string;
    note: string;
    sent: string;
    skipped: string;
  };
  manager: { direct_inbox_command: string; kind: "thread_heartbeat"; poll_command: string; prompt: string };
  note: string;
  status_command: string;
  teardown_policy: {
    idle_poll: string;
    owner: "manager_or_operator";
    terminal_closeout: string;
    terminal_closeout_command: string;
    worker_rule: string;
  };
  wakeup_dispatch_command: string;
  wakeup_plan_command: string;
  worker: { direct_inbox_command: string; kind: "thread_heartbeat"; poll_command: string; prompt: string };
};

function renderDisposableBindingText(result: {
  heartbeat_recommendations?: DisposableHeartbeatRecommendations;
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
  if (result.heartbeat_recommendations) {
    lines.push("Heartbeat recommendations:");
    lines.push(`  interval: every ${result.heartbeat_recommendations.interval_minutes} minutes`);
    lines.push(`  manager: ${result.heartbeat_recommendations.manager.poll_command}`);
    lines.push(`  worker: ${result.heartbeat_recommendations.worker.poll_command}`);
    lines.push(`  status: ${result.heartbeat_recommendations.status_command}`);
    lines.push(`  wakeup plan: ${result.heartbeat_recommendations.wakeup_plan_command}`);
    lines.push(`  wakeup dispatch: ${result.heartbeat_recommendations.wakeup_dispatch_command}`);
    lines.push(`  delivery sent: ${result.heartbeat_recommendations.delivery_receipt_commands.sent}`);
    lines.push(`  teardown: ${result.heartbeat_recommendations.teardown_policy.idle_poll}`);
    lines.push(`  closeout: ${result.heartbeat_recommendations.teardown_policy.terminal_closeout_command}`);
  }
  lines.push("Worker handoff:");
  lines.push(result.worker_handoff);
  return `${lines.join("\n")}\n`;
}

function disposableHeartbeatRecommendations(taskName: string, dbPath: string): DisposableHeartbeatRecommendations {
  const terminalCloseoutCommand = `${conveyorPollInvocation()} finish-task ${shellQuote(taskName)} --reason ${shellQuote("Verified terminal closeout")} --require-criteria-audit --path ${shellQuote(dbPath)}`;
  const managerHeartbeatCommand = disposableAppHeartbeatCommand("manager", taskName, dbPath);
  const workerHeartbeatCommand = disposableAppHeartbeatCommand("worker", taskName, dbPath);
  const managerInboxCommand = sessionPollCommand("manager", taskName, dbPath);
  const workerInboxCommand = sessionPollCommand("worker", taskName, dbPath);
  const workerNotifyCommand = durableWorkerNotifyManagerCommand(taskName, dbPath);
  const workerNotifyDispatchCommand = durableWorkerNotifyDispatchCommand(dbPath);
  const wakeupDispatchCommand = `${conveyorPollInvocation()} app-wakeup-dispatch ${shellQuote(taskName)} --path ${shellQuote(dbPath)} --json`;
  const deliveryReceiptCommands = disposableDeliveryReceiptCommands(taskName, dbPath);
  return {
    applies_when: {
      can_receive_push: false,
      delivery_mode: "pull_required",
      receive_style: "pull",
      session_kind: "codex_app",
    },
    delivery_receipt_commands: deliveryReceiptCommands,
    interval_minutes: 2,
    note: "Dispatch can deliver pull-required inbox items, but Codex app/no-tmux sessions still need a heartbeat or operator wake-up to poll while idle.",
    status_command: `${conveyorPollInvocation()} app-loop-status ${shellQuote(taskName)} --path ${shellQuote(dbPath)} --json`,
    teardown_policy: {
      idle_poll: "Never delete, pause, or disable a manager or worker heartbeat because an inbox poll returned no item; that is only a quiet poll interval.",
      owner: "manager_or_operator",
      terminal_closeout: "Only the manager or operator should tear down heartbeats, and only after a terminal manager decision plus verified task closeout, or after explicit operator instruction.",
      terminal_closeout_command: terminalCloseoutCommand,
      worker_rule: "The worker must not own loop teardown and must not remove heartbeat automation based on idle polling.",
    },
    wakeup_dispatch_command: wakeupDispatchCommand,
    wakeup_plan_command: `${conveyorPollInvocation()} app-wakeup-plan ${shellQuote(taskName)} --path ${shellQuote(dbPath)} --json`,
    manager: {
      direct_inbox_command: managerInboxCommand,
      kind: "thread_heartbeat",
      poll_command: managerHeartbeatCommand,
      prompt: [
        "Use the manage-codex-workers skill.",
        `Run the manager app heartbeat for task ${taskName}.`,
        `Run: ${managerHeartbeatCommand}`,
        `If the heartbeat output asks for direct inbox polling, run: ${managerInboxCommand}`,
        `For stale app-thread recovery with an auditable receipt, run: ${wakeupDispatchCommand}`,
        "Send app-thread wake prompts only for actions where `send_ready=true`; direct app-thread delivery is not task completion.",
        `After a successful app-thread send, record it with: ${deliveryReceiptCommands.sent}`,
        `For healthy skipped actions, record: ${deliveryReceiptCommands.skipped}`,
        `For missing-thread blocked actions, record: ${deliveryReceiptCommands.blocked}`,
        ...visibleSessionProtocolLines("manager"),
        "If an item is consumed, execute only that manager instruction, verify worker claims before recording conclusions, update Conveyor state as appropriate, and produce exactly one next worker task.",
        "If no item is consumed, stop after a one-line idle receipt.",
        "Do not delete, pause, or disable manager or worker heartbeat automation after an idle poll; an idle poll is only a quiet interval.",
        "Keep manager closeout/control-plane proof out of accepted worker criteria; record finish-task, final task state, and heartbeat teardown proof in the manager final report or audit receipts.",
        `If all accepted criteria are satisfied, deferred, or rejected and there is no next worker task, record the terminal manager decision, run or report the result of: ${terminalCloseoutCommand}`,
        "After verified task closeout, explicitly report heartbeat teardown status; if the task remains managed/active, report that as a control-plane blocker instead of calling the loop complete.",
      ].join("\n"),
    },
    worker: {
      direct_inbox_command: workerInboxCommand,
      kind: "thread_heartbeat",
      poll_command: workerHeartbeatCommand,
      prompt: [
        "Use the manage-codex-workers skill.",
        `Run the worker app heartbeat for task ${taskName}.`,
        `Run: ${workerHeartbeatCommand}`,
        `If the heartbeat output asks for direct inbox polling, run: ${workerInboxCommand}`,
        ...visibleSessionProtocolLines("worker"),
        "If an item is consumed, execute only that single worker instruction and return exact commands, compact evidence for any completion claim, blockers/residual risk, and exactly one next recommended worker task.",
        "Before your final answer after any consumed item, notify the manager durably; a direct app-thread final answer is not a manager receipt and is not task completion.",
        `Run: ${workerNotifyCommand}`,
        `Then run: ${workerNotifyDispatchCommand}`,
        "If either notify/dispatch command fails, include that failure as the blocker and do not claim the manager was notified.",
        "If no item is consumed, stop after a one-line idle receipt.",
        "Do not delete, pause, or disable worker heartbeat automation after an idle poll; the manager or operator owns terminal loop teardown.",
      ].join("\n"),
    },
  };
}

function disposableDeliveryReceiptCommands(taskName: string, dbPath: string): DisposableHeartbeatRecommendations["delivery_receipt_commands"] {
  const base = `${conveyorPollInvocation()} app-wakeup-record-delivery ${shellQuote(taskName)} --role <role> --dispatch-receipt <receipt.event_id>`;
  const pathAndJson = ` --path ${shellQuote(dbPath)} --json`;
  return {
    blocked: `${base} --delivery-status blocked${pathAndJson}`,
    note: "Run these only after app-wakeup-dispatch. Replace <role>, <receipt.event_id>, and <action.thread.id> from the dispatch JSON; sent is valid only for send_ready=true actions.",
    sent: `${base} --delivery-status sent --thread-id <action.thread.id>${pathAndJson}`,
    skipped: `${base} --delivery-status skipped${pathAndJson}`,
  };
}

function disposableAppHeartbeatCommand(role: "manager" | "worker", taskName: string, dbPath: string): string {
  return `${conveyorPollInvocation()} app-heartbeat ${shellQuote(taskName)} --role ${role} --path ${shellQuote(dbPath)} --json`;
}

function durableWorkerNotifyManagerCommand(taskName: string, dbPath: string): string {
  return `${conveyorPollInvocation()} enqueue-notify-manager ${shellQuote(taskName)} --message ${shellQuote("<compact completion/blocker report with files, commands, evidence, residual risk, and next recommended worker task>")} --correlation-id ${shellQuote("<worker-result-id>")} --path ${shellQuote(dbPath)} --json`;
}

function durableWorkerNotifyDispatchCommand(dbPath: string): string {
  return `${conveyorPollInvocation()} dispatch --watch --watch-iterations 1 --interval 2 --dispatcher-id dispatch-local --path ${shellQuote(dbPath)} --json`;
}

function sessionPollCommand(role: "manager" | "worker", taskName: string | null, dbPath: string): string {
  const inbox = role === "worker" ? "worker-inbox" : "manager-inbox";
  const task = taskName ? shellQuote(taskName) : "<task>";
  return `${conveyorPollInvocation()} ${inbox} ${task} --consume-next --wait --timeout 60 --path ${shellQuote(dbPath)} --json`;
}

function conveyorPollInvocation(): string {
  const binDir = join(packageRootFromRuntimeModule(), "bin");
  return pathIsExecutable(join(binDir, "conveyor")) ? `PATH=${shellQuote(binDir)}:$PATH conveyor` : "conveyor";
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
    dbPath: string | null;
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
  const pathSuffix = commandPathSuffix(options.dbPath);
  const setupCommand = options.taskName
    ? `${workerctl} manager-config ${taskLine} --questions${pathSuffix}`
    : `${workerctl} manager-config <task> --questions${pathSuffix}`;
  const cycleCommand = options.taskName ? `${workerctl} cycle ${taskLine}${pathSuffix}` : `${workerctl} cycle <task>${pathSuffix}`;
  const managerAckCommand = options.taskName
    ? `${workerctl} manager-ack ${taskLine} --from-stdin${pathSuffix}`
    : `${workerctl} manager-ack <task> --from-stdin${pathSuffix}`;
  const workerAckCommand = options.taskName
    ? `${workerctl} worker-ack ${taskLine} --json${pathSuffix}`
    : `${workerctl} worker-ack <task> --json${pathSuffix}`;
  const satisfyCriterionCommand = options.taskName
    ? `${workerctl} criteria ${taskLine} --satisfy <id> --proof "<proof>" --evidence-json '{"status":"pass","command":"<command>","summary":"<what this proved>"}'${pathSuffix}`
    : `${workerctl} criteria <task> --satisfy <id> --proof "<proof>" --evidence-json '{"status":"pass","command":"<command>","summary":"<what this proved>"}'${pathSuffix}`;
  const config = context ? managerConfigSync(database, context.id) : null;
  const initialSetup = config
    ? seededManagerConfigSetup({ config, cycleCommand, managerAckCommand, workerAckCommand })
    : [
      "Initial setup:",
      `1. Run \`${setupCommand}\`.`,
      "2. Ask the user the returned setup questions in this manager Codex chat.",
      `3. Persist the answers with \`${workerctl} manager-config${pathSuffix}\`.`,
      "4. Use `conveyor manager-config --interactive` only when a human is directly running conveyor in a terminal.",
      "",
      "Acknowledgement:",
      `- Before your first cycle, record the supervision contract you are committing to with \`${managerAckCommand}\`.`,
      `  Example JSON: {"task":"${taskLine}","manager_session":"${options.managerName}","supervision_contract":"I will supervise through Conveyor and verify criteria before finishing.","will_not_edit_project_files":true}`,
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
    "- Keep manager closeout/control-plane proof out of accepted worker criteria; record finish-task, final task state, teardown, and final-report proof in manager closeout evidence instead.",
    "- Before finishing, compare worker receipts/verification against accepted open criteria.",
    `- For each accepted criterion that is proven, record evidence with \`${satisfyCriterionCommand}\`.`,
    `- When all accepted criteria are satisfied, deferred, or rejected, finish the task with \`${workerctl} finish-task ${taskLine} --reason "Accepted criteria satisfied" --require-criteria-audit${pathSuffix}\`.`,
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
    `  Example JSON: {"task":"${options.config.task_id}","supervision_contract":"I will supervise through Conveyor and verify criteria before finishing.","will_not_edit_project_files":true}`,
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

function commandPathSuffix(dbPath: string | null): string {
  return dbPath ? ` --path ${shellQuote(dbPath)}` : "";
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
): string {
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
  return eventId;
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

function redactAudit(audit: ReturnType<typeof taskAuditSync>): ReturnType<typeof taskAuditSync> {
  return {
    ...audit,
    terminal_captures: audit.terminal_captures.map((capture) => {
      const { content, ...rest } = capture;
      if (typeof content !== "string") {
        return rest;
      }
      return {
        ...rest,
        content_byte_count: Buffer.byteLength(content),
        content_line_count: pythonSplitlinesCount(content),
        content_redacted: true,
      };
    }),
    transcript_segments: audit.transcript_segments.map((segment) => {
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

   Example JSON:
   {"goal_restatement":"Restate the assigned task.","proposed_criteria":{"must_have":["Current-task proof"],"follow_up":[]},"expected_tools":["shell"],"open_questions":[],"ready_to_start":true}

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

function ensureTmuxServerAccessible(runner: TmuxRunner): TypescriptRuntimeResult | null {
  const result = runner(["tmux", "start-server"], { check: false });
  if (result.status === 0) {
    return null;
  }
  const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
  return lifecycleWorkerErrorResult(tmuxCommandFailureMessage(["tmux", "start-server"], detail));
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

function isTelemetryView(value: string): boolean {
  return value === "metrics" || value === "snapshot" || value === "check" || value === "task" || value === "failures";
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
