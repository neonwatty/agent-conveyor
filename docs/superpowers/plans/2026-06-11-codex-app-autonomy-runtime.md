# Codex App Autonomy Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Conveyor runtime needed for Codex app-created manager/worker sessions to operate with durable heartbeats, leases, recovery prompts, dispatcher status, and evidence-gated autonomous loops.

**Architecture:** Keep Codex app thread creation in the Codex app layer, because Conveyor CLI cannot directly call app tools. Conveyor becomes the durable control plane: it records app thread identities, gives each role one heartbeat command, computes lease health from existing session/dispatch/inbox telemetry, emits wake prompts, and exposes a single status command that says what the operator or app automation should do next.

**Tech Stack:** TypeScript CLI runtime, Node test runner, SQLite via `node:sqlite`, existing Conveyor sessions/bindings/commands/routed_notifications/telemetry tables, Codex app thread tools and automations as the external wake layer.

---

## Scope Map

This plan turns the eight autonomy suggestions into four concrete runtime capabilities:

- **Heartbeat command:** one role-specific command for Codex app sessions to run on wake, replacing prompt-only polling discipline.
- **Lease/status engine:** one pure runtime module that classifies manager, worker, dispatcher, command, inbox, and criteria health.
- **Wakeup plan:** one CLI output that tells the operator or app automation exactly which thread to wake and with which prompt.
- **Skill/docs update:** make the app-native managed-worker flow first-class and explicit about manager and worker thread creation.

This plan deliberately does not build a private Codex app API client. The app/server surface and built-in `create_thread` / `send_message_to_thread` tools remain outside the package. Conveyor outputs prompts, thread metadata, leases, and wake recommendations that those app tools can use.

---

## File Structure

- Modify: `src/runtime/codex-session.ts`
  - Add bound-session heartbeat helpers and exported role poll command helpers.
- Create: `src/runtime/app-autonomy.ts`
  - Compute app loop status, leases, wake recommendations, and heartbeat results from existing DB tables.
- Modify: `src/runtime/runtime.test.ts`
  - Add focused unit tests for heartbeat and status logic against temp SQLite DBs.
- Modify: `src/cli/typescript-runtime.ts`
  - Add CLI commands `app-heartbeat`, `app-loop-status`, and `app-wakeup-plan`.
- Modify: `src/cli/typescript-runtime.test.ts`
  - Add command parser and JSON output tests for the new commands.
- Modify: `src/index.ts`
  - Export app autonomy types/functions.
- Modify: `README.md`
  - Document the app-native autonomy workflow and command reference.
- Modify: `docs/manager-recipes.md`
  - Add the Codex app manager/worker loop recipe.
- Modify: `/Users/neonwatty/.codex/skills/manage-codex-workers/SKILL.md`
  - After package changes land and skills are reinstalled, update the installed skill through `conveyor install-skills`; do not hand-edit the installed skill as the source of truth.
- Modify or create: package skill source file that installs to `manage-codex-workers/SKILL.md`
  - Locate it with `rg "One-Prompt Codex App Ralph Loop" .` before editing, then update the package-owned source.

---

### Task 1: Add App Autonomy Runtime Model

**Files:**
- Create: `src/runtime/app-autonomy.ts`
- Modify: `src/index.ts`
- Test: `src/runtime/runtime.test.ts`

- [ ] **Step 1: Write failing tests for app-loop status classification**

Add tests near the existing runtime DB tests in `src/runtime/runtime.test.ts`:

