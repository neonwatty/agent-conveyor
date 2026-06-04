import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { finishCommandAttemptSync, markCommandAttemptSideEffectStartedSync } from "./commands.js";
import { managerConfigPermissionAllowed, managerConfigSync } from "./manager-config.js";
import {
  deferRoutedNotificationBeforeSideEffectSync,
  deliveryModeForTargetSessionSync,
  finishRoutedNotificationSync,
  insertRoutedNotificationSync,
  markRoutedNotificationSideEffectStartedSync,
} from "./notifications.js";
import { activeBindingForTaskSync } from "./tasks.js";
import { sendTextToSessionWithRunner } from "./tmux.js";
import type { ClaimedCommand, CommandRecord } from "./commands.js";
import type { RoutedNotificationDeliveryMode } from "./notifications.js";
import type { SendTextResult, TmuxRunner } from "./tmux.js";

export interface DispatchPermissionCheck {
  allowed: boolean;
  configured: boolean;
  required_permission: string;
}

export interface DispatchCommandRoute {
  binding_id: string;
  created_at: string;
  manager_session_id: string;
  manager_session_name: string;
  signal_type: string;
  source_session_id: string;
  source_session_name: string;
  state: string;
  target_session_id: string;
  target_session_name: string;
  task_id: string;
  worker_session_id: string;
  worker_session_name: string;
}

export interface DispatchCommandResult {
  attempt_id: number;
  cleanup_policy?: string | null;
  command_id: string;
  command_type: string;
  correlation_id: string | null;
  current_iteration?: number;
  delivered?: boolean;
  delivery_mode?: RoutedNotificationDeliveryMode;
  dispatcher_id: string;
  dry_run: boolean;
  error?: string;
  loop_policy?: Record<string, unknown>;
  manager_decision_id?: number | null;
  max_iterations?: number;
  missing_evidence?: string[];
  notification_id?: number | null;
  permission_check?: DispatchPermissionCheck | null;
  reason?: string | null;
  requested_iteration?: number;
  required_before_continue?: string[];
  run_id?: string;
  seed_prompt_sha256?: string | null;
  send_result?: SendTextResult;
  side_effect_completed?: boolean;
  side_effect_started?: boolean;
  state: "blocked" | "delivered" | "failed" | "planned" | "pull_required";
  stop_conditions?: string[];
  target_session?: string;
  target_worker_notified?: boolean;
}

export class DispatchPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchPermissionError";
  }
}

export class DispatchRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRoutingError";
  }
}

export function resolveDispatchCommandRouteSync(database: DatabaseSync, command: CommandRecord): DispatchCommandRoute {
  if (!command.task_id) {
    throw new DispatchRoutingError(`${command.type} command requires task_id for active binding resolution`);
  }
  const binding = activeBindingForTaskSync(database, command.task_id);
  if (command.type === "notify_manager") {
    return {
      ...binding,
      signal_type: "notify_manager",
      source_session_id: binding.worker_session_id,
      source_session_name: binding.worker_session_name,
      target_session_id: binding.manager_session_id,
      target_session_name: binding.manager_session_name,
    };
  }
  if (command.type === "nudge_worker" || command.type === "continue_iteration") {
    return {
      ...binding,
      signal_type: command.type,
      source_session_id: binding.manager_session_id,
      source_session_name: binding.manager_session_name,
      target_session_id: binding.worker_session_id,
      target_session_name: binding.worker_session_name,
    };
  }
  throw new DispatchRoutingError(`unsupported dispatch command type: ${command.type}`);
}

