import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { taskAuditSync } from "./audit.js";
import type { TaskAuditResult } from "./audit.js";
import { managerConfigSync } from "./manager-config.js";
import { replayEntriesFromAudit } from "./replay.js";

export interface TaskExportManifest {
  created_at: string;
  files: string[];
  task: {
    id: string;
    name: string;
  };
}

export interface TaskExportResult {
  archive: string | null;
  export_dir: string;
  manifest: TaskExportManifest;
  task: string;
}

export class TaskExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExportError";
  }
}

export function exportTaskSync(
  database: DatabaseSync,
  options: {
    includeFullTranscripts?: boolean;
    includeTranscripts?: boolean;
    now?: string;
    outputDir: string;
    task: string;
    zip?: boolean;
  },
): TaskExportResult {
  const audit = taskAuditSync(database, options.task);
  const snapshot = taskStatusSnapshotSync(database, audit.task.id);
  const telemetryEvents = telemetryEventsForTaskSync(database, audit.task.id);
  const telemetrySummary = telemetrySummarySync(telemetryEvents);
  const replay = {
    entries: replayEntriesFromAudit(audit, { mode: "timeline", role: "all" }),
    mode: "timeline",
    role: "all",
    task: audit.task,
  };
  const fullReplay = options.includeFullTranscripts
    ? {
        entries: replayEntriesFromAudit(audit, { mode: "full-transcript", role: "all" }),
        mode: "full-transcript",
        role: "all",
        task: audit.task,
      }
    : null;
  const exportDir = resolve(options.outputDir);
  mkdirSync(exportDir, { recursive: true });
  const files = [
    "task-status.json",
    "audit.json",
    "acceptance-criteria.json",
    "prompts.json",
    "transcript-captures.json",
    "terminal-captures.json",
    "agent-observations.json",
    "manager-cycles.json",
    "manager-cycle-spans.json",
    "manager-decisions.json",
    "mutation-audit.json",
    "replay.json",
    "telemetry-events.json",
    "telemetry-summary.json",
    "telemetry-report.md",
  ];
  if (options.includeTranscripts || options.includeFullTranscripts) {
    files.push("transcript-segments.json");
  }
  if (options.includeFullTranscripts) {
    files.push("replay-full-transcript.json", "transcripts/worker.txt", "transcripts/manager.txt");
  }
  const payloads: Record<string, unknown> = {
    "acceptance-criteria.json": audit.acceptance_criteria,
    "agent-observations.json": audit.agent_observations,
    "audit.json": redactAuditForExport(audit),
    "manager-cycle-spans.json": audit.manager_cycle_spans,
    "manager-cycles.json": audit.manager_cycles,
    "manager-decisions.json": audit.manager_decisions,
    "mutation-audit.json": mutationAuditResultSync(audit),
    "prompts.json": promptRecordsForTaskSync(database, audit.task.id),
    "replay-full-transcript.json": fullReplay,
    "replay.json": replay,
    "task-status.json": snapshot,
    "telemetry-events.json": telemetryEvents,
    "telemetry-summary.json": telemetrySummary,
    "terminal-captures.json": redactTerminalCaptures(audit.terminal_captures),
    "transcript-captures.json": transcriptCaptureRecordsForTaskSync(database, audit.task.id),
    "transcript-segments.json": audit.transcript_segments,
  };
  for (const file of files) {
    if (file.endsWith(".json")) {
      writeJson(`${exportDir}/${file}`, payloads[file]);
    } else if (file === "telemetry-report.md") {
      writeText(`${exportDir}/${file}`, telemetryReportMarkdown({
        events: telemetryEvents,
        summary: telemetrySummary,
        task: audit.task,
      }));
    } else if (file.startsWith("transcripts/")) {
      const role = file.includes("worker") ? "worker" : "manager";
      writeText(`${exportDir}/${file}`, transcriptText(audit, role));
    }
  }
  const manifest = {
    created_at: options.now ?? new Date().toISOString(),
    files,
    task: {
      id: audit.task.id,
      name: audit.task.name,
    },
  };
  writeJson(`${exportDir}/manifest.json`, manifest);
  const archive = options.zip ? `${exportDir}.zip` : null;
  if (archive) {
    writeZip(archive, [...files, "manifest.json"].map((file) => ({
      data: readFileSync(`${exportDir}/${file}`),
      name: file,
    })));
  }
  return {
    archive,
    export_dir: exportDir,
    manifest,
    task: audit.task.name,
  };
}

