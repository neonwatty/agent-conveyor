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

from workerctl.constants import PROJECT_ROOT
from workerctl.core import WorkerError, age_seconds, ensure_tool, now_iso, run, sh_quote
from workerctl.db import active_manager
from workerctl.db import attach_manager_to_binding
from workerctl.db import bind_task_worker
from workerctl.db import connect as connect_db
from workerctl.db import create_command as create_db_command
from workerctl.db import create_manager as create_db_manager
from workerctl.db import end_active_binding
from workerctl.db import ensure_task as ensure_db_task
from workerctl.db import finish_command as finish_db_command
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_prompt as insert_db_prompt
from workerctl.db import initialize_database
from workerctl.db import latest_manager_prompt
from workerctl.db import mark_manager_seen
from workerctl.db import mark_command_attempted
from workerctl.db import mark_worker_state, upsert_worker
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


def resumed_manager_session_name(task_id: str, task_name: str) -> str:
    return f"{manager_session_name(task_id, task_name)}-{uuid.uuid4().hex[:8]}"


def manager_record_name(task_name: str) -> str:
    return f"manager-{safe_slug(task_name)[:40]}-{uuid.uuid4().hex[:8]}"


def cli_path_prefix() -> str:
    return f"PATH={sh_quote(str(PROJECT_ROOT / 'bin'))}:$PATH"


def manager_session_exists(session_name: str) -> bool:
    proc = run(["tmux", "has-session", "-t", session_name], check=False)
    return proc.returncode == 0


def default_budget_expires_at(hours: int = 24) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def passthrough_args(values: list[str]) -> list[str]:
    if values and values[0] == "--":
        return values[1:]
    return values


def task_artifact_dir(task_id: str) -> Path:
    return state_root() / "artifacts" / "tasks" / task_id


def build_manager_prompt(
    *,
    task_name: str,
    goal: str,
    summary: str | None,
    manager_instructions: str | None,
    worker_name: str,
    budget: dict[str, Any],
    source_snapshot: dict[str, Any] | None = None,
) -> str:
    instructions = manager_instructions or "Observe the worker and intervene only through workerctl task-scoped commands."
    snapshot = source_snapshot or {}
    return "\n".join(
        [
            f"# Manager for {task_name}",
            "",
            "You are supervising a Codex worker through workerctl.",
            "",
            f"Task: {task_name}",
            f"Goal: {goal}",
            f"Worker: {worker_name}",
            f"Summary: {summary or 'No summary provided.'}",
            "",
            "Manager instructions:",
            instructions,
            "",
            "Required control commands:",
            f"- workerctl manager-observe {task_name} --json",
            f"- workerctl manager-decision {task_name} --decision <wait|nudge|interrupt|escalate|stop|inspect> --reason \"<reason>\"",
            f"- workerctl task-health {task_name} --json",
            f"- workerctl task-status {task_name} --json",
            f"- workerctl task-capture {task_name} --lines 120 --json",
            f"- workerctl task-capture {task_name} --role manager --lines 120 --json",
            f"- workerctl task-idle-check {task_name}",
            f"- workerctl task-nudge {task_name} \"<message>\"",
            f"- workerctl task-interrupt {task_name}",
            f"- workerctl audit {task_name} --json",
            "",
            "Rules:",
            "- Use only task-scoped workerctl commands for worker communication.",
            "- Start each loop with manager-observe so health, status, and terminal captures are recorded.",
            "- Record decisions with manager-decision before mutating worker state.",
            "- Run task-health first when state is uncertain or any task-scoped command fails.",
            "- Read task-status before nudging and respect the live nudge budget.",
            "- Stop and report if the worker is blocked, the budget is exhausted, or state is uncertain.",
            "",
            f"Initial nudge budget: {budget['max_nudges']} until {budget['expires_at']}.",
            "",
            "Source snapshot:",
            "```json",
            json.dumps(snapshot, indent=2, sort_keys=True),
            "```",
            "",
        ]
    )


