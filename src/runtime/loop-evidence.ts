import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { computeVisualDiffSync } from "./visual-diff.js";
import type { VisualDiffReport } from "./visual-diff.js";

export type AcceptanceCriterionStatus = "accepted" | "deferred" | "proposed" | "rejected" | "satisfied";
export type AcceptanceCriterionSource = "final_audit" | "manager_inferred" | "user_requested" | "worker_proposed";

export interface AcceptanceCriterionRecord {
  created_at: string;
  criterion: string;
  evidence: Record<string, unknown>;
  id: number;
  proof: string | null;
  rationale: string | null;
  source: AcceptanceCriterionSource;
  status: AcceptanceCriterionStatus;
  task_id: string;
  updated_at: string;
}

export interface RalphLoopRunRecord {
  cleanup_policy: string | null;
  current_iteration: number;
  id: string;
  max_iterations: number;
  metadata: Record<string, unknown>;
  name: string;
  preset: string | null;
  required_before_continue: string[];
  seed_prompt_sha256: string | null;
  stop_conditions: string[];
  task_id: string;
}

export interface LoopEvidenceRecordResult {
  criterion: AcceptanceCriterionRecord;
  evidence: Record<string, unknown>;
  run: RalphLoopRunRecord;
}

export interface VisualDiffLoopEvidenceResult {
  criterion: AcceptanceCriterionRecord;
  diff: VisualDiffReport;
  evidence: Record<string, unknown>;
  threshold_criterion: AcceptanceCriterionRecord;
}

export class LoopEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopEvidenceError";
  }
}

export function loopEvidenceCriterion(runId: string, iteration: number, evidenceType: string): string {
  return `Ralph loop ${runId} iteration ${iteration} ${evidenceType} evidence`;
}

export function recordLoopEvidenceSync(
  database: DatabaseSync,
  options: {
    artifactPath?: string | null;
    correlationId?: string | null;
    evidenceType: string;
    iteration: number;
    loopRunId: string;
    metadata?: Record<string, unknown> | null;
    now?: string;
    proof?: string | null;
    source?: AcceptanceCriterionSource;
    status?: string;
    task: string;
  },
): LoopEvidenceRecordResult {
  if (options.iteration < 1) {
    throw new LoopEvidenceError("--iteration must be at least 1");
  }
  const evidenceType = options.evidenceType.trim();
  if (!evidenceType) {
    throw new LoopEvidenceError("--evidence-type must be non-empty");
  }
  const metadata = evidenceType === "adversarial_check"
    ? adversarialCheckMetadata(options.metadata ?? {})
    : { ...(options.metadata ?? {}) };
  const task = taskRowSync(database, options.task);
  const run = ralphLoopRunForTaskSync(database, { loopRunId: options.loopRunId, task });
  const status = options.status ?? "pass";
  const criterionStatus = loopEvidenceCriterionStatus(status);
  const evidence: Record<string, unknown> = {
    ...metadata,
    evidence_type: evidenceType,
    iteration: options.iteration,
    ralph_loop_run_id: run.id,
    status,
  };
  if (options.artifactPath) {
    evidence.artifact_path = String(options.artifactPath);
  }
  if (options.correlationId) {
    evidence.correlation_id = options.correlationId;
  }
  const criterionText = loopEvidenceCriterion(run.id, options.iteration, evidenceType);
  const existing = acceptanceCriteriaForTaskSync(database, { taskId: task.id })
    .filter((criterion) => criterion.criterion === criterionText);
  let criterion: AcceptanceCriterionRecord | null = null;
  if (existing.length === 0) {
    const criterionId = insertAcceptanceCriterionSync(database, {
      criterion: criterionText,
      evidence,
      now: options.now,
      proof: options.proof ?? `${evidenceType} evidence recorded for Ralph loop ${run.id} iteration ${options.iteration}.`,
      source: options.source ?? "manager_inferred",
      status: criterionStatus,
      taskId: task.id,
    });
    criterion = acceptanceCriteriaForTaskSync(database, { taskId: task.id }).find((row) => row.id === criterionId) ?? null;
    if (!criterion) {
      throw new LoopEvidenceError(`Unknown acceptance criterion: ${criterionId}`);
    }
    insertAcceptanceCriterionEventSync(database, {
      criterion,
      created: true,
      eventType: "acceptance_criterion_added",
      now: options.now,
      taskId: task.id,
    });
  } else {
    for (const previous of existing) {
      criterion = updateAcceptanceCriterionSync(database, {
        criterionId: previous.id,
        evidence,
        now: options.now,
        proof: options.proof ?? previous.proof,
        status: criterionStatus,
      });
      insertAcceptanceCriterionEventSync(database, {
        criterion,
        eventType: "acceptance_criterion_updated",
        now: options.now,
        previous,
        taskId: task.id,
      });
    }
  }
  if (!criterion) {
    throw new LoopEvidenceError("failed to record loop evidence");
  }
  return { criterion, evidence, run };
}

