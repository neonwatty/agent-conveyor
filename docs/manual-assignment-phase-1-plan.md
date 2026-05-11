# Manual-Assignment Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up unified `sessions` table, pid→rollout discovery, and new `register-worker` / `register-manager` / `bind` / `unbind` / `deregister` CLI primitives — coexisting with the existing `workers` / `managers` / `promote` / `manage` paths. No supervision change yet; JSON ingester is Phase 2.

**Architecture:** A single `sessions` table (with a `role` column) is added alongside `workers` and `managers`; the existing tables stay live and the new path also writes shim rows into them so existing supervision keeps working. The `bindings` table grows nullable `worker_session_id` / `manager_session_id` columns so new bindings can reference sessions directly (required because a manager outside tmux cannot satisfy the `workers.tmux_session unique not null` constraint). A new `workerctl/codex_session.py` module owns pid→rollout discovery via `lsof`.

**Tech Stack:** Python 3, SQLite (WAL), `argparse` CLI dispatch, `unittest` tests in `tests/test_workerctl.py`. No new third-party dependencies.

**Scope note:** Phase 1 only. Phases 2-5 (JSON ingester, new supervision loop, shadow+flip, retirement of `promote`/`manage`) are separate plans.

---

## File Structure

**Created:**
- `workerctl/codex_session.py` — pid→rollout discovery. Functions: `find_native_codex_pid`, `find_rollout_path_for_pid`, `read_session_meta`, `discover_session`.

**Modified:**
- `workerctl/db.py` — schema v5 migration block (~lines 85-350), new helper functions (append near `upsert_worker` around line 598).
- `workerctl/commands.py` — new `command_register_worker`, `command_register_manager`, `command_bind`, `command_unbind`, `command_deregister`, `command_sessions` (list).
- `workerctl/cli.py` — `add_parser` blocks for the new commands.
- `tests/test_workerctl.py` — new test classes `SessionsSchemaTests`, `CodexSessionDiscoveryTests`, `RegisterCommandsTests`, `BindCommandTests` appended to the file.

**Not touched in Phase 1:**
- `workerctl/supervise.py`, `workerctl/lifecycle.py`, `workerctl/tmux.py` — old supervision/promotion paths stay intact.

---

## Task 1: Codex session discovery module

**Files:**
- Create: `workerctl/codex_session.py`
- Test: `tests/test_workerctl.py` (append `CodexSessionDiscoveryTests` class)

- [ ] **Step 1: Write the failing test for `read_session_meta`**

Append to `tests/test_workerctl.py`:

```python
class CodexSessionDiscoveryTests(unittest.TestCase):
    def test_read_session_meta_parses_first_line(self):
        from workerctl import codex_session

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "rollout-2026-05-11T07-32-08-abc.jsonl"
            meta_line = json.dumps({
                "timestamp": "2026-05-11T14:32:11.791Z",
                "type": "session_meta",
                "payload": {
                    "id": "019e1773-d973-7122-a8d6-f25331ebc8b7",
                    "cwd": "/repo",
                    "originator": "codex-tui",
                    "cli_version": "0.130.0",
                },
            })
            path.write_text(meta_line + "\n" + '{"type":"event_msg"}\n')
            meta = codex_session.read_session_meta(path)

            self.assertEqual(meta["id"], "019e1773-d973-7122-a8d6-f25331ebc8b7")
            self.assertEqual(meta["cwd"], "/repo")
            self.assertEqual(meta["originator"], "codex-tui")

    def test_read_session_meta_raises_on_wrong_type(self):
        from workerctl import codex_session

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "bad.jsonl"
            path.write_text('{"type":"event_msg","payload":{}}\n')
            with self.assertRaises(codex_session.CodexSessionError):
                codex_session.read_session_meta(path)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v
```
Expected: `ModuleNotFoundError: No module named 'workerctl.codex_session'`.

- [ ] **Step 3: Create the module with `read_session_meta`**

Create `workerctl/codex_session.py`:

```python
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


class CodexSessionError(Exception):
    pass


def read_session_meta(path: Path) -> dict[str, Any]:
    """Return the parsed payload of the first `session_meta` record in a rollout file."""
    with open(path, "r") as fh:
        first_line = fh.readline()
    if not first_line:
        raise CodexSessionError(f"rollout file is empty: {path}")
    try:
        record = json.loads(first_line)
    except json.JSONDecodeError as exc:
        raise CodexSessionError(f"rollout file first line is not JSON: {path}") from exc
    if record.get("type") != "session_meta":
        raise CodexSessionError(f"rollout file first record is not session_meta: {path}")
    payload = record.get("payload") or {}
    if not isinstance(payload, dict):
        raise CodexSessionError(f"rollout session_meta payload is not an object: {path}")
    return payload
```

- [ ] **Step 4: Run test to verify it passes**

```bash
python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v
```
Expected: 2 tests PASS.

- [ ] **Step 5: Write failing test for `find_native_codex_pid`**

Append to `CodexSessionDiscoveryTests`:

```python
    def test_find_native_codex_pid_returns_self_when_already_native(self):
        from workerctl import codex_session
        # When the input pid is already a native codex binary, return it unchanged.
        # We stub the helper to make this deterministic.
        result = codex_session.find_native_codex_pid(99999, _ps_children=lambda _: [])
        self.assertEqual(result, 99999)

    def test_find_native_codex_pid_walks_to_child_when_node_wrapper(self):
        from workerctl import codex_session
        # node parent with one native codex child
        children_by_pid = {1000: [2000]}

        def fake_ps_children(pid):
            return children_by_pid.get(pid, [])

        result = codex_session.find_native_codex_pid(1000, _ps_children=fake_ps_children)
        self.assertEqual(result, 2000)
```

- [ ] **Step 6: Run test to verify it fails**

```bash
python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v
```
Expected: `AttributeError: module 'workerctl.codex_session' has no attribute 'find_native_codex_pid'`.

- [ ] **Step 7: Implement `find_native_codex_pid`**

Append to `workerctl/codex_session.py`:

```python
def _ps_children_default(pid: int) -> list[int]:
    """Return direct child pids of `pid` using pgrep -P."""
    pgrep = shutil.which("pgrep")
    if pgrep is None:
        return []
    proc = subprocess.run(
        [pgrep, "-P", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        return []
    return [int(line) for line in proc.stdout.split() if line.strip().isdigit()]


def find_native_codex_pid(pid: int, *, _ps_children=_ps_children_default) -> int:
    """Walk pid's child tree once to find a native codex binary.

    The npm-installed codex CLI runs as `node /opt/homebrew/bin/codex ...` which spawns
    a native binary child that owns the rollout file handle. Return the first child if
    one exists, otherwise return `pid` unchanged.
    """
    children = _ps_children(pid)
    if not children:
        return pid
    return children[0]
```

