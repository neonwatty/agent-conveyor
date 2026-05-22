import http from "node:http";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createServer as createViteServer } from "vite";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

import {
  buildPtyAttachArgs,
  normalizeServerOptions,
  runWorkerctlJson,
  type PartialServerOptions,
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
  latest_cycle?: { state?: string } | null;
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
};

function isDashboardSession(session: Record<string, unknown>): boolean {
  return DASHBOARD_TERMINALS.some((terminal) => terminal.tmuxSession === session.tmux_session);
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
  const taskName = binding?.task_name ? String(binding.task_name) : "";
  if (taskName) {
    try {
      snapshot = await runWorkerctlJson({
        command: "snapshot",
        task: taskName,
        workerctlPath: options.workerctlPath,
        dbPath: options.dbPath,
      }) as SnapshotResult;
    } catch {
      snapshot = null;
    }
  }
  return {
    binding,
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
