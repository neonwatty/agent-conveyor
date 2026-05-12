# Manual-Assignment Redesign — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the legacy supervision and promotion CLI surface that Phases 1-4 superseded. Collapse the legacy reconciliation commands into one DB-centric `reconcile`. Trim `workerctl/tmux.py` down to the PTY + keys + capture primitives the new path needs. Update the README so the new path is the only documented one.

**Architecture:** Phase 5 is mostly *deletion*. The new CLI (`register-worker` / `register-manager` / `bind` / `unbind` / `deregister` / `sessions` / `ingest` / `tail` / `cycle` / `session-nudge` / `session-interrupt` / `divergences`) plus the audit surface (`audit` / `replay` / `events` / `commands` / `mutation-audit` / `export-task`) plus the task primitives (`tasks` / `bind-task` is being retired in favor of `bind`; `finish-task` / `stop-task` stay) becomes the entire supported surface. Legacy tables (`workers`, `managers`, `bindings.worker_id`, `bindings.manager_id`) stay in the schema for historical audit — Phase 5 deletes only the *code* that operated on them, never the *data*.

**Tech Stack:** Python 3, SQLite (WAL), `unittest`, stdlib only. No new third-party deps.

**Scope note:** Phase 5 only. No new features. The new `reconcile` command IS new code, but it replaces three existing commands and only does what those three did plus session-aware checks. Phase 6+ (if ever) can iterate on UX.

---

## Inventory: what gets retired

### CLI commands to delete (~28)

**Promotion + management:**
- `promote` (command_promote in lifecycle.py)
- `self-promote` (command_self_promote)
- `manage` (command_manage)
- `become-managed` (command_become_managed)
- `unmanage` (command_unmanage)
- `my-status` (command_my_status)
- `pause-manager` (command_pause_manager)
- `close-manager` (command_close_manager)
- `resume-manager` (command_resume_manager)
- `remanage` (command_remanage)
- `bind-task` (the legacy worker-only bind; the new `bind` is its session-aware successor)
- `name-session` (legacy worker self-registration helper)
- `start-work` (legacy worker pre-registration)
- `explain-managed-flow` (legacy documentation helper)

**Legacy supervision loop:**
- `supervise` (command_supervise in supervise.py)
- `watch` (command_watch)
- `manager-observe` (command_manager_observe in commands.py)
- `manager-decision` (command_manager_decision)

**Legacy task-scoped variants** (the new path uses `cycle` + `session-nudge` + `session-interrupt`):
- `task-nudge` (command_task_nudge)
- `task-interrupt` (command_task_interrupt)
- `task-idle-check` (command_task_idle_check)
- `task-capture` (command_task_capture)
- `task-events` (command_task_events)
- `task-status` (command_task_status)
- `task-health` (command_task_health)
- `extend-nudge-budget` (command_extend_nudge_budget)

**Reconciliation (will be replaced by ONE new `reconcile`):**
- `reconcile` (legacy command_reconcile — being rewritten in place)
- `recover` (command_recover)
- `close-stale` (command_close_stale)

### CLI commands KEPT (audit/admin/new-path)

`register-worker`, `register-manager`, `deregister`, `sessions`, `bind`, `unbind`, `ingest`, `tail`, `cycle`, `session-nudge`, `session-interrupt`, `divergences`, `tasks`, `events`, `commands`, `audit`, `mutation-audit`, `replay`, `export-task`, `finish-task`, `stop-task`, `list`, `status`, `idle-check`, `nudge`, `interrupt`, `capture`, `stop`, `update-status`, `classify`, `open`, `open-worker`, `open-manager`, `doctor`, `doctor-self`, `db-doctor`, `prune`, `transcript-prune`, `transcript-capture`, `transcript-show`, `import-compat`, `qa-plan`, `create`, `start`, `start-test`.

(Note: `nudge` / `interrupt` / `capture` / `stop` / `idle-check` are legacy worker-name-based but still useful for direct low-level access against backfilled workers. They stay.)

### Modules to delete or trim

- **Delete entirely:** `workerctl/supervise.py` (legacy supervision loop — no remaining callers after the CLI deletions).
- **Trim substantially:** `workerctl/lifecycle.py` (~1692 lines → ~400 lines). Keep only `command_finish_task`, `command_stop_task`, and supporting helpers used by the kept commands.
- **Trim modestly:** `workerctl/commands.py` (~2979 lines). Delete the manager_observe / manager_decision / task_* command functions.
- **Trim modestly:** `workerctl/tmux.py` (~304 lines → ~180 lines). Keep `new-session` spawn (still used by `create`/`start`), `send-keys` / `paste-buffer` / `set-buffer` / `delete-buffer`, `capture-pane`, `has-session`. Remove worker-name-based wrappers (`tmux_target(name)`, `send_text(name)`, `interrupt_worker(name)`) ONLY if no kept commands still use them.

### Schema

**No schema changes.** Legacy tables and columns stay for historical audit. After Phase 5, `workers`, `managers`, `bindings.worker_id`, `bindings.manager_id` become write-frozen (no kept code path writes to them) but readable by `audit` / `replay` / `export-task`.

---

## File Structure (after Phase 5)

**Deleted:**
- `workerctl/supervise.py`
- `docs/worker-first-promotion-plan.md` (historical doc, no longer reflects reality)

