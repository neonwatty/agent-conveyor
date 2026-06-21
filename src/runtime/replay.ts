import type {
  TaskAuditCorrelationChain,
  TaskAuditEvent,
  TaskAuditManagerDecision,
  TaskAuditNotificationAcknowledgement,
  TaskAuditResult,
  TaskAuditRoutedNotification,
} from "./audit.js";
import type { CommandAttemptRecord, CommandRecord } from "./commands.js";

export type ReplayMode = "compact" | "timeline" | "transcript" | "full-transcript";
export type ReplayRole = "all" | "worker" | "manager" | "reviewer" | "workerctl";

export interface ReplayEntry {
  actor: string;
  content?: string | null;
  details: Record<string, unknown>;
  kind: string;
  source: string;
  source_id: number | string | null;
  summary: string;
  timestamp: string;
}

export interface ReplayResult {
  entries: ReplayEntry[];
  entry_count: number;
  mode: ReplayMode;
  role: ReplayRole;
  task: TaskAuditResult["task"];
}

export function replayEntriesFromAudit(
  audit: TaskAuditResult,
  options: {
    mode?: ReplayMode;
    role?: ReplayRole;
  } = {},
): ReplayEntry[] {
  const mode = options.mode ?? "timeline";
  const role = options.role ?? "all";
  const entries: ReplayEntry[] = [];
  const includeObserves = mode !== "compact";
  const includeCaptures = mode === "transcript";
  const includeSegments = mode === "full-transcript";
  const seenCaptureHashesByRole = new Map<string, Set<string>>();

  for (const command of audit.commands) {
    const [actor, kind, summary] = commandSummary(command);
    if (!roleIncludesActor(role, actor)) {
      continue;
    }
    entries.push({
      actor,
      details: {
        command_id: command.id,
        state: command.state,
        type: command.type,
      },
      kind,
      source: "commands",
      source_id: command.id,
      summary,
      timestamp: command.created_at,
    });
  }

  for (const attempt of audit.command_attempts) {
    if (role !== "all" && role !== "manager") {
      continue;
    }
    entries.push(commandAttemptEntry(attempt));
  }

  for (const notification of audit.routed_notifications) {
    if (role !== "all" && role !== "manager") {
      continue;
    }
    entries.push(routedNotificationEntry(notification));
  }

  for (const acknowledgement of audit.notification_acknowledgements) {
    if (role !== "all" && role !== acknowledgement.role) {
      continue;
    }
    entries.push(notificationAcknowledgementEntry(acknowledgement));
  }

  for (const chain of audit.correlation_chains) {
    if (role !== "all" && role !== "manager") {
      continue;
    }
    entries.push(correlationChainEntry(audit, chain));
  }

  for (const decision of audit.manager_decisions) {
    if (role !== "all" && role !== "manager") {
      continue;
    }
    entries.push(managerDecisionEntry(decision));
  }

  if (includeObserves) {
    for (const event of audit.events) {
      if (role !== "all" && role !== "manager") {
        continue;
      }
      const summary = acceptanceCriterionSummary(event);
      if (summary === null) {
        continue;
      }
      entries.push({
        actor: event.actor || "workerctl",
        details: acceptanceCriterionDetails(event),
        kind: "acceptance_criterion",
        source: "events",
        source_id: event.id,
        summary,
        timestamp: event.created_at,
      });
    }
  }

  if (includeCaptures) {
    for (const capture of audit.terminal_captures) {
      const captureRole = stringValue(capture.role) ?? "workerctl";
      if (role !== "all" && role !== captureRole) {
        continue;
      }
      const contentSha = stringValue(capture.content_sha256);
      if (contentSha !== null) {
        const seenHashes = seenCaptureHashesByRole.get(captureRole) ?? new Set<string>();
        if (seenHashes.has(contentSha)) {
          continue;
        }
        seenHashes.add(contentSha);
        seenCaptureHashesByRole.set(captureRole, seenHashes);
      }
      const excerpt = captureExcerpt(capture);
      const summary = `${captureRole} terminal capture: ${captureSummary(capture)}${excerpt ? ` | ${excerpt}` : ""}`;
      entries.push({
        actor: captureRole,
        details: {
          capture_id: capture.id,
          classifier: capture.classifier,
          content_sha256: capture.content_sha256,
          line_count: capture.line_count,
          source: capture.source,
        },
        kind: "capture",
        source: "terminal_captures",
        source_id: sourceId(capture.id),
        summary,
        timestamp: stringValue(capture.captured_at) ?? audit.task.created_at,
      });
    }
  }

  if (includeSegments) {
    for (const segment of audit.transcript_segments) {
      const segmentRole = stringValue(segment.role) ?? "workerctl";
      if (role !== "all" && role !== segmentRole) {
        continue;
      }
      const text = stringValue(segment.segment_text);
      const segmentKind = stringValue(segment.segment_kind) ?? "metadata";
      const lineCount = segment.line_count;
      entries.push({
        actor: segmentRole,
        content: text,
        details: {
          content_sha256: segment.content_sha256,
          line_count: lineCount,
          previous_capture_id: segment.previous_capture_id,
          retention_class: segment.retention_class,
          segment_kind: segmentKind,
          source_capture_id: segment.source_capture_id,
        },
        kind: "transcript_segment",
        source: "transcript_segments",
        source_id: sourceId(segment.id),
        summary: text
          ? `${segmentRole} transcript segment (${lineCount} lines)`
          : `${segmentRole} transcript metadata (${segmentKind})`,
        timestamp: stringValue(segment.captured_at) ?? audit.task.created_at,
      });
    }
  }

  return entries.sort((left, right) => {
    const timestamp = left.timestamp.localeCompare(right.timestamp);
    if (timestamp !== 0) {
      return timestamp;
    }
    const source = left.source.localeCompare(right.source);
    if (source !== 0) {
      return source;
    }
    return String(left.source_id).localeCompare(String(right.source_id));
  });
}

