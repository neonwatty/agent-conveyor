# Handoff Ledger Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the selected Ledger First dashboard view for one active manager, Dispatch, and worker pair.

**Architecture:** Derive one `flow` object on the dashboard server from existing observation data, then render it in React as a health strip, current handoff card, actionable blockers, and correlation ledger. Keep existing Dispatch and Timeline details as drill-down surfaces; do not add persistence or new CLI commands.

**Tech Stack:** TypeScript, React, Vite dashboard, Node `node:test`, existing `conveyor` JSON command wrappers.

---

## File Structure

- Modify `dashboard/server/index.ts`
  - Add `FlowObservation` types.
  - Add exported `buildFlowObservation(...)`.
  - Include `flow` in `/api/observation`.
- Modify `dashboard/server/workerctl.test.ts`
  - Add focused tests for healthy handoff, no binding, stale Dispatch, pending inbox, failed commands, open criteria, and side-effect risk.
- Modify `dashboard/client/main.tsx`
  - Add `FlowObservation` client type.
  - Add `HandoffLedgerPanel` and small rendering helpers.
  - Render Ledger First before the existing detailed Dispatch and Timeline sections.
- Modify `dashboard/client/styles.css`
  - Add Ledger First layout and responsive styling.
- Verify with `npm test -- --runInBand`, `npm run build`, and a browser screenshot of the dashboard.

## Task 1: Server Flow Derivation Tests

**Files:**
- Modify: `dashboard/server/workerctl.test.ts`

- [ ] **Step 1: Import the server helper**

In `dashboard/server/workerctl.test.ts`, update the import from `./index.ts`:

```ts
import {
  acceptanceCriteriaSummary,
  bindingFromAudit,
  buildFlowObservation,
  cleanupDashboardShells,
  dashboardTaskName,
  dispatchChainEntries,
  dispatchHealth,
  dispatchHeartbeatTelemetryOptions,
  dispatchInboxSummary,
  findDashboardBinding,
  isDashboardSession,
} from "./index.ts";
```

- [ ] **Step 2: Add a healthy handoff test**

Append this test near the existing dashboard display helper tests:

```ts
test("builds healthy handoff flow from consumed worker completion", () => {
  const criteria = acceptanceCriteriaSummary({
    acceptance_criteria: [
      { status: "satisfied" },
      { status: "accepted" },
    ],
  });
  const chains = dispatchChainEntries({
    command_attempts: [],
    commands: [],
    correlation_chains: [
      {
        command_id: null,
        command_state: "delivered",
        command_type: "worker_task_complete",
        correlation_id: "corr-complete",
        created_at: "2026-06-09T12:40:00Z",
        manager_cycle_id: 18,
        manager_decision_id: null,
        routed_notification_ids: [28],
        signal_type: "worker_task_complete",
        source_event_id: 219,
      },
    ],
    routed_notifications: [
      {
        consumed_at: "2026-06-09T12:41:00Z",
        consumed_by_session_name: "manager-a",
        correlation_id: "corr-complete",
        created_at: "2026-06-09T12:40:00Z",
        delivered_at: "2026-06-09T12:40:02Z",
        id: 28,
        signal_type: "worker_task_complete",
        source_event_id: 219,
        state: "delivered",
        target_session_name: "manager-a",
      },
    ],
  });
  const flow = buildFlowObservation({
    binding: {
      manager_name: "manager-a",
      state: "active",
      task_name: "task-a",
      worker_name: "worker-a",
    },
    criteria,
    dispatch: {
      chains,
      health: {
        core_status: "active",
        failed_count: 0,
        heartbeat: { dispatcher_id: "dispatch-a", stale: false, stale_seconds: 8, state: "active" },
        operator_message: "Dispatch is routing worker/manager events.",
        queued_count: 0,
        side_effect_risk_count: 0,
        stale_claim_count: 0,
        suppressed_signal_count: 0,
      },
      inbox: {
        consumed_count: 1,
        pending_count: 0,
        pull_required_pending_count: 0,
        sessions: [],
      },
    },
    latestCycle: { state: "succeeded" },
    task: { name: "task-a", state: "managed" },
    terminals: [
      {
        id: "a",
        label: "Terminal A",
        registered_session: { alive: true, name: "worker-a", role: "worker", state: "active" },
        role: "worker",
        tmux_session: "workerctl-dashboard-a",
      },
      {
        id: "b",
        label: "Terminal B",
        registered_session: { alive: true, name: "manager-a", role: "manager", state: "active" },
        role: "manager",
        tmux_session: "workerctl-dashboard-b",
      },
    ],
  });

  assert.equal(flow.current.summary, "Worker completed task -> Dispatch routed completion -> Manager consumed it");
  assert.equal(flow.current.waiting_on, "manager");
  assert.equal(flow.current.problem, "open_criteria");
  assert.equal(flow.current.correlation_id, "corr-complete");
  assert.equal(flow.counts.open_criteria, 1);
  assert.equal(flow.blockers[0].key, "open-criteria");
  assert.equal(flow.ledger.length, 1);
  assert.equal(flow.ledger[0].actor, "worker");
  assert.equal(flow.ledger[0].status, "ok");
});
```