export function recordAdversarialLoopEvidenceSync(
  database: DatabaseSync,
  options: {
    artifactPath?: string | null;
    check: string;
    correlationId?: string | null;
    failureMode: string;
    iteration: number;
    loopRunId: string;
    now?: string;
    result: string;
    source?: AcceptanceCriterionSource;
    status?: string;
    task: string;
  },
): LoopEvidenceRecordResult {
  const metadata = adversarialCheckMetadata({
    check: options.check,
    failure_mode: options.failureMode,
    result: options.result,
  });
  return recordLoopEvidenceSync(database, {
    artifactPath: options.artifactPath,
    correlationId: options.correlationId,
    evidenceType: "adversarial_check",
    iteration: options.iteration,
    loopRunId: options.loopRunId,
    metadata,
    now: options.now,
    proof: `Adversarial check: ${metadata.failure_mode} -> ${metadata.result}`,
    source: options.source,
    status: options.status,
    task: options.task,
  });
}

export function recordVisualDiffLoopEvidenceSync(
  database: DatabaseSync,
  options: {
    candidatePath: string;
    correlationId?: string | null;
    diffOutput?: string | null;
    iteration: number;
    loopRunId: string;
    now?: string;
    referencePath: string;
    reportOutput?: string | null;
    source?: AcceptanceCriterionSource;
    task: string;
    threshold: number;
  },
): VisualDiffLoopEvidenceResult {
  const task = taskRowSync(database, options.task);
  ralphLoopRunForTaskSync(database, { loopRunId: options.loopRunId, task });
  const report = computeVisualDiffSync({
    candidatePath: options.candidatePath,
    diffOutput: options.diffOutput,
    referencePath: options.referencePath,
    reportOutput: options.reportOutput,
    threshold: options.threshold,
  });
  const reportResult = recordLoopEvidenceSync(database, {
    artifactPath: options.reportOutput,
    correlationId: options.correlationId,
    evidenceType: "visual_diff_report",
    iteration: options.iteration,
    loopRunId: options.loopRunId,
    metadata: { ...report },
    now: options.now,
    proof: "Visual diff report recorded.",
    source: options.source,
    status: "pass",
    task: task.id,
  });
  const thresholdStatus = report.below_threshold ? "pass" : "fail";
  const thresholdProof = report.below_threshold
    ? `Visual diff score ${formatNumber(report.diff_score)} is at or below threshold ${formatNumber(report.threshold)}.`
    : `Visual diff score ${formatNumber(report.diff_score)} exceeds threshold ${formatNumber(report.threshold)}.`;
  const thresholdResult = recordLoopEvidenceSync(database, {
    artifactPath: options.reportOutput,
    correlationId: options.correlationId,
    evidenceType: "diff_below_threshold",
    iteration: options.iteration,
    loopRunId: options.loopRunId,
    metadata: { ...report },
    now: options.now,
    proof: thresholdProof,
    source: options.source,
    status: thresholdStatus,
    task: task.id,
  });
  return {
    criterion: reportResult.criterion,
    diff: report,
    evidence: reportResult.evidence,
    threshold_criterion: thresholdResult.criterion,
  };
}

export function acceptanceCriteriaForTaskSync(
  database: DatabaseSync,
  options: {
    statuses?: AcceptanceCriterionStatus[];
    taskId: string;
  },
): AcceptanceCriterionRecord[] {
  const params: string[] = [options.taskId];
  let where = "where task_id = ?";
  if (options.statuses !== undefined) {
    if (options.statuses.length === 0) {
      return [];
    }
    for (const status of options.statuses) {
      validateAcceptanceCriterionStatus(status);
    }
    where += ` and status in (${options.statuses.map(() => "?").join(", ")})`;
    params.push(...options.statuses);
  }
  const rows = database.prepare(`
    select id, task_id, criterion, status, source, proof, rationale,
           evidence_json, created_at, updated_at
    from acceptance_criteria
    ${where}
    order by id
  `).all(...params) as unknown as AcceptanceCriterionRow[];
  return rows.map(acceptanceCriterionRecord);
}

