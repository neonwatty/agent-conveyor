# Manual-Assignment Redesign — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Codex JSON ingester — given a registered session (Phase 1), read new events from its rollout JSONL, persist them to a new `codex_events` table, track byte offsets for incremental reads, update session heartbeat, and expose the stream via `workerctl tail`. Does NOT change supervision; Phase 3 will consume this.

**Architecture:** A new `workerctl/ingest.py` module owns three responsibilities behind small functions: (1) parsing new JSONL bytes from a session's rollout file into event records, (2) inferring high-level state (`busy` / `idle` / `unknown`) from `event_msg` subtypes, (3) orchestrating one ingest cycle for a session — read new bytes, persist events, advance the offset, update heartbeat. Schema v6 adds a `codex_events` table keyed by `session_id` and a `last_ingest_offset` column on `sessions`. CLI surface adds `workerctl ingest <session>` (idempotent one-shot ingest) and `workerctl tail <session>` (DB-backed event view).

**Tech Stack:** Python 3, SQLite (WAL), `unittest`, stdlib only. No new third-party deps.

**Scope note:** Phase 2 only. Out of scope: continuous tail daemon, `--follow` mode, supervision loop changes, replacing pane-diff `classify_busy_wait`. Those land in Phases 3-5.

---

## File Structure

**Created:**
- `workerctl/ingest.py` — pure-ish library. Functions: `parse_jsonl_events(content, start_offset)`, `infer_state(event)`, `current_state(conn, session_id)`, `ingest_session(conn, session_name)`. ~150 lines target.

**Modified:**
- `workerctl/db.py` — bump `SCHEMA_VERSION` 5→6, add `codex_events` to `REQUIRED_TABLES`, add `codex_events_session_id` to `REQUIRED_INDEXES`, add CREATE TABLE + indexes in `migrate`, add `migrate_to_v6_codex_events(conn)` that adds the column to `sessions` (idempotent), wire it into `migrate()`. Add helpers: `insert_codex_event(...)`, `latest_codex_events_for_session(...)`, `set_session_ingest_offset(...)`, `bump_session_heartbeat(...)`.
- `workerctl/commands.py` — `command_ingest`, `command_tail`.
- `workerctl/cli.py` — wire two new subparsers.
- `tests/test_workerctl.py` — append `CodexEventsSchemaTests`, `IngestModuleTests`, `IngestCliTests`.

**Not touched in Phase 2:**
- `workerctl/supervise.py`, `workerctl/lifecycle.py`, `workerctl/tmux.py`, `workerctl/classify.py`, anything in `promote`/`manage` paths.

---

## Task 1: Schema v6 — `codex_events` table + `last_ingest_offset` column

**Files:**
- Modify: `workerctl/db.py` — bump version, schema additions, migration helper.
- Test: `tests/test_workerctl.py` (append `CodexEventsSchemaTests`).

- [ ] **Step 1: Write failing tests for schema shape**

Append to `tests/test_workerctl.py`:

```python
class CodexEventsSchemaTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_codex_events_table_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            tables = {
                row["name"]
                for row in conn.execute("select name from sqlite_master where type='table'")
            }
            self.assertIn("codex_events", tables)

    def test_codex_events_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(codex_events)")}
            expected = {"id", "session_id", "timestamp", "type", "subtype",
                        "payload_json", "byte_offset", "ingested_at"}
            self.assertTrue(expected <= cols, f"missing: {expected - cols}")

    def test_codex_events_fk_to_sessions_enforced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into codex_events(
                      session_id, timestamp, type, payload_json, byte_offset, ingested_at
                    )
                    values ('does-not-exist', '2026-05-11T00:00:00Z', 'event_msg',
                            '{}', 0, '2026-05-11T00:00:00Z')
                    """
                )

    def test_sessions_has_last_ingest_offset_column(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
            self.assertIn("last_ingest_offset", cols)

    def test_codex_events_session_id_index_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            indexes = {
                r["name"] for r in conn.execute(
                    "select name from sqlite_master where type='index' and tbl_name='codex_events'"
                )
            }
            self.assertIn("codex_events_session_id", indexes)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.CodexEventsSchemaTests -v
```
Expected: 5 tests FAIL — `codex_events` table missing.

- [ ] **Step 3: Bump schema version and add CREATE TABLE**

In `workerctl/db.py`:
- Change `SCHEMA_VERSION = 5` to `SCHEMA_VERSION = 6`.
- Add `"codex_events"` to `REQUIRED_TABLES` (alphabetical, between `bindings` and `commands` — verify exact slot).
- Add `"codex_events_session_id"` to `REQUIRED_INDEXES` (alphabetical).
- Inside `migrate()` executescript, after the existing `events` table CREATE, add:

```sql
        create table if not exists codex_events(
          id integer primary key autoincrement,
          session_id text not null references sessions(id),
          timestamp text not null,
          type text not null,
          subtype text,
          payload_json text not null check (json_valid(payload_json)),
          byte_offset integer not null,
          ingested_at text not null
        );
```

