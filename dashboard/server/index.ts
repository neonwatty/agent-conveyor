import http from "node:http";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createServer as createViteServer } from "vite";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

import {
  buildPtyAttachArgs,
  normalizeServerOptions,
  runWorkerctlJson,
  type PartialServerOptions,
  type WorkerctlCommandOptions,
} from "./workerctl.ts";
import { parseTerminalControlMessage } from "./terminal.ts";

const DASHBOARD_TERMINALS = [
  { id: "a", label: "Terminal A", tmuxSession: "workerctl-dashboard-a" },
  { id: "b", label: "Terminal B", tmuxSession: "workerctl-dashboard-b" },
] as const;

function resolveExecutable(name: string): string {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : name;
}

function disableTmuxStatus(session: string): void {
  spawnSync(resolveExecutable("tmux"), ["set-option", "-t", session, "status", "off"], { stdio: "ignore" });
}

function shellEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.npm_config_prefix;
  return env;
}

function resetDashboardShells(cwd: string): void {
  const tmux = resolveExecutable("tmux");
  const shell = process.env.SHELL || "/bin/zsh";
  for (const terminal of DASHBOARD_TERMINALS) {
    spawnSync(tmux, ["kill-session", "-t", terminal.tmuxSession], { stdio: "ignore" });
    const result = spawnSync(tmux, ["new-session", "-d", "-s", terminal.tmuxSession, "-c", cwd, "env", "-u", "npm_config_prefix", shell], {
      encoding: "utf8",
      env: shellEnvironment(),
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `Failed to create tmux session ${terminal.tmuxSession}`);
    }
    disableTmuxStatus(terminal.tmuxSession);
  }
}

type TerminalProcess = {
  kill: () => void;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: () => void) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
};

type DiscoverResult = {
  bindings?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
};

type SnapshotResult = {
  alerts?: Array<{ message?: string; severity?: string; type?: string }>;
  commands?: {
    failed_count?: number;
    unfinished_count?: number;
  };
  latest_cycle?: { state?: string } | null;
  manager?: { last_heartbeat_at?: string | null } | null;
  task?: { goal?: string; name?: string; state?: string } | null;
  telemetry?: {
    recent?: Array<{
      actor?: string;
      attributes?: Record<string, unknown>;
      correlation?: Record<string, unknown>;
      event_type?: string;
      severity?: string;
      summary?: string;
      timestamp?: string;
    }>;
  };
  worker?: { last_heartbeat_at?: string | null } | null;
};

type TelemetryEvent = {
  actor?: string;
  attributes?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
  event_type?: string;
  severity?: string;
  summary?: string;
  timestamp?: string;
};

type AuditCommand = {
  available_at?: string | null;
  claim_expires_at?: string | null;
  claimed_at?: string | null;
  claimed_by?: string | null;
  correlation_id?: string | null;
  created_at?: string;
  error?: string | null;
  id?: string;
  state?: string;
  type?: string;
  updated_at?: string;
};

type AuditCommandAttempt = {
  command_id?: string;
  correlation_id?: string | null;
  dispatcher_id?: string | null;
  error?: string | null;
  finished_at?: string | null;
  id?: number;
  side_effect_completed?: boolean;
  side_effect_started?: boolean;
  started_at?: string;
  state?: string;
};

type AuditCorrelationChain = {
  attempt_ids?: number[];
  command_id?: string | null;
  command_state?: string;
  command_type?: string;
  correlation_id?: string | null;
  created_at?: string;
  manager_cycle_id?: number | null;
  manager_decision_id?: number | null;
  routed_notification_ids?: number[];
  signal_type?: string;
  source_event_id?: number | null;
};

type AuditResult = {
  command_attempts?: AuditCommandAttempt[];
  commands?: AuditCommand[];
  correlation_chains?: AuditCorrelationChain[];
  routed_notifications?: Array<Record<string, unknown>>;
};

type DispatchConversationItem = {
  detail?: string;
  kind: string;
  label: string;
};