function insertAcceptanceCriterionSync(
  database: DatabaseSync,
  options: {
    criterion: string;
    evidence: Record<string, unknown>;
    now?: string;
    proof: string | null;
    rationale?: string | null;
    source: AcceptanceCriterionSource;
    status: AcceptanceCriterionStatus;
    taskId: string;
  },
): number {
  validateAcceptanceCriterionStatus(options.status);
  validateAcceptanceCriterionSource(options.source);
  const existing = database.prepare(`
    select id
    from acceptance_criteria
    where task_id = ? and source = ? and criterion = ?
  `).get(options.taskId, options.source, options.criterion) as { id: number } | undefined;
  if (existing) {
    return existing.id;
  }
  const timestamp = options.now ?? new Date().toISOString();
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
    options.rationale ?? null,
    stableJson(options.evidence),
    timestamp,
    timestamp,
  );
  const criterionId = Number(result.lastInsertRowid);
  emitTelemetry(database, {
    attributes: {
      criterion: options.criterion,
      has_evidence: true,
      has_proof: options.proof !== null,
      status: options.status,
    },
    correlation: {
      criterion_id: criterionId,
      source: options.source,
    },
    eventType: "acceptance_criterion_added",
    summary: "Added acceptance criterion.",
    taskId: options.taskId,
    timestamp,
  });
  return criterionId;
}

function updateAcceptanceCriterionSync(
  database: DatabaseSync,
  options: {
    criterionId: number;
    evidence: Record<string, unknown>;
    now?: string;
    proof: string | null;
    rationale?: string | null;
    status: AcceptanceCriterionStatus;
  },
): AcceptanceCriterionRecord {
  validateAcceptanceCriterionStatus(options.status);
  const existing = database.prepare(`
    select id, task_id, criterion, status, source, proof, rationale,
           evidence_json, created_at, updated_at
    from acceptance_criteria
    where id = ?
  `).get(options.criterionId) as AcceptanceCriterionRow | undefined;
  if (!existing) {
    throw new LoopEvidenceError(`Unknown acceptance criterion: ${options.criterionId}`);
  }
  const timestamp = options.now ?? new Date().toISOString();
  database.prepare(`
    update acceptance_criteria
    set status = ?, evidence_json = ?, proof = ?, rationale = ?, updated_at = ?
    where id = ?
  `).run(
    options.status,
    stableJson(options.evidence),
    options.proof,
    options.rationale ?? existing.rationale,
    timestamp,
    options.criterionId,
  );
  const updated = database.prepare(`
    select id, task_id, criterion, status, source, proof, rationale,
           evidence_json, created_at, updated_at
    from acceptance_criteria
    where id = ?
  `).get(options.criterionId) as AcceptanceCriterionRow | undefined;
  if (!updated) {
    throw new LoopEvidenceError(`Unknown acceptance criterion: ${options.criterionId}`);
  }
  const record = acceptanceCriterionRecord(updated);
  emitTelemetry(database, {
    attributes: {
      criterion: record.criterion,
      has_evidence: true,
      has_proof: record.proof !== null,
      previous_status: existing.status,
      status: record.status,
    },
    correlation: {
      criterion_id: record.id,
      source: record.source,
    },
    eventType: "acceptance_criterion_updated",
    summary: "Updated acceptance criterion.",
    taskId: record.task_id,
    timestamp,
  });
  return record;
}

function loopEvidenceCriterionStatus(status: string): AcceptanceCriterionStatus {
  const normalized = status.trim().toLowerCase();
  if (new Set(["green", "ok", "pass", "passed", "satisfied", "success", "succeeded"]).has(normalized)) {
    return "satisfied";
  }
  return "rejected";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : `${value.toPrecision(6)}`.replace(/\.?0+$/, "");
}

function adversarialCheckMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const values = { ...metadata };
  for (const [key, flag] of [
    ["failure_mode", "--failure-mode"],
    ["check", "--check"],
    ["result", "--result"],
  ] as const) {
    const value = typeof values[key] === "string" ? values[key].trim() : "";
    if (!value) {
      throw new LoopEvidenceError(`${flag} must be non-empty`);
    }
    values[key] = value;
  }
  return values;
}

function taskRowSync(database: DatabaseSync, task: string): { id: string; name: string } {
  const row = database.prepare(`
    select id, name
    from tasks
    where id = ? or name = ?
    limit 1
  `).get(task, task) as { id: string; name: string } | undefined;
  if (!row) {
    throw new LoopEvidenceError(`Unknown task: ${task}`);
  }
  return row;
}