- Also inside the executescript, after the existing index block, add:

```sql
        create index if not exists codex_events_session_id
        on codex_events(session_id, id);
```

- [ ] **Step 4: Write failing test for `migrate_to_v6_codex_events`**

Append to `CodexEventsSchemaTests`:

```python
    def test_migrate_to_v6_adds_last_ingest_offset_to_existing_sessions(self):
        """Simulate a v5 DB without `last_ingest_offset` column; verify the v6 migration
        adds the column without losing existing session rows."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            conn.commit()

            # Degrade to v5 shape: drop last_ingest_offset column via rebuild.
            conn.executescript(
                """
                alter table sessions rename to sessions_v5;
                create table sessions(
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
                insert into sessions(
                  id, name, role, identity_token,
                  tmux_session, tmux_pane_id,
                  codex_session_path, codex_session_id, pid,
                  cwd, registered_at, last_heartbeat_at, state
                )
                select id, name, role, identity_token,
                       tmux_session, tmux_pane_id,
                       codex_session_path, codex_session_id, pid,
                       cwd, registered_at, last_heartbeat_at, state
                from sessions_v5;
                drop table sessions_v5;
                """
            )
            conn.execute("PRAGMA user_version = 5")
            conn.commit()
            conn.close()

            # Reopen — must self-heal.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
            self.assertIn("last_ingest_offset", cols)

            row = conn.execute("select id, last_ingest_offset from sessions where name='w'").fetchone()
            self.assertIsNotNone(row)
            self.assertIsNone(row["last_ingest_offset"])  # NULL means "not yet ingested"
```

- [ ] **Step 5: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.CodexEventsSchemaTests.test_migrate_to_v6_adds_last_ingest_offset_to_existing_sessions -v
```
Expected: FAIL with `assertIn("last_ingest_offset", cols)`.

- [ ] **Step 6: Implement `migrate_to_v6_codex_events`**

In `workerctl/db.py`, after `migrate_to_v5_sessions`, add:

```python
def migrate_to_v6_codex_events(conn: sqlite3.Connection) -> None:
    """Add `last_ingest_offset` column to `sessions` if missing. Idempotent."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
    if "last_ingest_offset" not in existing_cols:
        conn.execute("alter table sessions add column last_ingest_offset integer")
```

In `migrate()`, after the unconditional `migrate_to_v5_sessions(conn)` call (Phase 1's self-heal), add an unconditional call:

```python
    # Phase 2 invariant repair. Always runs; the inner check makes it idempotent.
    migrate_to_v6_codex_events(conn)
```

- [ ] **Step 7: Run all schema tests**

```bash
python3 -m unittest tests.test_workerctl.CodexEventsSchemaTests -v
```
Expected: 6 tests PASS.

- [ ] **Step 8: Verify Phase 1 tests still pass**

```bash
python3 -m unittest tests.test_workerctl.SessionsSchemaTests tests.test_workerctl.RegisterCommandsTests tests.test_workerctl.BindCommandTests -v 2>&1 | tail -3
```
Expected: 0 failures.

- [ ] **Step 9: Full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures, +6 new tests.

- [ ] **Step 10: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add codex_events table and last_ingest_offset column (schema v6)"
```

---

## Task 2: DB helpers for codex_events

**Files:**
- Modify: `workerctl/db.py` — add helpers near other session helpers.
- Test: `tests/test_workerctl.py` (append to `CodexEventsSchemaTests`).

- [ ] **Step 1: Write failing tests**

Append to `CodexEventsSchemaTests`:

```python
    def test_insert_codex_event_persists_row(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            event_id = worker_db.insert_codex_event(
                conn,
                session_id=session_id,
                timestamp="2026-05-11T14:32:11.791Z",
                event_type="event_msg",
                subtype="task_started",
                payload={"turn_id": "t1", "started_at": "2026-05-11T14:32:11Z"},
                byte_offset=128,
            )
            self.assertIsInstance(event_id, int)
            row = conn.execute(
                "select session_id, type, subtype, byte_offset from codex_events where id = ?",
                (event_id,),
            ).fetchone()
            self.assertEqual(row["session_id"], session_id)
            self.assertEqual(row["type"], "event_msg")
            self.assertEqual(row["subtype"], "task_started")
            self.assertEqual(row["byte_offset"], 128)

    def test_latest_codex_events_for_session_orders_and_limits(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            for i in range(5):
                worker_db.insert_codex_event(
                    conn, session_id=session_id,
                    timestamp=f"2026-05-11T14:32:{10+i:02d}Z",
                    event_type="event_msg",
                    subtype="agent_message",
                    payload={"i": i},
                    byte_offset=i * 100,
                )
            rows = worker_db.latest_codex_events_for_session(
                conn, session_id=session_id, limit=3,
            )
            self.assertEqual(len(rows), 3)
            # Newest first
            offsets = [r["byte_offset"] for r in rows]
            self.assertEqual(offsets, [400, 300, 200])

    def test_set_session_ingest_offset_updates_column(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            worker_db.set_session_ingest_offset(conn, session_id=session_id, offset=42)
            row = conn.execute(
                "select last_ingest_offset from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["last_ingest_offset"], 42)

    def test_bump_session_heartbeat_sets_timestamp(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            worker_db.bump_session_heartbeat(
                conn, session_id=session_id, timestamp="2026-05-11T15:00:00Z",
            )
            row = conn.execute(
                "select last_heartbeat_at from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["last_heartbeat_at"], "2026-05-11T15:00:00Z")
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.CodexEventsSchemaTests -v
```
Expected: 4 new tests FAIL with `AttributeError`.

- [ ] **Step 3: Implement helpers**

In `workerctl/db.py`, after `deregister_session` (around line 880 — find with `grep -n "def deregister_session" workerctl/db.py`), add:

```python
def insert_codex_event(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    timestamp: str,
    event_type: str,
    subtype: str | None,
    payload: dict[str, Any],
    byte_offset: int,
    ingested_at: str | None = None,
) -> int:
    """Insert one codex event row. Returns the autoincrement id."""
    now = ingested_at or now_iso()
    cursor = conn.execute(
        """
        insert into codex_events(
          session_id, timestamp, type, subtype, payload_json, byte_offset, ingested_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, timestamp, event_type, subtype,
         json.dumps(payload, sort_keys=True), byte_offset, now),
    )
    return int(cursor.lastrowid)


