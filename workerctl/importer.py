from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from workerctl.constants import VALID_STATES
from workerctl.core import now_iso
from workerctl.db import connect as connect_db
from workerctl.db import initialize_database
from workerctl.db import insert_status as insert_db_status
from workerctl.db import insert_transcript_capture
from workerctl.db import upsert_worker
from workerctl.state import load_json
from workerctl.state import state_root


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def migration_name(root: Path, path: Path, digest: str, suffix: str = "") -> str:
    relative = path.relative_to(root)
    return f"compat:{relative}{suffix}:{digest}"


def migration_applied(conn, name: str) -> bool:
    row = conn.execute("select 1 from data_migrations where name = ?", (name,)).fetchone()
    return row is not None


def record_migration(conn, *, name: str, source_path: Path, source_hash: str) -> None:
    conn.execute(
        """
        insert or ignore into data_migrations(name, source_path, source_hash, applied_at)
        values (?, ?, ?, ?)
        """,
        (name, str(source_path), source_hash, now_iso()),
    )


def normal_status(payload: dict[str, Any]) -> dict[str, Any]:
    state = payload.get("state", "unknown")
    if state not in VALID_STATES:
        state = "unknown"
    return {
        "blocker": payload.get("blocker"),
        "current_task": payload.get("current_task"),
        "last_update": payload.get("last_update") or now_iso(),
        "next_action": payload.get("next_action"),
        "state": state,
    }


def existing_worker_state(conn, name: str) -> str | None:
    row = conn.execute("select state from workers where name = ?", (name,)).fetchone()
    return str(row["state"]) if row else None


def status_exists(conn, *, worker_id: str, status: dict[str, Any], timestamp: str) -> bool:
    row = conn.execute(
        """
        select 1 from statuses
        where worker_id = ? and state = ? and current_task is ?
          and next_action is ? and blocker is ? and created_at = ?
        limit 1
        """,
        (
            worker_id,
            status.get("state", "unknown"),
            status.get("current_task"),
            status.get("next_action"),
            status.get("blocker"),
            timestamp,
        ),
    ).fetchone()
    return row is not None


def transcript_capture_exists(conn, *, worker_id: str, digest: str, captured_at: str) -> bool:
    row = conn.execute(
        """
        select 1 from transcript_captures
        where worker_id = ? and sha256 = ? and captured_at = ?
        limit 1
        """,
        (worker_id, digest, captured_at),
    ).fetchone()
    return row is not None


def insert_compat_event(
    conn,
    *,
    worker_id: str,
    event: dict[str, Any],
    source_path: Path,
) -> None:
    event_type = str(event.get("type") or "event")
    created_at = str(event.get("time") or event.get("created_at") or now_iso())
    payload = {key: value for key, value in event.items() if key not in {"time", "type"}}
    payload["source_path"] = str(source_path)
    conn.execute(
        """
        insert into events(
          created_at, actor, command_id, correlation_id, task_id, worker_id,
          manager_id, type, payload_json
        )
        values (?, 'compat', null, null, null, ?, null, ?, ?)
        """,
        (created_at, worker_id, f"compat_{event_type}", json.dumps(payload, sort_keys=True)),
    )


def iter_worker_dirs(root: Path, worker: str | None) -> list[Path]:
    if worker:
        path = root / worker
        return [path] if (path / "config.json").exists() else []
    if not root.exists():
        return []
    return sorted(path for path in root.iterdir() if path.is_dir() and (path / "config.json").exists())


