from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from workerctl.constants import PROJECT_ROOT, STATE_ROOT
from workerctl.core import WorkerError, age_seconds, now_iso


def state_root() -> Path:
    return PROJECT_ROOT / STATE_ROOT


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
    path = events_path(name)
    if not path.exists():
        return []
    events = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


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


def initial_status(name: str, task: str | None) -> dict[str, Any]:
    return {
        "blocker": None,
        "current_task": task or "Start worker Codex session.",
        "last_update": now_iso(),
        "next_action": "Wait for manager instruction or begin assigned task.",
        "state": "waiting",
    }


def worker_contract(name: str, task: str | None) -> str:
    status_file = status_path(name)
    task_text = task or "Wait for a task from the manager."
    return f"""You are a worker Codex session supervised by a manager Codex session.

Task:
{task_text}

Keep this file updated whenever you start a new phase, become blocked, begin long-running verification, or finish:
{status_file}

Use this JSON shape:
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


def write_worker_contract(name: str, task: str | None) -> Path:
    contract_path = worker_dir(name) / "contract.txt"
    contract_path.write_text(worker_contract(name, task))
    return contract_path