def git_snapshot(cwd: str | None) -> dict[str, Any]:
    if not cwd:
        return {"available": False, "reason": "missing cwd"}
    directory = Path(cwd)
    if not directory.exists():
        return {"available": False, "reason": "cwd missing", "cwd": cwd}
    status = run(["git", "-C", str(directory), "status", "--short"], check=False)
    branch = run(["git", "-C", str(directory), "rev-parse", "--abbrev-ref", "HEAD"], check=False)
    head = run(["git", "-C", str(directory), "rev-parse", "HEAD"], check=False)
    if status.returncode != 0:
        return {"available": False, "cwd": cwd, "reason": status.stderr.strip() or status.stdout.strip()}
    return {
        "available": True,
        "branch": branch.stdout.strip() if branch.returncode == 0 else None,
        "cwd": cwd,
        "head": head.stdout.strip() if head.returncode == 0 else None,
        "status_short": status.stdout.splitlines(),
    }


def command_promote(args: argparse.Namespace) -> int:
    config = require_worker(args.worker)
    ensure_tool("tmux")
    ensure_tool("codex")
    if args.max_nudges < 0:
        raise WorkerError("--max-nudges must be >= 0")

    if not session_exists(args.worker):
        raise WorkerError(f"Worker tmux session is not running: {tmux_target(args.worker)}")

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    codex_args = passthrough_args(args.codex_args or [])
    expires_at = args.budget_expires_at or default_budget_expires_at(args.budget_hours)
    manager_id = None
    command_id = None
    prompt_path = None
    prompt_content = ""
    with connect_db(db_path) as conn:
        initialize_database(conn)
        worker_id = upsert_worker(
            conn,
            name=args.worker,
            cwd=config.get("cwd", ""),
            tmux_session=config.get("tmux_session", tmux_session(args.worker)),
            identity_token=config.get("identity_token"),
            tmux_pane_id=config.get("tmux_pane_id"),
            state="active",
        )
        task_id = ensure_db_task(conn, name=args.task, goal=args.goal, summary=args.summary)
        binding_id = bind_task_worker(conn, task=task_id, worker=worker_id)
        set_db_budget(conn, task_id=task_id, max_nudges=args.max_nudges, expires_at=expires_at)
        manager_name = manager_record_name(args.task)
        manager_session = manager_session_name(task_id, args.task)
        if manager_session_exists(manager_session):
            raise WorkerError(f"Manager tmux session already exists: {manager_session}")
        manager_id = create_db_manager(
            conn,
            task_id=task_id,
            name=manager_name,
            tmux_session=manager_session,
            codex_args=codex_args,
            state="starting",
        )
        attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
        source_snapshot = {
            "capture_meta": load_json(capture_meta_path(args.worker), {}),
            "git": git_snapshot(config.get("cwd")),
            "goal": args.goal,
            "status": latest_status(args.worker),
            "summary": args.summary,
            "transcript_sha256": hashlib.sha256(transcript_path(args.worker).read_bytes()).hexdigest()
            if transcript_path(args.worker).exists()
            else None,
            "worker": args.worker,
        }
        prompt_content = build_manager_prompt(
            task_name=args.task,
            goal=args.goal,
            summary=args.summary,
            manager_instructions=args.manager_instructions,
            worker_name=args.worker,
            budget={"expires_at": expires_at, "max_nudges": args.max_nudges},
            source_snapshot=source_snapshot,
        )
        prompt_dir = task_artifact_dir(task_id)
        prompt_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = prompt_dir / "manager-prompt.md"
        prompt_path.write_text(prompt_content)
        prompt_hash = hashlib.sha256(prompt_content.encode()).hexdigest()
        insert_db_prompt(
            conn,
            task_id=task_id,
            manager_id=manager_id,
            kind="manager",
            content=prompt_content,
            content_sha256=prompt_hash,
            generator_version="workerctl-sqlite-v1",
            source_snapshot=source_snapshot,
            policy={
                "max_nudges": args.max_nudges,
                "budget_expires_at": expires_at,
                "manager_instructions": args.manager_instructions,
            },
            artifact_path=str(prompt_path),
        )
        command_id = create_db_command(
            conn,
            command_type="promote",
            task_id=task_id,
            worker_id=worker_id,
            manager_id=manager_id,
            payload={
                "binding_id": binding_id,
                "codex_args": codex_args,
                "manager_session": manager_session,
                "prompt_path": str(prompt_path),
                "task": args.task,
                "worker": args.worker,
            },
        )
        insert_db_event(
            conn,
            "promotion_intent",
            actor="workerctl",
            command_id=command_id,
            task_id=task_id,
            worker_id=worker_id,
            manager_id=manager_id,
            payload={
                "binding_id": binding_id,
                "manager_session": manager_session,
                "prompt_path": str(prompt_path),
            },
        )
        conn.commit()

    result_payload = {
        "command_id": command_id,
        "manager_id": manager_id,
        "manager_session": manager_session,
        "prompt_path": str(prompt_path),
        "task": args.task,
        "worker": args.worker,
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            conn.commit()
        shell_command = f"{cli_path_prefix()} codex --no-alt-screen {' '.join(sh_quote(arg) for arg in codex_args)} \"$(cat {sh_quote(str(prompt_path))})\""
        run(["tmux", "new-session", "-d", "-s", manager_session, shell_command])
        manager_pane_id = identity.session_snapshot(manager_session)["pane_id"]
        worker_pane_id = identity.session_snapshot(config.get("tmux_session", tmux_session(args.worker)))["pane_id"]
        result_payload["manager_pane_id"] = manager_pane_id
        result_payload["worker_pane_id"] = worker_pane_id
        with connect_db(db_path) as conn:
            initialize_database(conn)
            set_worker_pane_id(conn, worker_id=worker_id, tmux_pane_id=worker_pane_id)
            set_manager_pane_id(conn, manager_id=manager_id, tmux_pane_id=manager_pane_id)
            mark_manager_seen(conn, manager_id=manager_id)
            set_manager_state(conn, manager_id=manager_id, state="ready")
            finish_db_command(conn, command_id=command_id, state="succeeded", result=result_payload)
            insert_db_event(
                conn,
                "promotion_succeeded",
                actor="workerctl",
                command_id=command_id,
                task_id=task_id,
                worker_id=worker_id,
                manager_id=manager_id,
                payload=result_payload,
            )
            conn.commit()
    except Exception as exc:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            set_manager_state(conn, manager_id=manager_id, state="failed", exit_reason=str(exc))
            set_task_state(conn, task_id=task_id, state="failed")
            finish_db_command(conn, command_id=command_id, state="failed", error=str(exc))
            insert_db_event(
                conn,
                "promotion_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=task_id,
                worker_id=worker_id,
                manager_id=manager_id,
                payload={**result_payload, "error": str(exc)},
            )
            conn.commit()
        raise
    if getattr(args, "open_manager", False):
        from workerctl.commands import open_tmux_session_window

        try:
            result_payload["open_manager"] = open_tmux_session_window(
                manager_session,
                terminal=getattr(args, "terminal", "auto"),
                dry_run=False,
            )
        except Exception as exc:
            result_payload["open_manager_error"] = str(exc)
    print(json.dumps(result_payload, indent=2, sort_keys=True))
    return 0


def command_self_promote(args: argparse.Namespace) -> int:
    worker = getattr(args, "worker", None)
    session = getattr(args, "session", None) or current_session_name()
    if not worker:
        if not session:
            raise WorkerError("Cannot infer current tmux session. Run inside tmux or pass --worker.")
        prefix = "codex-"
        if not session.startswith(prefix):
            raise WorkerError("Current tmux session is not named as a worker. Run `workerctl name-session <name>` first.")
        worker = session[len(prefix) :]
    promote_args = argparse.Namespace(
        budget_expires_at=args.budget_expires_at,
        budget_hours=args.budget_hours,
        codex_args=args.codex_args,
        goal=args.goal,
        manager_instructions=args.manager_instructions,
        max_nudges=args.max_nudges,
        open_manager=getattr(args, "open_manager", False),
        path=args.path,
        summary=args.summary,
        task=args.task,
        terminal=getattr(args, "terminal", "auto"),
        worker=worker,
    )
    return command_promote(promote_args)


def command_manage(args: argparse.Namespace) -> int:
    from workerctl.commands import command_name_session

    session = getattr(args, "session", None) or current_session_name()
    worker = getattr(args, "worker", None)
    if not session:
        raise WorkerError("Cannot infer current tmux session. Run inside tmux or pass --session.")
    if not worker:
        prefix = "codex-"
        if not session.startswith(prefix):
            raise WorkerError("Current session is not named as a worker. Pass --worker to register it, or run `workerctl name-session <name>` first.")
        worker = session[len(prefix) :]

    name_args = argparse.Namespace(
        cwd=args.cwd,
        force=args.force_name,
        name=worker,
        path=args.path,
        session=session,
        task=args.worker_task or args.summary or args.goal,
    )
    with contextlib.redirect_stdout(io.StringIO()):
        command_name_session(name_args)

    promote_args = argparse.Namespace(
        budget_expires_at=args.budget_expires_at,
        budget_hours=args.budget_hours,
        codex_args=args.codex_args,
        goal=args.goal,
        manager_instructions=args.manager_instructions,
        max_nudges=args.max_nudges,
        open_manager=getattr(args, "open_manager", False),
        path=args.path,
        summary=args.summary,
        task=args.task,
        terminal=getattr(args, "terminal", "auto"),
        worker=worker,
    )
    return command_promote(promote_args)


def command_become_managed(args: argparse.Namespace) -> int:
    args.open_manager = getattr(args, "open_manager", True)
    return command_manage(args)


def _resolve_unmanage_task(
    conn,
    *,
    session: str | None,
    task: str | None,
) -> dict[str, Any]:
    if task:
        binding = conn.execute(
            """
            select tasks.id as task_id, tasks.name as task_name, tasks.state as task_state,
                   bindings.id as binding_id, bindings.state as binding_state,
                   workers.id as worker_id, workers.name as worker_name,
                   workers.tmux_session as worker_tmux_session,
                   workers.tmux_pane_id as worker_tmux_pane_id,
                   workers.identity_token as worker_identity_token
            from tasks
            join bindings on bindings.task_id = tasks.id and bindings.state in ('active', 'ending')
            join workers on workers.id = bindings.worker_id
            where tasks.id = ? or tasks.name = ?
            order by bindings.created_at desc
            limit 1
            """,
            (task, task),
        ).fetchone()
        if binding is None:
            raise WorkerError(f"Task {task} has no active worker binding")
        if session and binding["worker_tmux_session"] != session:
            raise WorkerError(
                f"Task {binding['task_name']} is bound to {binding['worker_tmux_session']}, not current session {session}"
            )
    else:
        if not session:
            raise WorkerError("Cannot infer current tmux session. Run inside tmux or pass --session or --task.")
        rows = conn.execute(
            """
            select tasks.id as task_id, tasks.name as task_name, tasks.state as task_state,
                   bindings.id as binding_id, bindings.state as binding_state,
                   workers.id as worker_id, workers.name as worker_name,
                   workers.tmux_session as worker_tmux_session,
                   workers.tmux_pane_id as worker_tmux_pane_id,
                   workers.identity_token as worker_identity_token
            from workers
            join bindings on bindings.worker_id = workers.id and bindings.state in ('active', 'ending')
            join tasks on tasks.id = bindings.task_id
            where workers.tmux_session = ? and tasks.state in ('managed', 'paused')
            order by bindings.created_at desc
            """,
            (session,),
        ).fetchall()
        if not rows:
            raise WorkerError(f"No managed task is bound to tmux session {session}")
        if len(rows) > 1:
            names = ", ".join(row["task_name"] for row in rows)
            raise WorkerError(f"Multiple managed tasks are bound to {session}; pass --task. Candidates: {names}")
        binding = rows[0]
    return {
        "binding_id": binding["binding_id"],
        "binding_state": binding["binding_state"],
        "task_id": binding["task_id"],
        "task_name": binding["task_name"],
        "task_state": binding["task_state"],
        "worker_id": binding["worker_id"],
        "worker_identity_token": binding["worker_identity_token"],
        "worker_name": binding["worker_name"],
        "worker_tmux_pane_id": binding["worker_tmux_pane_id"],
        "worker_tmux_session": binding["worker_tmux_session"],
    }


def _current_task_status(
    *,
    db_path: Path | None,
    session: str | None,
    task: str | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = _resolve_unmanage_task(conn, session=session, task=task)
        snapshot = task_status_snapshot(conn, task=binding["task_name"])
    return binding, snapshot


def _worker_source(
    *,
    command: str,
    binding: dict[str, Any],
    resolved_from: str,
    verification: dict[str, Any],
) -> dict[str, Any]:
    return {
        "initiator": "worker",
        "resolved_from": resolved_from,
        "source_command": command,
        "tmux_session": binding["worker_tmux_session"],
        "worker": binding["worker_name"],
        "worker_identity": verification,
    }


def _pause_manager_task(
    *,
    db_path: Path | None,
    task: str,
    command_type: str = "pause_manager",
    event_prefix: str = "pause_manager",
    source: dict[str, Any] | None = None,
    worker_id: str | None = None,
    dry_run: bool = False,
) -> int:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        manager = active_manager(conn, task=task)
        if manager is None:
            raise WorkerError(f"Task {task} has no active manager")
        source_payload = source or {}
        if dry_run:
            result = {
                "dry_run": True,
                "manager": manager["name"],
                "manager_session": manager["tmux_session"],
                "source": source_payload,
                "task": task,
            }
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        command_id = create_db_command(
            conn,
            command_type=command_type,
            task_id=manager["task_id"],
            worker_id=worker_id,
            manager_id=manager["id"],
            payload={"manager_session": manager["tmux_session"], "source": source_payload, "task": task},
        )
        insert_db_event(
            conn,
            f"{event_prefix}_intent",
            actor=source_payload.get("initiator", "workerctl"),
            command_id=command_id,
            task_id=manager["task_id"],
            worker_id=worker_id,
            manager_id=manager["id"],
            payload={"manager_session": manager["tmux_session"], "source": source_payload},
        )
        conn.commit()
    result = {
        "command_id": command_id,
        "manager": manager["name"],
        "manager_session": manager["tmux_session"],
        "source": source_payload,
        "task": task,
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            conn.commit()
        verification = identity.verify_manager_identity(manager)
        result["manager_identity"] = verification
        with connect_db(db_path) as conn:
            initialize_database(conn)
            if verification["live"]:
                mark_manager_seen(conn, manager_id=manager["id"])
            set_manager_state(conn, manager_id=manager["id"], state="stopping")
            insert_db_event(
                conn,
                "manager_identity_verified",
                actor=source_payload.get("initiator", "workerctl"),
                command_id=command_id,
                task_id=manager["task_id"],
                worker_id=worker_id,
                manager_id=manager["id"],
                payload=verification,
            )
            conn.commit()
        killed = False
        if verification["live"]:
            run(["tmux", "kill-session", "-t", manager["tmux_session"]])
            killed = True
        result["killed_session"] = killed
        with connect_db(db_path) as conn:
            initialize_database(conn)
            set_manager_state(conn, manager_id=manager["id"], state="stopped")
            set_task_state(conn, task_id=manager["task_id"], state="paused")
            finish_db_command(conn, command_id=command_id, state="succeeded", result=result)
            insert_db_event(
                conn,
                f"{event_prefix}_succeeded",
                actor=source_payload.get("initiator", "workerctl"),
                command_id=command_id,
                task_id=manager["task_id"],
                worker_id=worker_id,
                manager_id=manager["id"],
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
                actor=source_payload.get("initiator", "workerctl"),
                command_id=command_id,
                task_id=manager["task_id"],
                worker_id=worker_id,
                manager_id=manager["id"],
                payload={**result, "error": str(exc)},
            )
            conn.commit()
        raise
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_pause_manager(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    return _pause_manager_task(db_path=db_path, task=args.task)


def command_unmanage(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    session = getattr(args, "session", None) or current_session_name()
    task = getattr(args, "task", None)
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = _resolve_unmanage_task(conn, session=session, task=task)
        if binding["task_state"] != "managed":
            raise WorkerError(f"Task {binding['task_name']} is not managed; current state is {binding['task_state']}")
    verification = identity.verify_worker_binding_identity(binding)
    source = _worker_source(
        command="unmanage",
        binding=binding,
        resolved_from="task" if task else "tmux_session",
        verification=verification,
    )
    return _pause_manager_task(
        db_path=db_path,
        task=binding["task_name"],
        command_type="unmanage",
        event_prefix="unmanage",
        source=source,
        worker_id=binding["worker_id"],
        dry_run=getattr(args, "dry_run", False),
    )


def command_my_status(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    session = getattr(args, "session", None) or current_session_name()
    task = getattr(args, "task", None)
    binding, snapshot = _current_task_status(db_path=db_path, session=session, task=task)
    result = {
        "manager": snapshot["manager"],
        "suggested_next_commands": [],
        "task": {
            "id": snapshot["id"],
            "name": snapshot["name"],
            "state": snapshot["state"],
            "summary": snapshot["summary"],
        },
        "worker": snapshot["worker"],
        "worker_status": snapshot["worker_status"],
    }
    if snapshot["state"] == "managed":
        result["suggested_next_commands"] = [
            "workerctl unmanage",
            f"workerctl task-status {snapshot['name']} --json",
        ]
    elif snapshot["state"] == "paused":
        result["suggested_next_commands"] = [
            "workerctl remanage",
            f"workerctl stop-task {snapshot['name']}",
        ]
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    manager_state = result["manager"]["state"] if result["manager"] else "-"
    print(
        "\t".join(
            [
                binding["worker_name"],
                binding["worker_tmux_session"],
                snapshot["name"],
                snapshot["state"],
                manager_state,
            ]
        )
    )
    for command in result["suggested_next_commands"]:
        print(f"next: {command}")
    return 0


def _resume_manager_task(
    *,
    db_path: Path | None,
    task: str,
    codex_args: list[str],
    command_type: str = "resume_manager",
    event_prefix: str = "resume_manager",
    source: dict[str, Any] | None = None,
    worker_id: str | None = None,
    open_manager: bool = False,
    terminal: str = "auto",
) -> int:
    ensure_tool("tmux")
    ensure_tool("codex")
    source_payload = source or {}
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=task)
        if snapshot["state"] != "paused":
            raise WorkerError(f"Task {snapshot['name']} is not paused; current state is {snapshot['state']}")
        worker = snapshot["worker"]
        if worker is None:
            raise WorkerError(f"Task {snapshot['name']} cannot resume manager without an active worker binding")
        worker_verification = identity.verify_worker_record_identity(db_path, worker)
        prompt = latest_manager_prompt(conn, task_id=snapshot["id"])
        prompt_path = Path(prompt["artifact_path"]) if prompt["artifact_path"] else task_artifact_dir(snapshot["id"]) / "manager-prompt.md"
        if not prompt_path.exists():
            prompt_path.parent.mkdir(parents=True, exist_ok=True)
            prompt_path.write_text(prompt["content"])
        manager_name = manager_record_name(snapshot["name"])
        manager_session = resumed_manager_session_name(snapshot["id"], snapshot["name"])
        if manager_session_exists(manager_session):
            raise WorkerError(f"Manager tmux session already exists: {manager_session}")
        manager_id = create_db_manager(
            conn,
            task_id=snapshot["id"],
            name=manager_name,
            tmux_session=manager_session,
            codex_args=codex_args,
            state="starting",
        )
        attach_manager_to_binding(conn, task_id=snapshot["id"], manager_id=manager_id)
        command_id = create_db_command(
            conn,
            command_type=command_type,
            task_id=snapshot["id"],
            worker_id=worker_id,
            manager_id=manager_id,
            payload={"codex_args": codex_args, "manager_session": manager_session, "prompt_path": str(prompt_path), "source": source_payload},
        )
        insert_db_event(
            conn,
            f"{event_prefix}_intent",
            actor=source_payload.get("initiator", "workerctl"),
            command_id=command_id,
            task_id=snapshot["id"],
            worker_id=worker_id,
            manager_id=manager_id,
            payload={"manager_session": manager_session, "prompt_path": str(prompt_path), "source": source_payload},
        )
        conn.commit()
    result = {
        "command_id": command_id,
        "manager_id": manager_id,
        "manager_session": manager_session,
        "prompt_path": str(prompt_path),
        "source": source_payload,
        "task": snapshot["name"],
        "worker_identity": worker_verification,
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            conn.commit()
        shell_command = f"{cli_path_prefix()} codex --no-alt-screen {' '.join(sh_quote(arg) for arg in codex_args)} \"$(cat {sh_quote(str(prompt_path))})\""
        run(["tmux", "new-session", "-d", "-s", manager_session, shell_command])
        manager_pane_id = identity.session_snapshot(manager_session)["pane_id"]
        result["manager_pane_id"] = manager_pane_id
        with connect_db(db_path) as conn:
            initialize_database(conn)
            set_manager_pane_id(conn, manager_id=manager_id, tmux_pane_id=manager_pane_id)
            mark_manager_seen(conn, manager_id=manager_id)
            set_manager_state(conn, manager_id=manager_id, state="ready")
            set_task_state(conn, task_id=snapshot["id"], state="managed")
            finish_db_command(conn, command_id=command_id, state="succeeded", result=result)
            insert_db_event(
                conn,
                f"{event_prefix}_succeeded",
                actor=source_payload.get("initiator", "workerctl"),
                command_id=command_id,
                task_id=snapshot["id"],
                worker_id=worker_id,
                manager_id=manager_id,
                payload=result,
            )
            conn.commit()
    except Exception as exc:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            set_manager_state(conn, manager_id=manager_id, state="failed", exit_reason=str(exc))
            finish_db_command(conn, command_id=command_id, state="failed", error=str(exc))
            insert_db_event(
                conn,
                f"{event_prefix}_failed",
                actor=source_payload.get("initiator", "workerctl"),
                command_id=command_id,
                task_id=snapshot["id"],
                worker_id=worker_id,
                manager_id=manager_id,
                payload={**result, "error": str(exc)},
            )
            conn.commit()
        raise
    if open_manager:
        from workerctl.commands import open_tmux_session_window

        try:
            result["open_manager"] = open_tmux_session_window(manager_session, terminal=terminal, dry_run=False)
        except Exception as exc:
            result["open_manager_error"] = str(exc)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_resume_manager(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    codex_args = passthrough_args(args.codex_args or [])
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
    worker_id = snapshot["worker"]["id"] if snapshot["worker"] else None
    return _resume_manager_task(
        db_path=db_path,
        task=args.task,
        codex_args=codex_args,
        worker_id=worker_id,
        open_manager=getattr(args, "open_manager", False),
        terminal=getattr(args, "terminal", "auto"),
    )


def command_remanage(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    session = getattr(args, "session", None) or current_session_name()
    task = getattr(args, "task", None)
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = _resolve_unmanage_task(conn, session=session, task=task)
        if binding["task_state"] != "paused":
            raise WorkerError(f"Task {binding['task_name']} is not paused; current state is {binding['task_state']}")
    verification = identity.verify_worker_binding_identity(binding)
    source = _worker_source(
        command="remanage",
        binding=binding,
        resolved_from="task" if task else "tmux_session",
        verification=verification,
    )
    codex_args = passthrough_args(args.codex_args or [])
    return _resume_manager_task(
        db_path=db_path,
        task=binding["task_name"],
        codex_args=codex_args,
        command_type="remanage",
        event_prefix="remanage",
        source=source,
        worker_id=binding["worker_id"],
        open_manager=getattr(args, "open_manager", False),
        terminal=getattr(args, "terminal", "auto"),
    )


def command_stop_task(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        if snapshot["state"] in {"done", "failed"}:
            raise WorkerError(f"Task {snapshot['name']} is already {snapshot['state']}")
        manager = active_manager(conn, task=snapshot["id"])
        worker = snapshot["worker"]
        command_id = create_db_command(
            conn,
            command_type="stop_task",
            task_id=snapshot["id"],
            worker_id=worker["id"] if worker else None,
            manager_id=manager["id"] if manager else None,
            payload={
                "message": args.message,
                "stop_worker": args.stop_worker,
                "task": snapshot["name"],
                "worker": worker["name"] if worker else None,
            },
        )
        insert_db_event(
            conn,
            "stop_task_intent",
            actor="workerctl",
            command_id=command_id,
            task_id=snapshot["id"],
            worker_id=worker["id"] if worker else None,
            manager_id=manager["id"] if manager else None,
            payload={
                "message": args.message,
                "stop_worker": args.stop_worker,
            },
        )
        conn.commit()

    result = {
        "command_id": command_id,
        "killed_manager": False,
        "killed_worker": False,
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
        if manager and result["manager_identity"]["live"]:
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
                append_event(worker["name"], "stop_task_message", {"command_id": command_id, "message": args.message})
            if worker_identity["live"]:
                run(["tmux", "kill-session", "-t", tmux_target(worker["name"])])
                append_event(worker["name"], "stop_task", {"command_id": command_id, "task": snapshot["name"]})
                result["killed_worker"] = True
        with connect_db(db_path) as conn:
            initialize_database(conn)
            if manager:
                set_manager_state(conn, manager_id=manager["id"], state="stopped")
            if worker and args.stop_worker:
                mark_worker_state(conn, name=worker["name"], state="stopped")
            end_active_binding(conn, task_id=snapshot["id"])
            set_task_state(conn, task_id=snapshot["id"], state="done")
            finish_db_command(conn, command_id=command_id, state="succeeded", result=result)
            insert_db_event(
                conn,
                "stop_task_succeeded",
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
                "stop_task_failed",
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
            left join managers on managers.id = bindings.manager_id
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


def command_reconcile(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    results = reconcile_rows(db_path, task=args.task, recover=False)
    print(json.dumps({"recover": False, "results": results}, indent=2, sort_keys=True))
    return 1 if any(result["drift"] for result in results) else 0


def command_recover(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    sync_pane_ids = getattr(args, "sync_pane_ids", False)
    results = reconcile_rows(db_path, task=args.task, recover=True, sync_pane_ids=sync_pane_ids)
    print(json.dumps({"recover": True, "results": results, "sync_pane_ids": sync_pane_ids}, indent=2, sort_keys=True))
    return 0


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


def close_stale_plan(
    results: list[dict[str, Any]],
    *,
    include_terminal_skips: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for result in results:
        task = result["task"]
        worker = result["worker"]
        manager = result["manager"]
        skip_reasons = []
        if task["state"] not in {"managed", "paused"}:
            skip_reasons.append(f"task_state_{task['state']}")
        if not worker:
            skip_reasons.append("no_recorded_worker")
        elif worker["live"] is not False:
            skip_reasons.append("worker_not_missing")
        if manager and manager["live"] is True:
            skip_reasons.append("manager_live")
        if result["unfinished_commands"]:
            skip_reasons.append("unfinished_commands")

        entry = {
            "drift": result["drift"],
            "manager": manager,
            "task": task,
            "unfinished_commands": result["unfinished_commands"],
            "worker": worker,
        }
        if skip_reasons:
            should_report_skip = (
                include_terminal_skips
                or task["state"] in {"managed", "paused"}
                or bool(result["drift"])
                or bool(result["unfinished_commands"])
            )
            if not should_report_skip:
                continue
            skipped.append({**entry, "skip_reasons": skip_reasons})
        else:
            candidates.append(
                {
                    **entry,
                    "close_reasons": [
                        "worker_missing",
                        "no_live_manager",
                        "no_unfinished_commands",
                    ],
                    "planned_state": "failed",
                }
            )
    return candidates, skipped


def command_close_stale(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    apply_changes = bool(getattr(args, "apply", False))
    results = reconcile_rows(db_path, task=args.task, recover=False)
    candidates, skipped = close_stale_plan(results, include_terminal_skips=bool(args.task))
    closed = []

    if apply_changes:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            for candidate in candidates:
                task = candidate["task"]
                worker = candidate["worker"]
                manager = candidate["manager"]
                payload = {
                    "close_reasons": candidate["close_reasons"],
                    "drift": candidate["drift"],
                    "manager": manager,
                    "planned_state": "failed",
                    "task": task,
                    "worker": worker,
                }
                command_id = create_db_command(
                    conn,
                    command_type="close_stale",
                    task_id=task["id"],
                    worker_id=worker["id"] if worker else None,
                    manager_id=manager["id"] if manager else None,
                    payload=payload,
                )
                mark_command_attempted(conn, command_id=command_id)
                if worker:
                    mark_worker_state(conn, name=worker["name"], state="missing")
                if manager and manager["state"] in {"starting", "ready", "stopping"} and manager["live"] is False:
                    set_manager_state(
                        conn,
                        manager_id=manager["id"],
                        state="missing",
                        exit_reason="tmux session missing during close-stale",
                    )
                end_active_binding(conn, task_id=task["id"])
                set_task_state(conn, task_id=task["id"], state="failed")
                result = {
                    "manager_id": manager["id"] if manager else None,
                    "task_id": task["id"],
                    "task_state": "failed",
                    "worker_id": worker["id"] if worker else None,
                    "worker_state": "missing" if worker else None,
                }
                insert_db_event(
                    conn,
                    "close_stale_task",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=task["id"],
                    worker_id=worker["id"] if worker else None,
                    manager_id=manager["id"] if manager else None,
                    payload={**payload, "result": result},
                )
                finish_db_command(conn, command_id=command_id, state="succeeded", result=result)
                closed.append({**candidate, "command_id": command_id, "result": result})
            conn.commit()

    print(
        json.dumps(
            {
                "apply": apply_changes,
                "candidates": candidates,
                "closed": closed,
                "skipped": skipped,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0
