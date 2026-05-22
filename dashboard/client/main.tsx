import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type DashboardTerminalId = "a" | "b";
type RawTelemetry = {
  actor?: string;
  attributes?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
  event_type?: string;
  severity?: string;
  summary?: string;
  timestamp?: string;
};
type TerminalState = {
  id: DashboardTerminalId;
  label: string;
  registered_session?: {
    alive?: boolean | null;
    name: string;
    role: "worker" | "manager";
    state?: string;
  } | null;
  role: "manager" | "shell" | "worker";
  tmux_session: string;
};
type TimelineItem = {
  detail?: string;
  key: string;
  raw?: RawTelemetry;
  severity?: string;
  time?: string;
  title: string;
};
type Observation = {
  binding?: {
    manager_name?: string;
    state?: string;
    task_name?: string;
    worker_name?: string;
  } | null;
  latest_cycle?: { state?: string } | null;
  polled_at: string;
  task?: { goal?: string; name?: string; state?: string } | null;
  terminals: TerminalState[];
  timeline: TimelineItem[];
};
type PollState = "idle" | "live" | "error";

function terminalResizeMessage(cols: number, rows: number) {
  return JSON.stringify({ marker: "dashboard-terminal-control", type: "resize", cols, rows });
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

function roleLabel(terminal: TerminalState) {
  const session = terminal.registered_session;
  if (!session) {
    return "shell";
  }
  const health = session.alive === false ? "dead" : session.state || "registered";
  return `${session.role}: ${session.name} (${health})`;
}

function TerminalPane({ terminal }: { terminal: TerminalState }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const xterm = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#07100f", foreground: "#d9e7df" },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(ref.current);
    fit.fit();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty?session=${encodeURIComponent(terminal.tmux_session)}`);
    socket.onmessage = (event) => xterm.write(event.data);
    xterm.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(terminalResizeMessage(xterm.cols, xterm.rows));
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
      xterm.dispose();
    };
  }, [terminal.tmux_session]);

  return (
    <section className="terminal-panel">
      <header>
        <div>
          <span>{terminal.label}</span>
          <strong>{terminal.tmux_session}</strong>
        </div>
        <em data-role={terminal.role}>{roleLabel(terminal)}</em>
      </header>
      <div ref={ref} className="terminal-host" />
    </section>
  );
}

function StatePanel({ observation }: { observation: Observation | null }) {
  const terminalA = observation?.terminals.find((item) => item.id === "a");
  const terminalB = observation?.terminals.find((item) => item.id === "b");
  const rows = [
    ["Terminal A", terminalA ? roleLabel(terminalA) : "starting"],
    ["Terminal B", terminalB ? roleLabel(terminalB) : "starting"],
    ["Relationship", observation?.binding ? observation.binding.state || "bound" : "none"],
    ["Task", observation?.task?.name || observation?.binding?.task_name || "none"],
    ["Latest cycle", observation?.latest_cycle?.state || "none"],
  ];
  return (
    <section>
      <h2>State</h2>
      <dl className="state-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <section className="timeline-section">
      <h2>Timeline</h2>
      <ol className="timeline-list">
        {items.map((item) => (
          <li key={item.key} data-severity={item.severity}>
            <time>{formatTime(item.time)}</time>
            <strong>{item.title}</strong>
            {item.detail ? <span>{item.detail}</span> : null}
            {item.raw ? (
              <details>
                <summary>Raw telemetry</summary>
                <pre>{JSON.stringify(item.raw, null, 2)}</pre>
              </details>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? <li><strong>Waiting for dashboard terminal activity</strong></li> : null}
      </ol>
    </section>
  );
}

function App() {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [pollState, setPollState] = useState<PollState>("idle");
  const [pollError, setPollError] = useState<string | null>(null);
  const pollInFlight = useRef(false);

  async function refresh() {
    if (pollInFlight.current) {
      return;
    }
    pollInFlight.current = true;
    setPollState("live");
    try {
      const response = await fetch("/api/observation");
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || response.statusText);
      }
      setObservation(await response.json());
      setPollError(null);
      setPollState("idle");
    } catch (error) {
      setPollError(error instanceof Error ? error.message : String(error));
      setPollState("error");
    } finally {
      pollInFlight.current = false;
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(interval);
  }, []);

  const terminals = observation?.terminals || [
    { id: "a" as const, label: "Terminal A", role: "shell" as const, tmux_session: "workerctl-dashboard-a" },
    { id: "b" as const, label: "Terminal B", role: "shell" as const, tmux_session: "workerctl-dashboard-b" },
  ];

  return (
    <main className="app-shell">
      <section className="workspace">
        <TerminalPane terminal={terminals[0]} />
        <TerminalPane terminal={terminals[1]} />
        <aside className="observation-rail">
          <header>
            <h1>Observation</h1>
            <p data-state={pollState}>{pollError || (observation ? `Updated ${formatTime(observation.polled_at)}` : "Starting dashboard shells")}</p>
          </header>
          <StatePanel observation={observation} />
          <Timeline items={observation?.timeline || []} />
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
