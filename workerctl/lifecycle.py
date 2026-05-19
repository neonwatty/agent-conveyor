from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from workerctl.constants import DEFAULT_HISTORY_LINES, PROJECT_ROOT, RECOMMENDED_MANAGER_CODEX_ARGS
from workerctl.core import WorkerError, age_seconds, now_iso, raise_for_tmux_permission_failure, run, sh_quote
from workerctl.db import active_manager
from workerctl.db import active_binding_for_task
from workerctl.db import assess_manager_decision
from workerctl.db import acceptance_criteria_for_task
from workerctl.db import connect as connect_db
from workerctl.db import create_command as create_db_command
from workerctl.db import end_active_binding
from workerctl.db import finish_command as finish_db_command
from workerctl.db import insert_agent_observation
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_manager_decision
from workerctl.db import initialize_database
from workerctl.db import mark_manager_seen
from workerctl.db import mark_command_attempted
from workerctl.db import mark_worker_state
from workerctl.db import require_manager_decision_ok
from workerctl.db import set_manager_pane_id
from workerctl.db import set_manager_state
from workerctl.db import set_task_state
from workerctl.db import set_worker_pane_id
from workerctl.db import session_by_id
from workerctl.db import task_status_snapshot
from workerctl import identity
from workerctl.state import append_event
from workerctl.state import config_path
from workerctl.state import load_json
from workerctl.state import state_root
from workerctl.state import write_json
from workerctl.tmux import send_text
from workerctl.tmux import send_text_to_session
from workerctl.tmux import session_exists
from workerctl.tmux import tmux_session
from workerctl.tmux import tmux_target


CRITERIA_AUDIT_STATUSES = ("proposed", "accepted", "satisfied", "deferred", "rejected")


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return slug or "task"


def manager_session_name(task_id: str, task_name: str) -> str:
    return f"codex-manager-{safe_slug(task_name)[:32]}-{task_id[-8:]}"


def cli_path_prefix() -> str:
    return f"PATH={sh_quote(str(PROJECT_ROOT / 'bin'))}:$PATH"


def manager_session_exists(session_name: str) -> bool:
    proc = run(["tmux", "has-session", "-t", session_name], check=False)
    raise_for_tmux_permission_failure(proc)
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


def _final_criteria_audit(conn, *, task_id: str, require_criteria_audit: bool) -> dict[str, Any]:
    criteria = acceptance_criteria_for_task(conn, task_id=task_id)
    summary = {status: 0 for status in CRITERIA_AUDIT_STATUSES}
    for criterion in criteria:
        summary[criterion["status"]] = summary.get(criterion["status"], 0) + 1
    open_criteria = [
        {"id": criterion["id"], "criterion": criterion["criterion"]}
        for criterion in criteria
        if criterion["status"] == "accepted"
    ]
    return {
        "require_criteria_audit": require_criteria_audit,
        "open_criteria": open_criteria,
        "summary": summary,
        "total": len(criteria),
    }


def _final_criteria_audit_error(final_audit: dict[str, Any], *, task_name: str) -> str | None:
    open_criteria = final_audit["open_criteria"]
    if not open_criteria:
        return None
    details = "; ".join(f"#{criterion['id']}: {criterion['criterion']}" for criterion in open_criteria)
    return (
        f"Task {task_name} has accepted acceptance criteria still open; "
        f"satisfy, defer, or reject them before finishing: {details}"
    )


def _resolve_session_binding(conn, *, task_name: str) -> dict[str, Any] | None:
    try:
        binding = active_binding_for_task(conn, task_name=task_name)
    except WorkerError:
        return None
    worker_session = session_by_id(conn, session_id=binding["worker_session_id"])
    manager_session = session_by_id(conn, session_id=binding["manager_session_id"])
    return {
        "binding": binding,
        "manager": dict(manager_session) if manager_session is not None else None,
        "worker": dict(worker_session) if worker_session is not None else None,
    }


def _verify_session_identity(session: dict[str, Any]) -> dict[str, Any]:
    tmux_session_name = session.get("tmux_session")
    live = (
        identity.session_snapshot(tmux_session_name)
        if tmux_session_name
        else {"live": False, "pane_id": None, "session": None}
    )
    verification = {
        "db_pane_id": session.get("tmux_pane_id"),
        "db_session": tmux_session_name,
        "live": live["live"],
        "live_pane_id": live["pane_id"],
        "role": session["role"],
        "session": session["name"],
    }
    mismatches = []
    if not tmux_session_name:
        mismatches.append("tmux_session_missing")
    elif not live["live"]:
        mismatches.append("tmux_session_missing")
    if session.get("tmux_pane_id") and live["pane_id"] and live["pane_id"] != session["tmux_pane_id"]:
        mismatches.append("tmux_pane_mismatch")
    verification["mismatches"] = mismatches
    if mismatches:
        raise WorkerError(
            f"Session identity verification failed for {session['name']}: "
            f"{', '.join(mismatches)}"
        )
    return verification