def latest_codex_events_for_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    limit: int = 50,
    subtype: str | None = None,
) -> list[sqlite3.Row]:
    """Return up to `limit` most recent codex events for `session_id`, newest first."""
    query = "select * from codex_events where session_id = ?"
    params: list[Any] = [session_id]
    if subtype is not None:
        query += " and subtype = ?"
        params.append(subtype)
    query += " order by id desc limit ?"
    params.append(limit)
    return list(conn.execute(query, tuple(params)))


def set_session_ingest_offset(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    offset: int,
) -> None:
    conn.execute(
        "update sessions set last_ingest_offset = ? where id = ?",
        (offset, session_id),
    )


def bump_session_heartbeat(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    timestamp: str | None = None,
) -> None:
    now = timestamp or now_iso()
    conn.execute(
        "update sessions set last_heartbeat_at = ? where id = ?",
        (now, session_id),
    )
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.CodexEventsSchemaTests -v
```
Expected: 10 tests PASS (6 schema + 4 helper).

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add workerctl/db.py tests/test_workerctl.py
git commit -m "Add codex_events DB helpers and session ingest-offset/heartbeat helpers"
```

---

## Task 3: `workerctl/ingest.py` — JSONL parsing

**Files:**
- Create: `workerctl/ingest.py`
- Test: `tests/test_workerctl.py` (append `IngestModuleTests`).

- [ ] **Step 1: Write failing tests for `parse_jsonl_events`**

Append to `tests/test_workerctl.py`:

```python
class IngestModuleTests(unittest.TestCase):
    def test_parse_jsonl_events_empty_content_yields_nothing(self):
        from workerctl import ingest

        events = list(ingest.parse_jsonl_events(b"", start_offset=0))
        self.assertEqual(events, [])

    def test_parse_jsonl_events_yields_parsed_records_with_offsets(self):
        from workerctl import ingest

        line1 = '{"type":"session_meta","payload":{"id":"u1","cwd":"/r"}}\n'
        line2 = '{"timestamp":"2026-05-11T14:32:11Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}\n'
        content = (line1 + line2).encode("utf-8")
        events = list(ingest.parse_jsonl_events(content, start_offset=0))
        self.assertEqual(len(events), 2)

        self.assertEqual(events[0]["type"], "session_meta")
        self.assertEqual(events[0]["payload"]["id"], "u1")
        self.assertEqual(events[0]["byte_offset"], 0)
        self.assertEqual(events[0]["new_offset"], len(line1.encode("utf-8")))

        self.assertEqual(events[1]["type"], "event_msg")
        self.assertEqual(events[1]["subtype"], "task_started")
        self.assertEqual(events[1]["byte_offset"], len(line1.encode("utf-8")))
        self.assertEqual(events[1]["new_offset"], len(content))
        self.assertEqual(events[1]["timestamp"], "2026-05-11T14:32:11Z")

    def test_parse_jsonl_events_ignores_partial_trailing_line(self):
        """If the file ends without a newline, the trailing partial line is skipped
        and the offset advances only to the last complete line."""
        from workerctl import ingest

        complete = '{"type":"event_msg","payload":{"type":"agent_message"}}\n'
        partial = '{"type":"event_'  # truncated mid-write
        content = (complete + partial).encode("utf-8")
        events = list(ingest.parse_jsonl_events(content, start_offset=0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["new_offset"], len(complete.encode("utf-8")))

    def test_parse_jsonl_events_respects_start_offset(self):
        from workerctl import ingest

        line1 = '{"type":"event_msg","payload":{"type":"agent_message"}}\n'
        line2 = '{"type":"event_msg","payload":{"type":"task_complete","duration_ms":100}}\n'
        content = (line1 + line2).encode("utf-8")
        start = len(line1.encode("utf-8"))
        # Caller has already read line1. Pass only the unread portion.
        events = list(ingest.parse_jsonl_events(content[start:], start_offset=start))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["subtype"], "task_complete")
        self.assertEqual(events[0]["byte_offset"], start)
        self.assertEqual(events[0]["new_offset"], len(content))

    def test_parse_jsonl_events_skips_malformed_line(self):
        from workerctl import ingest

        good = '{"type":"event_msg","payload":{"type":"agent_message"}}\n'
        bad = '{this is not json}\n'
        good2 = '{"type":"event_msg","payload":{"type":"task_complete"}}\n'
        content = (good + bad + good2).encode("utf-8")
        events = list(ingest.parse_jsonl_events(content, start_offset=0))
        # Malformed line is skipped; offsets still advance past it.
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["subtype"], "agent_message")
        self.assertEqual(events[1]["subtype"], "task_complete")
        self.assertEqual(events[1]["new_offset"], len(content))
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 5 tests FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Create the module with `parse_jsonl_events`**

Create `workerctl/ingest.py`:

```python
from __future__ import annotations

