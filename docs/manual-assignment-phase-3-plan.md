# Manual-Assignment Redesign — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the manager-driven supervision path end-to-end against bindings + JSON ingest. A new `workerctl cycle <task>` command performs one observation+decision cycle: ingest worker rollout, compute state and staleness from `codex_events`, write a `manager_cycles` row, and return a structured JSON payload the manager Codex can read. Two new session-keyed control commands (`session-nudge`, `session-interrupt`) let a manager Codex acting on bindings actuate the worker. The manager itself runs as a regular Codex session — no tmux required for the manager.

**Architecture:** Three new pieces. (1) Session-keyed tmux helpers in `workerctl/tmux.py` that resolve `sessions.tmux_session` / `sessions.tmux_pane_id` and reuse the existing `run(["tmux", ...])` primitives. (2) A new `workerctl/supervise_cycle.py` module that resolves the active binding for a task (using `worker_session_id` from Phase 1), runs `ingest_session` for the worker, computes `current_state` + staleness, and writes a `manager_cycles` row. (3) Three CLI commands (`session-nudge`, `session-interrupt`, `cycle`) wired into the existing argparse dispatch.

**Tech Stack:** Python 3, SQLite (WAL), stdlib only, `unittest`. No new third-party deps. Reuses Phase 1's `register_session` / `bind_sessions` and Phase 2's `ingest_session` / `current_state` end-to-end.

**Scope note:** Phase 3 only. Out of scope: shadowing JSON-state alongside legacy `classify_busy_wait` (Phase 4), retiring `promote` / `manage` / `supervise` (Phase 5), continuous long-running supervision daemon (deferred — `cycle` is one-shot; the manager Codex loops by calling it).

---

## File Structure

**Created:**
- `workerctl/supervise_cycle.py` — pure-ish library. Function: `run_cycle(conn, *, task_name, now=None) -> dict`. Roughly 80 lines.

**Modified:**
- `workerctl/tmux.py` — new helpers `tmux_target_for_session_row(row)`, `send_text_to_session(conn, *, session_name, text)`, `interrupt_session(conn, *, session_name, key="C-c", followup=None, dry_run=False)`.
- `workerctl/ingest.py` — new helpers `last_state_event_timestamp(conn, *, session_id)`, `session_staleness_seconds(conn, *, session_id, now=None)`.
- `workerctl/db.py` — one new helper `active_binding_for_task(conn, *, task_name)` that returns the active binding row (with session ids resolved to session names for ergonomic consumption).
- `workerctl/commands.py` — three new command functions.
- `workerctl/cli.py` — three new subparsers.
- `tests/test_workerctl.py` — append `SessionTmuxTests`, `StalenessTests`, `SuperviseCycleTests`, plus CLI tests in `SessionActionCliTests` and `CycleCliTests`.
- `README.md` — Phase 3 subsection inside the existing Manual-Assignment Primitives section.

**Not touched in Phase 3:**
- `workerctl/supervise.py`, `workerctl/lifecycle.py`, legacy `promote`/`manage`/`supervise`/`watch` paths. Phase 3 is purely additive.

---

## Task 1: Staleness helpers in `workerctl/ingest.py`