**Major trims:**
- `workerctl/lifecycle.py` — keep finish-task / stop-task + helpers
- `workerctl/cli.py` — remove ~28 subparser blocks
- `workerctl/commands.py` — remove ~10 command_* functions
- `workerctl/tmux.py` — remove worker-name wrappers if no callers
- `tests/test_workerctl.py` — large CliTests class trimmed (delete tests for retired commands)
- `README.md` — replace legacy MVP section with new-path docs

**New (one):**
- A rewritten `command_reconcile(args)` that does schema check + gone-session detection + dangling-binding detection + stuck-task detection. Replaces the old reconcile/recover/close-stale trio.

---

## Task 1: Inventory and pin the retirement list

**Files:**
- Create: `docs/manual-assignment-phase-5-retirement-list.md` (a checklist artifact; helps the next 6 tasks stay on-track).

This task does NOT delete code. It writes down the exact CLI commands, command_* function names, file:line locations, and test class names that subsequent tasks will remove. The artifact is checked into the repo so reviewers can see the contract before the deletions begin.

- [ ] **Step 1: Generate the retirement list**

Create `docs/manual-assignment-phase-5-retirement-list.md` with this skeleton (fill in the actual file:line locations using `grep -n` against the current branch):

```markdown
# Phase 5 Retirement List

Generated at start of Phase 5. Lists every CLI subcommand, command function,
helper, and test class that will be deleted across Tasks 2-6 of Phase 5.

## CLI subcommands (workerctl/cli.py)

[List each retired subparser block with its line number, e.g.:]
- `promote` → workerctl/cli.py:NNN
- `self-promote` → workerctl/cli.py:NNN
... (28 entries)

## Command functions

[List each command_* function being deleted, with file:line:]
- `command_promote` → workerctl/lifecycle.py:211
- `command_supervise` → workerctl/supervise.py:131
... (matches the retirement list above)

## Test classes / test methods to delete

[Run `grep -nE "^class .*Tests" tests/test_workerctl.py` and identify which
classes test retired commands.]
- Tests for promote/manage/become-managed/etc. (likely scattered across CliTests)
- Tests for supervise/watch
- Tests for manager-observe / manager-decision / task-*
- Tests for reconcile/recover/close-stale (existing — will be replaced with new tests)

## Tmux helpers to delete (only if no remaining callers after Task 2+3)

- `send_text(name, text)` → workerctl/tmux.py:NNN  (legacy worker-name-keyed; check callers post-deletion)
- `interrupt_worker(name, ...)` → workerctl/tmux.py:NNN  (same)
- `tmux_target(name)` → workerctl/tmux.py:NNN  (the legacy `codex-{name}` builder)
```

- [ ] **Step 2: Commit the retirement list**

```bash
git add docs/manual-assignment-phase-5-retirement-list.md
git commit -m "Phase 5: inventory legacy CLI surface for retirement"
```

This artifact is referenced by subsequent tasks. It does not have to be exhaustively complete — the per-task instructions below also specify exactly what to delete — but it's a useful pre-flight check.

---

## Task 2: Retire promotion + management commands

**Files:**
- Modify: `workerctl/cli.py` — remove subparser blocks for `promote`, `self-promote`, `manage`, `become-managed`, `unmanage`, `my-status`, `pause-manager`, `close-manager`, `resume-manager`, `remanage`, `bind-task`, `name-session`, `start-work`, `explain-managed-flow`.
- Modify: `workerctl/commands.py` — remove `command_name_session`, `command_explain_managed_flow`, `command_bind_task`.
- Modify: `workerctl/lifecycle.py` — remove `command_promote`, `command_self_promote`, `command_manage`, `command_become_managed`, `command_unmanage`, `command_my_status`, `command_pause_manager`, `command_close_manager`, `command_resume_manager`, `command_remanage`, `command_start_work` and their helpers.
- Modify: `tests/test_workerctl.py` — delete or skip tests that exercise the removed commands.

**Note: this task does NOT touch `supervise` / `watch` / `manager-*` / `task-*` / `reconcile` / `recover` / `close-stale`. Those land in Tasks 3 and 4.**

- [ ] **Step 1: Map out the dependency chain before deleting**

```bash
# Find every reference to retired functions across the codebase.
for name in command_promote command_self_promote command_manage command_become_managed \
            command_unmanage command_my_status command_pause_manager command_close_manager \
            command_resume_manager command_remanage command_start_work \
            command_name_session command_explain_managed_flow command_bind_task; do
  echo "=== $name ==="
  grep -rn "$name" workerctl/ tests/ 2>/dev/null
done
```

Read the output. Note any HELPER functions (non-`command_` prefixed) that are used ONLY by the retired commands — those become orphaned and can be deleted too (Task 6 will sweep orphans; for now, just identify them).

- [ ] **Step 2: Remove the subparser blocks from `workerctl/cli.py`**

Open `workerctl/cli.py` and locate each subparser block. Each block looks roughly like:

```python
    promote = subparsers.add_parser("promote", help="...")
    promote.add_argument(...)
    ...
    promote.set_defaults(func=command_promote)
```

Delete the block for each of: `promote`, `self-promote`, `manage`, `become-managed`, `unmanage`, `my-status`, `pause-manager`, `close-manager`, `resume-manager`, `remanage`, `bind-task`, `name-session`, `start-work`, `explain-managed-flow`.

