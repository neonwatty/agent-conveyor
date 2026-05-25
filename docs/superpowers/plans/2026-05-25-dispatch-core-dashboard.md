# Dispatch Core Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dispatch a first-class always-on core component for supervised worker/manager pairs, and make the dashboard visually prove that Dispatch is carrying the worker/manager coordination loop.

**Architecture:** Add explicit Dispatch supervision to the control plane instead of relying on operators to remember a second command. `workerctl pair` and `workerctl dashboard` should be able to ensure a Dispatch watch process is running, while dashboard evidence comes from durable heartbeats, routed notifications, command attempts, manager cycles, and correlation chains. The dashboard remains an observer by default unless an explicit command path starts Dispatch, but the system workflow should make “no Dispatch” a loud degraded state, not a normal quiet state.

**Tech Stack:** Python `workerctl` CLI and SQLite control-plane DB, Node/Express dashboard backend, React dashboard client, Python `unittest`, Node test runner/Vite.

---

## File Structure

- Modify `workerctl/db.py`
  - Add durable dispatcher process records if we choose DB-owned Dispatch supervision.
  - Keep migration/index ordering safe for existing databases.
- Modify `workerctl/cli.py`
  - Add dashboard/pair flags for Dispatch supervision.
- Modify `workerctl/commands.py`
  - Add `ensure_dispatch_watch(...)` helper.
  - Wire Dispatch auto-start into `pair` and an explicit dashboard flag.
  - Add a status payload the dashboard can consume.
- Modify `dashboard/server/index.ts`
  - Fetch Dispatch process status in addition to heartbeat telemetry.
  - Optionally expose a local-only API endpoint to start Dispatch if we choose a dashboard button.
- Modify `dashboard/client/main.tsx`
  - Add a prominent Dispatch core-status banner and a “routing proof” lane.
  - Render the worker/manager conversation from durable Dispatch/control-plane rows.
- Modify `dashboard/client/styles.css`
  - Style active/degraded Dispatch state, routing chain groups, and failure/risk callouts.
- Modify `dashboard/server/workerctl.test.ts`
  - Test server-side normalization of Dispatch health, process status, chain summaries, and start-action args.
- Modify `tests/test_workerctl.py`
  - Test CLI behavior for Dispatch auto-start / ensure-start.
  - Test no duplicate Dispatch process starts.
  - Test manual/debug direct paths remain available.
- Modify `README.md`, `docs/manual-qa-checklist.md`, `skills/manage-codex-workers/SKILL.md`
  - Reframe Dispatch as core infrastructure.
  - Document “started automatically by pair/dashboard flow” and the visual proof expected in manual QA.

---

## Decision: Default Behavior

Implement this policy:

- `workerctl pair` should ensure Dispatch is running by default.
- `workerctl dashboard` should not silently start an actuator by default, but should provide an explicit `--ensure-dispatch` flag and a visible local-only “Start Dispatch” affordance.
- `workerctl dashboard` should loudly show `Dispatch: not observed` when Dispatch is absent.
- `workerctl dashboard --ensure-dispatch` should become the recommended manual-QA command.
- Keep `scripts/workerctl dispatch --watch ...` as the explicit low-level command for debugging and CI/manual isolated checks.

This gives the system sane defaults for the core pair workflow, while keeping dashboard startup safe and auditable.

---

### Task 0: Commit Existing Migration Fix

**Files:**
- Modify: `workerctl/db.py`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Verify the current migration fix**

Run:

```bash
python3 -m unittest tests.test_workerctl.DatabaseTests.test_database_migrates_routed_notifications_before_consumption_columns -v
npm test -- --runInBand
python3 -m py_compile workerctl/*.py
git diff --check
```

Expected:

```text
test_database_migrates_routed_notifications_before_consumption_columns ... ok
26 dashboard tests pass
py_compile exits 0
git diff --check exits 0
```

- [ ] **Step 2: Commit the migration fix**