- [ ] **Step 8: Run test to verify it passes**

```bash
python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v
```
Expected: 4 tests PASS.

- [ ] **Step 9: Write failing test for `find_rollout_path_for_pid`**

Append to `CodexSessionDiscoveryTests`:

```python
    def test_find_rollout_path_for_pid_returns_rollout_handle(self):
        from workerctl import codex_session

        fake_lsof_output = (
            "codex   31507 user   25w  REG  1,17  277502  41320170 "
            "/Users/u/.codex/sessions/2026/05/11/rollout-2026-05-11T10-54-17-abc.jsonl\n"
            "codex   31507 user   26r  REG  1,17     128  12345678 "
            "/Users/u/.codex/config.toml\n"
        )

        def fake_run_lsof(pid):
            return fake_lsof_output

        path = codex_session.find_rollout_path_for_pid(31507, _run_lsof=fake_run_lsof)
        self.assertEqual(
            str(path),
            "/Users/u/.codex/sessions/2026/05/11/rollout-2026-05-11T10-54-17-abc.jsonl",
        )

    def test_find_rollout_path_for_pid_raises_when_no_rollout_open(self):
        from workerctl import codex_session

        def fake_run_lsof(pid):
            return "codex 31507 user 25w REG 1,17 128 9999 /Users/u/.codex/config.toml\n"

        with self.assertRaises(codex_session.CodexSessionError):
            codex_session.find_rollout_path_for_pid(31507, _run_lsof=fake_run_lsof)
```

- [ ] **Step 10: Run test to verify it fails**

```bash
python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v
```
Expected: `AttributeError: ... no attribute 'find_rollout_path_for_pid'`.

- [ ] **Step 11: Implement `find_rollout_path_for_pid`**

Append to `workerctl/codex_session.py`:

```python
def _run_lsof_default(pid: int) -> str:
    lsof = shutil.which("lsof")
    if lsof is None:
        raise CodexSessionError("lsof is not available on PATH")
    proc = subprocess.run(
        [lsof, "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.stdout or ""


def find_rollout_path_for_pid(pid: int, *, _run_lsof=_run_lsof_default) -> Path:
    """Return the rollout JSONL file `pid` holds open for writes.

    Raises CodexSessionError when no rollout file is open (e.g. ephemeral session
    or non-codex pid).
    """
    output = _run_lsof(pid)
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped or stripped.endswith(".jsonl") is False:
            # Cheap path filter; full match is via the last whitespace-delimited token.
            pass
        parts = stripped.rsplit(None, 1)
        if len(parts) < 2:
            continue
        path = parts[-1]
        if "/sessions/" in path and "/rollout-" in path and path.endswith(".jsonl"):
            return Path(path)
    raise CodexSessionError(f"no rollout-*.jsonl file open for pid {pid}")
```

- [ ] **Step 12: Run test to verify it passes**

```bash
python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v
```
Expected: 6 tests PASS.

- [ ] **Step 13: Write failing test for `discover_session`**

Append to `CodexSessionDiscoveryTests`:

```python
    def test_discover_session_combines_lsof_and_meta(self):
        from workerctl import codex_session

        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "rollout-2026-05-11T07-32-08-xyz.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {
                    "id": "session-uuid-xyz",
                    "cwd": "/repo",
                    "originator": "codex-tui",
                    "cli_version": "0.130.0",
                },
            }) + "\n")

            fake_lsof = (
                f"codex 9999 user 25w REG 1,17 100 1 {rollout}\n"
            )

            result = codex_session.discover_session(
                pid=9999,
                _ps_children=lambda _: [],
                _run_lsof=lambda _: fake_lsof,
            )
            self.assertEqual(result["pid"], 9999)
            self.assertEqual(result["codex_session_id"], "session-uuid-xyz")
            self.assertEqual(result["codex_session_path"], str(rollout))
            self.assertEqual(result["cwd"], "/repo")
            self.assertEqual(result["originator"], "codex-tui")
```

- [ ] **Step 14: Run test, expect failure, then implement**

Append to `workerctl/codex_session.py`:

```python
def discover_session(
    *,
    pid: int,
    _ps_children=_ps_children_default,
    _run_lsof=_run_lsof_default,
) -> dict[str, Any]:
    """End-to-end discovery: walk pid tree, find rollout, parse session_meta.

    Returns a dict with keys: `pid`, `native_pid`, `codex_session_path`,
    `codex_session_id`, `cwd`, `originator`, `cli_version`.
    Raises CodexSessionError on any failure.
    """
    native_pid = find_native_codex_pid(pid, _ps_children=_ps_children)
    rollout = find_rollout_path_for_pid(native_pid, _run_lsof=_run_lsof)
    meta = read_session_meta(rollout)
    return {
        "pid": pid,
        "native_pid": native_pid,
        "codex_session_path": str(rollout),
        "codex_session_id": meta["id"],
        "cwd": meta.get("cwd", ""),
        "originator": meta.get("originator", ""),
        "cli_version": meta.get("cli_version", ""),
    }
```

Run: `python -m unittest tests.test_workerctl.CodexSessionDiscoveryTests -v`. Expected: 7 tests PASS.

- [ ] **Step 15: Commit**

```bash
git add workerctl/codex_session.py tests/test_workerctl.py
git commit -m "Add codex_session module for pid→rollout discovery"
```

---

## Task 2: Schema v5 — add `sessions` table with backfill

**Files:**
- Modify: `workerctl/db.py` — bump `SCHEMA_VERSION` to 5, add `sessions` to `REQUIRED_TABLES`, add CREATE TABLE in `migrate`, add backfill in a new `migrate_to_v5_sessions` function.
- Test: `tests/test_workerctl.py` — new class `SessionsSchemaTests`.

- [ ] **Step 1: Write failing test for sessions table schema**

Append to `tests/test_workerctl.py`:

```python
class SessionsSchemaTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_sessions_table_exists_after_init(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            tables = {
                row["name"]
                for row in conn.execute(
                    "select name from sqlite_master where type='table'"
                )
            }
            self.assertIn("sessions", tables)

    def test_sessions_table_has_expected_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
            expected = {
                "id", "name", "role", "identity_token",
                "tmux_session", "tmux_pane_id",
                "codex_session_path", "codex_session_id",
                "pid", "cwd",
                "registered_at", "last_heartbeat_at",
                "state",
            }
            self.assertTrue(expected <= cols, f"missing: {expected - cols}")

    def test_sessions_role_check_constraint(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into sessions(
                      id, name, role, identity_token, cwd, registered_at, state
                    )
                    values ('s-1', 'x', 'bogus', 't', '/tmp', '2026-05-11T00:00:00Z', 'active')
                    """
                )

    def test_sessions_name_unique(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                """
                insert into sessions(
                  id, name, role, identity_token, cwd, registered_at, state
                )
                values ('s-1', 'dup', 'worker', 't1', '/tmp', ?, 'active')
                """,
                (now,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into sessions(
                      id, name, role, identity_token, cwd, registered_at, state
                    )
                    values ('s-2', 'dup', 'manager', 't2', '/tmp', ?, 'active')
                    """,
                    (now,),
                )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m unittest tests.test_workerctl.SessionsSchemaTests -v
```
Expected: 4 tests FAIL — `sessions` table does not exist.

- [ ] **Step 3: Bump schema version and add sessions table**

In `workerctl/db.py`, change `SCHEMA_VERSION = 4` to `SCHEMA_VERSION = 5`.

Add `"sessions"` to `REQUIRED_TABLES` (insert in alphabetical order between `prompts` and `statuses`).

In the `migrate` function, inside the `conn.executescript(...)` block, add this CREATE TABLE after the existing `events` table (around line 303, before the `create unique index` block):

```sql
        create table if not exists sessions(
          id text primary key,
          name text unique not null,
          role text not null check (role in ('worker','manager')),
          identity_token text unique not null,
          tmux_session text,
          tmux_pane_id text,
          codex_session_path text,
          codex_session_id text,
          pid integer,
          cwd text not null,
          registered_at text not null,
          last_heartbeat_at text,
          state text not null check (state in ('active','gone'))
        );
```

- [ ] **Step 4: Run tests to verify the first three pass**

```bash
python -m unittest tests.test_workerctl.SessionsSchemaTests -v
```
Expected: 4 tests PASS.

- [ ] **Step 5: Write failing test for backfill from workers**

Append to `SessionsSchemaTests`:

```python
    def test_backfill_copies_existing_workers_to_sessions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            # Manually open a v4-style DB, insert a worker row, then run init to migrate.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                """
                insert into workers(
                  id, name, tmux_session, identity_token, cwd, state, created_at, updated_at
                )
                values ('worker-99', 'legacy-w', 'codex-legacy-w', 'tok-99', '/repo', 'active', ?, ?)
                """,
                (now, now),
            )
            conn.commit()
            conn.close()

            # Drop sessions table to simulate pre-v5, force re-init to backfill.
            conn = worker_db.connect(db_path)
            conn.execute("drop table sessions")
            conn.execute("PRAGMA user_version = 4")
            conn.commit()
            conn.close()

            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            row = conn.execute(
                "select id, name, role, cwd from sessions where id = 'worker-99'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["name"], "legacy-w")
            self.assertEqual(row["role"], "worker")
            self.assertEqual(row["cwd"], "/repo")

    def test_backfill_copies_existing_managers_to_sessions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            # Need a task first for the FK
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            conn.execute(
                """
                insert into managers(
                  id, name, task_id, tmux_session, state, codex_args_json, started_at
                )
                values ('manager-77', 'legacy-m', 'task-1', 'codex-legacy-m', 'ready', '[]', ?)
                """,
                (now,),
            )
            conn.commit()
            conn.close()

            conn = worker_db.connect(db_path)
            conn.execute("drop table sessions")
            conn.execute("PRAGMA user_version = 4")
            conn.commit()
            conn.close()

            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            row = conn.execute(
                "select id, name, role from sessions where id = 'manager-77'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["name"], "legacy-m")
            self.assertEqual(row["role"], "manager")
```

- [ ] **Step 6: Run tests to confirm backfill not yet present**

```bash
python -m unittest tests.test_workerctl.SessionsSchemaTests -v
```
Expected: 2 backfill tests FAIL with `None` rows.

- [ ] **Step 7: Add backfill function**

In `workerctl/db.py`, after the existing `migrate_worker_name_ids` function, add:

```python
def migrate_to_v5_sessions(conn: sqlite3.Connection) -> None:
    """Backfill `sessions` from existing `workers` and `managers` rows.

    Idempotent: uses `insert or ignore` so re-running does not duplicate. Maps:
    - workers → sessions with role='worker', state='active' (regardless of legacy state).
    - managers → sessions with role='manager', state='active'.

    Codex-session fields (path, id, pid) are left null; they only populate for sessions
    registered via the new `register-*` commands.
    """
    now = now_iso()
    worker_rows = conn.execute(
        """
        select id, name, tmux_session, tmux_pane_id, identity_token, cwd, created_at
        from workers
        """
    ).fetchall()
    for row in worker_rows:
        conn.execute(
            """
            insert or ignore into sessions(
              id, name, role, identity_token,
              tmux_session, tmux_pane_id,
              cwd, registered_at, state
            )
            values (?, ?, 'worker', ?, ?, ?, ?, ?, 'active')
            """,
            (
                row["id"], row["name"], row["identity_token"],
                row["tmux_session"], row["tmux_pane_id"],
                row["cwd"], row["created_at"] or now,
            ),
        )

    manager_rows = conn.execute(
        """
        select m.id, m.name, m.tmux_session, m.tmux_pane_id, m.started_at, t.id as task_id
        from managers m
        left join tasks t on t.id = m.task_id
        """
    ).fetchall()
    for row in manager_rows:
        conn.execute(
            """
            insert or ignore into sessions(
              id, name, role, identity_token,
              tmux_session, tmux_pane_id,
              cwd, registered_at, state
            )
            values (?, ?, 'manager', ?, ?, ?, ?, ?, 'active')
            """,
            (
                row["id"], row["name"], f"manager-token-{row['id']}",
                row["tmux_session"], row["tmux_pane_id"],
                "",  # historical managers don't track cwd separately; empty is acceptable
                row["started_at"] or now,
            ),
        )
```

In `migrate`, after the existing `if from_version < 2: migrate_worker_name_ids(conn)` call, add:

```python
    if from_version < 5:
        migrate_to_v5_sessions(conn)
```

- [ ] **Step 8: Run tests to verify backfill passes**

```bash
python -m unittest tests.test_workerctl.SessionsSchemaTests -v
```
Expected: 6 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add sessions table with backfill from workers and managers"
```

---

## Task 3: Schema v5 — add session_id columns to `bindings`

**Files:**
- Modify: `workerctl/db.py` — change `bindings` CREATE TABLE; add migration step that ALTERs the existing table.
- Test: `tests/test_workerctl.py` — append to `SessionsSchemaTests`.

- [ ] **Step 1: Write failing test for new bindings columns**

Append to `SessionsSchemaTests`:

```python
    def test_bindings_has_session_id_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(bindings)")}
            self.assertIn("worker_session_id", cols)
            self.assertIn("manager_session_id", cols)

    def test_bindings_worker_id_now_nullable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            conn.execute(
                "insert into sessions(id, name, role, identity_token, cwd, registered_at, state) "
                "values ('s-w', 'w', 'worker', 'tok-w', '/tmp', ?, 'active')",
                (now,),
            )
            conn.execute(
                "insert into sessions(id, name, role, identity_token, cwd, registered_at, state) "
                "values ('s-m', 'm', 'manager', 'tok-m', '/tmp', ?, 'active')",
                (now,),
            )
            # Insert binding without legacy worker_id / manager_id — should succeed.
            conn.execute(
                """
                insert into bindings(
                  id, task_id, worker_session_id, manager_session_id, state, created_at
                )
                values ('b-1', 'task-1', 's-w', 's-m', 'active', ?)
                """,
                (now,),
            )
            row = conn.execute(
                "select worker_id, worker_session_id from bindings where id='b-1'"
            ).fetchone()
            self.assertIsNone(row["worker_id"])
            self.assertEqual(row["worker_session_id"], "s-w")
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python -m unittest tests.test_workerctl.SessionsSchemaTests -v
```
Expected: 2 new tests FAIL — columns missing / NOT NULL violation.

- [ ] **Step 3: Update bindings schema in migrate**

In `workerctl/db.py`, replace the existing `create table if not exists bindings(...)` block (currently around lines 140-148) with:

```sql
        create table if not exists bindings(
          id text primary key,
          task_id text not null references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          worker_session_id text references sessions(id),
          manager_session_id text references sessions(id),
          state text not null check (state in ('active','ending','ended','invalid')),
          created_at text not null,
          ended_at text
        );
```

Note: `worker_id` was previously `NOT NULL`. For freshly created databases, the new schema makes it nullable. For existing databases, `create table if not exists` is a no-op — we need an ALTER step.

- [ ] **Step 4: Add ALTER step for existing databases**

In `migrate_to_v5_sessions`, before the worker backfill loop, add:

```python
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(bindings)")}
    if "worker_session_id" not in existing_cols:
        # SQLite has no DROP NOT NULL; we rebuild the table to make worker_id nullable
        # and to add the new columns. Wrapped in a transaction in the caller.
        conn.executescript(
            """
            alter table bindings rename to bindings_v4;
            create table bindings(
              id text primary key,
              task_id text not null references tasks(id),
              worker_id text references workers(id),
              manager_id text references managers(id),
              worker_session_id text references sessions(id),
              manager_session_id text references sessions(id),
              state text not null check (state in ('active','ending','ended','invalid')),
              created_at text not null,
              ended_at text
            );
            insert into bindings(
              id, task_id, worker_id, manager_id,
              worker_session_id, manager_session_id,
              state, created_at, ended_at
            )
            select id, task_id, worker_id, manager_id, null, null, state, created_at, ended_at
            from bindings_v4;
            drop table bindings_v4;
            """
        )
        # Re-create the existing unique indexes which were dropped with the table.
        conn.executescript(
            """
            create unique index if not exists one_active_binding_per_worker
              on bindings(worker_id) where state in ('active', 'ending');
            create unique index if not exists one_active_binding_per_task
              on bindings(task_id) where state in ('active', 'ending');
            create unique index if not exists one_active_binding_per_worker_session
              on bindings(worker_session_id) where state in ('active', 'ending');
            create unique index if not exists one_active_binding_per_manager_session
              on bindings(manager_session_id) where state in ('active', 'ending');
            """
        )
```

Also add `one_active_binding_per_worker_session` and `one_active_binding_per_manager_session` to `REQUIRED_INDEXES` in alphabetical order.

- [ ] **Step 5: Run tests to verify pass**

```bash
python -m unittest tests.test_workerctl.SessionsSchemaTests -v
```
Expected: all SessionsSchemaTests PASS.

- [ ] **Step 6: Run full existing test suite to verify no regression**

```bash
python -m unittest tests.test_workerctl -v 2>&1 | tail -20
```
Expected: previous test count + new tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add session_id columns to bindings with ALTER migration"
```

---

## Task 4: `db.py` — `register_session` and `session_row` helpers

**Files:**
- Modify: `workerctl/db.py` — add helpers near `upsert_worker` (~line 598).
- Test: `tests/test_workerctl.py` — append `RegisterCommandsTests` class.

- [ ] **Step 1: Write failing test for `register_session`**

Append to `tests/test_workerctl.py`:

```python
class RegisterCommandsTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_register_session_inserts_new_worker(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn,
                name="auth-worker",
                role="worker",
                codex_session_path="/path/to/rollout.jsonl",
                codex_session_id="codex-uuid-1",
                pid=12345,
                cwd="/repo",
                tmux_session="codex-auth-worker",
                tmux_pane_id="%5",
            )
            self.assertTrue(session_id.startswith("session-"))
            row = conn.execute(
                "select * from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["name"], "auth-worker")
            self.assertEqual(row["role"], "worker")
            self.assertEqual(row["pid"], 12345)
            self.assertEqual(row["state"], "active")

    def test_register_session_idempotent_on_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            id1 = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u1", pid=1, cwd="/repo",
            )
            id2 = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u1", pid=2, cwd="/repo",
            )
            self.assertEqual(id1, id2)
            row = conn.execute("select pid from sessions where id = ?", (id1,)).fetchone()
            self.assertEqual(row["pid"], 2)  # pid updated on re-register

    def test_register_session_rejects_role_change(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="x", role="worker", codex_session_path="/a",
                codex_session_id="u1", pid=1, cwd="/repo",
            )
            with self.assertRaises(WorkerError):
                worker_db.register_session(
                    conn, name="x", role="manager", codex_session_path="/a",
                    codex_session_id="u1", pid=2, cwd="/repo",
                )

    def test_register_session_creates_manager_without_tmux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="m1", role="manager", codex_session_path="/a",
                codex_session_id="u-m", pid=99, cwd="/repo",
            )
            row = conn.execute("select tmux_session, role from sessions where id = ?", (session_id,)).fetchone()
            self.assertIsNone(row["tmux_session"])
            self.assertEqual(row["role"], "manager")
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python -m unittest tests.test_workerctl.RegisterCommandsTests -v
```
Expected: 4 tests FAIL — `AttributeError: 'workerctl.db' has no attribute 'register_session'`.