export function exportTaskAuditSubsetSync(
  database: DatabaseSync,
  options: {
    now?: string;
    outputDir: string;
    task: string;
  },
): TaskExportResult {
  const audit = taskAuditSync(database, options.task);
  const exportDir = resolve(options.outputDir);
  mkdirSync(exportDir, { recursive: true });
  const files = [
    "task-status.json",
    "audit.json",
    "acceptance-criteria.json",
    "commands.json",
    "command-attempts.json",
    "routed-notifications.json",
    "manager-decisions.json",
    "correlation-chains.json",
  ];
  const payloads: Record<string, unknown> = {
    "acceptance-criteria.json": audit.acceptance_criteria,
    "audit.json": redactAuditForExport(audit),
    "command-attempts.json": audit.command_attempts,
    "commands.json": audit.commands,
    "correlation-chains.json": audit.correlation_chains,
    "manager-decisions.json": audit.manager_decisions,
    "routed-notifications.json": audit.routed_notifications,
    "task-status.json": taskStatusPayload(audit),
  };
  for (const file of files) {
    writeJson(`${exportDir}/${file}`, payloads[file]);
  }
  const manifest = {
    created_at: options.now ?? new Date().toISOString(),
    files,
    task: {
      id: audit.task.id,
      name: audit.task.name,
    },
  };
  writeJson(`${exportDir}/manifest.json`, manifest);
  return {
    archive: null,
    export_dir: exportDir,
    manifest,
    task: audit.task.name,
  };
}

function taskStatusPayload(audit: TaskAuditResult): Record<string, unknown> {
  return {
    created_at: audit.task.created_at,
    goal: audit.task.goal,
    id: audit.task.id,
    name: audit.task.name,
    state: audit.task.state,
    summary: audit.task.summary,
    updated_at: audit.task.updated_at,
  };
}

function taskStatusSnapshotSync(database: DatabaseSync, task: string): Record<string, unknown> {
  const taskRow = database.prepare(`
    select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
           tasks.created_at, tasks.updated_at,
           budgets.max_nudges, budgets.nudges_used, budgets.expires_at
    from tasks
    left join budgets on budgets.task_id = tasks.id
    where tasks.id = ? or tasks.name = ?
    order by tasks.created_at desc
    limit 1
  `).get(task, task) as {
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
  } | undefined;
  if (!taskRow) {
    throw new TaskExportError(`Unknown task: ${task}`);
  }
  const worker = taskStatusWorkerSync(database, taskRow.id);
  const manager = taskStatusManagerSync(database, taskRow.id);
  const integrityIssues: string[] = [];
  if (taskRow.state === "managed" && worker === null) {
    integrityIssues.push("managed_without_active_worker_binding");
  }
  if (taskRow.state === "managed" && manager === null) {
    integrityIssues.push("managed_without_active_manager");
  }
  if (taskRow.state === "failed" && manager !== null) {
    integrityIssues.push("closed_task_has_active_manager");
  }
  return {
    budget: taskRow.max_nudges === null ? null : {
      expires_at: taskRow.expires_at,
      max_nudges: taskRow.max_nudges,
      nudges_remaining: taskRow.max_nudges - (taskRow.nudges_used ?? 0),
      nudges_used: taskRow.nudges_used ?? 0,
    },
    created_at: taskRow.created_at,
    goal: taskRow.goal,
    id: taskRow.id,
    integrity: {
      issues: integrityIssues,
      ok: integrityIssues.length === 0,
    },
    manager,
    manager_config: managerConfigSync(database, taskRow.id),
    name: taskRow.name,
    state: taskRow.state,
    summary: taskRow.summary,
    updated_at: taskRow.updated_at,
    worker,
    worker_handoff: latestWorkerHandoffSync(database, taskRow.id),
    worker_status: worker === null ? null : latestWorkerStatusSync(database, String(worker.id)),
  };
}

