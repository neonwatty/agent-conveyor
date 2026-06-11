import type { DatabaseSync } from "node:sqlite";

export type AppLoopLeaseState = "healthy" | "missing" | "stale";
export type AppLoopDispatchState = "healthy" | "missing" | "stale";
export type AppLoopRole = "manager" | "worker";

export interface AppLoopRoleStatus {
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  direct_inbox_command: string | null;
  lease: {
    age_seconds: number | null;
    last_heartbeat_at: string | null;
    stale_after_seconds: number;
    state: AppLoopLeaseState;
  };
  name: string | null;
  poll_command: string | null;
  receive_style: "pull" | "push" | null;
  session_id: string | null;
  session_kind: "codex_app" | "no_tmux" | "tmux" | null;
}

export interface AppLoopNextAction {
  kind: "start_dispatch" | "wake_manager" | "wake_worker";
  prompt?: string;
  reason: string;
  role?: AppLoopRole;
}

export interface AppLoopStatus {
  dispatch: {
    dispatcher_id: string;
    last_heartbeat_at: string | null;
    state: AppLoopDispatchState;
  };
  manager: AppLoopRoleStatus;
  next_actions: AppLoopNextAction[];
  ok: boolean;
  task: { id: string; name: string };
  worker: AppLoopRoleStatus;
}

export interface AppWakeupPlan {
  dispatcher: {
    command: string;
    required: boolean;
    state: AppLoopDispatchState;
  };
  status: AppLoopStatus;
  wakeups: AppWakeup[];
}

export interface AppWakeup {
  prompt: string;
  reason: string;
  role: AppLoopRole;
  thread: {
    id: string | null;
    title: string | null;
  };
}

export function appLoopStatusSync(
  database: DatabaseSync,
  options: {
    dbPath?: string | null;
    dispatcherId: string;
    heartbeatStaleSeconds: number;
    now: string;
    taskName: string;
  },
): AppLoopStatus {
  const task = database.prepare("select id, name from tasks where name = ?").get(options.taskName) as
    | { id: string; name: string }
    | undefined;
  if (!task) {
    throw new Error(`Task not found: ${options.taskName}`);
  }

  const binding = database.prepare(`
    select ws.id as worker_session_id,
           ws.name as worker_name,
           ws.last_heartbeat_at as worker_last_heartbeat_at,
           ws.codex_app_thread_id as worker_thread_id,
           ws.codex_app_thread_title as worker_thread_title,
           ws.tmux_session as worker_tmux_session,
           ms.id as manager_session_id,
           ms.name as manager_name,
           ms.last_heartbeat_at as manager_last_heartbeat_at,
           ms.codex_app_thread_id as manager_thread_id,
           ms.codex_app_thread_title as manager_thread_title,
           ms.tmux_session as manager_tmux_session
    from bindings
    left join sessions ws on ws.id = bindings.worker_session_id
    left join sessions ms on ms.id = bindings.manager_session_id
    where bindings.task_id = ? and bindings.state in ('active', 'ending')
    order by bindings.created_at desc
    limit 1
  `).get(task.id) as Record<string, string | null> | undefined;
  if (!binding) {
    throw new Error(`No active binding for task: ${options.taskName}`);
  }

  const dispatchHeartbeat = database.prepare(`
    select timestamp
    from telemetry_events
    where actor = 'dispatch'
      and event_type = 'dispatch_watch_heartbeat'
      and json_extract(correlation_json, '$.dispatcher_id') = ?
    order by timestamp desc, id desc
    limit 1
  `).get(options.dispatcherId) as { timestamp: string } | undefined;

  const manager = roleStatus({
    dbPath: options.dbPath ?? null,
    heartbeatStaleSeconds: options.heartbeatStaleSeconds,
    lastHeartbeatAt: binding.manager_last_heartbeat_at,
    name: binding.manager_name,
    now: options.now,
    role: "manager",
    sessionId: binding.manager_session_id,
    taskName: options.taskName,
    threadId: binding.manager_thread_id,
    threadTitle: binding.manager_thread_title,
    tmuxSession: binding.manager_tmux_session,
  });
  const worker = roleStatus({
    dbPath: options.dbPath ?? null,
    heartbeatStaleSeconds: options.heartbeatStaleSeconds,
    lastHeartbeatAt: binding.worker_last_heartbeat_at,
    name: binding.worker_name,
    now: options.now,
    role: "worker",
    sessionId: binding.worker_session_id,
    taskName: options.taskName,
    threadId: binding.worker_thread_id,
    threadTitle: binding.worker_thread_title,
    tmuxSession: binding.worker_tmux_session,
  });
  const dispatchState = dispatchLeaseState(dispatchHeartbeat?.timestamp ?? null, options.now, options.heartbeatStaleSeconds);
  const dispatch = {
    dispatcher_id: options.dispatcherId,
    last_heartbeat_at: dispatchHeartbeat?.timestamp ?? null,
    state: dispatchState,
  };
  const nextActions: AppLoopNextAction[] = [];
  if (dispatch.state !== "healthy") {
    nextActions.push({
      kind: "start_dispatch",
      prompt: `Run: conveyor dispatch --watch --dispatcher-id ${shellQuote(options.dispatcherId)}${pathFlag(options.dbPath ?? null)}`,
      reason: `Dispatch ${options.dispatcherId} is ${dispatch.state}.`,
    });
  }
  if (manager.lease.state !== "healthy") {
    nextActions.push({
      kind: "wake_manager",
      prompt: manager.poll_command ?? undefined,
      reason: `Manager heartbeat is ${manager.lease.state}.`,
      role: "manager",
    });
  }
  if (worker.lease.state !== "healthy") {
    nextActions.push({
      kind: "wake_worker",
      prompt: worker.poll_command ?? undefined,
      reason: `Worker heartbeat is ${worker.lease.state}.`,
      role: "worker",
    });
  }

  return {
    dispatch,
    manager,
    next_actions: nextActions,
    ok: dispatch.state === "healthy" && manager.lease.state === "healthy" && worker.lease.state === "healthy",
    task,
    worker,
  };
}

