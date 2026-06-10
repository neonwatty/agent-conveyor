import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type RoutedNotificationDeliveryMode = "pull_required" | "push";
export type RoutedNotificationState = "delivered" | "failed" | "pending" | "suppressed";

export interface RoutedNotificationRecord {
  binding_id: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  command_id: string | null;
  correlation_id: string;
  created_at: string;
  consumed_at: string | null;
  consumed_by_session_id: string | null;
  consumed_manager_cycle_id: number | null;
  dedupe_key: string;
  delivered_at: string | null;
  delivery_mode: RoutedNotificationDeliveryMode;
  error: string | null;
  id: number;
  payload: Record<string, unknown>;
  side_effect_completed: boolean;
  side_effect_started: boolean;
  signal_type: string;
  source_event_id: number | null;
  source_event_timestamp: string | null;
  source_session_id: string;
  state: RoutedNotificationState;
  target_session_id: string;
  task_id: string;
}

export interface SessionInboxRecord extends RoutedNotificationRecord {
  source_session_name: string;
  source_session_role: string;
  target_session_name: string;
  target_session_role: string;
  task_name: string;
}

export class RoutedNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutedNotificationError";
  }
}

export function deliveryModeForTargetSessionSync(database: DatabaseSync, targetSessionId: string): RoutedNotificationDeliveryMode {
  const row = database.prepare("select tmux_session from sessions where id = ?").get(targetSessionId) as {
    tmux_session: string | null;
  } | undefined;
  if (!row) {
    throw new RoutedNotificationError(`target session ${JSON.stringify(targetSessionId)} no longer exists`);
  }
  return row.tmux_session ? "push" : "pull_required";
}

