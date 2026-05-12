from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from workerctl.constants import PROJECT_ROOT, RECOMMENDED_MANAGER_CODEX_ARGS
from workerctl.core import WorkerError, age_seconds, ensure_tool, now_iso, run, sh_quote
from workerctl.db import active_manager
from workerctl.db import assess_manager_decision
from workerctl.db import attach_manager_to_binding
from workerctl.db import bind_task_worker
from workerctl.db import connect as connect_db
from workerctl.db import create_command as create_db_command
from workerctl.db import create_manager as create_db_manager
from workerctl.db import end_active_binding
from workerctl.db import ensure_task as ensure_db_task
from workerctl.db import finish_command as finish_db_command
from workerctl.db import insert_agent_observation
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_manager_decision
from workerctl.db import insert_prompt as insert_db_prompt
from workerctl.db import initialize_database
from workerctl.db import latest_manager_prompt
from workerctl.db import mark_manager_seen
from workerctl.db import mark_command_attempted
from workerctl.db import mark_worker_state, upsert_worker
from workerctl.db import require_manager_decision_ok
from workerctl.db import set_budget as set_db_budget
from workerctl.db import set_manager_pane_id
from workerctl.db import set_manager_state
from workerctl.db import set_task_state
from workerctl.db import set_worker_pane_id
from workerctl.db import task_status_snapshot
from workerctl import identity
from workerctl.state import append_event
from workerctl.state import capture_meta_path
from workerctl.state import config_path
from workerctl.state import latest_status
from workerctl.state import load_json
from workerctl.state import require_worker
from workerctl.state import state_root
from workerctl.state import transcript_path
from workerctl.state import write_json
from workerctl.tmux import send_text
from workerctl.tmux import session_exists
from workerctl.tmux import current_session_name
from workerctl.tmux import tmux_session
from workerctl.tmux import tmux_target

def safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return slug or "task"


def manager_session_name(task_id: str, task_name: str) -> str:
    return f"codex-manager-{safe_slug(task_name)[:32]}-{task_id[-8:]}"


def cli_path_prefix() -> str:
    return f"PATH={sh_quote(str(PROJECT_ROOT / 'bin'))}:$PATH"


def manager_session_exists(session_name: str) -> bool:
    proc = run(["tmux", "has-session", "-t", session_name], check=False)
    return proc.returncode == 0


def passthrough_args(values: list[str]) -> list[str]:
    if values and values[0] == "--":
        return values[1:]
    return values


def manager_codex_args_from_args(args: argparse.Namespace) -> list[str]:
    explicit_args = passthrough_args(getattr(args, "codex_args", None) or [])
    if explicit_args:
        return explicit_args
    if getattr(args, "no_manager_codex_args", False):
        return []
    return list(RECOMMENDED_MANAGER_CODEX_ARGS)


def task_artifact_dir(task_id: str) -> Path:
    return state_root() / "artifacts" / "tasks" / task_id


