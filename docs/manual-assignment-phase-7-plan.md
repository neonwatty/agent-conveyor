# Phase 7 Implementation Plan — Polish from Phase 6 Exploratory Testing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Act on the top three friction points surfaced during Phase 6 exploratory testing. Small additive changes, no schema migration.

**Architecture:** Three targeted improvements, each in an existing module. No new files.

**Tech Stack:** Python 3, SQLite (WAL), stdlib only.

**Scope note:** Phase 7 only. Out of scope: cycle `--compact` JSON output (low impact), re-register warning on codex_session_id change (low impact), replay summary enrichment beyond what Phase 4 already added.

---

## Findings being addressed

1. **`workerctl sessions` is dominated by legacy noise.** 108 of 112 active sessions in the live DB have `pid IS NULL` (Phase 1 backfill from legacy workers/managers). The user can't see their current registrations without parsing. Default to filtering them out; add `--include-legacy` to opt back in.

2. **Cycle on a dead worker reports `state=idle` with no explicit "worker dead" signal.** A manager Codex would have to parse `pane_signal.reason` to discover the worker died. Add a top-level `worker_alive` (and `manager_alive`) field by calling `_pid_is_alive(pid)` from the reconcile helper.

3. **`classify_busy_wait` early-returns when staleness < busy_wait_seconds (default 90s).** Real stuck-prompt detection is delayed until staleness crosses 90s. The helper already accepts `busy_wait_seconds` as a parameter — surface it via a `cycle --busy-wait-seconds N` CLI flag for operators who want faster detection.

---

## File Structure

**Modified:**
- `workerctl/commands.py` — `command_sessions` filter; `command_cycle` flag plumbing; `_pid_is_alive` reuse for cycle output.
- `workerctl/db.py` — `list_sessions` gains `include_legacy` parameter.
- `workerctl/supervise_cycle.py` — `run_cycle` accepts `busy_wait_seconds`; includes `worker_alive` / `manager_alive` in payload.
- `workerctl/shadow_state.py` — `pane_signal_for_session` already accepts `busy_wait_seconds`; thread through unchanged.
- `workerctl/cli.py` — `--include-legacy` on `sessions`; `--busy-wait-seconds` on `cycle`.
- `tests/test_workerctl.py` — three test classes / methods.
- `README.md` — flag documentation.

**Created:** (none)

---

## Task 1: Sessions list legacy filter

**Files:**
- Modify: `workerctl/db.py` — `list_sessions` signature.
- Modify: `workerctl/commands.py` — `command_sessions` passes the flag.
- Modify: `workerctl/cli.py` — `--include-legacy` flag.
- Test: `tests/test_workerctl.py`.

The Phase 1 backfill inserted ~108 rows into `sessions` for every pre-existing worker/manager. Those rows have `pid IS NULL` (no live process to track). After Phase 5 they're read-only artifacts. Default behavior should filter them; `--include-legacy` to see them.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py` (or a relevant existing class):

```python
class SessionsLegacyFilterTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_list_sessions_excludes_legacy_pid_null_by_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Register a real session (pid set).
            worker_db.register_session(
                conn, name="real", role="worker",
                codex_session_path="/a", codex_session_id="u-r",
                pid=12345, cwd="/r",
            )
            # Inject a legacy backfill row by hand (pid NULL).
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                """
                insert into sessions(id, name, role, identity_token, cwd,
                                     registered_at, state, pid)
                values ('legacy-s', 'legacy', 'worker', 'tok-legacy', '/r',
                        ?, 'active', NULL)
                """,
                (now,),
            )
            conn.commit()
            sessions = worker_db.list_sessions(conn)
            names = {s["name"] for s in sessions}
            self.assertIn("real", names)
            self.assertNotIn("legacy", names)

    def test_list_sessions_include_legacy_returns_both(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="real", role="worker",
                codex_session_path="/a", codex_session_id="u-r",
                pid=12345, cwd="/r",
            )
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                """
                insert into sessions(id, name, role, identity_token, cwd,
                                     registered_at, state, pid)
                values ('legacy-s', 'legacy', 'worker', 'tok-legacy', '/r',
                        ?, 'active', NULL)
                """,
                (now,),
            )
            conn.commit()
            sessions = worker_db.list_sessions(conn, include_legacy=True)
            names = {s["name"] for s in sessions}
            self.assertIn("real", names)
            self.assertIn("legacy", names)

    def test_cli_sessions_default_excludes_legacy(self):
        # Subprocess test via WORKERCTL_STATE_ROOT. Verify the `legacy` row
        # does NOT appear in default `workerctl sessions` output, but DOES
        # appear with --include-legacy.
        ...
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SessionsLegacyFilterTests -v
```