Also remove these names from the `from workerctl.commands import (...)` and `from workerctl.lifecycle import (...)` import blocks at the top of `cli.py`.

- [ ] **Step 3: Delete the corresponding command functions**

In `workerctl/lifecycle.py`, locate and delete:
- `def command_promote(args)` (and its body)
- `def command_self_promote(args)`
- `def command_manage(args)`
- `def command_become_managed(args)`
- `def command_unmanage(args)`
- `def command_my_status(args)`
- `def command_pause_manager(args)`
- `def command_close_manager(args)`
- `def command_resume_manager(args)`
- `def command_remanage(args)`
- `def command_start_work(args)` (if it lives here)

In `workerctl/commands.py`, locate and delete:
- `def command_name_session(args)`
- `def command_explain_managed_flow(args)`
- `def command_bind_task(args)`

Use `grep -n "^def command_" workerctl/lifecycle.py` and the same for `commands.py` to find exact line numbers.

- [ ] **Step 4: Identify orphan helpers**

After deleting the command_* functions, some private helpers may become unused. Search for likely orphans:

```bash
# In lifecycle.py, find helpers whose name doesn't start with `command_` and grep for callers.
grep -nE "^def [a-z_]+" workerctl/lifecycle.py | while read -r line; do
  fn=$(echo "$line" | sed -E 's/^.*:def ([a-z_]+).*/\1/')
  if [[ "$fn" != command_* ]]; then
    count=$(grep -c "$fn" workerctl/*.py tests/*.py 2>/dev/null | awk -F: '{s+=$2} END {print s}')
    echo "$fn: $count references"
  fi
done
```

Delete helpers with zero references after the command_* deletions. Helpers with 1 self-reference (the definition itself) are also orphans.

**Defer to Task 6 if uncertain:** Task 6 does a final orphan sweep. For Task 2, only delete obvious orphans (e.g., a helper named `_build_promotion_prompt` that was only called by `command_promote`).

- [ ] **Step 5: Delete or skip tests that exercise the removed commands**

In `tests/test_workerctl.py`, find tests that subprocess-invoke or import the retired commands:

```bash
grep -nE "(\"promote\"|\"manage\"|\"become-managed\"|\"unmanage\"|\"my-status\"|\"pause-manager\"|\"close-manager\"|\"resume-manager\"|\"remanage\"|\"bind-task\"|\"name-session\"|\"start-work\"|\"explain-managed-flow\")" tests/test_workerctl.py | head -30
```

For each matching test method (or whole test class if every method retires), delete the method. Do NOT just skip with `@unittest.skip(...)` — the goal is removal.

CAVEAT: Some tests may use the legacy command path to set up state for testing OTHER things (e.g., a test of `command_audit` that uses `promote` to create a managed task first). In those cases, migrate the setup to use the new path (`register-worker` + `register-manager` + `bind`) instead of deleting the test outright.

- [ ] **Step 6: Verify the test suite passes**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -10
```

Expected: a smaller test count (the suite has ~276 tests post-Phase 4; Phase 5 Task 2 will likely drop 30-80 tests). All remaining tests must pass.

If a test fails that does NOT mention the retired commands by name, you've likely deleted a helper that the kept commands also used. Restore the helper and re-run.

- [ ] **Step 7: Verify the CLI surface**

```bash
python3 -m workerctl --help 2>&1 | head -60
```

None of the retired command names should appear. The kept commands (especially `register-worker`, `register-manager`, `bind`, `cycle`) should still be present.

- [ ] **Step 8: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py workerctl/lifecycle.py tests/test_workerctl.py
git commit -m "Phase 5 Task 2: retire promotion and management CLI commands"
```

Note the explicit "Task 2" in the commit message — this is the largest deletion task and merits a marker for bisection.

---

## Task 3: Retire legacy supervision and task-scoped commands

**Files:**
- Modify: `workerctl/cli.py` — remove subparser blocks for `supervise`, `watch`, `manager-observe`, `manager-decision`, `task-nudge`, `task-interrupt`, `task-idle-check`, `task-capture`, `task-events`, `task-status`, `task-health`, `extend-nudge-budget`.
- Delete: `workerctl/supervise.py` entirely.
- Modify: `workerctl/commands.py` — remove `command_manager_observe`, `command_manager_decision`, `command_task_*` functions, `command_extend_nudge_budget`.
- Modify: `tests/test_workerctl.py` — delete tests that exercise the removed commands.

- [ ] **Step 1: Identify command function locations**

```bash
grep -nE "^def command_(manager_observe|manager_decision|task_nudge|task_interrupt|task_idle_check|task_capture|task_events|task_status|task_health|extend_nudge_budget|supervise|watch)" workerctl/*.py
```

- [ ] **Step 2: Remove subparser blocks from `cli.py`**

Same pattern as Task 2. Locate each of the listed subparser blocks and delete them. Remove the names from the import blocks at the top of `cli.py`.

- [ ] **Step 3: Delete `workerctl/supervise.py` entirely**

```bash
git rm workerctl/supervise.py
```

Before deleting, search for imports of `workerctl.supervise` in other modules:

```bash
grep -rn "from workerctl import supervise\|from workerctl.supervise\|workerctl.supervise" workerctl/ tests/
```