**Files:**
- Modify: `workerctl/ingest.py` — add `last_state_event_timestamp` and `session_staleness_seconds`.
- Test: `tests/test_workerctl.py` — append `StalenessTests` class.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class StalenessTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _register(self, conn):
        return worker_db.register_session(
            conn, name="w", role="worker", codex_session_path="/a",
            codex_session_id="cuid-w", pid=1, cwd="/repo",
        )

    def test_last_state_event_timestamp_none_when_no_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            self.assertIsNone(
                ingest.last_state_event_timestamp(conn, session_id=sid),
            )

    def test_last_state_event_timestamp_skips_non_state_bearing(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            # Only non-state-bearing events present.
            worker_db.insert_codex_event(
                conn, session_id=sid,
                timestamp="2026-05-11T14:32:11Z",
                event_type="event_msg", subtype="agent_message",
                payload={}, byte_offset=0,
            )
            worker_db.insert_codex_event(
                conn, session_id=sid,
                timestamp="2026-05-11T14:32:12Z",
                event_type="event_msg", subtype="token_count",
                payload={}, byte_offset=100,
            )
            self.assertIsNone(
                ingest.last_state_event_timestamp(conn, session_id=sid),
            )

    def test_last_state_event_timestamp_returns_most_recent(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            for subtype, ts, offset in [
                ("task_started", "2026-05-11T14:32:10Z", 0),
                ("agent_message", "2026-05-11T14:32:11Z", 100),
                ("task_complete", "2026-05-11T14:32:12Z", 200),
                ("agent_message", "2026-05-11T14:32:13Z", 300),
            ]:
                worker_db.insert_codex_event(
                    conn, session_id=sid,
                    timestamp=ts, event_type="event_msg",
                    subtype=subtype, payload={}, byte_offset=offset,
                )
            self.assertEqual(
                ingest.last_state_event_timestamp(conn, session_id=sid),
                "2026-05-11T14:32:12Z",
            )

    def test_session_staleness_seconds_none_when_no_state_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            self.assertIsNone(
                ingest.session_staleness_seconds(
                    conn, session_id=sid, now="2026-05-11T14:33:00Z",
                ),
            )

    def test_session_staleness_seconds_computes_against_now(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            worker_db.insert_codex_event(
                conn, session_id=sid,
                timestamp="2026-05-11T14:30:00Z",
                event_type="event_msg", subtype="task_complete",
                payload={}, byte_offset=0,
            )
            staleness = ingest.session_staleness_seconds(
                conn, session_id=sid, now="2026-05-11T14:35:00Z",
            )
            self.assertEqual(staleness, 300)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.StalenessTests -v
```
Expected: 5 tests FAIL with `AttributeError`.

- [ ] **Step 3: Implement `last_state_event_timestamp`**

Append to `workerctl/ingest.py`:

```python
def last_state_event_timestamp(conn: sqlite3.Connection, *, session_id: str) -> str | None:
    """Return the ISO timestamp of the most recent state-bearing event for `session_id`,
    or None if no state-bearing event has been ingested.

    State-bearing means type='event_msg' and subtype in {task_started, user_message,
    task_complete}. Mirrors `current_state`'s filter so the timestamp and the inferred
    state always refer to the same row.
    """
    placeholders = ",".join("?" * len(_STATE_BEARING_SUBTYPES))
    row = conn.execute(
        f"""
        select timestamp from codex_events
        where session_id = ?
          and type = 'event_msg'
          and subtype in ({placeholders})
        order by id desc
        limit 1
        """,
        (session_id, *_STATE_BEARING_SUBTYPES),
    ).fetchone()
    if row is None:
        return None
    return row["timestamp"]
```

- [ ] **Step 4: Implement `session_staleness_seconds`**

Append to `workerctl/ingest.py`:

```python
from datetime import datetime, timezone


def _parse_iso_z(value: str) -> datetime:
    """Parse an ISO-8601 string with a trailing 'Z' or numeric offset into an aware datetime."""
    # Codex rollouts emit '2026-05-11T14:32:11.791Z'. Python <3.11 doesn't accept 'Z'.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def session_staleness_seconds(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    now: str | None = None,
) -> float | None:
    """Return seconds since the most recent state-bearing event for `session_id`.

    Returns None if no state-bearing event has been ingested. `now` defaults to the
    current UTC time; it accepts an ISO string for deterministic tests.
    """
    last = last_state_event_timestamp(conn, session_id=session_id)
    if last is None:
        return None
    now_dt = _parse_iso_z(now) if now else datetime.now(timezone.utc)
    last_dt = _parse_iso_z(last)
    return (now_dt - last_dt).total_seconds()
```

- [ ] **Step 5: Run tests**

```bash
python3 -m unittest tests.test_workerctl.StalenessTests -v
```
Expected: 5 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 224 tests (219 + 5).

- [ ] **Step 7: Commit**

```bash
git add workerctl/ingest.py tests/test_workerctl.py
git commit -m "Add last_state_event_timestamp and session_staleness_seconds helpers"
```

---

## Task 2: Session-keyed tmux helpers in `workerctl/tmux.py`

**Files:**
- Modify: `workerctl/tmux.py` — add `session_tmux_target(row)`, `send_text_to_session(conn, *, session_name, text, dry_run=False)`, `interrupt_session(conn, *, session_name, key="C-c", followup=None, dry_run=False)`.
- Test: `tests/test_workerctl.py` — append `SessionTmuxTests`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class SessionTmuxTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _register_with_tmux(self, conn, **overrides):
        kwargs = {
            "name": "w", "role": "worker",
            "codex_session_path": "/a", "codex_session_id": "u", "pid": 1, "cwd": "/repo",
            "tmux_session": "codex-w", "tmux_pane_id": "%5",
        }
        kwargs.update(overrides)
        return worker_db.register_session(conn, **kwargs)

    def test_session_tmux_target_uses_session_and_pane(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            row = worker_db.session_row(conn, name="w")
            target = worker_tmux.session_tmux_target(row)
            # Pane-qualified target ensures we hit the right pane even if other panes exist.
            self.assertEqual(target, "codex-w:%5")

    def test_session_tmux_target_falls_back_to_session_when_no_pane(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn, tmux_pane_id=None)
            row = worker_db.session_row(conn, name="w")
            self.assertEqual(worker_tmux.session_tmux_target(row), "codex-w")

    def test_send_text_to_session_raises_when_no_tmux_session(self):
        from workerctl import tmux as worker_tmux
        from workerctl.core import WorkerError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/a", codex_session_id="u", pid=1, cwd="/repo",
            )
            with self.assertRaises(WorkerError):
                worker_tmux.send_text_to_session(conn, session_name="m", text="hi")

    def test_send_text_to_session_dry_run_does_not_invoke_tmux(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            captured_calls = []

            def fake_run(cmd, check=True):
                captured_calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                result = worker_tmux.send_text_to_session(
                    conn, session_name="w", text="hello", dry_run=True,
                )
            finally:
                worker_tmux.run = original_run

            self.assertEqual(captured_calls, [])
            self.assertEqual(result["dry_run"], True)
            self.assertEqual(result["target"], "codex-w:%5")
            self.assertEqual(result["text"], "hello")

    def test_send_text_to_session_invokes_set_paste_send_keys(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            calls = []

            def fake_run(cmd, check=True):
                calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                worker_tmux.send_text_to_session(
                    conn, session_name="w", text="payload",
                )
            finally:
                worker_tmux.run = original_run

            # Expect at least: set-buffer, paste-buffer, send-keys (Enter), delete-buffer.
            verbs = [c[1] for c in calls if len(c) > 1]
            self.assertIn("set-buffer", verbs)
            self.assertIn("paste-buffer", verbs)
            self.assertIn("send-keys", verbs)
            self.assertIn("delete-buffer", verbs)
            # paste-buffer and send-keys must target the resolved pane.
            paste_calls = [c for c in calls if len(c) > 1 and c[1] == "paste-buffer"]
            send_calls = [c for c in calls if len(c) > 1 and c[1] == "send-keys"]
            self.assertTrue(all("codex-w:%5" in c for c in paste_calls))
            self.assertTrue(all("codex-w:%5" in c for c in send_calls))

    def test_interrupt_session_dry_run(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            captured_calls = []

            def fake_run(cmd, check=True):
                captured_calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                result = worker_tmux.interrupt_session(
                    conn, session_name="w", dry_run=True,
                )
            finally:
                worker_tmux.run = original_run

            self.assertEqual(captured_calls, [])
            self.assertEqual(result["dry_run"], True)
            self.assertEqual(result["key"], "C-c")
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SessionTmuxTests -v
```
Expected: 6 tests FAIL with `AttributeError`.

- [ ] **Step 3: Implement the helpers**

In `workerctl/tmux.py`, after the existing `interrupt_worker` function (around line 180), add:

```python
def session_tmux_target(row: sqlite3.Row) -> str:
    """Build a `tmux send-keys -t TARGET` string from a `sessions` row.

    If the row has a `tmux_pane_id` (e.g. `%5`), the target is `<session>:<pane_id>`
    so we hit a specific pane. Otherwise the target is the session name and tmux
    routes to the active pane in window 0.
    """
    session_name = row["tmux_session"]
    if not session_name:
        from workerctl.core import WorkerError
        raise WorkerError(
            f"session has no tmux_session; cannot build tmux target (session role likely 'manager' running outside tmux)"
        )
    pane_id = row["tmux_pane_id"]
    if pane_id:
        return f"{session_name}:{pane_id}"
    return session_name


def send_text_to_session(
    conn: "sqlite3.Connection",
    *,
    session_name: str,
    text: str,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Send `text` (followed by Enter) to the session's tmux pane.

    Resolves the session via `db.session_row` and rejects sessions without a tmux
    session attached (e.g. managers running outside tmux). Mirrors `send_text` but
    keyed by session_id instead of worker name.
    """
    from workerctl import db as worker_db

    row = worker_db.session_row(conn, name=session_name)
    target = session_tmux_target(row)
    result = {
        "dry_run": dry_run,
        "session": session_name,
        "target": target,
        "text": text,
        "time": now_iso(),
    }
    if dry_run:
        return result
    buffer_name = f"workerctl-session-{session_name}"
    run(["tmux", "set-buffer", "-b", buffer_name, text])
    try:
        run(["tmux", "paste-buffer", "-b", buffer_name, "-t", target])
        time.sleep(PASTE_SUBMIT_DELAY_SECONDS)
        run(["tmux", "send-keys", "-t", target, SUBMIT_KEY])
    finally:
        run(["tmux", "delete-buffer", "-b", buffer_name], check=False)
    return result


def interrupt_session(
    conn: "sqlite3.Connection",
    *,
    session_name: str,
    key: str = "C-c",
    followup: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Send an interrupt key (default Ctrl-C) to the session's tmux pane.

    Optional `followup` text is paste-buffered after a short delay. Mirrors
    `interrupt_worker` but keyed by session_id.
    """
    from workerctl import db as worker_db

    row = worker_db.session_row(conn, name=session_name)
    target = session_tmux_target(row)
    result = {
        "dry_run": dry_run,
        "followup": followup,
        "key": key,
        "session": session_name,
        "target": target,
        "time": now_iso(),
    }
    if dry_run:
        return result
    run(["tmux", "send-keys", "-t", target, key])
    if followup:
        time.sleep(0.5)
        send_text_to_session(conn, session_name=session_name, text=followup)
    return result
```

Check imports at the top of `workerctl/tmux.py`: `sqlite3` may not be imported. Add `import sqlite3` if absent. `Any` should already be present (the existing `interrupt_worker` returns `dict[str, Any]`).

Note on `session_tmux_target` raising: the function imports `WorkerError` lazily inside the function body to avoid a hard import dependency from `tmux.py` to `core.py` at module load time (mirrors the existing lazy import pattern in `send_text_to_session`).

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.SessionTmuxTests -v
```
Expected: 6 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 230 tests (224 + 6).

- [ ] **Step 6: Commit**

```bash
git add workerctl/tmux.py tests/test_workerctl.py
git commit -m "Add session-keyed send_text_to_session and interrupt_session"
```

---

## Task 3: CLI `session-nudge` and `session-interrupt`

**Files:**
- Modify: `workerctl/commands.py` — add `command_session_nudge`, `command_session_interrupt`.
- Modify: `workerctl/cli.py` — wire two subparsers.
- Test: `tests/test_workerctl.py` — append `SessionActionCliTests`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class SessionActionCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_with_worker(self, tmpdir):
        rollout = Path(tmpdir) / "rollout.jsonl"
        rollout.write_text(json.dumps({
            "type": "session_meta",
            "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
        }) + "\n")
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        # register-worker with --tmux-session so the row has a tmux target.
        self.run_cli(
            "register-worker", "--name", "w",
            "--codex-session", str(rollout),
            "--pid", "1", "--cwd", str(ROOT),
            "--tmux-session", "codex-w",
            env_extra=env,
        )
        return rollout, state_dir, env

    def test_cli_session_nudge_dry_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_with_worker(tmpdir)
            proc = self.run_cli(
                "session-nudge", "w", "hello there", "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["session"], "w")
            self.assertEqual(payload["text"], "hello there")
            self.assertEqual(payload["dry_run"], True)
            self.assertIn("codex-w", payload["target"])

    def test_cli_session_nudge_rejects_session_without_tmux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
            # Register a manager WITHOUT --tmux-session — clean error path.
            self.run_cli(
                "register-manager", "--name", "m",
                "--codex-session", str(rollout),
                "--pid", "2", "--cwd", str(ROOT),
                env_extra=env,
            )
            proc = self.run_cli(
                "session-nudge", "m", "shouldn't work", "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)

    def test_cli_session_interrupt_dry_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_with_worker(tmpdir)
            proc = self.run_cli(
                "session-interrupt", "w", "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["session"], "w")
            self.assertEqual(payload["key"], "C-c")
            self.assertEqual(payload["dry_run"], True)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SessionActionCliTests -v
```
Expected: 3 tests FAIL — unknown subcommands.

- [ ] **Step 3: Implement command functions in `workerctl/commands.py`**

Append (place near `command_ingest` / `command_tail`):

```python
def command_session_nudge(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        result = worker_tmux.send_text_to_session(
            conn, session_name=args.name, text=args.text, dry_run=args.dry_run,
        )
        worker_db.insert_event(
            conn, "session_nudged", actor="workerctl",
            payload={"session": args.name, "dry_run": args.dry_run, "text_length": len(args.text)},
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_session_interrupt(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        result = worker_tmux.interrupt_session(
            conn, session_name=args.name, key=args.key,
            followup=args.followup, dry_run=args.dry_run,
        )
        worker_db.insert_event(
            conn, "session_interrupted", actor="workerctl",
            payload={"session": args.name, "key": args.key, "dry_run": args.dry_run},
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0
```

- [ ] **Step 4: Wire subparsers in `workerctl/cli.py`**

Add imports to the `from workerctl.commands import (...)` block:

```python
    command_session_nudge,
    command_session_interrupt,
```

After the `tail` subparser block (added in Phase 2), add:

```python
    session_nudge = subparsers.add_parser(
        "session-nudge",
        help="Send text (followed by Enter) to a registered session's tmux pane.",
    )
    session_nudge.add_argument("name", help="Session name.")
    session_nudge.add_argument("text", help="Text to send.")
    session_nudge.add_argument("--dry-run", action="store_true", help="Resolve target without sending.")
    session_nudge.set_defaults(func=command_session_nudge)

    session_interrupt = subparsers.add_parser(
        "session-interrupt",
        help="Send an interrupt key (default Ctrl-C) to a registered session's tmux pane.",
    )
    session_interrupt.add_argument("name", help="Session name.")
    session_interrupt.add_argument("--key", default="C-c", help="Key chord (tmux format).")
    session_interrupt.add_argument("--followup", default=None, help="Optional text to send after the interrupt.")
    session_interrupt.add_argument("--dry-run", action="store_true", help="Resolve target without sending.")
    session_interrupt.set_defaults(func=command_session_interrupt)
```

- [ ] **Step 5: Run CLI tests**

```bash
python3 -m unittest tests.test_workerctl.SessionActionCliTests -v
```
Expected: 3 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 233 tests (230 + 3).

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add session-nudge and session-interrupt CLI commands"
```

---

## Task 4: `active_binding_for_task` DB helper

**Files:**
- Modify: `workerctl/db.py` — add helper near `bind_sessions`.
- Test: `tests/test_workerctl.py` — append to `BindCommandTests`.

- [ ] **Step 1: Write failing tests**

Append to `BindCommandTests` in `tests/test_workerctl.py`:

```python
    def test_active_binding_for_task_returns_resolved_dict(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            row = worker_db.active_binding_for_task(conn, task_name="auth-refactor")
            self.assertEqual(row["binding_id"], binding_id)
            self.assertEqual(row["worker_session_name"], "w1")
            self.assertEqual(row["manager_session_name"], "m1")
            self.assertIsNotNone(row["worker_session_id"])
            self.assertIsNotNone(row["manager_session_id"])

    def test_active_binding_for_task_raises_when_no_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            with self.assertRaises(WorkerError):
                worker_db.active_binding_for_task(conn, task_name="auth-refactor")

    def test_active_binding_for_task_only_returns_active_or_ending(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            worker_db.unbind_task(conn, task_name="auth-refactor")
            with self.assertRaises(WorkerError):
                worker_db.active_binding_for_task(conn, task_name="auth-refactor")
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.BindCommandTests -v
```
Expected: 3 tests FAIL with `AttributeError`.

- [ ] **Step 3: Implement `active_binding_for_task`**

In `workerctl/db.py`, after `unbind_task` (find with `grep -n "def unbind_task" workerctl/db.py`), add:

```python
def active_binding_for_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
) -> dict[str, Any]:
    """Return the active (or ending) binding for `task_name` with session names resolved.

    Returns a dict with keys:
      - `binding_id`: str
      - `task_id`: str
      - `worker_session_id`: str
      - `manager_session_id`: str
      - `worker_session_name`: str
      - `manager_session_name`: str
      - `state`: str ('active' | 'ending')
      - `created_at`: str

    Raises WorkerError if the task is unknown or has no active binding. Only resolves
    session-id-based bindings (Phase 1+); legacy worker_id/manager_id bindings are
    NOT returned here (they remain accessible via active_task_worker).
    """
    task = task_row(conn, task=task_name)
    row = conn.execute(
        """
        select
          b.id as binding_id,
          b.task_id as task_id,
          b.worker_session_id as worker_session_id,
          b.manager_session_id as manager_session_id,
          ws.name as worker_session_name,
          ms.name as manager_session_name,
          b.state as state,
          b.created_at as created_at
        from bindings b
        join sessions ws on ws.id = b.worker_session_id
        join sessions ms on ms.id = b.manager_session_id
        where b.task_id = ?
          and b.state in ('active', 'ending')
        order by b.created_at desc
        limit 1
        """,
        (task["id"],),
    ).fetchone()
    if row is None:
        raise WorkerError(f"no active session-based binding for task {task_name!r}")
    return dict(row)
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.BindCommandTests -v
```
Expected: all PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 236 tests (233 + 3).

- [ ] **Step 6: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add active_binding_for_task DB helper"
```

---

## Task 5: `workerctl/supervise_cycle.py` module

**Files:**
- Create: `workerctl/supervise_cycle.py`
- Test: `tests/test_workerctl.py` — append `SuperviseCycleTests`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class SuperviseCycleTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _setup_bound_task(self, conn, tmpdir, rollout_events):
        rollout = Path(tmpdir) / "rollout.jsonl"
        rollout.write_text("".join(json.dumps(e) + "\n" for e in rollout_events))
        now = "2026-05-11T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values ('task-1', 't', 'g', 'candidate', ?, ?)",
            (now, now),
        )
        worker_db.register_session(
            conn, name="w", role="worker",
            codex_session_path=str(rollout),
            codex_session_id="u-w", pid=1, cwd="/r",
        )
        worker_db.register_session(
            conn, name="m", role="manager",
            codex_session_path=str(rollout),  # reuses fixture; not under test
            codex_session_id="u-m", pid=2, cwd="/r",
        )
        worker_db.bind_sessions(
            conn, task_name="t",
            worker_session_name="w", manager_session_name="m",
        )
        conn.commit()
        return rollout

    def test_run_cycle_ingests_and_returns_state(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])

            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:32:15Z",
            )
            self.assertEqual(result["task"], "t")
            self.assertEqual(result["worker_session"], "w")
            self.assertEqual(result["manager_session"], "m")
            self.assertEqual(result["ingest"]["new_events"], 2)
            self.assertEqual(result["state"], "busy")
            self.assertEqual(result["last_state_event_at"], "2026-05-11T14:32:11Z")
            self.assertAlmostEqual(result["staleness_seconds"], 4.0, places=0)
            self.assertIn("cycle_id", result)

    def test_run_cycle_records_manager_cycle_row(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])

            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            row = conn.execute(
                "select state, status_json from manager_cycles where id = ?",
                (result["cycle_id"],),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["state"], "succeeded")
            status = json.loads(row["status_json"])
            self.assertEqual(status["state"], "idle")
            self.assertEqual(status["worker_session"], "w")

    def test_run_cycle_unknown_task_raises(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(WorkerError):
                supervise_cycle.run_cycle(conn, task_name="does-not-exist")

    def test_run_cycle_no_active_binding_raises(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            conn.commit()
            with self.assertRaises(WorkerError):
                supervise_cycle.run_cycle(conn, task_name="t")

    def test_run_cycle_handles_session_without_state_events(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
            ])

            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:32:15Z",
            )
            self.assertEqual(result["state"], "unknown")
            self.assertIsNone(result["last_state_event_at"])
            self.assertIsNone(result["staleness_seconds"])
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests -v
```
Expected: 5 tests FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Create the module**

Create `workerctl/supervise_cycle.py`:

```python
from __future__ import annotations

