import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type Snapshot = {
  alerts?: Array<{ message: string; severity: string; type: string }>;
  binding?: { manager_session_name: string; worker_session_name: string } | null;
  commands?: { failed_count: number; unfinished_count: number };
  criteria?: { open_blocker_count: number; summary: Record<string, number> };
  latest_cycle?: { state: string; worker_state?: string; notable_pane_pattern?: string | null } | null;
  manager?: { alive: boolean | null; name: string; tmux_session?: string | null } | null;
  task?: { name: string; state: string; goal: string };
  telemetry?: { summary: { total: number; by_severity: Record<string, number> } };
  worker?: { alive: boolean | null; name: string; tmux_session?: string | null } | null;
};

type SessionRow = { name: string; role: "worker" | "manager"; state?: string; tmux_session?: string | null };
type TaskRow = { name: string; state?: string; goal?: string };
type Receipt = { command: string[]; exitCode: number | null; stdout: string; stderr: string; json?: unknown };

function safeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    const resize = () => fit.fit();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
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
        {!session ? <div className="empty-terminal">Attach a tmux-backed session to enable the terminal.</div> : null}
      </div>
    </section>
  );
}

function App() {
  const initialTask = useMemo(() => new URLSearchParams(location.search).get("task") || "", []);
  const [task, setTask] = useState(initialTask);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [worker, setWorker] = useState("");
  const [manager, setManager] = useState("");
  const [newTask, setNewTask] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [managerName, setManagerName] = useState("");
  const [cwd, setCwd] = useState("");
  const [managerMode, setManagerMode] = useState<"light" | "guided" | "strict">("guided");
  const [nudge, setNudge] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    }
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

  async function startWorker() {
    const selectedWorker = workerName || `${safeName(task || newTask)}-worker`;
    const receipt = await action("start-worker", {
      cwd,
      taskPrompt: taskPrompt || taskGoal || task,
      timeoutSeconds: 60,
      workerName: selectedWorker,
    }, false);
    if (receipt?.exitCode === 0) {
      setWorker(selectedWorker);
      await loadSetup();
    }
  }

  async function startManager() {
    const selectedManager = managerName || `${safeName(task || newTask)}-manager`;
    const receipt = await action("start-manager", {
      cwd,
      managerName: selectedManager,
      timeoutSeconds: 60,
    }, false);
    if (receipt?.exitCode === 0) {
      setManager(selectedManager);
      await loadSetup();
    }
  }

  async function startPair() {
    const selectedTask = safeName(newTask || task);
    const selectedWorker = workerName || `${selectedTask}-worker`;
    const selectedManager = managerName || `${selectedTask}-manager`;
    const receipt = await action("start-pair", {
      cwd,
      managerAcceptance: ["Worker and manager terminals attach in the dashboard."],
      managerMode,
      managerName: selectedManager,
      managerObjective: taskGoal || `Supervise ${selectedTask}.`,
      task: selectedTask,
      taskGoal: taskGoal || taskPrompt || selectedTask,
      taskPrompt: taskPrompt || taskGoal || selectedTask,
      timeoutSeconds: 60,
      workerName: selectedWorker,
    }, false);
    if (receipt?.exitCode === 0) {
      const payload = jsonRecord(receipt.json);
      const taskPayload = jsonRecord(payload.task);
      const workerPayload = jsonRecord(payload.worker);
      const managerPayload = jsonRecord(payload.manager);
      const returnedTask = String(taskPayload.name || selectedTask);
      const returnedWorker = String(workerPayload.name || selectedWorker);
      const returnedManager = String(managerPayload.name || selectedManager);
      setTask(returnedTask);
      setWorker(returnedWorker);
      setManager(returnedManager);
      await loadSetup();
      await refresh(returnedTask);
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
        <aside className="rail">
          <h2>{snapshot?.task?.name || "No task loaded"}</h2>
          <p className="goal">{snapshot?.task?.goal || error || "Load a task to inspect dashboard telemetry."}</p>
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
            <h3>Bootstrap</h3>
            <div className="form-grid bootstrap-grid">
              <label>Task
                <input value={newTask} onChange={(event) => {
                  const value = safeName(event.target.value);
                  setNewTask(value);
                  if (!workerName) {
                    setWorkerName(value ? `${value}-worker` : "");
                  }
                  if (!managerName) {
                    setManagerName(value ? `${value}-manager` : "");
                  }
                }} placeholder={task || "task-name"} />
              </label>
              <label>Goal
                <textarea value={taskGoal} onChange={(event) => setTaskGoal(event.target.value)} placeholder="Task goal" />
              </label>
              <label>Worker prompt
                <textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder="Initial worker prompt" />
              </label>
              <label>Worker
                <input value={workerName} onChange={(event) => setWorkerName(safeName(event.target.value))} placeholder={`${safeName(newTask || task) || "task"}-worker`} />
              </label>
              <label>Manager
                <input value={managerName} onChange={(event) => setManagerName(safeName(event.target.value))} placeholder={`${safeName(newTask || task) || "task"}-manager`} />
              </label>
              <label>CWD
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="dashboard server cwd" />
              </label>
              <label>Manager mode
                <select value={managerMode} onChange={(event) => setManagerMode(event.target.value as "light" | "guided" | "strict")}>
                  <option value="guided">guided</option>
                  <option value="light">light</option>
                  <option value="strict">strict</option>
                </select>
              </label>
              <div className="button-grid">
                <button disabled={busy} onClick={() => createTask().catch((err: Error) => setError(err.message))}>Create Task</button>
                <button disabled={busy} onClick={() => startWorker().catch((err: Error) => setError(err.message))}>Start Worker</button>
                <button disabled={busy} onClick={() => startManager().catch((err: Error) => setError(err.message))}>Start Manager</button>
                <button disabled={busy} className="primary-action" onClick={() => startPair().catch((err: Error) => setError(err.message))}>Start Pair</button>
              </div>
            </div>
          </section>
          <section>
            <h3>Attach & Bind</h3>
            <div className="form-grid">
              <label>Worker
                <select value={worker || snapshot?.worker?.name || ""} onChange={(event) => setWorker(event.target.value)}>
                  <option value="">Select worker</option>
                  {workerOptions.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </label>
              <label>Manager
                <select value={manager || snapshot?.manager?.name || ""} onChange={(event) => setManager(event.target.value)}>
                  <option value="">Select manager</option>
                  {managerOptions.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </label>
              <button onClick={() => action("bind", { task, worker: worker || snapshot?.worker?.name, manager: manager || snapshot?.manager?.name })}>Bind</button>
            </div>
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
            <h3>Receipts</h3>
            <ul className="receipts">
              {receipts.map((receipt, index) => (
                <li key={`${receipt.command.join(" ")}-${index}`}>
                  <strong>{receipt.exitCode === 0 ? "ok" : "failed"}</strong>
                  <span>{receipt.command.slice(1).join(" ")}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