export function replayResultFromAudit(
  audit: TaskAuditResult,
  options: {
    limit?: number | null;
    mode?: ReplayMode;
    role?: ReplayRole;
  } = {},
): ReplayResult {
  const mode = options.mode ?? "timeline";
  const role = options.role ?? "all";
  let entries = replayEntriesFromAudit(audit, { mode, role });
  if (options.limit !== undefined && options.limit !== null) {
    entries = entries.slice(-options.limit);
  }
  return {
    entries,
    entry_count: entries.length,
    mode,
    role,
    task: audit.task,
  };
}

export function renderReplayText(result: ReplayResult): string {
  const lines = [
    `Task: ${result.task.name}`,
    `State: ${result.task.state}`,
    `Mode: ${result.mode}`,
    "",
  ];
  const finishEntries = result.entries.filter((entry) => entry.kind === "finish");
  if ((result.task.state === "done" || result.task.state === "failed") && finishEntries.length > 0) {
    const final = finishEntries[finishEntries.length - 1];
    lines.push(
      "Finished:",
      `- ${final.summary}`,
      "- Review: conveyor replay <task> --format compact",
      "- Audit: conveyor mutation-audit <task> --json",
      "",
    );
  }
  for (const entry of result.entries) {
    const hhmmss = entry.timestamp.split("T", 2).at(1)?.replace(/Z$/, "") ?? entry.timestamp;
    lines.push(`${hhmmss}  ${entry.actor.padEnd(16, " ")} ${entry.summary}`);
    if (typeof entry.content === "string" && entry.content.length > 0) {
      lines.push(entry.content);
    }
  }
  return lines.join("\n");
}

function commandAttemptEntry(attempt: CommandAttemptRecord): ReplayEntry {
  return {
    actor: "dispatch",
    details: {
      attempt_id: attempt.id,
      command_id: attempt.command_id,
      correlation_id: attempt.correlation_id,
      dispatcher_id: attempt.dispatcher_id,
      error: attempt.error,
      result: attempt.result,
      side_effect_completed: attempt.side_effect_completed,
      side_effect_started: attempt.side_effect_started,
      state: attempt.state,
    },
    kind: "command_attempt",
    source: "command_attempts",
    source_id: attempt.id,
    summary: `dispatch attempt ${attempt.state}: ${attempt.command_id}`,
    timestamp: attempt.started_at,
  };
}

function routedNotificationEntry(notification: TaskAuditRoutedNotification): ReplayEntry {
  return {
    actor: "dispatch",
    details: {
      command_id: notification.command_id,
      consumed_at: notification.consumed_at,
      consumed_by_session_id: notification.consumed_by_session_id,
      consumed_by_session_name: notification.consumed_by_session_name,
      correlation_id: notification.correlation_id,
      delivered_at: notification.delivered_at,
      delivery_mode: notification.delivery_mode,
      notification_id: notification.id,
      signal_type: notification.signal_type,
      source_session_id: notification.source_session_id,
      source_session_name: notification.source_session_name,
      state: notification.state,
      target_session_id: notification.target_session_id,
      target_session_name: notification.target_session_name,
    },
    kind: "routed_notification",
    source: "routed_notifications",
    source_id: notification.id,
    summary: (
      `dispatch notification ${notification.signal_type}: `
      + `${notification.state} via ${notification.delivery_mode ?? "unknown"}`
    ),
    timestamp: notification.delivered_at ?? notification.created_at,
  };
}

