import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type Snapshot = {
  alerts?: Array<{ message: string; severity: string; type: string }>;
  binding?: { manager_session_name: string; worker_session_name: string } | null;
  commands?: { failed_count: number; recent?: Array<Record<string, unknown>>; unfinished_count: number };
  criteria?: {
    open_accepted?: Array<{ criterion: string; id: number | string; status: string }>;
    open_blocker_count: number;
    summary: Record<string, number>;
  };
  latest_cycle?: {
    completed_at?: string;
    started_at?: string;
    state: string;
    status?: {
      last_event_subtype?: string | null;
      manager_context?: {
        manager_config?: {
          acceptance_criteria?: string[];
          guidelines?: string[];
          objective?: string;
          reference_paths?: string[];
          supervision_mode?: string;
        };
      };
      state?: string;
      task_completed?: boolean;
    };
    worker_state?: string;
    notable_pane_pattern?: string | null;
  } | null;
  manager?: { alive: boolean | null; name: string; state?: string; tmux_session?: string | null } | null;
  task?: { name: string; state: string; goal: string };
  telemetry?: {
    recent?: Array<{ actor?: string; event_type?: string; severity?: string; summary?: string; timestamp?: string }>;
    summary: { total: number; by_severity: Record<string, number> };
  };
  worker?: { alive: boolean | null; name: string; state?: string; tmux_session?: string | null } | null;
};

type SessionRow = { name: string; role: "worker" | "manager"; state?: string; tmux_session?: string | null };
type TaskRow = { name: string; state?: string; goal?: string };
type Receipt = { command: string[]; exitCode: number | null; stdout: string; stderr: string; json?: unknown };
type ActivityItem = { detail?: string; key: string; severity?: string; time?: string; title: string };
type PaneHealth = { detail: string; state: "attached" | "missing" | "pending" | "warning"; title: string };
type DiscoverSuggestion = {
  command?: string;
  kind: string;
  manager?: string;
  prompt?: string;
  task?: string;
  worker?: string;
};
type DiscoverPayload = {
  bindings: Array<Record<string, unknown>>;
  query: string;
  sessions: SessionRow[];
  suggestions: DiscoverSuggestion[];
  tasks: TaskRow[];
  telemetry: Array<{ actor?: string; event_type?: string; severity?: string; summary?: string; timestamp?: string }>;
};
type PollState = "idle" | "live" | "error";

function terminalResizeMessage(cols: number, rows: number) {
  return JSON.stringify({ marker: "dashboard-terminal-control", type: "resize", cols, rows });
}

function safeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function derivedWorkerName(taskName: string) {
  return `${safeName(taskName) || "dashboard-task"}-worker`;
}

function derivedManagerName(taskName: string) {
  return `${safeName(taskName) || "dashboard-task"}-manager`;
}

function setupCodeFromTask(taskName: string) {
  const safeTask = safeName(taskName) || "dashboard-task";
  return safeTask.startsWith("dashboard-") ? safeTask.slice("dashboard-".length) : safeTask;
}

