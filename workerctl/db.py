from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError
from workerctl.core import now_iso
from workerctl.state import state_root


SCHEMA_VERSION = 6
REQUIRED_TABLES = {
    "agent_observations",
    "bindings",
    "budgets",
    "codex_events",
    "commands",
    "data_migrations",
    "events",
    "manager_cycles",
    "manager_decisions",
    "managers",
    "prompts",
    "schema_migrations",
    "sessions",
    "statuses",
    "tasks",
    "terminal_captures",
    "transcript_captures",
    "transcript_segments",
    "workers",
}
REQUIRED_INDEXES = {
    "codex_events_session_id",
    "commands_task_state_created",
    "events_task_id",
    "one_active_binding_per_task",
    "one_active_binding_per_manager_session",
    "one_active_binding_per_worker_session",
    "one_active_binding_per_worker",
    "one_active_manager_per_task",
    "agent_observations_task_id",
    "statuses_worker_id",
    "terminal_captures_task_role",
    "transcript_captures_worker_id",
    "transcript_segments_task_role",
}
REQUIRED_TRIGGERS = {
    "events_no_delete",
    "events_no_update",
}


def default_db_path() -> Path:
    return state_root() / "workerctl.db"


def connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or default_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    configure_connection(conn)
    return conn


def configure_connection(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    if foreign_keys != 1:
        raise RuntimeError("SQLite foreign key enforcement is not enabled")


def initialize_database(conn: sqlite3.Connection) -> None:
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    if user_version > SCHEMA_VERSION:
        raise RuntimeError(f"Database schema version {user_version} is newer than workerctl supports ({SCHEMA_VERSION})")
    migrate(conn, user_version)


def migrate(conn: sqlite3.Connection, from_version: int) -> None:
    if from_version > SCHEMA_VERSION:
        raise RuntimeError(f"Database schema version {from_version} is newer than workerctl supports ({SCHEMA_VERSION})")
    conn.executescript(
        """
        create table if not exists schema_migrations(
          version integer primary key,
          applied_at text not null
        );

        create table if not exists data_migrations(
          name text primary key,
          source_path text not null,
          source_hash text not null,
          applied_at text not null
        );

        create table if not exists workers(
          id text primary key,
          name text unique not null,
          tmux_session text unique not null,
          tmux_pane_id text,
          identity_token text unique not null,
          cwd text not null,
          state text not null check (state in ('candidate','active','stopped','missing','failed')),
          created_at text not null,
          updated_at text not null,
          last_seen_at text,
          exit_detected_at text,
          exit_reason text
        );

        create table if not exists tasks(
          id text primary key,
          name text not null,
          goal text not null,
          summary text,
          state text not null check (state in ('candidate','managed','paused','done','failed')),
          created_at text not null,
          updated_at text not null
        );

        create table if not exists managers(
          id text primary key,
          name text unique not null,
          task_id text not null references tasks(id),
          tmux_session text unique not null,
          tmux_pane_id text,
          state text not null check (state in ('starting','ready','stopping','stopped','missing','failed')),
          codex_args_json text not null check (json_valid(codex_args_json)),
          started_at text not null,
          stopped_at text,
          last_seen_at text,
          last_capture_sha256 text,
          exit_detected_at text,
          exit_reason text
        );

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

        create table if not exists statuses(
          id integer primary key autoincrement,
          worker_id text not null references workers(id),
          state text not null check (state in ('planning','editing','running_tests','blocked','waiting','done','unknown')),
          current_task text,
          next_action text,
          blocker text,
          created_at text not null
        );

        create table if not exists prompts(
          id integer primary key autoincrement,
          task_id text references tasks(id),
          manager_id text references managers(id),
          kind text not null check (kind in ('manager','worker_contract','resume')),
          content text not null,
          content_sha256 text not null,
          generator_version text not null,
          source_snapshot_json text not null check (json_valid(source_snapshot_json)),
          policy_json text not null check (json_valid(policy_json)),
          artifact_path text,
          created_at text not null
        );

        create table if not exists transcript_captures(
          id integer primary key autoincrement,
          worker_id text not null references workers(id),
          sha256 text not null,
          content text,
          captured_at text not null,
          changed_at text not null,
          history_lines integer not null,
          byte_count integer not null,
          line_count integer not null,
          capture_kind text not null check (capture_kind in ('latest','changed','metadata_only','archived')),
          retention_class text not null check (retention_class in ('hot','warm','archive'))
        );

        create table if not exists terminal_captures(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          role text not null check (role in ('worker','manager')),
          tmux_session text not null,
          tmux_pane_id text,
          command_id text references commands(id),
          captured_at text not null,
          history_lines integer not null,
          content_sha256 text not null,
          content text,
          content_path text,
          byte_count integer not null,
          line_count integer not null,
          classifier_json text not null check (json_valid(classifier_json)),
          source text not null
        );

        create table if not exists transcript_segments(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          role text not null check (role in ('worker','manager')),
          source_capture_id integer not null references terminal_captures(id),
          previous_capture_id integer references terminal_captures(id),
          captured_at text not null,
          content_sha256 text not null,
          segment_text text,
          segment_start_line integer,
          segment_end_line integer,
          byte_count integer not null,
          line_count integer not null,
          retention_class text not null check (retention_class in ('hot','warm','cold','redacted')),
          segment_kind text not null check (segment_kind in ('metadata','excerpt','snapshot','segment','reset')),
          redacted integer not null default 0 check (redacted in (0, 1)),
          created_at text not null
        );

        create table if not exists agent_observations(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          role text not null check (role in ('worker','manager','workerctl')),
          observation_type text not null check (observation_type in ('status','error','decision','blocker','summary','command_output','health','capture')),
          severity text not null check (severity in ('info','warning','error')),
          source_capture_id integer references terminal_captures(id),
          command_id text references commands(id),
          created_at text not null,
          message text not null,
          payload_json text not null check (json_valid(payload_json))
        );

        create table if not exists manager_cycles(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          manager_id text references managers(id),
          started_at text not null,
          completed_at text,
          state text not null check (state in ('started','succeeded','failed')),
          health_observation_id integer references agent_observations(id),
          manager_capture_id integer references terminal_captures(id),
          worker_capture_id integer references terminal_captures(id),
          status_json text check (status_json is null or json_valid(status_json)),
          health_json text check (health_json is null or json_valid(health_json)),
          decision text,
          error text
        );

        create table if not exists manager_decisions(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          manager_id text references managers(id),
          manager_cycle_id integer references manager_cycles(id),
          decision text not null check (decision in ('wait','nudge','interrupt','escalate','stop','inspect')),
          reason text not null,
          created_at text not null,
          payload_json text not null check (json_valid(payload_json))
        );

        create table if not exists budgets(
          task_id text primary key references tasks(id),
          max_nudges integer not null check (max_nudges >= 0),
          nudges_used integer not null default 0 check (nudges_used >= 0),
          expires_at text not null,
          check (nudges_used <= max_nudges)
        );

        create table if not exists commands(
          id text primary key,
          idempotency_key text unique not null,
          created_at text not null,
          updated_at text not null,
          task_id text references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          type text not null,
          state text not null check (state in ('pending','attempted','succeeded','failed')),
          payload_json text not null check (json_valid(payload_json)),
          result_json text check (result_json is null or json_valid(result_json)),
          error text
        );

        create table if not exists events(
          id integer primary key autoincrement,
          created_at text not null,
          actor text not null,
          command_id text references commands(id),
          correlation_id text,
          task_id text references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          type text not null,
          payload_json text not null check (json_valid(payload_json))
        );

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

        create unique index if not exists one_active_binding_per_worker
        on bindings(worker_id)
        where state in ('active', 'ending');

        create unique index if not exists one_active_binding_per_task
        on bindings(task_id)
        where state in ('active', 'ending');

        create unique index if not exists one_active_manager_per_task
        on managers(task_id)
        where state in ('starting', 'ready', 'stopping');

        create index if not exists events_task_id
        on events(task_id, id);

        create index if not exists codex_events_session_id
        on codex_events(session_id, id);

        create index if not exists commands_task_state_created
        on commands(task_id, state, created_at);

        create index if not exists statuses_worker_id
        on statuses(worker_id, id);

        create index if not exists terminal_captures_task_role
        on terminal_captures(task_id, role, id);

        create index if not exists agent_observations_task_id
        on agent_observations(task_id, id);

        create index if not exists transcript_captures_worker_id
        on transcript_captures(worker_id, id);

        create index if not exists transcript_segments_task_role
        on transcript_segments(task_id, role, id);

        create trigger if not exists events_no_update
        before update on events
        begin
          select raise(abort, 'events are append-only');
        end;

        create trigger if not exists events_no_delete
        before delete on events
        begin
          select raise(abort, 'events are append-only');
        end;
        """
    )
    if from_version < 2:
        migrate_worker_name_ids(conn)
    # Always run v5 invariant repair. Internals are idempotent: bindings rebuild is
    # guarded by column-presence check, backfills use `insert or ignore`, and index
    # creates use `if not exists`. This protects against partial-migration states
    # like the one observed when sessions table was added under a separate commit
    # before the bindings rebuild logic existed.
    migrate_to_v5_sessions(conn)
    # Phase 2 invariant repair. Always runs; the inner check makes it idempotent.
    migrate_to_v6_codex_events(conn)
    sync_worker_ids_to_config_files(conn)
    conn.execute(
        "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
        (SCHEMA_VERSION, now_iso()),
    )
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def migrate_worker_name_ids(conn: sqlite3.Connection) -> None:
    legacy_rows = conn.execute("select id, name from workers where id = name").fetchall()
    if not legacy_rows:
        return
    id_map = {str(row["id"]): f"worker-{uuid.uuid4()}" for row in legacy_rows}
    now = now_iso()
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("begin")
        conn.execute("drop trigger if exists events_no_update")
        conn.execute("drop trigger if exists events_no_delete")
        for old_id, new_id in id_map.items():
            for table in ("bindings", "statuses", "transcript_captures", "commands", "events"):
                conn.execute(f"update {table} set worker_id = ? where worker_id = ?", (new_id, old_id))
            conn.execute("update workers set id = ?, updated_at = ? where id = ?", (new_id, now, old_id))
            conn.execute(
                """
                insert into events(created_at, actor, type, worker_id, payload_json)
                values (?, 'workerctl', 'worker_id_migrated', ?, ?)
                """,
                (
                    now,
                    new_id,
                    json.dumps({"old_worker_id": old_id, "new_worker_id": new_id}, sort_keys=True),
                ),
            )
        conn.execute(
            """
            create trigger events_no_update
            before update on events
            begin
              select raise(abort, 'events are append-only');
            end
            """
        )
        conn.execute(
            """
            create trigger events_no_delete
            before delete on events
            begin
              select raise(abort, 'events are append-only');
            end
            """
        )
        conn.execute(
            "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
            (2, now),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def migrate_to_v5_sessions(conn: sqlite3.Connection) -> None:
    """Backfill `sessions` from existing `workers` and `managers` rows.

    Idempotent: uses `insert or ignore` so re-running does not duplicate. Maps:
    - workers -> sessions with role='worker', state='active' (regardless of legacy state).
    - managers -> sessions with role='manager', state='active'.

    Codex-session fields (path, id, pid) are left null; they only populate for sessions
    registered via the new `register-*` commands.
    """
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(bindings)")}
    if "worker_session_id" not in existing_cols:
        # SQLite has no DROP NOT NULL; we rebuild the table to make worker_id nullable
        # and to add the new columns. The parent `migrate()` runs in autocommit mode
        # for the executescript above; we don't need an explicit transaction here.
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
                row["id"], row["name"], f"legacy-manager-token-{uuid.uuid4()}",
                row["tmux_session"], row["tmux_pane_id"],
                "",  # historical managers don't track cwd separately; empty is acceptable
                row["started_at"] or now,
            ),
        )

    # Ensure the two session-id partial unique indexes exist regardless of whether
    # the rebuild branch ran. On fresh DBs the executescript above created the new
    # bindings columns but did not create these indexes; on upgraded DBs the rebuild
    # branch already created them and these statements no-op due to `if not exists`.
    conn.executescript(
        """
        create unique index if not exists one_active_binding_per_worker_session
        on bindings(worker_session_id) where state in ('active', 'ending');
        create unique index if not exists one_active_binding_per_manager_session
        on bindings(manager_session_id) where state in ('active', 'ending');
        """
    )