def import_compat_worker(conn, *, root: Path, worker_path: Path, apply_changes: bool) -> dict[str, Any]:
    config_path = worker_path / "config.json"
    status_path = worker_path / "status.json"
    events_path = worker_path / "events.jsonl"
    transcript_path = worker_path / "transcript.txt"
    capture_meta_path = worker_path / "capture-meta.json"

    config = load_json(config_path, {})
    worker_name = str(config.get("name") or worker_path.name)
    config_digest = file_sha256(config_path)
    config_migration = migration_name(root, config_path, config_digest)
    already_config = migration_applied(conn, config_migration)
    existing_state = existing_worker_state(conn, worker_name)
    worker_id = worker_name
    actions: list[dict[str, Any]] = []

    if not already_config:
        actions.append({"action": "upsert_worker", "source": str(config_path), "worker": worker_name})
        if apply_changes:
            worker_id = upsert_worker(
                conn,
                name=worker_name,
                cwd=str(config.get("cwd") or ""),
                tmux_session=str(config.get("tmux_session") or f"codex-{worker_name}"),
                identity_token=config.get("identity_token"),
                tmux_pane_id=config.get("tmux_pane_id"),
                state=existing_state or "candidate",
                timestamp=config.get("created_at"),
            )
            record_migration(conn, name=config_migration, source_path=config_path, source_hash=config_digest)
    elif apply_changes:
        row = conn.execute("select id from workers where name = ?", (worker_name,)).fetchone()
        if row:
            worker_id = str(row["id"])

    if status_path.exists():
        status_digest = file_sha256(status_path)
        status_migration = migration_name(root, status_path, status_digest)
        if not migration_applied(conn, status_migration):
            status = normal_status(load_json(status_path, {}))
            timestamp = status.get("last_update") or now_iso()
            actions.append({"action": "insert_status", "source": str(status_path), "worker": worker_name})
            if apply_changes:
                if not status_exists(conn, worker_id=worker_id, status=status, timestamp=timestamp):
                    insert_db_status(conn, worker_id=worker_id, status=status, timestamp=timestamp)
                record_migration(conn, name=status_migration, source_path=status_path, source_hash=status_digest)

    if transcript_path.exists():
        transcript = transcript_path.read_text()
        transcript_digest = text_sha256(transcript)
        transcript_migration = migration_name(root, transcript_path, transcript_digest)
        if transcript and not migration_applied(conn, transcript_migration):
            capture_meta = load_json(capture_meta_path, {}) if capture_meta_path.exists() else {}
            captured_at = capture_meta.get("captured_at") or capture_meta.get("changed_at") or now_iso()
            changed_at = capture_meta.get("changed_at") or captured_at
            history_lines = int(capture_meta.get("history_lines") or len(transcript.splitlines()) or 1)
            actions.append({"action": "insert_transcript_capture", "source": str(transcript_path), "worker": worker_name})
            if apply_changes:
                if not transcript_capture_exists(conn, worker_id=worker_id, digest=transcript_digest, captured_at=captured_at):
                    insert_transcript_capture(
                        conn,
                        worker_id=worker_id,
                        sha256=transcript_digest,
                        content=transcript,
                        captured_at=captured_at,
                        changed_at=changed_at,
                        history_lines=history_lines,
                        changed=True,
                    )
                record_migration(conn, name=transcript_migration, source_path=transcript_path, source_hash=transcript_digest)

    if events_path.exists():
        for index, line in enumerate(events_path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            line_digest = text_sha256(line)
            event_migration = migration_name(root, events_path, line_digest, suffix=f":{index}")
            if migration_applied(conn, event_migration):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                actions.append({"action": "skip_invalid_event", "line": index, "source": str(events_path)})
                continue
            actions.append({"action": "insert_event", "line": index, "source": str(events_path), "worker": worker_name})
            if apply_changes:
                insert_compat_event(conn, worker_id=worker_id, event=event, source_path=events_path)
                record_migration(conn, name=event_migration, source_path=events_path, source_hash=line_digest)

    return {
        "actions": actions,
        "action_count": len(actions),
        "worker": worker_name,
    }


def command_import_compat(args: argparse.Namespace) -> int:
    root = Path(args.root).expanduser().resolve() if args.root else state_root()
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    apply_changes = bool(getattr(args, "apply", False))
    worker_results = []
    with connect_db(db_path) as conn:
        initialize_database(conn)
        for worker_path in iter_worker_dirs(root, args.worker):
            worker_results.append(import_compat_worker(conn, root=root, worker_path=worker_path, apply_changes=apply_changes))
        if apply_changes:
            conn.commit()
    print(
        json.dumps(
            {
                "apply": apply_changes,
                "root": str(root),
                "workers": worker_results,
                "worker_count": len(worker_results),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0
