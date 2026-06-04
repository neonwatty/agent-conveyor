import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface TaskBudget {
  expires_at: string;
  max_nudges: number;
  nudges_remaining: number;
  nudges_used: number;
}

export interface TaskRecord {
  budget: TaskBudget | null;
  created_at: string;
  goal: string;
  id: string;
  name: string;
  state: string;
  summary: string | null;
  updated_at: string;
}

export interface SessionBindingRecord {
  binding_id: string;
  created_at: string;
  ended_at?: string | null;
  manager_session_id: string;
  manager_session_name: string;
  state: string;
  task_id: string;
  worker_session_id: string;
  worker_session_name: string;
}

export class TaskLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLifecycleError";
  }
}

export function createTaskSync(
  database: DatabaseSync,
  options: {
    goal: string;
    name: string;
    now?: string;
    summary?: string | null;
    taskId?: string;
  },
): string {
  const taskId = options.taskId ?? `task-${randomUUID()}`;
  const timestamp = options.now ?? new Date().toISOString();
  database.prepare(`
    insert into tasks(id, name, goal, summary, state, created_at, updated_at)
    values (?, ?, ?, ?, 'candidate', ?, ?)
  `).run(taskId, options.name, options.goal, options.summary ?? null, timestamp, timestamp);
  database.prepare(`
    insert into events(created_at, actor, task_id, type, payload_json)
    values (?, ?, ?, ?, ?)
  `).run(
    timestamp,
    "workerctl",
    taskId,
    "task_created",
    stableJson({ goal: options.goal, name: options.name, summary: options.summary ?? null }),
  );
  return taskId;
}

export function bindSessionsSync(
  database: DatabaseSync,
  options: {
    bindingId?: string;
    managerSessionName: string;
    now?: string;
    taskName: string;
    workerSessionName: string;
  },
): string {
  const timestamp = options.now ?? new Date().toISOString();
  const task = taskRow(database, options.taskName);
  const workerSession = sessionRow(database, options.workerSessionName, "worker");
  const managerSession = sessionRow(database, options.managerSessionName, "manager");
  const existing = database.prepare(`
    select id
    from bindings
    where task_id = ?
      and state in ('active', 'ending')
  `).get(task.id) as { id: string } | undefined;
  if (existing) {
    throw new TaskLifecycleError(
      `task ${JSON.stringify(options.taskName)} already has an active binding ${JSON.stringify(existing.id)}`,
    );
  }
  for (const [label, session] of [["worker", workerSession], ["manager", managerSession]] as const) {
    const alreadyBound = database.prepare(`
      select id, task_id
      from bindings
      where state in ('active', 'ending')
        and (worker_session_id = ? or manager_session_id = ?)
      limit 1
    `).get(session.id, session.id) as { id: string; task_id: string } | undefined;
    if (alreadyBound) {
      throw new TaskLifecycleError(
        `${label} session ${JSON.stringify(session.name)} is already bound to task `
        + `${JSON.stringify(alreadyBound.task_id)} (binding ${JSON.stringify(alreadyBound.id)})`,
      );
    }
  }

  const bindingId = options.bindingId ?? `binding-${randomUUID()}`;
  database.prepare(`
    insert into bindings(
      id, task_id, worker_session_id, manager_session_id, state, created_at
    )
    values (?, ?, ?, ?, 'active', ?)
  `).run(bindingId, task.id, workerSession.id, managerSession.id, timestamp);
  return bindingId;
}

export function unbindTaskSync(
  database: DatabaseSync,
  options: { now?: string; taskName: string },
): void {
  const task = taskRow(database, options.taskName);
  const timestamp = options.now ?? new Date().toISOString();
  const result = database.prepare(`
    update bindings
    set state = 'ended', ended_at = ?
    where task_id = ?
      and state in ('active', 'ending')
  `).run(timestamp, task.id);
  if (result.changes === 0) {
    throw new TaskLifecycleError(`no active binding for task ${JSON.stringify(options.taskName)}`);
  }
}

