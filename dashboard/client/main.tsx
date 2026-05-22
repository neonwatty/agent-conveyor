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

function terminalResizeMessage(cols: number, rows: number) {
  return JSON.stringify({ marker: "dashboard-terminal-control", type: "resize", cols, rows });
}

function safeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
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
  for (const receipt of receipts) {
    items.push({
      detail: receipt.stderr || receipt.stdout || undefined,
      key: `receipt-${receipt.command.join(" ")}-${items.length}`,
      severity: receipt.exitCode === 0 ? "info" : "error",
      title: `${receipt.exitCode === 0 ? "Command ok" : "Command failed"}: ${receiptTitle(receipt)}`,
    });
  }
  for (const event of snapshot?.telemetry?.recent ?? []) {
    items.push({
      detail: event.summary,
      key: `telemetry-${event.timestamp}-${event.event_type}-${items.length}`,
      severity: event.severity,
      time: event.timestamp,
      title: [event.actor, event.event_type].filter(Boolean).join(" / ") || "Telemetry event",
    });
  }
  for (const command of snapshot?.commands?.recent ?? []) {
    const type = String(command.type || command.command || "command");
    const state = String(command.state || command.status || "");
    items.push({
      key: `command-${type}-${command.created_at || items.length}`,
      severity: state === "failed" ? "error" : "info",
      time: typeof command.created_at === "string" ? command.created_at : undefined,
      title: [type, state].filter(Boolean).join(" "),
    });
  }
  return items.slice(0, 30);
}

function TerminalPane({ title, session }: { title: string; session?: string | null }) {
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
        <strong>{session || "No tmux session"}</strong>
      </header>
      <div ref={ref} className="terminal-host">
        {!session ? <div className="empty-terminal">Use Start & Attach Pair to create a tmux-backed session and attach this pane automatically.</div> : null}
      </div>
    </section>
  );
}

function App() {
  const initialTask = useMemo(() => new URLSearchParams(location.search).get("task") || "", []);
  const defaultTask = useMemo(() => `dashboard-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`, []);
  const [task, setTask] = useState(initialTask);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [worker, setWorker] = useState("");
  const [manager, setManager] = useState("");
  const [newTask, setNewTask] = useState(initialTask || defaultTask);
  const [taskGoal, setTaskGoal] = useState("Manual dashboard supervision experiment.");
  const [nudge, setNudge] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function loadSetup() {
    const [tasksResponse, sessionsResponse] = await Promise.all([
      fetch("/api/tasks"),
      fetch("/api/sessions"),
    ]);
    setTasks(await tasksResponse.json());
    setSessions(await sessionsResponse.json());
  }

  async function refresh(selectedTask = task) {
    if (!selectedTask) {
      setError("Select a task to load diagnostics.");
      return;
    }
    setError(null);
    const response = await fetch(`/api/snapshot?task=${encodeURIComponent(selectedTask)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || response.statusText);
    }
    setSnapshot(await response.json());
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
    const value = safeName(rawValue);
    setNewTask(value);
  }

  async function createTask() {
    const selectedTask = safeName(newTask || task);
    const receipt = await action("create-task", { task: selectedTask, taskGoal, taskSummary: taskGoal }, false);
    if (receipt?.exitCode === 0) {
      setTask(selectedTask);
      await loadSetup();
      await refresh(selectedTask).catch(() => undefined);
    }
  }

  useEffect(() => {
    loadSetup().catch((err: Error) => setError(err.message));
    if (task) {
      refresh(task).catch((err: Error) => setError(err.message));
    }
  }, []);

  const workerSession = snapshot?.worker?.tmux_session;
  const managerSession = snapshot?.manager?.tmux_session;
  const workerOptions = sessions.filter((session) => session.role === "worker");
  const managerOptions = sessions.filter((session) => session.role === "manager");
  const activity = buildActivity(snapshot, receipts);
  const managerConfig = snapshot?.latest_cycle?.status?.manager_context?.manager_config;
  const selectedWorker = worker || snapshot?.worker?.name || "";
  const selectedManager = manager || snapshot?.manager?.name || "";

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
        <TerminalPane title="Worker" session={workerSession} />
        <TerminalPane title="Manager" session={managerSession} />
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
          <section className="bootstrap-card">
            <h3>Manual session binding</h3>
            <div className="form-grid bootstrap-grid">
              <label>Task
                <input value={newTask} onChange={(event) => updateBootstrapTask(event.target.value)} placeholder={task || "task-name"} />
              </label>
              <label>Goal
                <textarea value={taskGoal} onChange={(event) => setTaskGoal(event.target.value)} placeholder="Task goal" />
              </label>
              <label>Worker
                <select value={selectedWorker} onChange={(event) => setWorker(event.target.value)}>
                  <option value="">Select worker</option>
                  {workerOptions.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </label>
              <label>Manager
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
            <h3>Activity replay</h3>
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