Tests in `tests/test_workerctl.py` may import it. Either delete those tests (preferred) or migrate them to test the new `cycle` path. Most legacy supervise tests should fall away naturally.

- [ ] **Step 4: Delete the command functions from `commands.py`**

Locate and delete:
- `def command_manager_observe(args)`
- `def command_manager_decision(args)`
- `def command_task_nudge(args)`
- `def command_task_interrupt(args)`
- `def command_task_idle_check(args)`
- `def command_task_capture(args)`
- `def command_task_events(args)`
- `def command_task_status(args)`
- `def command_task_health(args)`
- `def command_extend_nudge_budget(args)`

- [ ] **Step 5: Identify orphan helpers**

Same approach as Task 2. Likely orphans:
- Helpers in `commands.py` named with `_observe` / `_decision` / `_task_` prefixes that are no longer referenced.
- Database helpers in `db.py` named for legacy task-scoped operations (e.g., `record_manager_decision` may have multiple callers — check before deleting; only delete if no kept command uses it).

Defer ambiguous orphans to Task 6.

- [ ] **Step 6: Delete or skip tests**

Find tests using retired command names:

```bash
grep -nE "(\"supervise\"|\"watch\"|\"manager-observe\"|\"manager-decision\"|\"task-nudge\"|\"task-interrupt\"|\"task-idle-check\"|\"task-capture\"|\"task-events\"|\"task-status\"|\"task-health\"|\"extend-nudge-budget\")" tests/test_workerctl.py
```

Delete the tests. Same caveat as Task 2: if a test uses these to set up state for testing something kept, migrate the setup to use the new path.

- [ ] **Step 7: Verify**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -10
python3 -m workerctl --help 2>&1 | grep -E "supervise|watch|manager-observe|manager-decision|task-nudge"
```

Expected: tests pass; no retired commands in help output.

- [ ] **Step 8: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py workerctl/supervise.py tests/test_workerctl.py
git commit -m "Phase 5 Task 3: retire legacy supervise/watch and task-scoped commands"
```

---

## Task 4: Collapse reconcile + recover + close-stale into a new `reconcile`

**Files:**
- Modify: `workerctl/lifecycle.py` — delete `command_reconcile`, `command_recover`, `command_close_stale`.
- Modify: `workerctl/commands.py` — add new `command_reconcile(args)`.
- Modify: `workerctl/cli.py` — remove `recover` and `close-stale` subparsers; rewrite `reconcile` subparser to point at the new command and add `--apply` flag.
- Modify: `tests/test_workerctl.py` — delete tests for retired versions; add tests for the new `reconcile`.

The new `reconcile`:
1. Schema health check (parallels existing `db-doctor` output).
2. Reports sessions with `state='active'` whose `pid` is not alive.
3. Reports active bindings whose `worker_session_id` or `manager_session_id` references a session with `state='gone'`.
4. Reports tasks with active bindings whose most recent `manager_cycles` row is older than 1 hour (configurable via `--stale-cycles-seconds`).
5. With `--apply`: marks gone-pid sessions `state='gone'`; marks dangling bindings `state='invalid'` with an audit event; does NOT auto-close tasks.

- [ ] **Step 1: Write failing tests for the new `reconcile`**

Append to `tests/test_workerctl.py` a new test class `ReconcileTests`:

```python
class ReconcileTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_reconcile_reports_dead_pid_session(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Register a session with a definitely-dead pid (2^31 - 1 is reserved on macOS).
            worker_db.register_session(
                conn, name="dead", role="worker",
                codex_session_path="/a", codex_session_id="u",
                pid=2147483646, cwd="/repo",
                tmux_session="codex-dead",
            )
            conn.commit()

            report = worker_commands.collect_reconcile_report(conn)
            dead_pid_sessions = [
                s for s in report["dead_pid_sessions"]
                if s["name"] == "dead"
            ]
            self.assertEqual(len(dead_pid_sessions), 1)
            self.assertEqual(dead_pid_sessions[0]["pid"], 2147483646)

    def test_reconcile_reports_dangling_binding(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t", worker_session_name="w", manager_session_name="m",
            )
            # Mark the worker session gone — the binding now dangles.
            conn.execute("update sessions set state='gone' where name='w'")
            conn.commit()

            report = worker_commands.collect_reconcile_report(conn)
            dangling = [
                b for b in report["dangling_bindings"]
                if b["task_name"] == "t"
            ]
            self.assertEqual(len(dangling), 1)
            self.assertIn("worker", dangling[0]["gone_role"])

    def test_reconcile_apply_marks_gone_pid_session_gone(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="dead", role="worker",
                codex_session_path="/a", codex_session_id="u",
                pid=2147483646, cwd="/repo",
            )
            conn.commit()

            worker_commands.apply_reconcile(conn)

            row = conn.execute(
                "select state from sessions where name='dead'"
            ).fetchone()
            self.assertEqual(row["state"], "gone")

    def test_reconcile_apply_marks_dangling_binding_invalid(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            binding_id = worker_db.bind_sessions(
                conn, task_name="t", worker_session_name="w", manager_session_name="m",
            )
            conn.execute("update sessions set state='gone' where name='w'")
            conn.commit()

            worker_commands.apply_reconcile(conn)

            row = conn.execute(
                "select state from bindings where id = ?", (binding_id,)
            ).fetchone()
            self.assertEqual(row["state"], "invalid")

    def test_reconcile_cli_dry_run_does_not_mutate(self):
        # CLI smoke test — dry-run (no --apply) should print a JSON report and
        # leave sessions/bindings untouched.
        env = os.environ.copy()
        with tempfile.TemporaryDirectory() as tmpdir:
            env["WORKERCTL_STATE_ROOT"] = tmpdir
            # Register a dead-pid session via the CLI for realism.
            subprocess.run(
                [sys.executable, "-m", "workerctl", "register-worker",
                 "--name", "dead", "--pid", "2147483646",
                 "--codex-session", "/does/not/matter.jsonl",
                 "--cwd", str(ROOT)],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            # The register-worker call will fail because the rollout path doesn't exist
            # — that's expected. Adapt the test to use a fixture rollout instead.

            # Build a fixture rollout for the registration to succeed.
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(
                json.dumps({"type": "session_meta",
                            "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"}})
                + "\n"
            )
            subprocess.run(
                [sys.executable, "-m", "workerctl", "register-worker",
                 "--name", "dead", "--pid", "2147483646",
                 "--codex-session", str(rollout),
                 "--cwd", str(ROOT)],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "reconcile"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            self.assertIn("dead_pid_sessions", report)
            # The dead session should appear in the report.
            self.assertTrue(any(s["name"] == "dead" for s in report["dead_pid_sessions"]))

            # Dry-run must NOT have marked the session gone.
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            row = conn.execute("select state from sessions where name='dead'").fetchone()
            self.assertEqual(row["state"], "active")
```