export function executeDispatchCommandSync(
  database: DatabaseSync,
  options: {
    claimed: ClaimedCommand;
    dispatcherId: string;
    dryRun?: boolean;
    now?: string;
    sleep?: (milliseconds: number) => void;
    tmuxRunner?: TmuxRunner;
  },
): DispatchCommandResult {
  const timestamp = options.now ?? new Date().toISOString();
  const command = options.claimed.command;
  const attempt = options.claimed.attempt;
  const baseResult = {
    attempt_id: attempt.id,
    command_id: command.id,
    command_type: command.type,
    correlation_id: command.correlation_id,
    dispatcher_id: options.dispatcherId,
  };
  const text = dispatchCommandText(command);
  const route = resolveDispatchCommandRouteSync(database, command);
  if (options.dryRun) {
    return {
      ...baseResult,
      dry_run: true,
      state: "planned",
      target_session: route.target_session_name,
    };
  }
  const permissionCheck = checkDispatchRequiredPermissionSync(database, { command, now: timestamp });
  const deliveryMode = deliveryModeForTargetSessionSync(database, route.target_session_id);
  const loopPolicy = dispatchRalphLoopPolicySync(database, command);
  if (loopPolicy?.reason) {
    const error = loopPolicyBlockError(loopPolicy);
    const result = {
      ...baseResult,
      ...loopResultFields(loopPolicy),
      delivered: false,
      delivery_mode: deliveryMode,
      dry_run: false,
      manager_decision_id: managerDecisionIdFromCommand(command),
      notification_id: null,
      side_effect_completed: false,
      side_effect_started: false,
      state: "blocked" as const,
      target_session: route.target_session_name,
      target_worker_notified: false,
    };
    finishCommandAttemptSync(database, {
      attemptId: attempt.id,
      error,
      now: timestamp,
      result,
      sideEffectCompleted: false,
      sideEffectStarted: false,
      state: "blocked",
    });
    return result;
  }
  const payload = {
    command_id: command.id,
    command_type: command.type,
    delivery_mode: deliveryMode,
    dispatcher_id: options.dispatcherId,
    message: text,
    permission_check: permissionCheck,
    source_session: route.source_session_name,
    target_session: route.target_session_name,
    task_id: command.task_id,
    ...(loopPolicy ? notificationLoopPayload(loopPolicy) : {}),
  };
  const tmuxRunner = options.tmuxRunner;
  if (deliveryMode !== "pull_required" && !tmuxRunner) {
    throw new DispatchRoutingError("push delivery requires a tmux runner and is not available in this TypeScript slice");
  }
  const notificationId = insertRoutedNotificationSync(database, {
    bindingId: route.binding_id,
    commandId: command.id,
    correlationId: command.correlation_id ?? `dispatch-${randomUUID()}`,
    dedupeKey: `${route.binding_id}:${command.type}:${command.id}`,
    deliveryMode,
    now: timestamp,
    payload,
    signalType: route.signal_type,
    sourceSessionId: route.source_session_id,
    targetSessionId: route.target_session_id,
    taskId: route.task_id,
  });
  emitTelemetry(database, {
    attributes: {
      delivery_mode: deliveryMode,
      permission_check: permissionCheck,
      source_session: route.source_session_name,
      target_session: route.target_session_name,
    },
    correlation: {
      attempt_id: attempt.id,
      command_id: command.id,
      command_type: command.type,
      correlation_id: command.correlation_id,
      dispatcher_id: options.dispatcherId,
      routed_notification_id: notificationId,
    },
    eventType: "dispatch_command_attempted",
    severity: "info",
    summary: `Dispatch is executing command ${command.type}.`,
    taskId: route.task_id,
    timestamp,
  });
  if (deliveryMode === "push") {
    const runner = tmuxRunner;
    if (!runner) {
      throw new DispatchRoutingError("push delivery requires a tmux runner and is not available in this TypeScript slice");
    }
    const sideEffectAudit = {
      side_effect_completed: false,
      side_effect_started: false,
    };
    try {
      const sendResult = sendTextToSessionWithRunner(
        sessionForTmux(database, route.target_session_id),
        formatLoopPolicyPushText(text, loopPolicy),
        runner,
        {
          now: () => timestamp,
          sideEffectAudit,
          sideEffectStartedCallback: () => {
            markCommandAttemptSideEffectStartedSync(database, attempt.id);
            markRoutedNotificationSideEffectStartedSync(database, {
              notificationId,
              now: timestamp,
            });
          },
          sleep: options.sleep,
        },
      );
      const result = {
        ...baseResult,
        ...loopResultFields(loopPolicy),
        delivery_mode: deliveryMode,
        dry_run: false,
        notification_id: notificationId,
        permission_check: permissionCheck,
        send_result: sendResult,
        side_effect_completed: sendResult.side_effect_completed,
        side_effect_started: sendResult.side_effect_started,
        state: "delivered" as const,
        target_session: route.target_session_name,
      };
      finishRoutedNotificationSync(database, {
        notificationId,
        now: timestamp,
        state: "delivered",
      });
      emitTelemetry(database, {
        attributes: {
          target: sendResult.target,
          target_session: route.target_session_name,
        },
        correlation: {
          attempt_id: attempt.id,
          command_id: command.id,
          command_type: command.type,
          correlation_id: command.correlation_id,
          dispatcher_id: options.dispatcherId,
          routed_notification_id: notificationId,
          signal_type: route.signal_type,
        },
        eventType: "dispatch_signal_routed",
        severity: "info",
        summary: `Dispatch routed command ${command.type} to ${route.target_session_name}.`,
        taskId: route.task_id,
        timestamp,
      });
      finishCommandAttemptSync(database, {
        attemptId: attempt.id,
        now: timestamp,
        result,
        sideEffectCompleted: sendResult.side_effect_completed,
        sideEffectStarted: sendResult.side_effect_started,
        state: "succeeded",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sideEffectAudit.side_effect_started) {
        finishRoutedNotificationSync(database, {
          error: message,
          notificationId,
          state: "failed",
        });
      } else {
        deferRoutedNotificationBeforeSideEffectSync(database, {
          error: message,
          notificationId,
        });
      }
      const result = {
        ...baseResult,
        ...loopResultFields(loopPolicy),
        delivery_mode: deliveryMode,
        dry_run: false,
        error: message,
        notification_id: notificationId,
        permission_check: permissionCheck,
        side_effect_completed: sideEffectAudit.side_effect_completed,
        side_effect_started: sideEffectAudit.side_effect_started,
        state: "failed" as const,
        target_session: route.target_session_name,
      };
      emitTelemetry(database, {
        attributes: {
          error: message,
          error_type: error instanceof Error ? error.name : typeof error,
          target_session: route.target_session_name,
        },
        correlation: {
          attempt_id: attempt.id,
          command_id: command.id,
          command_type: command.type,
          correlation_id: command.correlation_id,
          dispatcher_id: options.dispatcherId,
          routed_notification_id: notificationId,
          signal_type: route.signal_type,
        },
        eventType: "dispatch_signal_failed",
        severity: "error",
        summary: `Dispatch failed to route command ${command.type} to ${route.target_session_name}.`,
        taskId: route.task_id,
        timestamp,
      });
      finishCommandAttemptSync(database, {
        attemptId: attempt.id,
        error: message,
        now: timestamp,
        result,
        sideEffectCompleted: sideEffectAudit.side_effect_completed,
        sideEffectStarted: sideEffectAudit.side_effect_started,
        state: "failed",
      });
      return result;
    }
  }
  const result = {
    ...baseResult,
    ...loopResultFields(loopPolicy),
    delivery_mode: deliveryMode,
    dry_run: false,
    notification_id: notificationId,
    permission_check: permissionCheck,
    side_effect_completed: false,
    side_effect_started: false,
    state: "pull_required" as const,
    target_session: route.target_session_name,
  };
  finishRoutedNotificationSync(database, {
    notificationId,
    now: timestamp,
    sideEffectCompleted: false,
    state: "delivered",
  });
  emitTelemetry(database, {
    attributes: {
      delivery_mode: deliveryMode,
      target_session: route.target_session_name,
    },
    correlation: {
      attempt_id: attempt.id,
      binding_id: route.binding_id,
      command_id: command.id,
      command_type: command.type,
      correlation_id: command.correlation_id,
      dispatcher_id: options.dispatcherId,
      routed_notification_id: notificationId,
      signal_type: route.signal_type,
    },
    eventType: "dispatch_signal_pull_required",
    severity: "info",
    summary: `Dispatch recorded pull-required ${route.signal_type} for ${route.target_session_name}.`,
    taskId: route.task_id,
    timestamp,
  });
  finishCommandAttemptSync(database, {
    attemptId: attempt.id,
    now: timestamp,
    result,
    sideEffectCompleted: false,
    sideEffectStarted: false,
    state: "succeeded",
  });
  return result;
}

export function checkDispatchRequiredPermissionSync(
  database: DatabaseSync,
  options: {
    command: CommandRecord;
    now?: string;
  },
): DispatchPermissionCheck | null {
  const requiredPermission = options.command.required_permission;
  if (!requiredPermission) {
    return null;
  }
  if (!options.command.task_id) {
    throw new DispatchPermissionError(`${options.command.type} command requires task_id for permission check`);
  }
  const config = managerConfigSync(database, options.command.task_id);
  const permissionCheck = {
    allowed: managerConfigPermissionAllowed(config, requiredPermission),
    configured: config !== null,
    required_permission: requiredPermission,
  };
  emitTelemetry(database, {
    attributes: permissionCheck,
    correlation: {
      command_id: options.command.id,
      command_type: options.command.type,
      correlation_id: options.command.correlation_id,
      required_permission: requiredPermission,
    },
    eventType: "dispatch_command_permission_checked",
    severity: permissionCheck.allowed ? "info" : "warning",
    summary: `Dispatch checked manager permission ${requiredPermission}.`,
    taskId: options.command.task_id,
    timestamp: options.now ?? new Date().toISOString(),
  });
  if (!permissionCheck.allowed) {
    throw new DispatchPermissionError(`manager permission required for dispatch command: ${requiredPermission}`);
  }
  return permissionCheck;
}

function emitTelemetry(
  database: DatabaseSync,
  options: {
    attributes: Record<string, unknown>;
    correlation: Record<string, unknown>;
    eventType: string;
    severity: "error" | "info" | "warning";
    summary: string;
    taskId: string;
    timestamp: string;
  },
): void {
  const eventId = `telemetry-${randomUUID()}`;
  database.prepare(`
    insert into telemetry_events(
      id, run_id, task_id, timestamp, actor, event_type, severity,
      summary, correlation_json, attributes_json
    )
    values (?, null, ?, ?, 'dispatch', ?, ?, ?, ?, ?)
  `).run(
    eventId,
    options.taskId,
    options.timestamp,
    options.eventType,
    options.severity,
    options.summary,
    stableJson(options.correlation),
    stableJson(options.attributes),
  );
  database.prepare(`
    insert into telemetry_events_fts(
      event_id, task_id, run_id, actor, event_type, summary, attributes
    )
    values (?, ?, null, 'dispatch', ?, ?, ?)
  `).run(
    eventId,
    options.taskId,
    options.eventType,
    options.summary,
    stableJson(options.attributes),
  );
}

function dispatchCommandText(command: CommandRecord): string {
  const text = command.payload.message ?? command.payload.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new DispatchRoutingError(`${command.type} command requires non-empty payload.message or payload.text`);
  }
  return text;
}

