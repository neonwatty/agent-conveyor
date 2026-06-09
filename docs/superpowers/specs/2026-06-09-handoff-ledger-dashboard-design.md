# Handoff Ledger Dashboard Design

## Purpose

Create a simple real-time dashboard view for one active manager, Dispatch, and
worker pair. The view should show who has the ball, why, and what needs to
happen next.

This is not a new QA dashboard, fleet monitor, graph explorer, or observability
console. It is a focused live handoff monitor for the current run.

The existing dashboard already exposes terminal panes, state, Dispatch health,
Dispatch chains, inbox summaries, criteria counts, and telemetry timeline data.
The missing product surface is a compact interpretation layer that turns those
records into an operator-readable flow:

```text
Manager -> Dispatch -> Worker -> Dispatch -> Manager
```

The first version should favor clarity over spectacle. Every visible element
must answer one of these questions:

1. Is the pair bound and alive?
2. Is Dispatch alive?
3. What was the last meaningful handoff?
4. Who is expected to act next?
5. Is anything blocked, stale, failed, or waiting in an inbox?

## Product Shape

The dashboard should present a **Handoff Ledger** as the primary observation
surface for a single task binding.

### Health Strip

The top of the observation surface should show a compact health strip:

- task state;
- active binding state;
- manager alive or stale;
- worker alive or stale;
- Dispatch active, stale, or not observed;
- open criteria count;
- pending inbox count;
- failed or blocked command count.

The strip should use plain language and restrained status colors. It should not
make users interpret raw command or notification states to know whether the loop
is healthy.

### Current Handoff

The main card should summarize the latest meaningful handoff. Example:

```text
Current handoff
Worker completed task -> Dispatch routed completion -> Manager consumed it

Waiting on: Manager
Reason: visual proof still missing before finish
Correlation: run-afd2941a
Updated: 12s ago
```

This card should be derived from the latest relevant correlation chain,
notification, command attempt, criteria state, and Dispatch heartbeat. It should
be intentionally small: one summary, one `waiting_on` actor, one `problem` when
present, and the strongest reason.

### Correlation Ledger

Below the current handoff, show a compact chronological ledger grouped by
correlation id. Each row should show:

- timestamp or age;
- actor (`manager`, `dispatch`, `worker`, `operator`, or `workerctl`);
- event kind;
- short summary;
- status (`ok`, `waiting`, `blocked`, `failed`, or `stale`);
- expandable details for ids, payloads, and evidence.

Example:

```text
12:40 Worker     task_complete source event #219
12:40 Dispatch   routed worker_task_complete notification #28
12:41 Manager    cycle #18 consumed notification
12:41 Manager    decision #44: ask worker for visual proof
```

The ledger should make causality easy to follow without requiring a multi-lane
graph. If a later design adds graphical treatment, it should render this same
ledger rather than introduce a second mental model.

### Actionable Blockers

A right rail or compact section should list only actionable blockers:

- no active binding;
- manager or worker dead/stale;
- Dispatch heartbeat stale or missing;
- command pending too long;
- command failed or blocked;
- side effect started but not completed;
- notification delivered but unconsumed;
- `pull_required` inbox item pending;
- worker completion routed but no later manager cycle consumed it;
- accepted criteria still open.

This section should not duplicate the whole event stream. It should answer:
"what should I look at first?"

### Debug Drawers

Raw details should stay available but collapsed by default:

- command payload and result;
- command attempt errors;
- notification delivery mode and state;
- source event id;
- consumed manager cycle id;
- manager decision reason;
- acceptance evidence JSON;
- terminal logs or transcript snippets.

Terminal panes remain useful as the detail/debug view, but they should not be
the primary way to understand flow health.

## Data Flow

Do not add new durable tables for the first version. The dashboard server should
derive a small `flow` object from existing observation data:

```ts
type FlowObservation = {
  task: string | null;
  manager: {
    name?: string;
    alive?: boolean | null;
    state?: string;
    last_seen_at?: string | null;
  };
  worker: {
    name?: string;
    alive?: boolean | null;
    state?: string;
    last_seen_at?: string | null;
  };
  dispatch: {
    status: "active" | "stale" | "not_observed";
    dispatcher_id?: string;
    heartbeat_age_seconds?: number | null;
  };
  current: {
    summary: string;
    waiting_on?: "worker" | "manager" | "dispatch" | "operator" | null;
    problem?: "blocked" | "failed" | "stale" | "side_effect_risk" | "pending_inbox" | "open_criteria" | null;
    correlation_id?: string | null;
    command_type?: string;
    command_state?: string;
    updated_at?: string;
  };
  counts: {
    queued_commands: number;
    failed_commands: number;
    pending_inbox: number;
    open_criteria: number;
  };
  ledger: Array<{
    key: string;
    time?: string;
    actor: "manager" | "dispatch" | "worker" | "operator" | "workerctl";
    kind: string;
    summary: string;
    status: "ok" | "waiting" | "blocked" | "failed" | "stale";
    correlation_id?: string | null;
    detail?: Record<string, unknown>;
  }>;
  blockers: Array<{
    key: string;
    severity: "warning" | "error";
    summary: string;
    detail?: string;
  }>;
};
```

Most fields are already available or derivable from the current
`/api/observation` payload:

- `binding`;
- `terminals`;
- `latest_cycle`;
- `criteria`;
- `dispatch.health`;
- `dispatch.inbox`;
- `dispatch.chains`;
- `timeline`;
- task state.

The first implementation should add this as a derived server-side field rather
than duplicating CLI logic in React. If the derivation proves unreliable during
dogfooding, add one small durable hint later, such as `next_actor`, emitted only
at durable handoff points.

## UI Placement

The Handoff Ledger should become the first thing a user sees in the observation
rail or a new primary observation band. The existing Dispatch chain list should
remain available as a drill-down, but it should not be the primary mental model.

The selected layout is **Ledger First**:

1. health strip;
2. current handoff;
3. actionable blockers;
4. correlation ledger;
5. existing detailed Dispatch and timeline sections behind expansion controls.

This layout is the default because it keeps the full operational story visible:
health, current handoff, blockers, and the event ledger. A small relay treatment
may be used inside the Current Handoff card, but only when it carries the same
state as the ledger and does not introduce a second graph-first model.

The visual treatment can be polished, but the layout should stay operational:
quiet status colors, clear text, stable dimensions, and no decorative graph that
does not carry state.

## Error Handling

When data is incomplete, the UI should degrade into explicit uncertainty:

- no binding: show `No active binding` and hide handoff claims;
- no Dispatch heartbeat: show `Dispatch not observed`;
- stale heartbeat: show the age and mark Dispatch stale;
- no correlation chains: show `Waiting for first handoff`;
- no latest cycle after worker completion: show `Waiting on manager`;
- open criteria: show `Waiting on manager/operator` unless another actor is
  more clearly responsible.

The dashboard must avoid implying that a task is safe to finish merely because a
worker says it is done. Criteria state, Dispatch consumption, and finish command
state must remain distinct.

## Testing And Verification

Implementation should include focused server tests for the `flow` derivation:

- healthy active binding;
- stale or missing Dispatch heartbeat;
- delivered but unconsumed notification;
- `pull_required` pending inbox item;
- failed or blocked command attempt;
- worker completion routed and consumed by a later manager cycle;
- accepted criteria still open.

Client verification should include a browser-backed check or screenshot for a
representative observation payload. The dashboard migration contract still
requires:

```bash
npm test -- --runInBand
npm run build
```

For live behavior changes, use the repo evidence playbook to name and disprove
the strongest realistic failure mode before closeout.

## Out Of Scope

- Fleet or multi-task overview.
- New durable tables.
- New telemetry taxonomy beyond a possible future `next_actor` hint.
- Animated topology as the primary UI.
- Raw transcript streaming by default.
- Replacing terminal panes.
- Full replay/export redesign.
- Finish-gate enforcement changes.

## Open Follow-Up

Before implementation, walk through one real active pair in the current
dashboard and confirm whether existing `dispatch.chains` already contain enough
information to derive `waiting_on` and `problem` reliably. If not, document the
smallest missing hint rather than expanding the whole schema.