(Note: the CLI test as drafted has scaffolding for fixture-building inline. Clean it up to match the existing test patterns in the file.)

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.ReconcileTests -v
```

Expected: 5 tests FAIL with `AttributeError: module 'workerctl.commands' has no attribute 'collect_reconcile_report'`.

- [ ] **Step 3: Delete the legacy reconcile/recover/close-stale**

In `workerctl/lifecycle.py`:
- Delete `command_reconcile`, `command_recover`, `command_close_stale` and any helpers used only by them.

In `workerctl/cli.py`:
- Remove the `recover` and `close-stale` subparser blocks.
- Remove `command_recover` and `command_close_stale` from the import block at the top.
- Leave the `reconcile` subparser in place for now — Step 4 will rewrite it.

- [ ] **Step 4: Implement the new `command_reconcile` in `workerctl/commands.py`**

Append to `workerctl/commands.py`:

```python
def _pid_is_alive(pid: int) -> bool:
    """Return True if the given pid is alive. Uses os.kill(pid, 0) — does not
    actually signal. Returns False on PermissionError too (process exists but
    isn't ours; treat as "not ours to reconcile" → leave alone)."""
    import os
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but belongs to another user. Treat as "not our problem."
        return True
    return True


def collect_reconcile_report(conn: "sqlite3.Connection") -> dict:
    """Build a reconciliation report without mutating state.

    Returns a dict with keys:
      - `schema_health`: output of database_health
      - `dead_pid_sessions`: [{name, role, pid, last_heartbeat_at}, ...]
      - `dangling_bindings`: [{binding_id, task_name, gone_role, gone_session_name}, ...]
      - `stuck_tasks`: [{task_name, binding_id, last_cycle_at, age_seconds}, ...]
    """
    from workerctl import db as worker_db
    from workerctl.core import now_iso

    schema = worker_db.database_health(conn)

    dead_pid_sessions = []
    for row in conn.execute(
        "select name, role, pid, last_heartbeat_at from sessions "
        "where state = 'active' and pid is not null"
    ):
        if not _pid_is_alive(int(row["pid"])):
            dead_pid_sessions.append({
                "name": row["name"],
                "role": row["role"],
                "pid": int(row["pid"]),
                "last_heartbeat_at": row["last_heartbeat_at"],
            })

    dangling_bindings = []
    for row in conn.execute(
        """
        select
          b.id as binding_id, t.name as task_name,
          ws.state as worker_state, ws.name as worker_name,
          ms.state as manager_state, ms.name as manager_name
        from bindings b
        join tasks t on t.id = b.task_id
        left join sessions ws on ws.id = b.worker_session_id
        left join sessions ms on ms.id = b.manager_session_id
        where b.state in ('active', 'ending')
          and b.worker_session_id is not null
        """
    ):
        if row["worker_state"] == "gone":
            dangling_bindings.append({
                "binding_id": row["binding_id"],
                "task_name": row["task_name"],
                "gone_role": "worker",
                "gone_session_name": row["worker_name"],
            })
        if row["manager_state"] == "gone":
            dangling_bindings.append({
                "binding_id": row["binding_id"],
                "task_name": row["task_name"],
                "gone_role": "manager",
                "gone_session_name": row["manager_name"],
            })

    # Stuck tasks: active bindings whose newest manager_cycles row is too old.
    # Skip tasks with no cycles yet — they may just be freshly bound.
    stuck_tasks = []
    for row in conn.execute(
        """
        select t.name as task_name, b.id as binding_id,
               max(mc.completed_at) as last_cycle_at
        from bindings b
        join tasks t on t.id = b.task_id
        left join manager_cycles mc on mc.task_id = b.task_id
        where b.state in ('active', 'ending')
        group by b.id
        having last_cycle_at is not null
        """
    ):
        from datetime import datetime, timezone
        last_dt = datetime.fromisoformat(
            row["last_cycle_at"].rstrip("Z") + "+00:00"
        )
        age = (datetime.now(timezone.utc) - last_dt).total_seconds()
        if age > 3600:  # 1 hour default
            stuck_tasks.append({
                "task_name": row["task_name"],
                "binding_id": row["binding_id"],
                "last_cycle_at": row["last_cycle_at"],
                "age_seconds": age,
            })

    return {
        "schema_health": schema,
        "dead_pid_sessions": dead_pid_sessions,
        "dangling_bindings": dangling_bindings,
        "stuck_tasks": stuck_tasks,
    }