def _stop_or_finish_task(args: argparse.Namespace, *, finish: bool) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    command_type = "finish_task" if finish else "stop_task"
    event_prefix = "finish_task" if finish else "stop_task"
    final_reason = getattr(args, "reason", None) or "Task finished by operator."
    stop_manager = (not finish) or bool(getattr(args, "stop_manager", False))
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        if snapshot["state"] in {"done", "failed"}:
            raise WorkerError(f"Task {snapshot['name']} is already {snapshot['state']}")
        manager = active_manager(conn, task=snapshot["id"])
        worker = snapshot["worker"]
        decision_check = assess_manager_decision(
            conn,
            task_id=snapshot["id"],
            decision_id=getattr(args, "decision_id", None),
            allowed_decisions={"stop"},
        )
        require_manager_decision_ok(
            command_type=command_type,
            decision_check=decision_check,
            strict=getattr(args, "strict_decisions", False),
        )
        command_id = create_db_command(
            conn,
            command_type=command_type,
            task_id=snapshot["id"],
            worker_id=worker["id"] if worker else None,
            manager_id=manager["id"] if manager else None,
            payload={
                "finish": finish,
                "message": args.message,
                "manager_decision": decision_check,
                "reason": final_reason if finish else None,
                "stop_manager": stop_manager,
                "stop_worker": args.stop_worker,
                "task": snapshot["name"],
                "worker": worker["name"] if worker else None,
            },
        )
        final_decision_id = None
        final_observation_id = None
        if finish:
            final_decision_id = insert_manager_decision(
                conn,
                task_id=snapshot["id"],
                manager_id=manager["id"] if manager else None,
                decision="stop",
                reason=final_reason,
                payload={"source": "finish_task", "command_id": command_id},
            )
            final_observation_id = insert_agent_observation(
                conn,
                task_id=snapshot["id"],
                manager_id=manager["id"] if manager else None,
                worker_id=worker["id"] if worker else None,
                role="manager",
                observation_type="decision",
                severity="info",
                command_id=command_id,
                message=final_reason,
                payload={"decision": "stop", "decision_id": final_decision_id, "source": "finish_task"},
            )
        insert_db_event(
            conn,
            f"{event_prefix}_intent",
            actor="workerctl",
            command_id=command_id,
            task_id=snapshot["id"],
            worker_id=worker["id"] if worker else None,
            manager_id=manager["id"] if manager else None,
            payload={
                "finish": finish,
                "final_decision_id": final_decision_id,
                "final_observation_id": final_observation_id,
                "manager_decision": decision_check,
                "message": args.message,
                "reason": final_reason if finish else None,
                "stop_manager": stop_manager,
                "stop_worker": args.stop_worker,
            },
        )
        conn.commit()

    result = {
        "command_id": command_id,
        "final_decision_id": final_decision_id,
        "final_observation_id": final_observation_id,
        "finish": finish,
        "manager_decision": decision_check,
        "killed_manager": False,
        "killed_worker": False,
        "reason": final_reason if finish else None,
        "stop_manager": stop_manager,
        "stop_worker": args.stop_worker,
        "task": snapshot["name"],
        "worker": worker["name"] if worker else None,
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            conn.commit()
        if manager:
            manager_identity = identity.verify_manager_identity(manager)
            result["manager_identity"] = manager_identity
            with connect_db(db_path) as conn:
                initialize_database(conn)
                if manager_identity["live"]:
                    mark_manager_seen(conn, manager_id=manager["id"])
                insert_db_event(
                    conn,
                    "manager_identity_verified",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    manager_id=manager["id"],
                    payload=manager_identity,
                )
                conn.commit()
        if stop_manager and manager and result["manager_identity"]["live"]:
            run(["tmux", "kill-session", "-t", manager["tmux_session"]])
            result["killed_manager"] = True
        if args.stop_worker and worker:
            worker_identity = identity.verify_worker_record_identity(db_path, worker)
            result["worker_identity"] = worker_identity
            with connect_db(db_path) as conn:
                initialize_database(conn)
                insert_db_event(
                    conn,
                    "worker_identity_verified",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    worker_id=worker["id"],
                    payload=worker_identity,
                )
                conn.commit()
            if args.message and worker_identity["live"]:
                send_text(worker["name"], args.message)
                append_event(worker["name"], f"{event_prefix}_message", {"command_id": command_id, "message": args.message})
            if worker_identity["live"]:
                run(["tmux", "kill-session", "-t", tmux_target(worker["name"])])
                append_event(worker["name"], event_prefix, {"command_id": command_id, "task": snapshot["name"]})
                result["killed_worker"] = True
        with connect_db(db_path) as conn:
            initialize_database(conn)
            if manager and stop_manager:
                set_manager_state(conn, manager_id=manager["id"], state="stopped")
            if worker and args.stop_worker:
                mark_worker_state(conn, name=worker["name"], state="stopped")
            end_active_binding(conn, task_id=snapshot["id"])
            set_task_state(conn, task_id=snapshot["id"], state="done")
            finish_db_command(conn, command_id=command_id, state="succeeded", result=result)
            insert_db_event(
                conn,
                f"{event_prefix}_succeeded",
                actor="workerctl",
                command_id=command_id,
                task_id=snapshot["id"],
                worker_id=worker["id"] if worker else None,
                manager_id=manager["id"] if manager else None,
                payload=result,
            )
            conn.commit()
    except Exception as exc:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            finish_db_command(conn, command_id=command_id, state="failed", error=str(exc))
            insert_db_event(
                conn,
                f"{event_prefix}_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=snapshot["id"],
                worker_id=worker["id"] if worker else None,
                manager_id=manager["id"] if manager else None,
                payload={**result, "error": str(exc)},
            )
            conn.commit()
        raise
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_stop_task(args: argparse.Namespace) -> int:
    return _stop_or_finish_task(args, finish=False)


def command_finish_task(args: argparse.Namespace) -> int:
    return _stop_or_finish_task(args, finish=True)


def reconcile_rows(
    db_path: Path | None,
    *,
    task: str | None,
    recover: bool,
    sync_pane_ids: bool = False,
) -> list[dict[str, Any]]:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        params: tuple[Any, ...] = ()
        where = ""
        if task:
            where = "where tasks.id = ? or tasks.name = ?"
            params = (task, task)
        rows = conn.execute(
            f"""
            select tasks.id as task_id, tasks.name as task_name, tasks.state as task_state,
                   workers.id as worker_id, workers.name as worker_name,
                   workers.tmux_session as worker_session, workers.state as worker_state,
                   workers.tmux_pane_id as worker_pane_id,
                   managers.id as manager_id, managers.name as manager_name,
                   managers.tmux_session as manager_session, managers.tmux_pane_id as manager_pane_id,
                   managers.state as manager_state, managers.last_seen_at as manager_last_seen_at,
                   managers.last_capture_sha256 as manager_last_capture_sha256
            from tasks
            left join bindings on bindings.task_id = tasks.id and bindings.state in ('active', 'ending')
            left join workers on workers.id = bindings.worker_id
            left join managers on managers.task_id = tasks.id
              and managers.state in ('starting', 'ready', 'stopping')
              and managers.started_at = (
                select max(active_managers.started_at)
                from managers active_managers
                where active_managers.task_id = tasks.id
                  and active_managers.state in ('starting', 'ready', 'stopping')
              )
            {where}
            order by tasks.created_at, tasks.id
            """,
            params,
        ).fetchall()
        command_rows = conn.execute(
            """
            select commands.id, commands.type, commands.state, commands.created_at,
                   commands.updated_at, commands.task_id, tasks.name as task_name
            from commands
            left join tasks on tasks.id = commands.task_id
            where commands.state in ('pending', 'attempted')
            order by commands.created_at, commands.id
            """
        ).fetchall()
    unfinished_by_task: dict[str | None, list[dict[str, Any]]] = {}
    for command in command_rows:
        unfinished_by_task.setdefault(command["task_id"], []).append(
            {
                "created_at": command["created_at"],
                "id": command["id"],
                "recommended_action": "inspect audit; retry manually if external side effect did not happen",
                "state": command["state"],
                "task_id": command["task_id"],
                "task_name": command["task_name"],
                "type": command["type"],
                "updated_at": command["updated_at"],
            }
        )
    results = []
    for row in rows:
        worker_snapshot = manager_snapshot = None
        if row["worker_name"]:
            worker_snapshot = identity.session_snapshot(row["worker_session"])
        if row["manager_session"]:
            manager_snapshot = identity.session_snapshot(row["manager_session"])
        worker_live = worker_snapshot["live"] if worker_snapshot else None
        manager_live = manager_snapshot["live"] if manager_snapshot else None
        drift = []
        if row["worker_name"] and row["worker_state"] in {"active", "candidate"} and not worker_live:
            drift.append("worker_missing")
        if row["manager_id"] and row["manager_state"] in {"starting", "ready", "stopping"} and not manager_live:
            drift.append("manager_missing")
        if (
            row["worker_name"]
            and row["worker_pane_id"]
            and worker_live
            and worker_snapshot
            and worker_snapshot["pane_id"]
            and worker_snapshot["pane_id"] != row["worker_pane_id"]
        ):
            drift.append("worker_pane_mismatch")
        if (
            row["manager_id"]
            and row["manager_pane_id"]
            and manager_live
            and manager_snapshot
            and manager_snapshot["pane_id"]
            and manager_snapshot["pane_id"] != row["manager_pane_id"]
        ):
            drift.append("manager_pane_mismatch")
        result = {
            "drift": drift,
            "unfinished_commands": unfinished_by_task.get(row["task_id"], []),
            "manager": {
                "id": row["manager_id"],
                "live": manager_live,
                "name": row["manager_name"],
                "recorded_pane_id": row["manager_pane_id"],
                "session": row["manager_session"],
                "state": row["manager_state"],
                "last_capture_sha256": row["manager_last_capture_sha256"],
                "last_seen_age_seconds": age_seconds(row["manager_last_seen_at"]),
                "last_seen_at": row["manager_last_seen_at"],
                "tmux_pane_id": manager_snapshot["pane_id"] if manager_snapshot else None,
            } if row["manager_id"] else None,
            "task": {"id": row["task_id"], "name": row["task_name"], "state": row["task_state"]},
            "worker": {
                "id": row["worker_id"],
                "live": worker_live,
                "name": row["worker_name"],
                "recorded_pane_id": row["worker_pane_id"],
                "session": row["worker_session"],
                "state": row["worker_state"],
                "tmux_pane_id": worker_snapshot["pane_id"] if worker_snapshot else None,
            } if row["worker_id"] else None,
        }
        if result["unfinished_commands"] and "unfinished_commands" not in result["drift"]:
            result["drift"].append("unfinished_commands")
        results.append(result)
    if recover:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            for result in results:
                if result["worker"] and "worker_missing" in result["drift"]:
                    mark_worker_state(conn, name=result["worker"]["name"], state="missing")
                    insert_db_event(
                        conn,
                        "recover_worker_missing",
                        actor="workerctl",
                        task_id=result["task"]["id"],
                        worker_id=result["worker"]["id"],
                        payload={"worker": result["worker"]["name"]},
                    )
                if result["manager"] and "manager_missing" in result["drift"]:
                    set_manager_state(
                        conn,
                        manager_id=result["manager"]["id"],
                        state="missing",
                        exit_reason="tmux session missing during recover",
                    )
                    if result["task"]["state"] == "managed":
                        set_task_state(conn, task_id=result["task"]["id"], state="paused")
                    insert_db_event(
                        conn,
                        "recover_manager_missing",
                        actor="workerctl",
                        task_id=result["task"]["id"],
                        manager_id=result["manager"]["id"],
                        payload={"manager": result["manager"]["name"]},
                    )
                if result["worker"] and "worker_pane_mismatch" in result["drift"]:
                    if sync_pane_ids and result["worker"]["tmux_pane_id"]:
                        set_worker_pane_id(
                            conn,
                            worker_id=result["worker"]["id"],
                            tmux_pane_id=result["worker"]["tmux_pane_id"],
                        )
                        config = load_json(config_path(result["worker"]["name"]), {})
                        if isinstance(config, dict):
                            config["tmux_pane_id"] = result["worker"]["tmux_pane_id"]
                            write_json(config_path(result["worker"]["name"]), config)
                        insert_db_event(
                            conn,
                            "recover_worker_pane_synced",
                            actor="workerctl",
                            task_id=result["task"]["id"],
                            worker_id=result["worker"]["id"],
                            payload={
                                "previous_pane_id": result["worker"]["recorded_pane_id"],
                                "tmux_pane_id": result["worker"]["tmux_pane_id"],
                                "worker": result["worker"]["name"],
                            },
                        )
                    insert_db_event(
                        conn,
                        "recover_worker_pane_mismatch",
                        actor="workerctl",
                        task_id=result["task"]["id"],
                        worker_id=result["worker"]["id"],
                        payload={
                            "recorded_pane_id": result["worker"]["recorded_pane_id"],
                            "tmux_pane_id": result["worker"]["tmux_pane_id"],
                            "worker": result["worker"]["name"],
                        },
                    )
                if result["manager"] and "manager_pane_mismatch" in result["drift"]:
                    if sync_pane_ids and result["manager"]["tmux_pane_id"]:
                        set_manager_pane_id(
                            conn,
                            manager_id=result["manager"]["id"],
                            tmux_pane_id=result["manager"]["tmux_pane_id"],
                        )
                        insert_db_event(
                            conn,
                            "recover_manager_pane_synced",
                            actor="workerctl",
                            task_id=result["task"]["id"],
                            manager_id=result["manager"]["id"],
                            payload={
                                "manager": result["manager"]["name"],
                                "previous_pane_id": result["manager"]["recorded_pane_id"],
                                "tmux_pane_id": result["manager"]["tmux_pane_id"],
                            },
                        )
                    insert_db_event(
                        conn,
                        "recover_manager_pane_mismatch",
                        actor="workerctl",
                        task_id=result["task"]["id"],
                        manager_id=result["manager"]["id"],
                        payload={
                            "manager": result["manager"]["name"],
                            "recorded_pane_id": result["manager"]["recorded_pane_id"],
                            "tmux_pane_id": result["manager"]["tmux_pane_id"],
                        },
                    )
            conn.commit()
    return results


def manager_liveness_warnings(results: list[dict[str, Any]], *, stale_seconds: int) -> list[dict[str, Any]]:
    warnings = []
    for result in results:
        manager = result["manager"]
        if not manager or not manager["live"] or manager["state"] not in {"starting", "ready", "stopping"}:
            continue
        if manager["last_seen_at"] is None:
            warnings.append(
                {
                    "manager": manager["name"],
                    "manager_id": manager["id"],
                    "reason": "manager_never_seen",
                    "recommended_action": "observe manager or run a manager lifecycle command to refresh heartbeat",
                    "task": result["task"]["name"],
                    "task_id": result["task"]["id"],
                }
            )
            continue
        if manager["last_seen_age_seconds"] is not None and manager["last_seen_age_seconds"] > stale_seconds:
            warnings.append(
                {
                    "age_seconds": manager["last_seen_age_seconds"],
                    "last_seen_at": manager["last_seen_at"],
                    "manager": manager["name"],
                    "manager_id": manager["id"],
                    "reason": "manager_seen_stale",
                    "recommended_action": "inspect manager terminal; do not auto-recover unless tmux session is missing",
                    "stale_seconds": stale_seconds,
                    "task": result["task"]["name"],
                    "task_id": result["task"]["id"],
                }
            )
    return warnings