interface RalphLoopRun {
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

interface RalphLoopPolicy {
  cleanup_policy: string | null;
  current_iteration: number;
  loop_policy: Record<string, unknown>;
  max_iterations: number;
  missing_evidence: string[];
  reason: string | null;
  required_before_continue: string[];
  requested_iteration: number;
  run_id: string;
  seed_prompt_sha256: string | null;
  stop_conditions: string[];
}

function dispatchRalphLoopPolicySync(database: DatabaseSync, command: CommandRecord): RalphLoopPolicy | null {
  if (command.type !== "continue_iteration") {
    return null;
  }
  const loopPayload = command.payload.ralph_loop;
  if (!isRecord(loopPayload)) {
    throw new DispatchRoutingError("continue_iteration command requires payload.ralph_loop");
  }
  const runId = loopPayload.run_id;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new DispatchRoutingError("continue_iteration command requires payload.ralph_loop.run_id");
  }
  const requestedIterationValue = loopPayload.requested_iteration;
  if (typeof requestedIterationValue !== "number" || !Number.isInteger(requestedIterationValue)) {
    throw new DispatchRoutingError("continue_iteration command requires integer payload.ralph_loop.requested_iteration");
  }
  const requestedIteration = requestedIterationValue;
  const run = ralphLoopRunSync(database, runId);
  if (run.task_id !== command.task_id) {
    throw new DispatchRoutingError("continue_iteration Ralph loop run does not belong to command task");
  }
  let reason: string | null;
  let missingEvidence: string[] = [];
  if (requestedIteration <= run.current_iteration) {
    reason = "stale_requested_iteration";
  } else if (run.current_iteration >= run.max_iterations || requestedIteration > run.max_iterations) {
    reason = "max_iterations_reached";
  } else {
    missingEvidence = missingRalphLoopEvidenceSync(database, {
      requestedIteration,
      requiredBeforeContinue: run.required_before_continue,
      runId: run.id,
      taskId: command.task_id ?? "",
    });
    reason = missingEvidenceReason(missingEvidence);
  }
  return {
    cleanup_policy: run.cleanup_policy,
    current_iteration: run.current_iteration,
    loop_policy: loopPolicyPayload(run),
    max_iterations: run.max_iterations,
    missing_evidence: missingEvidence,
    reason,
    required_before_continue: run.required_before_continue,
    requested_iteration: requestedIteration,
    run_id: run.id,
    seed_prompt_sha256: run.seed_prompt_sha256,
    stop_conditions: run.stop_conditions,
  };
}