export function insertRoutedNotificationSync(
  database: DatabaseSync,
  options: {
    bindingId: string;
    claimExpiresAt?: string | null;
    claimedAt?: string | null;
    claimedBy?: string | null;
    commandId?: string | null;
    correlationId: string;
    dedupeKey: string;
    deliveryMode?: RoutedNotificationDeliveryMode;
    now?: string;
    payload: Record<string, unknown>;
    signalType: string;
    sourceEventId?: number | null;
    sourceEventTimestamp?: string | null;
    sourceSessionId: string;
    state?: RoutedNotificationState;
    targetSessionId: string;
    taskId: string;
  },
): number {
  const state = options.state ?? "pending";
  if (!["pending", "delivered", "failed", "suppressed"].includes(state)) {
    throw new RoutedNotificationError(`invalid routed notification state: ${state}`);
  }
  const deliveryMode = options.deliveryMode ?? "push";
  if (!["push", "pull_required"].includes(deliveryMode)) {
    throw new RoutedNotificationError(`invalid routed notification delivery mode: ${deliveryMode}`);
  }
  const createdAt = options.now ?? new Date().toISOString();
  const claimedAt = options.claimedAt ?? (options.claimedBy ? createdAt : null);
  const result = database.prepare(`
    insert into routed_notifications(
      task_id, binding_id, correlation_id, source_session_id, target_session_id,
      signal_type, source_event_id, source_event_timestamp, dedupe_key, command_id,
      created_at, state, payload_json, claimed_by, claimed_at, claim_expires_at,
      delivery_mode
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.taskId,
    options.bindingId,
    options.correlationId,
    options.sourceSessionId,
    options.targetSessionId,
    options.signalType,
    options.sourceEventId ?? null,
    options.sourceEventTimestamp ?? null,
    options.dedupeKey,
    options.commandId ?? null,
    createdAt,
    state,
    stableJson(options.payload),
    options.claimedBy ?? null,
    claimedAt,
    options.claimExpiresAt ?? null,
    deliveryMode,
  );
  return Number(result.lastInsertRowid);
}

export function finishRoutedNotificationSync(
  database: DatabaseSync,
  options: {
    error?: string | null;
    notificationId: number;
    now?: string;
    sideEffectCompleted?: boolean | null;
    state: "delivered" | "failed" | "suppressed";
  },
): void {
  const deliveredAt = options.state === "delivered" ? options.now ?? new Date().toISOString() : null;
  const completed = options.sideEffectCompleted ?? (options.state === "delivered");
  database.prepare(`
    update routed_notifications
    set state = ?, delivered_at = ?, error = ?, side_effect_completed = ?
    where id = ?
  `).run(options.state, deliveredAt, options.error ?? null, completed ? 1 : 0, options.notificationId);
}

export function markRoutedNotificationSideEffectStartedSync(
  database: DatabaseSync,
  options: {
    claimExpiresAt?: string | null;
    claimedBy?: string | null;
    notificationId: number;
    now?: string;
  },
): void {
  if (options.claimedBy === undefined && options.claimExpiresAt === undefined) {
    database.prepare("update routed_notifications set side_effect_started = 1 where id = ?").run(options.notificationId);
    return;
  }
  const timestamp = options.now ?? new Date().toISOString();
  database.prepare(`
    update routed_notifications
    set side_effect_started = 1,
        claimed_by = coalesce(?, claimed_by),
        claimed_at = coalesce(claimed_at, ?),
        claim_expires_at = coalesce(?, claim_expires_at)
    where id = ?
  `).run(options.claimedBy ?? null, timestamp, options.claimExpiresAt ?? null, options.notificationId);
}

export function deferRoutedNotificationBeforeSideEffectSync(
  database: DatabaseSync,
  options: { error: string; notificationId: number },
): void {
  database.prepare(`
    update routed_notifications
    set state = 'pending',
        error = ?,
        claimed_by = null,
        claimed_at = null,
        claim_expires_at = null,
        side_effect_started = 0,
        side_effect_completed = 0
    where id = ?
  `).run(options.error, options.notificationId);
}

export function routedNotificationsSync(database: DatabaseSync, options?: { taskId?: string | null }): RoutedNotificationRecord[] {
  const rows = options?.taskId
    ? database.prepare(`${routedNotificationSelect()} where task_id = ? order by id`).all(options.taskId) as unknown as RoutedNotificationRow[]
    : database.prepare(`${routedNotificationSelect()} order by id`).all() as unknown as RoutedNotificationRow[];
  return rows.map(routedNotificationRecord);
}

export function sessionInboxSync(
  database: DatabaseSync,
  options: { includeConsumed?: boolean; limit?: number; sessionName: string },
): SessionInboxRecord[] {
  const session = sessionRow(database, options.sessionName);
  const where = options.includeConsumed
    ? "rn.target_session_id = ? and rn.state = 'delivered'"
    : "rn.target_session_id = ? and rn.state = 'delivered' and rn.consumed_at is null";
  const rows = database.prepare(`${sessionInboxQuery(where)} limit ?`).all(
    session.id,
    Math.max(1, options.limit ?? 10),
  ) as unknown as SessionInboxRow[];
  return rows.map(sessionInboxRecord);
}

export function consumeNextSessionInboxItemSync(
  database: DatabaseSync,
  options: { now?: string; sessionName: string },
): SessionInboxRecord | null {
  const session = sessionRow(database, options.sessionName);
  const row = database.prepare(`
    select id
    from routed_notifications
    where target_session_id = ?
      and state = 'delivered'
      and consumed_at is null
    order by created_at, id
    limit 1
  `).get(session.id) as { id: number } | undefined;
  if (!row) {
    return null;
  }
  const result = database.prepare(`
    update routed_notifications
    set consumed_at = ?, consumed_by_session_id = ?
    where id = ?
      and target_session_id = ?
      and state = 'delivered'
      and consumed_at is null
  `).run(options.now ?? new Date().toISOString(), session.id, row.id, session.id);
  if (result.changes === 0) {
    return null;
  }
  const consumed = database.prepare(sessionInboxQuery("rn.id = ?")).get(row.id) as SessionInboxRow | undefined;
  if (!consumed) {
    return null;
  }
  const record = sessionInboxRecord(consumed);
  advanceRalphLoopIterationOnConsumeSync(database, {
    consumed: record,
    now: options.now ?? new Date().toISOString(),
  });
  return record;
}

function advanceRalphLoopIterationOnConsumeSync(
  database: DatabaseSync,
  options: { consumed: SessionInboxRecord; now: string },
): void {
  if (options.consumed.signal_type !== "continue_iteration") {
    return;
  }
  const loopPayload = isRecord(options.consumed.payload.ralph_loop)
    ? options.consumed.payload.ralph_loop
    : null;
  const runId = typeof loopPayload?.run_id === "string" ? loopPayload.run_id : null;
  const requestedIteration = integerMetadata(loopPayload?.requested_iteration);
  if (!runId || requestedIteration === null) {
    return;
  }
  const row = database.prepare(`
    select task_id, metadata_json
    from runs
    where id = ?
  `).get(runId) as { metadata_json: string; task_id: string } | undefined;
  if (!row || row.task_id !== options.consumed.task_id) {
    return;
  }
  const metadata = parseJsonObject(row.metadata_json);
  const previousIteration = integerMetadata(metadata.current_iteration);
  const maxIterations = integerMetadata(metadata.max_iterations);
  if (
    previousIteration === null
    || maxIterations === null
    || requestedIteration <= previousIteration
    || requestedIteration > maxIterations
  ) {
    return;
  }
  metadata.current_iteration = requestedIteration;
  database.prepare("update runs set metadata_json = ? where id = ?")
    .run(stableJson(metadata), runId);
  emitLoopIterationAdvancedTelemetry(database, {
    commandId: options.consumed.command_id,
    consumedBySessionId: options.consumed.consumed_by_session_id,
    correlationId: options.consumed.correlation_id,
    currentIteration: requestedIteration,
    notificationId: options.consumed.id,
    previousIteration,
    requestedIteration,
    runId,
    targetSessionName: options.consumed.target_session_name,
    taskId: options.consumed.task_id,
    timestamp: options.now,
  });
}

function routedNotificationSelect(): string {
  return `
    select id, task_id, binding_id, correlation_id, source_session_id,
           target_session_id, signal_type, source_event_id, source_event_timestamp,
           dedupe_key, command_id, created_at, delivered_at, consumed_manager_cycle_id,
           consumed_by_session_id, consumed_at, delivery_mode, state, claimed_by,
           claimed_at, claim_expires_at, side_effect_started, side_effect_completed,
           payload_json, error
    from routed_notifications
  `;
}

function sessionInboxQuery(whereClause: string): string {
  return `
    select
      rn.id, rn.task_id, rn.binding_id, rn.correlation_id,
      rn.source_session_id, rn.target_session_id, rn.signal_type,
      rn.source_event_id, rn.source_event_timestamp, rn.dedupe_key,
      rn.command_id, rn.created_at, rn.delivered_at,
      rn.consumed_manager_cycle_id, rn.consumed_by_session_id,
      rn.consumed_at, rn.delivery_mode, rn.state, rn.claimed_by,
      rn.claimed_at, rn.claim_expires_at, rn.side_effect_started,
      rn.side_effect_completed, rn.payload_json, rn.error,
      ss.name as source_session_name, ss.role as source_session_role,
      ts.name as target_session_name, ts.role as target_session_role,
      t.name as task_name
    from routed_notifications rn
    join sessions ss on ss.id = rn.source_session_id
    join sessions ts on ts.id = rn.target_session_id
    join tasks t on t.id = rn.task_id
    where ${whereClause}
    order by rn.created_at, rn.id
  `;
}

interface RoutedNotificationRow {
  binding_id: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  command_id: string | null;
  correlation_id: string;
  created_at: string;
  consumed_at: string | null;
  consumed_by_session_id: string | null;
  consumed_manager_cycle_id: number | null;
  dedupe_key: string;
  delivered_at: string | null;
  delivery_mode: RoutedNotificationDeliveryMode;
  error: string | null;
  id: number;
  payload_json: string;
  side_effect_completed: number;
  side_effect_started: number;
  signal_type: string;
  source_event_id: number | null;
  source_event_timestamp: string | null;
  source_session_id: string;
  state: RoutedNotificationState;
  target_session_id: string;
  task_id: string;
}

interface SessionInboxRow extends RoutedNotificationRow {
  source_session_name: string;
  source_session_role: string;
  target_session_name: string;
  target_session_role: string;
  task_name: string;
}

function sessionInboxRecord(row: SessionInboxRow): SessionInboxRecord {
  return {
    ...routedNotificationRecord(row),
    source_session_name: row.source_session_name,
    source_session_role: row.source_session_role,
    target_session_name: row.target_session_name,
    target_session_role: row.target_session_role,
    task_name: row.task_name,
  };
}

function routedNotificationRecord(row: RoutedNotificationRow): RoutedNotificationRecord {
  return {
    binding_id: row.binding_id,
    claimed_at: row.claimed_at,
    claimed_by: row.claimed_by,
    claim_expires_at: row.claim_expires_at,
    command_id: row.command_id,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    consumed_at: row.consumed_at,
    consumed_by_session_id: row.consumed_by_session_id,
    consumed_manager_cycle_id: row.consumed_manager_cycle_id,
    dedupe_key: row.dedupe_key,
    delivered_at: row.delivered_at,
    delivery_mode: row.delivery_mode,
    error: row.error,
    id: row.id,
    payload: JSON.parse(row.payload_json),
    side_effect_completed: Boolean(row.side_effect_completed),
    side_effect_started: Boolean(row.side_effect_started),
    signal_type: row.signal_type,
    source_event_id: row.source_event_id,
    source_event_timestamp: row.source_event_timestamp,
    source_session_id: row.source_session_id,
    state: row.state,
    target_session_id: row.target_session_id,
    task_id: row.task_id,
  };
}

function sessionRow(database: DatabaseSync, sessionName: string): { id: string; name: string; role: string } {
  const row = database.prepare("select id, name, role from sessions where name = ?").get(sessionName) as {
    id: string;
    name: string;
    role: string;
  } | undefined;
  if (!row) {
    throw new RoutedNotificationError(`no session registered with name ${JSON.stringify(sessionName)}`);
  }
  return row;
}

function emitLoopIterationAdvancedTelemetry(
  database: DatabaseSync,
  options: {
    commandId: string | null;
    consumedBySessionId: string | null;
    correlationId: string;
    currentIteration: number;
    notificationId: number;
    previousIteration: number;
    requestedIteration: number;
    runId: string;
    targetSessionName: string;
    taskId: string;
    timestamp: string;
  },
): void {
  const eventId = `telemetry-${randomUUID()}`;
  const attributes = {
    consumed_by_session_id: options.consumedBySessionId,
    current_iteration: options.currentIteration,
    previous_iteration: options.previousIteration,
    requested_iteration: options.requestedIteration,
    target_session_name: options.targetSessionName,
  };
  const correlation = {
    command_id: options.commandId,
    correlation_id: options.correlationId,
    notification_id: options.notificationId,
    run_id: options.runId,
  };
  const attributesJson = stableJson(attributes);
  database.prepare(`
    insert into telemetry_events(
      id, run_id, task_id, timestamp, actor, event_type, severity,
      summary, correlation_json, attributes_json
    )
    values (?, ?, ?, ?, 'dispatch', 'ralph_loop_iteration_advanced', 'info', ?, ?, ?)
  `).run(
    eventId,
    options.runId,
    options.taskId,
    options.timestamp,
    `Ralph loop advanced to iteration ${options.currentIteration}.`,
    stableJson(correlation),
    attributesJson,
  );
  database.prepare(`
    insert into telemetry_events_fts(
      event_id, task_id, run_id, actor, event_type, summary, attributes
    )
    values (?, ?, ?, 'dispatch', 'ralph_loop_iteration_advanced', ?, ?)
  `).run(
    eventId,
    options.taskId,
    options.runId,
    `Ralph loop advanced to iteration ${options.currentIteration}.`,
    attributesJson,
  );
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