function taskStatusWorkerSync(database: DatabaseSync, taskId: string): Record<string, unknown> | null {
  const row = database.prepare(`
    select bindings.id, bindings.state, bindings.created_at,
           workers.id as worker_id, workers.name as worker_name,
           workers.tmux_session, workers.tmux_pane_id, workers.state as worker_state,
           workers.cwd
    from bindings
    join workers on workers.id = bindings.worker_id
    where bindings.task_id = ? and bindings.state in ('active', 'ending')
    order by bindings.created_at desc
    limit 1
  `).get(taskId) as {
    created_at: string;
    cwd: string;
    id: string;
    state: string;
    tmux_pane_id: string | null;
    tmux_session: string;
    worker_id: string;
    worker_name: string;
    worker_state: string;
  } | undefined;
  if (!row) {
    return null;
  }
  return {
    binding_id: row.id,
    binding_state: row.state,
    cwd: row.cwd,
    id: row.worker_id,
    name: row.worker_name,
    state: row.worker_state,
    tmux_pane_id: row.tmux_pane_id,
    tmux_session: row.tmux_session,
  };
}

function latestWorkerStatusSync(database: DatabaseSync, workerId: string): Record<string, unknown> | null {
  const row = database.prepare(`
    select state, current_task, next_action, blocker, created_at
    from statuses
    where worker_id = ?
    order by id desc
    limit 1
  `).get(workerId) as {
    blocker: string | null;
    created_at: string;
    current_task: string | null;
    next_action: string | null;
    state: string;
  } | undefined;
  if (!row) {
    return null;
  }
  return {
    blocker: row.blocker,
    current_task: row.current_task,
    last_update: row.created_at,
    next_action: row.next_action,
    state: row.state,
  };
}

function taskStatusManagerSync(database: DatabaseSync, taskId: string): Record<string, unknown> | null {
  const row = database.prepare(`
    select id, name, tmux_session, tmux_pane_id, state, codex_args_json, started_at,
           stopped_at, last_seen_at, exit_detected_at, exit_reason
    from managers
    where task_id = ? and state in ('starting', 'ready', 'stopping')
    order by started_at desc
    limit 1
  `).get(taskId) as {
    codex_args_json: string;
    exit_detected_at: string | null;
    exit_reason: string | null;
    id: string;
    last_seen_at: string | null;
    name: string;
    started_at: string;
    state: string;
    stopped_at: string | null;
    tmux_pane_id: string | null;
    tmux_session: string;
  } | undefined;
  if (!row) {
    return null;
  }
  return {
    codex_args: JSON.parse(row.codex_args_json),
    exit_detected_at: row.exit_detected_at,
    exit_reason: row.exit_reason,
    id: row.id,
    last_seen_at: row.last_seen_at,
    name: row.name,
    started_at: row.started_at,
    state: row.state,
    stopped_at: row.stopped_at,
    task_id: taskId,
    tmux_pane_id: row.tmux_pane_id,
    tmux_session: row.tmux_session,
  };
}