def migrate_to_v6_codex_events(conn: sqlite3.Connection) -> None:
    """Add `last_ingest_offset` column to `sessions` if missing. Idempotent."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
    if "last_ingest_offset" not in existing_cols:
        conn.execute("alter table sessions add column last_ingest_offset integer")


def sync_worker_ids_to_config_files(conn: sqlite3.Connection) -> None:
    database_path = conn.execute("PRAGMA database_list").fetchone()["file"]
    if Path(database_path).resolve() != default_db_path().resolve():
        return
    for row in conn.execute("select id, name from workers"):
        config_path = state_root() / str(row["name"]) / "config.json"
        if not config_path.exists():
            continue
        try:
            config = json.loads(config_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if config.get("worker_id") == row["id"]:
            continue
        config["worker_id"] = row["id"]
        config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")


def database_health(conn: sqlite3.Connection) -> dict[str, Any]:
    foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    schema_version = conn.execute("select max(version) from schema_migrations").fetchone()[0]

    tables = {
        row["name"]
        for row in conn.execute(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        )
    }
    indexes = {
        row["name"]
        for row in conn.execute("select name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
    }
    triggers = {row["name"] for row in conn.execute("select name from sqlite_master where type = 'trigger'")}
    foreign_key_violations = [
        dict(row)
        for row in conn.execute(
            """
            select "table", rowid, parent, fkid
            from pragma_foreign_key_check
            """
        )
    ]

    checks = [
        {"name": "foreign_keys", "ok": foreign_keys == 1, "value": foreign_keys},
        {"name": "journal_mode_wal", "ok": str(journal_mode).lower() == "wal", "value": journal_mode},
        {"name": "busy_timeout", "ok": busy_timeout >= 5000, "value": busy_timeout},
        {"name": "schema_version", "ok": schema_version == SCHEMA_VERSION, "value": schema_version},
        {"name": "user_version", "ok": user_version == SCHEMA_VERSION, "value": user_version},
        {"name": "required_tables", "ok": REQUIRED_TABLES <= tables, "missing": sorted(REQUIRED_TABLES - tables)},
        {"name": "required_indexes", "ok": REQUIRED_INDEXES <= indexes, "missing": sorted(REQUIRED_INDEXES - indexes)},
        {"name": "required_triggers", "ok": REQUIRED_TRIGGERS <= triggers, "missing": sorted(REQUIRED_TRIGGERS - triggers)},
        {
            "name": "foreign_key_check",
            "ok": not foreign_key_violations,
            "violations": foreign_key_violations,
        },
    ]
    return {
        "checks": checks,
        "ok": all(check["ok"] for check in checks),
        "schema_version": schema_version,
        "user_version": user_version,
    }


def insert_event(
    conn: sqlite3.Connection,
    event_type: str,
    *,
    actor: str,
    payload: dict[str, Any] | None = None,
    command_id: str | None = None,
    correlation_id: str | None = None,
    task_id: str | None = None,
    worker_id: str | None = None,
    manager_id: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into events(
          created_at, actor, command_id, correlation_id, task_id, worker_id,
          manager_id, type, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now_iso(),
            actor,
            command_id,
            correlation_id,
            task_id,
            worker_id,
            manager_id,
            event_type,
            json.dumps(payload or {}, sort_keys=True),
        ),
    )
    return int(cursor.lastrowid)


def create_command(
    conn: sqlite3.Connection,
    *,
    command_type: str,
    payload: dict[str, Any],
    idempotency_key: str | None = None,
    task_id: str | None = None,
    worker_id: str | None = None,
    manager_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    command_id = f"command-{uuid.uuid4()}"
    now = timestamp or now_iso()
    key = idempotency_key or command_id
    conn.execute(
        """
        insert into commands(
          id, idempotency_key, created_at, updated_at, task_id, worker_id,
          manager_id, type, state, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        """,
        (
            command_id,
            key,
            now,
            now,
            task_id,
            worker_id,
            manager_id,
            command_type,
            json.dumps(payload, sort_keys=True),
        ),
    )
    return command_id


def mark_command_attempted(conn: sqlite3.Connection, *, command_id: str, timestamp: str | None = None) -> None:
    conn.execute(
        """
        update commands
        set state = 'attempted', updated_at = ?
        where id = ? and state = 'pending'
        """,
        (timestamp or now_iso(), command_id),
    )


def finish_command(
    conn: sqlite3.Connection,
    *,
    command_id: str,
    state: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    timestamp: str | None = None,
) -> None:
    if state not in {"succeeded", "failed"}:
        raise ValueError(f"invalid command finish state: {state}")
    conn.execute(
        """
        update commands
        set state = ?, updated_at = ?, result_json = ?, error = ?
        where id = ?
        """,
        (
            state,
            timestamp or now_iso(),
            json.dumps(result, sort_keys=True) if result is not None else None,
            error,
            command_id,
        ),
    )


def upsert_worker(
    conn: sqlite3.Connection,
    *,
    name: str,
    cwd: str,
    tmux_session: str,
    state: str,
    identity_token: str | None = None,
    tmux_pane_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    existing = conn.execute("select id, identity_token from workers where name = ?", (name,)).fetchone()
    worker_id = str(existing["id"]) if existing else f"worker-{uuid.uuid4()}"
    token = identity_token or f"workerctl-{uuid.uuid4()}"
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into workers(
          id, name, tmux_session, tmux_pane_id, identity_token, cwd, state, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(name) do update set
          tmux_session = excluded.tmux_session,
          tmux_pane_id = coalesce(excluded.tmux_pane_id, workers.tmux_pane_id),
          cwd = excluded.cwd,
          state = excluded.state,
          updated_at = excluded.updated_at,
          exit_detected_at = null,
          exit_reason = null
        """,
        (worker_id, name, tmux_session, tmux_pane_id, token, cwd, state, now, now),
    )
    row = conn.execute("select id from workers where name = ?", (name,)).fetchone()
    return str(row["id"])