function ralphLoopRunSync(database: DatabaseSync, runId: string): RalphLoopRun {
  const row = database.prepare(`
    select id, task_id, purpose, metadata_json
    from runs
    where id = ?
  `).get(runId) as { id: string; metadata_json: string; purpose: string | null; task_id: string } | undefined;
  if (!row) {
    throw new DispatchRoutingError(`Unknown run: ${runId}`);
  }
  const metadata = parseJsonObject(row.metadata_json);
  if (metadata.kind !== "ralph_loop" && row.purpose !== "ralph_loop") {
    throw new DispatchRoutingError(`Run ${JSON.stringify(runId)} is not a Ralph loop run`);
  }
  const currentIteration = integerMetadata(metadata.current_iteration);
  const maxIterations = integerMetadata(metadata.max_iterations);
  if (currentIteration === null || maxIterations === null) {
    throw new DispatchRoutingError(`Ralph loop run ${JSON.stringify(runId)} is missing iteration policy`);
  }
  return {
    cleanup_policy: typeof metadata.cleanup_policy === "string" ? metadata.cleanup_policy : null,
    current_iteration: currentIteration,
    id: row.id,
    max_iterations: maxIterations,
    metadata,
    preset: typeof metadata.preset === "string" ? metadata.preset : null,
    required_before_continue: stringList(metadata.required_before_continue),
    seed_prompt_sha256: typeof metadata.seed_prompt_sha256 === "string" ? metadata.seed_prompt_sha256 : null,
    stop_conditions: stringList(metadata.stop_conditions),
    task_id: row.task_id,
  };
}