def apply_reconcile(conn: "sqlite3.Connection") -> dict:
    """Apply the reconcile changes: mark gone-pid sessions gone, mark dangling
    bindings invalid. Returns the report dict with an additional `applied` key
    listing what was changed.

    Stuck tasks are reported but never auto-closed.
    """
    from workerctl import db as worker_db
    from workerctl.core import now_iso

    report = collect_reconcile_report(conn)
    now = now_iso()
    applied = {"sessions_marked_gone": [], "bindings_marked_invalid": []}

    for s in report["dead_pid_sessions"]:
        # Use deregister_session if available — but it raises on active bindings.
        # Apply path: mark gone directly, then mark any bindings as dangling.
        conn.execute(
            "update sessions set state='gone', last_heartbeat_at=? where name=?",
            (now, s["name"]),
        )
        applied["sessions_marked_gone"].append(s["name"])
        worker_db.insert_event(
            conn, "session_marked_gone_by_reconcile", actor="workerctl",
            payload={"name": s["name"], "pid": s["pid"], "reason": "pid not alive"},
        )

    # Re-collect dangling after the session updates above.
    report_post = collect_reconcile_report(conn)
    for b in report_post["dangling_bindings"]:
        conn.execute(
            "update bindings set state='invalid', ended_at=? where id=?",
            (now, b["binding_id"]),
        )
        applied["bindings_marked_invalid"].append(b["binding_id"])
        worker_db.insert_event(
            conn, "binding_marked_invalid_by_reconcile", actor="workerctl",
            payload={
                "binding_id": b["binding_id"],
                "task_name": b["task_name"],
                "gone_role": b["gone_role"],
                "gone_session_name": b["gone_session_name"],
            },
        )

    conn.commit()
    report["applied"] = applied
    return report


def command_reconcile(args: argparse.Namespace) -> int:
    """Reconcile DB state with reality. Without --apply: report only. With --apply:
    mark dead-pid sessions gone, mark bindings to gone sessions invalid. Stuck tasks
    are reported but never auto-closed (operators decide).
    """
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        if args.apply:
            report = apply_reconcile(conn)
        else:
            report = collect_reconcile_report(conn)
    finally:
        conn.close()
    print(json.dumps(report, indent=2, sort_keys=True, default=str))
    return 0
```

- [ ] **Step 5: Rewrite the `reconcile` subparser in `cli.py`**

Find the `reconcile` subparser block and replace it with:

```python
    reconcile = subparsers.add_parser(
        "reconcile",
        help="Report (and optionally apply) reconciliation actions: dead-pid sessions, "
             "dangling bindings, stuck tasks. Output is a JSON report.",
    )
    reconcile.add_argument("--apply", action="store_true",
                          help="Apply changes (mark gone-pid sessions gone, mark dangling bindings invalid).")
    reconcile.set_defaults(func=command_reconcile)