def set_worker_pane_id(conn: sqlite3.Connection, *, worker_id: str, tmux_pane_id: str | None) -> None:
    if tmux_pane_id is None:
        return
    conn.execute(
        "update workers set tmux_pane_id = ?, updated_at = ? where id = ?",
        (tmux_pane_id, now_iso(), worker_id),
    )


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
          last_ingest_offset = null,
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


def session_by_id(conn: sqlite3.Connection, *, session_id: str) -> sqlite3.Row | None:
    """Look up a session by id. Returns the row or None if not found.

    Mirrors `session_row` (which looks up by name) but for id-keyed access.
    Callers that need a present-row contract should check the return value
    explicitly — this helper does not raise on missing.
    """
    return conn.execute(
        "select * from sessions where id = ?", (session_id,)
    ).fetchone()


def list_sessions(
    conn: sqlite3.Connection,
    *,
    role: str | None = None,
    include_legacy: bool = False,
    state: str | None = None,
) -> list[dict[str, Any]]:
    """List sessions, optionally filtering by role.

    By default, excludes legacy sessions (pid IS NULL) from Phase 1 backfill and
    gone sessions. Use include_legacy=True to opt in to legacy rows. Use
    state="all" to bypass both default filters.
    """
    if state not in (None, "active", "gone", "all"):
        raise ValueError(f"invalid state filter: {state!r}")

    query = "select * from sessions"
    clauses: list[str] = []
    params: list = []
    if role is not None:
        clauses.append("role = ?")
        params.append(role)
    if state == "gone":
        clauses.append("state = 'gone'")
    elif state == "all":
        pass
    else:
        clauses.append("state != 'gone'")
    if state in (None,) and not include_legacy:
        clauses.append("pid is not null")
    elif state == "active":
        clauses.append("pid is not null")
    if clauses:
        query += " where " + " and ".join(clauses)
    query += " order by registered_at"
    return [dict(row) for row in conn.execute(query, tuple(params))]