- [ ] **Step 3: Add failure and uncertainty tests**

Append these tests after the healthy handoff test:

```ts
test("builds flow blocker when no active binding is known", () => {
  const flow = buildFlowObservation({
    binding: null,
    criteria: acceptanceCriteriaSummary(null),
    dispatch: {
      chains: [],
      health: {
        core_status: "not_observed",
        failed_count: 0,
        heartbeat: { stale: true, stale_seconds: null, state: "not_observed" },
        operator_message: "Dispatch has not been observed; worker completions will not wake managers.",
        queued_count: 0,
        side_effect_risk_count: 0,
        stale_claim_count: 0,
        suppressed_signal_count: 0,
      },
      inbox: {
        consumed_count: 0,
        pending_count: 0,
        pull_required_pending_count: 0,
        sessions: [],
      },
    },
    latestCycle: null,
    task: null,
    terminals: [],
  });

  assert.equal(flow.current.summary, "No active manager/worker binding");
  assert.equal(flow.current.waiting_on, "operator");
  assert.equal(flow.current.problem, "blocked");
  assert.equal(flow.blockers.some((blocker) => blocker.key === "no-binding"), true);
});

test("builds flow blockers for stale dispatch, pending inbox, failed command, and side-effect risk", () => {
  const flow = buildFlowObservation({
    binding: { manager_name: "manager-a", state: "active", task_name: "task-a", worker_name: "worker-a" },
    criteria: acceptanceCriteriaSummary(null),
    dispatch: {
      chains: [],
      health: {
        core_status: "stale",
        failed_count: 1,
        heartbeat: { dispatcher_id: "dispatch-a", stale: true, stale_seconds: 91, state: "stale" },
        operator_message: "Dispatch heartbeat is stale; worker completions may not wake managers.",
        queued_count: 1,
        side_effect_risk_count: 1,
        stale_claim_count: 1,
        suppressed_signal_count: 0,
      },
      inbox: {
        consumed_count: 0,
        pending_count: 2,
        pull_required_pending_count: 1,
        sessions: [],
      },
    },
    latestCycle: null,
    task: { name: "task-a", state: "managed" },
    terminals: [
      {
        id: "a",
        label: "Terminal A",
        registered_session: { alive: false, name: "worker-a", role: "worker", state: "active" },
        role: "worker",
        tmux_session: "workerctl-dashboard-a",
      },
    ],
  });

  assert.equal(flow.dispatch.status, "stale");
  assert.equal(flow.current.problem, "stale");
  assert.equal(flow.current.waiting_on, "dispatch");
  assert.equal(flow.blockers.some((blocker) => blocker.key === "dispatch-stale"), true);
  assert.equal(flow.blockers.some((blocker) => blocker.key === "pending-inbox"), true);
  assert.equal(flow.blockers.some((blocker) => blocker.key === "failed-commands"), true);
  assert.equal(flow.blockers.some((blocker) => blocker.key === "side-effect-risk"), true);
  assert.equal(flow.blockers.some((blocker) => blocker.key === "worker-dead"), true);
});
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
npm test -- --runInBand
```

Expected: FAIL because `buildFlowObservation` is not exported from `dashboard/server/index.ts`.

## Task 2: Server Flow Derivation Implementation

**Files:**
- Modify: `dashboard/server/index.ts`
- Test: `dashboard/server/workerctl.test.ts`

- [ ] **Step 1: Add flow types**

In `dashboard/server/index.ts`, after `type DispatchHealth = ...` or after `acceptanceCriteriaSummary`, add:

```ts
type FlowActor = "manager" | "dispatch" | "worker" | "operator" | "workerctl";
type FlowStatus = "ok" | "waiting" | "blocked" | "failed" | "stale";
type FlowWaitingOn = "worker" | "manager" | "dispatch" | "operator" | null;
type FlowProblem = "blocked" | "failed" | "stale" | "side_effect_risk" | "pending_inbox" | "open_criteria" | null;

type FlowLedgerEntry = {
  actor: FlowActor;
  correlation_id?: string | null;
  detail?: Record<string, unknown>;
  key: string;
  kind: string;
  status: FlowStatus;
  summary: string;
  time?: string;
};

type FlowBlocker = {
  detail?: string;
  key: string;
  severity: "warning" | "error";
  summary: string;
};

type FlowTerminal = ReturnType<typeof terminalState>;
type FlowDispatch = {
  chains: ReturnType<typeof dispatchChainEntries>;
  health: ReturnType<typeof dispatchHealth>;
  inbox: ReturnType<typeof dispatchInboxSummary>;
};

export type FlowObservation = {
  blockers: FlowBlocker[];
  counts: {
    failed_commands: number;
    open_criteria: number;
    pending_inbox: number;
    queued_commands: number;
  };
  current: {
    command_state?: string;
    command_type?: string;
    correlation_id?: string | null;
    problem?: FlowProblem;
    summary: string;
    updated_at?: string;
    waiting_on?: FlowWaitingOn;
  };
  dispatch: {
    dispatcher_id?: string;
    heartbeat_age_seconds?: number | null;
    status: "active" | "stale" | "not_observed";
  };
  ledger: FlowLedgerEntry[];
  manager: {
    alive?: boolean | null;
    name?: string;
    state?: string;
  };
  task: string | null;
  worker: {
    alive?: boolean | null;
    name?: string;
    state?: string;
  };
};
```

- [ ] **Step 2: Add actor and status helpers**

In `dashboard/server/index.ts`, below the flow types, add:

```ts
function flowSession(terminals: FlowTerminal[], role: "manager" | "worker") {
  return terminals.find((terminal) => terminal.registered_session?.role === role)?.registered_session || null;
}

function flowChainActor(chain: ReturnType<typeof dispatchChainEntries>[number]): FlowActor {
  if (chain.command_type === "worker_task_complete") {
    return "worker";
  }
  if (chain.manager_decision_id || chain.manager_cycle_id) {
    return "manager";
  }
  return "dispatch";
}

function flowChainStatus(chain: ReturnType<typeof dispatchChainEntries>[number]): FlowStatus {
  if (chain.side_effect_risk) {
    return "failed";
  }
  if (chain.command_state === "failed" || chain.attempts.some((attempt) => attempt.state === "failed")) {
    return "failed";
  }
  if (chain.command_state === "blocked" || chain.attempts.some((attempt) => attempt.state === "blocked")) {
    return "blocked";
  }
  if (chain.notifications?.some((notification) => !notification.consumed_at && notification.state === "delivered")) {
    return "waiting";
  }
  return "ok";
}

function flowLedgerEntries(chains: ReturnType<typeof dispatchChainEntries>): FlowLedgerEntry[] {
  return chains.slice(0, 8).map((chain) => ({
    actor: flowChainActor(chain),
    correlation_id: chain.correlation_id,
    detail: {
      command_id: chain.command_id,
      manager_cycle_id: chain.manager_cycle_id,
      manager_decision_id: chain.manager_decision_id,
      notification_count: chain.notification_count,
      source_event_id: chain.source_event_id,
    },
    key: chain.key,
    kind: chain.command_type || "handoff",
    status: flowChainStatus(chain),
    summary: chain.summary || chain.command_id || chain.correlation_id || "Dispatch handoff",
    time: chain.time,
  }));
}
```

- [ ] **Step 3: Add blocker and current-handoff helpers**

In `dashboard/server/index.ts`, below `flowLedgerEntries`, add:

```ts
function flowBlockers({
  binding,
  criteria,
  dispatch,
  manager,
  worker,
}: {
  binding: Record<string, unknown> | null;
  criteria: CriteriaSummary;
  dispatch: FlowDispatch;
  manager: FlowObservation["manager"];
  worker: FlowObservation["worker"];
}): FlowBlocker[] {
  const blockers: FlowBlocker[] = [];
  if (!binding) {
    blockers.push({
      key: "no-binding",
      severity: "error",
      summary: "No active manager/worker binding.",
    });
  }
  if (manager.alive === false) {
    blockers.push({
      key: "manager-dead",
      severity: "error",
      summary: "Manager session is not alive.",
    });
  }
  if (worker.alive === false) {
    blockers.push({
      key: "worker-dead",
      severity: "error",
      summary: "Worker session is not alive.",
    });
  }
  if (dispatch.health.core_status !== "active") {
    blockers.push({
      detail: dispatch.health.operator_message,
      key: dispatch.health.core_status === "stale" ? "dispatch-stale" : "dispatch-not-observed",
      severity: dispatch.health.core_status === "stale" ? "warning" : "error",
      summary: dispatch.health.core_status === "stale"
        ? "Dispatch heartbeat is stale."
        : "Dispatch has not been observed.",
    });
  }
  if (dispatch.health.failed_count > 0) {
    blockers.push({
      key: "failed-commands",
      severity: "error",
      summary: `${dispatch.health.failed_count} command${dispatch.health.failed_count === 1 ? "" : "s"} failed.`,
    });
  }
  if (dispatch.health.side_effect_risk_count > 0) {
    blockers.push({
      key: "side-effect-risk",
      severity: "error",
      summary: "A command side effect started but did not complete.",
    });
  }
  if (dispatch.inbox.pending_count > 0) {
    blockers.push({
      key: "pending-inbox",
      severity: "warning",
      summary: `${dispatch.inbox.pending_count} delivered inbox item${dispatch.inbox.pending_count === 1 ? "" : "s"} remain unconsumed.`,
    });
  }
  if (criteria.open > 0) {
    blockers.push({
      key: "open-criteria",
      severity: "warning",
      summary: `${criteria.open} accepted/proposed criterion${criteria.open === 1 ? "" : "s"} still open.`,
    });
  }
  return blockers;
}

function currentFlowProblem(dispatch: FlowDispatch, criteria: CriteriaSummary, blockers: FlowBlocker[]): FlowProblem {
  if (blockers.some((blocker) => blocker.key === "no-binding")) {
    return "blocked";
  }
  if (dispatch.health.core_status !== "active") {
    return "stale";
  }
  if (dispatch.health.failed_count > 0) {
    return "failed";
  }
  if (dispatch.health.side_effect_risk_count > 0) {
    return "side_effect_risk";
  }
  if (dispatch.inbox.pending_count > 0) {
    return "pending_inbox";
  }
  if (criteria.open > 0) {
    return "open_criteria";
  }
  return null;
}

function currentFlowWaitingOn(problem: FlowProblem, latestChain: ReturnType<typeof dispatchChainEntries>[number] | undefined): FlowWaitingOn {
  if (problem === "blocked") {
    return "operator";
  }
  if (problem === "stale" || problem === "failed" || problem === "side_effect_risk") {
    return "dispatch";
  }
  if (problem === "pending_inbox") {
    return latestChain?.command_type === "nudge_worker" ? "worker" : "manager";
  }
  if (problem === "open_criteria") {
    return "manager";
  }
  if (latestChain?.command_type === "nudge_worker") {
    return "worker";
  }
  if (latestChain?.command_type === "worker_task_complete") {
    return "manager";
  }
  return null;
}

function currentFlowSummary({
  binding,
  latestChain,
  problem,
}: {
  binding: Record<string, unknown> | null;
  latestChain: ReturnType<typeof dispatchChainEntries>[number] | undefined;
  problem: FlowProblem;
}): string {
  if (!binding) {
    return "No active manager/worker binding";
  }
  if (!latestChain) {
    return "Waiting for first handoff";
  }
  if (latestChain.command_type === "worker_task_complete" && latestChain.manager_cycle_id) {
    return "Worker completed task -> Dispatch routed completion -> Manager consumed it";
  }
  if (latestChain.command_type === "worker_task_complete") {
    return "Worker completed task -> Dispatch routed completion -> waiting for manager";
  }
  if (latestChain.command_type === "nudge_worker") {
    return "Manager decided -> Dispatch routed nudge -> waiting for worker";
  }
  if (problem === "failed") {
    return `${latestChain.command_type || "Command"} failed during Dispatch`;
  }
  return latestChain.summary || "Waiting for next handoff";
}
```

- [ ] **Step 4: Add and export `buildFlowObservation`**

In `dashboard/server/index.ts`, below the helpers from Step 3, add:

```ts
export function buildFlowObservation({
  binding,
  criteria,
  dispatch,
  latestCycle,
  task,
  terminals,
}: {
  binding: Record<string, unknown> | null;
  criteria: CriteriaSummary;
  dispatch: FlowDispatch;
  latestCycle: SnapshotResult["latest_cycle"] | null;
  task: SnapshotResult["task"] | { name?: string; state?: string } | null;
  terminals: FlowTerminal[];
}): FlowObservation {
  const managerSession = flowSession(terminals, "manager");
  const workerSession = flowSession(terminals, "worker");
  const manager = {
    alive: managerSession?.alive,
    name: managerSession?.name || (binding?.manager_name ? String(binding.manager_name) : undefined),
    state: managerSession?.state,
  };
  const worker = {
    alive: workerSession?.alive,
    name: workerSession?.name || (binding?.worker_name ? String(binding.worker_name) : undefined),
    state: workerSession?.state,
  };
  const blockers = flowBlockers({ binding, criteria, dispatch, manager, worker });
  const latestChain = dispatch.chains[0];
  const problem = currentFlowProblem(dispatch, criteria, blockers);
  const waitingOn = currentFlowWaitingOn(problem, latestChain);
  const taskName = task?.name || (binding?.task_name ? String(binding.task_name) : null);

  return {
    blockers,
    counts: {
      failed_commands: dispatch.health.failed_count,
      open_criteria: criteria.open,
      pending_inbox: dispatch.inbox.pending_count,
      queued_commands: dispatch.health.queued_count,
    },
    current: {
      command_state: latestChain?.command_state,
      command_type: latestChain?.command_type,
      correlation_id: latestChain?.correlation_id,
      problem,
      summary: currentFlowSummary({ binding, latestChain, problem }),
      updated_at: latestChain?.time || (latestCycle && "completed_at" in latestCycle ? latestCycle.completed_at || undefined : undefined),
      waiting_on: waitingOn,
    },
    dispatch: {
      dispatcher_id: typeof dispatch.health.heartbeat?.dispatcher_id === "string" ? dispatch.health.heartbeat.dispatcher_id : undefined,
      heartbeat_age_seconds: typeof dispatch.health.heartbeat?.stale_seconds === "number" ? dispatch.health.heartbeat.stale_seconds : null,
      status: dispatch.health.core_status,
    },
    ledger: flowLedgerEntries(dispatch.chains),
    manager,
    task: taskName,
    worker,
  };
}
```

- [ ] **Step 5: Include `flow` in dashboard observation**

In `dashboard/server/index.ts`, replace the final `return { ... }` assembly in `dashboardObservation` with named locals:

```ts
  const observedBinding = binding || bindingFromAudit(audit, taskName);
  const criteria = acceptanceCriteriaSummary(audit);
  const dispatch = {
    chains: dispatchChainEntries(audit),
    health: dispatchHealth(snapshot, audit, suppressedTelemetry, heartbeatTelemetry),
    inbox: dispatchInboxSummary(audit),
  };
  const task = snapshot?.task || (taskName ? { name: taskName } : null);
  const latestCycle = snapshot?.latest_cycle || null;
  return {
    audit: audit ? {
      command_attempts: audit.command_attempts || [],
      commands: audit.commands || [],
      correlation_chains: audit.correlation_chains || [],
      routed_notifications: audit.routed_notifications || [],
    } : null,
    binding: observedBinding,
    criteria,
    dispatch,
    flow: buildFlowObservation({
      binding: observedBinding,
      criteria,
      dispatch,
      latestCycle,
      task,
      terminals,
    }),
    latest_cycle: latestCycle,
    polled_at: new Date().toISOString(),
    task,
    terminals,
    timeline: interpretedTimeline({ binding: observedBinding, snapshot, terminals }),
  };
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit server flow derivation**

Run:

```bash
git add dashboard/server/index.ts dashboard/server/workerctl.test.ts
git commit -m "Add dashboard handoff flow derivation"
```

## Task 3: Client Types And Ledger Components

**Files:**
- Modify: `dashboard/client/main.tsx`

- [ ] **Step 1: Add client flow types**

In `dashboard/client/main.tsx`, after `type DispatchHealth = ...`, add:

```ts
type FlowStatus = "ok" | "waiting" | "blocked" | "failed" | "stale";
type FlowObservation = {
  blockers: Array<{
    detail?: string;
    key: string;
    severity: "warning" | "error";
    summary: string;
  }>;
  counts: {
    failed_commands: number;
    open_criteria: number;
    pending_inbox: number;
    queued_commands: number;
  };
  current: {
    command_state?: string;
    command_type?: string;
    correlation_id?: string | null;
    problem?: string | null;
    summary: string;
    updated_at?: string;
    waiting_on?: string | null;
  };
  dispatch: {
    dispatcher_id?: string;
    heartbeat_age_seconds?: number | null;
    status: "active" | "stale" | "not_observed";
  };
  ledger: Array<{
    actor: "manager" | "dispatch" | "worker" | "operator" | "workerctl";
    correlation_id?: string | null;
    detail?: Record<string, unknown>;
    key: string;
    kind: string;
    status: FlowStatus;
    summary: string;
    time?: string;
  }>;
  manager: {
    alive?: boolean | null;
    name?: string;
    state?: string;
  };
  task: string | null;
  worker: {
    alive?: boolean | null;
    name?: string;
    state?: string;
  };
};
```

Then add `flow?: FlowObservation;` to the `Observation` type.

- [ ] **Step 2: Add rendering helpers**

In `dashboard/client/main.tsx`, after `criteriaLabel`, add:

```tsx
function statusTone(status: FlowStatus | "active" | "not_observed" | "stale" | undefined) {
  if (status === "ok" || status === "active") {
    return "ok";
  }
  if (status === "failed" || status === "blocked" || status === "not_observed") {
    return "error";
  }
  return "warning";
}

