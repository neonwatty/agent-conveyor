import { DatabaseSync } from "node:sqlite";
import { acceptanceCriteriaForTaskSync } from "./loop-evidence.js";
import type { AcceptanceCriterionRecord } from "./loop-evidence.js";
import type { CommandAttemptRecord, CommandRecord } from "./commands.js";
import type { RoutedNotificationDeliveryMode, RoutedNotificationState } from "./notifications.js";

export interface TaskAuditTask {
  created_at: string;
  goal: string;
  id: string;
  name: string;
  state: string;
  summary: string | null;
  updated_at: string;
}

export interface TaskAuditEvent {
  actor: string;
  command_id: string | null;
  correlation_id: string | null;
  created_at: string;
  id: number;
  manager_id: string | null;
  payload: Record<string, unknown>;
  task_id: string;
  type: string;
  worker_id: string | null;
}

export interface TaskAuditManagerDecision {
  created_at: string;
  decision: string;
  id: number;
  manager_cycle_id: number | null;
  manager_id: string | null;
  payload: Record<string, unknown>;
  reason: string;
  task_id: string;
}

export interface TaskAuditRoutedNotification {
  binding_id: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  command_id: string | null;
  correlation_id: string;
  created_at: string;
  consumed_at: string | null;
  consumed_by_session_id: string | null;
  consumed_by_session_name: string | null;
  consumed_by_session_role: string | null;
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
  source_session_name: string;
  source_session_role: string;
  state: RoutedNotificationState;
  target_session_id: string;
  target_session_name: string;
  target_session_role: string;
  task_id: string;
}

export interface TaskAuditCorrelationChain {
  attempt_ids: number[];
  command_id: string | null;
  command_state: string;
  command_type: string;
  correlation_id: string | null;
  created_at: string;
  manager_cycle_id: number | null;
  manager_decision_cycle_id?: number | null;
  manager_decision_id: number | null;
  routed_notification_ids: number[];
  signal_type?: string;
  source_event_id?: number | null;
}

export interface TaskAuditResult {
  acceptance_criteria: AcceptanceCriterionRecord[];
  command_attempts: CommandAttemptRecord[];
  commands: CommandRecord[];
  correlation_chains: TaskAuditCorrelationChain[];
  events: TaskAuditEvent[];
  manager_decisions: TaskAuditManagerDecision[];
  routed_notifications: TaskAuditRoutedNotification[];
  task: TaskAuditTask;
}

export class TaskAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskAuditError";
  }
}

export function taskAuditSync(database: DatabaseSync, task: string): TaskAuditResult {
  const taskRow = taskRowSync(database, task);
  const commands = commandRecordsForTaskSync(database, taskRow.id);
  const commandAttempts = commandAttemptRecordsForTaskSync(database, taskRow.id);
  const routedNotifications = routedNotificationRecordsForTaskSync(database, taskRow.id);
  const managerDecisions = managerDecisionRecordsForTaskSync(database, taskRow.id);
  return {
    acceptance_criteria: acceptanceCriteriaForTaskSync(database, { taskId: taskRow.id }),
    command_attempts: commandAttempts,
    commands,
    correlation_chains: buildCorrelationChains({
      commandAttempts,
      commands,
      managerDecisions,
      routedNotifications,
    }),
    events: eventRecordsForTaskSync(database, taskRow.id),
    manager_decisions: managerDecisions,
    routed_notifications: routedNotifications,
    task: taskRow,
  };
}