def _summarize_pre_stop_capture(capture: dict[str, Any]) -> dict[str, Any]:
    capture_row = capture["capture"]
    segment = capture.get("transcript_segment")
    return {
        "capture_id": capture_row["id"],
        "content_sha256": capture_row["content_sha256"],
        "history_lines": capture_row["history_lines"],
        "line_count": capture_row["line_count"],
        "role": capture["role"],
        "source": capture_row["source"],
        "transcript_segment": (
            {
                "id": segment["id"],
                "kind": segment["segment_kind"],
                "line_count": segment["line_count"],
                "retention_class": segment.get("retention_class", "hot"),
            }
            if segment
            else None
        ),
    }


def _capture_pre_stop_transcripts(
    db_path: Path | None,
    *,
    task: str,
    command_id: str,
    stop_worker: bool,
    stop_manager: bool,
    lines: int,
    mode: str,
) -> list[dict[str, Any]]:
    from workerctl.commands import capture_task_terminal

    captures = []
    for role, should_capture in (("worker", stop_worker), ("manager", stop_manager)):
        if not should_capture:
            continue
        capture = capture_task_terminal(
            db_path,
            task=task,
            role=role,
            lines=lines,
            source="finish_task_pre_stop",
            command_id=command_id,
            transcript_mode=mode,
        )
        captures.append(_summarize_pre_stop_capture(capture))
    return captures


def _require_nonempty_transcript_segments(captures: list[dict[str, Any]]) -> None:
    missing = []
    for capture in captures:
        segment = capture.get("transcript_segment")
        if not segment or int(segment.get("line_count") or 0) <= 0:
            missing.append(capture.get("role", "unknown"))
    if missing:
        raise WorkerError(
            "no non-empty transcript segment captured for role(s): "
            + ", ".join(missing)
        )