Expected: 3 tests FAIL.

- [ ] **Step 3: Implement `list_sessions` filter**

In `workerctl/db.py`, update `list_sessions`:

```python
def list_sessions(
    conn: sqlite3.Connection,
    *,
    role: str | None = None,
    include_legacy: bool = False,
) -> list[dict[str, Any]]:
    query = "select * from sessions"
    clauses: list[str] = []
    params: list = []
    if role is not None:
        clauses.append("role = ?")
        params.append(role)
    if not include_legacy:
        clauses.append("pid is not null")
    if clauses:
        query += " where " + " and ".join(clauses)
    query += " order by registered_at"
    return [dict(row) for row in conn.execute(query, tuple(params))]
```

- [ ] **Step 4: Plumb through `command_sessions`**

In `workerctl/commands.py`:

```python
def command_sessions(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        rows = worker_db.list_sessions(
            conn, role=args.role, include_legacy=args.include_legacy,
        )
    finally:
        conn.close()
    print(json.dumps(rows, indent=2, sort_keys=True, default=str))
    return 0
```

- [ ] **Step 5: Add CLI flag**

In `workerctl/cli.py`, on the `sessions` subparser:

```python
    sessions.add_argument(
        "--include-legacy", action="store_true",
        help="Include Phase 1 backfill rows (pid IS NULL) — legacy workers/managers.",
    )
```

- [ ] **Step 6: Run tests and verify CLI**

```bash
python3 -m unittest tests.test_workerctl.SessionsLegacyFilterTests -v
python3 -m workerctl sessions 2>&1 | python3 -c "import json, sys; print(len(json.load(sys.stdin)))"
python3 -m workerctl sessions --include-legacy 2>&1 | python3 -c "import json, sys; print(len(json.load(sys.stdin)))"
```

Expected: 3 tests PASS. CLI shows fewer sessions by default than with `--include-legacy`.

- [ ] **Step 7: Commit**

```bash
git add workerctl/db.py workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Phase 7: filter legacy pid-null sessions by default; --include-legacy to opt in"
```

---

## Task 2: `worker_alive` / `manager_alive` in cycle output

**Files:**
- Modify: `workerctl/supervise_cycle.py` — call `_pid_is_alive` for both worker and manager sessions; include both bools in `status_payload`.
- Modify: `workerctl/commands.py` — `_pid_is_alive` may need to be reused (already defined for reconcile; can be imported / lifted).
- Test: `tests/test_workerctl.py`.

`_pid_is_alive` already exists in `workerctl/commands.py` for `reconcile`. Either import it or move it to a more shared location.

- [ ] **Step 1: Decide where `_pid_is_alive` lives**

Two options:
- **A**: Keep in `workerctl/commands.py`. Import from supervise_cycle.py: `from workerctl.commands import _pid_is_alive`.
- **B**: Move to a shared module (e.g., `workerctl/core.py` or a new `workerctl/processes.py`).

Recommendation: **A** — minimal disruption. Two callers (reconcile + cycle), one canonical home. If a third caller appears, hoist then.

- [ ] **Step 2: Write failing tests**

Append to `SuperviseCycleTests` in `tests/test_workerctl.py`:

```python
    def test_run_cycle_reports_worker_alive_true_for_live_pid(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            # _setup_bound_task uses pid=1 (init); init is always alive.
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertTrue(result["worker_alive"])
            self.assertTrue(result["manager_alive"])

    def test_run_cycle_reports_worker_alive_false_for_dead_pid(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Build a fixture using a definitely-dead pid (2^31 - 2 reserved on macOS).
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u", "cwd": "/r"},
            }) + "\n")
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u-w", pid=2147483646, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path=str(rollout),
                codex_session_id="u-m", pid=2147483645, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertFalse(result["worker_alive"])
            self.assertFalse(result["manager_alive"])
```

- [ ] **Step 3: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests -v
```

Expected: 2 tests FAIL with KeyError (`worker_alive` / `manager_alive` keys absent).

- [ ] **Step 4: Implement in `run_cycle`**

In `workerctl/supervise_cycle.py`:

```python
# At top of file:
from workerctl.commands import _pid_is_alive

# Inside run_cycle, after binding is resolved and before status_payload is built:
worker_row = worker_db.session_by_id(conn, session_id=binding["worker_session_id"])
manager_row = worker_db.session_by_id(conn, session_id=binding["manager_session_id"])
worker_alive = bool(worker_row and worker_row["pid"] is not None and _pid_is_alive(int(worker_row["pid"])))
manager_alive = bool(manager_row and manager_row["pid"] is not None and _pid_is_alive(int(manager_row["pid"])))
```

Then add to `status_payload` dict:

```python
    status_payload = {
        "kind": "session_cycle",
        ...
        "worker_alive": worker_alive,
        "manager_alive": manager_alive,
        ...
    }
```

Update the docstring's "stable keys" list to include `worker_alive` and `manager_alive`.

- [ ] **Step 5: Run tests**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -5
```

Expected: all pass (236 baseline + 3 + 2 = 241).

- [ ] **Step 6: Commit**

```bash
git add workerctl/supervise_cycle.py tests/test_workerctl.py
git commit -m "Phase 7: add worker_alive and manager_alive to cycle output"
```

---

## Task 3: Configurable busy-wait threshold via `cycle --busy-wait-seconds N`

**Files:**
- Modify: `workerctl/supervise_cycle.py` — `run_cycle` accepts `busy_wait_seconds` and passes to `pane_signal_for_session`.
- Modify: `workerctl/commands.py` — `command_cycle` reads `args.busy_wait_seconds`.
- Modify: `workerctl/cli.py` — add the flag.
- Test: `tests/test_workerctl.py`.

`pane_signal_for_session` already accepts `busy_wait_seconds`; just plumb through.

- [ ] **Step 1: Write failing test**

Append to `SuperviseCycleTests`:

```python
    def test_run_cycle_with_low_busy_wait_threshold_fires_pattern_quickly(self):
        """With staleness < default 90s but > custom 5s, pattern should fire."""
        from workerctl import supervise_cycle
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            conn.execute(
                "update sessions set tmux_session = 'codex-w', tmux_pane_id = '%5' "
                "where name = 'w'"
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                # Staleness from 14:32:11 to 14:32:20 = 9s (< default 90, > custom 5).
                result = supervise_cycle.run_cycle(
                    conn, task_name="t",
                    now="2026-05-11T14:32:20Z",
                    busy_wait_seconds=5,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["notable_pane_pattern"], "trust_prompt")
            # Default threshold would NOT fire — verify by re-running with default:
            original2 = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result_default = supervise_cycle.run_cycle(
                    conn, task_name="t",
                    now="2026-05-11T14:32:21Z",
                    # default busy_wait_seconds (90)
                )
            finally:
                worker_tmux.capture_tmux_target = original2

            # With default threshold (90s) and staleness ~10s, pattern is SKIPPED.
            self.assertIsNone(result_default["notable_pane_pattern"])

    def test_cli_cycle_busy_wait_seconds_flag_plumbed_through(self):
        # CLI subprocess test: invoke `workerctl cycle <task> --busy-wait-seconds 5`
        # against a setup similar to above, verify notable_pane_pattern fires.
        ...
```

- [ ] **Step 2: Run to verify failure**

Expected: TypeError / unrecognized argument.

- [ ] **Step 3: Add `busy_wait_seconds` parameter to `run_cycle`**

In `workerctl/supervise_cycle.py`:

```python
def run_cycle(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    now: str | None = None,
    busy_wait_seconds: int = 90,
) -> dict[str, Any]:
    ...
    # Pass it through to the pane signal helper:
    pane_signal = worker_shadow.pane_signal_for_session(
        conn,
        session_id=binding["worker_session_id"],
        busy_wait_seconds=busy_wait_seconds,
        now=started_at,
    )
    ...
```

- [ ] **Step 4: Add CLI flag**

In `workerctl/cli.py`, on the `cycle` subparser:

```python
    cycle.add_argument(
        "--busy-wait-seconds", type=int, default=90,
        help="Seconds of staleness before the pane classifier fires (default 90). "
             "Lower values catch stuck prompts sooner but risk false positives.",
    )
```

In `workerctl/commands.py`, `command_cycle`:

```python
def command_cycle(args: argparse.Namespace) -> int:
    ...
    result = supervise_cycle.run_cycle(
        conn, task_name=args.task, busy_wait_seconds=args.busy_wait_seconds,
    )
    ...
```

- [ ] **Step 5: Run tests**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```

Expected: 243 pass (241 + 2 new).

- [ ] **Step 6: Commit**

```bash
git add workerctl/supervise_cycle.py workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Phase 7: configurable cycle --busy-wait-seconds for faster pane-pattern detection"
```

---

## Task 4: README updates

**Files:**
- Modify: `README.md`.

- [ ] **Step 1: Document the three additions**

In the Commands section:

- `sessions [--role worker|manager] [--include-legacy]` — note that the default excludes Phase 1 backfill rows (108 of them on the live DB), `--include-legacy` to include them.
- `cycle <task> [--busy-wait-seconds N]` — note the threshold default 90, lower for faster pane-pattern detection.
- Cycle output's `worker_alive` / `manager_alive` fields — note they're a cheap `os.kill(pid, 0)` check, give the manager Codex an explicit "worker died" signal.

In the Phase 7 polish section (parallel to Phase 6's existing section):

```markdown
## Phase 7 polish

- `workerctl sessions` defaults to excluding Phase 1 backfill rows (`pid IS NULL`).
  Use `--include-legacy` to include them.
- `workerctl cycle --busy-wait-seconds N` — override the default 90s threshold
  for the pane classifier. Lower values catch stuck prompts sooner.
- Cycle output adds `worker_alive` / `manager_alive` (bool) — a cheap pid liveness
  check that gives the manager Codex an explicit "worker died" signal without
  parsing `pane_signal.reason`.
```

- [ ] **Step 2: Verify**

```bash
python3 -m workerctl sessions --help
python3 -m workerctl cycle --help
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Phase 7: document --include-legacy, --busy-wait-seconds, worker_alive"
```

---

## Self-Review

**Spec coverage:** All three findings addressed.

**Placeholder scan:** No TBDs; every step has concrete code or grep-able locations.

**Type consistency:**
- `list_sessions` signature gains `include_legacy: bool = False` (default preserves new behavior; tests for both branches).
- `run_cycle` return dict gains `worker_alive: bool` and `manager_alive: bool` keys; the cycle output documentation in supervise_cycle.py needs the new keys listed.
- `run_cycle` signature gains `busy_wait_seconds: int = 90` (default matches existing helper).

**Known caveats:**
- `_pid_is_alive` is imported across module boundaries (Task 2); flagged but accepted. If a third caller appears, hoist.
- The `worker_alive` check is `os.kill(pid, 0)` — on a single host, fine. For future multi-host or containerized scenarios this would need a different liveness primitive.
- Task 3 only surfaces the threshold via `cycle`. `pane_signal_for_session` already accepts the parameter; if other commands grow pane-signal consumers, they need the same flag.

---

## Out of Scope (deferred)

- `cycle --compact` JSON output for line-noise reduction (low impact, finding from Phase 6 testing).
- Re-register warning when `codex_session_id` changes (low impact).
- Replay summary enrichment beyond Phase 4's `[pane pattern: X]` (low impact).
- A `start-manager` complement to `start-worker` (would close another spawn-and-register gap, but managers run independently and are usually long-lived — deferred unless real friction surfaces).