import json
import sqlite3
from typing import Any

from workerctl import db as worker_db
from workerctl import ingest as worker_ingest
from workerctl.core import WorkerError, now_iso


def run_cycle(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    now: str | None = None,
) -> dict[str, Any]:
    """Perform one observation cycle for a session-bound task.

    Steps:
      1. Resolve the active binding for `task_name` (raises WorkerError if missing).
      2. Run `ingest_session` on the worker session to pull any new rollout events.
      3. Compute `current_state` and staleness from `codex_events`.
      4. Write a `manager_cycles` row with the structured status.
      5. Return a JSON-serializable dict for the manager Codex (or operator) to act on.

    The returned dict has stable keys: `task`, `binding_id`, `worker_session`,
    `manager_session`, `ingest` ({new_events, new_offset}), `state`,
    `last_state_event_at`, `staleness_seconds`, `cycle_id`, `cycle_started_at`,
    `cycle_completed_at`. Phase 3 supervision consumers depend on these names.

    Raises:
      - WorkerError: task or active binding missing.
      - IngestError: rollout file missing or unreadable.
    """
    started_at = now or now_iso()
    binding = worker_db.active_binding_for_task(conn, task_name=task_name)

    ingest_result = worker_ingest.ingest_session(
        conn,
        session_name=binding["worker_session_name"],
        now=started_at,
    )
    state = worker_ingest.current_state(
        conn, session_id=binding["worker_session_id"],
    )
    last_state_event_at = worker_ingest.last_state_event_timestamp(
        conn, session_id=binding["worker_session_id"],
    )
    staleness = worker_ingest.session_staleness_seconds(
        conn, session_id=binding["worker_session_id"], now=started_at,
    )

    completed_at = now_iso()
    status_payload = {
        "task": task_name,
        "binding_id": binding["binding_id"],
        "worker_session": binding["worker_session_name"],
        "manager_session": binding["manager_session_name"],
        "ingest": ingest_result,
        "state": state,
        "last_state_event_at": last_state_event_at,
        "staleness_seconds": staleness,
    }
    cursor = conn.execute(
        """
        insert into manager_cycles(
          task_id, started_at, completed_at, state, status_json
        )
        values (?, ?, ?, 'succeeded', ?)
        """,
        (
            binding["task_id"],
            started_at,
            completed_at,
            json.dumps(status_payload, sort_keys=True, default=str),
        ),
    )
    cycle_id = int(cursor.lastrowid)
    conn.commit()

    return {
        **status_payload,
        "cycle_id": cycle_id,
        "cycle_started_at": started_at,
        "cycle_completed_at": completed_at,
    }
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleTests -v
```
Expected: 5 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 241 tests (236 + 5).

- [ ] **Step 6: Commit**

```bash
git add workerctl/supervise_cycle.py tests/test_workerctl.py
git commit -m "Add supervise_cycle.run_cycle orchestrator"
```

---

## Task 6: CLI `cycle <task>`

**Files:**
- Modify: `workerctl/commands.py` — add `command_cycle`.
- Modify: `workerctl/cli.py` — wire subparser.
- Test: `tests/test_workerctl.py` — append `CycleCliTests`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class CycleCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_bound_task_via_cli(self, tmpdir, events):
        rollout = Path(tmpdir) / "rollout.jsonl"
        full_events = ([{"type": "session_meta",
                          "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"}}]
                       + events)
        rollout.write_text("".join(json.dumps(e) + "\n" for e in full_events))
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        self.run_cli("register-worker", "--name", "w",
                     "--codex-session", str(rollout),
                     "--pid", "1", "--cwd", str(ROOT),
                     "--tmux-session", "codex-w",
                     env_extra=env)
        self.run_cli("register-manager", "--name", "m",
                     "--codex-session", str(rollout),
                     "--pid", "2", "--cwd", str(ROOT),
                     env_extra=env)
        self.run_cli("tasks", "--create", "myTask", "--goal", "g", env_extra=env)
        self.run_cli("bind", "--task", "myTask", "--worker", "w", "--manager", "m",
                     env_extra=env)
        return rollout, state_dir, env

    def test_cli_cycle_returns_structured_payload(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_bound_task_via_cli(tmpdir, events=[
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])
            proc = self.run_cli("cycle", "myTask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["task"], "myTask")
            self.assertEqual(result["worker_session"], "w")
            self.assertEqual(result["manager_session"], "m")
            self.assertEqual(result["state"], "busy")
            self.assertEqual(result["ingest"]["new_events"], 2)
            self.assertIn("cycle_id", result)

    def test_cli_cycle_idempotent_on_unchanged_rollout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_bound_task_via_cli(tmpdir, events=[
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            self.run_cli("cycle", "myTask", env_extra=env)
            proc = self.run_cli("cycle", "myTask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["ingest"]["new_events"], 0)
            self.assertEqual(result["state"], "idle")

    def test_cli_cycle_unknown_task_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            proc = self.run_cli(
                "cycle", "no-such-task",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.CycleCliTests -v
```
Expected: 3 tests FAIL — unknown subcommand `cycle`.