export function appWakeupPlanSync(
  database: DatabaseSync,
  options: {
    dbPath?: string | null;
    dispatcherId: string;
    heartbeatStaleSeconds: number;
    now: string;
    taskName: string;
  },
): AppWakeupPlan {
  const status = appLoopStatusSync(database, options);
  const wakeups: AppWakeup[] = [];
  if (status.manager.lease.state !== "healthy") {
    wakeups.push(roleWakeup("manager", status.manager, status.task.name, options.dbPath ?? null, status.manager.lease.state));
  }
  if (status.worker.lease.state !== "healthy") {
    wakeups.push(roleWakeup("worker", status.worker, status.task.name, options.dbPath ?? null, status.worker.lease.state));
  }
  return {
    dispatcher: {
      command: `conveyor dispatch --watch --dispatcher-id ${shellQuote(options.dispatcherId)}${pathFlag(options.dbPath ?? null)}`,
      required: status.dispatch.state !== "healthy",
      state: status.dispatch.state,
    },
    status,
    wakeups,
  };
}

export function appHeartbeatPollCommand(role: AppLoopRole, taskName: string, dbPath?: string | null): string {
  return `conveyor app-heartbeat ${shellQuote(taskName)} --role ${role}${pathFlag(dbPath ?? null)} --json`;
}

export function appLoopStatusCommand(taskName: string, dbPath?: string | null): string {
  return `conveyor app-loop-status ${shellQuote(taskName)}${pathFlag(dbPath ?? null)} --json`;
}

export function appWakeupPlanCommand(taskName: string, dbPath?: string | null): string {
  return `conveyor app-wakeup-plan ${shellQuote(taskName)}${pathFlag(dbPath ?? null)} --json`;
}