function ralphLoopRunForTaskSync(
  database: DatabaseSync,
  options: {
    loopRunId: string;
    task: { id: string; name: string };
  },
): RalphLoopRunRecord {
  const run = ralphLoopRunSync(database, options.loopRunId);
  if (run.task_id !== options.task.id) {
    throw new LoopEvidenceError(`loop run ${JSON.stringify(options.loopRunId)} does not belong to task ${JSON.stringify(options.task.name)}`);
  }
  return run;
}

function ralphLoopRunSync(database: DatabaseSync, runId: string): RalphLoopRunRecord {
  const row = database.prepare(`
    select id, task_id, name, purpose, metadata_json
    from runs
    where id = ?
  `).get(runId) as { id: string; metadata_json: string; name: string; purpose: string | null; task_id: string } | undefined;
  if (!row) {
    throw new LoopEvidenceError(`Unknown run: ${runId}`);
  }
  const metadata = parseJsonObject(row.metadata_json);
  if (metadata.kind !== "ralph_loop" && row.purpose !== "ralph_loop") {
    throw new LoopEvidenceError(`Run ${JSON.stringify(runId)} is not a Ralph loop run`);
  }
  const currentIteration = integerMetadata(metadata.current_iteration);
  const maxIterations = integerMetadata(metadata.max_iterations);
  if (currentIteration === null || maxIterations === null) {
    throw new LoopEvidenceError(`Ralph loop run ${JSON.stringify(runId)} is missing iteration policy`);
  }
  return {
    cleanup_policy: typeof metadata.cleanup_policy === "string" ? metadata.cleanup_policy : null,
    current_iteration: currentIteration,
    id: row.id,
    max_iterations: maxIterations,
    metadata,
    name: row.name,
    preset: typeof metadata.preset === "string" ? metadata.preset : null,
    required_before_continue: stringList(metadata.required_before_continue),
    seed_prompt_sha256: typeof metadata.seed_prompt_sha256 === "string" ? metadata.seed_prompt_sha256 : null,
    stop_conditions: stringList(metadata.stop_conditions),
    task_id: row.task_id,
  };
}

function insertAcceptanceCriterionEventSync(
  database: DatabaseSync,
  options: {
    created?: boolean;
    criterion: AcceptanceCriterionRecord;
    eventType: "acceptance_criterion_added" | "acceptance_criterion_updated";
    now?: string;
    previous?: AcceptanceCriterionRecord;
    taskId: string;
  },
): void {
  const payload: Record<string, unknown> = {
    criterion: options.criterion.criterion,
    criterion_id: options.criterion.id,
    evidence: options.criterion.evidence,
    proof: options.criterion.proof,
    rationale: options.criterion.rationale,
    source: options.criterion.source,
    status: options.criterion.status,
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
  database.prepare(`
    insert into events(created_at, actor, command_id, correlation_id, task_id, worker_id, manager_id, type, payload_json)
    values (?, 'workerctl', null, null, ?, null, null, ?, ?)
  `).run(
    options.now ?? new Date().toISOString(),
    options.taskId,
    options.eventType,
    stableJson(payload),
  );
}

function emitTelemetry(
  database: DatabaseSync,
  options: {
    attributes: Record<string, unknown>;
    correlation: Record<string, unknown>;
    eventType: string;
    summary: string;
    taskId: string;
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
    values (?, null, ?, ?, 'workerctl', ?, 'info', ?, ?, ?)
  `).run(
    eventId,
    options.taskId,
    options.timestamp,
    options.eventType,
    options.summary,
    stableJson(options.correlation),
    attributesJson,
  );
  database.prepare(`
    insert into telemetry_events_fts(
      event_id, task_id, run_id, actor, event_type, summary, attributes
    )
    values (?, ?, null, 'workerctl', ?, ?, ?)
  `).run(eventId, options.taskId, options.eventType, options.summary, attributesJson);
}

function validateAcceptanceCriterionStatus(status: string): asserts status is AcceptanceCriterionStatus {
  if (!new Set(["accepted", "deferred", "proposed", "rejected", "satisfied"]).has(status)) {
    throw new LoopEvidenceError(`Invalid acceptance criterion status: ${status}`);
  }
}

function validateAcceptanceCriterionSource(source: string): asserts source is AcceptanceCriterionSource {
  if (!new Set(["final_audit", "manager_inferred", "user_requested", "worker_proposed"]).has(source)) {
    throw new LoopEvidenceError(`Invalid acceptance criterion source: ${source}`);
  }
}

interface AcceptanceCriterionRow {
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
}

function acceptanceCriterionRecord(row: AcceptanceCriterionRow): AcceptanceCriterionRecord {
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
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