function latestWorkerHandoffSync(database: DatabaseSync, taskId: string): Record<string, unknown> | null {
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

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(sortJson(value), null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
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

function promptRecordsForTaskSync(database: DatabaseSync, taskId: string): Record<string, unknown>[] {
  const rows = database.prepare(`
    select id, kind, content, content_sha256, generator_version,
           source_snapshot_json, policy_json, artifact_path, created_at
    from prompts
    where task_id = ?
    order by id
  `).all(taskId) as Array<Record<string, unknown> & { policy_json: string; source_snapshot_json: string }>;
  return rows.map((row) => parseJsonColumns(row, {
    policy_json: "policy",
    source_snapshot_json: "source_snapshot",
  }));
}

function transcriptCaptureRecordsForTaskSync(database: DatabaseSync, taskId: string): Record<string, unknown>[] {
  const rows = database.prepare(`
    select transcript_captures.*
    from transcript_captures
    join bindings on bindings.worker_id = transcript_captures.worker_id
    where bindings.task_id = ?
      and transcript_captures.captured_at >= bindings.created_at
      and (bindings.ended_at is null or transcript_captures.captured_at <= bindings.ended_at)
    order by transcript_captures.id
  `).all(taskId) as Record<string, unknown>[];
  return redactTranscriptCaptures(rows);
}

function telemetryEventsForTaskSync(database: DatabaseSync, taskId: string): Record<string, unknown>[] {
  const rows = database.prepare(`
    select id, run_id, task_id, timestamp, actor, event_type, severity,
           summary, correlation_json, attributes_json
    from telemetry_events
    where task_id = ?
    order by timestamp, rowid
    limit 10000
  `).all(taskId) as Array<Record<string, unknown> & { attributes_json: string; correlation_json: string }>;
  return rows.map((row) => parseJsonColumns(row, {
    attributes_json: "attributes",
    correlation_json: "correlation",
  }));
}

function telemetrySummarySync(events: Record<string, unknown>[]): Record<string, unknown> {
  const runIds = new Set(events.map((event) => event.run_id).filter((value) => value !== null && value !== undefined));
  const taskIds = new Set(events.map((event) => event.task_id).filter((value) => value !== null && value !== undefined));
  return {
    by_actor: countBy(events, "actor"),
    by_event_type: countBy(events, "event_type"),
    by_severity: countBy(events, "severity"),
    first_timestamp: typeof events[0]?.timestamp === "string" ? events[0].timestamp : null,
    last_timestamp: typeof events.at(-1)?.timestamp === "string" ? events.at(-1)?.timestamp : null,
    run_id: runIds.size === 1 ? Array.from(runIds)[0] : null,
    task_id: taskIds.size === 1 ? Array.from(taskIds)[0] : null,
    total: events.length,
  };
}

function telemetryReportMarkdown(options: {
  events: Record<string, unknown>[];
  summary: Record<string, unknown>;
  task: TaskAuditResult["task"];
}): string {
  const byEventType = isRecord(options.summary.by_event_type) ? options.summary.by_event_type : {};
  const lines = [
    `# Telemetry Report: ${options.task.name}`,
    "",
    `- Task ID: \`${options.task.id}\``,
    `- Total events: ${String(options.summary.total ?? 0)}`,
    `- First event: ${String(options.summary.first_timestamp ?? "null")}`,
    `- Last event: ${String(options.summary.last_timestamp ?? "null")}`,
    "",
    "## Event Types",
  ];
  for (const [eventType, count] of Object.entries(byEventType).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`- \`${eventType}\`: ${String(count)}`);
  }
  lines.push("", "## Timeline");
  for (const event of options.events) {
    lines.push(
      `- ${String(event.timestamp)} \`${String(event.actor)}\` \`${String(event.event_type)}\` `
      + `[${String(event.severity)}]: ${String(event.summary)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function transcriptText(audit: TaskAuditResult, role: "manager" | "worker"): string {
  const lines: string[] = [];
  for (const segment of audit.transcript_segments) {
    if (segment.role !== role) {
      continue;
    }
    lines.push(`--- ${role} segment ${String(segment.id)} ${String(segment.captured_at)} (${String(segment.segment_kind)}) ---`);
    lines.push(typeof segment.segment_text === "string" && segment.segment_text ? segment.segment_text : "[metadata only]");
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function redactAuditForExport(audit: TaskAuditResult): TaskAuditResult {
  return {
    ...audit,
    terminal_captures: redactTerminalCaptures(audit.terminal_captures),
    transcript_segments: redactTranscriptSegments(audit.transcript_segments),
  };
}

function redactTerminalCaptures(captures: Record<string, unknown>[]): Record<string, unknown>[] {
  return captures.map((capture) => {
    const { content, ...rest } = capture;
    if (typeof content !== "string") {
      return rest;
    }
    return {
      ...rest,
      content_byte_count: Buffer.byteLength(content),
      content_line_count: splitlinesCount(content),
      content_redacted: true,
    };
  });
}

function redactTranscriptCaptures(captures: Record<string, unknown>[]): Record<string, unknown>[] {
  return captures.map((capture) => {
    const { content, ...rest } = capture;
    if (typeof content !== "string") {
      return rest;
    }
    return {
      ...rest,
      content_byte_count: Buffer.byteLength(content),
      content_line_count: splitlinesCount(content),
      content_redacted: true,
    };
  });
}

function redactTranscriptSegments(segments: Record<string, unknown>[]): Record<string, unknown>[] {
  return segments.map((segment) => {
    const { segment_text: segmentText, ...rest } = segment;
    if (typeof segmentText !== "string") {
      return rest;
    }
    return {
      ...rest,
      segment_text_byte_count: Buffer.byteLength(segmentText),
      segment_text_line_count: splitlinesCount(segmentText),
      segment_text_redacted: true,
    };
  });
}

function splitlinesCount(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const lineBreaks = value.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/(?:\r\n|\r|\n)$/.test(value) ? 0 : 1);
}

function mutationAuditResultSync(audit: TaskAuditResult): Record<string, unknown> {
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
    let managerDecision = isRecord(result.manager_decision)
      ? result.manager_decision
      : (isRecord(payload.manager_decision) ? payload.manager_decision : null);
    if (command.type === "finish_task" && typeof result.final_decision_id === "number" && decisionsById.has(result.final_decision_id)) {
      managerDecision = { decision: decisionsById.get(result.final_decision_id), warnings: [] };
    }
    const linkedDecision = linkedDecisionFromCheck(managerDecision, decisionsById);
    const nearest = audit.manager_decisions.filter((decision) => decision.created_at <= command.created_at).at(-1) ?? null;
    const warnings: string[] = [];
    const expectedFailure = Boolean(result.expected_failure ?? payload.expected_failure);
    if (!(expectedFailure && command.state === "failed")) {
      if (allowed.length === 0) {
        if (linkedDecision) warnings.push("unexpected_linked_decision");
      } else if (managerDecision) {
        const checkWarnings = Array.isArray(managerDecision.warnings) ? managerDecision.warnings.map(String) : [];
        warnings.push(...checkWarnings);
      } else {
        warnings.push("missing_decision_metadata");
      }
      if (allowed.length > 0 && nearest && !linkedDecision) {
        warnings.push("nearest_decision_unlinked");
      }
      if (allowed.length > 0 && linkedDecision && !allowed.includes(String(linkedDecision.decision))) {
        warnings.push("linked_decision_incompatible");
      }
    }
    return [{
      allowed_decisions: allowed,
      command: { created_at: command.created_at, id: command.id, state: command.state, type: command.type },
      effect: {
        dry_run: isRecord(result.send_result) ? Boolean(result.send_result.dry_run) : false,
        permission_check: result.permission_check ?? payload.permission_check,
        send_text: result.send_text ?? payload.send_text,
        sent: command.state === "succeeded" && isRecord(result.send_result) && !result.send_result.dry_run,
        slash_command: "slash_command" in result ? result.slash_command : payload.slash_command,
        worker_session: result.worker_session ?? payload.worker_session,
      },
      expected_failure: expectedFailure,
      linked_decision: linkedDecision,
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

function linkedDecisionFromCheck(
  value: Record<string, unknown> | null,
  decisionsById: Map<number, TaskAuditResult["manager_decisions"][number]>,
): TaskAuditResult["manager_decisions"][number] | Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  const decision = isRecord(value.decision) ? value.decision : value;
  const id = typeof value.decision_id === "number" ? value.decision_id : (typeof decision.id === "number" ? decision.id : null);
  if (id !== null && decisionsById.has(id)) {
    return decisionsById.get(id) ?? null;
  }
  return isRecord(decision) && typeof decision.decision === "string" ? decision : null;
}

function countBy(rows: Record<string, unknown>[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function parseJsonColumns(
  row: Record<string, unknown>,
  columns: Record<string, string>,
): Record<string, unknown> {
  const parsed = { ...row };
  for (const [column, key] of Object.entries(columns)) {
    const value = row[column];
    delete parsed[column];
    parsed[key] = typeof value === "string" ? JSON.parse(value) : null;
  }
  return parsed;
}

function writeZip(path: string, entries: Array<{ data: Buffer; name: string }>): void {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    chunks.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralDirectory.push(central);
    offset += local.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(...centralDirectory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  chunks.push(end);
  writeFileSync(path, Buffer.concat(chunks));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
