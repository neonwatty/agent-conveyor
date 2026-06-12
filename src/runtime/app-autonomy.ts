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

export type AppWakeupDispatchActionStatus = "blocked_missing_thread" | "ready_to_send" | "skipped_healthy";

export interface AppWakeupDispatchAction {
  blocker: string | null;
  prompt: string | null;
  reason: string;
  role: AppLoopRole;
  send_ready: boolean;
  status: AppWakeupDispatchActionStatus;
  thread: {
    id: string | null;
    title: string | null;
  };
}

export interface AppWakeupDispatchPlan {
  actions: AppWakeupDispatchAction[];
  dispatcher: AppWakeupPlan["dispatcher"];
  status: AppLoopStatus;
  summary: {
    blocked: number;
    dispatcher_required: boolean;
    ready_to_send: number;
    skipped: number;
    total_actions: number;
  };
}

export type AppAutopilotDesiredState = "active" | "stopped" | "unconfigured";

export interface AppAutopilotRoleAutomation {
  blocker: string | null;
  can_create: boolean;
  interval_minutes: number;
  kind: "heartbeat";
  name: string;
  prompt: string;
  role: AppLoopRole;
  rrule: string;
  target_thread_id: string | null;
  target_thread_title: string | null;
}

export interface AppAutopilotPlan {
  automation_specs: AppAutopilotRoleAutomation[];
  control: {
    dispatcher_command: string;
    note: string;
    status_command: string;
    stop_command: string;
    wakeup_dispatch_command: string;
  };
  desired_state: AppAutopilotDesiredState;
  dispatcher: AppWakeupPlan["dispatcher"];
  interval_minutes: number;
  last_policy_event: {
    event_id: string;
    event_type: string;
    recorded_at: string;
  } | null;
  status: AppLoopStatus;
  summary: {
    blocked_automations: number;
    creatable_automations: number;
    dispatcher_required: boolean;
    total_automations: number;
  };
  task: { id: string; name: string };
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

export function appAutopilotPlanSync(
  database: DatabaseSync,
  options: {
    dbPath?: string | null;
    dispatchIntervalSeconds: number;
    dispatcherId: string;
    desiredState?: AppAutopilotDesiredState | null;
    heartbeatIntervalMinutes: number;
    heartbeatStaleSeconds: number;
    now: string;
    taskName: string;
    watchIterations: number;
  },
): AppAutopilotPlan {
  const status = appLoopStatusSync(database, {
    dbPath: options.dbPath ?? null,
    dispatcherId: options.dispatcherId,
    heartbeatStaleSeconds: options.heartbeatStaleSeconds,
    now: options.now,
    taskName: options.taskName,
  });
  const lastPolicy = latestAppAutopilotPolicyEvent(database, status.task.id, options.dispatcherId);
  const desiredState = options.desiredState ?? lastPolicy?.desired_state ?? "unconfigured";
  const dispatcherCommand = [
    "conveyor dispatch --watch",
    `--watch-iterations ${options.watchIterations}`,
    `--interval ${formatNumber(options.dispatchIntervalSeconds)}`,
    `--dispatcher-id ${shellQuote(options.dispatcherId)}`,
    pathFlag(options.dbPath ?? null).trim(),
  ].filter(Boolean).join(" ");
  const automationSpecs = (["manager", "worker"] as const).map((role) => {
    const roleStatus = role === "manager" ? status.manager : status.worker;
    const wakeup = roleWakeup(role, roleStatus, status.task.name, options.dbPath ?? null, roleStatus.lease.state);
    const name = `Conveyor ${status.task.name} ${role} heartbeat`;
    return {
      blocker: roleStatus.codex_app_thread_id
        ? null
        : `No Codex app thread id is registered for the ${role}; register app thread metadata before creating an app heartbeat automation.`,
      can_create: Boolean(roleStatus.codex_app_thread_id),
      interval_minutes: options.heartbeatIntervalMinutes,
      kind: "heartbeat" as const,
      name,
      prompt: wakeup.prompt,
      role,
      rrule: `FREQ=MINUTELY;INTERVAL=${options.heartbeatIntervalMinutes}`,
      target_thread_id: roleStatus.codex_app_thread_id,
      target_thread_title: roleStatus.codex_app_thread_title,
    };
  });
  const creatable = automationSpecs.filter((spec) => spec.can_create).length;
  return {
    automation_specs: automationSpecs,
    control: {
      dispatcher_command: dispatcherCommand,
      note: "A plain shell CLI cannot call Codex app thread tools. Create or pause these heartbeat automations from a Codex app session, then use this CLI for status/start/stop receipts.",
      status_command: `conveyor app-autopilot status ${shellQuote(status.task.name)}${pathFlag(options.dbPath ?? null)} --json`,
      stop_command: `conveyor app-autopilot stop ${shellQuote(status.task.name)}${pathFlag(options.dbPath ?? null)} --json`,
      wakeup_dispatch_command: `conveyor app-wakeup-dispatch ${shellQuote(status.task.name)} --dispatcher-id ${shellQuote(options.dispatcherId)}${pathFlag(options.dbPath ?? null)} --json`,
    },
    desired_state: desiredState,
    dispatcher: {
      command: dispatcherCommand,
      required: status.dispatch.state !== "healthy",
      state: status.dispatch.state,
    },
    interval_minutes: options.heartbeatIntervalMinutes,
    last_policy_event: lastPolicy
      ? {
        event_id: lastPolicy.event_id,
        event_type: lastPolicy.event_type,
        recorded_at: lastPolicy.recorded_at,
      }
      : null,
    status,
    summary: {
      blocked_automations: automationSpecs.length - creatable,
      creatable_automations: creatable,
      dispatcher_required: status.dispatch.state !== "healthy",
      total_automations: automationSpecs.length,
    },
    task: status.task,
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

export function appWakeupDispatchPlanSync(
  database: DatabaseSync,
  options: {
    dbPath?: string | null;
    dispatcherId: string;
    heartbeatStaleSeconds: number;
    now: string;
    taskName: string;
  },
): AppWakeupDispatchPlan {
  const plan = appWakeupPlanSync(database, options);
  const wakeupsByRole = new Map(plan.wakeups.map((wakeup) => [wakeup.role, wakeup]));
  const actions = (["manager", "worker"] as const).map((role) => {
    const roleStatus = role === "manager" ? plan.status.manager : plan.status.worker;
    const wakeup = wakeupsByRole.get(role);
    if (!wakeup) {
      return {
        blocker: null,
        prompt: null,
        reason: `${role} heartbeat is healthy.`,
        role,
        send_ready: false,
        status: "skipped_healthy" as const,
        thread: {
          id: roleStatus.codex_app_thread_id,
          title: roleStatus.codex_app_thread_title,
        },
      };
    }
    if (!wakeup.thread.id) {
      return {
        blocker: `No Codex app thread id is registered for the ${role}; use the prompt manually or register app thread metadata before calling send_message_to_thread.`,
        prompt: wakeup.prompt,
        reason: wakeup.reason,
        role,
        send_ready: false,
        status: "blocked_missing_thread" as const,
        thread: wakeup.thread,
      };
    }
    return {
      blocker: null,
      prompt: wakeup.prompt,
      reason: wakeup.reason,
      role,
      send_ready: true,
      status: "ready_to_send" as const,
      thread: wakeup.thread,
    };
  });
  const ready = actions.filter((action) => action.status === "ready_to_send").length;
  const blocked = actions.filter((action) => action.status === "blocked_missing_thread").length;
  const skipped = actions.filter((action) => action.status === "skipped_healthy").length;
  return {
    actions,
    dispatcher: plan.dispatcher,
    status: plan.status,
    summary: {
      blocked,
      dispatcher_required: plan.dispatcher.required,
      ready_to_send: ready,
      skipped,
      total_actions: actions.length,
    },
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

function latestAppAutopilotPolicyEvent(
  database: DatabaseSync,
  taskId: string,
  dispatcherId: string,
): { desired_state: AppAutopilotDesiredState; event_id: string; event_type: string; recorded_at: string } | null {
  const row = database.prepare(`
    select id, event_type, timestamp
    from telemetry_events
    where task_id = ?
      and event_type in ('app_autopilot_started', 'app_autopilot_stopped')
      and json_extract(correlation_json, '$.dispatcher_id') = ?
    order by timestamp desc, rowid desc
    limit 1
  `).get(taskId, dispatcherId) as { event_type: string; id: string; timestamp: string } | undefined;
  if (!row) {
    return null;
  }
  return {
    desired_state: row.event_type === "app_autopilot_started" ? "active" : "stopped",
    event_id: row.id,
    event_type: row.event_type,
    recorded_at: row.timestamp,
  };
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

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