def deregister_session(conn: sqlite3.Connection, *, name: str, timestamp: str | None = None) -> None:
    now = timestamp or now_iso()
    existing = conn.execute("select id from sessions where name = ?", (name,)).fetchone()
    if existing is None:
        raise WorkerError(f"no session registered with name {name!r}")
    session_id = existing["id"]
    active_binding = conn.execute(
        """
        select id, task_id from bindings
        where state in ('active', 'ending')
          and (worker_session_id = ? or manager_session_id = ?)
        limit 1
        """,
        (session_id, session_id),
    ).fetchone()
    if active_binding is not None:
        raise WorkerError(
            f"cannot deregister session {name!r}: it is still bound to task "
            f"{active_binding['task_id']!r} (binding {active_binding['id']!r}). "
            f"Unbind the task first."
        )
    conn.execute(
        "update sessions set state='gone', last_heartbeat_at=? where name=?",
        (now, name),
    )


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


def insert_status(
    conn: sqlite3.Connection,
    *,
    worker_id: str,
    status: dict[str, Any],
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into statuses(worker_id, state, current_task, next_action, blocker, created_at)
        values (?, ?, ?, ?, ?, ?)
        """,
        (
            worker_id,
            status.get("state", "unknown"),
            status.get("current_task"),
            status.get("next_action"),
            status.get("blocker"),
            timestamp or status.get("last_update") or now_iso(),
        ),
    )
    return int(cursor.lastrowid)


def insert_transcript_capture(
    conn: sqlite3.Connection,
    *,
    worker_id: str,
    sha256: str,
    content: str,
    captured_at: str,
    changed_at: str,
    history_lines: int,
    changed: bool,
) -> int:
    cursor = conn.execute(
        """
        insert into transcript_captures(
          worker_id, sha256, content, captured_at, changed_at, history_lines,
          byte_count, line_count, capture_kind, retention_class
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            worker_id,
            sha256,
            content if changed else None,
            captured_at,
            changed_at,
            history_lines,
            len(content.encode()),
            len(content.splitlines()),
            "changed" if changed else "metadata_only",
            "hot",
        ),
    )
    return int(cursor.lastrowid)


def insert_terminal_capture(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    tmux_session: str,
    content_sha256: str,
    content: str,
    history_lines: int,
    source: str,
    worker_id: str | None = None,
    manager_id: str | None = None,
    tmux_pane_id: str | None = None,
    command_id: str | None = None,
    classifier: dict[str, Any] | None = None,
    content_path: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into terminal_captures(
          task_id, worker_id, manager_id, role, tmux_session, tmux_pane_id,
          command_id, captured_at, history_lines, content_sha256, content,
          content_path, byte_count, line_count, classifier_json, source
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            worker_id,
            manager_id,
            role,
            tmux_session,
            tmux_pane_id,
            command_id,
            timestamp or now_iso(),
            history_lines,
            content_sha256,
            content,
            content_path,
            len(content.encode()),
            len(content.splitlines()),
            json.dumps(classifier or {}, sort_keys=True),
            source,
        ),
    )
    return int(cursor.lastrowid)


def latest_terminal_capture_for_role(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    before_id: int | None = None,
) -> dict[str, Any] | None:
    where = "task_id = ? and role = ?"
    params: list[Any] = [task_id, role]
    if before_id is not None:
        where += " and id < ?"
        params.append(before_id)
    row = conn.execute(
        f"""
        select id, captured_at, content_sha256, content, line_count
        from terminal_captures
        where {where}
        order by id desc
        limit 1
        """,
        params,
    ).fetchone()
    return dict(row) if row else None


def insert_transcript_segment(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    source_capture_id: int,
    previous_capture_id: int | None,
    content_sha256: str,
    segment_text: str | None,
    segment_start_line: int | None,
    segment_end_line: int | None,
    segment_kind: str,
    retention_class: str = "hot",
    timestamp: str | None = None,
) -> int:
    row_timestamp = timestamp or now_iso()
    cursor = conn.execute(
        """
        insert into transcript_segments(
          task_id, role, source_capture_id, previous_capture_id, captured_at,
          content_sha256, segment_text, segment_start_line, segment_end_line,
          byte_count, line_count, retention_class, segment_kind, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            role,
            source_capture_id,
            previous_capture_id,
            row_timestamp,
            content_sha256,
            segment_text,
            segment_start_line,
            segment_end_line,
            len((segment_text or "").encode()),
            len((segment_text or "").splitlines()),
            retention_class,
            segment_kind,
            row_timestamp,
        ),
    )
    return int(cursor.lastrowid)


def insert_agent_observation(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    observation_type: str,
    severity: str,
    message: str,
    payload: dict[str, Any] | None = None,
    worker_id: str | None = None,
    manager_id: str | None = None,
    source_capture_id: int | None = None,
    command_id: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into agent_observations(
          task_id, worker_id, manager_id, role, observation_type, severity,
          source_capture_id, command_id, created_at, message, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            worker_id,
            manager_id,
            role,
            observation_type,
            severity,
            source_capture_id,
            command_id,
            timestamp or now_iso(),
            message,
            json.dumps(payload or {}, sort_keys=True),
        ),
    )
    return int(cursor.lastrowid)


def create_manager_cycle(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    manager_id: str | None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into manager_cycles(task_id, manager_id, started_at, state)
        values (?, ?, ?, 'started')
        """,
        (task_id, manager_id, timestamp or now_iso()),
    )
    return int(cursor.lastrowid)


def finish_manager_cycle(
    conn: sqlite3.Connection,
    *,
    cycle_id: int,
    state: str,
    health_observation_id: int | None = None,
    manager_capture_id: int | None = None,
    worker_capture_id: int | None = None,
    status: dict[str, Any] | None = None,
    health: dict[str, Any] | None = None,
    decision: str | None = None,
    error: str | None = None,
    timestamp: str | None = None,
) -> None:
    conn.execute(
        """
        update manager_cycles
        set completed_at = ?, state = ?, health_observation_id = ?,
            manager_capture_id = ?, worker_capture_id = ?, status_json = ?,
            health_json = ?, decision = ?, error = ?
        where id = ?
        """,
        (
            timestamp or now_iso(),
            state,
            health_observation_id,
            manager_capture_id,
            worker_capture_id,
            json.dumps(status, sort_keys=True) if status is not None else None,
            json.dumps(health, sort_keys=True) if health is not None else None,
            decision,
            error,
            cycle_id,
        ),
    )


