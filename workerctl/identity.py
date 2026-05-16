from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError, raise_for_tmux_permission_failure, run
from workerctl.db import connect as connect_db
from workerctl.db import initialize_database
from workerctl.state import require_worker


def session_snapshot(session_name: str) -> dict[str, Any]:
    if shutil.which("tmux") is None:
        return {"live": False, "pane_id": None, "session": session_name}
    proc = run(["tmux", "has-session", "-t", session_name], check=False)
    raise_for_tmux_permission_failure(proc)
    if proc.returncode != 0:
        return {"live": False, "pane_id": None, "session": session_name}
    panes = run(["tmux", "list-panes", "-t", session_name, "-F", "#{pane_id}"], check=False)
    raise_for_tmux_permission_failure(panes)
    pane_ids = [line for line in panes.stdout.splitlines() if line.strip()] if panes.returncode == 0 else []
    return {"live": True, "pane_id": pane_ids[0] if pane_ids else None, "session": session_name}


def verify_manager_identity(manager: dict[str, Any]) -> dict[str, Any]:
    live = session_snapshot(manager["tmux_session"])
    verification = {
        "db_pane_id": manager.get("tmux_pane_id"),
        "db_session": manager["tmux_session"],
        "live": live["live"],
        "live_pane_id": live["pane_id"],
        "manager": manager["name"],
    }
    mismatches = []
    if not live["live"]:
        mismatches.append("manager_session_missing")
    if manager.get("tmux_pane_id") and live["pane_id"] and live["pane_id"] != manager["tmux_pane_id"]:
        mismatches.append("manager_pane_mismatch")
    verification["mismatches"] = mismatches
    if mismatches:
        raise WorkerError(f"Manager identity verification failed for {manager['name']}: {', '.join(mismatches)}")
    return verification


def verify_worker_binding_identity(binding: dict[str, Any]) -> dict[str, Any]:
    config = require_worker(binding["worker_name"])
    live = session_snapshot(binding["worker_tmux_session"])
    verification = {
        "config_pane_id": config.get("tmux_pane_id"),
        "config_session": config.get("tmux_session"),
        "config_token": config.get("identity_token"),
        "db_pane_id": binding.get("worker_tmux_pane_id"),
        "db_session": binding["worker_tmux_session"],
        "db_token": binding.get("worker_identity_token"),
        "live": live["live"],
        "live_pane_id": live["pane_id"],
        "worker": binding["worker_name"],
    }
    mismatches = []
    if not config.get("identity_token"):
        mismatches.append("config_identity_token_missing")
    if config.get("identity_token") and config.get("identity_token") != binding.get("worker_identity_token"):
        mismatches.append("identity_token_mismatch")
    if config.get("tmux_session") != binding["worker_tmux_session"]:
        mismatches.append("tmux_session_mismatch")
    if not live["live"]:
        mismatches.append("tmux_session_missing")
    if binding.get("worker_tmux_pane_id") and live["pane_id"] and live["pane_id"] != binding["worker_tmux_pane_id"]:
        mismatches.append("tmux_pane_mismatch")
    if config.get("tmux_pane_id") and binding.get("worker_tmux_pane_id") and config.get("tmux_pane_id") != binding["worker_tmux_pane_id"]:
        mismatches.append("config_pane_mismatch")
    verification["mismatches"] = mismatches
    if mismatches:
        raise WorkerError(f"Worker identity verification failed for {binding['worker_name']}: {', '.join(mismatches)}")
    return verification


def verify_worker_record_identity(db_path: Path | None, worker: dict[str, Any]) -> dict[str, Any]:
    config = require_worker(worker["name"])
    with connect_db(db_path) as conn:
        initialize_database(conn)
        row = conn.execute(
            """
            select identity_token, tmux_pane_id, tmux_session
            from workers
            where id = ?
            """,
            (worker["id"],),
        ).fetchone()
    if row is None:
        raise WorkerError(f"Worker identity verification failed for {worker['name']}: worker_missing")
    binding = {
        "worker_identity_token": row["identity_token"],
        "worker_name": worker["name"],
        "worker_tmux_pane_id": row["tmux_pane_id"],
        "worker_tmux_session": row["tmux_session"],
    }
    return verify_worker_binding_identity(binding)