Run:

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Fix routed notification migration ordering"
```

Expected:

```text
[main <sha>] Fix routed notification migration ordering
```

---

### Task 1: Add Dispatch Ensure-Start Contract

**Files:**
- Test: `tests/test_workerctl.py`
- Modify: `workerctl/commands.py`
- Modify: `workerctl/cli.py`

- [ ] **Step 1: Write failing tests for dashboard dry-run ensure-dispatch**

Add to `CliTests` in `tests/test_workerctl.py`:

```python
def test_dashboard_dry_run_can_include_dispatch_watch(self):
    proc = self.run_workerctl(
        "dashboard",
        "--task",
        "qa-task",
        "--ensure-dispatch",
        "--dispatcher-id",
        "dispatch-dashboard",
        "--dry-run",
        "--json",
    )

    self.assertEqual(proc.returncode, 0, proc.stderr)
    payload = json.loads(proc.stdout)
    self.assertEqual(payload["task"], "qa-task")
    self.assertTrue(payload["ensure_dispatch"])
    self.assertIn("dispatch", payload["dispatch_command"])
    self.assertIn("--watch", payload["dispatch_command"])
    self.assertIn("--dispatcher-id", payload["dispatch_command"])
    self.assertIn("dispatch-dashboard", payload["dispatch_command"])
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_dashboard_dry_run_can_include_dispatch_watch -v
```

Expected:

```text
error: unrecognized arguments: --ensure-dispatch --dispatcher-id dispatch-dashboard
```

- [ ] **Step 3: Add CLI flags**

In `workerctl/cli.py`, update the dashboard parser:

```python
dashboard.add_argument("--ensure-dispatch", action="store_true", help="Start a local Dispatch watch process for this dashboard if one is not observed.")
dashboard.add_argument("--dispatcher-id", default="dispatch-dashboard", help="Dispatcher id used with --ensure-dispatch.")
```

- [ ] **Step 4: Add dry-run command shape**

In `workerctl/commands.py`, update `command_dashboard` dry-run payload to include:

```python
dispatch_command = [
    str(workerctl_path),
    "dispatch",
    "--watch",
    "--dispatcher-id",
    args.dispatcher_id,
]
if args.task:
    dispatch_command.extend(["--task", args.task])
```

And add to the JSON payload:

```python
"ensure_dispatch": bool(getattr(args, "ensure_dispatch", False)),
"dispatch_command": dispatch_command if getattr(args, "ensure_dispatch", False) else None,
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_dashboard_dry_run_can_include_dispatch_watch -v
```

Expected:

```text
OK
```

- [ ] **Step 6: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py tests/test_workerctl.py
git commit -m "Add dashboard dispatch ensure contract"
```

---

### Task 2: Implement Local Dispatch Watch Start

**Files:**
- Test: `tests/test_workerctl.py`
- Modify: `workerctl/commands.py`

- [ ] **Step 1: Write failing test for dashboard starting Dispatch**

Add to `CliTests`:

```python
def test_dashboard_ensure_dispatch_starts_watch_process(self):
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "workerctl.db"
        spawned = []

        def fake_popen(command, **kwargs):
            spawned.append({"command": command, "kwargs": kwargs})

            class Proc:
                pid = 12345

            return Proc()

        with mock.patch("workerctl.commands.subprocess.Popen", side_effect=fake_popen):
            proc = self.run_workerctl(
                "dashboard",
                "--ensure-dispatch",
                "--dispatcher-id",
                "dispatch-dashboard",
                "--db-path",
                str(db_path),
                "--dry-run",
                "--json",
            )

    self.assertEqual(proc.returncode, 0, proc.stderr)
    payload = json.loads(proc.stdout)
    self.assertEqual(payload["dispatch_command"][1:4], ["dispatch", "--watch", "--dispatcher-id"])
```

If `run_workerctl` cannot observe the mock because it shells a subprocess, convert this to a direct helper test for a new pure function:

```python
command = commands.dashboard_dispatch_command(
    workerctl_path=Path("scripts/workerctl"),
    dispatcher_id="dispatch-dashboard",
    task=None,
    db_path=Path("/tmp/workerctl.db"),
)
self.assertEqual(command[:4], ["scripts/workerctl", "dispatch", "--watch", "--dispatcher-id"])
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_dashboard_ensure_dispatch_starts_watch_process -v
```

Expected: failure because no start helper exists yet.

- [ ] **Step 3: Implement helper**

Add in `workerctl/commands.py`:

```python
def dashboard_dispatch_command(
    *,
    workerctl_path: Path,
    dispatcher_id: str,
    task: str | None,
    db_path: Path | None,
) -> list[str]:
    command = [str(workerctl_path), "dispatch", "--watch", "--dispatcher-id", dispatcher_id]
    if task:
        command.extend(["--task", task])
    if db_path:
        command.extend(["--path", str(db_path)])
    return command
```

Then when `--ensure-dispatch` is set and not `--dry-run`, start it:

```python
subprocess.Popen(
    dispatch_command,
    cwd=str(PROJECT_ROOT),
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
)
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_dashboard_dry_run_can_include_dispatch_watch tests.test_workerctl.CliTests.test_dashboard_ensure_dispatch_starts_watch_process -v
```

Expected:

```text
OK
```

- [ ] **Step 5: Commit**

```bash
git add workerctl/commands.py tests/test_workerctl.py
git commit -m "Start dispatch watch from dashboard when requested"
```

---

### Task 3: Ensure Dispatch From Pair Workflow

**Files:**
- Test: `tests/test_workerctl.py`
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Modify: `README.md`
- Modify: `skills/manage-codex-workers/SKILL.md`

- [ ] **Step 1: Write failing test for pair dry-run output**

Add to `PairCommandTests`:

```python
def test_pair_dry_run_reports_dispatch_watch_by_default(self):
    proc = self.run_workerctl(
        "pair",
        "--worker",
        "qa-worker",
        "--manager",
        "qa-manager",
        "--task",
        "qa-task",
        "--goal",
        "Exercise dispatch.",
        "--dry-run",
        "--json",
    )

    self.assertEqual(proc.returncode, 0, proc.stderr)
    payload = json.loads(proc.stdout)
    self.assertTrue(payload["dispatch"]["ensure"])
    self.assertIn("dispatch", payload["dispatch"]["command"])
    self.assertIn("--watch", payload["dispatch"]["command"])
```

- [ ] **Step 2: Add opt-out flag**

In `workerctl/cli.py`, add to `pair`:

```python
pair.add_argument("--no-dispatch", action="store_true", help="Do not ensure Dispatch watch is running for this pair.")
pair.add_argument("--dispatcher-id", default="dispatch-local", help="Dispatcher id used when ensuring Dispatch for the pair.")
```

- [ ] **Step 3: Add pair dispatch payload and start behavior**

In `workerctl/commands.py`, in the pair command path, compute:

```python
ensure_dispatch = not getattr(args, "no_dispatch", False)
dispatch_command = dashboard_dispatch_command(
    workerctl_path=Path("scripts/workerctl"),
    dispatcher_id=args.dispatcher_id,
    task=args.task,
    db_path=db_path,
)
```

Add this to dry-run JSON:

```python
"dispatch": {
    "ensure": ensure_dispatch,
    "command": dispatch_command if ensure_dispatch else None,
}
```

For non-dry-run pair startup, start Dispatch after worker/manager registration and bind success.

- [ ] **Step 4: Update docs**

In `README.md`, replace “run Dispatch in a separate shell” as the primary instruction with:

```markdown
`workerctl pair` ensures a Dispatch watch process by default. For manual dashboard QA, use:

```bash
workerctl dashboard --task <task> --ensure-dispatch --dispatcher-id dispatch-dashboard
```

Use `--no-dispatch` only for isolated debugging.
```

In `skills/manage-codex-workers/SKILL.md`, state:

```markdown
Dispatch is core infrastructure. Pair startup should ensure it is running; if the dashboard shows `not observed`, treat the pair as degraded.
```

- [ ] **Step 5: Run tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.PairCommandTests.test_pair_dry_run_reports_dispatch_watch_by_default -v
python3 -m unittest tests.test_workerctl.CliTests.test_install_local_prints_path_line tests.test_workerctl.CliTests.test_install_local_write_is_idempotent -v
```

Expected:

```text
OK
```

- [ ] **Step 6: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py README.md skills/manage-codex-workers/SKILL.md tests/test_workerctl.py
git commit -m "Ensure dispatch from pair workflow"
```

---

### Task 4: Dashboard Core Dispatch Status Banner

**Files:**
- Test: `dashboard/server/workerctl.test.ts`
- Modify: `dashboard/server/index.ts`
- Modify: `dashboard/client/main.tsx`
- Modify: `dashboard/client/styles.css`

- [ ] **Step 1: Add server test for core status**

Add to `dashboard/server/workerctl.test.ts`:

```ts
test("dispatch health exposes core status labels", () => {
  const missing = dispatchHealth({ telemetry: { recent: [] } }, null);
  assert.equal(missing.core_status, "not_observed");
  assert.match(missing.operator_message, /will not wake managers/);

  const active = dispatchHealth({
    telemetry: {
      recent: [{
        actor: "dispatch",
        event_type: "dispatch_watch_heartbeat",
        timestamp: new Date().toISOString(),
        correlation: { dispatcher_id: "dispatch-live", iteration: 1 },
        attributes: { dry_run: false, processed_count: 0 },
      }],
    },
  }, null);
  assert.equal(active.core_status, "active");
  assert.match(active.operator_message, /routing worker\\/manager events/);
});
```