- [ ] **Step 3: Implement `command_cycle` in `workerctl/commands.py`**

Append (place near `command_session_nudge`):

```python
def command_cycle(args: argparse.Namespace) -> int:
    """Run one observation cycle for a bound task. Output is structured JSON.

    The manager Codex (or an operator) is expected to read the output and decide
    whether to call `session-nudge`, `session-interrupt`, `finish-task`, or wait.
    The cycle command does NOT decide on the manager's behalf — it observes only.
    """
    from workerctl import db as worker_db
    from workerctl import supervise_cycle

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        result = supervise_cycle.run_cycle(conn, task_name=args.task)
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0
```

- [ ] **Step 4: Wire subparser in `workerctl/cli.py`**

Add import: `command_cycle` to the existing import block.

After the `session-interrupt` subparser block (added in Task 3), add:

```python
    cycle = subparsers.add_parser(
        "cycle",
        help="Run one observation cycle for a session-bound task. Returns JSON.",
    )
    cycle.add_argument("task", help="Task name.")
    cycle.set_defaults(func=command_cycle)
```

- [ ] **Step 5: Run CLI tests**

```bash
python3 -m unittest tests.test_workerctl.CycleCliTests -v
```
Expected: 3 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, 244 tests (241 + 3).

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add cycle CLI command for session-bound task observation"
```

---

## Task 7: README docs for Phase 3

**Files:**
- Modify: `README.md` — add Phase 3 subsection.

- [ ] **Step 1: Verify CLI shapes**

Run each of these and confirm the README examples match:
```bash
python3 -m workerctl session-nudge --help
python3 -m workerctl session-interrupt --help
python3 -m workerctl cycle --help
```

- [ ] **Step 2: Add Phase 3 subsection to README**

In `README.md`, find the existing `### Phase 2: Ingest + Tail` subsection (inside `## Manual-Assignment Primitives (Phase 1)`). After it ends and before the next `##` heading, insert:

````markdown
### Phase 3: Observation Cycles + Session Actions

Once a task has an active binding, the manager Codex can drive supervision by
calling `workerctl cycle <task>` to observe the worker, then deciding whether
to nudge, interrupt, finish, or wait. The cycle command is one-shot and stateless;
the manager Codex performs the loop.

```bash
# Observe one cycle (idempotent — runs ingest first, then summarizes state).
workerctl cycle auth-refactor
# Output:
# {
#   "task": "auth-refactor",
#   "binding_id": "binding-...",
#   "worker_session": "auth-worker",
#   "manager_session": "auth-mgr",
#   "ingest": { "new_events": 3, "new_offset": 12345 },
#   "state": "busy",
#   "last_state_event_at": "2026-05-11T14:32:11Z",
#   "staleness_seconds": 4.2,
#   "cycle_id": 17,
#   "cycle_started_at": "2026-05-11T14:32:15Z",
#   "cycle_completed_at": "2026-05-11T14:32:15Z"
# }

# Nudge the worker (text + Enter via the worker's tmux pane).
workerctl session-nudge auth-worker "Status update please"
workerctl session-nudge auth-worker "Status update please" --dry-run

# Interrupt the worker (Ctrl-C by default; --followup to send text after).
workerctl session-interrupt auth-worker
workerctl session-interrupt auth-worker --followup "Stop and report progress"
```