def insert_manager_decision(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    manager_id: str | None,
    decision: str,
    reason: str,
    manager_cycle_id: int | None = None,
    payload: dict[str, Any] | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into manager_decisions(
          task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            manager_id,
            manager_cycle_id,
            decision,
            reason,
            timestamp or now_iso(),
            json.dumps(payload or {}, sort_keys=True),
        ),
    )
    return int(cursor.lastrowid)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def assess_manager_decision(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    decision_id: int | None,
    allowed_decisions: set[str],
    max_age_seconds: int = 900,
) -> dict[str, Any]:
    if decision_id is None:
        return {
            "allowed_decisions": sorted(allowed_decisions),
            "decision": None,
            "decision_id": None,
            "ok": False,
            "warnings": ["missing_decision_id"],
        }
    row = conn.execute(
        """
        select id, task_id, manager_id, manager_cycle_id, decision, reason,
               created_at, payload_json
        from manager_decisions
        where id = ?
        """,
        (decision_id,),
    ).fetchone()
    if row is None:
        return {
            "allowed_decisions": sorted(allowed_decisions),
            "decision": None,
            "decision_id": decision_id,
            "ok": False,
            "warnings": ["decision_not_found"],
        }
    decision = {
        "created_at": row["created_at"],
        "decision": row["decision"],
        "id": row["id"],
        "manager_cycle_id": row["manager_cycle_id"],
        "manager_id": row["manager_id"],
        "reason": row["reason"],
        "task_id": row["task_id"],
    }
    warnings: list[str] = []
    if row["task_id"] != task_id:
        warnings.append("decision_task_mismatch")
    if row["decision"] not in allowed_decisions:
        warnings.append("decision_mismatch")
    created_at = _parse_iso(row["created_at"])
    age_seconds = None
    if created_at is None:
        warnings.append("decision_timestamp_invalid")
    else:
        age_seconds = int((datetime.now(timezone.utc) - created_at).total_seconds())
        if age_seconds > max_age_seconds:
            warnings.append("decision_stale")
    return {
        "age_seconds": age_seconds,
        "allowed_decisions": sorted(allowed_decisions),
        "decision": decision,
        "decision_id": decision_id,
        "max_age_seconds": max_age_seconds,
        "ok": not warnings,
        "warnings": warnings,
    }


def require_manager_decision_ok(
    *,
    command_type: str,
    decision_check: dict[str, Any] | None,
    strict: bool,
) -> None:
    if not strict:
        return
    if decision_check and decision_check.get("ok"):
        return
    details = {
        "command_type": command_type,
        "error": "manager_decision_validation_failed",
        "manager_decision": decision_check,
    }
    raise WorkerError(f"strict manager decision validation failed: {json.dumps(details, sort_keys=True)}")


def task_row(conn: sqlite3.Connection, *, task: str) -> sqlite3.Row:
    row = conn.execute(
        """
        select id, name, goal, summary, state, created_at, updated_at
        from tasks
        where id = ? or name = ?
        order by created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown task: {task}")
    return row


def worker_row(conn: sqlite3.Connection, *, worker: str) -> sqlite3.Row:
    row = conn.execute(
        """
        select id, name, tmux_session, tmux_pane_id, identity_token, cwd, state,
               created_at, updated_at, last_seen_at, exit_detected_at, exit_reason
        from workers
        where id = ? or name = ?
        limit 1
        """,
        (worker, worker),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown worker: {worker}")
    return row


def create_task(
    conn: sqlite3.Connection,
    *,
    name: str,
    goal: str,
    summary: str | None = None,
    task_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    new_task_id = task_id or f"task-{uuid.uuid4()}"
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into tasks(id, name, goal, summary, state, created_at, updated_at)
        values (?, ?, ?, ?, 'candidate', ?, ?)
        """,
        (new_task_id, name, goal, summary, now, now),
    )
    insert_event(
        conn,
        "task_created",
        actor="workerctl",
        task_id=new_task_id,
        payload={"goal": goal, "name": name, "summary": summary},
    )
    return new_task_id


def ensure_task(
    conn: sqlite3.Connection,
    *,
    name: str,
    goal: str,
    summary: str | None = None,
    timestamp: str | None = None,
) -> str:
    row = conn.execute(
        """
        select id, state from tasks
        where name = ?
        order by created_at desc
        limit 1
        """,
        (name,),
    ).fetchone()
    if row is not None:
        if row["state"] not in {"candidate", "paused"}:
            raise WorkerError(f"Task {name} is not promotable in state {row['state']}")
        return str(row["id"])
    return create_task(conn, name=name, goal=goal, summary=summary, timestamp=timestamp)


def set_budget(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    max_nudges: int,
    expires_at: str,
) -> None:
    conn.execute(
        """
        insert into budgets(task_id, max_nudges, nudges_used, expires_at)
        values (?, ?, 0, ?)
        on conflict(task_id) do update set
          max_nudges = excluded.max_nudges,
          expires_at = excluded.expires_at,
          nudges_used = min(budgets.nudges_used, excluded.max_nudges)
        """,
        (task_id, max_nudges, expires_at),
    )


def extend_nudge_budget(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    add_nudges: int,
    expires_at: str,
) -> dict[str, Any]:
    if add_nudges <= 0:
        raise WorkerError("--add-nudges must be > 0")
    conn.execute(
        """
        insert into budgets(task_id, max_nudges, nudges_used, expires_at)
        values (?, ?, 0, ?)
        on conflict(task_id) do update set
          max_nudges = budgets.max_nudges + excluded.max_nudges,
          expires_at = excluded.expires_at
        """,
        (task_id, add_nudges, expires_at),
    )
    row = conn.execute(
        "select max_nudges, nudges_used, expires_at from budgets where task_id = ?",
        (task_id,),
    ).fetchone()
    return {
        "expires_at": row["expires_at"],
        "max_nudges": row["max_nudges"],
        "nudges_remaining": row["max_nudges"] - row["nudges_used"],
        "nudges_used": row["nudges_used"],
    }


def reserve_nudge_budget(conn: sqlite3.Connection, *, task_id: str, timestamp: str | None = None) -> dict[str, Any] | None:
    row = conn.execute(
        "select max_nudges, nudges_used, expires_at from budgets where task_id = ?",
        (task_id,),
    ).fetchone()
    if row is None:
        return None
    now = timestamp or now_iso()
    if row["expires_at"] < now:
        raise WorkerError(f"Nudge budget expired at {row['expires_at']}")
    if row["nudges_used"] >= row["max_nudges"]:
        raise WorkerError("Nudge budget exhausted")
    conn.execute(
        """
        update budgets
        set nudges_used = nudges_used + 1
        where task_id = ? and nudges_used < max_nudges and expires_at >= ?
        """,
        (task_id, now),
    )
    updated = conn.execute(
        "select max_nudges, nudges_used, expires_at from budgets where task_id = ?",
        (task_id,),
    ).fetchone()
    return {
        "expires_at": updated["expires_at"],
        "max_nudges": updated["max_nudges"],
        "nudges_remaining": updated["max_nudges"] - updated["nudges_used"],
        "nudges_used": updated["nudges_used"],
    }


def insert_prompt(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    kind: str,
    content: str,
    content_sha256: str,
    generator_version: str,
    source_snapshot: dict[str, Any],
    policy: dict[str, Any],
    manager_id: str | None = None,
    artifact_path: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into prompts(
          task_id, manager_id, kind, content, content_sha256, generator_version,
          source_snapshot_json, policy_json, artifact_path, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            manager_id,
            kind,
            content,
            content_sha256,
            generator_version,
            json.dumps(source_snapshot, sort_keys=True),
            json.dumps(policy, sort_keys=True),
            artifact_path,
            timestamp or now_iso(),
        ),
    )
    return int(cursor.lastrowid)