function missingRalphLoopEvidenceSync(
  database: DatabaseSync,
  options: {
    requestedIteration: number;
    requiredBeforeContinue: string[];
    runId: string;
    taskId: string;
  },
): string[] {
  if (options.requestedIteration <= 1 || options.requiredBeforeContinue.length === 0) {
    return [];
  }
  const previousIteration = options.requestedIteration - 1;
  const rows = database.prepare(`
    select evidence_json
    from acceptance_criteria
    where task_id = ? and status = 'satisfied'
    order by id
  `).all(options.taskId) as Array<{ evidence_json: string }>;
  const evidenceRows = rows.map((row) => parseJsonObject(row.evidence_json));
  return options.requiredBeforeContinue.filter((evidenceType) => !evidenceRows.some((evidence) => ralphLoopEvidenceMatches(evidence, {
    evidenceType,
    iteration: previousIteration,
    runId: options.runId,
  })));
}

function ralphLoopEvidenceMatches(
  evidence: Record<string, unknown>,
  options: {
    evidenceType: string;
    iteration: number;
    runId: string;
  },
): boolean {
  if (
    evidence.evidence_type !== options.evidenceType
    || evidence.ralph_loop_run_id !== options.runId
    || evidence.iteration !== options.iteration
  ) {
    return false;
  }
  if (options.evidenceType === "adversarial_check") {
    return isStructuredAdversarialEvidence(evidence);
  }
  return true;
}

function isStructuredAdversarialEvidence(evidence: Record<string, unknown>): boolean {
  for (const key of ["failure_mode", "check", "result"]) {
    const value = evidence[key];
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }
  }
  const status = evidence.status;
  if (status === undefined || status === null) {
    return true;
  }
  if (typeof status !== "string") {
    return false;
  }
  return !new Set(["error", "errored", "fail", "failed", "failure", "rejected"]).has(status.trim().toLowerCase());
}

function missingEvidenceReason(missingEvidence: string[]): string | null {
  if (missingEvidence.length === 0) {
    return null;
  }
  if (missingEvidence.length === 1) {
    return `missing_${missingEvidence[0]}_evidence`;
  }
  return "missing_required_evidence";
}

function loopPolicyPayload(run: RalphLoopRun): Record<string, unknown> {
  const template = run.metadata.template ?? run.preset;
  return {
    artifact_requirements: isRecord(run.metadata.artifact_requirements) ? run.metadata.artifact_requirements : {},
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
    template,
  };
}

function loopResultFields(loopPolicy: RalphLoopPolicy | null): Partial<DispatchCommandResult> {
  if (!loopPolicy) {
    return {};
  }
  return {
    cleanup_policy: loopPolicy.cleanup_policy,
    current_iteration: loopPolicy.current_iteration,
    loop_policy: loopPolicy.loop_policy,
    max_iterations: loopPolicy.max_iterations,
    missing_evidence: loopPolicy.missing_evidence,
    reason: loopPolicy.reason,
    requested_iteration: loopPolicy.requested_iteration,
    required_before_continue: loopPolicy.required_before_continue,
    run_id: loopPolicy.run_id,
    seed_prompt_sha256: loopPolicy.seed_prompt_sha256,
    stop_conditions: loopPolicy.stop_conditions,
  };
}