- [ ] **Step 2: Implement server fields**

In `dashboard/server/index.ts`, extend `dispatchHealth` return:

```ts
const heartbeat = latestDispatchHeartbeat(snapshot, heartbeatTelemetry as TelemetryEvent[]);
const coreStatus = heartbeat.state === "active" ? "active" : heartbeat.state === "stale" ? "stale" : "not_observed";
return {
  core_status: coreStatus,
  operator_message: coreStatus === "active"
    ? "Dispatch is active and routing worker/manager events."
    : coreStatus === "stale"
      ? "Dispatch heartbeat is stale; worker completions may not wake managers."
      : "Dispatch is not observed; worker completions will not wake managers.",
  heartbeat,
  ...
};
```

- [ ] **Step 3: Render prominent banner**

In `dashboard/client/main.tsx`, above the Dispatch chips:

```tsx
<div className="dispatch-core-banner" data-state={health?.core_status || "not_observed"}>
  <strong>Dispatch {health?.core_status || "not observed"}</strong>
  <span>{health?.operator_message}</span>
</div>
```

Update `DispatchHealth` type:

```ts
core_status?: "active" | "not_observed" | "stale";
operator_message?: string;
```

- [ ] **Step 4: Style banner**

In `dashboard/client/styles.css`:

```css
.dispatch-core-banner {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-muted);
}

.dispatch-core-banner[data-state="active"] {
  border-color: #2f855a;
}

.dispatch-core-banner[data-state="stale"],
.dispatch-core-banner[data-state="not_observed"] {
  border-color: #b7791f;
}
```

- [ ] **Step 5: Run dashboard tests/build**

Run:

```bash
npm test -- --runInBand
npm run build
```

Expected:

```text
26+ tests pass
vite build succeeds
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/index.ts dashboard/client/main.tsx dashboard/client/styles.css dashboard/server/workerctl.test.ts
git commit -m "Show dispatch core status in dashboard"
```

---

### Task 5: Dashboard Worker/Manager Conversation Lane

**Files:**
- Test: `dashboard/server/workerctl.test.ts`
- Modify: `dashboard/server/index.ts`
- Modify: `dashboard/client/main.tsx`
- Modify: `dashboard/client/styles.css`

- [ ] **Step 1: Add test for conversation entries**

Add to `dashboard/server/workerctl.test.ts`:

```ts
test("dispatch chains summarize worker manager conversation", () => {
  const chains = dispatchChainEntries({
    command_attempts: [{
      command_id: "cmd-1",
      dispatcher_id: "dispatch-local",
      id: 1,
      side_effect_completed: true,
      side_effect_started: true,
      state: "succeeded",
    }],
    commands: [{
      correlation_id: "corr-1",
      created_at: "2026-05-25T10:00:00Z",
      id: "cmd-1",
      state: "succeeded",
      type: "nudge_worker",
    }],
    correlation_chains: [{
      attempt_ids: [1],
      command_id: "cmd-1",
      command_state: "succeeded",
      command_type: "nudge_worker",
      correlation_id: "corr-1",
      created_at: "2026-05-25T10:00:00Z",
      manager_cycle_id: 44,
      manager_decision_cycle_id: 43,
      manager_decision_id: 12,
      routed_notification_ids: [99],
    }],
    routed_notifications: [{ id: 99, state: "delivered", signal_type: "nudge_worker" }],
  });

  assert.equal(chains[0].conversation.length >= 3, true);
  assert.deepEqual(chains[0].conversation.map((item) => item.kind), [
    "manager_decision",
    "dispatch_attempt",
    "manager_cycle",
  ]);
});
```

- [ ] **Step 2: Implement `conversation` field**

In `dashboard/server/index.ts`, add each chain entry:

```ts
conversation: [
  chain.manager_decision_id ? { kind: "manager_decision", label: `Manager decision #${chain.manager_decision_id}` } : null,
  attempts.length ? { kind: "dispatch_attempt", label: `Dispatch ${attempts[0].state} via ${attempts[0].dispatcher_id || "unknown dispatcher"}` } : null,
  primaryNotification ? { kind: "routed_notification", label: `Routed notification #${primaryNotification.id} ${primaryNotification.state}` } : null,
  chain.manager_cycle_id ? { kind: "manager_cycle", label: `Manager cycle #${chain.manager_cycle_id} consumed the routed fact` } : null,
].filter(Boolean),
```

- [ ] **Step 3: Render conversation lane**

In `dashboard/client/main.tsx`, inside each chain `<li>`:

```tsx
{chain.conversation?.length ? (
  <ol className="dispatch-conversation">
    {chain.conversation.map((item, index) => (
      <li key={`${chain.key}-${index}`} data-kind={item.kind}>{item.label}</li>
    ))}
  </ol>
) : null}
```

Update type:

```ts
conversation?: Array<{ kind: string; label: string }>;
```

- [ ] **Step 4: Style lane**

In `dashboard/client/styles.css`:

```css
.dispatch-conversation {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding-left: 18px;
}

.dispatch-conversation li {
  color: var(--text-muted);
}
```

- [ ] **Step 5: Run dashboard verification**

Run:

```bash
npm test -- --runInBand
npm run build
```

Expected: all dashboard tests and build pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/index.ts dashboard/client/main.tsx dashboard/client/styles.css dashboard/server/workerctl.test.ts
git commit -m "Render dispatch conversation lane"
```

---

### Task 6: Manual QA Readiness Docs

**Files:**
- Modify: `docs/manual-qa-checklist.md`
- Modify: `README.md`

- [ ] **Step 1: Update manual QA command**

In `docs/manual-qa-checklist.md`, change dashboard startup to:

```markdown
- [ ] `scripts/workerctl dashboard --task <task> --ensure-dispatch --dispatcher-id qa-dispatch-dashboard` starts the dashboard and ensures Dispatch watch is running.
```

- [ ] **Step 2: Add visual proof checklist**

Add:

```markdown
- [ ] Dashboard top banner says `Dispatch active` and shows dispatcher id, heartbeat age, iteration, processed count, and dry-run state.
- [ ] Dispatch conversation lane shows worker completion detection, routed notification, manager cycle consumption, manager decision, command claim, command attempt, and command delivery where applicable.
- [ ] Dashboard clearly warns when Dispatch is stale or not observed.
```

- [ ] **Step 3: Run docs/help tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_install_local_prints_path_line tests.test_workerctl.CliTests.test_install_local_write_is_idempotent tests.test_workerctl.CliTests.test_task_scoped_read_commands_are_listed_in_help -v
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add docs/manual-qa-checklist.md README.md
git commit -m "Document dispatch dashboard QA proof"
```

---

### Task 7: Full Verification and PR

**Files:**
- No implementation files unless tests fail.

- [ ] **Step 1: Run full verification**

Run:

```bash
python3 -m unittest tests.test_workerctl -v
npm test -- --runInBand
npm run build
python3 -m py_compile workerctl/*.py
git diff --check
```

Expected:

```text
Python suite passes
Dashboard tests pass
Dashboard build passes
py_compile exits 0
git diff --check exits 0
```

- [ ] **Step 2: Run live smoke of dashboard API**

Run:

```bash
scripts/workerctl dashboard --task dependabot-pr-queue-20260522 --ensure-dispatch --dispatcher-id qa-dispatch-dashboard
curl -sS http://127.0.0.1:8797/api/observation | python3 -m json.tool | sed -n '1,80p'
```

Expected:

```text
dispatch.health.core_status is active or stale after a heartbeat exists
dispatch.health.heartbeat.state is not not_observed after Dispatch has run at least once
```

- [ ] **Step 3: Create PR**

Run:

```bash
git switch -c dispatch-core-dashboard
git push -u origin dispatch-core-dashboard
gh pr create --base main --head dispatch-core-dashboard --title "Make Dispatch core in dashboard workflow" --body "Adds explicit Dispatch ensure-start flow and dashboard visual proof for worker/manager routing."
```

Expected:

```text
PR URL printed
```

---

## Self-Review

**Spec coverage:** This plan covers automatic/core Dispatch startup for pair workflow, explicit dashboard ensure-start, dashboard visual confirmation, worker/manager conversation from durable Dispatch/control-plane rows, docs, and manual QA.

**Intentional non-goal:** Dashboard does not silently start Dispatch by default in this first slice; it starts Dispatch only through explicit `--ensure-dispatch` or a future local-only button. Pair startup does ensure Dispatch by default because that is the core supervised system path.

**Manual QA proof:** The dashboard must show `Dispatch active` plus a routed chain/conversation lane. `not_observed` is treated as degraded, not acceptable.