```ts
test("app loop status classifies healthy codex app sessions and dispatch heartbeat", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-loop."));
  const dbPath = join(root, "workerctl.db");
  const database = openRuntimeDatabaseSync(dbPath);
  try {
    const now = "2026-06-11T12:00:00Z";
    seedAppLoopFixture(database, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:10Z",
      managerHeartbeatAt: "2026-06-11T11:59:20Z",
      workerHeartbeatAt: "2026-06-11T11:59:30Z",
      now,
    });

    const status = appLoopStatusSync(database, {
      dispatcherId: "dispatch-local",
      heartbeatStaleSeconds: 180,
      now,
      taskName: "app-loop-task",
    });

    assert.equal(status.ok, true);
    assert.equal(status.dispatch.state, "healthy");
    assert.equal(status.manager.lease.state, "healthy");
    assert.equal(status.worker.lease.state, "healthy");
    assert.deepEqual(status.next_actions, []);
  } finally {
    database.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("app loop status recommends waking stale pull-required sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-loop-stale."));
  const dbPath = join(root, "workerctl.db");
  const database = openRuntimeDatabaseSync(dbPath);
  try {
    const now = "2026-06-11T12:00:00Z";
    seedAppLoopFixture(database, {
      dispatcherHeartbeatAt: "2026-06-11T11:59:10Z",
      managerHeartbeatAt: "2026-06-11T11:51:00Z",
      workerHeartbeatAt: "2026-06-11T11:50:00Z",
      now,
    });

    const status = appLoopStatusSync(database, {
      dispatcherId: "dispatch-local",
      heartbeatStaleSeconds: 180,
      now,
      taskName: "app-loop-task",
    });

    assert.equal(status.ok, false);
    assert.equal(status.manager.lease.state, "stale");
    assert.equal(status.worker.lease.state, "stale");
    assert.equal(status.next_actions[0].kind, "wake_manager");
    assert.equal(status.next_actions[1].kind, "wake_worker");
  } finally {
    database.close();
    rmSync(root, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- --runInBand src/runtime/runtime.test.ts
```

Expected: FAIL because `appLoopStatusSync` and the fixture helper are not defined.

- [ ] **Step 3: Implement `src/runtime/app-autonomy.ts`**