```

Add `command_reconcile` to the import block in `cli.py`.

- [ ] **Step 6: Verify tests pass**

```bash
python3 -m unittest tests.test_workerctl.ReconcileTests -v
python3 -m unittest tests.test_workerctl 2>&1 | tail -5
```

Expected: all `ReconcileTests` pass; full suite passes (with fewer tests overall due to Phase 5 Tasks 2-3 deletions).

- [ ] **Step 7: Commit**

```bash
git add workerctl/cli.py workerctl/commands.py workerctl/lifecycle.py tests/test_workerctl.py
git commit -m "Phase 5 Task 4: collapse reconcile/recover/close-stale into one DB-centric reconcile"
```

---

## Task 5: Trim `workerctl/tmux.py`

**Files:**
- Modify: `workerctl/tmux.py` — remove worker-name-keyed wrappers if no callers remain after Tasks 2-4.
- Verify: no test or kept command depends on the removed helpers.

The Phase 1-4 new path uses these tmux primitives:
- `run([...tmux...])` — base subprocess invocation (KEEP)
- `tmux_session(name)` — `f"codex-{name}"` builder (KEEP only if any kept command still uses; otherwise delete)
- `tmux_target(name)` — wraps `tmux_session` for `send-keys -t` targets (KEEP only if a callers remain)
- `current_pane_id(session)` — used by `create`/`start` for new sessions (KEEP)
- `session_exists(name)` — KEEP (used by `create`, by reconcile)
- `capture_tmux_target(target, lines)` — KEEP (used by Phase 4 shadow signal)
- `capture_output(name, lines)` — wrapper around the above; KEEP only if `capture` command still uses it (it likely does)
- `interrupt_worker(name, key, followup, dry_run)` — KEEP only if `interrupt` command still uses (it does)
- `send_text(name, text)` — KEEP only if `nudge` command still uses (it does)
- `wait_for_ready(name, timeout)` — used by `create --wait-ready`; KEEP
- `session_tmux_target(row)` (Phase 3 new) — KEEP
- `send_text_to_session(conn, session_name, text, dry_run)` (Phase 3 new) — KEEP
- `interrupt_session(conn, session_name, key, followup, dry_run)` (Phase 3 new) — KEEP
- `_tmux_session_running(tmux_session)` (Phase 3 new) — KEEP

After Phase 5 Tasks 2-4, most of these likely still have callers from the *kept* worker-name-based commands (`nudge`, `interrupt`, `capture`, `stop`, `create`, `start`). Phase 5 Task 5 is therefore a small task — the tmux module may not shrink much at all.

- [ ] **Step 1: Reference scan**

For each function in `workerctl/tmux.py`, find external callers:

```bash
grep -nE "^def " workerctl/tmux.py | while read -r line; do
  fn=$(echo "$line" | sed -E 's/^.*:def ([a-z_]+).*/\1/')
  count=$(grep -c "worker_tmux\.${fn}\|tmux\.${fn}" workerctl/*.py tests/*.py 2>/dev/null | awk -F: '{s+=$2} END {print s}')
  echo "$fn: $count external references"
done
```

Identify functions with zero external references. These are candidates for deletion.

- [ ] **Step 2: Delete unreferenced helpers**

Delete the identified functions. Be conservative: if a function has 1 reference and that reference is inside a test, decide whether to keep the function (the test exercises it) or delete the test too.

DO NOT delete:
- Anything still called by kept commands (verify before deleting).
- `_tmux_session_running` (Phase 3 — convert FileNotFoundError to WorkerError; still used).
- Constants like `SUBMIT_KEY`, `PASTE_SUBMIT_DELAY_SECONDS`, `DEFAULT_HISTORY_LINES`.

- [ ] **Step 3: Verify tests pass**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -5
```

If a test fails, restore the helper it depended on and re-evaluate.

- [ ] **Step 4: Commit (only if anything was deleted)**

```bash
git add workerctl/tmux.py
git commit -m "Phase 5 Task 5: trim unused worker-name-keyed tmux helpers"
```

If no helpers were deleted (all still have callers), skip this commit and note in the report that the tmux module is already minimal after Phases 1-4.

---

## Task 6: Final orphan sweep across `lifecycle.py` and `commands.py`

**Files:**
- Modify: `workerctl/lifecycle.py`, `workerctl/commands.py`, `workerctl/db.py` — delete any helper functions whose only references were in the now-deleted command functions.

- [ ] **Step 1: Identify helpers with zero callers**

```bash
for mod in workerctl/lifecycle.py workerctl/commands.py workerctl/db.py; do
  echo "=== $mod ==="
  grep -nE "^def [a-z_]" "$mod" | while read -r line; do
    fn=$(echo "$line" | sed -E 's/^.*:def ([a-z_]+).*/\1/')
    if [[ "$fn" == _* ]] || [[ "$fn" != command_* ]]; then
      # Skip private helpers and command_* functions for this sweep.
      # Focus on non-private non-command public helpers.
      count=$(grep -c "\\b${fn}\\b" workerctl/*.py tests/*.py 2>/dev/null | awk -F: '{s+=$2} END {print s}')
      if [ "$count" -le 1 ]; then
        echo "ORPHAN CANDIDATE: $line ($count references)"
      fi
    fi
  done
done
```

This is approximate — the grep can hit comments or unrelated strings. Treat output as a candidate list, not a hit list. For each candidate, manually verify by reading the file.

- [ ] **Step 2: Delete confirmed orphans**

For each helper confirmed to have no callers (other than its own definition), delete it.

- [ ] **Step 3: Verify**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -5
python3 -m workerctl --help 2>&1 | head -5
```

- [ ] **Step 4: Commit**

```bash
git add workerctl/lifecycle.py workerctl/commands.py workerctl/db.py
git commit -m "Phase 5 Task 6: sweep orphan helpers left by retired commands"
```

---

## Task 7: README rewrite

**Files:**
- Modify: `README.md` — restructure so the new path is the primary documented flow.

The current README has a substantial "Current MVP Usage" section that documents `promote`, `manage`, `supervise`, etc. — all retired. The Phase 1-4 subsections inside "Manual-Assignment Primitives" are now the primary docs and should be promoted out of the subsection nesting.

- [ ] **Step 1: Identify retired sections**

Sections that need rewriting or deletion:
- "Current MVP Usage" — heavily references retired commands.
- "SQLite Worker-Manager Lifecycle" — describes the legacy lifecycle.
- The "Manual-Assignment Primitives (Phase 1)" wrapper heading should likely be renamed or hoisted (its sub-sections Phase 1/2/3/4 ARE the primary docs now).

Sections to keep:
- Initial overview / what this is.
- Doctor / setup steps.
- The Phase 1/2/3/4 sub-sections (probably without the "Phase N:" prefix in headings — those are historical and can move to a CHANGELOG or commit history).

- [ ] **Step 2: Draft the new README structure**

Suggested top-level structure:

```markdown
# Codex Terminal Manager

[Brief intro — what this is, who it's for]

## Quickstart

[Install + first registration + first cycle]

## Concepts

[Sessions / bindings / cycles / shadow signal]

## Commands

### Registration
- register-worker
- register-manager
- deregister
- sessions

### Tasks + binding
- tasks --create
- bind / unbind
- finish-task / stop-task

### Observation
- cycle
- tail / ingest
- divergences
- audit / replay / events / mutation-audit / export-task

### Actuation
- session-nudge
- session-interrupt

### Administration
- doctor / db-doctor
- reconcile

## Manager Loop Pattern

[How a manager Codex drives supervision via repeated cycle invocations]

## Migration from Legacy Path

[One paragraph: legacy promote/manage/supervise commands were retired in
Phase 5. Existing legacy DB rows (workers, managers, bindings.worker_id)
remain readable via `audit` and `replay` but can't be acted on by the
new commands. To resume an old task, finish-task it, then bind a new
session pair via the new path.]
```

Adapt to the existing README's tone and length. Keep technical content from Phase 1-4 subsections — just relocate.

- [ ] **Step 3: Apply the rewrite**

Write the new README. The Phase 1-4 example commands and explanations should mostly survive — they just live under different headings.

- [ ] **Step 4: Verify every command in the new README still exists**

```bash
# For each `workerctl X` mentioned in README, confirm `workerctl X --help` works.
grep -oE "workerctl [a-z-]+" README.md | sort -u | while read -r cmd; do
  echo "=== $cmd ==="
  python3 -m $cmd --help 2>&1 | head -1
done
```

- [ ] **Step 5: Delete `docs/worker-first-promotion-plan.md`**

This historical planning doc describes the legacy promotion flow, which is now retired. Remove it:

```bash
git rm docs/worker-first-promotion-plan.md
```

Keep `docs/prototype-plan.md` for now if it has historical value, or remove it too. Use judgment.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/
git commit -m "Phase 5 Task 7: rewrite README around the new path; retire legacy docs"
```

---

## Self-Review

**Spec coverage:**
- Retirement list documented → Task 1 ✓
- Promotion/management commands removed → Task 2 ✓
- Legacy supervision + task-scoped commands removed → Task 3 ✓
- Reconcile commands collapsed → Task 4 ✓
- Tmux trim (best-effort given Phase 1-4 already use most primitives) → Task 5 ✓
- Orphan helpers swept → Task 6 ✓
- README rewrite → Task 7 ✓

**Placeholder scan:** no TBDs; the deletion-driven tasks are necessarily less mechanical than the addition phases (the implementer has to make judgment calls about orphan helpers and test migrations), but the criteria for each judgment call are spelled out.

**Type consistency:** The new `command_reconcile` produces JSON output; tests assert on `report["dead_pid_sessions"]`, `report["dangling_bindings"]`, `report["stuck_tasks"]`, `report["applied"]` (on apply path). Helper functions `collect_reconcile_report` and `apply_reconcile` return `dict`; tests import them directly to bypass CLI scaffolding.

**No schema migration.** Phase 5 deletes only code. Legacy tables and columns remain for audit history readability.

**Known caveats:**
- Task 2's "delete orphan helpers" instruction is intentionally conservative; Task 6 does a second-pass sweep.
- Task 4's stuck-task threshold (`age > 3600` seconds) is hardcoded; future Phase 6+ could make it configurable. For Phase 5, hardcoded is fine.
- Task 4 uses `os.kill(pid, 0)` which works on POSIX. Windows is out of scope (the README is already Mac-first).
- Task 5 may produce a tiny or empty diff. If `workerctl/tmux.py` doesn't shrink, that's expected — Phase 1-4 already shifted heavy lifting onto helpers Phase 5 cannot delete.
- The expected test count is hard to predict. Phase 4 ended at 276 tests. Phase 5 will delete many legacy-command tests and add ~5 new reconcile tests. Expected end-state: somewhere between 180 and 240 tests, all passing. Don't fail a task if the count differs from a specific prediction.

---

## Migration story for the live DB

After Phase 5 lands, the user's `.codex-workers/workerctl.db` contains historical legacy data:
- 44+ workers, 64+ managers, 44+ bindings with `worker_id`/`manager_id` set, tasks, manager_cycles from legacy paths.
- All readable via `audit`, `replay`, `events`, `mutation-audit`, `export-task`.
- None actable via the new CLI surface (the new CLI looks only at sessions / session-id bindings / codex_events).

Any active legacy task at the time of Phase 5 merge can be wound down by:
1. `workerctl finish-task <task>` to mark it complete (this command stays).
2. Or just leave it as historical state.

To start a new task, use the Phase 1-4 path: `register-worker` + `register-manager` + `tasks --create` + `bind` + manager-Codex-driven `cycle` loop.

---

## Out of Scope (for any future Phase 6+)

- Adding spawn-and-register ergonomics like `start-worker --name N --cwd D` that creates a tmux session, starts codex, and registers as a worker in one call. Currently `register-worker` requires the user to start codex first.
- Dropping legacy tables (`workers`, `managers`, `bindings.worker_id`, `bindings.manager_id`). The data is small and serves historical audit; deletion can wait until there's a concrete reason.
- A continuous supervision daemon (the Phase 3 architecture decision: manager Codex drives the loop, no Python daemon).
- Configurable thresholds (`stale_cycles_seconds`, etc.) on the new `reconcile`.