export function directInboxPollCommand(role: AppLoopRole, taskName: string, dbPath?: string | null): string {
  const inbox = role === "manager" ? "manager-inbox" : "worker-inbox";
  return `conveyor ${inbox} ${shellQuote(taskName)} --consume-next --wait --timeout 60${pathFlag(dbPath ?? null)} --json`;
}

function roleStatus(options: {
  dbPath: string | null;
  heartbeatStaleSeconds: number;
  lastHeartbeatAt: string | null;
  name: string | null;
  now: string;
  role: AppLoopRole;
  sessionId: string | null;
  taskName: string;
  threadId: string | null;
  threadTitle: string | null;
  tmuxSession: string | null;
}): AppLoopRoleStatus {
  const hasTmux = Boolean(options.tmuxSession);
  return {
    codex_app_thread_id: options.threadId,
    codex_app_thread_title: options.threadTitle,
    direct_inbox_command: directInboxPollCommand(options.role, options.taskName, options.dbPath),
    lease: {
      age_seconds: ageSeconds(options.lastHeartbeatAt, options.now),
      last_heartbeat_at: options.lastHeartbeatAt,
      stale_after_seconds: options.heartbeatStaleSeconds,
      state: leaseState(options.lastHeartbeatAt, options.now, options.heartbeatStaleSeconds),
    },
    name: options.name,
    poll_command: appHeartbeatPollCommand(options.role, options.taskName, options.dbPath),
    receive_style: hasTmux ? "push" : "pull",
    session_id: options.sessionId,
    session_kind: hasTmux ? "tmux" : options.threadId ? "codex_app" : "no_tmux",
  };
}

function roleWakeup(
  role: AppLoopRole,
  status: AppLoopRoleStatus,
  taskName: string,
  dbPath: string | null,
  state: AppLoopLeaseState,
): AppWakeup {
  const pollCommand = appHeartbeatPollCommand(role, taskName, dbPath);
  const directInboxCommand = directInboxPollCommand(role, taskName, dbPath);
  const roleInstruction = role === "manager"
    ? "If an item is consumed, verify worker claims before recording conclusions, require concrete evidence, update Conveyor state as appropriate, and produce exactly one next worker task."
    : "If an item is consumed, execute only that single worker instruction and return exact commands, compact evidence, blockers or residual risk, and exactly one next recommended worker task.";
  return {
    prompt: [
      "Use the manage-codex-workers skill.",
      `This is the ${role} heartbeat wakeup for task ${taskName}.`,
      `Run: ${pollCommand}`,
      `If the heartbeat result asks for direct inbox polling, run: ${directInboxCommand}`,
      roleInstruction,
      "If no item is consumed, stop after a one-line idle receipt.",
      "Idle polling is not completion and does not authorize heartbeat teardown.",
    ].join("\n"),
    reason: `${role} heartbeat is ${state}.`,
    role,
    thread: {
      id: status.codex_app_thread_id,
      title: status.codex_app_thread_title,
    },
  };
}

function dispatchLeaseState(value: string | null, now: string, staleSeconds: number): AppLoopDispatchState {
  const state = leaseState(value, now, staleSeconds);
  return state === "healthy" ? "healthy" : state === "stale" ? "stale" : "missing";
}

function leaseState(value: string | null, now: string, staleSeconds: number): AppLoopLeaseState {
  if (!value) {
    return "missing";
  }
  const age = ageSeconds(value, now);
  return age !== null && age <= staleSeconds ? "healthy" : "stale";
}

function ageSeconds(value: string | null, now: string): number | null {
  if (!value) {
    return null;
  }
  const parsedNow = Date.parse(now);
  const parsedValue = Date.parse(value);
  if (!Number.isFinite(parsedNow) || !Number.isFinite(parsedValue)) {
    return null;
  }
  return Math.max(0, Math.floor((parsedNow - parsedValue) / 1000));
}

function pathFlag(dbPath: string | null): string {
  return dbPath ? ` --path ${shellQuote(dbPath)}` : "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