import json
from typing import Any, Iterator


def parse_jsonl_events(content: bytes, *, start_offset: int) -> Iterator[dict[str, Any]]:
    """Yield parsed JSONL records from `content`, tracking absolute byte offsets.

    `start_offset` is the absolute file offset corresponding to `content[0]`.
    The caller is expected to have read the file from that offset.

    Each yielded dict has:
      - `type`: top-level record type (session_meta, event_msg, response_item, ...).
      - `subtype`: inner payload type for event_msg, else None.
      - `timestamp`: ISO timestamp from the record, or None if absent.
      - `payload`: the raw payload dict.
      - `byte_offset`: absolute file offset where this record's line starts.
      - `new_offset`: absolute file offset just after this record's terminating newline.

    Lines without a trailing newline are NOT yielded (assumed to be a partial write).
    Malformed lines (invalid JSON) are silently skipped, but the offset still advances
    past them so they aren't reprocessed.
    """
    cursor = 0
    while True:
        newline = content.find(b"\n", cursor)
        if newline == -1:
            return
        line_bytes = content[cursor:newline]
        next_cursor = newline + 1
        absolute_line_start = start_offset + cursor
        absolute_after_line = start_offset + next_cursor
        cursor = next_cursor

        try:
            record = json.loads(line_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        record_type = record.get("type")
        if not isinstance(record_type, str):
            continue
        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}
        subtype = payload.get("type") if record_type == "event_msg" else None
        if subtype is not None and not isinstance(subtype, str):
            subtype = None
        yield {
            "type": record_type,
            "subtype": subtype,
            "timestamp": record.get("timestamp"),
            "payload": payload,
            "byte_offset": absolute_line_start,
            "new_offset": absolute_after_line,
        }
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add workerctl/ingest.py tests/test_workerctl.py
git commit -m "Add ingest.parse_jsonl_events with byte-offset tracking"
```

---

## Task 4: `infer_state` and `current_state`

**Files:**
- Modify: `workerctl/ingest.py`
- Test: `tests/test_workerctl.py` (append to `IngestModuleTests`).

- [ ] **Step 1: Write failing tests for `infer_state`**

Append to `IngestModuleTests`:

```python
    def test_infer_state_returns_busy_for_task_started(self):
        from workerctl import ingest
        self.assertEqual(
            ingest.infer_state({"type": "event_msg", "subtype": "task_started", "payload": {}}),
            "busy",
        )

    def test_infer_state_returns_busy_for_user_message(self):
        from workerctl import ingest
        self.assertEqual(
            ingest.infer_state({"type": "event_msg", "subtype": "user_message", "payload": {}}),
            "busy",
        )

    def test_infer_state_returns_idle_for_task_complete(self):
        from workerctl import ingest
        self.assertEqual(
            ingest.infer_state({"type": "event_msg", "subtype": "task_complete", "payload": {}}),
            "idle",
        )

    def test_infer_state_returns_none_for_agent_message(self):
        from workerctl import ingest
        # agent_message indicates progress but doesn't change state
        self.assertIsNone(
            ingest.infer_state({"type": "event_msg", "subtype": "agent_message", "payload": {}}),
        )

    def test_infer_state_returns_none_for_token_count(self):
        from workerctl import ingest
        self.assertIsNone(
            ingest.infer_state({"type": "event_msg", "subtype": "token_count", "payload": {}}),
        )

    def test_infer_state_returns_none_for_non_event_msg(self):
        from workerctl import ingest
        self.assertIsNone(
            ingest.infer_state({"type": "response_item", "subtype": None, "payload": {}}),
        )
        self.assertIsNone(
            ingest.infer_state({"type": "session_meta", "subtype": None, "payload": {}}),
        )
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 6 new tests FAIL with `AttributeError`.