export function isDashboardSession(session: Record<string, unknown>): boolean {
  return session.state !== "gone" && DASHBOARD_TERMINALS.some((terminal) => terminal.tmuxSession === session.tmux_session);
}

function sessionAlive(session: Record<string, unknown>): boolean | null {
  const pid = Number(session.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findDashboardBinding(discovered: DiscoverResult, sessions: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const names = new Set(sessions.map((session) => String(session.name)));
  for (const binding of discovered.bindings || []) {
    if (names.has(String(binding.worker_name)) || names.has(String(binding.manager_name))) {
      return binding;
    }
    if (
      DASHBOARD_TERMINALS.some((terminal) => terminal.tmuxSession === binding.worker_tmux_session)
      || DASHBOARD_TERMINALS.some((terminal) => terminal.tmuxSession === binding.manager_tmux_session)
    ) {
      return binding;
    }
  }
  return null;
}

function terminalState(terminal: (typeof DASHBOARD_TERMINALS)[number], sessions: Array<Record<string, unknown>>) {
  const session = sessions.find((item) => item.tmux_session === terminal.tmuxSession);
  const registeredRole = session?.role === "worker" || session?.role === "manager" ? session.role : null;
  return {
    id: terminal.id,
    label: terminal.label,
    registered_session: session && registeredRole ? {
      alive: sessionAlive(session),
      name: String(session.name),
      role: registeredRole,
      state: session.state ? String(session.state) : undefined,
    } : null,
    role: registeredRole || "shell",
    tmux_session: terminal.tmuxSession,
  };
}

function isExpiredTimestamp(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < now;
}

function latestDispatchHeartbeat(snapshot: SnapshotResult | null, durableHeartbeats: TelemetryEvent[] = []) {
  const heartbeats = [
    ...durableHeartbeats,
    ...(snapshot?.telemetry?.recent || []),
  ]
    .filter((event) => event.actor === "dispatch" && event.event_type === "dispatch_watch_heartbeat")
    .sort((left, right) => Date.parse(String(right.timestamp || "")) - Date.parse(String(left.timestamp || "")));
  const heartbeat = heartbeats[0];
  if (!heartbeat) {
    return {
      stale: true,
      stale_seconds: null,
      state: "not_observed",
      timestamp: "",
    };
  }
  const timestamp = heartbeat.timestamp || "";
  const parsedTimestamp = Date.parse(timestamp);
  const ageSeconds = Number.isFinite(parsedTimestamp)
    ? Math.max(0, Math.round((Date.now() - parsedTimestamp) / 1000))
    : null;
  const stale = ageSeconds === null ? true : ageSeconds > 30;
  return {
    dispatcher_id: typeof heartbeat.correlation?.dispatcher_id === "string" ? heartbeat.correlation.dispatcher_id : undefined,
    dry_run: typeof heartbeat.attributes?.dry_run === "boolean" ? heartbeat.attributes.dry_run : undefined,
    iteration: typeof heartbeat.correlation?.iteration === "number" ? heartbeat.correlation.iteration : undefined,
    processed_count: typeof heartbeat.attributes?.processed_count === "number" ? heartbeat.attributes.processed_count : undefined,
    stale,
    stale_seconds: ageSeconds,
    state: stale ? "stale" : "active",
    timestamp,
  };
}

function dispatchOperatorMessage(coreStatus: "active" | "not_observed" | "stale"): string {
  if (coreStatus === "active") {
    return "Dispatch is routing worker/manager events.";
  }
  if (coreStatus === "stale") {
    return "Dispatch heartbeat is stale; worker completions may not wake managers.";
  }
  return "Dispatch has not been observed; worker completions will not wake managers.";
}

function commandLabel(command: AuditCommand | undefined, commandId: string | undefined): string {
  const type = command?.type || "command";
  const id = command?.id || commandId || "";
  return id ? `${type} ${id}` : type;
}

function notificationLabel(notification: Record<string, unknown> | undefined, fallbackType: string | undefined): string {
  const signalType = String(notification?.signal_type || fallbackType || "notification");
  return notification?.id ? `${signalType} notification #${notification.id}` : signalType;
}

function notificationMessage(notification: Record<string, unknown> | undefined): string | undefined {
  const payload = notification?.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function notificationWorkerReceipt(notification: Record<string, unknown> | undefined): string | undefined {
  const payload = notification?.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const receipt = (payload as Record<string, unknown>).worker_receipt;
  if (!receipt || typeof receipt !== "object") {
    return undefined;
  }
  const message = (receipt as Record<string, unknown>).last_agent_message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function latestDispatchAttempt(attempts: AuditCommandAttempt[]): AuditCommandAttempt | undefined {
  const timestampedAttempts = attempts
    .map((attempt) => ({ attempt, timestamp: attempt.started_at ? Date.parse(attempt.started_at) : NaN }))
    .filter((item) => Number.isFinite(item.timestamp));
  if (timestampedAttempts.length) {
    return timestampedAttempts.reduce((latest, item) => (item.timestamp >= latest.timestamp ? item : latest)).attempt;
  }
  return attempts.at(-1);
}

function dispatchConversationItems(
  chain: AuditCorrelationChain,
  attempts: AuditCommandAttempt[],
  primaryNotification: Record<string, unknown> | undefined,
): DispatchConversationItem[] {
  const dispatchAttempt = latestDispatchAttempt(attempts);
  return [
    chain.manager_decision_id
      ? { kind: "manager_decision", label: `Manager decision #${chain.manager_decision_id}` }
      : null,
    dispatchAttempt
      ? { kind: "dispatch_attempt", label: `Dispatch ${dispatchAttempt.state || "attempted"} via ${dispatchAttempt.dispatcher_id || "unknown dispatcher"}` }
      : null,
    primaryNotification
      ? {
        detail: notificationMessage(primaryNotification),
        kind: "routed_notification",
        label: `Routed notification #${primaryNotification.id} ${primaryNotification.state || "unknown"}`,
      }
      : null,
    primaryNotification && notificationWorkerReceipt(primaryNotification)
      ? {
        detail: notificationWorkerReceipt(primaryNotification),
        kind: "worker_receipt",
        label: `Worker receipt from source event #${primaryNotification.source_event_id || "unknown"}`,
      }
      : null,
    chain.manager_cycle_id
      ? { kind: "manager_cycle", label: `Manager cycle #${chain.manager_cycle_id} consumed the routed fact` }
      : null,
  ].filter((item): item is DispatchConversationItem => item !== null);
}

function chainTimestamp(value: unknown): number {
  if (typeof value !== "string" || !value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function dispatchChainEntries(audit: AuditResult | null) {
  const commandsById = new Map((audit?.commands || []).map((command) => [String(command.id), command]));
  const notificationsById = new Map((audit?.routed_notifications || []).map((notification) => [Number(notification.id), notification]));
  const attemptsById = new Map((audit?.command_attempts || []).map((attempt) => [Number(attempt.id), attempt]));
  const attemptsByCommand = new Map<string, AuditCommandAttempt[]>();
  for (const attempt of audit?.command_attempts || []) {
    if (attempt.command_id) {
      attemptsByCommand.set(attempt.command_id, [...(attemptsByCommand.get(attempt.command_id) || []), attempt]);
    }
  }
  const entries = (audit?.correlation_chains || []).map((chain) => {
    const command = chain.command_id ? commandsById.get(chain.command_id) : undefined;
    const chainAttempts = (chain.attempt_ids || [])
      .map((id) => attemptsById.get(Number(id)))
      .filter((attempt) => attempt !== undefined);
    const attempts = chainAttempts.length ? chainAttempts : chain.command_id ? attemptsByCommand.get(chain.command_id) || [] : [];
    const notifications = (chain.routed_notification_ids || [])
      .map((id) => notificationsById.get(Number(id)))
      .filter((notification) => notification !== undefined);
    const primaryNotification = notifications[0];
    const riskyAttempts = attempts.filter((attempt) => attempt.side_effect_started && !attempt.side_effect_completed);
    return {
      attempts: attempts.map((attempt) => ({
        dispatcher_id: attempt.dispatcher_id,
        error: attempt.error,
        id: attempt.id,
        side_effect_completed: Boolean(attempt.side_effect_completed),
        side_effect_started: Boolean(attempt.side_effect_started),
        state: attempt.state,
      })),
      command_id: chain.command_id,
      command_state: chain.command_state || command?.state || (typeof primaryNotification?.state === "string" ? primaryNotification.state : undefined),
      command_type: chain.command_type || command?.type || (typeof primaryNotification?.signal_type === "string" ? primaryNotification.signal_type : undefined),
      correlation_id: chain.correlation_id || command?.correlation_id || (typeof primaryNotification?.correlation_id === "string" ? primaryNotification.correlation_id : undefined),
      conversation: dispatchConversationItems(chain, attempts, primaryNotification),
      error: attempts.find((attempt) => attempt.error)?.error || command?.error || (typeof primaryNotification?.error === "string" ? primaryNotification.error : undefined),
      key: `chain-${chain.command_id || chain.correlation_id || chain.routed_notification_ids?.join("-")}`,
      manager_cycle_id: chain.manager_cycle_id,
      manager_decision_id: chain.manager_decision_id,
      notification_count: chain.routed_notification_ids?.length || 0,
      side_effect_risk: riskyAttempts.length > 0,
      source_event_id: chain.source_event_id,
      summary: command ? commandLabel(command, chain.command_id || undefined) : notificationLabel(primaryNotification, chain.signal_type || chain.command_type),
      time: chain.created_at || command?.created_at || (typeof primaryNotification?.created_at === "string" ? primaryNotification.created_at : undefined),
    };
  });
  return entries
    .sort((left, right) => chainTimestamp(right.time) - chainTimestamp(left.time))
    .slice(0, 12);
}

export function dashboardTaskName(options: Pick<ReturnType<typeof normalizeServerOptions>, "task">, binding: Record<string, unknown> | null): string {
  return options.task || (binding?.task_name ? String(binding.task_name) : "");
}

export function dispatchHealth(
  snapshot: SnapshotResult | null,
  audit: AuditResult | null,
  suppressedTelemetry?: Array<Record<string, unknown>>,
  heartbeatTelemetry?: Array<Record<string, unknown>>,
) {
  const now = Date.now();
  const commands = audit?.commands || [];
  const attempts = audit?.command_attempts || [];
  const queued = commands.filter((command) => command.state === "pending" || command.state === "attempted");
  const failed = commands.filter((command) => command.state === "failed");
  const stale = queued.filter((command) => isExpiredTimestamp(command.claim_expires_at, now));
  const sideEffectRisk = attempts.filter((attempt) => attempt.side_effect_started && !attempt.side_effect_completed);
  const suppressedSignals = (suppressedTelemetry || snapshot?.telemetry?.recent || [])
    .filter((event) => event.actor === "dispatch" && event.event_type === "dispatch_signal_suppressed");
  const heartbeat = latestDispatchHeartbeat(snapshot, heartbeatTelemetry as TelemetryEvent[]);
  const coreStatus = heartbeat.state as "active" | "not_observed" | "stale";
  return {
    core_status: coreStatus,
    failed_count: commands.length ? failed.length : snapshot?.commands?.failed_count || 0,
    heartbeat,
    operator_message: dispatchOperatorMessage(coreStatus),
    queued_count: commands.length ? queued.length : snapshot?.commands?.unfinished_count || 0,
    side_effect_risk_count: sideEffectRisk.length,
    stale_claim_count: stale.length,
    suppressed_signal_count: suppressedSignals.length,
  };
}

export function dispatchHeartbeatTelemetryOptions(
  options: Pick<ReturnType<typeof normalizeServerOptions>, "workerctlPath" | "dbPath">,
): WorkerctlCommandOptions {
  return {
    command: "telemetry",
    limit: 1,
    telemetryActor: "dispatch",
    telemetryEventType: "dispatch_watch_heartbeat",
    telemetryNewest: true,
    workerctlPath: options.workerctlPath,
    dbPath: options.dbPath,
  };
}

function interpretedTimeline({
  binding,
  snapshot,
  terminals,
}: {
  binding: Record<string, unknown> | null;
  snapshot: SnapshotResult | null;
  terminals: ReturnType<typeof terminalState>[];
}) {
  const items: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  for (const terminal of DASHBOARD_TERMINALS) {
    items.push({
      key: `shell-${terminal.id}`,
      time: now,
      title: `${terminal.label} shell ready`,
      detail: terminal.tmuxSession,
      severity: "info",
    });
  }
  for (const terminal of terminals) {
    if (terminal.registered_session) {
      items.push({
        key: `registered-${terminal.id}-${terminal.registered_session.name}`,
        time: now,
        title: `${terminal.label} registered as ${terminal.registered_session.role}`,
        detail: terminal.registered_session.name,
        severity: terminal.registered_session.alive === false ? "warning" : "info",
      });
    }
  }
  if (binding) {
    items.push({
      key: `binding-${binding.id || binding.task_name}`,
      time: String(binding.created_at || now),
      title: "Worker and manager bound",
      detail: [binding.task_name, binding.worker_name, binding.manager_name].filter(Boolean).join(" / "),
      severity: "info",
    });
  }
  for (const alert of snapshot?.alerts || []) {
    items.push({
      key: `alert-${alert.type}-${alert.message}`,
      title: alert.type || "Alert",
      detail: alert.message,
      severity: alert.severity || "warning",
    });
  }
  for (const event of snapshot?.telemetry?.recent || []) {
    items.push({
      key: `telemetry-${event.timestamp}-${event.actor}-${event.event_type}-${event.summary}`,
      time: event.timestamp,
      title: [event.actor, event.event_type].filter(Boolean).join(" / ") || "Telemetry event",
      detail: event.summary,
      severity: event.severity,
      raw: event,
    });
  }
  return items.slice(0, 40);
}

async function dashboardObservation(options: ReturnType<typeof normalizeServerOptions>) {
  const discovered = await runWorkerctlJson({
    command: "discover",
    includeAll: true,
    limit: 100,
    workerctlPath: options.workerctlPath,
    dbPath: options.dbPath,
  }) as DiscoverResult;
  const sessions = (discovered.sessions || []).filter(isDashboardSession);
  const terminals = DASHBOARD_TERMINALS.map((terminal) => terminalState(terminal, sessions));
  const binding = findDashboardBinding(discovered, sessions);
  let snapshot: SnapshotResult | null = null;
  let audit: AuditResult | null = null;
  let suppressedTelemetry: Array<Record<string, unknown>> = [];
  let heartbeatTelemetry: Array<Record<string, unknown>> = [];
  const taskName = dashboardTaskName(options, binding);
  if (taskName) {
    try {
      snapshot = await runWorkerctlJson({
        command: "snapshot",
        limit: 25,
        task: taskName,
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }) as SnapshotResult;
    } catch {
      snapshot = null;
    }
    try {
      audit = await runWorkerctlJson({
        command: "audit",
        task: taskName,
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }) as AuditResult;
    } catch {
      audit = null;
    }
    try {
      suppressedTelemetry = await runWorkerctlJson({
        command: "telemetry",
        limit: 1000,
        task: taskName,
        telemetryActor: "dispatch",
        telemetryEventType: "dispatch_signal_suppressed",
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }) as Array<Record<string, unknown>>;
    } catch {
      suppressedTelemetry = [];
    }
    try {
      heartbeatTelemetry = await runWorkerctlJson(dispatchHeartbeatTelemetryOptions(options)) as Array<Record<string, unknown>>;
    } catch {
      heartbeatTelemetry = [];
    }
  }
  return {
    audit: audit ? {
      command_attempts: audit.command_attempts || [],
      commands: audit.commands || [],
      correlation_chains: audit.correlation_chains || [],
      routed_notifications: audit.routed_notifications || [],
    } : null,
    binding,
    dispatch: {
      chains: dispatchChainEntries(audit),
      health: dispatchHealth(snapshot, audit, suppressedTelemetry, heartbeatTelemetry),
    },
    latest_cycle: snapshot?.latest_cycle || null,
    polled_at: new Date().toISOString(),
    task: snapshot?.task || (taskName ? { name: taskName } : null),
    terminals,
    timeline: interpretedTimeline({ binding, snapshot, terminals }),
  };
}

function spawnScriptTmuxAttach(session: string): TerminalProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    resolveExecutable("script"),
    ["-q", "/dev/null", resolveExecutable("tmux"), "attach", "-t", session],
    { cwd: process.cwd(), env: process.env },
  );
  return {
    kill: () => child.kill(),
    onData: (callback) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", callback);
      child.stderr.on("data", callback);
    },
    onExit: (callback) => {
      child.on("close", callback);
      child.on("exit", callback);
    },
    resize: () => undefined,
    write: (data) => child.stdin.write(data),
  };
}

function parseArgs(argv: string[]): PartialServerOptions {
  const options: PartialServerOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--host") {
      options.host = value;
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(value);
      index += 1;
    } else if (arg === "--task") {
      options.task = value;
      index += 1;
    } else if (arg === "--workerctl-path") {
      options.workerctlPath = value;
      index += 1;
    } else if (arg === "--db-path") {
      options.dbPath = value;
      index += 1;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = normalizeServerOptions(parseArgs(process.argv.slice(2)));
  resetDashboardShells(process.cwd());
  const app = express();
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true });

  app.use(express.json());
  app.get("/api/config", (_request, response) => {
    response.json({
      host: options.host,
      port: options.port,
      terminals: DASHBOARD_TERMINALS,
    });
  });
  app.get("/api/observation", async (_request, response, next) => {
    try {
      response.json(await dashboardObservation(options));
    } catch (error) {
      next(error);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname !== "/pty") {
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      sockets.emit("connection", ws, request, url);
    });
  });

  sockets.on("connection", (ws: WebSocket, _request: http.IncomingMessage, url: URL) => {
    const session = url.searchParams.get("session") || "";
    if (!DASHBOARD_TERMINALS.some((terminal) => terminal.tmuxSession === session)) {
      ws.send(`Dashboard only attaches ${DASHBOARD_TERMINALS.map((terminal) => terminal.tmuxSession).join(" or ")}.\r\n`);
      ws.close();
      return;
    }
    const [, ...args] = buildPtyAttachArgs({ session });
    disableTmuxStatus(session);
    let term: TerminalProcess;
    try {
      const ptyTerm = pty.spawn(resolveExecutable("tmux"), args, {
        cols: 120,
        rows: 36,
        name: "xterm-256color",
        cwd: process.cwd(),
        env: process.env,
      });
      term = {
        kill: () => ptyTerm.kill(),
        onData: (callback) => ptyTerm.onData(callback),
        onExit: (callback) => ptyTerm.onExit(callback),
        resize: (cols, rows) => ptyTerm.resize(cols, rows),
        write: (data) => ptyTerm.write(data),
      };
    } catch (error) {
      try {
        term = spawnScriptTmuxAttach(session);
      } catch (fallbackError) {
        ws.send(`Failed to attach tmux session ${session}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\r\n`);
        ws.close();
        return;
      }
    }
    term.onData((data) => ws.send(data));
    term.onExit(() => ws.close());
    ws.on("message", (message: RawData) => {
      const text = message.toString();
      const control = parseTerminalControlMessage(text);
      if (control) {
        term.resize(control.cols, control.rows);
        return;
      }
      term.write(text);
    });
    ws.on("close", () => term.kill());
  });

  const vite = await createViteServer({
    root: "dashboard",
    server: { hmr: { server }, middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  server.listen(options.port, options.host, () => {
    console.log(`workerctl dashboard: http://${options.host}:${options.port}/`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