Create `src/runtime/app-autonomy.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type AppLoopLeaseState = "healthy" | "stale" | "missing";
export type AppLoopDispatchState = "healthy" | "stale" | "missing";

export interface AppLoopRoleStatus {
  codex_app_thread_id: string | null;
  codex_app_thread_title: string | null;
  lease: {
    age_seconds: number | null;
    last_heartbeat_at: string | null;
    state: AppLoopLeaseState;
    stale_after_seconds: number;
  };
  name: string | null;
  poll_command: string | null;
  receive_style: "pull" | "push" | null;
  session_kind: "codex_app" | "tmux" | "no_tmux" | null;
}

export interface AppLoopStatus {
  dispatch: {
    dispatcher_id: string;
    last_heartbeat_at: string | null;
    state: AppLoopDispatchState;
  };
  manager: AppLoopRoleStatus;
  next_actions: Array<{ kind: string; prompt?: string; reason: string; role?: "manager" | "worker" }>;
  ok: boolean;
  task: { id: string; name: string };
  worker: AppLoopRoleStatus;
}

export function appLoopStatusSync(
  database: DatabaseSync,
  options: { dispatcherId: string; heartbeatStaleSeconds: number; now: string; taskName: string },
): AppLoopStatus {
  const task = database.prepare("select id, name from tasks where name = ?").get(options.taskName) as { id: string; name: string } | undefined;
  if (!task) {
    throw new Error(`Task not found: ${options.taskName}`);
  }
  const binding = database.prepare(`
    select ws.name as worker_name, ws.last_heartbeat_at as worker_last_heartbeat_at,
           ws.codex_app_thread_id as worker_thread_id, ws.codex_app_thread_title as worker_thread_title,
           ws.tmux_session as worker_tmux_session,
           ms.name as manager_name, ms.last_heartbeat_at as manager_last_heartbeat_at,
           ms.codex_app_thread_id as manager_thread_id, ms.codex_app_thread_title as manager_thread_title,
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
    order by timestamp desc
    limit 1
  `).get(options.dispatcherId) as { timestamp: string } | undefined;

  const manager = roleStatus({
    heartbeatStaleSeconds: options.heartbeatStaleSeconds,
    lastHeartbeatAt: binding.manager_last_heartbeat_at,
    name: binding.manager_name,
    now: options.now,
    role: "manager",
    taskName: options.taskName,
    threadId: binding.manager_thread_id,
    threadTitle: binding.manager_thread_title,
    tmuxSession: binding.manager_tmux_session,
  });
  const worker = roleStatus({
    heartbeatStaleSeconds: options.heartbeatStaleSeconds,
    lastHeartbeatAt: binding.worker_last_heartbeat_at,
    name: binding.worker_name,
    now: options.now,
    role: "worker",
    taskName: options.taskName,
    threadId: binding.worker_thread_id,
    threadTitle: binding.worker_thread_title,
    tmuxSession: binding.worker_tmux_session,
  });
  const dispatchState = classifyTime(dispatchHeartbeat?.timestamp ?? null, options.now, options.heartbeatStaleSeconds);
  const dispatch = {
    dispatcher_id: options.dispatcherId,
    last_heartbeat_at: dispatchHeartbeat?.timestamp ?? null,
    state: dispatchState === "healthy" ? "healthy" as const : dispatchState === "stale" ? "stale" as const : "missing" as const,
  };
  const next_actions: AppLoopStatus["next_actions"] = [];
  if (dispatch.state !== "healthy") {
    next_actions.push({
      kind: "start_dispatch",
      reason: `Dispatch ${options.dispatcherId} is ${dispatch.state}.`,
      prompt: `Run: conveyor dispatch --watch --dispatcher-id ${options.dispatcherId}`,
    });
  }
  if (manager.lease.state !== "healthy") {
    next_actions.push({ kind: "wake_manager", reason: `Manager heartbeat is ${manager.lease.state}.`, role: "manager", prompt: manager.poll_command ?? undefined });
  }
  if (worker.lease.state !== "healthy") {
    next_actions.push({ kind: "wake_worker", reason: `Worker heartbeat is ${worker.lease.state}.`, role: "worker", prompt: worker.poll_command ?? undefined });
  }
  return {
    dispatch,
    manager,
    next_actions,
    ok: dispatch.state === "healthy" && manager.lease.state === "healthy" && worker.lease.state === "healthy",
    task,
    worker,
  };
}

function roleStatus(options: {
  heartbeatStaleSeconds: number;
  lastHeartbeatAt: string | null;
  name: string | null;
  now: string;
  role: "manager" | "worker";
  taskName: string;
  threadId: string | null;
  threadTitle: string | null;
  tmuxSession: string | null;
}): AppLoopRoleStatus {
  const leaseState = classifyTime(options.lastHeartbeatAt, options.now, options.heartbeatStaleSeconds);
  const hasTmux = Boolean(options.tmuxSession);
  return {
    codex_app_thread_id: options.threadId,
    codex_app_thread_title: options.threadTitle,
    lease: {
      age_seconds: ageSeconds(options.lastHeartbeatAt, options.now),
      last_heartbeat_at: options.lastHeartbeatAt,
      state: leaseState,
      stale_after_seconds: options.heartbeatStaleSeconds,
    },
    name: options.name,
    poll_command: `conveyor ${options.role}-inbox ${shellQuote(options.taskName)} --consume-next --wait --timeout 60 --json`,
    receive_style: hasTmux ? "push" : "pull",
    session_kind: hasTmux ? "tmux" : options.threadId ? "codex_app" : "no_tmux",
  };
}

function classifyTime(value: string | null, now: string, staleSeconds: number): AppLoopLeaseState {
  if (!value) return "missing";
  const age = ageSeconds(value, now);
  return age !== null && age <= staleSeconds ? "healthy" : "stale";
}

function ageSeconds(value: string | null, now: string): number | null {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(value)) / 1000));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
```

- [ ] **Step 4: Export the runtime**

Add to `src/index.ts`:

```ts
export type { AppLoopRoleStatus, AppLoopStatus } from "./runtime/app-autonomy.js";
export { appLoopStatusSync } from "./runtime/app-autonomy.js";
```

- [ ] **Step 5: Add test fixture helper**

Add this helper to `src/runtime/runtime.test.ts` near related DB fixture helpers:

```ts
function seedAppLoopFixture(
  database: RuntimeDatabase,
  options: {
    dispatcherHeartbeatAt: string | null;
    managerHeartbeatAt: string | null;
    now: string;
    workerHeartbeatAt: string | null;
  },
): void {
  database.prepare("insert into tasks(id, name, goal, summary, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)").run(
    "task-app-loop",
    "app-loop-task",
    "Exercise app loop status.",
    null,
    "managed",
    options.now,
    options.now,
  );
  database.prepare(`
    insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
      codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("session-worker-app", "worker-app", "worker", "worker-token", "codex-worker", "/tmp/worker.jsonl",
    "thread-worker", "Worker App", "/repo", options.now, options.workerHeartbeatAt, "active");
  database.prepare(`
    insert into sessions(id, name, role, identity_token, codex_session_id, codex_session_path,
      codex_app_thread_id, codex_app_thread_title, cwd, registered_at, last_heartbeat_at, state)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("session-manager-app", "manager-app", "manager", "manager-token", "codex-manager", "/tmp/manager.jsonl",
    "thread-manager", "Manager App", "/repo", options.now, options.managerHeartbeatAt, "active");
  database.prepare("insert into bindings(id, task_id, worker_session_id, manager_session_id, state, created_at) values (?, ?, ?, ?, ?, ?)").run(
    "binding-app-loop",
    "task-app-loop",
    "session-worker-app",
    "session-manager-app",
    "active",
    options.now,
  );
  if (options.dispatcherHeartbeatAt) {
    database.prepare(`
      insert into telemetry_events(id, actor, event_type, severity, summary, timestamp, correlation_json, attributes_json)
      values (?, 'dispatch', 'dispatch_watch_heartbeat', 'info', 'Dispatch watch heartbeat 1.', ?, ?, ?)
    `).run(
      "telemetry-dispatch-app-loop",
      options.dispatcherHeartbeatAt,
      JSON.stringify({ dispatcher_id: "dispatch-local", iteration: 1 }),
      JSON.stringify({ dry_run: false, processed_count: 0 }),
    );
  }
}
```

- [ ] **Step 6: Run tests to verify pass**

Run:

```bash
npm test -- --runInBand src/runtime/runtime.test.ts
```

Expected: PASS for the new app loop status tests and existing runtime tests.

---

### Task 2: Add `app-heartbeat` Command

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add tests in `src/cli/typescript-runtime.test.ts`:

```ts
test("TypeScript runtime app-heartbeat refreshes bound manager session and returns poll command", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-heartbeat."));
  const dbPath = join(root, "workerctl.db");
  try {
    const result = runTypescriptRuntime([
      "app-heartbeat",
      "app-loop-task",
      "--role",
      "manager",
      "--path",
      dbPath,
      "--json",
    ], { now: () => new Date("2026-06-11T12:00:00Z") });

    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.role, "manager");
    assert.equal(output.task.name, "app-loop-task");
    assert.equal(output.poll_command.includes("manager-inbox app-loop-task"), true);
    assert.equal(output.heartbeat.state, "recorded");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
```

Seed the same fixture pattern used by Task 1 before invoking the command.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: FAIL with unsupported command `app-heartbeat`.

- [ ] **Step 3: Implement parser support**

In `src/cli/typescript-runtime.ts`, add `app-heartbeat` to the command allowlist and support:

```ts
if (parsed.command === "app-heartbeat") {
  return runAppHeartbeatCommand(parsed, options);
}
```

Add flag parsing for:

```text
--role manager|worker
--dispatcher-id <id>
--stale-after <seconds>
```

Default `--dispatcher-id` to `dispatch-local` and `--stale-after` to `180`.

- [ ] **Step 4: Implement heartbeat command behavior**

Add `runAppHeartbeatCommand` in `src/cli/typescript-runtime.ts`:

```ts
function runAppHeartbeatCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const role = parsed.flags.role;
  if (role !== "manager" && role !== "worker") {
    return errorResult("app-heartbeat requires --role manager|worker");
  }
  const taskName = parsed.task;
  if (!taskName) {
    return errorResult("app-heartbeat requires a task name");
  }
  const database = openRuntimeDatabase(parsed, options);
  try {
    const now = nowIsoSeconds(options);
    const session = boundSessionForRoleSync(database, { role, taskName });
    database.prepare("update sessions set last_heartbeat_at = ? where id = ?").run(now, session.id);
    emitTelemetrySync(database, {
      actor: role,
      attributes: { role, task: taskName },
      correlation: { command: "app-heartbeat" },
      eventType: "app_heartbeat",
      severity: "info",
      summary: `${role} app heartbeat for ${taskName}.`,
      timestamp: now,
    });
    const output = {
      heartbeat: { recorded_at: now, state: "recorded" },
      poll_command: sessionPollCommand(role, taskName, parsed.flags.dbPath),
      role,
      task: { name: taskName },
    };
    return parsed.flags.json ? jsonResult(output) : textResult(`${role} heartbeat recorded for ${taskName}\n`);
  } finally {
    database.close();
  }
}
```

If local helpers have different names, preserve existing naming and reuse the existing bound-session query style.

- [ ] **Step 5: Run CLI tests**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: PASS for `app-heartbeat` tests.

---

### Task 3: Add `app-loop-status` Command

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write failing status command tests**

Add tests:

```ts
test("TypeScript runtime app-loop-status reports stale worker and start-dispatch action", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-loop-status."));
  const dbPath = join(root, "workerctl.db");
  seedCliAppLoopFixture(dbPath, {
    dispatcherHeartbeatAt: null,
    managerHeartbeatAt: "2026-06-11T11:59:50Z",
    workerHeartbeatAt: "2026-06-11T11:45:00Z",
  });
  try {
    const result = runTypescriptRuntime([
      "app-loop-status",
      "app-loop-task",
      "--path",
      dbPath,
      "--json",
    ], { now: () => new Date("2026-06-11T12:00:00Z") });

    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.dispatch.state, "missing");
    assert.equal(output.worker.lease.state, "stale");
    assert.equal(output.next_actions.some((action: { kind: string }) => action.kind === "start_dispatch"), true);
    assert.equal(output.next_actions.some((action: { kind: string }) => action.kind === "wake_worker"), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: FAIL with unsupported command `app-loop-status`.

- [ ] **Step 3: Implement command**

Wire the command to `appLoopStatusSync`:

```ts
function runAppLoopStatusCommand(
  parsed: ParsedRuntimeArgs,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date },
): TypescriptRuntimeResult {
  const taskName = parsed.task;
  if (!taskName) return errorResult("app-loop-status requires a task name");
  const database = openRuntimeDatabase(parsed, options);
  try {
    const status = appLoopStatusSync(database, {
      dispatcherId: parsed.flags.dispatcherId ?? "dispatch-local",
      heartbeatStaleSeconds: parsed.flags.staleAfterSeconds ?? 180,
      now: nowIsoSeconds(options),
      taskName,
    });
    return parsed.flags.json ? jsonResult(status) : textResult(renderAppLoopStatusText(status));
  } finally {
    database.close();
  }
}
```

- [ ] **Step 4: Implement concise text rendering**

Add text output:

```ts
function renderAppLoopStatusText(status: AppLoopStatus): string {
  const lines = [
    `App loop ${status.task.name}: ${status.ok ? "ok" : "attention required"}`,
    `Dispatch ${status.dispatch.dispatcher_id}: ${status.dispatch.state}`,
    `Manager ${status.manager.name ?? "(missing)"}: ${status.manager.lease.state}`,
    `Worker ${status.worker.name ?? "(missing)"}: ${status.worker.lease.state}`,
  ];
  for (const action of status.next_actions) {
    lines.push(`Next: ${action.kind} - ${action.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: PASS for `app-loop-status` tests.

---

### Task 4: Add `app-wakeup-plan` Command

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing wakeup-plan tests**

Add test:

```ts
test("TypeScript runtime app-wakeup-plan prints app-thread prompts for stale roles", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-app-wakeup-plan."));
  const dbPath = join(root, "workerctl.db");
  seedCliAppLoopFixture(dbPath, {
    dispatcherHeartbeatAt: "2026-06-11T11:59:00Z",
    managerHeartbeatAt: "2026-06-11T11:45:00Z",
    workerHeartbeatAt: "2026-06-11T11:44:00Z",
  });
  try {
    const result = runTypescriptRuntime([
      "app-wakeup-plan",
      "app-loop-task",
      "--path",
      dbPath,
      "--json",
    ], { now: () => new Date("2026-06-11T12:00:00Z") });
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.wakeups.length, 2);
    assert.equal(output.wakeups[0].thread.id, "thread-manager");
    assert.equal(output.wakeups[0].prompt.includes("conveyor app-heartbeat app-loop-task --role manager"), true);
    assert.equal(output.wakeups[1].thread.id, "thread-worker");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: FAIL with unsupported command `app-wakeup-plan`.

- [ ] **Step 3: Implement wakeup plan output**

Add a command that wraps `appLoopStatusSync` and returns:

```ts
{
  dispatcher: {
    command: "conveyor dispatch --watch --dispatcher-id dispatch-local",
    required: true
  },
  wakeups: [
    {
      role: "manager",
      thread: { id: "thread-manager", title: "Manager App" },
      prompt: "Use the manage-codex-workers skill.\nRun: conveyor app-heartbeat app-loop-task --role manager --json\nThen follow the returned poll command or next instruction."
    }
  ]
}
```

Prompt rules:

- Manager prompt must say: verify worker claims before conclusions, require evidence, and produce exactly one next worker task.
- Worker prompt must say: execute only the consumed instruction, report evidence, blockers, residual risk, and exactly one next recommended worker task.
- Both prompts must say idle polling is not completion and does not tear down heartbeat.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: PASS for `app-wakeup-plan`.

---

### Task 5: Extend Disposable Binding Output To Prefer App Runtime Commands

**Files:**
- Modify: `src/cli/typescript-runtime.ts`
- Test: `src/cli/typescript-runtime.test.ts`

- [ ] **Step 1: Write failing disposable-binding assertion**

Find the existing `create-disposable-binding --json` test for heartbeat recommendations and add assertions:

```ts
assert.equal(output.heartbeat_recommendations.manager.poll_command.includes("app-heartbeat"), true);
assert.equal(output.heartbeat_recommendations.worker.poll_command.includes("app-heartbeat"), true);
assert.equal(output.heartbeat_recommendations.status_command.includes("app-loop-status"), true);
assert.equal(output.heartbeat_recommendations.wakeup_plan_command.includes("app-wakeup-plan"), true);
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: FAIL because current heartbeat recommendations point directly at `manager-inbox` / `worker-inbox`.

- [ ] **Step 3: Update heartbeat recommendations**

Change the recommendation shape to include:

```ts
status_command: "conveyor app-loop-status <task> --json",
wakeup_plan_command: "conveyor app-wakeup-plan <task> --json",
manager.poll_command: "conveyor app-heartbeat <task> --role manager --json",
worker.poll_command: "conveyor app-heartbeat <task> --role worker --json"
```

Keep the direct inbox command in each role prompt as a fallback named `direct_inbox_command`.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- --runInBand src/cli/typescript-runtime.test.ts
```

Expected: PASS for disposable binding heartbeat tests and new app runtime command tests.

---

### Task 6: Update Manager Skill Source For App-Native Manager And Worker Creation

**Files:**
- Modify: package-owned source for `manage-codex-workers/SKILL.md`
- Modify after install only: `/Users/neonwatty/.codex/skills/manage-codex-workers/SKILL.md`

- [ ] **Step 1: Locate package skill source**

Run:

```bash
rg -n "One-Prompt Codex App Ralph Loop|create_thread|worker-codex-app-thread-id" .
```

Expected: one source path inside the package plus the installed skill path.

- [ ] **Step 2: Update source skill instructions**

Change the Codex app Ralph loop instructions so they explicitly support two app-native setups:

```text
Preferred fully app-native setup:
1. The operator thread creates a same-project manager thread with create_thread.
2. The operator thread creates a same-project worker thread with create_thread.
3. The operator records both thread ids in create-disposable-binding using --manager-codex-app-thread-id and --worker-codex-app-thread-id.
4. The operator starts or verifies Dispatch.
5. The operator sends the manager bootstrap prompt to the manager thread and the worker bootstrap prompt to the worker thread.
6. The manager and worker use conveyor app-heartbeat, not direct inbox polling, as their default heartbeat.
```

Preserve the existing fallback where the current thread acts as manager and only a worker thread is created.

- [ ] **Step 3: Reinstall skills**

Run:

```bash
conveyor install-skills --json
```

Expected: output includes `manage-codex-workers`.

- [ ] **Step 4: Verify installed skill**

Run:

```bash
rg -n "app-heartbeat|app-loop-status|Preferred fully app-native setup" /Users/neonwatty/.codex/skills/manage-codex-workers/SKILL.md
```

Expected: all three strings are present.

---

### Task 7: Document The Hands-Off Operating Model

**Files:**
- Modify: `README.md`
- Modify: `docs/manager-recipes.md`
- Modify: `docs/manual-qa-checklist.md`

- [ ] **Step 1: Update README command reference**

Add command entries:

```markdown
- `app-heartbeat TASK --role manager|worker [--dispatcher-id ID] [--stale-after N] [--json]` —
  records a Codex app session heartbeat for the bound role and returns the
  role's next poll/action command. This is the default recurring command for
  pull-required Codex app sessions.
- `app-loop-status TASK [--dispatcher-id ID] [--stale-after N] [--json]` —
  summarizes manager, worker, Dispatch, and wake health for an app-native
  Conveyor loop.
- `app-wakeup-plan TASK [--dispatcher-id ID] [--json]` — returns the exact
  manager and worker thread prompts an operator or Codex app automation should
  send when sessions are stale or have pending work.
```

- [ ] **Step 2: Update manager recipe**

Add a recipe named `Codex App Native Manager/Worker Loop` with this minimum runbook:

```bash
conveyor doctor
conveyor db-doctor
conveyor create-disposable-binding TASK \
  --worker WORKER \
  --manager MANAGER \
  --worker-codex-app-thread-id THREAD_WORKER \
  --worker-codex-app-thread-title "Worker" \
  --manager-codex-app-thread-id THREAD_MANAGER \
  --manager-codex-app-thread-title "Manager" \
  --adversarial \
  --json
conveyor dispatch --watch --dispatcher-id dispatch-local
conveyor app-loop-status TASK --json
conveyor app-wakeup-plan TASK --json
```

- [ ] **Step 3: Update manual QA checklist**

Add a checklist item:

```markdown
- [ ] App-native loop drill: create a disposable binding with manager and worker
  Codex app thread ids, run bounded `dispatch --watch`, run
  `app-heartbeat` for each role, verify `app-loop-status --json` reports
  healthy leases, then age one heartbeat and verify `app-wakeup-plan --json`
  recommends only the stale role.
```

- [ ] **Step 4: Run docs grep**

Run:

```bash
rg -n "app-heartbeat|app-loop-status|app-wakeup-plan|Codex App Native Manager/Worker Loop" README.md docs/manager-recipes.md docs/manual-qa-checklist.md
```

Expected: each command appears in command reference, recipe, and QA checklist.

---

### Task 8: Add End-To-End Package Smoke For App Autonomy

**Files:**
- Modify: package smoke script discovered by `rg -n "package-smoke|release-check" scripts package.json`
- Test: smoke script output

- [ ] **Step 1: Locate smoke script**

Run:

```bash
rg -n "package-smoke|release-check|create-disposable-binding" scripts package.json
```

Expected: identify the script that installs or exercises the packed package.

- [ ] **Step 2: Add app autonomy smoke steps**

Extend the smoke script to run against a temp DB:

```bash
conveyor create-disposable-binding smoke-app-loop \
  --worker smoke-worker \
  --manager smoke-manager \
  --worker-codex-app-thread-id thread-worker-smoke \
  --worker-codex-app-thread-title "Smoke Worker" \
  --manager-codex-app-thread-id thread-manager-smoke \
  --manager-codex-app-thread-title "Smoke Manager" \
  --adversarial \
  --path "$DB" \
  --json

conveyor app-heartbeat smoke-app-loop --role manager --path "$DB" --json
conveyor app-heartbeat smoke-app-loop --role worker --path "$DB" --json
conveyor dispatch --watch --watch-iterations 1 --dispatcher-id dispatch-local --path "$DB" --json
conveyor app-loop-status smoke-app-loop --path "$DB" --json
conveyor app-wakeup-plan smoke-app-loop --path "$DB" --json
```

Assert `app-loop-status` has `"ok":true` after both role heartbeats and one dispatch heartbeat.

- [ ] **Step 3: Run local package smoke**

Run:

```bash
npm run build:cli
scripts/package-smoke
```

Expected: both commands exit 0 and the smoke output proves app autonomy commands work from the built package.

---

### Task 9: Final Verification And Release Readiness

**Files:**
- No new source files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- --runInBand src/runtime/runtime.test.ts src/cli/typescript-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build:cli
```

Expected: PASS.

- [ ] **Step 3: Run package smoke**

Run:

```bash
scripts/package-smoke
```

Expected: PASS, including `app-heartbeat`, `app-loop-status`, and `app-wakeup-plan`.

- [ ] **Step 4: Run release check**

Run:

```bash
scripts/release-check
```

Expected: PASS.

- [ ] **Step 5: Strongest failure-mode check**

Failure mode: app-native loops appear healthy even though Dispatch is dead or app sessions are stale.

Run:

```bash
DB="$(mktemp -t conveyor-app-loop.XXXXXX.db)"
conveyor create-disposable-binding stale-app-loop \
  --worker stale-worker \
  --manager stale-manager \
  --worker-codex-app-thread-id thread-worker-stale \
  --manager-codex-app-thread-id thread-manager-stale \
  --path "$DB" \
  --json >/tmp/stale-app-loop-create.json
conveyor app-loop-status stale-app-loop --path "$DB" --json >/tmp/stale-app-loop-status.json
node -e 'const s=require("/tmp/stale-app-loop-status.json"); if (s.ok || !s.next_actions.some(a=>a.kind==="start_dispatch")) process.exit(1)'
```

Expected: exit 0. The status must be unhealthy and must recommend starting Dispatch before any hands-off claim is made.

---

## Mapping Back To The Eight Suggestions

1. **Real wakeup mechanism:** `app-wakeup-plan` emits exact prompts and thread ids for Codex app automation or operator `send_message_to_thread`.
2. **Dispatcher as daemon:** `app-loop-status` treats missing/stale dispatch heartbeat as unhealthy and recommends the exact watch command.
3. **Inbox-driven app wakeups:** stale or pending roles become explicit wake recommendations instead of silent pull-only waits.
4. **Lease/timeout rules:** `appLoopStatusSync` computes manager, worker, and dispatch lease state with one stale threshold.
5. **Manager recovery prompt:** `app-wakeup-plan` emits a manager prompt with evidence verification and single-next-task rules.
6. **Worker recovery prompt:** `app-wakeup-plan` emits a worker prompt with single-instruction execution and evidence reporting rules.
7. **Operator dashboard/status command:** `app-loop-status` is the CLI status surface; dashboard wiring can follow once the CLI contract is stable.
8. **Hard safety rails:** skill/docs prompts keep manager evidence gates and worker scope limits explicit; task-specific rails remain in task prompts.

---

## Self-Review

- Spec coverage: all eight autonomy suggestions map to either heartbeat, lease/status, wakeup plan, dispatcher status, or skill/docs.
- Placeholder scan: this plan avoids placeholder language and gives exact commands, paths, and expected outcomes.
- Type consistency: the plan uses `appLoopStatusSync`, `app-heartbeat`, `app-loop-status`, and `app-wakeup-plan` consistently across runtime, CLI, tests, docs, and smoke.

Plan complete and saved to `docs/superpowers/plans/2026-06-11-codex-app-autonomy-runtime.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, with checkpoints for review.