def create_manager(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    name: str,
    tmux_session: str,
    codex_args: list[str],
    state: str = "starting",
    manager_id: str | None = None,
    tmux_pane_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    new_manager_id = manager_id or name
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into managers(
          id, name, task_id, tmux_session, tmux_pane_id, state, codex_args_json, started_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (new_manager_id, name, task_id, tmux_session, tmux_pane_id, state, json.dumps(codex_args), now),
    )
    return new_manager_id


def manager_from_row(row: sqlite3.Row, *, task_id: str) -> dict[str, Any]:
    return {
        "codex_args": json.loads(row["codex_args_json"]),
        "exit_detected_at": row["exit_detected_at"],
        "exit_reason": row["exit_reason"],
        "id": row["id"],
        "last_seen_at": row["last_seen_at"],
        "name": row["name"],
        "started_at": row["started_at"],
        "state": row["state"],
        "stopped_at": row["stopped_at"],
        "task_id": task_id,
        "tmux_pane_id": row["tmux_pane_id"],
        "tmux_session": row["tmux_session"],
    }


def active_manager(conn: sqlite3.Connection, *, task: str) -> dict[str, Any] | None:
    task = task_row(conn, task=task)
    row = conn.execute(
        """
        select id, name, tmux_session, tmux_pane_id, state, codex_args_json, started_at,
               stopped_at, last_seen_at, exit_detected_at, exit_reason
        from managers
        where task_id = ? and state in ('starting', 'ready', 'stopping')
        order by started_at desc
        limit 1
        """,
        (task["id"],),
    ).fetchone()
    if row is None:
        return None
    return manager_from_row(row, task_id=task["id"])


def set_manager_pane_id(conn: sqlite3.Connection, *, manager_id: str, tmux_pane_id: str | None) -> None:
    if tmux_pane_id is None:
        return
    conn.execute(
        "update managers set tmux_pane_id = ? where id = ?",
        (tmux_pane_id, manager_id),
    )


def mark_manager_seen(
    conn: sqlite3.Connection,
    *,
    manager_id: str,
    last_capture_sha256: str | None = None,
    timestamp: str | None = None,
) -> None:
    conn.execute(
        """
        update managers
        set last_seen_at = ?,
            last_capture_sha256 = coalesce(?, last_capture_sha256)
        where id = ?
        """,
        (timestamp or now_iso(), last_capture_sha256, manager_id),
    )


def latest_manager_prompt(conn: sqlite3.Connection, *, task_id: str) -> sqlite3.Row:
    row = conn.execute(
        """
        select content, artifact_path
        from prompts
        where task_id = ? and kind = 'manager'
        order by id desc
        limit 1
        """,
        (task_id,),
    ).fetchone()
    if row is None:
        raise WorkerError("No manager prompt has been recorded for this task")
    return row


def set_manager_state(
    conn: sqlite3.Connection,
    *,
    manager_id: str,
    state: str,
    timestamp: str | None = None,
    exit_reason: str | None = None,
) -> None:
    now = timestamp or now_iso()
    stopped_at = now if state in {"stopped", "missing", "failed"} else None
    conn.execute(
        """
        update managers
        set state = ?, stopped_at = coalesce(?, stopped_at),
            exit_detected_at = case when ? in ('missing', 'failed') then ? else exit_detected_at end,
            exit_reason = coalesce(?, exit_reason)
        where id = ?
        """,
        (state, stopped_at, state, now, exit_reason, manager_id),
    )


def set_task_state(conn: sqlite3.Connection, *, task_id: str, state: str, timestamp: str | None = None) -> None:
    conn.execute(
        "update tasks set state = ?, updated_at = ? where id = ?",
        (state, timestamp or now_iso(), task_id),
    )


def attach_manager_to_binding(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    manager_id: str,
) -> None:
    conn.execute(
        """
        update bindings
        set manager_id = ?
        where task_id = ? and state in ('active', 'ending')
        """,
        (manager_id, task_id),
    )


def end_active_binding(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    timestamp: str | None = None,
) -> None:
    conn.execute(
        """
        update bindings
        set state = 'ended', ended_at = ?
        where task_id = ? and state in ('active', 'ending')
        """,
        (timestamp or now_iso(), task_id),
    )


def list_tasks(conn: sqlite3.Connection, *, active_only: bool = False) -> list[dict[str, Any]]:
    where = "where tasks.state in ('candidate', 'managed', 'paused')" if active_only else ""
    rows = conn.execute(
        f"""
        select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
               tasks.created_at, tasks.updated_at,
               budgets.max_nudges, budgets.nudges_used, budgets.expires_at
        from tasks
        left join budgets on budgets.task_id = tasks.id
        {where}
        order by tasks.created_at, tasks.id
        """
    ).fetchall()
    tasks: list[dict[str, Any]] = []
    for row in rows:
        task = {
            "created_at": row["created_at"],
            "goal": row["goal"],
            "id": row["id"],
            "name": row["name"],
            "state": row["state"],
            "summary": row["summary"],
            "updated_at": row["updated_at"],
        }
        if row["max_nudges"] is not None:
            task["budget"] = {
                "expires_at": row["expires_at"],
                "max_nudges": row["max_nudges"],
                "nudges_remaining": row["max_nudges"] - row["nudges_used"],
                "nudges_used": row["nudges_used"],
            }
        else:
            task["budget"] = None
        tasks.append(task)
    return tasks


def bind_task_worker(
    conn: sqlite3.Connection,
    *,
    task: str,
    worker: str,
    binding_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    task_row = conn.execute(
        "select id, name, state from tasks where id = ? or name = ? order by created_at desc limit 1",
        (task, task),
    ).fetchone()
    if task_row is None:
        raise WorkerError(f"Unknown task: {task}")
    if task_row["state"] not in {"candidate", "paused"}:
        raise WorkerError(f"Task {task_row['name']} is not bindable in state {task_row['state']}")

    worker_row = conn.execute("select id, name from workers where name = ? or id = ?", (worker, worker)).fetchone()
    if worker_row is None:
        raise WorkerError(f"Unknown worker: {worker}")

    active_task_binding = conn.execute(
        """
        select id from bindings
        where task_id = ? and state in ('active', 'ending')
        """,
        (task_row["id"],),
    ).fetchone()
    if active_task_binding is not None:
        raise WorkerError(f"Task {task_row['name']} already has an active binding")

    active_worker_binding = conn.execute(
        """
        select id from bindings
        where worker_id = ? and state in ('active', 'ending')
        """,
        (worker_row["id"],),
    ).fetchone()
    if active_worker_binding is not None:
        raise WorkerError(f"Worker {worker_row['name']} already has an active binding")

    new_binding_id = binding_id or f"binding-{uuid.uuid4()}"
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into bindings(id, task_id, worker_id, state, created_at)
        values (?, ?, ?, 'active', ?)
        """,
        (new_binding_id, task_row["id"], worker_row["id"], now),
    )
    conn.execute(
        """
        update tasks
        set state = 'managed', updated_at = ?
        where id = ?
        """,
        (now, task_row["id"]),
    )
    insert_event(
        conn,
        "worker_bound",
        actor="workerctl",
        task_id=task_row["id"],
        worker_id=worker_row["id"],
        payload={
            "binding_id": new_binding_id,
            "task": task_row["name"],
            "worker": worker_row["name"],
        },
    )
    return new_binding_id


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

    for label, session_record in (("worker", worker_sess), ("manager", manager_sess)):
        already_bound = conn.execute(
            """
            select id, task_id from bindings
            where state in ('active','ending')
              and (worker_session_id = ? or manager_session_id = ?)
            limit 1
            """,
            (session_record["id"], session_record["id"]),
        ).fetchone()
        if already_bound is not None:
            raise WorkerError(
                f"{label} session {session_record['name']!r} is already bound to task "
                f"{already_bound['task_id']!r} (binding {already_bound['id']!r})"
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
    """End the active binding for `task_name`. Raises WorkerError if no active binding."""
    now = timestamp or now_iso()
    task = task_row(conn, task=task_name)
    cursor = conn.execute(
        "update bindings set state='ended', ended_at=? "
        "where task_id=? and state in ('active','ending')",
        (now, task["id"]),
    )
    if cursor.rowcount == 0:
        raise WorkerError(f"no active binding for task {task_name!r}")


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


def divergent_cycles_for_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return successful Phase 3 cycle rows where the shadow pane signal flagged
    a notable pattern (`notable_pane_pattern` is non-null in `status_json`).

    Returns a list of dicts with keys: `id`, `task_id`, `started_at`,
    `completed_at`, `state`, `notable_pane_pattern`, `status` (parsed status_json).
    Ordered newest-first, capped at `limit`.

    Raises WorkerError if `task_name` is unknown. Failed cycles are excluded
    (they don't carry a notable_pane_pattern field — see supervise_cycle.run_cycle).

    The SQL filter `state = 'succeeded'` is a redundant guardrail in case a
    future failure-payload shape adds `notable_pane_pattern` — the data-flow
    guarantee (failure_status omits the key) is the primary mechanism; this is
    belt-and-suspenders.
    """
    task = task_row(conn, task=task_name)
    rows = conn.execute(
        """
        select
          id, task_id, started_at, completed_at, state, status_json,
          json_extract(status_json, '$.notable_pane_pattern') as notable_pane_pattern
        from manager_cycles
        where task_id = ?
          and state = 'succeeded'
          and json_extract(status_json, '$.notable_pane_pattern') is not null
        order by id desc
        limit ?
        """,
        (task["id"], limit),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "task_id": r["task_id"],
            "started_at": r["started_at"],
            "completed_at": r["completed_at"],
            "state": r["state"],
            "notable_pane_pattern": r["notable_pane_pattern"],
            "status": json.loads(r["status_json"]),
        }
        for r in rows
    ]


def active_task_worker(conn: sqlite3.Connection, *, task: str) -> dict[str, Any]:
    row = conn.execute(
        """
        select tasks.id as task_id, tasks.name as task_name, tasks.state as task_state,
               bindings.id as binding_id, bindings.state as binding_state,
               workers.id as worker_id, workers.name as worker_name,
               workers.tmux_session, workers.tmux_pane_id, workers.identity_token,
               workers.cwd, workers.state as worker_state
        from tasks
        left join bindings on bindings.task_id = tasks.id and bindings.state in ('active', 'ending')
        left join workers on workers.id = bindings.worker_id
        where tasks.id = ? or tasks.name = ?
        order by tasks.created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown task: {task}")
    if row["worker_id"] is None:
        manager = active_manager(conn, task=row["task_id"])
        manager_state = manager["state"] if manager else None
        raise WorkerError(
            f"Task {row['task_name']} has no active worker binding "
            f"(task_state={row['task_state']}, manager_state={manager_state})"
        )
    return {
        "binding_id": row["binding_id"],
        "binding_state": row["binding_state"],
        "task_id": row["task_id"],
        "task_name": row["task_name"],
        "task_state": row["task_state"],
        "worker_cwd": row["cwd"],
        "worker_id": row["worker_id"],
        "worker_identity_token": row["identity_token"],
        "worker_name": row["worker_name"],
        "worker_state": row["worker_state"],
        "worker_tmux_pane_id": row["tmux_pane_id"],
        "worker_tmux_session": row["tmux_session"],
    }


def task_audit(conn: sqlite3.Connection, *, task: str) -> dict[str, Any]:
    task_row = conn.execute(
        """
        select id, name, goal, summary, state, created_at, updated_at
        from tasks
        where id = ? or name = ?
        order by created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if task_row is None:
        raise WorkerError(f"Unknown task: {task}")

    event_rows = conn.execute(
        """
        select id, created_at, actor, command_id, correlation_id, task_id,
               worker_id, manager_id, type, payload_json
        from events
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    command_rows = conn.execute(
        """
        select id, idempotency_key, created_at, updated_at, task_id, worker_id,
               manager_id, type, state, payload_json, result_json, error
        from commands
        where task_id = ?
        order by created_at, id
        """,
        (task_row["id"],),
    ).fetchall()
    capture_rows = conn.execute(
        """
        select id, task_id, worker_id, manager_id, role, tmux_session,
               tmux_pane_id, command_id, captured_at, history_lines,
               content_sha256, content, content_path, byte_count, line_count,
               classifier_json, source
        from terminal_captures
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    segment_rows = conn.execute(
        """
        select id, task_id, role, source_capture_id, previous_capture_id,
               captured_at, content_sha256, segment_text, segment_start_line,
               segment_end_line, byte_count, line_count, retention_class,
               segment_kind, redacted, created_at
        from transcript_segments
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    observation_rows = conn.execute(
        """
        select id, task_id, worker_id, manager_id, role, observation_type,
               severity, source_capture_id, command_id, created_at, message,
               payload_json
        from agent_observations
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    cycle_rows = conn.execute(
        """
        select id, task_id, manager_id, started_at, completed_at, state,
               health_observation_id, manager_capture_id, worker_capture_id,
               status_json, health_json, decision, error
        from manager_cycles
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    decision_rows = conn.execute(
        """
        select id, task_id, manager_id, manager_cycle_id, decision, reason,
               created_at, payload_json
        from manager_decisions
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    return {
        "commands": [
            {
                "created_at": row["created_at"],
                "error": row["error"],
                "id": row["id"],
                "idempotency_key": row["idempotency_key"],
                "manager_id": row["manager_id"],
                "payload": json.loads(row["payload_json"]),
                "result": json.loads(row["result_json"]) if row["result_json"] else None,
                "state": row["state"],
                "task_id": row["task_id"],
                "type": row["type"],
                "updated_at": row["updated_at"],
                "worker_id": row["worker_id"],
            }
            for row in command_rows
        ],
        "agent_observations": [
            {
                "command_id": row["command_id"],
                "created_at": row["created_at"],
                "id": row["id"],
                "manager_id": row["manager_id"],
                "message": row["message"],
                "observation_type": row["observation_type"],
                "payload": json.loads(row["payload_json"]),
                "role": row["role"],
                "severity": row["severity"],
                "source_capture_id": row["source_capture_id"],
                "task_id": row["task_id"],
                "worker_id": row["worker_id"],
            }
            for row in observation_rows
        ],
        "events": [
            {
                "actor": row["actor"],
                "command_id": row["command_id"],
                "correlation_id": row["correlation_id"],
                "created_at": row["created_at"],
                "id": row["id"],
                "manager_id": row["manager_id"],
                "payload": json.loads(row["payload_json"]),
                "task_id": row["task_id"],
                "type": row["type"],
                "worker_id": row["worker_id"],
            }
            for row in event_rows
        ],
        "manager_cycles": [
            {
                "completed_at": row["completed_at"],
                "decision": row["decision"],
                "error": row["error"],
                "health": json.loads(row["health_json"]) if row["health_json"] else None,
                "health_observation_id": row["health_observation_id"],
                "id": row["id"],
                "manager_capture_id": row["manager_capture_id"],
                "manager_id": row["manager_id"],
                "started_at": row["started_at"],
                "state": row["state"],
                "status": json.loads(row["status_json"]) if row["status_json"] else None,
                "task_id": row["task_id"],
                "worker_capture_id": row["worker_capture_id"],
            }
            for row in cycle_rows
        ],
        "manager_decisions": [
            {
                "created_at": row["created_at"],
                "decision": row["decision"],
                "id": row["id"],
                "manager_cycle_id": row["manager_cycle_id"],
                "manager_id": row["manager_id"],
                "payload": json.loads(row["payload_json"]),
                "reason": row["reason"],
                "task_id": row["task_id"],
            }
            for row in decision_rows
        ],
        "task": {
            "created_at": task_row["created_at"],
            "goal": task_row["goal"],
            "id": task_row["id"],
            "name": task_row["name"],
            "state": task_row["state"],
            "summary": task_row["summary"],
            "updated_at": task_row["updated_at"],
        },
        "terminal_captures": [
            {
                "byte_count": row["byte_count"],
                "captured_at": row["captured_at"],
                "classifier": json.loads(row["classifier_json"]),
                "command_id": row["command_id"],
                "content": row["content"],
                "content_path": row["content_path"],
                "content_sha256": row["content_sha256"],
                "history_lines": row["history_lines"],
                "id": row["id"],
                "line_count": row["line_count"],
                "manager_id": row["manager_id"],
                "role": row["role"],
                "source": row["source"],
                "task_id": row["task_id"],
                "tmux_pane_id": row["tmux_pane_id"],
                "tmux_session": row["tmux_session"],
                "worker_id": row["worker_id"],
            }
            for row in capture_rows
        ],
        "transcript_segments": [
            {
                "byte_count": row["byte_count"],
                "captured_at": row["captured_at"],
                "content_sha256": row["content_sha256"],
                "created_at": row["created_at"],
                "id": row["id"],
                "line_count": row["line_count"],
                "previous_capture_id": row["previous_capture_id"],
                "redacted": bool(row["redacted"]),
                "retention_class": row["retention_class"],
                "role": row["role"],
                "segment_end_line": row["segment_end_line"],
                "segment_kind": row["segment_kind"],
                "segment_start_line": row["segment_start_line"],
                "segment_text": row["segment_text"],
                "source_capture_id": row["source_capture_id"],
                "task_id": row["task_id"],
            }
            for row in segment_rows
        ],
    }


def task_status_snapshot(conn: sqlite3.Connection, *, task: str) -> dict[str, Any]:
    task_row = conn.execute(
        """
        select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
               tasks.created_at, tasks.updated_at,
               budgets.max_nudges, budgets.nudges_used, budgets.expires_at
        from tasks
        left join budgets on budgets.task_id = tasks.id
        where tasks.id = ? or tasks.name = ?
        order by tasks.created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if task_row is None:
        raise WorkerError(f"Unknown task: {task}")

    binding_row = conn.execute(
        """
        select bindings.id, bindings.state, bindings.created_at,
               workers.id as worker_id, workers.name as worker_name,
               workers.tmux_session, workers.tmux_pane_id, workers.state as worker_state,
               workers.cwd
        from bindings
        join workers on workers.id = bindings.worker_id
        where bindings.task_id = ? and bindings.state in ('active', 'ending')
        order by bindings.created_at desc
        limit 1
        """,
        (task_row["id"],),
    ).fetchone()

    worker = None
    latest_status = None
    if binding_row is not None:
        worker = {
            "binding_id": binding_row["id"],
            "binding_state": binding_row["state"],
            "cwd": binding_row["cwd"],
            "id": binding_row["worker_id"],
            "name": binding_row["worker_name"],
            "state": binding_row["worker_state"],
            "tmux_pane_id": binding_row["tmux_pane_id"],
            "tmux_session": binding_row["tmux_session"],
        }
        status_row = conn.execute(
            """
            select state, current_task, next_action, blocker, created_at
            from statuses
            where worker_id = ?
            order by id desc
            limit 1
            """,
            (binding_row["worker_id"],),
        ).fetchone()
        if status_row is not None:
            latest_status = {
                "blocker": status_row["blocker"],
                "current_task": status_row["current_task"],
                "last_update": status_row["created_at"],
                "next_action": status_row["next_action"],
                "state": status_row["state"],
            }

    budget = None
    if task_row["max_nudges"] is not None:
        budget = {
            "expires_at": task_row["expires_at"],
            "max_nudges": task_row["max_nudges"],
            "nudges_remaining": task_row["max_nudges"] - task_row["nudges_used"],
            "nudges_used": task_row["nudges_used"],
        }

    manager = active_manager(conn, task=task_row["id"])
    integrity_issues = []
    if task_row["state"] == "managed" and worker is None:
        integrity_issues.append("managed_without_active_worker_binding")
    if task_row["state"] == "managed" and manager is None:
        integrity_issues.append("managed_without_active_manager")
    if task_row["state"] == "failed" and manager is not None:
        integrity_issues.append("closed_task_has_active_manager")

    return {
        "budget": budget,
        "created_at": task_row["created_at"],
        "goal": task_row["goal"],
        "id": task_row["id"],
        "name": task_row["name"],
        "state": task_row["state"],
        "summary": task_row["summary"],
        "updated_at": task_row["updated_at"],
        "integrity": {
            "issues": integrity_issues,
            "ok": not integrity_issues,
        },
        "manager": manager,
        "worker": worker,
        "worker_status": latest_status,
    }


def mark_worker_state(conn: sqlite3.Connection, *, name: str, state: str, timestamp: str | None = None) -> None:
    conn.execute(
        """
        update workers
        set state = ?, updated_at = ?
        where name = ?
        """,
        (state, timestamp or now_iso(), name),
    )
