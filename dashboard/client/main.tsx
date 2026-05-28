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
type DispatchChain = {
  attempts: Array<{
    dispatcher_id?: string | null;
    error?: string | null;
    id?: number;
    side_effect_completed: boolean;
    side_effect_started: boolean;
    state?: string;
  }>;
  command_id?: string | null;
  command_state?: string;
  command_type?: string;
  correlation_id?: string | null;
  conversation?: Array<{ detail?: string; kind: string; label: string }>;
  error?: string | null;
  key: string;
  manager_cycle_id?: number | null;
  manager_decision_id?: number | null;
  notification_count: number;
  side_effect_risk: boolean;
  source_event_id?: number | null;
  summary: string;
  time?: string;
};
type DispatchHealth = {
  core_status: "active" | "not_observed" | "stale";
  failed_count: number;
  heartbeat?: {
    dispatcher_id?: string;
    dry_run?: boolean;
    iteration?: number;
    processed_count?: number;
    stale: boolean;
    stale_seconds?: number | null;
    state?: "active" | "not_observed" | "stale";
    timestamp?: string;
  } | null;
  queued_count: number;
  operator_message: string;
  side_effect_risk_count: number;
  stale_claim_count: number;
  suppressed_signal_count: number;
};
type CriteriaSummary = {
  accepted: number;
  deferred: number;
  open: number;
  proposed: number;
  rejected: number;
  satisfied: number;
  total: number;
};
type Observation = {
  audit?: {
    command_attempts: unknown[];
    commands: unknown[];
    correlation_chains: unknown[];
    routed_notifications: unknown[];
  } | null;
  binding?: {
    manager_name?: string;
    state?: string;
    task_name?: string;
    worker_name?: string;
  } | null;
  criteria?: CriteriaSummary;
  dispatch?: {
    chains: DispatchChain[];
    health: DispatchHealth;
  };
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

function formatAge(seconds?: number | null) {
  if (seconds === null || seconds === undefined) {
    return "unknown";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function roleLabel(terminal: TerminalState) {
  const session = terminal.registered_session;
  if (!session) {
    return "shell";
  }
  const health = session.alive === false ? "dead" : session.state || "registered";
  return `${session.role}: ${session.name} (${health})`;
}

function latestFinishChain(observation: Observation | null): DispatchChain | undefined {
  return observation?.dispatch?.chains.find((chain) => chain.command_type === "finish_task");
}

function finishLabel(chain: DispatchChain | undefined) {
  if (!chain) {
    return "none";
  }
  return [
    chain.command_state || "unknown",
    chain.command_id || chain.correlation_id || null,
  ].filter(Boolean).join(" / ");
}

function criteriaLabel(criteria: CriteriaSummary | undefined) {
  if (!criteria || criteria.total === 0) {
    return "none";
  }
  const extra = [
    criteria.proposed > 0 ? `${criteria.proposed} proposed` : null,
    criteria.deferred > 0 ? `${criteria.deferred} deferred` : null,
    criteria.rejected > 0 ? `${criteria.rejected} rejected` : null,
  ].filter(Boolean);
  return [
    `${criteria.satisfied} satisfied`,
    `${criteria.open} open`,
    ...extra,
  ].join(" / ");
}

function DispatchPanel({ observation }: { observation: Observation | null }) {
  const health = observation?.dispatch?.health;
  const chains = observation?.dispatch?.chains || [];
  const heartbeat = health?.heartbeat;
  const coreStatus = health?.core_status || heartbeat?.state || (heartbeat?.stale ? "stale" : "not_observed");
  const heartbeatState = coreStatus;
  const heartbeatLabel = heartbeatState === "active"
    ? "active"
    : heartbeatState === "stale"
      ? "stale"
      : "not observed";
  const chips = [
    ["Queued", String(health?.queued_count ?? 0), (health?.queued_count ?? 0) > 0 ? "warning" : "ok"],
    ["Failed", String(health?.failed_count ?? 0), (health?.failed_count ?? 0) > 0 ? "error" : "ok"],
    ["Stale", String(health?.stale_claim_count ?? 0), (health?.stale_claim_count ?? 0) > 0 ? "warning" : "ok"],
    ["Risk", String(health?.side_effect_risk_count ?? 0), (health?.side_effect_risk_count ?? 0) > 0 ? "error" : "ok"],
    ["Suppressed", String(health?.suppressed_signal_count ?? 0), (health?.suppressed_signal_count ?? 0) > 0 ? "warning" : "ok"],
  ];
  return (
    <section className="dispatch-section">
      <h2>Dispatch</h2>
      <div className="dispatch-core-banner" data-state={coreStatus}>
        <div>
          <span>Dispatch core</span>
          <strong>{coreStatus === "not_observed" ? "not observed" : coreStatus}</strong>
        </div>
        <p>{health?.operator_message || "Dispatch has not been observed; worker completions will not wake managers."}</p>
      </div>
      <div className="dispatch-health">
        {chips.map(([label, value, state]) => (
          <div key={label} data-state={state}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="dispatch-heartbeat" data-state={heartbeatState === "active" ? "ok" : "warning"}>
        <span>Heartbeat</span>
        <strong>{heartbeat?.timestamp ? `${formatTime(heartbeat.timestamp)} (${formatAge(heartbeat.stale_seconds)} ago)` : heartbeatLabel}</strong>
        {heartbeat ? (
          <em>
            {[
              heartbeatLabel,
              heartbeat.dispatcher_id,
              typeof heartbeat.iteration === "number" ? `iteration ${heartbeat.iteration}` : null,
              typeof heartbeat.processed_count === "number" ? `${heartbeat.processed_count} processed` : null,
              typeof heartbeat.dry_run === "boolean" ? (heartbeat.dry_run ? "dry run" : "live") : null,
            ].filter(Boolean).join(" / ")}
          </em>
        ) : null}
      </div>
      <ol className="dispatch-chain-list">
        {chains.map((chain) => (
          <li key={chain.key} data-risk={chain.side_effect_risk || undefined}>
            <div>
              <time>{formatTime(chain.time)}</time>
              <strong>{chain.command_type || "command"}</strong>
              <span>{chain.command_state || "unknown"}</span>
            </div>
            <p>{chain.error ? `${chain.summary || chain.command_id || chain.correlation_id}: ${chain.error}` : chain.summary || chain.command_id || chain.correlation_id}</p>
            <small>
              {[
                chain.manager_cycle_id ? `cycle #${chain.manager_cycle_id}` : null,
                chain.manager_decision_id ? `decision #${chain.manager_decision_id}` : null,
                chain.source_event_id ? `source event #${chain.source_event_id}` : null,
                chain.correlation_id ? `correlation ${chain.correlation_id}` : null,
                `${chain.attempts.length} attempt${chain.attempts.length === 1 ? "" : "s"}`,
                `${chain.notification_count} notification${chain.notification_count === 1 ? "" : "s"}`,
              ].filter(Boolean).join(" / ")}
            </small>
            {chain.conversation?.length ? (
              <ol className="dispatch-conversation">
                {chain.conversation.map((item, index) => (
                  <li key={`${chain.key}-${index}`} data-kind={item.kind}>
                    <span>{item.label}</span>
                    {item.detail ? <em>{item.detail}</em> : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
        {chains.length === 0 ? <li><strong>No dispatch chains for the bound task</strong></li> : null}
      </ol>
    </section>
  );
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
  const finish = latestFinishChain(observation);
  const rows = [
    ["Terminal A", terminalA ? roleLabel(terminalA) : "starting"],
    ["Terminal B", terminalB ? roleLabel(terminalB) : "starting"],
    ["Relationship", observation?.binding ? observation.binding.state || "bound" : "none"],
    ["Task", observation?.task?.name || observation?.binding?.task_name || "none"],
    ["Task state", observation?.task?.state || "unknown"],
    ["Criteria", criteriaLabel(observation?.criteria)],
    ["Latest cycle", observation?.latest_cycle?.state || "none"],
    ["Finish task", finishLabel(finish)],
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
          <DispatchPanel observation={observation} />
          <Timeline items={observation?.timeline || []} />
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
