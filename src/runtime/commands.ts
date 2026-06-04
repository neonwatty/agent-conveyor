import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validateRequiredPermission as validateManagerRequiredPermission } from "./manager-permissions.js";

export interface CommandRecord {
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
  payload: Record<string, unknown>;
  required_permission: string | null;
  result: Record<string, unknown> | null;
  state: string;
  task_id: string | null;
  type: string;
  updated_at: string;
  worker_id: string | null;
}

export interface CommandAttemptRecord {
  command_id: string;
  correlation_id: string;
  dispatcher_id: string;
  error: string | null;
  finished_at: string | null;
  id: number;
  result: Record<string, unknown> | null;
  side_effect_completed: boolean;
  side_effect_started: boolean;
  started_at: string;
  state: string;
}

export interface ClaimedCommand {
  attempt: CommandAttemptRecord;
  command: CommandRecord;
}

export interface RecoveredDispatchClaim {
  attempt_id: number | null;
  command_id: string;
  command_type: string;
  error: string;
  side_effect_started: boolean;
  state: "failed" | "requeued";
}

export class CommandQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandQueueError";
  }
}

export function claimableDispatchCommandsSync(
  database: DatabaseSync,
  options: {
    commandTypes: string[];
    limit?: number;
    now?: string;
  },
): CommandRecord[] {
  if (options.commandTypes.length === 0) {
    throw new CommandQueueError("command_types must not be empty");
  }
  const timestamp = options.now ?? new Date().toISOString();
  const placeholders = options.commandTypes.map(() => "?").join(", ");
  const rows = database.prepare(`
    select id, idempotency_key, created_at, updated_at, task_id, worker_id,
           manager_id, correlation_id, type, state, available_at, claimed_by,
           claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
           required_permission, result_json, error
    from commands
    where state = 'pending'
      and type in (${placeholders})
      and (available_at is null or available_at <= ?)
      and attempts < max_attempts
    order by created_at, id
    limit ?
  `).all(...options.commandTypes, timestamp, Math.max(1, options.limit ?? 10)) as unknown as CommandRow[];
  return rows.map(commandRecord);
}