- [ ] **Step 3: Implement `register_session`**

Add to `workerctl/db.py` (after `upsert_worker`, around line 632):

```python
def register_session(
    conn: sqlite3.Connection,
    *,
    name: str,
    role: str,
    codex_session_path: str,
    codex_session_id: str,
    pid: int,
    cwd: str,
    tmux_session: str | None = None,
    tmux_pane_id: str | None = None,
    identity_token: str | None = None,
    timestamp: str | None = None,
) -> str:
    """Idempotent upsert into `sessions`. Returns the session id.

    On conflict by name: updates pid, codex_session_path, codex_session_id, tmux fields,
    and state='active'. Raises WorkerError if a row exists with the same name but a
    different role.
    """
    if role not in ("worker", "manager"):
        raise WorkerError(f"invalid session role: {role}")
    now = timestamp or now_iso()
    existing = conn.execute(
        "select id, role, identity_token from sessions where name = ?", (name,)
    ).fetchone()
    if existing is not None and existing["role"] != role:
        raise WorkerError(
            f"session name {name!r} already exists with role {existing['role']!r}; "
            f"refusing to re-register as {role!r}"
        )
    session_id = str(existing["id"]) if existing else f"session-{uuid.uuid4()}"
    token = (existing["identity_token"] if existing else None) or identity_token or f"session-token-{uuid.uuid4()}"
    conn.execute(
        """
        insert into sessions(
          id, name, role, identity_token,
          tmux_session, tmux_pane_id,
          codex_session_path, codex_session_id, pid,
          cwd, registered_at, last_heartbeat_at, state
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        on conflict(name) do update set
          tmux_session = excluded.tmux_session,
          tmux_pane_id = coalesce(excluded.tmux_pane_id, sessions.tmux_pane_id),
          codex_session_path = excluded.codex_session_path,
          codex_session_id = excluded.codex_session_id,
          pid = excluded.pid,
          cwd = excluded.cwd,
          last_heartbeat_at = excluded.last_heartbeat_at,
          state = 'active'
        """,
        (
            session_id, name, role, token,
            tmux_session, tmux_pane_id,
            codex_session_path, codex_session_id, pid,
            cwd, now, now,
        ),
    )
    return session_id


def session_row(conn: sqlite3.Connection, *, name: str, role: str | None = None) -> sqlite3.Row:
    """Look up a session by name. Optionally verify role. Raises WorkerError if missing or role mismatch."""
    row = conn.execute("select * from sessions where name = ?", (name,)).fetchone()
    if row is None:
        raise WorkerError(f"no session registered with name {name!r}")
    if role is not None and row["role"] != role:
        raise WorkerError(f"session {name!r} has role {row['role']!r}, expected {role!r}")
    return row


def list_sessions(conn: sqlite3.Connection, *, role: str | None = None) -> list[dict[str, Any]]:
    query = "select * from sessions"
    params: tuple = ()
    if role is not None:
        query += " where role = ?"
        params = (role,)
    query += " order by registered_at"
    return [dict(row) for row in conn.execute(query, params)]


def deregister_session(conn: sqlite3.Connection, *, name: str, timestamp: str | None = None) -> None:
    now = timestamp or now_iso()
    cursor = conn.execute(
        "update sessions set state='gone', last_heartbeat_at=? where name=?",
        (now, name),
    )
    if cursor.rowcount == 0:
        raise WorkerError(f"no session registered with name {name!r}")
```

- [ ] **Step 4: Run tests to verify pass**