def _stop_or_finish_task(args: argparse.Namespace, *, finish: bool) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    command_type = "finish_task" if finish else "stop_task"
    event_prefix = "finish_task" if finish else "stop_task"
    default_reason = "Task finished by operator." if finish else "Task stopped by operator."
    final_reason = getattr(args, "reason", None) or default_reason
    stop_manager = (not finish) or bool(getattr(args, "stop_manager", False))
    capture_transcript_before_stop = bool(getattr(args, "capture_transcript_before_stop", False))
    capture_transcript_lines = int(getattr(args, "capture_transcript_lines", DEFAULT_HISTORY_LINES))
    capture_transcript_mode = getattr(args, "capture_transcript_mode", "segment")
    require_transcript_segment = bool(getattr(args, "require_transcript_segment", False))
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        if snapshot["state"] in {"done", "failed"}:
            raise WorkerError(f"Task {snapshot['name']} is already {snapshot['state']}")
        require_criteria_audit = bool(getattr(args, "require_criteria_audit", False)) if finish else False
        final_audit = _final_criteria_audit(
            conn,
            task_id=snapshot["id"],
            require_criteria_audit=require_criteria_audit,
        )
        if require_criteria_audit:
            audit_error = _final_criteria_audit_error(final_audit, task_name=snapshot["name"])
            if audit_error is not None:
                command_id = create_db_command(
                    conn,
                    command_type=command_type,
                    task_id=snapshot["id"],
                    worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
                    payload={
                        "expected_failure": True,
                        "failure_stage": "final_criteria_audit",
                        "final_audit": final_audit,
                        "finish": finish,
                        "message": args.message,
                        "reason": final_reason,
                        "capture_transcript_before_stop": capture_transcript_before_stop,
                        "stop_manager": stop_manager,
                        "stop_worker": args.stop_worker,
                        "task": snapshot["name"],
                    },
                )
                mark_command_attempted(conn, command_id=command_id)
                result = {
                    "command_id": command_id,
                    "expected_failure": True,
                    "failure_stage": "final_criteria_audit",
                    "final_audit": final_audit,
                    "finish": finish,
                    "task": snapshot["name"],
                }
                finish_db_command(conn, command_id=command_id, state="failed", result=result, error=audit_error)
                insert_db_event(
                    conn,
                    f"{event_prefix}_failed",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
                    payload={**result, "error": audit_error, "error_type": "WorkerError"},
                )
                conn.commit()
                raise WorkerError(audit_error)
        manager = active_manager(conn, task=snapshot["id"])
        worker = snapshot["worker"]
        session_binding = _resolve_session_binding(conn, task_name=snapshot["name"])
        manager_session = session_binding["manager"] if session_binding else None
        worker_session = session_binding["worker"] if session_binding else None
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
                **({"final_audit": final_audit} if finish else {}),
                "capture_transcript_before_stop": capture_transcript_before_stop,
                "capture_transcript_lines": capture_transcript_lines,
                "capture_transcript_mode": capture_transcript_mode,
                "message": args.message,
                "manager_decision": decision_check,
                "reason": final_reason,
                "stop_manager": stop_manager,
                "stop_worker": args.stop_worker,
                "task": snapshot["name"],
                "worker": worker["name"] if worker else (worker_session["name"] if worker_session else None),
                "worker_session": worker_session["name"] if worker_session else None,
                "manager_session": manager_session["name"] if manager_session else None,
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
                **({"final_audit": final_audit} if finish else {}),
                "final_decision_id": final_decision_id,
                "final_observation_id": final_observation_id,
                "manager_decision": decision_check,
                "message": args.message,
                "capture_transcript_before_stop": capture_transcript_before_stop,
                "capture_transcript_lines": capture_transcript_lines,
                "capture_transcript_mode": capture_transcript_mode,
                "reason": final_reason,
                "stop_manager": stop_manager,
                "stop_worker": args.stop_worker,
            },
        )
        conn.commit()

    result = {
        "command_id": command_id,
        **({"final_audit": final_audit} if finish else {}),
        "final_decision_id": final_decision_id,
        "final_observation_id": final_observation_id,
        "finish": finish,
        "manager_decision": decision_check,
        "killed_manager": False,
        "killed_worker": False,
        "pre_stop_transcript_captures": [],
        "reason": final_reason,
        "stop_manager": stop_manager,
        "stop_worker": args.stop_worker,
        "task": snapshot["name"],
        "worker": worker["name"] if worker else (worker_session["name"] if worker_session else None),
        "worker_session": worker_session["name"] if worker_session else None,
        "manager_session": manager_session["name"] if manager_session else None,
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            if finish:
                insert_db_event(
                    conn,
                    "finish_task_criteria_audit",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    worker_id=worker["id"] if worker else None,
                    manager_id=manager["id"] if manager else None,
                    payload=final_audit,
                )
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
        elif manager_session:
            manager_identity = _verify_session_identity(manager_session)
            result["manager_identity"] = manager_identity
            with connect_db(db_path) as conn:
                initialize_database(conn)
                insert_db_event(
                    conn,
                    "manager_identity_verified",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    payload=manager_identity,
                )
                conn.commit()
        manager_tmux_session = None
        if manager and result.get("manager_identity", {}).get("live"):
            manager_tmux_session = manager["tmux_session"]
        elif manager_session and result.get("manager_identity", {}).get("live"):
            manager_tmux_session = manager_session["tmux_session"]
        if finish and capture_transcript_before_stop and (args.stop_worker or stop_manager):
            result["pre_stop_transcript_captures"] = _capture_pre_stop_transcripts(
                db_path,
                task=snapshot["name"],
                command_id=command_id,
                stop_worker=bool(args.stop_worker),
                stop_manager=bool(stop_manager),
                lines=capture_transcript_lines,
                mode=capture_transcript_mode,
            )
            if require_transcript_segment:
                _require_nonempty_transcript_segments(result["pre_stop_transcript_captures"])
            with connect_db(db_path) as conn:
                initialize_database(conn)
                insert_db_event(
                    conn,
                    "finish_task_pre_stop_transcript_captured",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    worker_id=worker["id"] if worker else None,
                    manager_id=manager["id"] if manager else None,
                    payload={
                        "captures": result["pre_stop_transcript_captures"],
                        "lines": capture_transcript_lines,
                        "mode": capture_transcript_mode,
                    },
                )
                conn.commit()
        if stop_manager and manager_tmux_session:
            run(["tmux", "kill-session", "-t", manager_tmux_session])
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
        elif args.stop_worker and worker_session:
            worker_identity = _verify_session_identity(worker_session)
            result["worker_identity"] = worker_identity
            with connect_db(db_path) as conn:
                initialize_database(conn)
                insert_db_event(
                    conn,
                    "worker_identity_verified",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=snapshot["id"],
                    payload=worker_identity,
                )
                conn.commit()
            if args.message and worker_identity["live"]:
                with connect_db(db_path) as conn:
                    initialize_database(conn)
                    send_text_to_session(conn, session_name=worker_session["name"], text=args.message)
            if worker_identity["live"]:
                run(["tmux", "kill-session", "-t", worker_session["tmux_session"]])
                result["killed_worker"] = True
        with connect_db(db_path) as conn:
            initialize_database(conn)
            stopped_at = now_iso()
            if manager and stop_manager:
                set_manager_state(conn, manager_id=manager["id"], state="stopped")
            if worker and args.stop_worker:
                mark_worker_state(conn, name=worker["name"], state="stopped")
            if manager_session and stop_manager:
                conn.execute(
                    "update sessions set state='gone', last_heartbeat_at=? where id=?",
                    (stopped_at, manager_session["id"]),
                )
            if worker_session and args.stop_worker:
                conn.execute(
                    "update sessions set state='gone', last_heartbeat_at=? where id=?",
                    (stopped_at, worker_session["id"]),
                )
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