function notificationLoopPayload(loopPolicy: RalphLoopPolicy): Record<string, unknown> {
  return {
    loop_policy: loopPolicy.loop_policy,
    ralph_loop: {
      artifact_requirements: isRecord(loopPolicy.loop_policy.artifact_requirements) ? loopPolicy.loop_policy.artifact_requirements : {},
      cleanup_policy: loopPolicy.cleanup_policy,
      current_iteration: loopPolicy.current_iteration,
      max_iterations: loopPolicy.max_iterations,
      preset: loopPolicy.loop_policy.preset ?? null,
      recommended_tools: Array.isArray(loopPolicy.loop_policy.recommended_tools) ? loopPolicy.loop_policy.recommended_tools : [],
      required_before_continue: loopPolicy.required_before_continue,
      requested_iteration: loopPolicy.requested_iteration,
      run_id: loopPolicy.run_id,
      seed_prompt_sha256: loopPolicy.seed_prompt_sha256,
      stop_conditions: loopPolicy.stop_conditions,
      tags: Array.isArray(loopPolicy.loop_policy.tags) ? loopPolicy.loop_policy.tags : [],
      template: loopPolicy.loop_policy.template ?? null,
    },
  };
}

function loopPolicyBlockError(loopPolicy: RalphLoopPolicy): string {
  const parts = [
    String(loopPolicy.reason),
    `current_iteration=${loopPolicy.current_iteration}`,
    `max_iterations=${loopPolicy.max_iterations}`,
    `requested_iteration=${loopPolicy.requested_iteration}`,
  ];
  if (loopPolicy.missing_evidence.length > 0) {
    parts.splice(1, 0, `missing_evidence=${loopPolicy.missing_evidence.join(",")}`);
  }
  return parts.join(" ");
}

function formatLoopPolicyPushText(text: string, loopPolicy: RalphLoopPolicy | null): string {
  if (!loopPolicy) {
    return text;
  }
  const policyPayload = loopPolicy.loop_policy;
  const template = policyPayload.template ?? policyPayload.preset ?? "unknown";
  const recommendedTools = Array.isArray(policyPayload.recommended_tools) ? policyPayload.recommended_tools.map(String) : [];
  const artifactRequirements = isRecord(policyPayload.artifact_requirements) ? Object.keys(policyPayload.artifact_requirements).sort() : [];
  return [
    text.trimEnd(),
    "",
    "Loop policy:",
    `- run_id: ${loopPolicy.run_id}`,
    `- template: ${template}`,
    `- iteration: requested ${loopPolicy.requested_iteration} (current ${loopPolicy.current_iteration} of ${loopPolicy.max_iterations})`,
    `- cleanup_policy: ${loopPolicy.cleanup_policy ?? "none"}`,
    `- required_before_continue: ${loopPolicy.required_before_continue.length ? loopPolicy.required_before_continue.join(", ") : "none"}`,
    `- recommended_tools: ${recommendedTools.length ? recommendedTools.join(", ") : "none"}`,
    `- artifact_requirements: ${artifactRequirements.length ? artifactRequirements.join(", ") : "none"}`,
  ].join("\n");
}

function managerDecisionIdFromCommand(command: CommandRecord): number | null {
  const managerDecision = command.payload.manager_decision;
  if (!isRecord(managerDecision)) {
    return null;
  }
  const decisionId = managerDecision.decision_id ?? managerDecision.id;
  if (typeof decisionId === "number" && Number.isInteger(decisionId)) {
    return decisionId;
  }
  if (typeof decisionId === "string" && /^\d+$/.test(decisionId)) {
    return Number(decisionId);
  }
  return null;
}

function sessionForTmux(
  database: DatabaseSync,
  sessionId: string,
): { name: string; tmux_pane_id: string | null; tmux_session: string | null } {
  const row = database.prepare(`
    select name, tmux_pane_id, tmux_session
    from sessions
    where id = ?
  `).get(sessionId) as { name: string; tmux_pane_id: string | null; tmux_session: string | null } | undefined;
  if (!row) {
    throw new DispatchRoutingError(`target session ${JSON.stringify(sessionId)} no longer exists`);
  }
  return row;
}

function parseJsonObject(json: string): Record<string, unknown> {
  const value = JSON.parse(json) as unknown;
  return isRecord(value) ? value : {};
}

function integerMetadata(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}