```bash
python -m unittest tests.test_workerctl.RegisterCommandsTests -v
```
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add register_session / session_row / list_sessions / deregister_session helpers"
```

---

## Task 5: `db.py` — `bind_sessions` and `unbind_task` helpers

**Files:**
- Modify: `workerctl/db.py` — add helpers near existing `bind_task_worker` (~line 1446).
- Test: `tests/test_workerctl.py` — append `BindCommandTests`.

- [ ] **Step 1: Write failing tests for `bind_sessions`**

Append to `tests/test_workerctl.py`:

```python
class BindCommandTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def setup_pair(self, conn):
        now = "2026-05-11T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values ('task-1', 'auth-refactor', 'g', 'candidate', ?, ?)",
            (now, now),
        )
        worker_db.register_session(
            conn, name="w1", role="worker", codex_session_path="/a",
            codex_session_id="cuid-w", pid=1, cwd="/repo",
        )
        worker_db.register_session(
            conn, name="m1", role="manager", codex_session_path="/b",
            codex_session_id="cuid-m", pid=2, cwd="/repo",
        )

    def test_bind_sessions_creates_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn,
                task_name="auth-refactor",
                worker_session_name="w1",
                manager_session_name="m1",
            )
            self.assertTrue(binding_id.startswith("binding-"))
            row = conn.execute(
                "select * from bindings where id = ?", (binding_id,)
            ).fetchone()
            self.assertEqual(row["state"], "active")
            self.assertEqual(row["task_id"], "task-1")
            self.assertIsNotNone(row["worker_session_id"])
            self.assertIsNotNone(row["manager_session_id"])
            self.assertIsNone(row["worker_id"])
            self.assertIsNone(row["manager_id"])

    def test_bind_sessions_rejects_double_bind_same_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            worker_db.register_session(
                conn, name="m2", role="manager", codex_session_path="/c",
                codex_session_id="cuid-m2", pid=3, cwd="/repo",
            )
            with self.assertRaises(WorkerError):
                worker_db.bind_sessions(
                    conn, task_name="auth-refactor",
                    worker_session_name="w1", manager_session_name="m2",
                )

    def test_bind_sessions_rejects_role_mismatch(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            with self.assertRaises(WorkerError):
                worker_db.bind_sessions(
                    conn, task_name="auth-refactor",
                    worker_session_name="m1",  # wrong role
                    manager_session_name="w1",
                )

    def test_unbind_task_ends_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            worker_db.unbind_task(conn, task_name="auth-refactor")
            row = conn.execute(
                "select state, ended_at from bindings where id = ?", (binding_id,)
            ).fetchone()
            self.assertEqual(row["state"], "ended")
            self.assertIsNotNone(row["ended_at"])
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python -m unittest tests.test_workerctl.BindCommandTests -v
```
Expected: 4 tests FAIL — `bind_sessions` not defined.

- [ ] **Step 3: Implement `bind_sessions` and `unbind_task`**

Add to `workerctl/db.py` (after `bind_task_worker`, around line 1519):

```python
def bind_sessions(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    worker_session_name: str,
    manager_session_name: str,
    timestamp: str | None = None,
) -> str:
    """Create an active binding between a task and a (worker, manager) session pair.

    Uses the new `worker_session_id` / `manager_session_id` columns. Raises WorkerError
    on missing task/session, role mismatch, or pre-existing active binding for the task.
    """
    now = timestamp or now_iso()
    task = task_row(conn, task=task_name)
    worker_sess = session_row(conn, name=worker_session_name, role="worker")
    manager_sess = session_row(conn, name=manager_session_name, role="manager")

    existing = conn.execute(
        "select id from bindings where task_id = ? and state in ('active','ending')",
        (task["id"],),
    ).fetchone()
    if existing is not None:
        raise WorkerError(
            f"task {task_name!r} already has an active binding {existing['id']!r}"
        )

    binding_id = f"binding-{uuid.uuid4()}"
    conn.execute(
        """
        insert into bindings(
          id, task_id, worker_session_id, manager_session_id, state, created_at
        )
        values (?, ?, ?, ?, 'active', ?)
        """,
        (binding_id, task["id"], worker_sess["id"], manager_sess["id"], now),
    )
    return binding_id


def unbind_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    timestamp: str | None = None,
) -> None:
    """End the active binding for `task_name`. No-op if no active binding."""
    now = timestamp or now_iso()
    task = task_row(conn, task=task_name)
    cursor = conn.execute(
        "update bindings set state='ended', ended_at=? "
        "where task_id=? and state in ('active','ending')",
        (now, task["id"]),
    )
    if cursor.rowcount == 0:
        raise WorkerError(f"no active binding for task {task_name!r}")