- [ ] **Step 3: Implement `infer_state`**

Append to `workerctl/ingest.py`:

```python
# Mapping from event_msg subtype -> high-level session state.
# None means "this event does not change state."
_STATE_MAP: dict[str, str] = {
    "task_started": "busy",
    "user_message": "busy",
    "task_complete": "idle",
}


def infer_state(event: dict[str, Any]) -> str | None:
    """Return the high-level state implied by `event`, or None if no change.

    `event` is one of the dicts yielded by `parse_jsonl_events` or the equivalent
    shape from a `codex_events` row. Only `event_msg` records influence state.
    """
    if event.get("type") != "event_msg":
        return None
    subtype = event.get("subtype")
    if not isinstance(subtype, str):
        return None
    return _STATE_MAP.get(subtype)
```

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 11 tests PASS (5 + 6).

- [ ] **Step 5: Write failing tests for `current_state`**

Append to `IngestModuleTests`:

```python
    def test_current_state_returns_unknown_when_no_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u", pid=1, cwd="/repo",
            )
            self.assertEqual(ingest.current_state(conn, session_id=session_id), "unknown")

    def test_current_state_walks_back_to_most_recent_state_event(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u", pid=1, cwd="/repo",
            )
            # Sequence: task_started -> agent_message (no change) -> task_complete -> agent_message
            for subtype, offset in [
                ("task_started", 100),
                ("agent_message", 200),
                ("task_complete", 300),
                ("agent_message", 400),  # newest but no state change
            ]:
                worker_db.insert_codex_event(
                    conn, session_id=session_id,
                    timestamp="2026-05-11T00:00:00Z",
                    event_type="event_msg",
                    subtype=subtype,
                    payload={},
                    byte_offset=offset,
                )
            # Latest state-bearing event was task_complete -> idle
            self.assertEqual(ingest.current_state(conn, session_id=session_id), "idle")

    def test_current_state_picks_most_recent_busy_signal(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u", pid=1, cwd="/repo",
            )
            for subtype, offset in [
                ("task_complete", 100),
                ("user_message", 200),
                ("task_started", 300),
            ]:
                worker_db.insert_codex_event(
                    conn, session_id=session_id,
                    timestamp="2026-05-11T00:00:00Z",
                    event_type="event_msg",
                    subtype=subtype,
                    payload={},
                    byte_offset=offset,
                )
            self.assertEqual(ingest.current_state(conn, session_id=session_id), "busy")
```

- [ ] **Step 6: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 3 new tests FAIL with `AttributeError`.

- [ ] **Step 7: Implement `current_state`**

Append to `workerctl/ingest.py`:

```python
import sqlite3

_STATE_BEARING_SUBTYPES = tuple(_STATE_MAP.keys())


def current_state(conn: "sqlite3.Connection", *, session_id: str) -> str:
    """Return the latest high-level state for `session_id`, or 'unknown' if none.

    Walks the most recent state-bearing codex_events for the session. State-bearing
    means `type='event_msg'` and `subtype` in {task_started, user_message, task_complete}.
    """
    placeholders = ",".join("?" * len(_STATE_BEARING_SUBTYPES))
    row = conn.execute(
        f"""
        select subtype from codex_events
        where session_id = ?
          and type = 'event_msg'
          and subtype in ({placeholders})
        order by id desc
        limit 1
        """,
        (session_id, *_STATE_BEARING_SUBTYPES),
    ).fetchone()
    if row is None:
        return "unknown"
    return _STATE_MAP[row["subtype"]]
```