function notificationAcknowledgementEntry(acknowledgement: TaskAuditNotificationAcknowledgement): ReplayEntry {
  return {
    actor: acknowledgement.role,
    details: {
      acknowledgement_id: acknowledgement.id,
      correlation_id: acknowledgement.correlation_id,
      notification_id: acknowledgement.notification_id,
      payload: acknowledgement.payload,
      signal_type: acknowledgement.signal_type,
      status: acknowledgement.status,
    },
    kind: "notification_acknowledgement",
    source: "notification_acknowledgements",
    source_id: acknowledgement.id,
    summary: `${acknowledgement.role} acknowledged notification ${acknowledgement.notification_id}: ${acknowledgement.status}`,
    timestamp: acknowledgement.created_at,
  };
}

function correlationChainEntry(audit: TaskAuditResult, chain: TaskAuditCorrelationChain): ReplayEntry {
  const parts = [chain.command_type, chain.command_state];
  if (chain.command_id === null && chain.source_event_id !== undefined && chain.source_event_id !== null) {
    parts.push(`source event #${chain.source_event_id}`);
  }
  if (chain.manager_decision_id !== null) {
    parts.push(`decision #${chain.manager_decision_id}`);
  }
  if (chain.manager_cycle_id !== null) {
    parts.push(`cycle #${chain.manager_cycle_id}`);
  }
  if (chain.attempt_ids.length > 0) {
    parts.push(`${chain.attempt_ids.length} attempt(s)`);
  }
  if (chain.routed_notification_ids.length > 0) {
    parts.push(`${chain.routed_notification_ids.length} notification(s)`);
  }
  return {
    actor: "dispatch",
    details: chain as unknown as Record<string, unknown>,
    kind: "correlation_chain",
    source: "correlation_chains",
    source_id: chain.command_id ?? chain.correlation_id ?? chain.source_event_id ?? null,
    summary: parts.join(" -> "),
    timestamp: commandCreatedAt(audit, chain.command_id) ?? chain.created_at ?? audit.task.created_at,
  };
}

function managerDecisionEntry(decision: TaskAuditManagerDecision): ReplayEntry {
  return {
    actor: "manager",
    details: {
      decision: decision.decision,
      manager_cycle_id: decision.manager_cycle_id,
    },
    kind: "decision",
    source: "manager_decisions",
    source_id: decision.id,
    summary: `decision ${decision.decision}: ${shorten(decision.reason)}`,
    timestamp: decision.created_at,
  };
}

function commandCreatedAt(audit: TaskAuditResult, commandId: string | null): string | null {
  if (commandId === null) {
    return null;
  }
  return audit.commands.find((command) => command.id === commandId)?.created_at ?? null;
}

function commandSummary(command: CommandRecord): [string, string, string] {
  const payload = command.payload;
  const result = command.result ?? {};
  if (command.type === "promote") {
    return [
      "system",
      "command",
      `promoted worker ${payload.worker ?? result.worker} and launched manager ${result.manager_session}`,
    ];
  }
  if (command.type === "task_interrupt") {
    const followup = stringValue(result.followup ?? payload.followup) ?? "interrupt";
    return ["manager -> worker", "command", `sent interrupt: ${shorten(followup)}`];
  }
  if (command.type === "task_nudge") {
    const message = stringValue(result.message ?? payload.message) ?? "nudge";
    return ["manager -> worker", "command", `sent nudge: ${shorten(message)}`];
  }
  if (command.type === "finish_task") {
    const reason = stringValue(result.reason ?? payload.reason) ?? "task finished";
    const suffix = result.stop_manager ? "manager stopped" : "manager left open";
    return ["manager", "finish", `finished task: ${shorten(reason)} (${suffix})`];
  }
  if (command.type === "close_manager") {
    const reason = stringValue(result.reason ?? payload.reason) ?? "manager closed";
    return ["workerctl", "command", `closed manager: ${shorten(reason)}`];
  }
  return ["workerctl", "command", `${command.type} ${command.state}`];
}