```

- [ ] **Step 4: Run tests to verify pass**

```bash
python -m unittest tests.test_workerctl.BindCommandTests -v
```
Expected: 4 tests PASS.

- [ ] **Step 5: Run full test suite to verify no regression**

```bash
python -m unittest tests.test_workerctl 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add bind_sessions and unbind_task helpers"
```

---

## Task 6: CLI commands — `register-worker`, `register-manager`, `deregister`, `sessions`

**Files:**
- Modify: `workerctl/commands.py` — add `command_register_worker`, `command_register_manager`, `command_deregister`, `command_sessions`.
- Modify: `workerctl/cli.py` — add `add_parser` blocks and import the new commands.
- Test: `tests/test_workerctl.py` — append CLI tests inside `RegisterCommandsTests`.

- [ ] **Step 1: Write failing CLI test for `register-worker`**

Append to `RegisterCommandsTests`:

```python
    def run_cli(self, *args, env_extra=None):
        # Use the workerctl script directly to exercise the full argparse path.
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        proc = subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(ROOT),
        )
        return proc

    def test_cli_register_worker_with_explicit_session_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Build a fake rollout file
            rollout = Path(tmpdir) / "rollout-2026-05-11-fake.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "fake-uuid", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")

            db_path = Path(tmpdir) / "state" / "workerctl.db"
            db_path.parent.mkdir(parents=True)

            proc = self.run_cli(
                "register-worker",
                "--name", "test-w",
                "--codex-session", str(rollout),
                "--pid", "12345",
                "--cwd", str(ROOT),
                env_extra={"WORKERCTL_STATE_ROOT": str(tmpdir) + "/state"},
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            row = conn.execute(
                "select role, pid, codex_session_id from sessions where name='test-w'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["role"], "worker")
            self.assertEqual(row["pid"], 12345)
            self.assertEqual(row["codex_session_id"], "fake-uuid")
```

Note: this test requires `WORKERCTL_STATE_ROOT` env-var support if not already present; check `workerctl/state.py` `state_root()` — if it doesn't honor an env var, add that hook before relying on it. (Look at existing `state_root` and use the env var it already supports, or fall back to passing `--db` if such a flag exists.)

- [ ] **Step 2: Verify env-var hook**

Run: `grep -n "state_root\|WORKERCTL_STATE_ROOT\|env" /Users/neonwatty/Desktop/codex-terminal-manager/workerctl/state.py | head -10`

If no env-var hook exists, add this minimal hook to the top of `state_root()` in `workerctl/state.py`:

```python
def state_root() -> Path:
    override = os.environ.get("WORKERCTL_STATE_ROOT")
    if override:
        return Path(override)
    # ... existing body unchanged ...
```

Commit this small change separately if added.

- [ ] **Step 3: Run test to verify failure (command unknown)**

```bash
python -m unittest tests.test_workerctl.RegisterCommandsTests.test_cli_register_worker_with_explicit_session_path -v
```
Expected: FAIL with non-zero exit code, stderr mentioning unknown subcommand.

- [ ] **Step 4: Add command functions to `commands.py`**

Append to `workerctl/commands.py`:

```python
def _register_session_from_args(args: argparse.Namespace, *, role: str) -> dict:
    from workerctl import codex_session as cs
    from workerctl import db as worker_db

    if args.codex_session:
        rollout_path = Path(args.codex_session)
        meta = cs.read_session_meta(rollout_path)
        codex_session_path = str(rollout_path)
        codex_session_id = meta["id"]
        cwd = args.cwd or meta.get("cwd", "")
        pid = args.pid
        if pid is None:
            raise WorkerError("--pid is required when --codex-session is supplied")
    elif args.pid is not None:
        info = cs.discover_session(pid=args.pid)
        codex_session_path = info["codex_session_path"]
        codex_session_id = info["codex_session_id"]
        cwd = args.cwd or info["cwd"]
        pid = args.pid
    else:
        raise WorkerError("must supply --pid or --codex-session")

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        session_id = worker_db.register_session(
            conn,
            name=args.name,
            role=role,
            codex_session_path=codex_session_path,
            codex_session_id=codex_session_id,
            pid=pid,
            cwd=cwd,
            tmux_session=getattr(args, "tmux_session", None),
        )
        conn.commit()
        worker_db.insert_event(
            conn,
            "session_registered",
            actor="workerctl",
            payload={
                "name": args.name, "role": role, "session_id": session_id,
                "pid": pid, "codex_session_id": codex_session_id,
            },
        )
        conn.commit()
        return {
            "session_id": session_id, "name": args.name, "role": role,
            "pid": pid, "codex_session_id": codex_session_id,
            "codex_session_path": codex_session_path, "cwd": cwd,
        }
    finally:
        conn.close()


def command_register_worker(args: argparse.Namespace) -> int:
    result = _register_session_from_args(args, role="worker")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_register_manager(args: argparse.Namespace) -> int:
    result = _register_session_from_args(args, role="manager")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_deregister(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        worker_db.deregister_session(conn, name=args.name)
        worker_db.insert_event(
            conn, "session_deregistered", actor="workerctl",
            payload={"name": args.name},
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps({"name": args.name, "state": "gone"}))
    return 0


def command_sessions(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        rows = worker_db.list_sessions(conn, role=args.role)
    finally:
        conn.close()
    print(json.dumps(rows, indent=2, sort_keys=True, default=str))
    return 0
```

Ensure `import argparse`, `import json`, `from pathlib import Path` and `from workerctl.core import WorkerError` are already imported in `commands.py` (they likely are — verify).

- [ ] **Step 5: Wire the new subcommands in `cli.py`**

Add to the `from workerctl.commands import (...)` block:

```python
    command_register_worker,
    command_register_manager,
    command_deregister,
    command_sessions,
```

In `build_parser`, after the existing `tasks = subparsers.add_parser("tasks", ...)` block, add:

```python
    register_worker = subparsers.add_parser(
        "register-worker",
        help="Register an existing Codex session as a worker.",
    )
    register_worker.add_argument("--name", required=True, help="Logical name for the session.")
    register_worker.add_argument("--pid", type=int, help="Pid of the running codex process.")
    register_worker.add_argument("--codex-session", help="Path to the rollout-*.jsonl file (skips lsof discovery).")
    register_worker.add_argument("--cwd", help="Working directory; defaults to value in session_meta.")
    register_worker.add_argument("--tmux-session", help="Optional tmux session name if the worker is in tmux.")
    register_worker.set_defaults(func=command_register_worker)

    register_manager = subparsers.add_parser(
        "register-manager",
        help="Register an existing Codex session as a manager (tmux not required).",
    )
    register_manager.add_argument("--name", required=True)
    register_manager.add_argument("--pid", type=int)
    register_manager.add_argument("--codex-session")
    register_manager.add_argument("--cwd")
    register_manager.add_argument("--tmux-session")
    register_manager.set_defaults(func=command_register_manager)

    deregister = subparsers.add_parser(
        "deregister",
        help="Mark a registered session as gone. Does not stop any process.",
    )
    deregister.add_argument("name", help="Session name to deregister.")
    deregister.set_defaults(func=command_deregister)

    sessions = subparsers.add_parser(
        "sessions",
        help="List registered sessions (workers and managers).",
    )
    sessions.add_argument("--role", choices=("worker", "manager"), default=None)
    sessions.set_defaults(func=command_sessions)
```

- [ ] **Step 6: Run the CLI test to verify it passes**

```bash
python -m unittest tests.test_workerctl.RegisterCommandsTests.test_cli_register_worker_with_explicit_session_path -v
```
Expected: PASS.

- [ ] **Step 7: Add tests for `register-manager`, `deregister`, and `sessions`**

Append to `RegisterCommandsTests`:

```python
    def test_cli_register_manager_without_tmux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "rollout-fake-mgr.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "mgr-uuid", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()

            proc = self.run_cli(
                "register-manager",
                "--name", "test-m",
                "--codex-session", str(rollout),
                "--pid", "99999",
                "--cwd", str(ROOT),
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select role, tmux_session, codex_session_id from sessions where name='test-m'"
            ).fetchone()
            self.assertEqual(row["role"], "manager")
            self.assertIsNone(row["tmux_session"])
            self.assertEqual(row["codex_session_id"], "mgr-uuid")

    def test_cli_sessions_lists_registered(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)

            proc = self.run_cli("sessions", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            names = {r["name"] for r in rows}
            self.assertEqual(names, {"w", "m"})

    def test_cli_deregister_marks_gone(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            proc = self.run_cli("deregister", "w", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute("select state from sessions where name='w'").fetchone()
            self.assertEqual(row["state"], "gone")
```

- [ ] **Step 8: Run all CLI tests to verify pass**

```bash
python -m unittest tests.test_workerctl.RegisterCommandsTests -v
```
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py workerctl/state.py tests/test_workerctl.py
git commit -m "Add register-worker, register-manager, deregister, sessions CLI commands"
```

---

## Task 7: CLI commands — `bind` and `unbind`

**Files:**
- Modify: `workerctl/commands.py` — add `command_bind`, `command_unbind`.
- Modify: `workerctl/cli.py` — add `add_parser` blocks.
- Test: `tests/test_workerctl.py` — append to `BindCommandTests`.

- [ ] **Step 1: Write failing test for `bind` CLI**

Append to `BindCommandTests`:

```python
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def test_cli_bind_creates_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("tasks", "create", "myTask", "--goal", "do the thing", env_extra=env)

            proc = self.run_cli(
                "bind", "--task", "myTask", "--worker", "w", "--manager", "m",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["binding_id"].startswith("binding-"))

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select state, worker_session_id, manager_session_id from bindings "
                "where id = ?", (payload["binding_id"],),
            ).fetchone()
            self.assertEqual(row["state"], "active")
            self.assertIsNotNone(row["worker_session_id"])
            self.assertIsNotNone(row["manager_session_id"])

    def test_cli_unbind_ends_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("tasks", "create", "myTask", "--goal", "do it", env_extra=env)
            self.run_cli("bind", "--task", "myTask", "--worker", "w", "--manager", "m", env_extra=env)

            proc = self.run_cli("unbind", "--task", "myTask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute("select state from bindings where task_id=(select id from tasks where name='myTask')").fetchone()
            self.assertEqual(row["state"], "ended")
```

Verify the existing `tasks create` CLI shape — check `command_tasks` in `commands.py`. If `tasks create <name> --goal <text>` is not the exact form, adapt the test (and note it here so the implementation matches the existing pattern). If the existing CLI uses something different, update the test args to match before proceeding.

- [ ] **Step 2: Run to confirm failure**

```bash
python -m unittest tests.test_workerctl.BindCommandTests.test_cli_bind_creates_binding -v
```
Expected: FAIL — unknown subcommand `bind`.

- [ ] **Step 3: Implement `command_bind` and `command_unbind`**

Append to `workerctl/commands.py`:

```python
def command_bind(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        binding_id = worker_db.bind_sessions(
            conn,
            task_name=args.task,
            worker_session_name=args.worker,
            manager_session_name=args.manager,
        )
        conn.commit()
        worker_db.insert_event(
            conn, "binding_created", actor="workerctl",
            payload={
                "binding_id": binding_id, "task": args.task,
                "worker": args.worker, "manager": args.manager,
            },
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps({
        "binding_id": binding_id, "task": args.task,
        "worker": args.worker, "manager": args.manager,
    }, indent=2, sort_keys=True))
    return 0


def command_unbind(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        worker_db.unbind_task(conn, task_name=args.task)
        conn.commit()
        worker_db.insert_event(
            conn, "binding_ended", actor="workerctl",
            payload={"task": args.task},
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps({"task": args.task, "state": "ended"}))
    return 0
```

- [ ] **Step 4: Wire the subcommands in `cli.py`**

Add to the import block in `cli.py`:

```python
    command_bind,
    command_unbind,
```

In `build_parser`, after the `sessions` subparser block from Task 6, add:

```python
    bind = subparsers.add_parser(
        "bind",
        help="Bind a worker and manager session pair to a task.",
    )
    bind.add_argument("--task", required=True, help="Task name.")
    bind.add_argument("--worker", required=True, help="Worker session name.")
    bind.add_argument("--manager", required=True, help="Manager session name.")
    bind.set_defaults(func=command_bind)

    unbind = subparsers.add_parser(
        "unbind",
        help="End the active binding for a task.",
    )
    unbind.add_argument("--task", required=True, help="Task name.")
    unbind.set_defaults(func=command_unbind)
```

- [ ] **Step 5: Run the bind tests**

```bash
python -m unittest tests.test_workerctl.BindCommandTests -v
```
Expected: all PASS.

- [ ] **Step 6: Run full suite to verify no regression**

```bash
python -m unittest tests.test_workerctl 2>&1 | tail -5
```
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add bind and unbind CLI commands"
```

---

## Task 8: README — document the new primitives

**Files:**
- Modify: `README.md` — add a section under or near "Current MVP Usage".

- [ ] **Step 1: Add a new section to README.md**

Insert this section in `README.md` after the "Current MVP Usage" section:

````markdown
## Manual-Assignment Primitives (Phase 1)

The new path lets you register an already-running Codex session as a worker or manager
and bind them to a task explicitly. These commands coexist with `promote`/`manage`;
existing supervision still uses the older path until Phase 2 lands the JSON ingester.

```bash
# Register a worker (auto-discovers rollout via lsof on pid)
workerctl register-worker --name auth-worker --pid $WORKER_PID --cwd "$PWD"

# Register a manager — tmux NOT required
workerctl register-manager --name auth-mgr --pid $MGR_PID --cwd "$PWD"

# Create a task (existing command)
workerctl tasks create auth-refactor --goal "Finish the auth refactor"

# Bind them
workerctl bind --task auth-refactor --worker auth-worker --manager auth-mgr

# Observe
workerctl sessions
workerctl sessions --role worker

# Clean up
workerctl unbind --task auth-refactor
workerctl deregister auth-mgr
workerctl deregister auth-worker
```

If `lsof` discovery fails (e.g. the codex session was started with `--ephemeral`), supply
the rollout path explicitly:

```bash
workerctl register-worker --name w --pid $PID \
  --codex-session ~/.codex/sessions/2026/05/11/rollout-...-<uuid>.jsonl
```

**Phase 1 scope:** these primitives create durable DB records only. Supervision still
runs through `promote`/`manage`/`supervise` against the legacy worker/manager records.
The JSON ingester and the manual-binding supervision loop come in Phase 2.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document manual-assignment primitives in README"
```

---

## Self-Review

**Spec coverage:**
- Unified `sessions` table with role column → Task 2 ✓
- `register-worker`, `register-manager` → Task 6 ✓
- `bind`, `unbind` → Task 7 ✓
- `deregister` → Task 6 ✓
- `sessions` (list) → Task 6 ✓
- Manager outside tmux → Task 4 (`tmux_session` nullable in `sessions`) + Task 6 (CLI doesn't require `--tmux-session`) ✓
- Codex JSON path discovery via lsof → Task 1 ✓
- Backfill from existing workers/managers → Task 2 ✓
- Coexistence with `promote`/`manage` → not touching old paths, retirement is Phase 5 ✓

**Placeholder scan:** no TBDs, no "add appropriate error handling", every code step has full code.

**Type consistency:**
- `register_session` returns `str` (session id) in Task 4; consumed by `command_register_*` in Task 6 — consistent.
- `bind_sessions` takes `task_name`, `worker_session_name`, `manager_session_name` in Task 5; CLI passes `args.task`, `args.worker`, `args.manager` mapped to those parameters in Task 7 — consistent.
- `session_row` returns `sqlite3.Row` in Task 4; consumed via `["id"]` in `bind_sessions` — consistent.

**Known caveats flagged inline:**
- Task 6 Step 2: state-root env-var hook may need to be added to `state.py` if not present.
- Task 7 Step 1: verify `tasks create --goal` matches existing `command_tasks` shape; adapt test if not.

---

## Out of Scope (deferred to later phases)

- **Phase 2:** Codex JSON ingester (`workerctl.ingest`), `tail` command, JSON-based state/idle inference.
- **Phase 3:** New supervision loop using `bind`+JSON; manager-outside-tmux execution end-to-end.
- **Phase 4:** Shadow JSON-based idle alongside pane-based; log divergence; flip primary signal.
- **Phase 5:** Retire `promote`, `manage`, `become-worker`, worker-first-promotion docs. Trim `workerctl/tmux.py` to PTY + send-keys + capture only. Collapse `recover`/`reconcile`/`db-doctor`/`close-stale`.