function formatTime(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function receiptTitle(receipt: Receipt) {
  return receipt.command.slice(1).join(" ") || receipt.command.join(" ");
}

function buildActivity(snapshot: Snapshot | null, receipts: Receipt[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const seen = new Set<string>();
  function push(item: ActivityItem) {
    if (seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    items.push(item);
  }
  for (const receipt of receipts) {
    push({
      detail: receipt.stderr || receipt.stdout || undefined,
      key: `receipt-${receipt.command.join(" ")}-${receipt.exitCode}-${receipt.stdout.length}-${receipt.stderr.length}`,
      severity: receipt.exitCode === 0 ? "info" : "error",
      title: `${receipt.exitCode === 0 ? "Command ok" : "Command failed"}: ${receiptTitle(receipt)}`,
    });
  }
  for (const event of snapshot?.telemetry?.recent ?? []) {
    push({
      detail: event.summary,
      key: `telemetry-${event.timestamp}-${event.actor}-${event.event_type}-${event.summary}`,
      severity: event.severity,
      time: event.timestamp,
      title: [event.actor, event.event_type].filter(Boolean).join(" / ") || "Telemetry event",
    });
  }
  for (const command of snapshot?.commands?.recent ?? []) {
    const type = String(command.type || command.command || "command");
    const state = String(command.state || command.status || "");
    push({
      key: `command-${type}-${state}-${command.created_at || ""}-${command.id || ""}`,
      severity: state === "failed" ? "error" : "info",
      time: typeof command.created_at === "string" ? command.created_at : undefined,
      title: [type, state].filter(Boolean).join(" "),
    });
  }
  return items.slice(0, 30);
}

function connectionState(snapshot: Snapshot | null) {
  return [
    ["Task", snapshot?.task?.state || "none"],
    ["Binding", snapshot?.binding ? "active" : "none"],
    ["Worker", snapshot?.worker?.alive === false ? "dead" : snapshot?.worker ? "attached" : "missing"],
    ["Manager", snapshot?.manager?.alive === false ? "dead" : snapshot?.manager ? "attached" : "missing"],
    ["Cycle", snapshot?.latest_cycle?.state || "none"],
  ];
}

function buildSetupPrompt(role: "manager" | "worker", params: { cwd: string; setupCode: string; taskGoal: string }) {
  if (role === "worker") {
    return [
      "Use the manage-codex-workers skill.",
      "",
      "Register this current Codex session as the worker for this dashboard setup.",
      "",
      `Dashboard setup code: ${params.setupCode}`,
      `Working directory: ${params.cwd}`,
      "",
      "Let the skill derive the task and session names from the setup code. Do not ask me to type generated worker, manager, or task names.",
      "",
      "After registration, wait for the manager. Do not start work until the manager has bound the task and provided acceptance criteria.",
    ].join("\n");
  }
  return [
    "Use the manage-codex-workers skill.",
    "",
    "Register this current Codex session as the manager for this dashboard setup.",
    "",
    `Dashboard setup code: ${params.setupCode}`,
    `Working directory: ${params.cwd}`,
    `Goal: ${params.taskGoal}`,
    "",
    "Let the skill derive the task and session names from the setup code, find the matching worker, create/configure the task if needed, and bind the worker and manager.",
    "",
    "Run cycles, inspect criteria and telemetry, nudge only when useful, require evidence, and finish/export the task when done.",
  ].join("\n");
}

function buildRegisterCommand(role: "manager" | "worker", params: { cwd: string; managerName: string; workerName: string }) {
  const command = role === "worker" ? "register-worker" : "register-manager";
  const name = role === "worker" ? params.workerName : params.managerName;
  return [
    "scripts/workerctl doctor-self",
    `scripts/workerctl ${command} --name ${name} --pid <current-codex-pid> --cwd ${params.cwd} --tmux-session <current-tmux-session>`,
  ].join("\n");
}

function paneHealth(role: "manager" | "worker", snapshot: Snapshot | null, selectedName: string, sessions: SessionRow[]): PaneHealth {
  const session = role === "worker" ? snapshot?.worker : snapshot?.manager;
  const selected = sessions.find((item) => item.name === selectedName);
  if (session?.tmux_session) {
    return { detail: session.tmux_session, state: "attached", title: "Attached" };
  }
  if (session?.alive === false) {
    return { detail: session.name, state: "missing", title: "Dead session" };
  }
  if (selected?.tmux_session) {
    return { detail: "Select Bind to attach this registered session.", state: "pending", title: "Ready to bind" };
  }
  if (selectedName) {
    return { detail: "Registered session has no tmux session recorded.", state: "warning", title: "No tmux" };
  }
  return { detail: "Register and bind a session to attach this pane.", state: "missing", title: "Not attached" };
}

function SetupSnippet({ label, text }: { label: string; text: string }) {
  async function copy() {
    await navigator.clipboard.writeText(text);
  }
  return (
    <div className="setup-snippet">
      <div>
        <strong>{label}</strong>
        <button type="button" onClick={() => copy().catch(() => undefined)}>Copy</button>
      </div>
      <textarea readOnly value={text} />
    </div>
  );
}

function TerminalPane({ health, title, session }: { health: PaneHealth; title: string; session?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !session) {
      return;
    }
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#07100f", foreground: "#d9e7df" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(ref.current);
    fit.fit();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty?session=${encodeURIComponent(session)}`);
    socket.onmessage = (event) => terminal.write(event.data);
    terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(terminalResizeMessage(terminal.cols, terminal.rows));
      }
    };
    socket.addEventListener("open", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      observer.disconnect();
      socket.close();
      terminal.dispose();
    };
  }, [session]);

  return (
    <section className="terminal-panel">
      <header>
        <span>{title}</span>
        <strong>{session || health.title}</strong>
        <em data-state={health.state}>{health.title}</em>
      </header>
      <div ref={ref} className="terminal-host">
        {!session ? <div className="empty-terminal">{health.detail}</div> : null}
      </div>
    </section>
  );
}

function App() {
  const initialTask = useMemo(() => new URLSearchParams(location.search).get("task") || "", []);
  const defaultTask = useMemo(() => `dashboard-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`, []);
  const pollInFlight = useRef(false);
  const [task, setTask] = useState(initialTask);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [worker, setWorker] = useState("");
  const [manager, setManager] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState(initialTask || defaultTask);
  const [discoverResult, setDiscoverResult] = useState<DiscoverPayload | null>(null);
  const [newTask, setNewTask] = useState(initialTask || defaultTask);
  const [taskGoal, setTaskGoal] = useState("Manual dashboard supervision experiment.");
  const [targetCwd, setTargetCwd] = useState("/Users/neonwatty/Desktop/codex-terminal-manager");
  const [workerName, setWorkerName] = useState(derivedWorkerName(initialTask || defaultTask));
  const [managerName, setManagerName] = useState(derivedManagerName(initialTask || defaultTask));
  const [nudge, setNudge] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollState, setPollState] = useState<PollState>("idle");
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function loadSetup() {
    const [tasksResponse, sessionsResponse] = await Promise.all([
      fetch("/api/tasks"),
      fetch("/api/sessions"),
    ]);
    if (!tasksResponse.ok || !sessionsResponse.ok) {
      throw new Error("Failed to load tasks or sessions.");
    }
    setTasks(await tasksResponse.json());
    setSessions(await sessionsResponse.json());
  }

  async function refresh(selectedTask = task, options: { silent?: boolean } = {}) {
    if (!selectedTask) {
      if (!options.silent) {
        setError("Select a task to load diagnostics.");
      }
      return;
    }
    if (!options.silent) {
      setError(null);
    }
    const response = await fetch(`/api/snapshot?task=${encodeURIComponent(selectedTask)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || response.statusText);
    }
    setSnapshot(await response.json());
    setLastRefreshAt(new Date().toISOString());
    setPollError(null);
  }

  async function discover(query = discoverQuery) {
    const response = await fetch(`/api/discover?query=${encodeURIComponent(query)}&limit=8`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || response.statusText);
    }
    const result = await response.json();
    setDiscoverResult(result);
    return result as DiscoverPayload;
  }

  async function action(endpoint: string, body: Record<string, unknown>, reload = true) {
    setError(null);
    setBusy(true);
    setBusyAction(endpoint);
    try {
      const response = await fetch(`/api/actions/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const receipt = await response.json();
      setReceipts((current) => [receipt, ...current].slice(0, 8));
      if (!response.ok || receipt.exitCode !== 0) {
        setError(receipt.stderr || receipt.error || `${endpoint} failed`);
        return receipt;
      }
      if (reload) {
        await refresh(String(body.task || task));
      }
      return receipt;
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  function updateBootstrapTask(rawValue: string) {
    const previousTask = newTask;
    const value = safeName(rawValue);
    setNewTask(value);
    if (!discoverQuery || discoverQuery === previousTask) {
      setDiscoverQuery(value);
    }
    if (!workerName || workerName === derivedWorkerName(previousTask)) {
      setWorkerName(derivedWorkerName(value));
    }
    if (!managerName || managerName === derivedManagerName(previousTask)) {
      setManagerName(derivedManagerName(value));
    }
  }

  async function createTask() {
    const selectedTask = safeName(newTask || task);
    const receipt = await action("create-task", { task: selectedTask, taskGoal, taskSummary: taskGoal }, false);
    if (receipt?.exitCode === 0) {
      setTask(selectedTask);
      setDiscoverQuery(selectedTask);
      await loadSetup();
      await refresh(selectedTask).catch(() => undefined);
    }
  }

  async function bindSuggestion(suggestion: DiscoverSuggestion) {
    if (!suggestion.task || !suggestion.worker || !suggestion.manager) {
      return;
    }
    setTask(suggestion.task);
    setWorker(suggestion.worker);
    setManager(suggestion.manager);
    const receipt = await action("bind", {
      manager: suggestion.manager,
      task: suggestion.task,
      worker: suggestion.worker,
    });
    if (receipt?.exitCode === 0) {
      await loadSetup();
      await refresh(suggestion.task).catch(() => undefined);
    }
  }

  useEffect(() => {
    loadSetup().catch((err: Error) => setError(err.message));
    if (task) {
      refresh(task).catch((err: Error) => setError(err.message));
    }
  }, []);

  useEffect(() => {
    if (!task) {
      return;
    }
    let cancelled = false;
    async function poll() {
      if (busy || pollInFlight.current) {
        return;
      }
      pollInFlight.current = true;
      setPollState("live");
      try {
        await Promise.all([loadSetup(), refresh(task, { silent: true })]);
        if (!cancelled) {
          setPollState("idle");
          setPollError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPollState("error");
          setPollError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        pollInFlight.current = false;
      }
    }
    const interval = window.setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [busy, task]);

  const workerSession = snapshot?.worker?.tmux_session;
  const managerSession = snapshot?.manager?.tmux_session;
  const workerOptions = sessions.filter((session) => session.role === "worker");
  const managerOptions = sessions.filter((session) => session.role === "manager");
  const activity = buildActivity(snapshot, receipts);
  const bindSuggestions = (discoverResult?.suggestions || []).filter((suggestion) => suggestion.kind === "bind" && suggestion.task && suggestion.worker && suggestion.manager);
  const managerConfig = snapshot?.latest_cycle?.status?.manager_context?.manager_config;
  const selectedWorker = worker || snapshot?.worker?.name || "";
  const selectedManager = manager || snapshot?.manager?.name || "";
  const setupTask = safeName(newTask || task || defaultTask);
  const setupParams = {
    cwd: targetCwd,
    setupCode: setupCodeFromTask(setupTask),
    taskGoal,
  };
  const commandParams = {
    cwd: targetCwd,
    managerName: managerName || derivedManagerName(setupTask),
    workerName: workerName || derivedWorkerName(setupTask),
  };
  const workerHealth = paneHealth("worker", snapshot, selectedWorker, sessions);
  const managerHealth = paneHealth("manager", snapshot, selectedManager, sessions);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>workerctl dashboard</h1>
          <p>Local supervision cockpit bound to loopback.</p>
        </div>
        <label>
          Task
          <input list="task-options" value={task} onChange={(event) => setTask(event.target.value)} placeholder="task name" />
        </label>
        <datalist id="task-options">
          {tasks.map((item) => <option key={item.name} value={item.name} />)}
        </datalist>
        <button onClick={() => refresh().catch((err: Error) => setError(err.message))}>Refresh</button>
      </header>
      <section className="workspace">
        <TerminalPane health={workerHealth} title="Worker" session={workerSession} />
        <TerminalPane health={managerHealth} title="Manager" session={managerSession} />
        <aside className="rail activity-rail">
          <h2>{snapshot?.task?.name || "No task loaded"}</h2>
          <p className="goal">{snapshot?.task?.goal || error || "Load a task to inspect dashboard telemetry."}</p>
          {busyAction ? (
            <div className="status-callout" data-state="busy">
              <strong>Running command...</strong>
              <span>{busyAction}</span>
            </div>
          ) : null}
          {error ? (
            <div className="status-callout" data-state="error">
              <strong>Action failed</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <div className="live-status" data-state={pollState}>
            <strong>{pollState === "live" ? "Updating" : pollState === "error" ? "Update error" : "Live QA lane"}</strong>
            <span>{pollError || (lastRefreshAt ? `Last refresh ${formatTime(lastRefreshAt)}` : "Waiting for a selected task")}</span>
          </div>
          <section className="bootstrap-card">
            <h3>Manual setup</h3>
            <div className="form-grid bootstrap-grid">
              <label>Task
                <input value={newTask} onChange={(event) => updateBootstrapTask(event.target.value)} placeholder={task || "task-name"} />
              </label>
              <label>Goal
                <textarea value={taskGoal} onChange={(event) => setTaskGoal(event.target.value)} placeholder="Task goal" />
              </label>
              <label>Working directory
                <input value={targetCwd} onChange={(event) => setTargetCwd(event.target.value)} />
              </label>
              <SetupSnippet label="Worker setup" text={buildSetupPrompt("worker", setupParams)} />
              <SetupSnippet label="Manager setup" text={buildSetupPrompt("manager", setupParams)} />
              <details className="command-skeletons">
                <summary>Debug command skeletons</summary>
                <SetupSnippet label="Worker command" text={buildRegisterCommand("worker", commandParams)} />
                <SetupSnippet label="Manager command" text={buildRegisterCommand("manager", commandParams)} />
              </details>
            </div>
          </section>
          <section className="bootstrap-card">
            <h3>Manual session binding</h3>
            <div className="form-grid bootstrap-grid">
              <label>Registered worker
                <select value={selectedWorker} onChange={(event) => setWorker(event.target.value)}>
                  <option value="">Select worker</option>
                  {workerOptions.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </label>
              <label>Registered manager
                <select value={selectedManager} onChange={(event) => setManager(event.target.value)}>
                  <option value="">Select manager</option>
                  {managerOptions.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </label>
              <div className="button-grid compact-actions">
                <button disabled={busy} onClick={() => createTask().catch((err: Error) => setError(err.message))}>Create Task Only</button>
                <button disabled={busy || !task || !selectedWorker || !selectedManager} onClick={() => action("bind", { task, worker: selectedWorker, manager: selectedManager })}>Bind Selected Sessions</button>
              </div>
            </div>
          </section>
          <section className="bootstrap-card">
            <h3>Discovery</h3>
            <div className="form-grid discovery-grid">
              <label>Search task, worker, manager, telemetry
                <input value={discoverQuery} onChange={(event) => setDiscoverQuery(event.target.value)} placeholder="dashboard setup code or task name" />
              </label>
              <button disabled={busy} onClick={() => discover().catch((err: Error) => setError(err.message))}>Discover</button>
            </div>
            {discoverResult ? (
              <div className="discovery-results">
                {bindSuggestions.length > 0 ? (
                  <div className="suggestion-list">
                    {bindSuggestions.map((suggestion) => (
                      <button
                        key={`${suggestion.task}-${suggestion.worker}-${suggestion.manager}`}
                        disabled={busy}
                        onClick={() => bindSuggestion(suggestion).catch((err: Error) => setError(err.message))}
                      >
                        Bind {suggestion.worker} to {suggestion.manager}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="discovery-columns">
                  <div>
                    <strong>Tasks</strong>
                    {(discoverResult.tasks || []).slice(0, 4).map((item) => (
                      <button key={item.name} type="button" onClick={() => { setTask(item.name); setNewTask(item.name); }}>{item.name}</button>
                    ))}
                    {discoverResult.tasks.length === 0 ? <span>No task matches</span> : null}
                  </div>
                  <div>
                    <strong>Sessions</strong>
                    {(discoverResult.sessions || []).slice(0, 6).map((item) => (
                      <button
                        key={item.name}
                        type="button"
                        onClick={() => item.role === "worker" ? setWorker(item.name) : setManager(item.name)}
                      >
                        {item.role}: {item.name}
                      </button>
                    ))}
                    {discoverResult.sessions.length === 0 ? <span>No session matches</span> : null}
                  </div>
                </div>
                {(discoverResult.suggestions || []).filter((item) => item.kind !== "bind").slice(0, 2).map((suggestion) => (
                  <p className="suggestion-text" key={`${suggestion.kind}-${suggestion.prompt}`}>{suggestion.prompt || suggestion.kind}</p>
                ))}
              </div>
            ) : null}
          </section>
          <section>
            <h3>Connection</h3>
            <dl className="connection-list">
              {connectionState(snapshot).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <div className="stat-grid">
            <div><span>Worker</span><strong>{snapshot?.worker?.alive === false ? "dead" : snapshot?.worker ? "seen" : "missing"}</strong></div>
            <div><span>Manager</span><strong>{snapshot?.manager?.alive === false ? "dead" : snapshot?.manager ? "seen" : "missing"}</strong></div>
            <div><span>Cycle</span><strong>{snapshot?.latest_cycle?.state || "none"}</strong></div>
            <div><span>Open criteria</span><strong>{snapshot?.criteria?.open_blocker_count ?? 0}</strong></div>
          </div>
          <section>
            <h3>Alerts</h3>
            <ul className="alerts">
              {(snapshot?.alerts || []).slice(0, 6).map((alert) => (
                <li key={`${alert.type}-${alert.message}`} data-severity={alert.severity}>{alert.type}: {alert.message}</li>
              ))}
              {snapshot?.alerts?.length === 0 ? <li>No alerts</li> : null}
            </ul>
          </section>
          <section>
            <h3>Telemetry</h3>
            <p>{snapshot?.telemetry?.summary.total ?? 0} events, {snapshot?.commands?.unfinished_count ?? 0} unfinished commands, {snapshot?.commands?.failed_count ?? 0} failed commands.</p>
          </section>
          <section>
            <h3>Manager config</h3>
            <dl className="config-list">
              <div><dt>Mode</dt><dd>{managerConfig?.supervision_mode || "none"}</dd></div>
              <div><dt>Objective</dt><dd>{managerConfig?.objective || "none"}</dd></div>
              <div><dt>Acceptance</dt><dd>{managerConfig?.acceptance_criteria?.length ?? 0}</dd></div>
              <div><dt>Guidelines</dt><dd>{managerConfig?.guidelines?.length ?? 0}</dd></div>
            </dl>
          </section>
          <section className="actions">
            <button onClick={() => action("cycle", { task })}>Cycle</button>
            <button onClick={() => action("interrupt", { session: snapshot?.worker?.name, key: "C-c", followup: "Please stop and summarize current state." })}>Interrupt</button>
            <button onClick={() => action("finish", { task, requireCriteriaAudit: true })}>Finish</button>
            <button onClick={() => action("export", { task, zip: true }, false)}>Export</button>
          </section>
          <section>
            <h3>Nudge Worker</h3>
            <textarea value={nudge} onChange={(event) => setNudge(event.target.value)} placeholder="Message to send to worker" />
            <button onClick={() => action("nudge", { session: snapshot?.worker?.name, text: nudge })}>Send</button>
          </section>
          <section>
            <h3>Live activity</h3>
            <ol className="activity-list">
              {activity.map((item) => (
                <li key={item.key} data-severity={item.severity}>
                  <time>{formatTime(item.time)}</time>
                  <strong>{item.title}</strong>
                  {item.detail ? <span>{item.detail}</span> : null}
                </li>
              ))}
              {activity.length === 0 ? <li><strong>No activity yet</strong></li> : null}
            </ol>
          </section>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