function actorLabel(actor: string) {
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function waitingLabel(value?: string | null) {
  return value ? actorLabel(value) : "none";
}
```

- [ ] **Step 3: Add `FlowHealthStrip`**

In `dashboard/client/main.tsx`, before `DispatchPanel`, add:

```tsx
function FlowHealthStrip({ flow }: { flow: FlowObservation }) {
  const items = [
    ["Task", flow.task || "none", flow.task ? "ok" : "warning"],
    ["Manager", flow.manager.alive === false ? "dead" : flow.manager.name || "unknown", flow.manager.alive === false ? "error" : "ok"],
    ["Worker", flow.worker.alive === false ? "dead" : flow.worker.name || "unknown", flow.worker.alive === false ? "error" : "ok"],
    ["Dispatch", flow.dispatch.status === "not_observed" ? "not observed" : flow.dispatch.status, statusTone(flow.dispatch.status)],
    ["Criteria", `${flow.counts.open_criteria} open`, flow.counts.open_criteria > 0 ? "warning" : "ok"],
    ["Inbox", `${flow.counts.pending_inbox} pending`, flow.counts.pending_inbox > 0 ? "warning" : "ok"],
    ["Commands", `${flow.counts.failed_commands} failed`, flow.counts.failed_commands > 0 ? "error" : "ok"],
    ["Queued", String(flow.counts.queued_commands), flow.counts.queued_commands > 0 ? "warning" : "ok"],
  ];
  return (
    <div className="flow-health-strip">
      {items.map(([label, value, tone]) => (
        <div key={label} data-state={tone}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add `CurrentHandoffCard`**

In `dashboard/client/main.tsx`, after `FlowHealthStrip`, add:

```tsx
function CurrentHandoffCard({ flow }: { flow: FlowObservation }) {
  return (
    <section className="current-handoff-card">
      <h2>Current Handoff</h2>
      <p className="handoff-summary">{flow.current.summary}</p>
      <div className="handoff-meta-grid">
        <div>
          <span>Waiting on</span>
          <strong>{waitingLabel(flow.current.waiting_on)}</strong>
        </div>
        <div>
          <span>Reason</span>
          <strong>{flow.current.problem ? flow.current.problem.replaceAll("_", " ") : "none"}</strong>
        </div>
        <div>
          <span>Correlation</span>
          <strong>{flow.current.correlation_id || "none"}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{formatTime(flow.current.updated_at) || "unknown"}</strong>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Add blockers and ledger components**

In `dashboard/client/main.tsx`, after `CurrentHandoffCard`, add:

```tsx
function ActionableBlockers({ flow }: { flow: FlowObservation }) {
  return (
    <section className="flow-blockers">
      <h2>Needs Attention</h2>
      {flow.blockers.length ? (
        <ul>
          {flow.blockers.map((blocker) => (
            <li key={blocker.key} data-severity={blocker.severity}>
              <span aria-hidden="true" />
              <div>
                <strong>{blocker.summary}</strong>
                {blocker.detail ? <em>{blocker.detail}</em> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No blockers detected.</p>
      )}
    </section>
  );
}

function CorrelationLedger({ flow }: { flow: FlowObservation }) {
  return (
    <section className="correlation-ledger">
      <h2>Correlation Ledger</h2>
      <ol>
        {flow.ledger.map((entry) => (
          <li key={entry.key} data-state={statusTone(entry.status)}>
            <time>{formatTime(entry.time) || "now"}</time>
            <span>{actorLabel(entry.actor)}</span>
            <strong>{entry.summary}</strong>
            <em>{entry.status}</em>
            {entry.detail ? (
              <details>
                <summary>Details</summary>
                <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
              </details>
            ) : null}
          </li>
        ))}
        {flow.ledger.length === 0 ? <li><strong>Waiting for first handoff</strong></li> : null}
      </ol>
    </section>
  );
}
```

- [ ] **Step 6: Add `HandoffLedgerPanel`**

In `dashboard/client/main.tsx`, after `CorrelationLedger`, add:

```tsx
function HandoffLedgerPanel({ observation }: { observation: Observation | null }) {
  const flow = observation?.flow;
  if (!flow) {
    return (
      <section className="handoff-ledger-panel">
        <h2>Handoff Ledger</h2>
        <p>Waiting for observation flow.</p>
      </section>
    );
  }
  return (
    <section className="handoff-ledger-panel">
      <FlowHealthStrip flow={flow} />
      <CurrentHandoffCard flow={flow} />
      <ActionableBlockers flow={flow} />
      <CorrelationLedger flow={flow} />
    </section>
  );
}
```

- [ ] **Step 7: Render Handoff Ledger before detailed sections**

In `App`, replace:

```tsx
          <StatePanel observation={observation} />
          <DispatchPanel observation={observation} />
          <Timeline items={observation?.timeline || []} />
```

with:

```tsx
          <HandoffLedgerPanel observation={observation} />
          <details className="observation-details">
            <summary>State and Dispatch details</summary>
            <StatePanel observation={observation} />
            <DispatchPanel observation={observation} />
          </details>
          <Timeline items={observation?.timeline || []} />
```

- [ ] **Step 8: Run dashboard tests**

Run:

```bash
npm test -- --runInBand
```

Expected: PASS.

## Task 4: Ledger First Styling

**Files:**
- Modify: `dashboard/client/styles.css`

- [ ] **Step 1: Choose the CSS insertion point**

In `dashboard/client/styles.css`, find the end of the `.state-list dd` rule:

```css
.state-list dd {
  color: #26332f;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.3;
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}
```

Insert the Ledger First styles immediately after that rule, before `.dispatch-section`.

- [ ] **Step 2: Add Ledger First styles**

Append before `.dispatch-section`:

```css
.handoff-ledger-panel {
  display: grid;
  gap: 10px;
  min-height: 0;
}

.flow-health-strip {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.flow-health-strip div,
.current-handoff-card,
.flow-blockers,
.correlation-ledger {
  background: #f2f6f3;
  border: 1px solid #d7dfda;
  border-radius: 6px;
}

.flow-health-strip div {
  border-top: 3px solid #668577;
  min-width: 0;
  padding: 7px 8px;
}

.flow-health-strip div[data-state="warning"] {
  border-color: #d8ba83;
}

.flow-health-strip div[data-state="error"] {
  border-color: #d9a09c;
}

.flow-health-strip span,
.current-handoff-card span,
.handoff-meta-grid span {
  color: #68756f;
  display: block;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
}

.flow-health-strip strong,
.handoff-meta-grid strong {
  color: #26332f;
  display: block;
  font-size: 12px;
  line-height: 1.25;
  margin-top: 3px;
  overflow-wrap: anywhere;
}

.current-handoff-card {
  border-left: 4px solid #5870a0;
  display: grid;
  gap: 10px;
  padding: 10px;
}

.current-handoff-card h2,
.flow-blockers h2,
.correlation-ledger h2 {
  margin-bottom: 0;
}

.handoff-summary {
  color: #17201d !important;
  font-size: 14px !important;
  font-weight: 900;
  margin: 0 !important;
}

.handoff-meta-grid {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.handoff-meta-grid div {
  background: #fff;
  border: 1px solid #d8dfdb;
  border-radius: 6px;
  min-width: 0;
  padding: 7px;
}

.flow-blockers {
  border-left: 4px solid #b5812c;
  padding: 10px;
}

.flow-blockers ul {
  display: grid;
  gap: 7px;
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.flow-blockers li {
  display: grid;
  gap: 7px;
  grid-template-columns: 14px minmax(0, 1fr);
}

.flow-blockers li > span {
  background: #f6edda;
  border: 1px solid #d8ba83;
  border-radius: 50%;
  height: 11px;
  margin-top: 3px;
  width: 11px;
}

.flow-blockers li[data-severity="error"] > span {
  background: #f4deda;
  border-color: #d9a09c;
}

.flow-blockers strong {
  color: #26332f;
  display: block;
  font-size: 12px;
  line-height: 1.3;
}

.flow-blockers em {
  color: #59665f;
  display: block;
  font-size: 11px;
  font-style: normal;
  line-height: 1.3;
  margin-top: 2px;
}

.correlation-ledger {
  min-height: 0;
  overflow: hidden;
  padding: 10px;
}

.correlation-ledger ol {
  display: grid;
  gap: 6px;
  list-style: none;
  margin: 8px 0 0;
  max-height: 210px;
  overflow: auto;
  padding: 0;
}

.correlation-ledger li {
  align-items: center;
  background: #fff;
  border: 1px solid #d8dfdb;
  border-left: 3px solid #668577;
  border-radius: 6px;
  display: grid;
  gap: 4px 7px;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  padding: 7px 8px;
}

.correlation-ledger li[data-state="warning"] {
  border-left-color: #b5812c;
}

.correlation-ledger li[data-state="error"] {
  border-left-color: #b8403d;
}

.correlation-ledger time,
.correlation-ledger span,
.correlation-ledger em {
  color: #76837d;
  font-size: 10px;
  font-style: normal;
}

.correlation-ledger span {
  font-weight: 900;
  text-transform: uppercase;
}

.correlation-ledger strong {
  color: #26332f;
  font-size: 11px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.correlation-ledger details {
  grid-column: 1 / -1;
}

.observation-details {
  border: 1px solid #d8dfdb;
  border-radius: 6px;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.observation-details summary {
  color: #42504b;
  cursor: pointer;
  font-size: 12px;
  font-weight: 900;
}

.observation-details[open] {
  display: grid;
  gap: 10px;
}
```

- [ ] **Step 3: Add mobile adjustments**

Inside `@media (max-width: 560px)`, add:

```css
  .flow-health-strip,
  .handoff-meta-grid,
  .correlation-ledger li {
    grid-template-columns: minmax(0, 1fr);
  }
```

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit client rendering and styles**

Run:

```bash
git add dashboard/client/main.tsx dashboard/client/styles.css
git commit -m "Add handoff ledger dashboard view"
```

## Task 5: Browser Verification And Closeout

**Files:**
- No planned source edits.
- Evidence: screenshot saved under `/tmp` or a QA artifact path.

- [ ] **Step 1: Start the dashboard**

Run:

```bash
npm run dashboard -- --task dashboard-evidence-review --port 8798
```

Expected: server prints a local URL on `127.0.0.1:8798`. If port `8798` is busy, use `8799`.

- [ ] **Step 2: Open the dashboard in the in-app browser or Playwright**

Open:

```text
http://127.0.0.1:8798
```

Expected: the dashboard loads without a React error overlay.

- [ ] **Step 3: Capture a screenshot**

Capture a screenshot proving the Ledger First layout renders:

- health strip visible;
- Current Handoff visible;
- Needs Attention visible;
- Correlation Ledger visible;
- State/Dispatch details collapsed or available below.

- [ ] **Step 4: Stop the dashboard server**

Stop the dev server process started in Step 1.

- [ ] **Step 5: Run final checks**

Run:

```bash
npm test -- --runInBand
npm run build
git diff --stat HEAD
```

Expected:

- tests pass;
- build passes;
- diff only contains intended dashboard implementation changes after the last commit, or no diff if everything has been committed.

- [ ] **Step 6: Final disproof evidence**

Use this closeout shape:

```text
Claim: Ledger First Handoff Ledger is implemented for one active pair.
Disproof attempt: the most likely failure is a pretty rail that hides stale Dispatch, unconsumed inbox, failed commands, or open criteria.
Evidence: npm test -- --runInBand; npm run build; screenshot showing Health Strip, Current Handoff, Needs Attention, and Correlation Ledger; focused server tests for stale Dispatch, pending inbox, failed command, side-effect risk, no binding, and open criteria.
Residual risk: name any unverified live-pair behavior or state none known.
```