export function activeBindingForTaskSync(database: DatabaseSync, taskName: string): SessionBindingRecord {
  const task = taskRow(database, taskName);
  const row = sessionBindingQuery(database, `
    where b.task_id = ?
      and b.state in ('active', 'ending')
    order by b.created_at desc
    limit 1
  `).get(task.id) as BindingRow | undefined;
  if (!row) {
    throw new TaskLifecycleError(`no active session-based binding for task ${JSON.stringify(taskName)}`);
  }
  return bindingRecord(row, { includeEndedAt: false });
}

export function latestSessionBindingForTaskSync(database: DatabaseSync, taskName: string): SessionBindingRecord {
  const task = taskRow(database, taskName);
  const row = sessionBindingQuery(database, `
    where b.task_id = ?
      and b.worker_session_id is not null
      and b.manager_session_id is not null
    order by b.created_at desc
    limit 1
  `).get(task.id) as BindingRow | undefined;
  if (!row) {
    throw new TaskLifecycleError(`no session-based binding for task ${JSON.stringify(taskName)}`);
  }
  return bindingRecord(row, { includeEndedAt: true });
}

export function listTasksSync(database: DatabaseSync, options?: { activeOnly?: boolean }): TaskRecord[] {
  const where = options?.activeOnly ? "where tasks.state in ('candidate', 'managed', 'paused')" : "";
  const rows = database.prepare(`
    select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
           tasks.created_at, tasks.updated_at,
           budgets.max_nudges, budgets.nudges_used, budgets.expires_at
    from tasks
    left join budgets on budgets.task_id = tasks.id
    ${where}
    order by tasks.created_at, tasks.id
  `).all() as Array<{
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
  }>;

  return rows.map((row) => ({
    budget: row.max_nudges === null ? null : {
      expires_at: row.expires_at ?? "",
      max_nudges: row.max_nudges,
      nudges_remaining: row.max_nudges - (row.nudges_used ?? 0),
      nudges_used: row.nudges_used ?? 0,
    },
    created_at: row.created_at,
    goal: row.goal,
    id: row.id,
    name: row.name,
    state: row.state,
    summary: row.summary,
    updated_at: row.updated_at,
  }));
}

function taskRow(database: DatabaseSync, taskName: string): { id: string; name: string } {
  const row = database.prepare(`
    select id, name
    from tasks
    where id = ? or name = ?
    order by created_at desc
    limit 1
  `).get(taskName, taskName) as { id: string; name: string } | undefined;
  if (!row) {
    throw new TaskLifecycleError(`Unknown task: ${taskName}`);
  }
  return row;
}

function sessionRow(database: DatabaseSync, name: string, role: "manager" | "worker"): { id: string; name: string; role: string } {
  const row = database.prepare("select id, name, role from sessions where name = ?").get(name) as {
    id: string;
    name: string;
    role: string;
  } | undefined;
  if (!row) {
    throw new TaskLifecycleError(`no session registered with name ${JSON.stringify(name)}`);
  }
  if (row.role !== role) {
    throw new TaskLifecycleError(`session ${JSON.stringify(name)} has role ${JSON.stringify(row.role)}, expected ${JSON.stringify(role)}`);
  }
  return row;
}

interface BindingRow {
  binding_id: string;
  created_at: string;
  ended_at: string | null;
  manager_session_id: string;
  manager_session_name: string;
  state: string;
  task_id: string;
  worker_session_id: string;
  worker_session_name: string;
}

function sessionBindingQuery(database: DatabaseSync, whereClause: string) {
  return database.prepare(`
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
    ${whereClause}
  `);
}

function bindingRecord(row: BindingRow, options: { includeEndedAt: boolean }): SessionBindingRecord {
  const record: SessionBindingRecord = {
    binding_id: row.binding_id,
    created_at: row.created_at,
    manager_session_id: row.manager_session_id,
    manager_session_name: row.manager_session_name,
    state: row.state,
    task_id: row.task_id,
    worker_session_id: row.worker_session_id,
    worker_session_name: row.worker_session_name,
  };
  if (options.includeEndedAt) {
    record.ended_at = row.ended_at;
  }
  return record;
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