function acceptanceCriterionSummary(event: TaskAuditEvent): string | null {
  const payload = event.payload;
  const criterionId = payload.criterion_id;
  const criterionLabel = criterionId !== undefined && criterionId !== null ? `#${criterionId}` : "<unknown>";
  const status = stringValue(payload.status);
  const criterion = stringValue(payload.criterion) ?? "";
  const previousStatus = stringValue(payload.previous_status);
  const transition = previousStatus && status ? ` (${previousStatus} -> ${status})` : "";
  if (event.type === "acceptance_criterion_added") {
    if (status === "proposed") {
      return `proposed criterion ${criterionLabel}: ${shorten(criterion)}`;
    }
    if (status === "accepted") {
      return `accepted criterion ${criterionLabel}: ${shorten(criterion)}`;
    }
    if (status === "satisfied") {
      const proof = stringValue(payload.proof);
      return proof
        ? `satisfied criterion ${criterionLabel}: proof recorded (${shorten(proof)})`
        : `satisfied criterion ${criterionLabel}: proof recorded`;
    }
    if (status === "deferred") {
      return `deferred criterion ${criterionLabel}: ${shorten(stringValue(payload.rationale) ?? criterion)}`;
    }
    if (status === "rejected") {
      return `rejected criterion ${criterionLabel}: ${shorten(stringValue(payload.rationale) ?? criterion)}`;
    }
    return `added ${status ?? "unknown"} criterion ${criterionLabel}: ${shorten(criterion)}`;
  }
  if (event.type !== "acceptance_criterion_updated") {
    return null;
  }
  if (status === "accepted") {
    return `accepted criterion ${criterionLabel}${transition}: ${shorten(criterion)}`;
  }
  if (status === "satisfied") {
    const proof = stringValue(payload.proof);
    return proof
      ? `satisfied criterion ${criterionLabel}${transition}: proof recorded (${shorten(proof)})`
      : `satisfied criterion ${criterionLabel}${transition}: proof recorded`;
  }
  if (status === "deferred") {
    return `deferred criterion ${criterionLabel}${transition}: ${shorten(
      stringValue(payload.rationale) ?? criterion,
    )}`;
  }
  if (status === "rejected") {
    return `rejected criterion ${criterionLabel}${transition}: ${shorten(
      stringValue(payload.rationale) ?? criterion,
    )}`;
  }
  const fallbackTransition = previousStatus ? `${previousStatus} -> ${status}` : status ?? "updated";
  return `updated criterion ${criterionLabel}: ${fallbackTransition}`;
}

function acceptanceCriterionDetails(event: TaskAuditEvent): Record<string, unknown> {
  const details: Record<string, unknown> = { event_type: event.type };
  const keys = [
    "criterion_id",
    "criterion",
    "status",
    "previous_status",
    "source",
    "task_id",
    "proof",
    "previous_proof",
    "rationale",
    "previous_rationale",
    "evidence",
    "previous_evidence",
    "created",
  ];
  for (const key of keys) {
    if (key in event.payload) {
      details[key] = event.payload[key];
    }
  }
  return details;
}

function roleIncludesActor(role: ReplayRole, actor: string): boolean {
  if (role === "all") {
    return true;
  }
  if (actor === role || actor === `manager -> ${role}` || actor === `${role} -> manager`) {
    return true;
  }
  return role === "manager" && (actor === "workerctl" || actor === "system");
}

function captureSummary(capture: Record<string, unknown>): string {
  const classifier = recordValue(capture.classifier);
  const busyWait = recordValue(classifier?.busy_wait);
  const startup = Array.isArray(classifier?.startup) ? classifier.startup : null;
  const parts: string[] = [];
  const pattern = stringValue(busyWait?.pattern);
  if (pattern) {
    if (pattern === "rate_limit_prompt") {
      parts.push("waiting_for_model_choice");
    } else if (pattern !== "approval_prompt") {
      parts.push(`busy_wait=${pattern}`);
    }
  }
  if (startup && startup.length > 0) {
    parts.push(`startup=${String(startup[0])}`);
  }
  if (parts.length === 0) {
    parts.push(`${Number(capture.line_count ?? 0)} lines`);
  }
  return parts.join(", ");
}

function captureExcerpt(capture: Record<string, unknown>): string | null {
  const content = stringValue(capture.content);
  if (!content) {
    return null;
  }
  const lines = content.split(/\r\n|\r|\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  const interesting = lines.slice(-12).map((line) => line.trim()).filter((line) => (
    line.startsWith("•")
    || line.startsWith("›")
    || line.startsWith(">")
    || line.startsWith("Ran ")
    || line.startsWith("Edited ")
    || line.startsWith("Added ")
    || line.startsWith("Built ")
    || line.startsWith("Task is complete")
  ));
  return shorten((interesting.length > 0 ? interesting : lines.slice(-4)).join(" / "), 320);
}

function sourceId(value: unknown): number | string | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function shorten(value: string, maxLength = 220): string {
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