function taskRowSync(database: DatabaseSync, task: string): TaskAuditTask {
  const row = database.prepare(`
    select id, name, goal, summary, state, created_at, updated_at
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(task, task) as TaskAuditTask | undefined;
  if (!row) {
    throw new TaskAuditError(`Unknown task: ${task}`);
  }
  return {
    created_at: row.created_at,
    goal: row.goal,
    id: row.id,
    name: row.name,
    state: row.state,
    summary: row.summary,
    updated_at: row.updated_at,
  };
}

function eventRecordsForTaskSync(database: DatabaseSync, taskId: string): TaskAuditEvent[] {
  const rows = database.prepare(`
    select id, created_at, actor, command_id, correlation_id, task_id,
           worker_id, manager_id, type, payload_json
    from events
    where task_id = ?
    order by id
  `).all(taskId) as unknown as EventRow[];
  return rows.map((row) => ({
    actor: row.actor,
    command_id: row.command_id,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    id: row.id,
    manager_id: row.manager_id,
    payload: parseJsonObject(row.payload_json),
    task_id: row.task_id,
    type: row.type,
    worker_id: row.worker_id,
  }));
}

function commandRecordsForTaskSync(database: DatabaseSync, taskId: string): CommandRecord[] {
  const rows = database.prepare(`
    select id, idempotency_key, created_at, updated_at, task_id, worker_id,
           manager_id, correlation_id, type, state, available_at, claimed_by,
           claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
           required_permission, result_json, error
    from commands
    where task_id = ?
    order by created_at, id
  `).all(taskId) as unknown as CommandRow[];
  return rows.map(commandRecord);
}

function commandAttemptRecordsForTaskSync(database: DatabaseSync, taskId: string): CommandAttemptRecord[] {
  const rows = database.prepare(`
    select command_attempts.id, command_attempts.command_id,
           command_attempts.correlation_id, command_attempts.dispatcher_id,
           command_attempts.started_at, command_attempts.finished_at,
           command_attempts.state, command_attempts.result_json,
           command_attempts.error, command_attempts.side_effect_started,
           command_attempts.side_effect_completed
    from command_attempts
    join commands on commands.id = command_attempts.command_id
    where commands.task_id = ?
    order by command_attempts.started_at, command_attempts.id
  `).all(taskId) as unknown as CommandAttemptRow[];
  return rows.map(commandAttemptRecord);
}

function routedNotificationRecordsForTaskSync(database: DatabaseSync, taskId: string): TaskAuditRoutedNotification[] {
  const rows = database.prepare(`
    select rn.id, rn.task_id, rn.binding_id, rn.correlation_id,
           rn.source_session_id, rn.target_session_id, rn.signal_type,
           rn.source_event_id, rn.source_event_timestamp, rn.dedupe_key,
           rn.command_id, rn.created_at, rn.delivered_at,
           rn.consumed_manager_cycle_id, rn.consumed_by_session_id,
           rn.consumed_at, rn.delivery_mode, rn.state, rn.claimed_by,
           rn.claimed_at, rn.claim_expires_at,
           rn.side_effect_started, rn.side_effect_completed, rn.payload_json,
           rn.error,
           ss.name as source_session_name, ss.role as source_session_role,
           ts.name as target_session_name, ts.role as target_session_role,
           cs.name as consumed_by_session_name,
           cs.role as consumed_by_session_role
    from routed_notifications rn
    join sessions ss on ss.id = rn.source_session_id
    join sessions ts on ts.id = rn.target_session_id
    left join sessions cs on cs.id = rn.consumed_by_session_id
    where rn.task_id = ?
    order by rn.created_at, rn.id
  `).all(taskId) as unknown as RoutedNotificationAuditRow[];
  return rows.map(routedNotificationRecord);
}

function managerDecisionRecordsForTaskSync(database: DatabaseSync, taskId: string): TaskAuditManagerDecision[] {
  const rows = database.prepare(`
    select id, task_id, manager_id, manager_cycle_id, decision, reason,
           created_at, payload_json
    from manager_decisions
    where task_id = ?
    order by id
  `).all(taskId) as unknown as ManagerDecisionRow[];
  return rows.map((row) => ({
    created_at: row.created_at,
    decision: row.decision,
    id: row.id,
    manager_cycle_id: row.manager_cycle_id,
    manager_id: row.manager_id,
    payload: parseJsonObject(row.payload_json),
    reason: row.reason,
    task_id: row.task_id,
  }));
}

function buildCorrelationChains(options: {
  commandAttempts: CommandAttemptRecord[];
  commands: CommandRecord[];
  managerDecisions: TaskAuditManagerDecision[];
  routedNotifications: TaskAuditRoutedNotification[];
}): TaskAuditCorrelationChain[] {
  const decisionsById = new Map(options.managerDecisions.map((decision) => [decision.id, decision]));
  const attemptsByCommand = groupBy(options.commandAttempts, (attempt) => attempt.command_id);
  const notificationsByCommand = groupBy(
    options.routedNotifications.filter((notification) => notification.command_id),
    (notification) => notification.command_id ?? "",
  );
  const chains: TaskAuditCorrelationChain[] = [];
  for (const command of options.commands) {
    const managerDecisionId = commandManagerDecisionId(command);
    const decision = managerDecisionId === null ? null : decisionsById.get(managerDecisionId) ?? null;
    const attempts = attemptsByCommand.get(command.id) ?? [];
    const notifications = notificationsByCommand.get(command.id) ?? [];
    if (!(decision || attempts.length > 0 || notifications.length > 0 || command.correlation_id)) {
      continue;
    }
    const consumedCycleId = notifications.find((notification) => notification.consumed_manager_cycle_id !== null)?.consumed_manager_cycle_id ?? null;
    chains.push({
      attempt_ids: attempts.map((attempt) => attempt.id),
      command_id: command.id,
      command_state: command.state,
      command_type: command.type,
      correlation_id: command.correlation_id,
      created_at: command.created_at,
      manager_cycle_id: consumedCycleId ?? decision?.manager_cycle_id ?? null,
      manager_decision_cycle_id: decision?.manager_cycle_id ?? null,
      manager_decision_id: decision?.id ?? null,
      routed_notification_ids: notifications.map((notification) => notification.id),
    });
  }
  for (const notification of options.routedNotifications.filter((item) => !item.command_id)) {
    chains.push({
      attempt_ids: [],
      command_id: null,
      command_state: notification.state,
      command_type: notification.signal_type,
      correlation_id: notification.correlation_id,
      created_at: notification.created_at,
      manager_cycle_id: notification.consumed_manager_cycle_id,
      manager_decision_id: null,
      routed_notification_ids: [notification.id],
      signal_type: notification.signal_type,
      source_event_id: notification.source_event_id,
    });
  }
  return chains.sort((left, right) => {
    const time = left.created_at.localeCompare(right.created_at);
    if (time !== 0) {
      return time;
    }
    return String(left.command_id ?? "").localeCompare(String(right.command_id ?? ""));
  });
}

function commandManagerDecisionId(command: CommandRecord): number | null {
  for (const root of [command.payload, command.result ?? {}]) {
    const managerDecision = root.manager_decision;
    if (!isRecord(managerDecision)) {
      continue;
    }
    const decisionRecord = isRecord(managerDecision.decision) ? managerDecision.decision : managerDecision;
    const decisionId = managerDecision.decision_id ?? decisionRecord.id;
    if (typeof decisionId === "number" && Number.isInteger(decisionId)) {
      return decisionId;
    }
    if (typeof decisionId === "string" && /^\d+$/.test(decisionId)) {
      return Number(decisionId);
    }
  }
  return null;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

interface EventRow {
  actor: string;
  command_id: string | null;
  correlation_id: string | null;
  created_at: string;
  id: number;
  manager_id: string | null;
  payload_json: string;
  task_id: string;
  type: string;
  worker_id: string | null;
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

interface CommandAttemptRow {
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
}

interface RoutedNotificationAuditRow {
  binding_id: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  command_id: string | null;
  consumed_at: string | null;
  consumed_by_session_id: string | null;
  consumed_by_session_name: string | null;
  consumed_by_session_role: string | null;
  consumed_manager_cycle_id: number | null;
  correlation_id: string;
  created_at: string;
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
  source_session_name: string;
  source_session_role: string;
  state: RoutedNotificationState;
  target_session_id: string;
  target_session_name: string;
  target_session_role: string;
  task_id: string;
}

interface ManagerDecisionRow {
  created_at: string;
  decision: string;
  id: number;
  manager_cycle_id: number | null;
  manager_id: string | null;
  payload_json: string;
  reason: string;
  task_id: string;
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
    payload: parseJsonObject(row.payload_json),
    required_permission: row.required_permission,
    result: row.result_json ? parseJsonObject(row.result_json) : null,
    state: row.state,
    task_id: row.task_id,
    type: row.type,
    updated_at: row.updated_at,
    worker_id: row.worker_id,
  };
}

function commandAttemptRecord(row: CommandAttemptRow): CommandAttemptRecord {
  return {
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
  };
}

function routedNotificationRecord(row: RoutedNotificationAuditRow): TaskAuditRoutedNotification {
  return {
    binding_id: row.binding_id,
    claimed_at: row.claimed_at,
    claimed_by: row.claimed_by,
    claim_expires_at: row.claim_expires_at,
    command_id: row.command_id,
    consumed_at: row.consumed_at,
    consumed_by_session_id: row.consumed_by_session_id,
    consumed_by_session_name: row.consumed_by_session_name,
    consumed_by_session_role: row.consumed_by_session_role,
    consumed_manager_cycle_id: row.consumed_manager_cycle_id,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    dedupe_key: row.dedupe_key,
    delivered_at: row.delivered_at,
    delivery_mode: row.delivery_mode,
    error: row.error,
    id: row.id,
    payload: parseJsonObject(row.payload_json),
    side_effect_completed: Boolean(row.side_effect_completed),
    side_effect_started: Boolean(row.side_effect_started),
    signal_type: row.signal_type,
    source_event_id: row.source_event_id,
    source_event_timestamp: row.source_event_timestamp,
    source_session_id: row.source_session_id,
    source_session_name: row.source_session_name,
    source_session_role: row.source_session_role,
    state: row.state,
    target_session_id: row.target_session_id,
    target_session_name: row.target_session_name,
    target_session_role: row.target_session_role,
    task_id: row.task_id,
  };
}

function parseJsonObject(json: string): Record<string, unknown> {
  const value = JSON.parse(json) as unknown;
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