export function createCommandSync(
  database: DatabaseSync,
  options: {
    availableAt?: string | null;
    commandId?: string;
    commandType: string;
    correlationId?: string | null;
    idempotencyKey?: string | null;
    managerId?: string | null;
    maxAttempts?: number;
    now?: string;
    payload: Record<string, unknown>;
    requiredPermission?: string | null;
    taskId?: string | null;
    workerId?: string | null;
  },
): string {
  const requiredPermission = validateRequiredPermission(options.requiredPermission ?? null);
  const commandId = options.commandId ?? `command-${randomUUID()}`;
  const correlationId = options.correlationId ?? `dispatch-${randomUUID()}`;
  const timestamp = options.now ?? new Date().toISOString();
  const idempotencyKey = options.idempotencyKey ?? commandId;
  database.prepare(`
    insert into commands(
      id, idempotency_key, created_at, updated_at, task_id, worker_id,
      manager_id, correlation_id, type, state, available_at, max_attempts,
      required_permission, payload_json
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    commandId,
    idempotencyKey,
    timestamp,
    timestamp,
    options.taskId ?? null,
    options.workerId ?? null,
    options.managerId ?? null,
    correlationId,
    options.commandType,
    options.availableAt ?? null,
    options.maxAttempts ?? 1,
    requiredPermission,
    stableJson(options.payload),
  );
  emitTelemetry(database, {
    actor: "workerctl",
    attributes: {
      idempotency_key: idempotencyKey,
      manager_id: options.managerId ?? null,
      required_permission: requiredPermission,
      state: "pending",
      worker_id: options.workerId ?? null,
    },
    correlation: {
      command_id: commandId,
      command_type: options.commandType,
      correlation_id: correlationId,
    },
    eventType: "command_created",
    severity: "info",
    summary: `Created command ${options.commandType}.`,
    taskId: options.taskId ?? null,
    timestamp,
  });
  return commandId;
}

export function recoverStaleDispatchClaimsSync(
  database: DatabaseSync,
  options: {
    commandTypes: string[];
    dispatcherId: string;
    limit?: number;
    now?: string;
  },
): RecoveredDispatchClaim[] {
  if (options.commandTypes.length === 0) {
    throw new CommandQueueError("command_types must not be empty");
  }
  const timestamp = options.now ?? new Date().toISOString();
  const placeholders = options.commandTypes.map(() => "?").join(", ");
  const commands = database.prepare(`
    select id, task_id, type, correlation_id, attempts, max_attempts
    from commands
    where state = 'attempted'
      and type in (${placeholders})
      and claim_expires_at is not null
      and claim_expires_at <= ?
    order by claim_expires_at, created_at, id
    limit ?
  `).all(...options.commandTypes, timestamp, Math.max(1, options.limit ?? 10)) as unknown as StaleCommandRow[];

  const recovered: RecoveredDispatchClaim[] = [];
  for (const command of commands) {
    const attempt = database.prepare(`
      select id, side_effect_started
      from command_attempts
      where command_id = ? and state = 'running'
      order by id desc
      limit 1
    `).get(command.id) as StaleAttemptRow | undefined;
    const sideEffectStarted = Boolean(attempt?.side_effect_started);
    let error: string;
    let eventType: "dispatch_command_abandoned" | "dispatch_command_failed";
    let state: "failed" | "requeued";
    if (sideEffectStarted) {
      error = "stale dispatch claim expired after side effect started; manual review required";
      if (attempt) {
        database.prepare(`
          update command_attempts
          set state = 'failed', finished_at = ?, error = ?
          where id = ?
        `).run(timestamp, error, attempt.id);
      }
      database.prepare(`
        update commands
        set state = 'failed', updated_at = ?, error = ?,
            claimed_by = null, claimed_at = null, claim_expires_at = null
        where id = ?
      `).run(timestamp, error, command.id);
      state = "failed";
      eventType = "dispatch_command_failed";
    } else {
      error = "stale dispatch claim abandoned before side effect started";
      const nextState = command.attempts < command.max_attempts ? "pending" : "failed";
      if (attempt) {
        database.prepare(`
          update command_attempts
          set state = 'abandoned', finished_at = ?, error = ?
          where id = ?
        `).run(timestamp, error, attempt.id);
      }
      database.prepare(`
        update commands
        set state = ?, updated_at = ?, error = ?,
            claimed_by = null, claimed_at = null, claim_expires_at = null
        where id = ?
      `).run(nextState, timestamp, nextState === "pending" ? null : error, command.id);
      state = nextState === "pending" ? "requeued" : "failed";
      eventType = "dispatch_command_abandoned";
    }
    emitTelemetry(database, {
      actor: "dispatch",
      attributes: {
        recovery_state: state,
        side_effect_started: sideEffectStarted,
      },
      correlation: {
        attempt_id: attempt?.id ?? null,
        command_id: command.id,
        command_type: command.type,
        correlation_id: command.correlation_id,
        dispatcher_id: options.dispatcherId,
      },
      eventType,
      severity: state === "failed" ? "error" : "warning",
      summary: `Recovered stale dispatch claim for ${command.type}.`,
      taskId: command.task_id,
      timestamp,
    });
    recovered.push({
      attempt_id: attempt?.id ?? null,
      command_id: command.id,
      command_type: command.type,
      error,
      side_effect_started: sideEffectStarted,
      state,
    });
  }
  return recovered;
}

export function claimNextDispatchCommandSync(
  database: DatabaseSync,
  options: {
    commandTypes: string[];
    dispatcherId: string;
    leaseSeconds?: number;
    now?: string;
  },
): ClaimedCommand | null {
  if (options.commandTypes.length === 0) {
    throw new CommandQueueError("command_types must not be empty");
  }
  const timestamp = options.now ?? new Date().toISOString();
  const claimExpiresAt = isoAfter(timestamp, Math.max(1, options.leaseSeconds ?? 60));
  const correlationId = `dispatch-${randomUUID()}`;
  const placeholders = options.commandTypes.map(() => "?").join(", ");
  const row = database.prepare(`
    update commands
    set state = 'attempted',
        updated_at = ?,
        correlation_id = coalesce(correlation_id, ?),
        claimed_by = ?,
        claimed_at = ?,
        claim_expires_at = ?,
        attempts = attempts + 1
    where id = (
      select id
      from commands
      where state = 'pending'
        and type in (${placeholders})
        and (available_at is null or available_at <= ?)
        and attempts < max_attempts
      order by created_at, id
      limit 1
    )
      and state = 'pending'
    returning id, idempotency_key, created_at, updated_at, task_id, worker_id,
              manager_id, correlation_id, type, state, available_at, claimed_by,
              claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
              required_permission, result_json, error
  `).get(
    timestamp,
    correlationId,
    options.dispatcherId,
    timestamp,
    claimExpiresAt,
    ...options.commandTypes,
    timestamp,
  ) as CommandRow | undefined;
  if (!row) {
    return null;
  }
  const attemptResult = database.prepare(`
    insert into command_attempts(
      command_id, correlation_id, dispatcher_id, started_at, state
    )
    values (?, ?, ?, ?, 'running')
  `).run(row.id, row.correlation_id, options.dispatcherId, timestamp);
  const attemptId = Number(attemptResult.lastInsertRowid);
  emitTelemetry(database, {
    actor: "dispatch",
    attributes: {
      attempts: row.attempts,
      claim_expires_at: row.claim_expires_at,
      manager_id: row.manager_id,
      worker_id: row.worker_id,
    },
    correlation: {
      attempt_id: attemptId,
      command_id: row.id,
      command_type: row.type,
      correlation_id: row.correlation_id,
      dispatcher_id: options.dispatcherId,
    },
    eventType: "dispatch_command_claimed",
    severity: "info",
    summary: `Dispatch claimed command ${row.type}.`,
    taskId: row.task_id,
    timestamp,
  });
  return {
    attempt: {
      command_id: row.id,
      correlation_id: row.correlation_id ?? "",
      dispatcher_id: options.dispatcherId,
      error: null,
      finished_at: null,
      id: attemptId,
      result: null,
      side_effect_completed: false,
      side_effect_started: false,
      started_at: timestamp,
      state: "running",
    },
    command: commandRecord(row),
  };
}

export function finishCommandAttemptSync(
  database: DatabaseSync,
  options: {
    attemptId: number;
    error?: string | null;
    now?: string;
    result?: Record<string, unknown> | null;
    sideEffectCompleted?: boolean;
    sideEffectStarted?: boolean;
    state: "abandoned" | "blocked" | "failed" | "succeeded";
  },
): CommandAttemptRecord {
  const timestamp = options.now ?? new Date().toISOString();
  const resultJson = options.result === undefined || options.result === null ? null : stableJson(options.result);
  const update = database.prepare(`
    update command_attempts
    set state = ?, finished_at = ?, result_json = ?, error = ?,
        side_effect_started = ?, side_effect_completed = ?
    where id = ? and state = 'running'
  `).run(
    options.state,
    timestamp,
    resultJson,
    options.error ?? null,
    options.sideEffectStarted ? 1 : 0,
    options.sideEffectCompleted ? 1 : 0,
    options.attemptId,
  );
  if (update.changes !== 1) {
    const existing = database.prepare("select state from command_attempts where id = ?").get(options.attemptId) as { state: string } | undefined;
    if (!existing) {
      throw new CommandQueueError(`Unknown command attempt: ${options.attemptId}`);
    }
    throw new CommandQueueError(`Command attempt ${options.attemptId} is not running (state: ${existing.state})`);
  }
  const attempt = database.prepare(`
    select command_attempts.id, command_attempts.command_id,
           command_attempts.correlation_id, command_attempts.dispatcher_id,
           command_attempts.started_at, command_attempts.finished_at,
           command_attempts.state, command_attempts.result_json,
           command_attempts.error, command_attempts.side_effect_started,
           command_attempts.side_effect_completed,
           commands.task_id, commands.worker_id, commands.manager_id,
           commands.type as command_type
    from command_attempts
    join commands on commands.id = command_attempts.command_id
    where command_attempts.id = ?
  `).get(options.attemptId) as AttemptJoinRow | undefined;
  if (!attempt) {
    throw new CommandQueueError(`Unknown command attempt: ${options.attemptId}`);
  }
  const commandState = options.state === "succeeded" ? "succeeded" : options.state === "blocked" ? "blocked" : "failed";
  database.prepare(`
    update commands
    set state = ?, updated_at = ?, result_json = ?, error = ?
    where id = ?
  `).run(commandState, timestamp, resultJson, options.error ?? null, attempt.command_id);

  const finishEventType = {
    abandoned: "dispatch_command_abandoned",
    blocked: "dispatch_command_blocked",
    failed: "dispatch_command_failed",
    succeeded: "dispatch_command_succeeded",
  } as const;
  const finishSeverity = {
    abandoned: "warning",
    blocked: "warning",
    failed: "error",
    succeeded: "info",
  } as const;

  emitTelemetry(database, {
    actor: "dispatch",
    attributes: {
      error: options.error ?? null,
      manager_id: attempt.manager_id,
      result: options.result ?? {},
      side_effect_completed: options.sideEffectCompleted ?? false,
      side_effect_started: options.sideEffectStarted ?? false,
      worker_id: attempt.worker_id,
    },
    correlation: {
      attempt_id: options.attemptId,
      command_id: attempt.command_id,
      command_type: attempt.command_type,
      correlation_id: attempt.correlation_id,
      dispatcher_id: attempt.dispatcher_id,
    },
    eventType: finishEventType[options.state],
    severity: finishSeverity[options.state],
    summary: `Dispatch command ${attempt.command_type} ${options.state}.`,
    taskId: attempt.task_id,
    timestamp,
  });
  return commandAttemptRecord(attempt);
}

export function markCommandAttemptSideEffectStartedSync(database: DatabaseSync, attemptId: number): void {
  database.prepare(`
    update command_attempts
    set side_effect_started = 1
    where id = ? and state = 'running'
  `).run(attemptId);
}

interface CommandRow {
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
  type: string;
  updated_at: string;
  worker_id: string | null;
}

interface StaleCommandRow {
  attempts: number;
  correlation_id: string | null;
  id: string;
  max_attempts: number;
  task_id: string | null;
  type: string;
}

interface StaleAttemptRow {
  id: number;
  side_effect_started: number;
}

interface AttemptJoinRow {
  command_id: string;
  command_type: string;
  correlation_id: string;
  dispatcher_id: string;
  error: string | null;
  finished_at: string | null;
  id: number;
  manager_id: string | null;
  result_json: string | null;
  side_effect_completed: number;
  side_effect_started: number;
  started_at: string;
  state: string;
  task_id: string | null;
  worker_id: string | null;
}

function commandRecord(row: CommandRow): CommandRecord {
  return {
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
    payload: JSON.parse(row.payload_json),
    required_permission: row.required_permission,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    state: row.state,
    task_id: row.task_id,
    type: row.type,
    updated_at: row.updated_at,
    worker_id: row.worker_id,
  };
}

function commandAttemptRecord(row: AttemptJoinRow): CommandAttemptRecord {
  return {
    command_id: row.command_id,
    correlation_id: row.correlation_id,
    dispatcher_id: row.dispatcher_id,
    error: row.error,
    finished_at: row.finished_at,
    id: row.id,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    side_effect_completed: Boolean(row.side_effect_completed),
    side_effect_started: Boolean(row.side_effect_started),
    started_at: row.started_at,
    state: row.state,
  };
}

function validateRequiredPermission(requiredPermission: string | null): string | null {
  try {
    return validateManagerRequiredPermission(requiredPermission);
  } catch (error) {
    throw new CommandQueueError(error instanceof Error ? error.message : String(error));
  }
}

function emitTelemetry(
  database: DatabaseSync,
  options: {
    actor: "dispatch" | "workerctl";
    attributes: Record<string, unknown>;
    correlation: Record<string, unknown>;
    eventType: string;
    severity: "error" | "info" | "warning";
    summary: string;
    taskId: string | null;
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
    null,
    options.taskId,
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
  `).run(eventId, options.taskId, null, options.actor, options.eventType, options.summary, attributesJson);
}

function isoAfter(value: string, seconds: number): string {
  const date = new Date(value);
  date.setUTCSeconds(date.getUTCSeconds() + seconds);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
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