(Note: `sqlite3` is imported locally to avoid a hard top-level dependency in a module that's otherwise pure-Python.)

- [ ] **Step 8: Run tests**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 14 tests PASS.

- [ ] **Step 9: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures.

- [ ] **Step 10: Commit**

```bash
git add workerctl/ingest.py tests/test_workerctl.py
git commit -m "Add infer_state and current_state state inference"
```

---

## Task 5: `ingest_session` orchestrator

**Files:**
- Modify: `workerctl/ingest.py`
- Test: `tests/test_workerctl.py` (append to `IngestModuleTests`).

- [ ] **Step 1: Write failing test for `ingest_session`**

Append to `IngestModuleTests`:

```python
    def test_ingest_session_persists_new_events_and_advances_offset(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            # Create a rollout file with two events.
            line1 = json.dumps({"type": "session_meta", "payload": {"id": "u", "cwd": "/r"}}) + "\n"
            line2 = json.dumps({
                "timestamp": "2026-05-11T14:32:11Z",
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "t1"},
            }) + "\n"
            rollout.write_text(line1 + line2)

            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()

            result = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(result["new_events"], 2)
            self.assertEqual(result["new_offset"], len((line1 + line2).encode("utf-8")))

            rows = conn.execute(
                "select type, subtype, byte_offset from codex_events "
                "where session_id = (select id from sessions where name='w') "
                "order by id"
            ).fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["type"], "session_meta")
            self.assertEqual(rows[1]["type"], "event_msg")
            self.assertEqual(rows[1]["subtype"], "task_started")

            offset_row = conn.execute(
                "select last_ingest_offset, last_heartbeat_at from sessions where name='w'"
            ).fetchone()
            self.assertEqual(offset_row["last_ingest_offset"], result["new_offset"])
            self.assertIsNotNone(offset_row["last_heartbeat_at"])

    def test_ingest_session_is_idempotent_on_unchanged_file(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            rollout.write_text(json.dumps({
                "type": "event_msg",
                "payload": {"type": "task_started"},
            }) + "\n")
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()

            r1 = ingest.ingest_session(conn, session_name="w")
            r2 = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(r1["new_events"], 1)
            self.assertEqual(r2["new_events"], 0)

            count = conn.execute("select count(*) from codex_events").fetchone()[0]
            self.assertEqual(count, 1)

    def test_ingest_session_picks_up_appended_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            initial = json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n"
            rollout.write_text(initial)
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()
            ingest.ingest_session(conn, session_name="w")

            # Append a second event
            with open(rollout, "a") as fh:
                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}) + "\n")

            result = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(result["new_events"], 1)
            rows = conn.execute("select subtype from codex_events order by id").fetchall()
            self.assertEqual([r["subtype"] for r in rows], ["task_started", "task_complete"])

    def test_ingest_session_raises_on_missing_session(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            with self.assertRaises(WorkerError):
                ingest.ingest_session(conn, session_name="does-not-exist")

    def test_ingest_session_raises_when_rollout_path_missing(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(Path(tmpdir) / "does-not-exist.jsonl"),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()
            from workerctl.ingest import IngestError
            with self.assertRaises(IngestError):
                ingest.ingest_session(conn, session_name="w")
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 5 new tests FAIL with `AttributeError: 'workerctl.ingest' has no attribute 'ingest_session'`.

- [ ] **Step 3: Implement `ingest_session` and `IngestError`**

Append to `workerctl/ingest.py`:

```python
from pathlib import Path

from workerctl import db as worker_db
from workerctl.core import WorkerError


class IngestError(Exception):
    """Raised when ingestion can't proceed for a structural reason (missing rollout, etc)."""


def ingest_session(
    conn: "sqlite3.Connection",
    *,
    session_name: str,
    now: str | None = None,
) -> dict[str, Any]:
    """Run one ingest cycle for the named session.

    Reads new bytes from the session's rollout file starting at the recorded offset,
    parses JSONL records, persists each to `codex_events`, advances the session's
    `last_ingest_offset`, and bumps `last_heartbeat_at`.

    Returns a dict with `new_events` (int) and `new_offset` (int).

    Raises:
      - WorkerError if the session is unknown.
      - IngestError if the rollout path is missing or unreadable.
    """
    row = worker_db.session_row(conn, name=session_name)
    session_id = row["id"]
    rollout_path_str = row["codex_session_path"]
    if not rollout_path_str:
        raise IngestError(f"session {session_name!r} has no codex_session_path")

    rollout_path = Path(rollout_path_str)
    if not rollout_path.exists():
        raise IngestError(f"rollout file does not exist: {rollout_path}")

    start_offset = row["last_ingest_offset"] or 0
    try:
        with open(rollout_path, "rb") as fh:
            fh.seek(start_offset)
            content = fh.read()
    except OSError as exc:
        raise IngestError(f"failed to read rollout file: {exc}") from exc

    timestamp = now or worker_db.now_iso()
    new_events = 0
    new_offset = start_offset
    for event in parse_jsonl_events(content, start_offset=start_offset):
        worker_db.insert_codex_event(
            conn,
            session_id=session_id,
            timestamp=event["timestamp"] or timestamp,
            event_type=event["type"],
            subtype=event["subtype"],
            payload=event["payload"],
            byte_offset=event["byte_offset"],
            ingested_at=timestamp,
        )
        new_offset = event["new_offset"]
        new_events += 1

    if new_offset != start_offset:
        worker_db.set_session_ingest_offset(conn, session_id=session_id, offset=new_offset)
    worker_db.bump_session_heartbeat(conn, session_id=session_id, timestamp=timestamp)
    conn.commit()

    return {"new_events": new_events, "new_offset": new_offset}
```

(Note: `worker_db.now_iso` is the existing helper used elsewhere in `db.py`. If it's not exported at module level, replace with `from workerctl.core import now_iso` and use `now_iso()` directly. Check with `grep -n "def now_iso\|from workerctl.core" workerctl/db.py | head -5`.)

- [ ] **Step 4: Run tests**

```bash
python3 -m unittest tests.test_workerctl.IngestModuleTests -v
```
Expected: 19 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add workerctl/ingest.py tests/test_workerctl.py
git commit -m "Add ingest_session orchestrator"
```

---

## Task 6: CLI commands `ingest` and `tail`

**Files:**
- Modify: `workerctl/commands.py` — `command_ingest`, `command_tail`.
- Modify: `workerctl/cli.py` — wire subparsers.
- Test: `tests/test_workerctl.py` (append `IngestCliTests`).

- [ ] **Step 1: Write failing tests**

Append to `tests/test_workerctl.py`:

```python
class IngestCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_with_rollout(self, tmpdir, events):
        rollout = Path(tmpdir) / "rollout.jsonl"
        rollout.write_text("".join(json.dumps(e) + "\n" for e in events))
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        # Register the session via CLI so the DB has a session row.
        meta = {"type": "session_meta", "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"}}
        meta_file = Path(tmpdir) / "meta-fixture.jsonl"
        meta_file.write_text(json.dumps(meta) + "\n")
        self.run_cli(
            "register-worker", "--name", "w",
            "--codex-session", str(rollout),
            "--pid", "1", "--cwd", str(ROOT),
            env_extra=env,
        )
        return rollout, state_dir, env

    def test_cli_ingest_persists_events(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_with_rollout(tmpdir, events=[
                {"type": "session_meta", "payload": {"id": "u1", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])
            proc = self.run_cli("ingest", "w", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["new_events"], 2)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            count = conn.execute(
                "select count(*) from codex_events where session_id = "
                "(select id from sessions where name='w')"
            ).fetchone()[0]
            self.assertEqual(count, 2)

    def test_cli_tail_prints_events(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_with_rollout(tmpdir, events=[
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
                {"timestamp": "2026-05-11T14:32:12Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete", "duration_ms": 1000}},
            ])
            self.run_cli("ingest", "w", env_extra=env)

            proc = self.run_cli("tail", "w", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            events = json.loads(proc.stdout)
            # Newest first
            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["subtype"], "task_complete")
            self.assertEqual(events[1]["subtype"], "task_started")

    def test_cli_tail_respects_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            events_list = [
                {"timestamp": f"2026-05-11T14:32:{10+i:02d}Z",
                 "type": "event_msg",
                 "payload": {"type": "agent_message", "message": f"chunk {i}"}}
                for i in range(5)
            ]
            rollout, state_dir, env = self._setup_with_rollout(tmpdir, events=events_list)
            self.run_cli("ingest", "w", env_extra=env)

            proc = self.run_cli("tail", "w", "--limit", "2", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            events = json.loads(proc.stdout)
            self.assertEqual(len(events), 2)

    def test_cli_ingest_unknown_session_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            proc = self.run_cli(
                "ingest", "missing",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
python3 -m unittest tests.test_workerctl.IngestCliTests -v
```
Expected: 4 tests FAIL — unknown subcommands `ingest` / `tail`.

- [ ] **Step 3: Add command functions to `workerctl/commands.py`**

Append (place near `command_sessions`):

```python
def command_ingest(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import ingest as worker_ingest

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        result = worker_ingest.ingest_session(conn, session_name=args.name)
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_tail(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        session = worker_db.session_row(conn, name=args.name)
        rows = worker_db.latest_codex_events_for_session(
            conn, session_id=session["id"], limit=args.limit, subtype=args.subtype,
        )
    finally:
        conn.close()
    events = [
        {
            "id": r["id"],
            "timestamp": r["timestamp"],
            "type": r["type"],
            "subtype": r["subtype"],
            "byte_offset": r["byte_offset"],
            "payload": json.loads(r["payload_json"]),
        }
        for r in rows
    ]
    print(json.dumps(events, indent=2, sort_keys=True, default=str))
    return 0
```

Also extend the CLI error handler in `workerctl/cli.py` to catch `IngestError`. Find the existing `except (WorkerError, CodexSessionError)` block (around line 884) and add the import + the class:

```python
from workerctl.ingest import IngestError
...
    except (WorkerError, CodexSessionError, IngestError) as exc:
        print(f"workerctl: {exc}", file=sys.stderr)
        return 1
```

- [ ] **Step 4: Wire subparsers in `workerctl/cli.py`**

Add to the `from workerctl.commands import (...)` block:

```python
    command_ingest,
    command_tail,
```

In `build_parser`, after the `unbind` subparser block (added in Phase 1), add:

```python
    ingest = subparsers.add_parser(
        "ingest",
        help="Read new events from a session's rollout JSONL and persist them.",
    )
    ingest.add_argument("name", help="Session name.")
    ingest.set_defaults(func=command_ingest)

    tail = subparsers.add_parser(
        "tail",
        help="Print the most recent codex_events for a session (newest first).",
    )
    tail.add_argument("name", help="Session name.")
    tail.add_argument("--limit", type=int, default=50, help="Max events to print.")
    tail.add_argument("--subtype", default=None, help="Filter by event_msg subtype.")
    tail.set_defaults(func=command_tail)
```

- [ ] **Step 5: Run CLI tests**

```bash
python3 -m unittest tests.test_workerctl.IngestCliTests -v
```
Expected: 4 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
python3 -m unittest tests.test_workerctl 2>&1 | tail -3
```
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add workerctl/commands.py workerctl/cli.py tests/test_workerctl.py
git commit -m "Add ingest and tail CLI commands"
```

---

## Task 7: README docs

**Files:**
- Modify: `README.md` — extend the "Manual-Assignment Primitives (Phase 1)" section with Phase 2 commands.

- [ ] **Step 1: Verify the existing section and CLI**

```bash
grep -n "Manual-Assignment Primitives" README.md
python3 -m workerctl ingest --help
python3 -m workerctl tail --help
```

- [ ] **Step 2: Add Phase 2 subsection**

In `README.md`, immediately after the existing `## Manual-Assignment Primitives (Phase 1)` section ends (and before the next `##` heading), add:

````markdown
### Phase 2: Ingest + Tail

Once a session is registered, its rollout JSONL can be ingested and queried.
Ingestion is idempotent and tracks a byte offset so subsequent runs only pick up
new events.

```bash
# Run one ingest cycle for a registered session
workerctl ingest auth-worker
# Output: {"new_events": 42, "new_offset": 12345}

# View the most recent codex events for a session (newest first)
workerctl tail auth-worker --limit 20

# Filter by event_msg subtype
workerctl tail auth-worker --subtype task_started --limit 5
```

The `ingest` command can be called repeatedly (e.g. on a polling interval). Each
run reads from the recorded `last_ingest_offset`, persists new events into the
`codex_events` table keyed by session id, advances the offset, and bumps
`last_heartbeat_at` on the session row. A long-running session ingester / new
supervision loop lands in Phase 3.

**State inference:** `task_started` and `user_message` set the session to `busy`;
`task_complete` sets it to `idle`. Other event subtypes (`agent_message`,
`token_count`, `response_item`) are recorded but do not change the inferred state.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document ingest and tail commands in README"
```

---

## Self-Review

**Spec coverage:**
- `codex_events` table → Task 1 ✓
- `last_ingest_offset` column on sessions → Task 1 ✓
- v6 migration self-heal → Task 1 ✓
- DB helpers (insert, latest, set offset, heartbeat) → Task 2 ✓
- `parse_jsonl_events` with offset tracking → Task 3 ✓
- `infer_state` for event_msg subtypes → Task 4 ✓
- `current_state` walk → Task 4 ✓
- `ingest_session` orchestrator → Task 5 ✓
- `IngestError` for missing rollout → Task 5 ✓
- `ingest` CLI → Task 6 ✓
- `tail` CLI with `--limit` / `--subtype` → Task 6 ✓
- CLI error handler catches `IngestError` → Task 6 ✓
- Docs → Task 7 ✓

**Placeholder scan:** no TBDs, all code blocks complete, no "similar to Task N" handwaves.

**Type consistency:**
- `parse_jsonl_events` yields dicts with keys `type`, `subtype`, `timestamp`, `payload`, `byte_offset`, `new_offset` (Task 3) — consumed by `ingest_session` (Task 5) with same keys ✓.
- `infer_state` accepts the same dict shape OR a `codex_events` row dict (Task 4) — works because both have `type` and `subtype` ✓.
- `ingest_session` returns `{"new_events": int, "new_offset": int}` (Task 5) — CLI prints same dict (Task 6) ✓.
- `IngestError` defined in Task 5; imported and caught in Task 6 ✓.

**Known caveats flagged inline:**
- Task 5 Step 3: `worker_db.now_iso` may need adjustment if not exported (check before implementing).
- Task 6 Step 3: imports for `IngestError` at module top vs. inside function — match existing patterns in `commands.py`.

---

## Out of Scope (deferred to later phases)

- **Phase 3:** Long-running ingester / new supervision loop that consumes `current_state` + `last_heartbeat_at` to decide nudges. `workerctl supervise <task>` reimplemented against bind+JSON. Manager-outside-tmux execution end-to-end.
- **Phase 4:** Shadow JSON-based idle detection alongside pane-based `classify_busy_wait`; log divergence; flip primary signal.
- **Phase 5:** Retire `promote`, `manage`, `become-worker`. Trim `workerctl/tmux.py` to PTY + send-keys + capture. Collapse `recover`/`reconcile`/`db-doctor`/`close-stale`.