**Worker tmux requirement.** `session-nudge` and `session-interrupt` require the
target session to have been registered with `--tmux-session` (workers running in
tmux). They reject sessions without a tmux pane — e.g. managers running in plain
Codex outside tmux. This is intentional: managers don't receive nudges; only
workers do.

**Manager loop pattern.** A manager Codex running outside tmux supervises by:
1. Calling `workerctl cycle <task>` and parsing the JSON output.
2. Deciding based on `state` and `staleness_seconds` whether to act.
3. Optionally calling `workerctl session-nudge`/`session-interrupt` to act.
4. Sleeping or yielding control, then looping.

The `cycle` command writes a `manager_cycles` row each invocation, providing a
durable audit trail visible via the existing `workerctl audit <task>`.

**State inference (recap from Phase 2):** `task_started`/`user_message` → `busy`;
`task_complete` → `idle`; everything else does not change state. `unknown` means
no state-bearing event has been ingested yet.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document cycle, session-nudge, and session-interrupt in README"
```

---

## Self-Review

**Spec coverage:**
- `last_state_event_timestamp` + `session_staleness_seconds` → Task 1 ✓
- Session-keyed `send_text_to_session` / `interrupt_session` → Task 2 ✓
- CLI `session-nudge` / `session-interrupt` → Task 3 ✓
- `active_binding_for_task` resolver → Task 4 ✓
- `supervise_cycle.run_cycle` orchestrator → Task 5 ✓
- CLI `cycle <task>` → Task 6 ✓
- README docs → Task 7 ✓

**Placeholder scan:** no TBDs; every code step has full code; commands match across tasks.

**Type consistency:**
- `active_binding_for_task` returns `dict[str, Any]` with documented keys (Task 4) — consumed in `run_cycle` (Task 5) reading `worker_session_name`, `worker_session_id`, etc. ✓
- `run_cycle` returns dict with `cycle_id`, `state`, `staleness_seconds`, etc. — CLI Task 6 just `json.dumps` it; tests assert on these keys ✓
- `send_text_to_session` returns `{session, target, text, dry_run, time}` — CLI Task 3 prints and tests assert on `session`/`text`/`dry_run`/`target` ✓
- `interrupt_session` returns similar shape — CLI Task 3 tests assert on `session`/`key`/`dry_run` ✓

**Migration:** Phase 3 does NOT modify schema. No new tables, no new columns. The `manager_cycles` row written by `run_cycle` populates only existing columns; `manager_id` is left NULL (this row is for a session-based cycle).

**Known caveats:**
- Task 5 writes `manager_cycles` with `manager_id` NULL. The schema allows it (no NOT NULL). Future Phase 4/5 may add a `manager_session_id` column for stronger linkage, but Phase 3 lives within the existing schema.
- The cycle command does NOT auto-decide nudge vs. wait. That's a deliberate Phase 3 boundary — the manager Codex (or operator) is the policy brain. Phase 4 may add a recommendation field once the shadow comparison validates the heuristics.

---

## Out of Scope (deferred to later phases)

- **Phase 4:** Shadow JSON-based state and staleness alongside legacy `classify_busy_wait` on a worker capture; log divergence; flip the primary signal in `workerctl supervise` / `workerctl watch` once shadow confirms agreement.
- **Phase 5:** Retire `promote`, `manage`, `become-worker`, `supervise`, `watch`, the worker-first-promotion plan/docs. Trim `workerctl/tmux.py` to the PTY+keys+capture primitives needed by `send_text_to_session` and `interrupt_session`. Collapse `recover`/`reconcile`/`db-doctor`/`close-stale` into one DB-centric reconciliation command.
- **Continuous supervision daemon** (not in Phase 4 or 5 either): the design is "manager Codex loops by calling `cycle` repeatedly." A Python daemon that polls many tasks in one process is a separate concern that can ride later if needed.
