from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from workerctl.constants import INVOCATION_CWD, STATE_ROOT
from workerctl.core import WorkerError, age_seconds, now_iso


def state_root() -> Path:
    override = os.environ.get("WORKERCTL_STATE_ROOT")
    if override:
        return Path(override)
    return INVOCATION_CWD / STATE_ROOT


def worker_dir(name: str) -> Path:
    validate_name(name)
    return state_root() / name


def validate_name(name: str) -> None:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    if not name or any(char not in allowed for char in name):
        raise WorkerError("Worker names may contain only letters, numbers, hyphens, and underscores.")


def config_path(name: str) -> Path:
    return worker_dir(name) / "config.json"


def status_path(name: str) -> Path:
    return worker_dir(name) / "status.json"


def events_path(name: str) -> Path:
    return worker_dir(name) / "events.jsonl"


def transcript_path(name: str) -> Path:
    return worker_dir(name) / "transcript.txt"


def capture_meta_path(name: str) -> Path:
    return worker_dir(name) / "capture-meta.json"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise WorkerError(f"Invalid JSON in {path}: {exc}") from exc


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def append_event(name: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
    event = {
        "time": now_iso(),
        "type": event_type,
        **(payload or {}),
    }
    events_path(name).parent.mkdir(parents=True, exist_ok=True)
    with events_path(name).open("a") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")


def read_events(name: str) -> list[dict[str, Any]]:
    events, _ = read_events_with_stats(name)
    return events


def read_events_with_stats(name: str) -> tuple[list[dict[str, Any]], int]:
    """Read worker events for `name`, returning `(events, skipped_line_count)`.

    Mirrors `read_events` but also reports how many malformed lines were silently
    skipped — useful for operator visibility into corrupted/truncated event logs.
    Blank lines do not count toward the skipped total; only lines that failed
    JSON decoding do.
    """
    path = events_path(name)
    if not path.exists():
        return [], 0
    events: list[dict[str, Any]] = []
    skipped = 0
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            skipped += 1
            continue
    return events, skipped


def last_event_age_seconds(name: str, event_type: str) -> int | None:
    for event in reversed(read_events(name)):
        if event.get("type") == event_type:
            return age_seconds(event.get("time"))
    return None


def require_worker(name: str) -> dict[str, Any]:
    config = load_json(config_path(name), None)
    if config is None:
        raise WorkerError(f"Unknown worker: {name}")
    return config


def latest_status(name: str) -> dict[str, Any]:
    fallback = load_json(status_path(name), {})
    try:
        from workerctl.db import connect as connect_db
        from workerctl.db import default_db_path, initialize_database

        if not default_db_path().exists():
            return fallback
        with connect_db() as conn:
            initialize_database(conn)
            row = conn.execute(
                """
                select statuses.state, statuses.current_task, statuses.next_action,
                       statuses.blocker, statuses.created_at
                from statuses
                join workers on workers.id = statuses.worker_id
                where workers.name = ?
                order by statuses.id desc
                limit 1
                """,
                (name,),
            ).fetchone()
        if row is None:
            return fallback
        return {
            "blocker": row["blocker"],
            "current_task": row["current_task"],
            "last_update": row["created_at"],
            "next_action": row["next_action"],
            "state": row["state"],
        }
    except Exception:
        return fallback


def initial_status(name: str, task: str | None) -> dict[str, Any]:
    return {
        "blocker": None,
        "current_task": task or "Start worker Codex session.",
        "last_update": now_iso(),
        "next_action": "Wait for manager instruction or begin assigned task.",
        "state": "waiting",
    }


def worker_contract(name: str, task: str | None, identity_token: str | None = None) -> str:
    status_file = status_path(name)
    task_text = task or "Wait for a task from the manager."
    identity_section = ""
    if identity_token:
        identity_section = f"""
Worker identity token:
{identity_token}

Keep this token unchanged. It lets workerctl verify that task-scoped manager
commands are targeting the intended worker session.
"""
    return f"""You are a worker Codex session supervised by a manager Codex session.

Task:
{task_text}
{identity_section}

Report status whenever you start a new phase, become blocked, begin long-running
verification, or finish. Use workerctl as the primary status path:

workerctl update-status {name} \\
  --state planning \\
  --current-task "short description" \\
  --next-action "short description"

Allowed state values:
planning, editing, running_tests, blocked, waiting, done, unknown

If you are blocked, include --blocker:

workerctl update-status {name} \\
  --state blocked \\
  --current-task "short description" \\
  --next-action "wait for direction" \\
  --blocker "what is blocking progress"

workerctl also exports this compatibility file for existing tooling:
{status_file}

Dispatcher inbox:
- If this worker is registered without a tmux session, manager nudges are
  pull-required dispatcher signals. Poll for them with:

  workerctl worker-inbox <task-name> --consume-next --wait --timeout 60 --json

- Treat a consumed inbox item as the next manager instruction, then update
  status with workerctl. Each consumed item records `dispatch_inbox_consumed`
  telemetry so the dispatcher-to-session handoff is auditable.

Compatibility JSON shape:
{{
  "state": "planning | editing | running_tests | blocked | waiting | done",
  "current_task": "short description",
  "last_update": "ISO-8601 timestamp",
  "next_action": "short description",
  "blocker": null
}}

Do not perform destructive git actions unless the user explicitly asks.
If you are blocked or need direction, set state to blocked and explain the blocker.
"""


def write_worker_contract(name: str, task: str | None, identity_token: str | None = None) -> Path:
    contract_path = worker_dir(name) / "contract.txt"
    contract_path.write_text(worker_contract(name, task, identity_token))
    return contract_path
