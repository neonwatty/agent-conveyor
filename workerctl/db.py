from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError
from workerctl.core import now_iso
from workerctl.state import state_root


SCHEMA_VERSION = 2
REQUIRED_TABLES = {
    "bindings",
    "budgets",
    "commands",
    "data_migrations",
    "events",
    "managers",
    "prompts",
    "schema_migrations",
    "statuses",
    "tasks",
    "transcript_captures",
    "workers",
}
REQUIRED_INDEXES = {
    "commands_task_state_created",
    "events_task_id",
    "one_active_binding_per_task",
    "one_active_binding_per_worker",
    "one_active_manager_per_task",
    "statuses_worker_id",
    "transcript_captures_worker_id",
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
          worker_id text not null references workers(id),
          manager_id text references managers(id),
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

        create index if not exists commands_task_state_created
        on commands(task_id, state, created_at);

        create index if not exists statuses_worker_id
        on statuses(worker_id, id);

        create index if not exists transcript_captures_worker_id
        on transcript_captures(worker_id, id);

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
        "task_id": task["id"],
        "tmux_pane_id": row["tmux_pane_id"],
        "tmux_session": row["tmux_session"],
    }


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
        "task": {
            "created_at": task_row["created_at"],
            "goal": task_row["goal"],
            "id": task_row["id"],
            "name": task_row["name"],
            "state": task_row["state"],
            "summary": task_row["summary"],
            "updated_at": task_row["updated_at"],
        },
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
    if task_row["state"] in {"done", "failed"} and manager is not None:
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
