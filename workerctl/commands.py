from __future__ import annotations

import argparse
import hashlib
import os
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from workerctl.classify import classify_busy_wait, classify_startup_output
from workerctl.audit import mutation_audit_result
from workerctl.constants import CODEX_STARTUP_PROFILES, DEFAULT_HISTORY_LINES, DEFAULT_MANAGER_STALE_SECONDS, PROJECT_ROOT, VALID_STATES
from workerctl.core import WorkerError, age_seconds, ensure_tool, now_iso, raise_for_tmux_permission_failure, run, sh_quote
from workerctl.criteria_plan import plan_criteria_commands
from workerctl.db import active_binding_for_task, active_manager, active_task_worker
from workerctl.db import connect as connect_db
from workerctl.db import create_task as create_db_task
from workerctl.db import database_health, default_db_path, initialize_database
from workerctl.db import insert_agent_observation
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_status as insert_db_status
from workerctl.db import insert_terminal_capture
from workerctl.db import insert_transcript_capture
from workerctl.db import insert_transcript_segment
from workerctl.db import latest_terminal_capture_for_role
from workerctl.db import latest_session_binding_for_task
from workerctl.db import list_tasks as list_db_tasks
from workerctl.db import list_runs as list_db_runs
from workerctl.db import mark_manager_seen
from workerctl.db import mark_worker_state, upsert_worker
from workerctl.db import active_run_for_task
from workerctl.db import create_run as create_db_run
from workerctl.db import finish_run as finish_db_run
from workerctl.db import run_row as db_run_row
from workerctl.db import session_by_id
from workerctl.db import set_worker_pane_id
from workerctl.db import task_audit
from workerctl.db import task_row as db_task_row
from workerctl.db import task_status_snapshot
from workerctl.db import query_telemetry_events
from workerctl.db import telemetry_summary
from workerctl import identity
from workerctl.state import (
    append_event,
    capture_meta_path,
    config_path,
    initial_status,
    latest_status,
    load_json,
    read_events,
    read_events_with_stats,
    require_worker,
    state_root,
    status_path,
    transcript_path,
    validate_name,
    worker_dir,
    write_json,
    write_worker_contract,
)
from workerctl.lifecycle import manager_liveness_warnings, reconcile_rows
from workerctl.output_safety import redact_audit, redact_capture_result, redact_payload, redact_transcript_segments
from workerctl.tmux import (
    capture_output,
    capture_tmux_target,
    current_session_name,
    current_pane_id,
    interrupt_worker,
    send_text,
    session_exists,
    tmux_session,
    tmux_target,
    wait_ready,
)


def attach_command(name: str) -> str:
    return f"tmux attach -t {tmux_session(name)}"


def stop_command(name: str) -> str:
    return f"workerctl stop {name}"


def cli_path_prefix() -> str:
    return f"PATH={sh_quote(str(PROJECT_ROOT / 'bin'))}:$PATH"


def dispatch_watch_command(
    workerctl_path: str | Path,
    dispatcher_id: str,
    db_path: str | Path | None = None,
) -> list[str]:
    command = [
        str(workerctl_path),
        "dispatch",
        "--watch",
        "--dispatcher-id",
        dispatcher_id,
    ]
    if db_path:
        command.extend(["--path", str(db_path)])
    return command


def dashboard_dispatch_command(
    workerctl_path: str | Path,
    dispatcher_id: str,
    db_path: str | Path | None = None,
) -> list[str]:
    return dispatch_watch_command(workerctl_path, dispatcher_id, db_path)


def _release_detached_popen_handle(process: subprocess.Popen[Any]) -> None:
    process.poll()
    if getattr(process, "returncode", None) is None:
        process.returncode = 0


def dashboard_launch_payload(args: argparse.Namespace) -> dict[str, Any]:
    query = urlencode({"task": args.task}) if args.task else ""
    url = f"http://{args.host}:{args.port}/"
    if query:
        url = f"{url}?{query}"
    command = [
        "npm",
        "run",
        "dashboard",
        "--",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--workerctl-path",
        args.workerctl_path,
    ]
    if args.task:
        command.extend(["--task", args.task])
    if args.db_path:
        command.extend(["--db-path", args.db_path])
    dispatch_command = dispatch_watch_command(
        workerctl_path=args.workerctl_path,
        dispatcher_id=args.dispatcher_id,
        db_path=args.db_path,
    )
    return {
        "command": command,
        "dispatch_command": dispatch_command if getattr(args, "ensure_dispatch", False) else None,
        "ensure_dispatch": bool(getattr(args, "ensure_dispatch", False)),
        "host": args.host,
        "port": args.port,
        "task": args.task,
        "url": url,
    }


def _recent_active_dispatch_heartbeat(db_path: str | Path | None, *, stale_seconds: float = 10.0) -> dict[str, Any] | None:
    try:
        with connect_db(Path(db_path).expanduser().resolve() if db_path else None) as conn:
            initialize_database(conn)
            heartbeats = query_telemetry_events(
                conn,
                actor="dispatch",
                event_type="dispatch_watch_heartbeat",
                limit=1,
                newest=True,
            )
    except Exception:
        return None
    if not heartbeats:
        return None
    heartbeat = heartbeats[0]
    if heartbeat.get("attributes", {}).get("dry_run") is True:
        return None
    heartbeat_age = age_seconds(heartbeat.get("timestamp"))
    if heartbeat_age is None or heartbeat_age > stale_seconds:
        return None
    return heartbeat


def command_dashboard(args: argparse.Namespace) -> int:
    payload = dashboard_launch_payload(args)
    if args.dry_run:
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(" ".join(sh_quote(part) for part in payload["command"]))
            print(payload["url"])
        return 0
    dispatch_process = None
    if payload["ensure_dispatch"] and payload["dispatch_command"]:
        if _recent_active_dispatch_heartbeat(getattr(args, "db_path", None)) is None:
            dispatch_process = subprocess.Popen(
                payload["dispatch_command"],
                cwd=PROJECT_ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
    try:
        return subprocess.run(payload["command"], cwd=PROJECT_ROOT, check=False).returncode
    finally:
        if dispatch_process is not None and dispatch_process.poll() is None:
            dispatch_process.terminate()
            try:
                dispatch_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                dispatch_process.kill()
                dispatch_process.wait(timeout=2)


def pair_dispatch_payload(args: argparse.Namespace, db_path: Path | None) -> dict[str, Any]:
    dispatcher_id = getattr(args, "dispatcher_id", None)
    ensure_dispatch = bool(dispatcher_id) and not bool(getattr(args, "no_dispatch", False))
    dispatch_command = (
        dispatch_watch_command(
            workerctl_path=PROJECT_ROOT / "scripts" / "workerctl",
            dispatcher_id=dispatcher_id,
            db_path=db_path,
        )
        if ensure_dispatch
        else None
    )
    return {
        "dispatch_command": dispatch_command,
        "ensure_dispatch": ensure_dispatch,
    }


def resolve_codex_startup_options(
    *,
    profile: str | None,
    sandbox: str | None,
    ask_for_approval: str | None,
) -> tuple[str | None, str | None]:
    if profile is None:
        return sandbox, ask_for_approval
    if profile not in CODEX_STARTUP_PROFILES:
        raise WorkerError(f"Unknown Codex startup profile: {profile}")
    profile_options = CODEX_STARTUP_PROFILES[profile]
    return (
        profile_options["sandbox"] if sandbox is None else sandbox,
        profile_options["ask_for_approval"] if ask_for_approval is None else ask_for_approval,
    )


def print_worker_commands(name: str) -> None:
    print("")
    print("Attach:")
    print(f"  {attach_command(name)}")
    print("")
    print("Stop:")
    print(f"  {stop_command(name)}")


def attach_session_command(session_name: str) -> str:
    return f"tmux attach -t {session_name}"


def start_prompt_path(session_name: str) -> Path:
    validate_name(session_name)
    return state_root() / "artifacts" / "start-prompts" / f"{session_name}.md"


def codex_arg_suffix(codex_args: list[str]) -> str:
    if not codex_args:
        return ""
    return " -- " + " ".join(sh_quote(arg) for arg in codex_args)


def workerctl_cli() -> str:
    return sh_quote(str(PROJECT_ROOT / "scripts" / "workerctl"))


def raw_worker_start_prompt(session_name: str, cwd: Path, manager_codex_args: list[str] | None = None) -> str:
    manager_suffix = codex_arg_suffix(manager_codex_args or [])
    workerctl = workerctl_cli()
    start_manager_template = f"{workerctl} start-manager --name <manager-name> --cwd {sh_quote(str(cwd))}{manager_suffix}"
    return f"""You are a raw worker candidate running inside workerctl tmux session {session_name}.

Current working directory: {cwd}

You are not registered as a worker yet.

The supported manager/worker setup is session-based:

1. Register this session as a worker after identifying the Codex process pid and
   rollout JSONL:

   {workerctl} register-worker --name <worker-name> --pid <pid> --codex-session <rollout.jsonl> --cwd {sh_quote(str(cwd))} --tmux-session {session_name}

2. Create or select a task:

   {workerctl} tasks --create <task-name> --goal "<goal>"

3. Start a manager:

   {start_manager_template}

4. Bind the sessions:

   {workerctl} bind --task <task-name> --worker <worker-name> --manager <manager-name>

5. Configure manager supervision:

   {workerctl} manager-config <task-name> --questions

6. After the task is bound and before editing files for the task, record your
   acknowledgement:

   {workerctl} worker-ack <task-name> --from-stdin

   The JSON should restate the goal, list proposed must-have/follow-up
   criteria, expected tools, open questions, and ready_to_start.

Required fields:
- worker name
- manager name
- task name
- goal

If any required field is missing, ask the user for it. Do not invent worker
name, manager name, task name, or goal values unless the user explicitly asks
you to choose them.

If the user asks to see the manager or worker terminal for your task, run:

{workerctl} open-manager <task-name>
{workerctl} open-worker <task-name>
"""


def manager_bootstrap_prompt(
    *,
    manager_name: str,
    cwd: str | Path,
    task_name: str | None = None,
    task_goal: str | None = None,
    worker_name: str | None = None,
    manager_config_seeded: bool = False,
    manager_config: dict[str, Any] | None = None,
) -> str:
    task_line = task_name or "<unbound-task>"
    goal_line = task_goal or "No task goal supplied yet."
    worker_line = worker_name or "No worker session supplied yet."
    workerctl = workerctl_cli()
    setup_command = (
        f"{workerctl} manager-config {task_line} --questions"
        if task_name
        else f"{workerctl} manager-config <task> --questions"
    )
    cycle_command = (
        f"{workerctl} cycle {task_line}"
        if task_name
        else f"{workerctl} cycle <task>"
    )
    manager_ack_command = (
        f"{workerctl} manager-ack {task_line} --from-stdin"
        if task_name
        else f"{workerctl} manager-ack <task> --from-stdin"
    )
    worker_ack_command = (
        f"{workerctl} worker-ack {task_line} --json"
        if task_name
        else f"{workerctl} worker-ack <task> --json"
    )
    ack_setup = f"""
Acknowledgement:
- Before your first cycle, record the supervision contract you are committing to with `{manager_ack_command}`.
- Before nudging or finishing, inspect the worker acknowledgement with `{worker_ack_command}` when available."""
    if manager_config_seeded:
        permission_summary = (
            "\n" + manager_permission_display(manager_config)
            if manager_config
            else ""
        )
        tool_summary = ""
        if manager_config and manager_config.get("tools"):
            tool_summary = "\nExpected tools: " + ", ".join(manager_config["tools"]) + "."
        initial_setup = f"""Initial setup:
- Manager config has already been recorded for this task.
- Start with `{cycle_command}` and inspect `manager_context.manager_config`.
- Ask setup questions only if the cycle output shows missing or unsuitable manager config.{permission_summary}{tool_summary}{ack_setup}"""
    else:
        initial_setup = f"""Initial setup:
1. Run `{setup_command}`.
2. Ask the user the returned setup questions in this manager Codex chat.
3. Persist the answers with `{workerctl} manager-config`.
4. Use `workerctl manager-config --interactive` only when a human is directly
   running workerctl in a terminal.{ack_setup}"""

    return f"""You are a Codex manager session for workerctl.

Working directory: {cwd}
Manager session name: {manager_name}
Task: {task_line}
Task goal: {goal_line}
Worker session: {worker_line}

Your role is to supervise, not to implement the worker task.

{initial_setup}

Supervision loop:
- Start observations with `{cycle_command}`.
- Read `manager_context.manager_config` in cycle output before nudging.
- Treat acceptance criteria as living supervision state.
- Inspect `manager_context.acceptance_criteria` each cycle.
- Inspect `manager_context.criteria_negotiation`; use its prompt when needed is true.
- Nudge the worker with `{workerctl} session-nudge {worker_line} "..."`;
  the legacy `nudge` command is only for old file-backed workers and should not
  be the first choice for session-bound pairs.
- If worker progress reveals new edge cases, tests, polish, or scope
  boundaries, ask the worker to propose must-have vs follow-up criteria.
- After a worker proposes separated criteria, use `{workerctl} criteria-plan`
  to draft reviewed criteria commands, then run only the commands you agree with.
- Record useful criteria with `{workerctl} criteria`.
  Examples:
  - `{workerctl} criteria {task_line} --add --criterion "..." --source worker_proposed --status proposed`
  - `{workerctl} criteria {task_line} --add --criterion "..." --source manager_inferred --status accepted`
  - `criterion_id=$({workerctl} criteria {task_line} --add --criterion "..." --source worker_proposed --status proposed | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')`
  - `{workerctl} criteria {task_line} --satisfy "$criterion_id" --evidence-json '{{"command":"...","status":"pass"}}'`
- Use `worker_proposed` for criteria that came from the worker.
- Use `manager_inferred` for criteria inferred from manager config, cycle
  evidence, or the manager's own inspection; `manager_config` is not a valid
  criteria source.
- Before finishing, compare worker receipts/verification against accepted open criteria.
- When all accepted criteria are satisfied, deferred, or rejected, finish the task with
  `{workerctl} finish-task {task_line} --reason "Accepted criteria satisfied" --require-criteria-audit`.
- Communicate with the worker only through workerctl session/task commands.
- Do not edit project files unless the user explicitly asks this manager
  session to change workerctl itself.
"""


def resolve_terminal(terminal: str) -> str:
    if terminal != "auto":
        return terminal
    if Path("/Applications/Ghostty.app").exists():
        return "ghostty"
    return "terminal"


def last_open_event(name: str) -> dict[str, Any] | None:
    for event in reversed(read_events(name)):
        if event.get("type") in {"open", "open_attempt"}:
            return event
    return None


def open_worker_window(name: str, *, terminal: str, dry_run: bool, force: bool) -> dict[str, Any]:
    require_worker(name)
    validate_name(name)
    if sys.platform != "darwin":
        raise WorkerError("workerctl open is currently implemented for macOS only.")
    if not session_exists(name):
        raise WorkerError(f"tmux session is not running for worker {name}: {tmux_target(name)}")

    prior_open = last_open_event(name)
    if prior_open and not force:
        prior_action = "terminal launch attempted" if prior_open.get("type") == "open_attempt" else "terminal opened"
        raise WorkerError(
            f"Worker {name} already had a {prior_action} at {prior_open.get('time', 'unknown time')}. "
            f"Attach manually with `{attach_command(name)}` or rerun with --force if you intentionally want another window."
        )

    selected_terminal = resolve_terminal(terminal)
    attach = ["tmux", "attach", "-t", tmux_target(name)]
    if selected_terminal == "ghostty":
        command = ["open", "-na", "Ghostty.app", "--args", "-e", *attach]
    elif selected_terminal == "terminal":
        script = f'tell application "Terminal" to do script "{attach_command(name)}"'
        command = ["osascript", "-e", 'tell application "Terminal" to activate', "-e", script]
    else:
        raise WorkerError(f"Unsupported terminal: {terminal}")

    result = {
        "attach_command": attach_command(name),
        "dry_run": dry_run,
        "force": force,
        "name": name,
        "terminal": selected_terminal,
        "tmux_session": tmux_session(name),
    }
    if dry_run:
        result["command"] = command
        return result
    append_event(name, "open_attempt", {"forced": force, "terminal": selected_terminal})
    run(command)
    append_event(name, "open", {"forced": force, "terminal": selected_terminal})
    return result


def open_tmux_session_window(session_name: str, *, terminal: str, dry_run: bool) -> dict[str, Any]:
    if sys.platform != "darwin":
        raise WorkerError("workerctl terminal opening commands are currently implemented for macOS only.")
    proc = run(["tmux", "has-session", "-t", session_name], check=False)
    raise_for_tmux_permission_failure(proc)
    if proc.returncode != 0:
        raise WorkerError(f"tmux session is not running: {session_name}")

    selected_terminal = resolve_terminal(terminal)
    attach = ["tmux", "attach", "-t", session_name]
    attach_text = attach_session_command(session_name)
    if selected_terminal == "ghostty":
        command = ["open", "-na", "Ghostty.app", "--args", "-e", *attach]
    elif selected_terminal == "terminal":
        script = f'tell application "Terminal" to do script "{attach_text}"'
        command = ["osascript", "-e", 'tell application "Terminal" to activate', "-e", script]
    else:
        raise WorkerError(f"Unsupported terminal: {terminal}")

    result = {
        "attach_command": attach_text,
        "dry_run": dry_run,
        "terminal": selected_terminal,
        "tmux_session": session_name,
    }
    if dry_run:
        result["command"] = command
        return result
    run(command)
    return result


def _worker_config_or_session(name: str) -> dict[str, Any]:
    try:
        config = dict(require_worker(name))
        config["_workerctl_lookup_source"] = "legacy"
        return config
    except WorkerError as exc:
        original_error = exc

    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        try:
            session = worker_db.session_row(conn, name=name)
        except WorkerError:
            raise original_error
        config = dict(session)
        config["_workerctl_lookup_source"] = "session"
        return config
    finally:
        conn.close()


def _tmux_target_for_config(name: str, config: dict[str, Any]) -> str:
    target = config.get("tmux_session")
    if not target:
        raise WorkerError(f"tmux session is not registered for worker {name}")
    return str(target)


def _session_exists_for_config(name: str, config: dict[str, Any]) -> bool:
    target = config.get("tmux_session")
    if not target:
        return False
    target = str(target)
    if target == tmux_target(name):
        return session_exists(name)
    proc = run(["tmux", "has-session", "-t", target], check=False)
    raise_for_tmux_permission_failure(proc)
    return proc.returncode == 0


def _capture_output_for_config(
    name: str,
    config: dict[str, Any],
    history_lines: int = DEFAULT_HISTORY_LINES,
) -> str:
    if config.get("_workerctl_lookup_source") == "legacy":
        return capture_output(name, history_lines)
    target = _tmux_target_for_config(name, config)
    if not _session_exists_for_config(name, config):
        raise WorkerError(f"tmux session is not running for worker {name}: {target}")
    output = capture_tmux_target(target, history_lines)
    digest = hashlib.sha256(output.encode()).hexdigest()
    meta = load_json(capture_meta_path(name), {})
    previous_digest = meta.get("sha256")
    previous_changed_at = meta.get("changed_at")
    captured_at = now_iso()
    changed = digest != previous_digest
    changed_at = captured_at if changed else previous_changed_at
    write_json(
        capture_meta_path(name),
        {
            "captured_at": captured_at,
            "changed_at": changed_at or captured_at,
            "sha256": digest,
            "history_lines": history_lines,
        },
    )
    transcript_path(name).write_text(output + ("\n" if output else ""))
    with connect_db() as conn:
        initialize_database(conn)
        worker_id = upsert_worker(
            conn,
            name=name,
            cwd=config.get("cwd", ""),
            tmux_session=target,
            identity_token=config.get("identity_token"),
            tmux_pane_id=config.get("tmux_pane_id") or current_pane_id(target),
            state="active",
            timestamp=captured_at,
        )
        insert_transcript_capture(
            conn,
            worker_id=worker_id,
            sha256=digest,
            content=output,
            captured_at=captured_at,
            changed_at=changed_at or captured_at,
            history_lines=history_lines,
            changed=changed,
        )
        conn.commit()
    return output


def command_start(args: argparse.Namespace) -> int:
    ensure_tool("tmux")
    ensure_tool("codex")
    session_name = args.session
    validate_name(session_name)
    directory = Path(args.cwd).expanduser().resolve()
    if not directory.exists() or not directory.is_dir():
        raise WorkerError(f"Session cwd does not exist or is not a directory: {directory}")
    proc = run(["tmux", "has-session", "-t", session_name], check=False)
    raise_for_tmux_permission_failure(proc)
    if proc.returncode == 0:
        raise WorkerError(f"tmux session already exists: {session_name}")

    raw_codex_args = list(args.codex_args or [])
    if raw_codex_args[:1] == ["--"]:
        raw_codex_args = raw_codex_args[1:]
    codex_args = " ".join(sh_quote(arg) for arg in raw_codex_args)
    prompt_path = None
    shell_command = f"{cli_path_prefix()} codex --cd {sh_quote(str(directory))} --no-alt-screen"
    if codex_args:
        shell_command = f"{shell_command} {codex_args}"
    if args.start_prompt:
        prompt_path = start_prompt_path(session_name)
        prompt_path.parent.mkdir(parents=True, exist_ok=True)
        prompt_path.write_text(raw_worker_start_prompt(session_name, directory, manager_codex_args=raw_codex_args))
        shell_command = f"{shell_command} \"$(cat {sh_quote(str(prompt_path))})\""
    run(["tmux", "new-session", "-d", "-s", session_name, shell_command])
    manager_suffix = codex_arg_suffix(raw_codex_args)
    result = {
        "attach_command": attach_session_command(session_name),
        "cwd": str(directory),
        "register_worker_command_template": f"workerctl register-worker --name <worker-name> --pid <pid> --codex-session <rollout.jsonl> --cwd {sh_quote(str(directory))} --tmux-session {session_name}",
        "start_manager_command_template": f"workerctl start-manager --name <manager-name> --cwd {sh_quote(str(directory))}{manager_suffix}",
        "bind_command_template": "workerctl bind --task <task-name> --worker <worker-name> --manager <manager-name>",
        "manager_config_questions_command_template": "workerctl manager-config <task-name> --questions",
        "session": session_name,
        "start_prompt_path": str(prompt_path) if prompt_path else None,
        "start_prompt_sent": bool(prompt_path),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def wait_for_status_update(
    name: str,
    *,
    initial_last_update: str | None,
    initial_current_task: str | None,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_status = load_json(status_path(name), {})
    while time.monotonic() < deadline:
        last_status = load_json(status_path(name), {})
        if (
            last_status.get("last_update") != initial_last_update
            or last_status.get("current_task") != initial_current_task
            or last_status.get("state") in {"planning", "editing", "running_tests", "blocked", "done"}
        ):
            append_event(
                name,
                "verify",
                {
                    "ok": True,
                    "reason": "status update observed",
                    "state": last_status.get("state"),
                },
            )
            return {
                "ok": True,
                "reason": "status update observed",
                "status": last_status,
            }
        if session_exists(name):
            try:
                capture_output(name, 80)
            except WorkerError as exc:
                append_event(
                    name,
                    "capture_failed",
                    {
                        "error": str(exc),
                        "phase": "wait_for_status_update",
                    },
                )
        time.sleep(1)

    append_event(
        name,
        "verify",
        {
            "ok": False,
            "reason": "timed out waiting for status update",
            "timeout_seconds": timeout_seconds,
        },
    )
    return {
        "ok": False,
        "reason": "timed out waiting for status update",
        "status": last_status,
    }


def command_create(args: argparse.Namespace) -> int:
    if args.open and args.stop_after:
        raise WorkerError("--open cannot be combined with --stop-after")
    ensure_tool("tmux")
    ensure_tool("codex")
    name = args.name
    validate_name(name)
    directory = Path(args.cwd).expanduser().resolve()
    if not directory.exists() or not directory.is_dir():
        raise WorkerError(f"Worker cwd does not exist or is not a directory: {directory}")
    if config_path(name).exists() and not args.reuse:
        raise WorkerError(f"Worker already exists: {name}. Use --reuse to reuse its state directory.")
    if session_exists(name):
        raise WorkerError(f"tmux session already exists: {tmux_target(name)}")
    with connect_db() as conn:
        initialize_database(conn)
        existing_worker = conn.execute("select id, tmux_session from workers where name = ?", (name,)).fetchone()
    if existing_worker and not args.reuse:
        raise WorkerError(
            f"Worker {name} already exists as worker id {existing_worker['id']} "
            f"in tmux session {existing_worker['tmux_session']}. Use --reuse only if continuing that worker is intentional."
        )
    if existing_worker and existing_worker["tmux_session"] != tmux_session(name):
        raise WorkerError(
            f"Worker {name} already exists as worker id {existing_worker['id']} "
            f"in tmux session {existing_worker['tmux_session']}; create would use {tmux_session(name)}."
        )

    worker_dir(name).mkdir(parents=True, exist_ok=True)
    identity_token = f"workerctl-{uuid.uuid4()}"
    write_json(
        config_path(name),
        {
            "created_at": now_iso(),
            "cwd": str(directory),
            "identity_token": identity_token,
            "name": name,
            "startup": "launched",
            "startup_reason": "worker session created",
            "state_dir": str(worker_dir(name)),
            "tmux_session": tmux_session(name),
            "tmux_target": tmux_target(name),
        },
    )
    initial_status_payload = initial_status(name, args.task)
    write_json(status_path(name), initial_status_payload)
    transcript_path(name).touch()

    with connect_db() as conn:
        initialize_database(conn)
        worker_id = upsert_worker(
            conn,
            name=name,
            cwd=str(directory),
            tmux_session=tmux_session(name),
            identity_token=identity_token,
            state="candidate",
            timestamp=initial_status_payload.get("last_update"),
        )
        insert_db_status(conn, worker_id=worker_id, status=initial_status_payload)
        insert_db_event(
            conn,
            "worker_create_recorded",
            actor="workerctl",
            worker_id=worker_id,
            payload={
                "cwd": str(directory),
                "name": name,
                "tmux_session": tmux_session(name),
            },
        )
        conn.commit()
    config = load_json(config_path(name), {})
    config["worker_id"] = worker_id
    write_json(config_path(name), config)

    contract_path = write_worker_contract(name, args.task, identity_token)
    if args.initial_prompt:
        shell_command = (
            f"{cli_path_prefix()} codex --cd {sh_quote(str(directory))} --no-alt-screen "
            f"\"$(cat {sh_quote(str(contract_path))})\""
        )
    else:
        shell_command = f"{cli_path_prefix()} codex --cd {sh_quote(str(directory))} --no-alt-screen"
    run(["tmux", "new-session", "-d", "-s", tmux_session(name), shell_command])
    tmux_pane_id = current_pane_id(tmux_session(name))
    config = load_json(config_path(name), {})
    config["tmux_pane_id"] = tmux_pane_id
    write_json(config_path(name), config)
    with connect_db() as conn:
        initialize_database(conn)
        set_worker_pane_id(conn, worker_id=worker_id, tmux_pane_id=tmux_pane_id)
        mark_worker_state(conn, name=name, state="active")
        insert_db_event(
            conn,
            "worker_tmux_started",
            actor="workerctl",
            worker_id=worker_id,
            payload={
                "tmux_pane_id": tmux_pane_id,
                "tmux_session": tmux_session(name),
            },
        )
        conn.commit()
    append_event(
        name,
        "create",
        {
            "contract_path": str(contract_path),
            "cwd": str(directory),
            "initial_prompt": args.initial_prompt,
            "task": args.task,
        },
    )

    startup = None
    if args.wait_ready:
        startup = wait_ready(name, args.wait_ready_timeout, args.accept_trust)
        config = load_json(config_path(name), {})
        config["startup"] = startup["startup"]
        config["startup_reason"] = startup["reason"]
        config["startup_checked_at"] = now_iso()
        config["startup_recommended_action"] = startup.get("recommended_action")
        write_json(config_path(name), config)
        append_event(name, "wait_ready", startup)
    elif args.accept_trust:
        run(["tmux", "send-keys", "-t", tmux_target(name), "Enter"])
        append_event(name, "accept_trust")

    print(f"created {name}")
    print(f"tmux session: {tmux_session(name)}")
    print(f"state dir: {worker_dir(name)}")
    if args.initial_prompt:
        print("contract provided as initial Codex prompt")
    else:
        print("contract saved but not provided; run workerctl nudge to provide instructions")
    if args.accept_trust:
        if args.wait_ready and startup:
            print(f"trust handling: accepted={startup['trust_accepted']}")
        else:
            print("sent Enter for initial trust prompt")
    if startup:
        print(f"startup: {startup['startup']} ({startup['reason']})")
        if startup.get("recommended_action") != "none":
            print(f"recommended action: {startup['recommended_action']}")
    if args.verify:
        result = wait_for_status_update(
            name,
            initial_last_update=initial_status_payload.get("last_update"),
            initial_current_task=initial_status_payload.get("current_task"),
            timeout_seconds=args.verify_timeout,
        )
        print(f"verification: {'ok' if result['ok'] else 'not verified'} ({result['reason']})")
        status = result["status"]
        print(f"state: {status.get('state', 'unknown')}")
        if status.get("current_task"):
            print(f"current task: {status['current_task']}")
    print_worker_commands(name)
    if args.open:
        result = open_worker_window(name, terminal=args.terminal, dry_run=False, force=args.force_open)
        print("")
        print(f"opened {result['terminal']} window for {name}")
    if args.stop_after:
        if session_exists(name):
            run(["tmux", "kill-session", "-t", tmux_target(name)])
            append_event(name, "stop", {"killed_session": True, "reason": "stop_after"})
            print("")
            print(f"stopped {name} (--stop-after)")
    return 0


def command_start_test(args: argparse.Namespace) -> int:
    name = args.name
    task = args.task or (
        f"Read README.md and run workerctl update-status {name} with a short summary. "
        "Do not edit tracked files."
    )
    create_args = argparse.Namespace(
        accept_trust=args.accept_trust,
        cwd=args.cwd,
        initial_prompt=True,
        name=name,
        reuse=args.reuse,
        open=args.open,
        force_open=args.force_open,
        stop_after=args.stop_after,
        task=task,
        terminal=args.terminal,
        verify=True,
        verify_timeout=args.verify_timeout,
        wait_ready=True,
        wait_ready_timeout=args.wait_ready_timeout,
    )
    return command_create(create_args)


def command_open(args: argparse.Namespace) -> int:
    result = open_worker_window(args.name, terminal=args.terminal, dry_run=args.dry_run, force=args.force)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_open_worker(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
    worker = snapshot["worker"]
    if worker is None:
        raise WorkerError(f"Task {snapshot['name']} has no active worker")
    result = open_tmux_session_window(worker["tmux_session"], terminal=args.terminal, dry_run=args.dry_run)
    result["task"] = snapshot["name"]
    result["worker"] = worker["name"]
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_open_manager(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
    manager = snapshot["manager"]
    if manager is None:
        raise WorkerError(f"Task {snapshot['name']} has no active manager")
    result = open_tmux_session_window(manager["tmux_session"], terminal=args.terminal, dry_run=args.dry_run)
    result["manager"] = manager["name"]
    result["task"] = snapshot["name"]
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_list(args: argparse.Namespace) -> int:
    root = state_root()
    if not root.exists():
        if args.json:
            print("[]")
        return 0
    workers: list[dict[str, Any]] = []
    for path in sorted(root.iterdir()):
        if not path.is_dir():
            continue
        config = load_json(path / "config.json", {})
        status = load_json(path / "status.json", {})
        name = config.get("name", path.name)
        terminal_error = None
        try:
            running = session_exists(name)
        except WorkerError as exc:
            running = False
            terminal_error = str(exc)
        worker = {
            "name": name,
            "running": running,
            "status": "running" if running else "stopped",
            "state": status.get("state", "unknown"),
            "current_task": status.get("current_task", ""),
        }
        if terminal_error is not None:
            worker["terminal_error"] = terminal_error
        workers.append(worker)
    if args.json:
        print(json.dumps(workers, indent=2, sort_keys=True))
        return 0
    for worker in workers:
        print(f"{worker['name']}\t{worker['status']}\t{worker['state']}\t{worker['current_task']}")
    return 0


def command_capture(args: argparse.Namespace) -> int:
    config = _worker_config_or_session(args.name)
    output = _capture_output_for_config(args.name, config, args.lines)
    if getattr(args, "include_content", False):
        if output:
            print(output)
        return 0
    capture_meta = load_json(capture_meta_path(args.name), {})
    summary = {
        "byte_count": len(output.encode()),
        "content_redacted": True,
        "history_lines": args.lines,
        "line_count": len(output.splitlines()),
        "name": args.name,
        "sha256": capture_meta.get("sha256"),
        "transcript_path": str(transcript_path(args.name)),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def command_status(args: argparse.Namespace) -> int:
    config = _worker_config_or_session(args.name)
    status = latest_status(args.name)
    capture_meta = load_json(capture_meta_path(args.name), {})
    terminal_capture_error: str | None = None
    try:
        running = _session_exists_for_config(args.name, config)
    except WorkerError as exc:
        running = False
        terminal_capture_error = str(exc)
    if running and args.refresh:
        try:
            _capture_output_for_config(args.name, config, args.lines)
            capture_meta = load_json(capture_meta_path(args.name), {})
        except WorkerError as exc:
            terminal_capture_error = str(exc)
            capture_meta = {"error": terminal_capture_error}
    elif terminal_capture_error is None and capture_meta.get("error"):
        terminal_capture_error = capture_meta.get("error")

    state = status.get("state", "unknown")
    if state not in VALID_STATES:
        state = "unknown"

    summary = {
        "name": args.name,
        "tmux_session": config.get("tmux_session"),
        "running": running,
        "startup": config.get("startup"),
        "startup_reason": config.get("startup_reason"),
        "startup_recommended_action": config.get("startup_recommended_action"),
        "state": state,
        "current_task": status.get("current_task"),
        "next_action": status.get("next_action"),
        "blocker": status.get("blocker"),
        "status_last_update": status.get("last_update"),
        "terminal_captured_at": capture_meta.get("captured_at"),
        "terminal_changed_at": capture_meta.get("changed_at"),
        "terminal_capture_error": terminal_capture_error,
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def idle_summary(
    name: str,
    *,
    status_stale_seconds: int,
    terminal_stale_seconds: int,
    busy_wait_seconds: int,
    refresh: bool,
    lines: int,
) -> dict[str, Any]:
    config = _worker_config_or_session(name)
    status = latest_status(name)
    capture_meta = load_json(capture_meta_path(name), {})
    capture_error = None
    try:
        running = _session_exists_for_config(name, config)
    except WorkerError as exc:
        running = False
        capture_error = str(exc)

    if running and refresh:
        try:
            _capture_output_for_config(name, config, lines)
            capture_meta = load_json(capture_meta_path(name), {})
        except WorkerError as exc:
            capture_error = str(exc)

    state = status.get("state", "unknown")
    if state not in VALID_STATES:
        state = "unknown"

    status_age = age_seconds(status.get("last_update"))
    terminal_age = age_seconds(capture_meta.get("changed_at"))
    status_is_stale = status_age is None or status_age >= status_stale_seconds
    terminal_is_stale = terminal_age is None or terminal_age >= terminal_stale_seconds
    terminal_output = ""
    terminal_fresh = True
    if running:
        try:
            terminal_output = capture_tmux_target(_tmux_target_for_config(name, config), lines)
        except WorkerError as exc:
            terminal_fresh = False
            if capture_error is None:
                capture_error = str(exc)
            terminal_output = transcript_path(name).read_text() if transcript_path(name).exists() else ""
    if capture_error is not None:
        terminal_fresh = False
    busy_wait = classify_busy_wait(terminal_output, status_age, busy_wait_seconds)

    if not running:
        health = "stopped"
        recommended_action = "none"
        reason = "tmux session is not running"
    elif state == "blocked":
        health = "blocked"
        recommended_action = "read_blocker"
        reason = "worker status.json reports blocked"
    elif state == "done":
        health = "done"
        recommended_action = "review_result"
        reason = "worker status.json reports done"
    elif capture_error:
        health = "unknown"
        recommended_action = "inspect_terminal"
        reason = capture_error
    elif busy_wait:
        health = "busy_wait"
        recommended_action = busy_wait["recommended_action"]
        reason = busy_wait["reason"]
    elif terminal_is_stale and status_is_stale:
        health = "stale"
        recommended_action = "ask_for_status"
        reason = "terminal output and status.json are both stale"
    elif terminal_is_stale:
        health = "quiet"
        recommended_action = "wait"
        reason = "terminal output is stale but status.json is fresh"
    elif status_is_stale:
        health = "status_stale"
        recommended_action = "wait"
        reason = "terminal output changed recently but status.json is stale"
    else:
        health = "active"
        recommended_action = "none"
        reason = "terminal output and status.json are fresh"

    return {
        "blocker": status.get("blocker"),
        "capture_error": capture_error,
        "current_task": status.get("current_task"),
        "health": health,
        "name": name,
        "next_action": status.get("next_action"),
        "reason": reason,
        "recommended_action": recommended_action,
        "running": running,
        "state": state,
        "status_age_seconds": status_age,
        "status_last_update": status.get("last_update"),
        "status_stale_seconds": status_stale_seconds,
        "terminal_age_seconds": terminal_age,
        "terminal_changed_at": capture_meta.get("changed_at"),
        "terminal_fresh": terminal_fresh,
        "terminal_stale_seconds": terminal_stale_seconds,
        "busy_wait_pattern": busy_wait.get("pattern") if busy_wait else None,
        "busy_wait_seconds": busy_wait_seconds,
        "tmux_session": config.get("tmux_session"),
    }


def command_idle_check(args: argparse.Namespace) -> int:
    summary = idle_summary(
        args.name,
        status_stale_seconds=args.status_stale_seconds,
        terminal_stale_seconds=args.terminal_stale_seconds,
        busy_wait_seconds=args.busy_wait_seconds,
        refresh=args.refresh,
        lines=args.lines,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def command_update_status(args: argparse.Namespace) -> int:
    config = require_worker(args.name)
    timestamp = now_iso()
    payload = {
        "blocker": args.blocker,
        "current_task": args.current_task,
        "last_update": timestamp,
        "next_action": args.next_action,
        "state": args.state,
    }
    write_json(status_path(args.name), payload)
    append_event(
        args.name,
        "status_updated",
        {
            "blocker": args.blocker,
            "current_task": args.current_task,
            "next_action": args.next_action,
            "state": args.state,
        },
    )
    with connect_db() as conn:
        initialize_database(conn)
        worker_id = upsert_worker(
            conn,
            name=args.name,
            cwd=config.get("cwd", ""),
            tmux_session=config.get("tmux_session", tmux_session(args.name)),
            identity_token=config.get("identity_token"),
            tmux_pane_id=config.get("tmux_pane_id"),
            state="active",
            timestamp=timestamp,
        )
        insert_db_status(conn, worker_id=worker_id, status=payload, timestamp=timestamp)
        insert_db_event(
            conn,
            "status_updated",
            actor="workerctl",
            worker_id=worker_id,
            payload={
                "blocker": args.blocker,
                "current_task": args.current_task,
                "next_action": args.next_action,
                "state": args.state,
            },
        )
        conn.commit()
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def _doctor_worker_summary(name: str, config: dict[str, Any], path: Path) -> dict[str, Any]:
    terminal_error = None
    try:
        running = session_exists(name)
    except WorkerError as exc:
        running = False
        terminal_error = str(exc)
    summary = {
        "name": name,
        "running": running,
        "startup": config.get("startup"),
        "state": load_json(path / "status.json", {}).get("state", "unknown"),
    }
    if terminal_error is not None:
        summary["terminal_error"] = terminal_error
    return summary


def command_doctor(args: argparse.Namespace) -> int:
    checks: list[dict[str, Any]] = []

    tmux_path = shutil.which("tmux")
    codex_path = shutil.which("codex")
    checks.append({"name": "tmux", "ok": bool(tmux_path), "path": tmux_path})
    checks.append({"name": "codex", "ok": bool(codex_path), "path": codex_path})

    if tmux_path:
        proc = run(["tmux", "-V"], check=False)
        checks.append({"name": "tmux_version", "ok": proc.returncode == 0, "value": proc.stdout.strip()})

    if codex_path:
        proc = run(["codex", "--version"], check=False)
        checks.append(
            {
                "name": "codex_version",
                "ok": proc.returncode == 0,
                "value": (proc.stdout.strip() or proc.stderr.strip()),
            }
        )

    target_cwd = Path(args.cwd).expanduser().resolve()
    checks.append({"name": "target_cwd_exists", "ok": target_cwd.is_dir(), "path": str(target_cwd)})
    checks.append({"name": "state_root_exists", "ok": state_root().exists(), "path": str(state_root())})

    workers = []
    if state_root().exists():
        for path in sorted(state_root().iterdir()):
            if path.is_dir() and (path / "config.json").exists():
                config = load_json(path / "config.json", {})
                name = config.get("name", path.name)
                workers.append(
                    _doctor_worker_summary(name, config, path)
                )

    ok = all(check.get("ok", False) for check in checks if check["name"] != "state_root_exists")
    result = {
        "checks": checks,
        "ok": ok,
        "project_root": str(PROJECT_ROOT),
        "workers": workers,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if ok else 1


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()


def new_path_payload(*, session: str | None = None) -> dict[str, Any]:
    """Describe how the current Codex session can register itself under the new path.

    The new path is: register an already-running Codex session as a worker (or
    manager), create a task, bind the pair, and let the manager Codex drive
    `workerctl cycle <task>` to observe progress.
    """
    return {
        "command_template": (
            "workerctl register-worker --name <NAME> --pid <PID> "
            "--cwd <CWD> --tmux-session <SESSION>"
        ),
        "follow_up": [
            "Have a manager Codex session register itself via `workerctl register-manager --name <MGR_NAME> --pid <MGR_PID> --cwd <CWD>`.",
            "Create a task and bind the pair: `workerctl tasks --create <TASK> --goal \"<goal>\"` then `workerctl bind --task <TASK> --worker <NAME> --manager <MGR_NAME>`.",
            "The manager Codex drives the supervision loop by calling `workerctl cycle <TASK>` repeatedly and reading the returned JSON.",
        ],
    }


def command_doctor_self(args: argparse.Namespace) -> int:
    """Verify the current Codex session can register itself as a worker.

    The new path does not require an in-place promotion: it simply needs a
    workerctl binary on PATH and, if the session is to be nudged via tmux, a
    live tmux session. Managers do not require tmux at all.
    """
    session_error = None
    try:
        session = getattr(args, "session", None) or current_session_name()
    except WorkerError as exc:
        session = None
        session_error = str(exc)
    tmux_path = shutil.which("tmux")
    codex_path = shutil.which("codex")
    workerctl_path = shutil.which("workerctl")
    skill_path = _codex_home() / "skills" / "manage-codex-workers" / "SKILL.md"
    checks = [
        {"name": "workerctl_on_path", "ok": bool(workerctl_path), "path": workerctl_path},
        {"name": "tmux_on_path", "ok": bool(tmux_path), "path": tmux_path},
        {"name": "codex_on_path", "ok": bool(codex_path), "path": codex_path},
        {"name": "inside_tmux", "ok": bool(session), "session": session},
        {"name": "manage_skill_installed", "ok": skill_path.exists(), "path": str(skill_path)},
    ]
    if session_error is not None:
        checks.append({"name": "tmux_access", "ok": False, "error": session_error})
    if session and tmux_path:
        try:
            proc = run(["tmux", "has-session", "-t", session], check=False)
            raise_for_tmux_permission_failure(proc)
            checks.append({"name": "current_tmux_session_live", "ok": proc.returncode == 0, "session": session})
        except WorkerError as exc:
            checks.append({"name": "current_tmux_session_live", "ok": False, "session": session, "error": str(exc)})
    if workerctl_path:
        proc = run(["workerctl", "classify", "--text", "workerctl self doctor"], check=False)
        checks.append({"name": "workerctl_executable", "ok": proc.returncode == 0, "path": workerctl_path})

    # A session can register itself as a worker if workerctl is on PATH, tmux is
    # available, and the current process is inside a live tmux session that the
    # manager can later nudge through. Managers do not strictly need tmux, but
    # for this preflight we require the same minimums.
    supported = all(
        check["ok"]
        for check in checks
        if check["name"] in {"workerctl_on_path", "tmux_on_path", "inside_tmux", "current_tmux_session_live"}
    )
    payload = new_path_payload(session=session)
    payload["supported"] = supported
    if supported:
        why_or_why_not = (
            "This Codex session is inside a live tmux session and workerctl is on PATH; "
            "it can register itself as a worker via `workerctl register-worker`."
        )
    else:
        failed = [check["name"] for check in checks if not check["ok"]]
        why_or_why_not = (
            "This Codex session cannot register itself as a tmux-backed worker. "
            f"Failed checks: {', '.join(failed) if failed else 'unknown'}. "
            "A Codex session running outside tmux can still register itself as a "
            "manager via `workerctl register-manager`."
        )
    result = {
        "checks": checks,
        "command_template": payload["command_template"],
        "current_session": session,
        "follow_up": payload["follow_up"],
        "ok": supported,
        "skill_path": str(skill_path),
        "supported": supported,
        "why_or_why_not": why_or_why_not,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if supported else 1


def command_qa_plan(args: argparse.Namespace) -> int:
    scenario = getattr(args, "scenario", "self-management")
    qa_plans = {
        "self-management": {
            "expected_observations": [
                "tmux session hosts a live Codex worker process",
                "register-worker resolves the rollout JSONL via lsof (or accepts --codex-session) and records the session as a worker",
                "register-manager records the manager session without requiring tmux",
                "tasks --create returns a task row; bind links it to the worker and manager sessions",
                "workerctl cycle <task> returns JSON with keys kind, state, pane_signal, notable_pane_pattern, ingest, cycle_id",
                "session-nudge delivers text to the worker tmux pane and is observable in subsequent captures",
                "a follow-up cycle ingests new events (ingest.new_events > 0) when the worker responds",
                "a divergence (e.g., trust_prompt) surfaces in workerctl divergences <task>",
                "unbind, deregister leave the SQLite control plane clean",
                "workerctl reconcile reports no dead-pid sessions, dangling bindings, or stuck tasks after cleanup",
            ],
            "steps": [
                'Start a Codex worker inside tmux: tmux new-session -d -s codex-foo && tmux send-keys -t codex-foo "codex" Enter.',
                "Capture the worker pid (e.g., pgrep -f 'codex.*--sandbox' | head -1) and confirm the rollout JSONL exists under ~/.codex/sessions/.",
                'Register the worker: workerctl register-worker --name foo --pid <WORKER_PID> --cwd "$PWD" --tmux-session codex-foo.',
                'Register the manager (its own Codex session pid): workerctl register-manager --name foo-mgr --pid <MGR_PID> --cwd "$PWD".',
                'Create the task: workerctl tasks --create my-task --goal "QA: cycle and nudge flow".',
                "Bind the pair: workerctl bind --task my-task --worker foo --manager foo-mgr.",
                "Run one observation cycle: workerctl cycle my-task. Verify JSON output includes kind, state, pane_signal, notable_pane_pattern, ingest, and cycle_id.",
                'Send a nudge: workerctl session-nudge foo "Status?". Verify the worker tmux pane shows the text.',
                "Run another cycle: workerctl cycle my-task. Verify ingest.new_events > 0 if the worker responded.",
                "Trigger a divergence: leave the worker at a trust prompt or rate-limit prompt, run workerctl cycle my-task, and run workerctl divergences my-task to confirm the row appears.",
                'Clean up the binding: workerctl unbind --task my-task. (Optionally: workerctl finish-task my-task --reason "QA complete".)',
                "Deregister both sessions: workerctl deregister foo && workerctl deregister foo-mgr.",
                "Run workerctl reconcile and confirm dead_pid_sessions, dangling_bindings, and stuck_tasks are all empty for this task. Add --apply if anything drifted.",
                "Run workerctl audit my-task and workerctl replay my-task to confirm the observation and actuation history is present.",
            ],
        },
        "emergent-criteria": {
            "expected_observations": [
                "manager cycle output includes manager_context.acceptance_criteria with summary/open/proposed/satisfied/deferred/rejected",
                "criteria_negotiation.needed starts true before active current-task criteria exist and turns false after proposed, accepted, or satisfied criteria exist",
                "the manager asks the worker for must-have current-task criteria versus deferred follow-up criteria",
                "criteria-plan can draft reviewed workerctl criteria --add commands from separated worker criteria text without mutating task state",
                "worker-proposed and manager-inferred criteria are visible through workerctl criteria --list",
                "accepted criteria block finish-task --require-criteria-audit until satisfied, deferred, or rejected",
                "satisfied criteria include evidence_json describing the verification receipt",
                "after multiple criteria mutations, workerctl criteria --list is used as the canonical task state",
                "replay shows acceptance_criterion_added and acceptance_criterion_updated transitions",
                "export-task writes acceptance-criteria.json and includes it in manifest.json",
                "finish-task --stop-manager --stop-worker reports killed_worker and killed_manager true for the session-bound pair",
                "after cleanup, no matching tmux sessions remain and the worker/manager session rows are marked gone",
                "after cleanup, reconcile reports no dangling bindings, dead-pid sessions, or stuck tasks and git status remains clean",
            ],
            "steps": [
                'Start a real pair: workerctl pair --task qa-emergent-criteria --worker-name qa-ec-worker --manager-name qa-ec-manager --cwd "$PWD" --task-goal "QA emergent acceptance criteria and cleanup lifecycle without tracked edits." --task-summary "Real worker/manager QA for criteria negotiation, finish cleanup, and tmux diagnostics." --task-prompt "Inspect README.md and workerctl help. Do not edit tracked files. Wait for manager instructions. When asked, propose 2-4 acceptance criteria for this QA slice, separating must-have criteria from follow-up criteria."',
                "Run workerctl cycle qa-emergent-criteria and verify manager_context.acceptance_criteria is present with empty status buckets.",
                "Verify manager_context.criteria_negotiation.needed is true and reason is no_criteria on the first cycle.",
                'Nudge the worker: workerctl session-nudge qa-ec-worker "Propose 2-4 acceptance criteria for this QA slice. Separate must-have current-task criteria from deferred follow-up criteria. Keep this status-only: do not edit tracked files."',
                "Optionally save the worker response and run workerctl criteria-plan qa-emergent-criteria --from-worker-response response.md --json; review suggestions before running any criteria mutations.",
                "Record at least one worker-proposed must-have criterion as accepted with workerctl criteria qa-emergent-criteria --add --criterion \"...\" --source worker_proposed --status accepted.",
                "Record at least one follow-up criterion as deferred with workerctl criteria qa-emergent-criteria --add --criterion \"...\" --source worker_proposed --status deferred --rationale \"Follow-up after this QA slice\".",
                "Run workerctl cycle qa-emergent-criteria again and verify open contains the accepted criterion while deferred contains the follow-up.",
                "Run workerctl cycle qa-emergent-criteria again and verify manager_context.criteria_negotiation.needed is false after active criteria exist.",
                "Check git status --short --branch and verify the status-only worker has not edited tracked files.",
                "If the worker omits a useful proof, add a manager-inferred accepted criterion with workerctl criteria qa-emergent-criteria --add --criterion \"...\" --source manager_inferred --status accepted.",
                "Attempt workerctl finish-task qa-emergent-criteria --reason \"QA premature finish\" --require-criteria-audit and verify it fails while accepted criteria remain open.",
                "Satisfy each accepted criterion with workerctl criteria qa-emergent-criteria --satisfy <id> --evidence-json '{\"command\":\"...\",\"status\":\"pass\"}' --proof \"...\".",
                "Run workerctl criteria qa-emergent-criteria --list and verify accepted is 0 before attempting the final audited finish.",
                "Run workerctl replay qa-emergent-criteria and verify criteria add/update transitions appear in chronological order.",
                "Run workerctl export-task qa-emergent-criteria --output /tmp/qa-emergent-criteria-export and verify acceptance-criteria.json exists and manifest.json lists it.",
                "Finish with workerctl finish-task qa-emergent-criteria --reason \"QA criteria flow complete\" --require-criteria-audit --stop-manager --stop-worker and verify killed_worker and killed_manager are true.",
                "Run tmux list-sessions 2>/dev/null | rg 'qa-ec-(worker|manager)|codex-qa-ec' || true and verify no matching tmux sessions remain.",
                "Run workerctl sessions --state all and verify qa-ec-worker and qa-ec-manager are both state gone.",
                "Run workerctl reconcile --stale-cycles-seconds 1 and confirm dead_pid_sessions, dangling_bindings, and stuck_tasks are empty.",
                "Run git status --short --branch and verify tracked status remains clean.",
            ],
        },
        "tmux-errors": {
            "expected_observations": [
                "read-only commands preserve stable JSON output and include actionable tmux error fields when tmux is unavailable or capture fails",
                "mutating commands that depend on tmux fail loudly with nonzero exit status and actionable stderr",
                "failed tmux send/kill attempts do not claim success and do not leave misleading partial-success audit rows",
                "cycle reports pane_signal.degraded true for terminal capture failures while worker_alive and manager_alive continue to reflect process liveness",
                "finish-task --stop-manager --stop-worker reports stop failures clearly when tmux cannot stop one side of the session-bound pair",
                "reconcile remains the recovery path for DB/runtime drift after tmux failures",
                "live failure simulations are isolated to disposable sessions or a controlled PATH/env override and do not disturb active user sessions",
            ],
            "steps": [
                "Record a clean preflight: workerctl doctor-self --json, workerctl sessions --state active, tmux list-sessions, and git status --short --branch.",
                "Run a read-only missing-tmux simulation, for example PATH=/usr/bin:/bin workerctl doctor-self --json, and verify the output remains parseable JSON with tmux_available false or an actionable tmux error field.",
                "Run workerctl list --json and workerctl status <disposable-worker> under the same missing-tmux simulation, if a disposable worker exists, and verify JSON shape is preserved rather than replaced by a traceback.",
                "Create or reuse only a disposable pair for mutation checks; do not target active project work sessions.",
                "Force a tmux send failure for workerctl session-nudge <disposable-worker> by using a missing tmux binary, killed tmux session, or invalid disposable tmux target; verify nonzero exit and actionable stderr.",
                "After the failed nudge, run workerctl audit <task> and workerctl replay <task>; verify no misleading successful session_nudged event was recorded for the failed send.",
                "Run workerctl cycle <task> with the disposable worker's tmux pane unavailable and verify pane_signal.degraded is true, terminal capture failure details are present, and worker_alive/manager_alive still describe registered process liveness.",
                "Exercise finish-task --stop-manager --stop-worker against a disposable pair where one tmux session is already gone; verify the command reports which stop failed or was already unavailable instead of silently claiming full cleanup.",
                "Run workerctl reconcile --stale-cycles-seconds 1 after each simulated failure and verify dead_pid_sessions, dangling_bindings, and stuck_tasks are understandable and recoverable.",
                "Run workerctl reconcile --apply only after inspecting the dry-run output and only for disposable sessions created by this QA.",
                "Verify cleanup with tmux list-sessions, workerctl sessions --state all, workerctl reconcile --stale-cycles-seconds 1, and git status --short --branch.",
                "If any live simulation would require disrupting real tmux or active Codex sessions, stop at the generated plan and cover that case with unit tests or dependency injection instead.",
            ],
        },
        "dispatch-completion": {
            "expected_observations": [
                "dispatch --once routes a bound worker task_complete signal from codex_events, not pane classifier output",
                "routed_notifications contains the worker_task_complete row with a correlation_id, source_event_id, delivered state, and dedupe key including the source event id",
                "the bound manager tmux pane receives a mechanical notification that asks the manager to inspect evidence and decide next action, without declaring task success",
                "a second task_complete event for the same binding creates a second routed notification rather than being suppressed by signal type alone",
                "a duplicate-route race emits dispatch_signal_suppressed telemetry and does not send another tmux notification",
                "audit, replay, and dashboard dispatch surfaces show the completion-only chain with a human-readable notification label, source event, timestamp, and notification count",
                "mixed command-backed and completion-only dispatch chains appear in chronological order",
                "the Dispatch panel surfaces queued, failed, stale, risky, and suppressed dispatch state without presenting Dispatch as a decision maker",
            ],
            "steps": [
                'Create a disposable pair: workerctl pair --task qa-dispatch-completion --worker-name qa-dispatch-worker --manager-name qa-dispatch-manager --cwd "$PWD" --task-goal "QA dispatch completion routing without tracked edits." --task-summary "Verify dispatch observes worker completion and wakes the manager mechanically." --task-prompt "Do not edit tracked files. Complete a short status-only response, then stop."',
                "Run workerctl cycle qa-dispatch-completion until the worker session has ingested codex_events with last_event_subtype task_complete.",
                "Run workerctl dispatch --once --type worker_task_complete --dispatcher-id qa-dispatch --json and verify processed_count is 1 and state is delivered.",
                "Inspect workerctl audit qa-dispatch-completion --json and verify routed_notifications has signal_type worker_task_complete, source_event_id, correlation_id, delivered state, and a dedupe_key containing the source event id.",
                "Inspect the manager tmux pane and verify it received a notification telling the manager the worker appears to have completed a turn and must inspect evidence before deciding what completion means.",
                "Run workerctl replay qa-dispatch-completion and verify routed_notifications and correlation_chains entries use the notification timestamp/source event rather than falling back to task creation time.",
                "Open the dashboard for the bound task and verify the Dispatch chain row uses a readable notification label, shows one notification, and does not replace the label with only the correlation id.",
                "Create or simulate a second worker task_complete event, run workerctl dispatch --once again, and verify a second routed notification appears because dedupe includes source_event_id.",
                "Simulate a duplicate-route race only against the disposable task or with a patched test double; verify dispatch_signal_suppressed telemetry is recorded and no extra manager send occurs.",
                "Verify the dashboard Dispatch health shows any recent suppressed dispatch signal count, and that mixed command-backed and completion-only chains are ordered by event time.",
                "Finish or clean up only the disposable pair, then run workerctl reconcile --stale-cycles-seconds 1 and git status --short --branch.",
            ],
        },
    }
    if scenario not in qa_plans:
        raise WorkerError(f"Unsupported QA scenario: {scenario}")
    payload = {"scenario": scenario, **qa_plans[scenario]}
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"QA plan: {scenario}")
        print("")
        for index, step in enumerate(payload["steps"], start=1):
            print(f"{index}. {step}")
        print("")
        print("Expected observations:")
        for observation in payload["expected_observations"]:
            print(f"- {observation}")
    return 0


def command_db_doctor(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else default_db_path()
    with connect_db(db_path) as conn:
        initialize_database(conn)
        health = database_health(conn)
    checks = list(health["checks"])
    result = {
        **health,
        "checks": checks,
        "path": str(db_path),
    }
    if getattr(args, "live", False):
        live_results = reconcile_rows(db_path, task=None, recover=False)
        drift_count = sum(1 for row in live_results if row["drift"])
        unfinished_count = sum(len(row["unfinished_commands"]) for row in live_results)
        manager_warnings = manager_liveness_warnings(
            live_results,
            stale_seconds=getattr(args, "manager_stale_seconds", DEFAULT_MANAGER_STALE_SECONDS),
        )
        live_check = {
            "drift_count": drift_count,
            "manager_liveness_warning_count": len(manager_warnings),
            "name": "live_reconcile",
            "ok": drift_count == 0 and unfinished_count == 0,
            "task_count": len(live_results),
            "unfinished_command_count": unfinished_count,
        }
        checks.append(live_check)
        result["live_reconcile"] = {
            "manager_liveness_warnings": manager_warnings,
            "ok": live_check["ok"],
            "results": live_results,
        }
        result["ok"] = result["ok"] and live_check["ok"]
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


def command_tasks(args: argparse.Namespace) -> int:
    if args.create and not args.goal:
        raise WorkerError("--goal is required with tasks --create")
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        if args.create:
            task_id = create_db_task(conn, name=args.create, goal=args.goal, summary=args.summary)
            conn.commit()
            result = {"created": True, "id": task_id, "name": args.create}
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        tasks = list_db_tasks(conn, active_only=args.active)
    if args.json:
        print(json.dumps(tasks, indent=2, sort_keys=True))
        return 0
    for task in tasks:
        print(f"{task['name']}\t{task['state']}\t{task['goal']}")
    return 0


def _json_arg(value: str | None, *, flag: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise WorkerError(f"{flag} must be valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise WorkerError(f"{flag} must be a JSON object")
    return parsed


def command_runs(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        if args.create:
            task = db_task_row(conn, task=args.create)
            run_id = create_db_run(
                conn,
                task_id=task["id"],
                name=args.name,
                purpose=args.purpose,
                metadata=_json_arg(args.metadata_json, flag="--metadata-json"),
            )
            conn.commit()
            result = db_run_row(conn, run=run_id)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        if args.show:
            result = db_run_row(conn, run=args.show)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        if args.finish:
            result = finish_db_run(conn, run=args.finish, status=args.status or "finished")
            conn.commit()
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        task_id = None
        if args.task:
            task_id = db_task_row(conn, task=args.task)["id"]
        runs = list_db_runs(conn, task_id=task_id, status=args.status)
    print(json.dumps(runs, indent=2, sort_keys=True))
    return 0


def _session_snapshot_for_dashboard(row: Any | None) -> dict[str, Any] | None:
    if row is None:
        return None
    pid = row["pid"]
    alive = None if pid is None else _pid_is_alive(int(pid))
    return {
        "alive": alive,
        "codex_session_id": row["codex_session_id"],
        "cwd": row["cwd"],
        "id": row["id"],
        "last_heartbeat_at": row["last_heartbeat_at"],
        "name": row["name"],
        "pid": pid,
        "role": row["role"],
        "state": row["state"],
        "tmux_pane_id": row["tmux_pane_id"],
        "tmux_session": row["tmux_session"],
    }


def _latest_cycle_snapshot(conn: Any, *, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        select id, task_id, started_at, completed_at, state, status_json, health_json, decision, error
        from manager_cycles
        where task_id = ?
        order by id desc
        limit 1
        """,
        (task_id,),
    ).fetchone()
    if row is None:
        return None
    status = json.loads(row["status_json"]) if row["status_json"] else {}
    health = json.loads(row["health_json"]) if row["health_json"] else {}
    ingest = status.get("ingest") if isinstance(status, dict) else None
    return {
        "completed_at": row["completed_at"],
        "decision": row["decision"],
        "error": row["error"],
        "health": health,
        "id": row["id"],
        "ingest": ingest or {},
        "notable_pane_pattern": status.get("notable_pane_pattern") if isinstance(status, dict) else None,
        "started_at": row["started_at"],
        "state": row["state"],
        "status": status,
        "staleness_seconds": status.get("staleness_seconds") if isinstance(status, dict) else None,
        "task_id": row["task_id"],
        "worker_state": status.get("state") if isinstance(status, dict) else None,
    }


def _recent_commands_snapshot(conn: Any, *, task_id: str, limit: int) -> dict[str, Any]:
    rows = conn.execute(
        """
        select id, type, state, created_at, updated_at, task_id, worker_id, manager_id,
               payload_json, result_json, error
        from commands
        where task_id = ?
        order by created_at desc, id desc
        limit ?
        """,
        (task_id, limit),
    ).fetchall()
    recent = [
        {
            "created_at": row["created_at"],
            "error": row["error"],
            "id": row["id"],
            "manager_id": row["manager_id"],
            "payload": json.loads(row["payload_json"]),
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "state": row["state"],
            "task_id": row["task_id"],
            "type": row["type"],
            "updated_at": row["updated_at"],
            "worker_id": row["worker_id"],
        }
        for row in rows
    ]
    counts = conn.execute(
        """
        select
          sum(case when state in ('pending', 'attempted') then 1 else 0 end) as unfinished_count,
          sum(case when state = 'failed' then 1 else 0 end) as failed_count
        from commands
        where task_id = ?
        """,
        (task_id,),
    ).fetchone()
    return {
        "failed_count": int(counts["failed_count"] or 0),
        "recent": recent,
        "unfinished_count": int(counts["unfinished_count"] or 0),
    }


def _task_reconcile_diagnostics(report: dict[str, Any], *, task_id: str, task_name: str) -> dict[str, Any]:
    dangling = [
        item for item in report["dangling_bindings"]
        if item.get("task_id") == task_id or item.get("task_name") == task_name
    ]
    stuck = [
        item for item in report["stuck_tasks"]
        if item.get("task_name") == task_name
    ]
    return {
        "dangling_bindings": dangling,
        "dead_pid_sessions": report["dead_pid_sessions"],
        "schema_ok": bool(report["schema_health"].get("ok")),
        "stuck_tasks": stuck,
    }


def _dashboard_alerts(
    *,
    task_snapshot: dict[str, Any],
    worker: dict[str, Any] | None,
    manager: dict[str, Any] | None,
    latest_cycle: dict[str, Any] | None,
    criteria_summary: dict[str, int],
    commands: dict[str, Any],
    diagnostics: dict[str, Any],
    telemetry_counts: dict[str, Any],
) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    for issue in task_snapshot["integrity"]["issues"]:
        alerts.append({"severity": "error", "type": "integrity_issue", "message": issue})
    for role, session in (("worker", worker), ("manager", manager)):
        if session and session["alive"] is False:
            alerts.append({
                "message": f"{role} session pid is not alive: {session['name']}",
                "severity": "error",
                "type": "dead_pid_session",
            })
    if latest_cycle and latest_cycle["state"] == "failed":
        alerts.append({
            "message": latest_cycle.get("error") or "Latest manager cycle failed.",
            "severity": "error",
            "type": "latest_cycle_failed",
        })
    if latest_cycle and latest_cycle.get("notable_pane_pattern"):
        alerts.append({
            "message": f"Pane pattern detected: {latest_cycle['notable_pane_pattern']}",
            "severity": "warning",
            "type": "notable_pane_pattern",
        })
    if criteria_summary.get("accepted", 0):
        alerts.append({
            "message": f"{criteria_summary['accepted']} accepted criteria remain open.",
            "severity": "warning",
            "type": "open_accepted_criteria",
        })
    if commands["unfinished_count"]:
        alerts.append({
            "message": f"{commands['unfinished_count']} commands are unfinished.",
            "severity": "warning",
            "type": "unfinished_commands",
        })
    if commands["failed_count"]:
        alerts.append({
            "message": f"{commands['failed_count']} commands failed.",
            "severity": "error",
            "type": "failed_commands",
        })
    if telemetry_counts["by_severity"].get("error", 0):
        alerts.append({
            "message": f"{telemetry_counts['by_severity']['error']} telemetry error events recorded.",
            "severity": "error",
            "type": "telemetry_errors",
        })
    if diagnostics["dangling_bindings"]:
        alerts.append({"message": "Task has dangling binding drift.", "severity": "error", "type": "dangling_binding"})
    if diagnostics["stuck_tasks"]:
        alerts.append({"message": "Task has stale manager cycles.", "severity": "warning", "type": "stuck_task"})
    if not diagnostics["schema_ok"]:
        alerts.append({"message": "Database schema health is not OK.", "severity": "error", "type": "schema_health"})
    return alerts


def telemetry_snapshot(conn: Any, *, task: str, limit: int = 10) -> dict[str, Any]:
    from workerctl import db as worker_db

    task_snapshot = task_status_snapshot(conn, task=task)
    task_id = task_snapshot["id"]
    task_row = db_task_row(conn, task=task)
    try:
        binding = active_binding_for_task(conn, task_name=task_snapshot["name"])
    except WorkerError:
        binding = None

    worker = manager = None
    if binding is not None:
        worker = _session_snapshot_for_dashboard(session_by_id(conn, session_id=binding["worker_session_id"]))
        manager = _session_snapshot_for_dashboard(session_by_id(conn, session_id=binding["manager_session_id"]))

    criteria_rows = worker_db.acceptance_criteria_for_task(conn, task_id=task_id)
    criteria_summary = _acceptance_criteria_summary(criteria_rows)
    open_accepted = [row for row in criteria_rows if row["status"] == "accepted"]
    telemetry_events = query_telemetry_events(conn, task_id=task_id, limit=10000)
    telemetry_counts = telemetry_summary(telemetry_events)
    recent_telemetry = query_telemetry_events(conn, task_id=task_id, limit=limit)
    commands = _recent_commands_snapshot(conn, task_id=task_id, limit=limit)
    reconcile_report = collect_reconcile_report(conn)
    diagnostics = _task_reconcile_diagnostics(
        reconcile_report,
        task_id=task_id,
        task_name=task_snapshot["name"],
    )
    latest_cycle = _latest_cycle_snapshot(conn, task_id=task_id)
    run = active_run_for_task(conn, task_id=task_id)
    task_info = {
        "created_at": task_row["created_at"],
        "goal": task_row["goal"],
        "id": task_row["id"],
        "integrity": task_snapshot["integrity"],
        "name": task_row["name"],
        "state": task_row["state"],
        "summary": task_row["summary"],
        "updated_at": task_row["updated_at"],
    }
    return {
        "alerts": _dashboard_alerts(
            task_snapshot=task_snapshot,
            worker=worker,
            manager=manager,
            latest_cycle=latest_cycle,
            criteria_summary=criteria_summary,
            commands=commands,
            diagnostics=diagnostics,
            telemetry_counts=telemetry_counts,
        ),
        "binding": {
            "created_at": binding["created_at"],
            "id": binding["binding_id"],
            "manager_session_id": binding["manager_session_id"],
            "manager_session_name": binding["manager_session_name"],
            "state": binding["state"],
            "task_id": binding["task_id"],
            "worker_session_id": binding["worker_session_id"],
            "worker_session_name": binding["worker_session_name"],
        } if binding is not None else None,
        "commands": commands,
        "criteria": {
            "open_accepted": open_accepted,
            "open_blocker_count": len(open_accepted),
            "summary": criteria_summary,
        },
        "diagnostics": diagnostics,
        "latest_cycle": latest_cycle,
        "manager": manager,
        "run": run,
        "task": task_info,
        "telemetry": {
            "recent": recent_telemetry,
            "summary": telemetry_counts,
        },
        "worker": worker,
    }


def _cycle_view_from_row(row: Any) -> dict[str, Any]:
    status = json.loads(row["status_json"]) if row["status_json"] else {}
    health = json.loads(row["health_json"]) if row["health_json"] else {}
    pane_signal = status.get("pane_signal") if isinstance(status, dict) else None
    if isinstance(pane_signal, dict):
        pane = {
            "captured": pane_signal.get("captured"),
            "notable_pattern": pane_signal.get("notable_pattern"),
            "reason": pane_signal.get("reason"),
            "staleness_seconds": pane_signal.get("staleness_seconds"),
        }
    else:
        pane = None
    ingest = status.get("ingest") if isinstance(status, dict) else None
    return {
        "completed_at": row["completed_at"],
        "decision": row["decision"],
        "error": row["error"],
        "health": health,
        "id": row["id"],
        "ingest": ingest or {},
        "manager_id": row["manager_id"],
        "notable_pane_pattern": status.get("notable_pane_pattern") if isinstance(status, dict) else None,
        "pane_signal": pane,
        "started_at": row["started_at"],
        "state": row["state"],
        "staleness_seconds": status.get("staleness_seconds") if isinstance(status, dict) else None,
        "task_id": row["task_id"],
        "worker_state": status.get("state") if isinstance(status, dict) else None,
    }


def _cycle_history_view(conn: Any, *, task_id: str, limit: int) -> dict[str, Any]:
    rows = conn.execute(
        """
        select id, task_id, manager_id, started_at, completed_at, state,
               status_json, health_json, decision, error
        from manager_cycles
        where task_id = ?
        order by id desc
        limit ?
        """,
        (task_id, limit),
    ).fetchall()
    history = [_cycle_view_from_row(row) for row in rows]
    last_success_row = conn.execute(
        """
        select id, task_id, manager_id, started_at, completed_at, state,
               status_json, health_json, decision, error
        from manager_cycles
        where task_id = ? and state = 'succeeded'
        order by id desc
        limit 1
        """,
        (task_id,),
    ).fetchone()
    failed_rows = conn.execute(
        """
        select id, task_id, manager_id, started_at, completed_at, state,
               status_json, health_json, decision, error
        from manager_cycles
        where task_id = ? and state = 'failed'
        order by id desc
        limit ?
        """,
        (task_id, limit),
    ).fetchall()
    pane_failure_rows = conn.execute(
        """
        select id, task_id, manager_id, started_at, completed_at, state,
               status_json, health_json, decision, error
        from manager_cycles
        where task_id = ?
          and json_extract(status_json, '$.pane_signal.captured') = 0
        order by id desc
        limit ?
        """,
        (task_id, limit),
    ).fetchall()
    counts = conn.execute(
        """
        select state, count(*) as count
        from manager_cycles
        where task_id = ?
        group by state
        """,
        (task_id,),
    ).fetchall()
    return {
        "counts_by_state": {row["state"]: int(row["count"]) for row in counts},
        "failed": [_cycle_view_from_row(row) for row in failed_rows],
        "failed_count": int(sum(row["count"] for row in counts if row["state"] == "failed")),
        "history": history,
        "last_successful": _cycle_view_from_row(last_success_row) if last_success_row else None,
        "pane_capture_failures": [_cycle_view_from_row(row) for row in pane_failure_rows],
        "pane_capture_failure_count": len(pane_failure_rows),
        "total": int(sum(row["count"] for row in counts)),
    }


def _safe_command_view(row: Any) -> dict[str, Any]:
    result = json.loads(row["result_json"]) if row["result_json"] else None
    payload = json.loads(row["payload_json"]) if row["payload_json"] else {}
    return {
        "attempts": row["attempts"],
        "available_at": row["available_at"],
        "claimed_by": row["claimed_by"],
        "correlation_id": row["correlation_id"],
        "created_at": row["created_at"],
        "error": row["error"],
        "id": row["id"],
        "manager_id": row["manager_id"],
        "max_attempts": row["max_attempts"],
        "payload_keys": sorted(payload) if isinstance(payload, dict) else [],
        "required_permission": row["required_permission"],
        "result_keys": sorted(result) if isinstance(result, dict) else [],
        "state": row["state"],
        "task_id": row["task_id"],
        "type": row["type"],
        "updated_at": row["updated_at"],
        "worker_id": row["worker_id"],
    }


def _commands_view(
    conn: Any,
    *,
    task_id: str | None = None,
    only_failed: bool = False,
    limit: int,
    updated_since: str | None = None,
    active_only: bool = False,
) -> dict[str, Any]:
    filters: list[str] = []
    params: list[Any] = []
    if task_id is not None:
        filters.append("task_id = ?")
        params.append(task_id)
    if updated_since is not None:
        filters.append("updated_at >= ?")
        params.append(updated_since)
    if active_only:
        filters.append("task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))")
    if only_failed:
        filters.append("state = 'failed'")
    where = f"where {' and '.join(filters)}" if filters else ""
    rows = conn.execute(
        f"""
        select id, idempotency_key, created_at, updated_at, task_id, worker_id,
               manager_id, correlation_id, type, state, available_at, claimed_by,
               claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
               required_permission, result_json, error
        from commands
        {where}
        order by updated_at desc, created_at desc, id desc
        limit ?
        """,
        [*params, limit],
    ).fetchall()
    count_filters = list(filters)
    count_params = list(params)
    count_where = f"where {' and '.join(count_filters)}" if count_filters else ""
    counts = conn.execute(
        f"select state, count(*) as count from commands {count_where} group by state",
        count_params,
    ).fetchall()
    return {
        "counts_by_state": {row["state"]: int(row["count"]) for row in counts},
        "failed_count": int(sum(row["count"] for row in counts if row["state"] == "failed")),
        "recent": [_safe_command_view(row) for row in rows],
        "total": int(sum(row["count"] for row in counts)),
    }


def _decisions_view(conn: Any, *, task_id: str, limit: int) -> dict[str, Any]:
    rows = conn.execute(
        """
        select id, task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
        from manager_decisions
        where task_id = ?
        order by created_at desc, id desc
        limit ?
        """,
        (task_id, limit),
    ).fetchall()
    return {
        "recent": [
            {
                "created_at": row["created_at"],
                "decision": row["decision"],
                "id": row["id"],
                "manager_cycle_id": row["manager_cycle_id"],
                "manager_id": row["manager_id"],
                "payload_keys": sorted(json.loads(row["payload_json"])),
                "reason": row["reason"],
                "task_id": row["task_id"],
            }
            for row in rows
        ],
    }


def _ingest_view(
    conn: Any,
    *,
    task_id: str | None = None,
    run_id: str | None = None,
    limit: int,
    updated_since: str | None = None,
    active_only: bool = False,
) -> dict[str, Any]:
    filters: list[str] = []
    params: list[Any] = []
    if task_id is not None:
        filters.append("task_id = ?")
        params.append(task_id)
    if run_id is not None:
        filters.append("run_id = ?")
        params.append(run_id)
    if updated_since is not None:
        filters.append("timestamp >= ?")
        params.append(updated_since)
    if active_only:
        filters.append("task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))")
    filter_sql = (" and " + " and ".join(filters)) if filters else ""
    skipped_row = conn.execute(
        f"""
        select
          sum(coalesce(json_extract(attributes_json, '$.new_events'), 0)) as new_events,
          sum(coalesce(json_extract(attributes_json, '$.skipped_lines'), 0)) as skipped_lines
        from telemetry_events
        where event_type = 'codex_events_ingested' {filter_sql}
        """,
        params,
    ).fetchone()
    skipped_events = conn.execute(
        f"""
        select id, run_id, task_id, timestamp, actor, event_type, severity,
               summary, correlation_json, attributes_json
        from telemetry_events
        where event_type = 'codex_events_ingested'
          and coalesce(json_extract(attributes_json, '$.skipped_lines'), 0) > 0
          {filter_sql}
        order by timestamp desc, id desc
        limit ?
        """,
        [*params, limit],
    ).fetchall()
    error_events = conn.execute(
        f"""
        select id, run_id, task_id, timestamp, actor, event_type, severity,
               summary, correlation_json, attributes_json
        from telemetry_events
        where (event_type like '%ingest%' or event_type = 'codex_events_ingested')
          and severity in ('warning', 'error')
          {filter_sql}
        order by timestamp desc, id desc
        limit ?
        """,
        [*params, limit],
    ).fetchall()
    cycle_filters: list[str] = ["mc.state = 'failed'"]
    cycle_params: list[Any] = []
    if task_id is not None:
        cycle_filters.append("mc.task_id = ?")
        cycle_params.append(task_id)
    if updated_since is not None:
        cycle_filters.append("coalesce(mc.completed_at, mc.started_at) >= ?")
        cycle_params.append(updated_since)
    if active_only:
        cycle_filters.append("mc.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))")
    cycle_where = " and ".join(cycle_filters)
    cycle_errors = conn.execute(
        f"""
        select mc.id, mc.task_id, t.name as task_name, mc.started_at, mc.completed_at,
               mc.state, mc.error, mc.status_json
        from manager_cycles mc
        left join tasks t on t.id = mc.task_id
        where {cycle_where}
          and (
            mc.error like '%Ingest%'
            or json_extract(mc.status_json, '$.error_type') like '%Ingest%'
          )
        order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
        limit ?
        """,
        [*cycle_params, limit],
    ).fetchall()

    def event_summary(row: Any) -> dict[str, Any]:
        attributes = json.loads(row["attributes_json"]) if row["attributes_json"] else {}
        return {
            "attributes": {
                key: attributes.get(key)
                for key in ("new_events", "skipped_lines", "error", "reason")
                if key in attributes
            },
            "event_type": row["event_type"],
            "id": row["id"],
            "run_id": row["run_id"],
            "severity": row["severity"],
            "summary": row["summary"],
            "task_id": row["task_id"],
            "timestamp": row["timestamp"],
        }

    return {
        "cycle_errors": [
            {
                "completed_at": row["completed_at"],
                "error": row["error"],
                "id": row["id"],
                "started_at": row["started_at"],
                "state": row["state"],
                "task_id": row["task_id"],
                "task_name": row["task_name"],
            }
            for row in cycle_errors
        ],
        "error_count": len(error_events) + len(cycle_errors),
        "recent_errors": [event_summary(row) for row in error_events],
        "recent_skipped": [event_summary(row) for row in skipped_events],
        "skipped_lines": _metrics_sum_row(skipped_row, "skipped_lines"),
        "new_events": _metrics_sum_row(skipped_row, "new_events"),
    }


def _criteria_view(conn: Any, *, task_id: str, limit: int) -> dict[str, Any]:
    from workerctl import db as worker_db

    rows = worker_db.acceptance_criteria_for_task(conn, task_id=task_id)
    summary = _acceptance_criteria_summary(rows)
    open_rows = [row for row in rows if row["status"] in ("proposed", "accepted")]
    return {
        "open": [
            {
                "created_at": row["created_at"],
                "id": row["id"],
                "proof": row["proof"],
                "source": row["source"],
                "status": row["status"],
                "updated_at": row["updated_at"],
            }
            for row in open_rows[:limit]
        ],
        "open_count": len(open_rows),
        "summary": summary,
        "total": len(rows),
    }


def _storage_counts(conn: Any, *, task_id: str | None = None) -> dict[str, Any]:
    task_filter = "where task_id = ?" if task_id is not None else ""
    task_params = [task_id] if task_id is not None else []
    terminal = conn.execute(
        f"select count(*) as count, sum(byte_count) as bytes from terminal_captures {task_filter}",
        task_params,
    ).fetchone()
    segments = conn.execute(
        f"select count(*) as count, sum(byte_count) as bytes from transcript_segments {task_filter}",
        task_params,
    ).fetchone()
    transcript_sql = "select count(*) as count, sum(byte_count) as bytes from transcript_captures"
    transcript_params: list[Any] = []
    if task_id is not None:
        transcript_sql = """
            select count(distinct transcript_captures.id) as count,
                   sum(transcript_captures.byte_count) as bytes
            from transcript_captures
            join bindings on bindings.worker_id = transcript_captures.worker_id
            where bindings.task_id = ?
        """
        transcript_params.append(task_id)
    transcript = conn.execute(transcript_sql, transcript_params).fetchone()
    terminal_bytes = _metrics_sum_row(terminal, "bytes")
    segment_bytes = _metrics_sum_row(segments, "bytes")
    transcript_bytes = _metrics_sum_row(transcript, "bytes")
    return {
        "database_file": _database_file_size(conn),
        "terminal_captures": {"bytes": terminal_bytes, "count": int(terminal["count"] or 0)},
        "transcript_captures": {"bytes": transcript_bytes, "count": int(transcript["count"] or 0)},
        "transcript_segments": {"bytes": segment_bytes, "count": int(segments["count"] or 0)},
        "total_retained": terminal_bytes + segment_bytes + transcript_bytes,
    }


def telemetry_task_view(conn: Any, *, task: str, limit: int = 10, stale_cycle_seconds: float = 3600.0) -> dict[str, Any]:
    snapshot = telemetry_snapshot(conn, task=task, limit=limit)
    task_id = snapshot["task"]["id"]
    cycles = _cycle_history_view(conn, task_id=task_id, limit=limit)
    commands = _commands_view(conn, task_id=task_id, limit=limit)
    failed_commands = _commands_view(conn, task_id=task_id, only_failed=True, limit=limit)
    ingest = _ingest_view(conn, task_id=task_id, limit=limit)
    latest_cycle = cycles["history"][0] if cycles["history"] else None
    latest_cycle_age = age_seconds(latest_cycle["completed_at"] or latest_cycle["started_at"]) if latest_cycle else None
    liveness = {
        "latest_cycle_age_seconds": latest_cycle_age,
        "latest_cycle_stale": latest_cycle_age is not None and latest_cycle_age > stale_cycle_seconds,
        "manager_alive": snapshot["manager"]["alive"] if snapshot.get("manager") else None,
        "worker_alive": snapshot["worker"]["alive"] if snapshot.get("worker") else None,
    }
    alerts = list(snapshot["alerts"])
    if liveness["latest_cycle_stale"]:
        alerts.append({
            "message": f"Latest manager cycle is older than {stale_cycle_seconds} seconds.",
            "severity": "warning",
            "type": "stale_cycle",
        })
    if ingest["skipped_lines"]:
        alerts.append({
            "message": f"{ingest['skipped_lines']} ingest lines were skipped.",
            "severity": "warning",
            "type": "ingest_skipped_lines",
        })
    if ingest["error_count"]:
        alerts.append({
            "message": f"{ingest['error_count']} ingest errors or warnings were recorded.",
            "severity": "error",
            "type": "ingest_errors",
        })
    recent_telemetry = [
        {
            "actor": event["actor"],
            "event_type": event["event_type"],
            "id": event["id"],
            "run_id": event["run_id"],
            "severity": event["severity"],
            "summary": event["summary"],
            "timestamp": event["timestamp"],
        }
        for event in snapshot["telemetry"]["recent"]
    ]
    return {
        "alerts": alerts,
        "commands": commands,
        "criteria": _criteria_view(conn, task_id=task_id, limit=limit),
        "cycles": cycles,
        "decisions": _decisions_view(conn, task_id=task_id, limit=limit),
        "failed_commands": failed_commands["recent"],
        "ingest": ingest,
        "liveness": liveness,
        "schema_version": 1,
        "storage": _storage_counts(conn, task_id=task_id),
        "task": snapshot["task"],
        "telemetry": {
            "recent": recent_telemetry,
            "summary": snapshot["telemetry"]["summary"],
        },
    }


def _failure_window_start(window: str | None) -> tuple[str | None, dict[str, Any] | None]:
    if window is None:
        return None, None
    seconds, label = _metrics_parse_window(window)
    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=seconds)
    return _metrics_iso(start), {
        "end": _metrics_iso(end),
        "label": label,
        "seconds": seconds,
        "start": _metrics_iso(start),
    }


def _open_criteria_failure_view(
    conn: Any,
    *,
    task_id: str | None = None,
    active_only: bool = False,
    limit: int,
) -> dict[str, Any]:
    filters: list[str] = []
    params: list[Any] = []
    row_filters: list[str] = []
    if task_id is not None:
        filters.append("task_id = ?")
        row_filters.append("ac.task_id = ?")
        params.append(task_id)
    if active_only:
        filters.append("task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))")
        row_filters.append("ac.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))")
    where = f"where {' and '.join(filters)}" if filters else ""
    counts = conn.execute(
        f"""
        select status, count(*) as count
        from acceptance_criteria
        {where}
        group by status
        """,
        params,
    ).fetchall()
    row_filters = [*row_filters, "ac.status = 'accepted'"]
    row_where = f"where {' and '.join(row_filters)}"
    rows = conn.execute(
        f"""
        select ac.id, ac.task_id, t.name as task_name, ac.status, ac.source, ac.created_at, ac.updated_at
        from acceptance_criteria ac
        left join tasks t on t.id = ac.task_id
        {row_where}
        order by ac.updated_at desc, ac.id desc
        limit ?
        """,
        [*params, limit],
    ).fetchall()
    by_status = {row["status"]: int(row["count"]) for row in counts}
    return {
        "by_status": by_status,
        "open_accepted": [dict(row) for row in rows],
        "open_accepted_count": int(by_status.get("accepted", 0)),
    }


def telemetry_failures_view(
    conn: Any,
    *,
    limit: int = 25,
    stale_cycle_seconds: float = 3600.0,
    task_id: str | None = None,
    run_id: str | None = None,
    active_only: bool = False,
    window: str | None = None,
) -> dict[str, Any]:
    updated_since, window_info = _failure_window_start(window)
    operator = telemetry_operator_snapshot(conn, stale_cycle_seconds=stale_cycle_seconds, limit=limit)
    cycle_filters = ["mc.state = 'failed'"]
    cycle_params: list[Any] = []
    pane_filters = ["json_extract(mc.status_json, '$.pane_signal.captured') = 0"]
    pane_params: list[Any] = []
    if task_id is not None:
        cycle_filters.append("mc.task_id = ?")
        cycle_params.append(task_id)
        pane_filters.append("mc.task_id = ?")
        pane_params.append(task_id)
    if updated_since is not None:
        cycle_filters.append("coalesce(mc.completed_at, mc.started_at) >= ?")
        cycle_params.append(updated_since)
        pane_filters.append("coalesce(mc.completed_at, mc.started_at) >= ?")
        pane_params.append(updated_since)
    if active_only:
        active_filter = "mc.task_id in (select id from tasks where state in ('candidate', 'managed', 'paused'))"
        cycle_filters.append(active_filter)
        pane_filters.append(active_filter)
    cycle_where = " and ".join(cycle_filters)
    pane_where = " and ".join(pane_filters)
    failed_cycle_rows = conn.execute(
        f"""
        select mc.id, mc.task_id, t.name as task_name, mc.manager_id, mc.started_at,
               mc.completed_at, mc.state, mc.status_json, mc.health_json, mc.decision, mc.error
        from manager_cycles mc
        left join tasks t on t.id = mc.task_id
        where {cycle_where}
        order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
        limit ?
        """,
        [*cycle_params, limit],
    ).fetchall()
    pane_rows = conn.execute(
        f"""
        select mc.id, mc.task_id, t.name as task_name, mc.manager_id, mc.started_at,
               mc.completed_at, mc.state, mc.status_json, mc.health_json, mc.decision, mc.error
        from manager_cycles mc
        left join tasks t on t.id = mc.task_id
        where {pane_where}
        order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
        limit ?
        """,
        [*pane_params, limit],
    ).fetchall()
    failed_cycles = []
    for row in failed_cycle_rows:
        item = _cycle_view_from_row(row)
        item["task_name"] = row["task_name"]
        failed_cycles.append(item)
    pane_failures = []
    for row in pane_rows:
        item = _cycle_view_from_row(row)
        item["task_name"] = row["task_name"]
        pane_failures.append(item)
    failed_commands = _commands_view(
        conn,
        task_id=task_id,
        only_failed=True,
        limit=limit,
        updated_since=updated_since,
        active_only=active_only,
    )["recent"]
    ingest = _ingest_view(
        conn,
        task_id=task_id,
        run_id=run_id,
        limit=limit,
        updated_since=updated_since,
        active_only=active_only,
    )
    open_criteria = _open_criteria_failure_view(
        conn,
        task_id=task_id,
        active_only=active_only,
        limit=limit,
    )
    alerts: list[dict[str, Any]] = []
    if failed_cycles:
        alerts.append({"message": f"{len(failed_cycles)} manager cycles failed.", "severity": "error", "type": "failed_cycles"})
    if failed_commands:
        alerts.append({"message": f"{len(failed_commands)} commands failed.", "severity": "error", "type": "failed_commands"})
    if ingest["error_count"]:
        alerts.append({"message": f"{ingest['error_count']} ingest errors or warnings were recorded.", "severity": "error", "type": "ingest_errors"})
    if pane_failures:
        alerts.append({"message": f"{len(pane_failures)} pane captures failed.", "severity": "warning", "type": "pane_capture_failures"})
    if open_criteria["open_accepted_count"]:
        alerts.append({"message": f"{open_criteria['open_accepted_count']} open accepted criteria remain.", "severity": "warning", "type": "open_accepted_criteria"})
    return {
        "alerts": alerts,
        "failed_commands": failed_commands,
        "failed_cycles": failed_cycles,
        "filters": {
            "active_only": active_only,
            "run_id": run_id,
            "task_id": task_id,
            "window": window_info,
        },
        "ingest": ingest,
        "operator": {
            "checks": {
                "ok": not alerts,
                "thresholds": operator["checks"]["thresholds"],
            },
            "commands": _commands_view(
                conn,
                task_id=task_id,
                limit=limit,
                updated_since=updated_since,
                active_only=active_only,
            ),
            "cycles": {
                "recent_failed": failed_cycles,
                "recent_failed_count": len(failed_cycles),
                "stale": [] if (task_id is not None or active_only or updated_since is not None) else operator["cycles"]["stale"],
                "stale_count": 0 if (task_id is not None or active_only or updated_since is not None) else operator["cycles"]["stale_count"],
            },
            "sessions": operator["sessions"],
            "tasks": operator["tasks"],
        },
        "open_criteria": open_criteria,
        "pane_capture_failures": pane_failures,
        "schema_version": 1,
        "storage": _storage_counts(conn, task_id=task_id),
    }


def _database_file_size(conn: Any) -> int:
    row = conn.execute("pragma database_list").fetchone()
    if not row:
        return 0
    path = row["file"] if "file" in row.keys() else row[2]
    if not path:
        return 0
    db_path = Path(path)
    return db_path.stat().st_size if db_path.exists() else 0


def _active_task_summaries(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        select id, name, state, summary, created_at, updated_at
        from tasks
        where state in ('candidate', 'managed', 'paused')
        order by updated_at desc, name
        """
    ).fetchall()
    return [
        {
            "created_at": row["created_at"],
            "id": row["id"],
            "name": row["name"],
            "state": row["state"],
            "summary": row["summary"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def _active_session_summaries(conn: Any, *, worker_staleness_seconds: float) -> dict[str, Any]:
    sessions = []
    stale = []
    for row in conn.execute(
        """
        select id, name, role, pid, cwd, tmux_session, tmux_pane_id, last_heartbeat_at, registered_at
        from sessions
        where state = 'active'
        order by role, name
        """
    ):
        heartbeat_age = age_seconds(row["last_heartbeat_at"])
        item = {
            "cwd": row["cwd"],
            "heartbeat_age_seconds": heartbeat_age,
            "id": row["id"],
            "last_heartbeat_at": row["last_heartbeat_at"],
            "name": row["name"],
            "pid": row["pid"],
            "registered_at": row["registered_at"],
            "role": row["role"],
            "tmux_pane_id": row["tmux_pane_id"],
            "tmux_session": row["tmux_session"],
        }
        sessions.append(item)
        if heartbeat_age is not None and heartbeat_age > worker_staleness_seconds:
            stale.append(item)
    return {
        "active": sessions,
        "active_count": len(sessions),
        "stale": stale,
        "stale_count": len(stale),
    }


def _operator_commands_snapshot(conn: Any, *, limit: int) -> dict[str, Any]:
    counts = conn.execute(
        """
        select
          sum(case when state in ('pending', 'attempted') then 1 else 0 end) as unfinished_count,
          sum(case when state = 'failed' then 1 else 0 end) as failed_count
        from commands
        """
    ).fetchone()
    failed = conn.execute(
        """
        select c.id, c.task_id, t.name as task_name, c.type, c.state, c.created_at, c.updated_at,
               c.claimed_by, c.attempts, c.error
        from commands c
        left join tasks t on t.id = c.task_id
        where c.state = 'failed'
        order by c.updated_at desc, c.created_at desc
        limit ?
        """,
        (limit,),
    ).fetchall()
    unfinished = conn.execute(
        """
        select c.id, c.task_id, t.name as task_name, c.type, c.state, c.created_at, c.updated_at,
               c.claimed_by, c.attempts
        from commands c
        left join tasks t on t.id = c.task_id
        where c.state in ('pending', 'attempted')
        order by c.updated_at desc, c.created_at desc
        limit ?
        """,
        (limit,),
    ).fetchall()
    return {
        "failed_count": int(counts["failed_count"] or 0),
        "recent_failed": [dict(row) for row in failed],
        "recent_unfinished": [dict(row) for row in unfinished],
        "unfinished_count": int(counts["unfinished_count"] or 0),
    }


def _operator_cycles_snapshot(conn: Any, *, stale_cycles_seconds: float, limit: int) -> dict[str, Any]:
    report = collect_reconcile_report(conn, stale_cycles_seconds=stale_cycles_seconds)
    failed = conn.execute(
        """
        select mc.id, mc.task_id, t.name as task_name, mc.started_at, mc.completed_at,
               mc.state, mc.decision, mc.error
        from manager_cycles mc
        left join tasks t on t.id = mc.task_id
        where mc.state = 'failed'
        order by coalesce(mc.completed_at, mc.started_at) desc, mc.id desc
        limit ?
        """,
        (limit,),
    ).fetchall()
    return {
        "recent_failed": [dict(row) for row in failed],
        "recent_failed_count": len(failed),
        "stale": report["stuck_tasks"],
        "stale_count": len(report["stuck_tasks"]),
    }


def _operator_criteria_snapshot(conn: Any, *, limit: int) -> dict[str, Any]:
    rows = conn.execute(
        """
        select ac.id, ac.task_id, t.name as task_name, ac.status, ac.source, ac.created_at, ac.updated_at
        from acceptance_criteria ac
        left join tasks t on t.id = ac.task_id
        where ac.status = 'accepted'
        order by ac.updated_at desc, ac.id desc
        limit ?
        """,
        (limit,),
    ).fetchall()
    counts = conn.execute(
        """
        select status, count(*) as count
        from acceptance_criteria
        group by status
        """
    ).fetchall()
    by_status = {row["status"]: int(row["count"]) for row in counts}
    return {
        "by_status": by_status,
        "open_accepted": [dict(row) for row in rows],
        "open_accepted_count": int(by_status.get("accepted", 0)),
    }


def telemetry_operator_snapshot(
    conn: Any,
    *,
    stale_cycle_seconds: float = 3600.0,
    worker_staleness_seconds: float = 3600.0,
    max_unfinished_commands: int = 0,
    max_open_criteria: int = 0,
    max_storage_bytes: int | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    report = collect_reconcile_report(conn, stale_cycles_seconds=stale_cycle_seconds)
    tasks = _active_task_summaries(conn)
    sessions = _active_session_summaries(conn, worker_staleness_seconds=worker_staleness_seconds)
    cycles = _operator_cycles_snapshot(conn, stale_cycles_seconds=stale_cycle_seconds, limit=limit)
    commands = _operator_commands_snapshot(conn, limit=limit)
    criteria = _operator_criteria_snapshot(conn, limit=limit)
    database_bytes = _database_file_size(conn)
    storage = {
        "database_bytes": database_bytes,
        "total_bytes": database_bytes,
    }
    thresholds = {
        "max_open_criteria": max_open_criteria,
        "max_storage_bytes": max_storage_bytes,
        "max_unfinished_commands": max_unfinished_commands,
        "stale_cycle_seconds": stale_cycle_seconds,
        "worker_staleness_seconds": worker_staleness_seconds,
    }

    alerts: list[dict[str, Any]] = []
    if not report["schema_health"].get("ok"):
        alerts.append({"message": "Database schema health is not OK.", "severity": "error", "type": "schema_health"})
    if report["dead_pid_sessions"]:
        alerts.append({
            "message": f"{len(report['dead_pid_sessions'])} active sessions have dead or missing pids.",
            "severity": "error",
            "type": "dead_pid_sessions",
        })
    if report["dangling_bindings"]:
        alerts.append({
            "message": f"{len(report['dangling_bindings'])} bindings reference gone sessions.",
            "severity": "error",
            "type": "reconcile_drift",
        })
    if cycles["stale_count"]:
        alerts.append({
            "message": f"{cycles['stale_count']} active tasks have stale manager cycles.",
            "severity": "warning",
            "type": "stale_cycles",
        })
    if sessions["stale_count"]:
        alerts.append({
            "message": f"{sessions['stale_count']} active sessions have stale heartbeats.",
            "severity": "warning",
            "type": "stale_sessions",
        })
    if commands["unfinished_count"] > max_unfinished_commands:
        alerts.append({
            "message": f"{commands['unfinished_count']} unfinished commands exceeds threshold {max_unfinished_commands}.",
            "severity": "warning",
            "type": "unfinished_commands",
        })
    if criteria["open_accepted_count"] > max_open_criteria:
        alerts.append({
            "message": f"{criteria['open_accepted_count']} open accepted criteria exceeds threshold {max_open_criteria}.",
            "severity": "warning",
            "type": "open_accepted_criteria",
        })
    if max_storage_bytes is not None and storage["total_bytes"] > max_storage_bytes:
        alerts.append({
            "message": f"{storage['total_bytes']} storage bytes exceeds threshold {max_storage_bytes}.",
            "severity": "warning",
            "type": "storage_bytes",
        })
    if cycles["recent_failed"]:
        alerts.append({
            "message": f"{len(cycles['recent_failed'])} recent manager cycles failed.",
            "severity": "error",
            "type": "failed_cycles",
        })
    if commands["failed_count"]:
        alerts.append({
            "message": f"{commands['failed_count']} commands failed.",
            "severity": "error",
            "type": "failed_commands",
        })

    return {
        "alerts": alerts,
        "checks": {
            "ok": not alerts,
            "thresholds": thresholds,
        },
        "commands": commands,
        "criteria": criteria,
        "cycles": cycles,
        "reconcile": {
            "dangling_bindings": report["dangling_bindings"],
            "dead_pid_sessions": report["dead_pid_sessions"],
            "schema_health": report["schema_health"],
            "stuck_tasks": report["stuck_tasks"],
        },
        "sessions": {
            **sessions,
            "dead_pid_count": len(report["dead_pid_sessions"]),
            "dead_pid_sessions": report["dead_pid_sessions"],
        },
        "storage": storage,
        "tasks": {
            "active": tasks,
            "active_count": len(tasks),
        },
    }


_TELEMETRY_METRICS_WINDOW_RE = re.compile(r"^(?P<count>[1-9][0-9]*)(?P<unit>[smhdw])$")
_METRICS_CRITERIA_STATUSES = ("proposed", "accepted", "satisfied", "deferred", "rejected")
_METRICS_COMMAND_STATES = ("pending", "attempted", "succeeded", "failed")
_METRICS_ATTEMPT_STATES = ("running", "succeeded", "failed", "abandoned")


def _metrics_parse_window(window: str) -> tuple[int, str]:
    value = (window or "").strip().lower()
    match = _TELEMETRY_METRICS_WINDOW_RE.match(value)
    if not match:
        raise WorkerError("--window must be a positive duration like 30m, 24h, or 7d")
    count = int(match.group("count"))
    unit = match.group("unit")
    return count * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[unit], value


def _metrics_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _metrics_count_rows(rows: Any, *, keys: tuple[str, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for row in rows:
        cursor = result
        for key in keys[:-1]:
            label = row[key] or "unknown"
            cursor = cursor.setdefault(label, {})
        label = row[keys[-1]] or "unknown"
        cursor[label] = int(row["count"])
    return result


def _metrics_sum_row(row: Any, key: str) -> int:
    value = row[key] if row is not None else None
    return int(value or 0)


def _telemetry_metrics(
    conn: Any,
    *,
    db_path: Path,
    window: str,
    run_id: str | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    seconds, window_label = _metrics_parse_window(window)
    end = datetime.now(timezone.utc)
    start = end - timedelta(seconds=seconds)
    start_iso = _metrics_iso(start)
    end_iso = _metrics_iso(end)

    event_filters = ["timestamp >= ?", "timestamp <= ?"]
    event_params: list[Any] = [start_iso, end_iso]
    row_filters: list[str] = []
    row_params: list[Any] = []
    if run_id is not None:
        event_filters.append("run_id = ?")
        event_params.append(run_id)
    if task_id is not None:
        event_filters.append("task_id = ?")
        event_params.append(task_id)
        row_filters.append("task_id = ?")
        row_params.append(task_id)
    event_where = " and ".join(event_filters)
    row_where = (" and " + " and ".join(row_filters)) if row_filters else ""

    telemetry_rows = conn.execute(
        f"""
        select actor, event_type, severity, count(*) as count
        from telemetry_events
        where {event_where}
        group by actor, event_type, severity
        """,
        event_params,
    ).fetchall()
    telemetry_by_actor = _metrics_count_rows(
        conn.execute(f"select actor, count(*) as count from telemetry_events where {event_where} group by actor", event_params).fetchall(),
        keys=("actor",),
    )
    telemetry_by_event_type = _metrics_count_rows(
        conn.execute(f"select event_type, count(*) as count from telemetry_events where {event_where} group by event_type", event_params).fetchall(),
        keys=("event_type",),
    )
    telemetry_by_severity = _metrics_count_rows(
        conn.execute(f"select severity, count(*) as count from telemetry_events where {event_where} group by severity", event_params).fetchall(),
        keys=("severity",),
    )

    cycle_rows = conn.execute(
        f"""
        select state, count(*) as count
        from manager_cycles
        where started_at >= ? and started_at <= ?{row_where}
        group by state
        """,
        [start_iso, end_iso, *row_params],
    ).fetchall()
    cycles_by_state = {row["state"]: int(row["count"]) for row in cycle_rows}
    cycle_success = cycles_by_state.get("succeeded", 0)
    cycle_failure = cycles_by_state.get("failed", 0)
    cycle_finished = cycle_success + cycle_failure

    commands_by_type: dict[str, dict[str, Any]] = {}
    for row in conn.execute(
        f"""
        select type, state, count(*) as count
        from commands
        where created_at >= ? and created_at <= ?{row_where}
        group by type, state
        """,
        [start_iso, end_iso, *row_params],
    ).fetchall():
        bucket = commands_by_type.setdefault(row["type"], {state: 0 for state in _METRICS_COMMAND_STATES})
        bucket[row["state"]] = int(row["count"])

    command_attempts_by_type: dict[str, dict[str, Any]] = {}
    for row in conn.execute(
        f"""
        select commands.type, command_attempts.state, count(*) as count
        from command_attempts
        join commands on commands.id = command_attempts.command_id
        where command_attempts.started_at >= ? and command_attempts.started_at <= ?{row_where}
        group by commands.type, command_attempts.state
        """,
        [start_iso, end_iso, *row_params],
    ).fetchall():
        bucket = command_attempts_by_type.setdefault(row["type"], {state: 0 for state in _METRICS_ATTEMPT_STATES})
        bucket[row["state"]] = int(row["count"])

    ingest_row = conn.execute(
        f"""
        select
          sum(coalesce(json_extract(attributes_json, '$.new_events'), 0)) as new_events,
          sum(coalesce(json_extract(attributes_json, '$.skipped_lines'), 0)) as skipped_lines
        from telemetry_events
        where {event_where} and event_type = 'codex_events_ingested'
        """,
        event_params,
    ).fetchone()
    pane_capture = {"succeeded": 0, "failed": 0, "unknown": 0}
    for row in conn.execute(
        f"""
        select
          case json_extract(status_json, '$.pane_signal.captured')
            when 1 then 'succeeded'
            when 0 then 'failed'
            else 'unknown'
          end as state,
          count(*) as count
        from manager_cycles
        where started_at >= ? and started_at <= ?{row_where}
        group by state
        """,
        [start_iso, end_iso, *row_params],
    ).fetchall():
        pane_capture[row["state"]] = int(row["count"])

    criteria_clause = "where task_id = ?" if task_id is not None else ""
    criteria_params = [task_id] if task_id is not None else []
    criteria_counts = {status: 0 for status in _METRICS_CRITERIA_STATUSES}
    for row in conn.execute(
        f"select status, count(*) as count from acceptance_criteria {criteria_clause} group by status",
        criteria_params,
    ).fetchall():
        criteria_counts[row["status"]] = int(row["count"])

    storage_filters = "where task_id = ?" if task_id is not None else ""
    storage_params = [task_id] if task_id is not None else []
    terminal_bytes = _metrics_sum_row(conn.execute(f"select sum(byte_count) as bytes from terminal_captures {storage_filters}", storage_params).fetchone(), "bytes")
    segment_bytes = _metrics_sum_row(conn.execute(f"select sum(byte_count) as bytes from transcript_segments {storage_filters}", storage_params).fetchone(), "bytes")
    transcript_capture_sql = "select sum(byte_count) as bytes from transcript_captures"
    transcript_capture_params: list[Any] = []
    if task_id is not None:
        transcript_capture_sql = """
            select sum(transcript_captures.byte_count) as bytes
            from transcript_captures
            join bindings on bindings.worker_id = transcript_captures.worker_id
            where bindings.task_id = ?
        """
        transcript_capture_params.append(task_id)
    transcript_capture_bytes = _metrics_sum_row(conn.execute(transcript_capture_sql, transcript_capture_params).fetchone(), "bytes")

    try:
        database_file_bytes = db_path.stat().st_size
    except OSError:
        database_file_bytes = 0
    reconcile = collect_reconcile_report(conn)
    active_task_clause = "where state in ('candidate', 'managed', 'paused')"
    active_task_params: list[Any] = []
    if task_id is not None:
        active_task_clause += " and id = ?"
        active_task_params.append(task_id)
    active_tasks = int(conn.execute(f"select count(*) from tasks {active_task_clause}", active_task_params).fetchone()[0])
    active_sessions_by_role = {
        row["role"]: int(row["count"])
        for row in conn.execute("select role, count(*) as count from sessions where state = 'active' group by role").fetchall()
    }
    export_count = int(
        conn.execute(
            f"""
            select count(*)
            from telemetry_events
            where {event_where}
              and (event_type like 'export_%' or event_type like '%_exported')
            """,
            event_params,
        ).fetchone()[0]
    )

    return {
        "schema_version": 1,
        "generated_at": end_iso,
        "filters": {"run_id": run_id, "task_id": task_id},
        "window": {"end": end_iso, "label": window_label, "seconds": seconds, "start": start_iso},
        "counters": {
            "cycles": {
                "failed": cycle_failure,
                "started": cycles_by_state.get("started", 0),
                "succeeded": cycle_success,
                "total": sum(cycles_by_state.values()),
            },
            "exports": {"total": export_count},
            "ingest": {
                "new_events": _metrics_sum_row(ingest_row, "new_events"),
                "skipped_lines": _metrics_sum_row(ingest_row, "skipped_lines"),
            },
            "pane_capture": pane_capture,
            "telemetry_events": {
                "by_actor": telemetry_by_actor,
                "by_actor_event_type_severity": _metrics_count_rows(telemetry_rows, keys=("actor", "event_type", "severity")),
                "by_event_type": telemetry_by_event_type,
                "by_severity": telemetry_by_severity,
                "total": sum(telemetry_by_actor.values()),
            },
        },
        "gauges": {
            "active_sessions": {
                "by_role": {
                    "manager": active_sessions_by_role.get("manager", 0),
                    "worker": active_sessions_by_role.get("worker", 0),
                },
                "total": sum(active_sessions_by_role.values()),
            },
            "active_tasks": active_tasks,
            "criteria": {
                "by_status": criteria_counts,
                "open": criteria_counts["proposed"] + criteria_counts["accepted"],
                "total": sum(criteria_counts.values()),
            },
            "reconcile": {
                "dangling_bindings": len(reconcile["dangling_bindings"]),
                "dead_pid_sessions": len(reconcile["dead_pid_sessions"]),
                "stuck_tasks": len(reconcile["stuck_tasks"]),
                "total_drift": len(reconcile["dangling_bindings"]) + len(reconcile["dead_pid_sessions"]) + len(reconcile["stuck_tasks"]),
            },
            "storage_bytes": {
                "database_file": database_file_bytes,
                "terminal_captures": terminal_bytes,
                "transcript_captures": transcript_capture_bytes,
                "transcript_segments": segment_bytes,
                "total_retained": terminal_bytes + transcript_capture_bytes + segment_bytes,
            },
        },
        "rollups": {
            "command_attempts_by_type": command_attempts_by_type,
            "commands_by_type": commands_by_type,
            "cycle_success_rate": (cycle_success / cycle_finished) if cycle_finished else None,
        },
    }


def command_telemetry(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        if getattr(args, "view", None) == "metrics":
            run_id = db_run_row(conn, run=args.run)["id"] if args.run else None
            task_id = db_task_row(conn, task=args.task)["id"] if args.task else None
            result = _telemetry_metrics(
                conn,
                db_path=db_path or default_db_path(),
                window=args.window or "24h",
                run_id=run_id,
                task_id=task_id,
            )
            if args.json:
                print(json.dumps(result, indent=2, sort_keys=True))
            else:
                print(f"window: {result['window']['label']}")
                print(f"telemetry_events: {result['counters']['telemetry_events']['total']}")
                print(f"cycle_success_rate: {result['rollups']['cycle_success_rate']}")
                print(f"skipped_ingest_lines: {result['counters']['ingest']['skipped_lines']}")
            return 0
        if getattr(args, "view", None) == "snapshot":
            if args.task:
                result = telemetry_snapshot(conn, task=args.task, limit=args.limit)
            else:
                result = telemetry_operator_snapshot(
                    conn,
                    stale_cycle_seconds=args.stale_cycle_seconds,
                    worker_staleness_seconds=args.worker_staleness_seconds,
                    max_unfinished_commands=args.max_unfinished_commands,
                    max_open_criteria=args.max_open_criteria,
                    max_storage_bytes=args.max_storage_bytes,
                    limit=args.limit,
                )
            print(json.dumps(result, indent=2, sort_keys=True, default=str))
            return 0
        if getattr(args, "view", None) == "check":
            result = telemetry_operator_snapshot(
                conn,
                stale_cycle_seconds=args.stale_cycle_seconds,
                worker_staleness_seconds=args.worker_staleness_seconds,
                max_unfinished_commands=args.max_unfinished_commands,
                max_open_criteria=args.max_open_criteria,
                max_storage_bytes=args.max_storage_bytes,
                limit=args.limit,
            )
            if args.json:
                print(json.dumps(result, indent=2, sort_keys=True, default=str))
            else:
                status = "healthy" if result["checks"]["ok"] else "unhealthy"
                print(f"telemetry check: {status}")
                for alert in result["alerts"]:
                    print(f"{alert['severity']}: {alert['type']}: {alert['message']}")
            return 0 if result["checks"]["ok"] else 1
        if getattr(args, "view", None) == "task":
            task = args.view_task or args.task
            if not task:
                raise WorkerError("telemetry task requires a task name or ID")
            result = telemetry_task_view(
                conn,
                task=task,
                limit=args.limit,
                stale_cycle_seconds=args.stale_cycle_seconds,
            )
            if args.json:
                print(json.dumps(result, indent=2, sort_keys=True, default=str))
            else:
                print(f"task: {result['task']['name']}")
                print(f"worker_alive: {result['liveness']['worker_alive']}")
                print(f"manager_alive: {result['liveness']['manager_alive']}")
                print(f"cycles: {result['cycles']['counts_by_state']}")
                print(f"failed_commands: {len(result['failed_commands'])}")
                for alert in result["alerts"]:
                    print(f"{alert['severity']}: {alert['type']}: {alert['message']}")
            return 0
        if getattr(args, "view", None) == "failures":
            run_id = None
            task_id = db_task_row(conn, task=args.task)["id"] if args.task else None
            if args.run:
                run = db_run_row(conn, run=args.run)
                run_id = run["id"]
                if task_id is not None and task_id != run["task_id"]:
                    raise WorkerError("--run and --task refer to different tasks")
                task_id = run["task_id"]
            result = telemetry_failures_view(
                conn,
                limit=args.limit,
                stale_cycle_seconds=args.stale_cycle_seconds,
                task_id=task_id,
                run_id=run_id,
                active_only=args.active_only,
                window=args.window,
            )
            if args.json:
                print(json.dumps(result, indent=2, sort_keys=True, default=str))
            else:
                print(f"failed_cycles: {len(result['failed_cycles'])}")
                print(f"failed_commands: {len(result['failed_commands'])}")
                print(f"ingest_errors: {result['ingest']['error_count']}")
                print(f"pane_capture_failures: {len(result['pane_capture_failures'])}")
                for alert in result["alerts"]:
                    print(f"{alert['severity']}: {alert['type']}: {alert['message']}")
            return 0
        run_id = None
        task_id = None
        if args.run:
            run_id = db_run_row(conn, run=args.run)["id"]
        if args.task:
            task_id = db_task_row(conn, task=args.task)["id"]
        events = query_telemetry_events(
            conn,
            run_id=run_id,
            task_id=task_id,
            actor=args.actor,
            event_type=args.event_type,
            severity=args.severity,
            search=args.search,
            limit=args.limit,
            newest=getattr(args, "newest", False),
        )
    if args.summary:
        result = telemetry_summary(events)
        if args.json:
            print(json.dumps(result, indent=2, sort_keys=True))
        else:
            print(f"total: {result['total']}")
            print(f"first_timestamp: {result['first_timestamp']}")
            print(f"last_timestamp: {result['last_timestamp']}")
            for label in ("by_actor", "by_event_type", "by_severity"):
                print(f"{label}:")
                for key, value in sorted(result[label].items()):
                    print(f"  {key}: {value}")
        return 0
    if args.json:
        print(json.dumps(events, indent=2, sort_keys=True))
        return 0
    for event in events:
        print(
            f"{event['timestamp']} {event['actor']} {event['event_type']} "
            f"[{event['severity']}] {event['summary']}"
        )
    return 0


def _acceptance_criteria_summary(criteria: list[dict[str, Any]]) -> dict[str, int]:
    summary = {status: 0 for status in ("proposed", "accepted", "satisfied", "deferred", "rejected")}
    for criterion in criteria:
        summary[criterion["status"]] += 1
    return summary


def _acceptance_criteria_response(
    conn: Any,
    *,
    task: Any,
    statuses: list[str] | None = None,
    affected_criterion: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from workerctl import db as worker_db

    all_criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
    criteria = (
        worker_db.acceptance_criteria_for_task(conn, task_id=task["id"], statuses=statuses)
        if statuses is not None
        else all_criteria
    )
    response = {
        "task": {"id": task["id"], "name": task["name"]},
        "criteria": criteria,
        "summary": _acceptance_criteria_summary(all_criteria),
    }
    if affected_criterion is not None:
        response["affected_criterion"] = affected_criterion
    return response


def _begin_criteria_mutation(conn: Any) -> None:
    conn.execute("BEGIN IMMEDIATE")


def _acceptance_criterion_event_payload(
    *,
    criterion: dict[str, Any],
    task_id: str,
    previous: dict[str, Any] | None = None,
    created: bool | None = None,
) -> dict[str, Any]:
    payload = {
        "criterion_id": criterion["id"],
        "criterion": criterion["criterion"],
        "status": criterion["status"],
        "source": criterion["source"],
        "proof": criterion["proof"],
        "rationale": criterion["rationale"],
        "evidence": criterion["evidence"],
        "task_id": task_id,
    }
    if created is not None:
        payload["created"] = created
    if previous is not None:
        payload.update(
            {
                "previous_status": previous["status"],
                "previous_proof": previous["proof"],
                "previous_rationale": previous["rationale"],
                "previous_evidence": previous["evidence"],
            }
        )
    return payload


def command_criteria(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    evidence = _json_arg(args.evidence_json, flag="--evidence-json")
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        if args.add:
            if not args.criterion:
                raise WorkerError("--criterion is required with criteria --add")
            if not args.source:
                raise WorkerError("--source is required with criteria --add")
            if len(args.status) > 1:
                raise WorkerError("criteria --add accepts at most one --status")
            _begin_criteria_mutation(conn)
            existing_criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
            existing = next(
                (
                    row
                    for row in existing_criteria
                    if row["source"] == args.source and row["criterion"] == args.criterion
                ),
                None,
            )
            criterion_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id=task["id"],
                criterion=args.criterion,
                status=args.status[0] if args.status else "proposed",
                source=args.source,
                proof=args.proof,
                rationale=args.rationale,
                evidence=evidence,
            )
            criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
            criterion = next(row for row in criteria if row["id"] == criterion_id)
            if existing is None:
                worker_db.insert_event(
                    conn,
                    "acceptance_criterion_added",
                    actor="workerctl",
                    task_id=task["id"],
                    payload=_acceptance_criterion_event_payload(
                        criterion=criterion,
                        task_id=task["id"],
                        created=True,
                    ),
            )
            result = _acceptance_criteria_response(conn, task=task, affected_criterion=criterion)
            conn.commit()
        elif args.list:
            result = _acceptance_criteria_response(conn, task=task, statuses=args.status or None)
        else:
            if args.status:
                raise WorkerError("--status is only supported with criteria --list or --add")
            action_status = {
                "accept": "accepted",
                "satisfy": "satisfied",
                "defer": "deferred",
                "reject": "rejected",
            }
            action_name = next(name for name in action_status if getattr(args, name) is not None)
            criterion_id = getattr(args, action_name)
            _begin_criteria_mutation(conn)
            task_criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task["id"])
            existing = next((row for row in task_criteria if row["id"] == criterion_id), None)
            if existing is None:
                raise WorkerError(f"Unknown acceptance criterion for task {task['name']}: {criterion_id}")
            update_kwargs: dict[str, Any] = {}
            if args.evidence_json is not None:
                update_kwargs["evidence"] = evidence
            if args.proof is not None:
                update_kwargs["proof"] = args.proof
            if args.rationale is not None:
                update_kwargs["rationale"] = args.rationale
            criterion = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=criterion_id,
                status=action_status[action_name],
                **update_kwargs,
            )
            worker_db.insert_event(
                conn,
                "acceptance_criterion_updated",
                actor="workerctl",
                task_id=task["id"],
                payload=_acceptance_criterion_event_payload(
                    criterion=criterion,
                    task_id=task["id"],
                    previous=existing,
                ),
            )
            result = _acceptance_criteria_response(conn, task=task, affected_criterion=criterion)
            conn.commit()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def _criteria_plan_input(args: argparse.Namespace) -> str:
    if args.from_text is not None:
        return args.from_text
    if args.from_worker_response is not None:
        return Path(args.from_worker_response).expanduser().read_text()
    if args.from_stdin:
        return sys.stdin.read()
    raise WorkerError("One of --from-text, --from-worker-response, or --from-stdin is required.")


def _shell_join(argv: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in argv)


def command_criteria_plan(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)

    result = plan_criteria_commands(task["name"], _criteria_plan_input(args), path=str(db_path) if db_path else None)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    print(f"Suggested criteria commands for {task['name']}")
    print("")
    accepted = [item for item in result["suggestions"] if item["status"] == "accepted"]
    deferred = [item for item in result["suggestions"] if item["status"] == "deferred"]
    print("Accepted current-task criteria:")
    if accepted:
        for index, item in enumerate(accepted, start=1):
            print(f"{index}. {_shell_join(item['command'])}")
    else:
        print("None.")
    print("")
    print("Deferred follow-up criteria:")
    if deferred:
        for index, item in enumerate(deferred, start=1):
            print(f"{index}. {_shell_join(item['command'])}")
    else:
        print("None.")
    if result["warnings"]:
        print("")
        print("Warnings:")
        for warning in result["warnings"]:
            print(f"- {warning}")
    print("")
    print("Review these commands before running them.")
    return 0


def command_handoff(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    payload = _json_arg(args.payload_json, flag="--payload-json")
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        worker_session_id = None
        try:
            binding = worker_db.active_binding_for_task(conn, task_name=task["name"])
            worker_session_id = binding["worker_session_id"]
        except WorkerError:
            worker_session_id = None
        handoff_id = worker_db.insert_worker_handoff(
            conn,
            task_id=task["id"],
            worker_session_id=worker_session_id,
            summary=args.summary,
            next_steps=args.next_step,
            payload=payload,
        )
        worker_db.insert_event(
            conn,
            "worker_handoff_recorded",
            actor="workerctl",
            task_id=task["id"],
            payload={
                "handoff_id": handoff_id,
                "next_step_count": len(args.next_step),
                "worker_session_id": worker_session_id,
            },
        )
        conn.commit()
        handoff = worker_db.latest_worker_handoff(conn, task_id=task["id"])
    print(json.dumps(handoff, indent=2, sort_keys=True))
    return 0


def _ack_payload_from_args(args: argparse.Namespace) -> dict[str, Any] | None:
    if getattr(args, "from_stdin", False):
        try:
            payload = json.loads(sys.stdin.read())
        except json.JSONDecodeError as exc:
            raise WorkerError(f"--from-stdin requires a JSON object: {exc}") from exc
        if not isinstance(payload, dict):
            raise WorkerError("--from-stdin requires a JSON object")
        return payload
    return None


def command_task_ack(args: argparse.Namespace, *, role: str) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        if getattr(args, "json", False) and not getattr(args, "from_stdin", False):
            ack = worker_db.latest_task_acknowledgement(conn, task_id=task["id"], role=role)
            print(json.dumps(ack, indent=2, sort_keys=True))
            return 0
        payload = _ack_payload_from_args(args)
        if payload is None:
            raise WorkerError(f"{role}-ack requires --from-stdin to write or --json to read")
        binding_id = None
        try:
            binding = worker_db.active_binding_for_task(conn, task_name=task["name"])
            binding_id = binding["binding_id"]
        except WorkerError:
            binding_id = None
        ack_id = worker_db.insert_task_acknowledgement(
            conn,
            task_id=task["id"],
            binding_id=binding_id,
            role=role,
            payload=payload,
            correlation_id=getattr(args, "correlation_id", None),
        )
        worker_db.insert_event(
            conn,
            f"{role}_ack_recorded",
            actor=role,
            task_id=task["id"],
            correlation_id=getattr(args, "correlation_id", None),
            payload={
                "ack_id": ack_id,
                "binding_id": binding_id,
                "payload_keys": sorted(payload),
                "role": role,
            },
        )
        conn.commit()
        ack = worker_db.latest_task_acknowledgement(conn, task_id=task["id"], role=role)
    print(json.dumps(ack, indent=2, sort_keys=True))
    return 0


def command_worker_ack(args: argparse.Namespace) -> int:
    return command_task_ack(args, role="worker")


def command_manager_ack(args: argparse.Namespace) -> int:
    return command_task_ack(args, role="manager")


def _continuation_payload_from_stdin(args: argparse.Namespace) -> dict[str, Any]:
    if not getattr(args, "from_stdin", False):
        raise WorkerError("continuation requires --from-stdin for --submit or --review")
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        raise WorkerError(f"--from-stdin requires a JSON object: {exc}") from exc
    if not isinstance(payload, dict):
        raise WorkerError("--from-stdin requires a JSON object")
    return payload


def _redact_continuation_payloads(
    rows: list[dict[str, Any]],
    *,
    as_role: str,
    include_payload: bool,
    correlation_id: str | None,
) -> list[dict[str, Any]]:
    manager_proposals = {
        row["correlation_id"]
        for row in rows
        if row["proposer"] == "manager"
    }
    redacted = []
    for row in rows:
        item = dict(row)
        may_include = include_payload
        if (
            include_payload
            and as_role == "manager"
            and row["proposer"] == "worker"
            and row["correlation_id"] not in manager_proposals
        ):
            if correlation_id:
                raise WorkerError("manager cannot read worker continuation payload before submitting manager continuation")
            may_include = False
        if not may_include:
            item.pop("payload", None)
            item["payload_redacted"] = True
        redacted.append(item)
    return redacted


def _continuation_pair(conn, *, task_id: str, correlation_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    from workerctl import db as worker_db

    worker = worker_db.latest_task_continuation(conn, task_id=task_id, proposer="worker", correlation_id=correlation_id)
    manager = worker_db.latest_task_continuation(conn, task_id=task_id, proposer="manager", correlation_id=correlation_id)
    if worker is None or manager is None:
        missing = []
        if worker is None:
            missing.append("worker")
        if manager is None:
            missing.append("manager")
        raise WorkerError(f"continuation review requires {', '.join(missing)} proposal(s) for correlation_id {correlation_id}")
    return worker, manager


def _review_payload_from_args(args: argparse.Namespace) -> dict[str, Any]:
    payload = _continuation_payload_from_stdin(args)
    return _validate_continuation_review_payload(payload)


def _validate_continuation_review_payload(payload: dict[str, Any]) -> dict[str, Any]:
    required = {"agreement", "verdict", "rationale", "subagent_run"}
    missing = sorted(required - set(payload))
    if missing:
        raise WorkerError(f"continuation review payload missing required field(s): {', '.join(missing)}")
    if not isinstance(payload["subagent_run"], dict):
        raise WorkerError("continuation review subagent_run must be a JSON object")
    if payload["agreement"] not in {"match", "compatible", "divergent"}:
        raise WorkerError("continuation review agreement must be match, compatible, or divergent")
    if payload["verdict"] not in {"proceed", "amend", "stop"}:
        raise WorkerError("continuation review verdict must be proceed, amend, or stop")
    subagent_run = dict(payload["subagent_run"])
    reviewer_session = subagent_run.get("reviewer_session_id")
    manager_session = subagent_run.get("manager_session_id")
    if not reviewer_session:
        raise WorkerError("continuation review requires subagent_run.reviewer_session_id")
    if not manager_session:
        raise WorkerError("continuation review requires subagent_run.manager_session_id")
    if reviewer_session == manager_session:
        raise WorkerError("reviewer subagent session must be distinct from manager session")
    if subagent_run.get("manager_rollout_access") is not False:
        raise WorkerError("reviewer subagent must record manager_rollout_access=false")
    payload["subagent_run"] = subagent_run
    return payload


def _record_continuation_review(
    conn,
    *,
    worker_db,
    task: dict[str, Any],
    config: dict[str, Any] | None,
    correlation_id: str,
    worker: dict[str, Any],
    manager: dict[str, Any],
    payload: dict[str, Any],
) -> dict[str, Any]:
    agreement = payload["agreement"]
    verdict = payload["verdict"]
    nudge_mode = clean_nudge_on_completion((config or {}).get("nudge_on_completion") if config else None)
    payload_subagent_run = payload["subagent_run"]
    reviewer_failed = verdict == "stop" and payload_subagent_run.get("status") == "failed"
    operator_routing_required = reviewer_failed or (agreement == "divergent" and nudge_mode != "auto-proceed")
    subagent_run = {
        **payload_subagent_run,
        "operator_routing_required": operator_routing_required,
        "nudge_on_completion": nudge_mode,
    }
    review_id = worker_db.insert_continuation_review(
        conn,
        task_id=task["id"],
        worker_continuation_id=worker["id"],
        manager_continuation_id=manager["id"],
        agreement=agreement,
        verdict=verdict,
        addendum=payload.get("addendum"),
        rationale=payload["rationale"],
        subagent_run=subagent_run,
        correlation_id=correlation_id,
    )
    worker_db.insert_event(
        conn,
        "continuation_review_recorded",
        actor="workerctl",
        task_id=task["id"],
        correlation_id=correlation_id,
        payload={
            "agreement": agreement,
            "manager_continuation_id": manager["id"],
            "operator_routing_required": operator_routing_required,
            "review_id": review_id,
            "verdict": verdict,
            "worker_continuation_id": worker["id"],
        },
    )
    worker_db.emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="continuation_review_recorded",
        severity="warning" if verdict == "stop" or operator_routing_required else "info",
        task_id=task["id"],
        summary=f"Continuation review recorded with verdict {verdict}.",
        correlation={
            "correlation_id": correlation_id,
            "manager_continuation_id": manager["id"],
            "review_id": review_id,
            "worker_continuation_id": worker["id"],
        },
        attributes={
            "agreement": agreement,
            "allowed_context": sorted(str(item) for item in subagent_run.get("allowed_context", [])),
            "has_addendum": bool(payload.get("addendum")),
            "has_rationale": bool(payload.get("rationale")),
            "manager_rollout_access": subagent_run.get("manager_rollout_access"),
            "manager_session_id": subagent_run.get("manager_session_id"),
            "nudge_on_completion": nudge_mode,
            "operator_routing_required": operator_routing_required,
            "payload_redacted": True,
            "reviewer_failure_routing_forced": reviewer_failed,
            "reviewer_duration_ms": subagent_run.get("duration_ms"),
            "reviewer_returncode": subagent_run.get("returncode"),
            "reviewer_session_distinct": subagent_run.get("reviewer_session_id") != subagent_run.get("manager_session_id"),
            "reviewer_session_id": subagent_run.get("reviewer_session_id"),
            "reviewer_status": subagent_run.get("status"),
            "verdict": verdict,
        },
    )
    conn.commit()
    output = worker_db.continuation_reviews(conn, task_id=task["id"])[-1]
    output["operator_routing_required"] = operator_routing_required
    return output


def _git_context() -> dict[str, Any]:
    result = {
        "branch_diff_name_only": "",
        "branch_diff_stat": "",
        "error": None,
        "working_tree_diff_name_only": "",
        "working_tree_diff_stat": "",
    }
    try:
        stat = subprocess.run(
            ["git", "diff", "--stat", "main...HEAD"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        names = subprocess.run(
            ["git", "diff", "--name-only", "main...HEAD"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        work_stat = subprocess.run(
            ["git", "diff", "--stat", "HEAD"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        work_names = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        result["error"] = str(exc)
        return result
    result["branch_diff_stat"] = stat.stdout[-5000:] if stat.returncode == 0 else ""
    result["branch_diff_name_only"] = names.stdout[-5000:] if names.returncode == 0 else ""
    result["working_tree_diff_stat"] = work_stat.stdout[-5000:] if work_stat.returncode == 0 else ""
    result["working_tree_diff_name_only"] = work_names.stdout[-5000:] if work_names.returncode == 0 else ""
    if stat.returncode != 0 or names.returncode != 0 or work_stat.returncode != 0 or work_names.returncode != 0:
        result["error"] = (stat.stderr or names.stderr or work_stat.stderr or work_names.stderr or "git diff failed")[-1000:]
    return result


def _recent_pr_context(limit: int = 5) -> list[dict[str, Any]]:
    gh = shutil.which("gh")
    if gh is None:
        return []
    try:
        proc = subprocess.run(
            [
                gh,
                "pr",
                "list",
                "--state",
                "all",
                "--limit",
                str(limit),
                "--json",
                "number,title,state,mergedAt,url",
            ],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _continuation_reviewer_context(
    conn,
    *,
    worker_db,
    task: dict[str, Any],
    config: dict[str, Any] | None,
    worker: dict[str, Any],
    manager: dict[str, Any],
    correlation_id: str,
) -> dict[str, Any]:
    return {
        "allowed_context": [
            "task",
            "correlation_id",
            "worker_continuation",
            "manager_continuation",
            "acceptance_criteria",
            "manager_config_summary",
            "diff",
            "recent_pull_requests",
            "constraints",
        ],
        "acceptance_criteria": worker_db.acceptance_criteria_for_task(conn, task_id=task["id"]),
        "constraints": {
            "manager_rollout_access": False,
            "read_only": True,
            "return_json_schema": {
                "agreement": "match | compatible | divergent",
                "verdict": "proceed | amend | stop",
                "addendum": "optional string",
                "rationale": "string",
            },
        },
        "correlation_id": correlation_id,
        "diff": _git_context(),
        "manager_config_summary": {
            "acceptance_criteria": (config or {}).get("acceptance_criteria") or [],
            "epilogues": (config or {}).get("epilogues") or [],
            "nudge_on_completion": (config or {}).get("nudge_on_completion") if config else None,
            "permissions": (config or {}).get("permissions") or {},
            "tools": (config or {}).get("tools") or [],
        },
        "manager_continuation": {
            "created_at": manager["created_at"],
            "id": manager["id"],
            "payload": manager["payload"],
            "revision": manager["revision"],
        },
        "recent_pull_requests": _recent_pr_context(),
        "task": {
            "goal": task["goal"],
            "id": task["id"],
            "name": task["name"],
            "state": task["state"],
        },
        "worker_continuation": {
            "created_at": worker["created_at"],
            "id": worker["id"],
            "payload": worker["payload"],
            "revision": worker["revision"],
        },
    }


def _sandbox_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _real_path_label(path: Path, *, force_dir: bool = False) -> tuple[str, bool]:
    resolved = os.path.realpath(str(path.expanduser()))
    return resolved, force_dir or Path(resolved).is_dir()


def _continuation_reviewer_denied_paths(
    conn,
    *,
    worker_db,
    task: dict[str, Any],
    db_path: Path | None,
) -> list[tuple[str, bool]]:
    binding = worker_db.active_binding_for_task(conn, task_name=task["name"])
    denied: list[Path] = []
    for key in ("worker_session_id", "manager_session_id"):
        session = worker_db.session_by_id(conn, session_id=binding[key])
        if session is not None and session["codex_session_path"]:
            denied.append(Path(str(session["codex_session_path"])))
    active_db_path = db_path if db_path is not None else worker_db.default_db_path()
    denied.extend([active_db_path, Path(f"{active_db_path}-wal"), Path(f"{active_db_path}-shm")])

    resolved: list[tuple[str, bool]] = []
    seen: set[str] = set()
    for path in denied:
        label, is_dir = _real_path_label(path)
        if label not in seen:
            seen.add(label)
            resolved.append((label, is_dir))
    state_label, state_is_dir = _real_path_label(state_root(), force_dir=True)
    if state_label not in seen:
        resolved.append((state_label, state_is_dir))
    return resolved


def _continuation_reviewer_sandbox_profile(denied_paths: list[tuple[str, bool]]) -> str:
    lines = ["(version 1)", "(allow default)"]
    for path, is_dir in denied_paths:
        rule = "subpath" if is_dir else "literal"
        lines.append(f'(deny file-read* ({rule} "{_sandbox_string(path)}"))')
    return "\n".join(lines) + "\n"


def _continuation_reviewer_env() -> dict[str, str]:
    allowed = {"LANG", "LC_ALL", "LC_CTYPE", "PATH", "TMPDIR", "PYTHONIOENCODING"}
    return {key: value for key, value in os.environ.items() if key in allowed}


def _reviewer_runner_label(reviewer_command: list[str]) -> str:
    if not reviewer_command:
        return ""
    return sh_quote(reviewer_command[0])


def _run_continuation_reviewer_command(
    *,
    reviewer_command: list[str],
    context: dict[str, Any],
    timeout: float,
    denied_paths: list[tuple[str, bool]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    started = time.monotonic()
    sandbox_exec = shutil.which("sandbox-exec")
    sandbox = {
        "denied_path_count": len(denied_paths),
        "enabled": False,
        "engine": "sandbox-exec",
        "profile": "deny-state-root-bound-session-and-db-read",
    }
    if sandbox_exec is None:
        sandbox["setup_error"] = "sandbox-exec not available"
        return (
            {
                "duration_ms": int((time.monotonic() - started) * 1000),
                "error": "sandbox-exec not available",
                "returncode": None,
                "stderr": "",
                "stdout": "",
            },
            sandbox,
        )

    try:
        with tempfile.TemporaryDirectory(prefix="workerctl-reviewer-") as tmpdir:
            sandbox_profile = Path(tmpdir) / "reviewer.sb"
            sandbox_profile.write_text(_continuation_reviewer_sandbox_profile(denied_paths), encoding="utf-8")
            proc = subprocess.run(
                [sandbox_exec, "-f", str(sandbox_profile), *reviewer_command],
                cwd=tmpdir,
                env=_continuation_reviewer_env(),
                input=json.dumps(context, sort_keys=True),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            sandbox["enabled"] = True
            return (
                {
                    "duration_ms": int((time.monotonic() - started) * 1000),
                    "error": None if proc.returncode == 0 else f"reviewer command exited {proc.returncode}",
                    "returncode": proc.returncode,
                    "stderr": proc.stderr[-2000:],
                    "stdout": proc.stdout[-10000:],
                },
                sandbox,
            )
    except FileNotFoundError as exc:
        sandbox["setup_error"] = str(exc)
        command_result = {
            "duration_ms": int((time.monotonic() - started) * 1000),
            "error": str(exc),
            "returncode": None,
            "stderr": "",
            "stdout": "",
        }
    except subprocess.TimeoutExpired as exc:
        sandbox["enabled"] = True
        command_result = {
            "duration_ms": int((time.monotonic() - started) * 1000),
            "error": f"reviewer command timed out after {timeout:g}s",
            "returncode": None,
            "stderr": (exc.stderr or "")[-2000:] if isinstance(exc.stderr, str) else "",
            "stdout": (exc.stdout or "")[-10000:] if isinstance(exc.stdout, str) else "",
        }
    except OSError as exc:
        sandbox["setup_error"] = str(exc)
        command_result = {
            "duration_ms": int((time.monotonic() - started) * 1000),
            "error": str(exc),
            "returncode": None,
            "stderr": "",
            "stdout": "",
        }
    return command_result, sandbox


def _reviewer_failure_payload(
    *,
    command_result: dict[str, Any],
    manager_session_id: str,
    reviewer_session_id: str,
    runner: str,
    sandbox: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error = command_result.get("error") or "reviewer command did not return a valid review"
    return {
        "agreement": "divergent",
        "verdict": "stop",
        "addendum": "Reviewer automation failed; do not proceed without operator review.",
        "rationale": error,
        "subagent_run": {
            "duration_ms": command_result.get("duration_ms"),
            "error": error,
            "manager_rollout_access": False,
            "manager_session_id": manager_session_id,
            "returncode": command_result.get("returncode"),
            "reviewer_session_id": reviewer_session_id,
            "runner": runner,
            "runner_arg_count": command_result.get("runner_arg_count"),
            "sandbox": sandbox or {},
            "status": "failed",
            "stderr_redacted": bool(command_result.get("stderr")),
            "stdout_redacted": bool(command_result.get("stdout")),
        },
    }


def command_continuation_reviewer(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    if args.reviewer_session_id == args.manager_session_id:
        raise WorkerError("reviewer subagent session must be distinct from manager session")
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        config = worker_db.manager_config(conn, task_id=task["id"])
        if not manager_permission_allowed(config, "context.spawn_reviewer"):
            raise WorkerError("continuation reviewer requires manager permission context.spawn_reviewer")
        worker, manager = _continuation_pair(conn, task_id=task["id"], correlation_id=args.correlation_id)
        context = _continuation_reviewer_context(
            conn,
            worker_db=worker_db,
            task=task,
            config=config,
            worker=worker,
            manager=manager,
            correlation_id=args.correlation_id,
        )
        if getattr(args, "dry_run", False):
            print(json.dumps({"context": context, "reviewer_command": args.reviewer_command}, indent=2, sort_keys=True))
            return 0
        reviewer_command = list(args.reviewer_command or [])
        if reviewer_command and reviewer_command[0] == "--":
            reviewer_command = reviewer_command[1:]
        if not reviewer_command:
            raise WorkerError("continuation-reviewer requires --reviewer-command unless --dry-run is used")
        runner = _reviewer_runner_label(reviewer_command)
        try:
            denied_paths = _continuation_reviewer_denied_paths(conn, worker_db=worker_db, task=task, db_path=db_path)
            command_result, sandbox = _run_continuation_reviewer_command(
                reviewer_command=reviewer_command,
                context=context,
                timeout=args.timeout,
                denied_paths=denied_paths,
            )
        except WorkerError as exc:
            sandbox = {
                "denied_path_count": 0,
                "enabled": False,
                "engine": "sandbox-exec",
                "profile": "deny-state-root-bound-session-and-db-read",
                "setup_error": str(exc),
            }
            command_result = {
                "duration_ms": 0,
                "error": str(exc),
                "returncode": None,
                "stderr": "",
                "stdout": "",
            }
        command_result["runner_arg_count"] = len(reviewer_command)
        if command_result["error"] is None:
            try:
                raw_payload = json.loads(command_result["stdout"])
                if not isinstance(raw_payload, dict):
                    raise ValueError("reviewer output must be a JSON object")
                raw_payload["subagent_run"] = {
                    **(raw_payload.get("subagent_run") if isinstance(raw_payload.get("subagent_run"), dict) else {}),
                    "allowed_context": context["allowed_context"],
                    "duration_ms": command_result["duration_ms"],
                    "manager_rollout_access": False,
                    "manager_session_id": args.manager_session_id,
                    "returncode": command_result["returncode"],
                    "reviewer_session_id": args.reviewer_session_id,
                    "runner": runner,
                    "runner_arg_count": len(reviewer_command),
                    "sandbox": sandbox,
                    "status": "succeeded",
                }
                payload = _validate_continuation_review_payload(raw_payload)
            except (json.JSONDecodeError, ValueError, WorkerError) as exc:
                command_result["error"] = str(exc)
                payload = _validate_continuation_review_payload(
                    _reviewer_failure_payload(
                        command_result=command_result,
                        manager_session_id=args.manager_session_id,
                        reviewer_session_id=args.reviewer_session_id,
                        runner=runner,
                        sandbox=sandbox,
                    )
                )
        else:
            payload = _validate_continuation_review_payload(
                _reviewer_failure_payload(
                    command_result=command_result,
                    manager_session_id=args.manager_session_id,
                    reviewer_session_id=args.reviewer_session_id,
                    runner=runner,
                    sandbox=sandbox,
                )
            )
        output = _record_continuation_review(
            conn,
            worker_db=worker_db,
            task=task,
            config=config,
            correlation_id=args.correlation_id,
            worker=worker,
            manager=manager,
            payload=payload,
        )
        print(json.dumps(output, indent=2, sort_keys=True))
        return 0


def command_continuation(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    operations = [
        bool(getattr(args, "submit", None)),
        bool(getattr(args, "review", False)),
        bool(getattr(args, "list", False)),
    ]
    if sum(1 for enabled in operations if enabled) != 1:
        raise WorkerError("continuation requires exactly one of --submit, --review, or --list")
    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        config = worker_db.manager_config(conn, task_id=task["id"])
        if getattr(args, "list", False):
            rows = worker_db.task_continuations(conn, task_id=task["id"], correlation_id=getattr(args, "correlation_id", None))
            output = {
                "continuations": _redact_continuation_payloads(
                    rows,
                    as_role=getattr(args, "as_role", "all"),
                    include_payload=bool(getattr(args, "include_payload", False)),
                    correlation_id=getattr(args, "correlation_id", None),
                ),
                "reviews": worker_db.continuation_reviews(conn, task_id=task["id"]),
                "task": {"id": task["id"], "name": task["name"]},
            }
            print(json.dumps(output, indent=2, sort_keys=True))
            return 0

        if getattr(args, "submit", None):
            proposer = args.submit
            payload = _continuation_payload_from_stdin(args)
            if proposer == "worker":
                correlation_id = getattr(args, "correlation_id", None) or f"continuation-{uuid.uuid4()}"
            else:
                correlation_id = getattr(args, "correlation_id", None)
                if not correlation_id:
                    raise WorkerError("manager continuation requires --correlation-id from the worker proposal turn")
                if worker_db.latest_task_continuation(conn, task_id=task["id"], proposer="worker", correlation_id=correlation_id) is None:
                    raise WorkerError("manager continuation requires an existing worker continuation for the same correlation_id")
            continuation_id = worker_db.insert_task_continuation(
                conn,
                task_id=task["id"],
                proposer=proposer,
                payload=payload,
                correlation_id=correlation_id,
            )
            worker_db.insert_event(
                conn,
                "task_continuation_recorded",
                actor=proposer,
                task_id=task["id"],
                correlation_id=correlation_id,
                payload={
                    "continuation_id": continuation_id,
                    "payload_keys": sorted(payload),
                    "proposer": proposer,
                },
            )
            conn.commit()
            row = worker_db.latest_task_continuation(conn, task_id=task["id"], proposer=proposer, correlation_id=correlation_id)
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0

        correlation_id = getattr(args, "correlation_id", None)
        if not correlation_id:
            raise WorkerError("continuation --review requires --correlation-id")
        if not manager_permission_allowed(config, "context.spawn_reviewer"):
            raise WorkerError("continuation review requires manager permission context.spawn_reviewer")
        worker, manager = _continuation_pair(conn, task_id=task["id"], correlation_id=correlation_id)
        payload = _review_payload_from_args(args)
        output = _record_continuation_review(
            conn,
            worker_db=worker_db,
            task=task,
            config=config,
            correlation_id=correlation_id,
            worker=worker,
            manager=manager,
            payload=payload,
        )
        print(json.dumps(output, indent=2, sort_keys=True))
        return 0


def _dispatch_completion_message(*, worker_name: str, task_name: str) -> str:
    return (
        f"Worker {worker_name} appears to have completed a turn for task {task_name}. "
        "Run/inspect workerctl cycle, review evidence and acceptance criteria, then decide "
        "whether to finish, request fixes, or continue observing."
    )


def _dispatch_command_types(dispatch_type: str | None) -> list[str]:
    if dispatch_type == "worker_task_complete":
        return []
    if dispatch_type in {"notify_manager", "nudge_worker"}:
        return [dispatch_type]
    return ["notify_manager", "nudge_worker"]


def _print_enqueue_result(args: argparse.Namespace, result: dict[str, Any]) -> None:
    if getattr(args, "json", False):
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"queued {result['command_type']} command {result['command_id']}")


def command_enqueue_notify_manager(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        command_id = worker_db.enqueue_notify_manager(
            conn,
            task_id=task["id"],
            message=args.message,
            required_permission=getattr(args, "required_permission", None),
            idempotency_key=getattr(args, "idempotency_key", None),
            correlation_id=getattr(args, "correlation_id", None),
        )
        command = conn.execute("select correlation_id from commands where id = ?", (command_id,)).fetchone()
        conn.commit()
    _print_enqueue_result(
        args,
        {
            "command_id": command_id,
            "command_type": "notify_manager",
            "correlation_id": command["correlation_id"],
            "required_permission": getattr(args, "required_permission", None),
            "task": args.task,
        },
    )
    return 0


def command_enqueue_nudge_worker(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        command_id = worker_db.enqueue_nudge_worker(
            conn,
            task_id=task["id"],
            message=args.message,
            required_permission=getattr(args, "required_permission", None),
            idempotency_key=getattr(args, "idempotency_key", None),
            correlation_id=getattr(args, "correlation_id", None),
        )
        command = conn.execute("select correlation_id from commands where id = ?", (command_id,)).fetchone()
        conn.commit()
    _print_enqueue_result(
        args,
        {
            "command_id": command_id,
            "command_type": "nudge_worker",
            "correlation_id": command["correlation_id"],
            "required_permission": getattr(args, "required_permission", None),
            "task": args.task,
        },
    )
    return 0


def _dispatch_command_text(command: dict[str, Any]) -> str:
    payload = command.get("payload") or {}
    text = payload.get("message", payload.get("text"))
    if not isinstance(text, str) or not text.strip():
        raise WorkerError(f"{command['type']} command requires non-empty payload.message or payload.text")
    return text


def _dispatch_command_route(conn, command: dict[str, Any]) -> dict[str, Any]:
    if not command.get("task_id"):
        raise WorkerError(f"{command['type']} command requires task_id for active binding resolution")
    binding = active_binding_for_task(conn, task_name=command["task_id"])
    if command["type"] == "notify_manager":
        return {
            **binding,
            "signal_type": "notify_manager",
            "source_session_id": binding["worker_session_id"],
            "source_session_name": binding["worker_session_name"],
            "target_session_id": binding["manager_session_id"],
            "target_session_name": binding["manager_session_name"],
        }
    if command["type"] == "nudge_worker":
        return {
            **binding,
            "signal_type": "nudge_worker",
            "source_session_id": binding["manager_session_id"],
            "source_session_name": binding["manager_session_name"],
            "target_session_id": binding["worker_session_id"],
            "target_session_name": binding["worker_session_name"],
        }
    raise WorkerError(f"unsupported dispatch command type: {command['type']}")


def _dispatch_required_permission_check(conn, *, worker_db, command: dict[str, Any]) -> dict[str, Any] | None:
    required_permission = command.get("required_permission")
    if not required_permission:
        return None
    if not command.get("task_id"):
        raise WorkerError(f"{command['type']} command requires task_id for permission check")
    config = worker_db.manager_config(conn, task_id=command["task_id"])
    allowed = manager_permission_allowed(config, required_permission)
    permission_check = {
        "allowed": allowed,
        "configured": config is not None,
        "required_permission": required_permission,
    }
    worker_db.emit_telemetry_event(
        conn,
        actor="dispatch",
        event_type="dispatch_command_permission_checked",
        severity="info" if allowed else "warning",
        task_id=command["task_id"],
        summary=f"Dispatch checked manager permission {required_permission}.",
        correlation={
            "command_id": command["id"],
            "command_type": command["type"],
            "correlation_id": command["correlation_id"],
            "required_permission": required_permission,
        },
        attributes=permission_check,
    )
    if not allowed:
        raise WorkerError(f"manager permission required for dispatch command: {required_permission}")
    return permission_check


def _execute_dispatch_command(*, worker_db, worker_tmux, db_path: Path | None, command: dict[str, Any], attempt: dict[str, Any], dispatcher_id: str) -> dict[str, Any]:
    notification_id = None
    prepared = False
    side_effect_audit = {"side_effect_completed": False, "side_effect_started": False}
    base_result = {
        "attempt_id": attempt["id"],
        "command_id": command["id"],
        "command_type": command["type"],
        "correlation_id": command["correlation_id"],
        "dispatcher_id": dispatcher_id,
        "dry_run": False,
    }
    try:
        text = _dispatch_command_text(command)
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            route = _dispatch_command_route(conn, command)
            permission_check = _dispatch_required_permission_check(conn, worker_db=worker_db, command=command)
            payload = {
                "command_id": command["id"],
                "command_type": command["type"],
                "dispatcher_id": dispatcher_id,
                "message": text,
                "permission_check": permission_check,
                "source_session": route["source_session_name"],
                "target_session": route["target_session_name"],
                "task_id": command["task_id"],
            }
            notification_id = worker_db.insert_routed_notification(
                conn,
                task_id=command["task_id"],
                binding_id=route["binding_id"],
                correlation_id=command["correlation_id"],
                source_session_id=route["source_session_id"],
                target_session_id=route["target_session_id"],
                signal_type=route["signal_type"],
                source_event_id=None,
                source_event_timestamp=None,
                dedupe_key=f"{route['binding_id']}:{command['type']}:{command['id']}",
                command_id=command["id"],
                payload=payload,
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="dispatch",
                event_type="dispatch_command_attempted",
                task_id=command["task_id"],
                summary=f"Dispatch is executing command {command['type']}.",
                correlation={
                    "attempt_id": attempt["id"],
                    "command_id": command["id"],
                    "command_type": command["type"],
                    "correlation_id": command["correlation_id"],
                    "dispatcher_id": dispatcher_id,
                    "routed_notification_id": notification_id,
                },
                attributes={
                    "permission_check": permission_check,
                    "source_session": route["source_session_name"],
                    "target_session": route["target_session_name"],
                },
            )
            worker_db.mark_command_attempt_side_effect_started(conn, attempt_id=attempt["id"])
            conn.commit()
            prepared = True
        side_effect_audit["side_effect_started"] = True
        with worker_db.connect(db_path) as send_conn:
            worker_db.initialize_database(send_conn)
            send_result = worker_tmux.send_text_to_session(
                send_conn,
                session_name=route["target_session_name"],
                text=text,
                dry_run=False,
                side_effect_audit=side_effect_audit,
            )
        result = {
            **base_result,
            "notification_id": notification_id,
            "permission_check": permission_check,
            "send_result": send_result,
            "side_effect_completed": side_effect_audit["side_effect_completed"],
            "side_effect_started": side_effect_audit["side_effect_started"],
            "state": "delivered",
            "target_session": route["target_session_name"],
        }
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            worker_db.finish_routed_notification(conn, notification_id=notification_id, state="delivered")
            worker_db.finish_command_attempt(
                conn,
                attempt_id=attempt["id"],
                state="succeeded",
                result=result,
                side_effect_started=side_effect_audit["side_effect_started"],
                side_effect_completed=side_effect_audit["side_effect_completed"],
            )
            conn.commit()
        return result
    except Exception as exc:
        result = {
            **base_result,
            "error": str(exc),
            "error_type": type(exc).__name__,
            "notification_id": notification_id,
            "required_permission": command.get("required_permission"),
            "side_effect_completed": side_effect_audit["side_effect_completed"],
            "side_effect_started": side_effect_audit["side_effect_started"],
            "state": "failed",
        }
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            if notification_id is not None and prepared:
                worker_db.finish_routed_notification(
                    conn,
                    notification_id=notification_id,
                    state="failed",
                    error=str(exc),
                )
            worker_db.finish_command_attempt(
                conn,
                attempt_id=attempt["id"],
                state="failed",
                result=result,
                error=str(exc),
                side_effect_started=side_effect_audit["side_effect_started"],
                side_effect_completed=side_effect_audit["side_effect_completed"],
            )
            conn.commit()
        return result


def _dispatch_claim_expires_at(lease_seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=max(1, lease_seconds))).isoformat().replace("+00:00", "Z")


def _route_worker_completion(
    *,
    worker_db,
    worker_tmux,
    db_path: Path | None,
    row,
    dispatcher_id: str,
    dry_run: bool,
    lease_seconds: int,
) -> dict[str, Any]:
    dedupe_key = (
        f"{row['binding_id']}:worker_task_complete:"
        f"{row['source_session_id']}:{row['source_event_id']}"
    )
    correlation_id = f"dispatch-{uuid.uuid4()}"
    message = _dispatch_completion_message(
        worker_name=row["worker_session_name"],
        task_name=row["task_name"],
    )
    source_payload = json.loads(row["source_payload_json"])
    worker_receipt = {
        "completed_at": source_payload.get("completed_at"),
        "duration_ms": source_payload.get("duration_ms"),
        "last_agent_message": source_payload.get("last_agent_message"),
        "source_event_id": row["source_event_id"],
        "source_event_timestamp": row["source_event_timestamp"],
        "source_session": row["worker_session_name"],
        "time_to_first_token_ms": source_payload.get("time_to_first_token_ms"),
        "turn_id": source_payload.get("turn_id"),
    }
    payload = {
        "dispatcher_id": dispatcher_id,
        "message": message,
        "signal": "worker_task_complete",
        "source_event_id": row["source_event_id"],
        "source_session": row["worker_session_name"],
        "target_session": row["manager_session_name"],
        "task": row["task_name"],
        "worker_receipt": worker_receipt,
    }
    result = {
        "binding_id": row["binding_id"],
        "correlation_id": correlation_id,
        "dedupe_key": dedupe_key,
        "dry_run": dry_run,
        "signal_type": "worker_task_complete",
        "source_event_id": row["source_event_id"],
        "target_session": row["manager_session_name"],
        "task": row["task_name"],
    }
    if dry_run:
        result["state"] = "planned"
        return result
    notification_id = None
    side_effect_audit = {"side_effect_completed": False, "side_effect_started": False}
    claimed_at = now_iso()
    claim_expires_at = _dispatch_claim_expires_at(lease_seconds)
    try:
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            try:
                notification_id = worker_db.insert_routed_notification(
                    conn,
                    task_id=row["task_id"],
                    binding_id=row["binding_id"],
                    correlation_id=correlation_id,
                    source_session_id=row["source_session_id"],
                    target_session_id=row["target_session_id"],
                    signal_type="worker_task_complete",
                    source_event_id=row["source_event_id"],
                    source_event_timestamp=row["source_event_timestamp"],
                    dedupe_key=dedupe_key,
                    payload=payload,
                    claimed_by=dispatcher_id,
                    claimed_at=claimed_at,
                    claim_expires_at=claim_expires_at,
                )
            except Exception as exc:
                if "UNIQUE constraint failed" not in str(exc):
                    raise
                result["state"] = "suppressed"
                worker_db.emit_telemetry_event(
                    conn,
                    actor="dispatch",
                    event_type="dispatch_signal_suppressed",
                    task_id=row["task_id"],
                    summary=f"Dispatch suppressed duplicate {result['signal_type']} for {row['task_name']}.",
                    correlation={
                        "binding_id": row["binding_id"],
                        "correlation_id": correlation_id,
                        "dispatcher_id": dispatcher_id,
                        "source_event_id": row["source_event_id"],
                        "signal_type": "worker_task_complete",
                    },
                    attributes={
                        "dedupe_key": dedupe_key,
                        "error": str(exc),
                        "source_session": row["worker_session_name"],
                        "target_session": row["manager_session_name"],
                    },
                )
                conn.commit()
                return result
            worker_db.emit_telemetry_event(
                conn,
                actor="dispatch",
                event_type="dispatch_signal_detected",
                task_id=row["task_id"],
                summary=f"Dispatch detected worker completion for {row['task_name']}.",
                correlation={
                    "binding_id": row["binding_id"],
                    "correlation_id": correlation_id,
                    "dispatcher_id": dispatcher_id,
                    "source_event_id": row["source_event_id"],
                    "signal_type": "worker_task_complete",
                },
                attributes={
                    "source_session": row["worker_session_name"],
                    "target_session": row["manager_session_name"],
                },
            )
            conn.commit()
        def mark_side_effect_started() -> None:
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.mark_routed_notification_side_effect_started(
                    conn,
                    notification_id=notification_id,
                    claimed_by=dispatcher_id,
                    claim_expires_at=claim_expires_at,
                )
                conn.commit()

        with worker_db.connect(db_path) as send_conn:
            worker_db.initialize_database(send_conn)
            send_result = worker_tmux.send_text_to_session(
                send_conn,
                session_name=row["manager_session_name"],
                text=message,
                dry_run=False,
                side_effect_audit=side_effect_audit,
                side_effect_started_callback=mark_side_effect_started,
            )
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            worker_db.mark_routed_notification_side_effect_started(conn, notification_id=notification_id)
            worker_db.finish_routed_notification(
                conn,
                notification_id=notification_id,
                state="delivered",
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="dispatch",
                event_type="dispatch_signal_routed",
                task_id=row["task_id"],
                summary=f"Dispatch notified manager {row['manager_session_name']}.",
                correlation={
                    "binding_id": row["binding_id"],
                    "correlation_id": correlation_id,
                    "dispatcher_id": dispatcher_id,
                    "routed_notification_id": notification_id,
                    "source_event_id": row["source_event_id"],
                    "signal_type": "worker_task_complete",
                },
                attributes={
                    "target": send_result.get("target"),
                    "target_session": row["manager_session_name"],
                },
            )
            conn.commit()
        result.update({"notification_id": notification_id, "state": "delivered"})
    except Exception as exc:
        if notification_id is not None:
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                if side_effect_audit.get("side_effect_started"):
                    worker_db.mark_routed_notification_side_effect_started(conn, notification_id=notification_id)
                    worker_db.finish_routed_notification(
                        conn,
                        notification_id=notification_id,
                        state="failed",
                        error=str(exc),
                    )
                else:
                    worker_db.defer_routed_notification_before_side_effect(
                        conn,
                        notification_id=notification_id,
                        error=str(exc),
                    )
                worker_db.emit_telemetry_event(
                    conn,
                    actor="dispatch",
                    event_type="dispatch_signal_failed",
                    severity="error",
                    task_id=row["task_id"],
                    summary=f"Dispatch failed to notify manager {row['manager_session_name']}.",
                    correlation={
                        "binding_id": row["binding_id"],
                        "correlation_id": correlation_id,
                        "dispatcher_id": dispatcher_id,
                        "routed_notification_id": notification_id,
                        "source_event_id": row["source_event_id"],
                        "signal_type": "worker_task_complete",
                    },
                    attributes={
                        "error": str(exc),
                        "error_type": type(exc).__name__,
                        "target_session": row["manager_session_name"],
                    },
                )
                conn.commit()
        result.update({"error": str(exc), "notification_id": notification_id, "state": "failed"})
    return result


def _deliver_claimed_worker_completion(
    *,
    worker_db,
    worker_tmux,
    db_path: Path | None,
    row,
    dispatcher_id: str,
    lease_seconds: int,
) -> dict[str, Any]:
    payload = json.loads(row["notification_payload_json"]) if row["notification_payload_json"] else {}
    message = payload.get("message") or _dispatch_completion_message(
        worker_name=row["worker_session_name"],
        task_name=row["task_name"],
    )
    notification_id = int(row["notification_id"])
    result = {
        "binding_id": row["binding_id"],
        "correlation_id": row["correlation_id"],
        "dedupe_key": row["dedupe_key"],
        "dry_run": False,
        "notification_id": notification_id,
        "recovered": True,
        "signal_type": "worker_task_complete",
        "source_event_id": row["source_event_id"],
        "target_session": row["manager_session_name"],
        "task": row["task_name"],
    }
    side_effect_audit = {"side_effect_completed": False, "side_effect_started": False}
    claim_expires_at = _dispatch_claim_expires_at(lease_seconds)
    try:
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            worker_db.emit_telemetry_event(
                conn,
                actor="dispatch",
                event_type="dispatch_signal_recovered",
                task_id=row["task_id"],
                summary=f"Dispatch recovered pending worker completion notification for {row['task_name']}.",
                correlation={
                    "binding_id": row["binding_id"],
                    "correlation_id": row["correlation_id"],
                    "dispatcher_id": dispatcher_id,
                    "routed_notification_id": notification_id,
                    "source_event_id": row["source_event_id"],
                    "signal_type": "worker_task_complete",
                },
                attributes={"target_session": row["manager_session_name"]},
            )
            conn.commit()
        def mark_side_effect_started() -> None:
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.mark_routed_notification_side_effect_started(
                    conn,
                    notification_id=notification_id,
                    claimed_by=dispatcher_id,
                    claim_expires_at=claim_expires_at,
                )
                conn.commit()

        with worker_db.connect(db_path) as send_conn:
            worker_db.initialize_database(send_conn)
            send_result = worker_tmux.send_text_to_session(
                send_conn,
                session_name=row["manager_session_name"],
                text=message,
                dry_run=False,
                side_effect_audit=side_effect_audit,
                side_effect_started_callback=mark_side_effect_started,
            )
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            worker_db.mark_routed_notification_side_effect_started(conn, notification_id=notification_id)
            worker_db.finish_routed_notification(conn, notification_id=notification_id, state="delivered")
            worker_db.emit_telemetry_event(
                conn,
                actor="dispatch",
                event_type="dispatch_signal_routed",
                task_id=row["task_id"],
                summary=f"Dispatch notified manager {row['manager_session_name']}.",
                correlation={
                    "binding_id": row["binding_id"],
                    "correlation_id": row["correlation_id"],
                    "dispatcher_id": dispatcher_id,
                    "routed_notification_id": notification_id,
                    "source_event_id": row["source_event_id"],
                    "signal_type": "worker_task_complete",
                },
                attributes={
                    "recovered": True,
                    "target": send_result.get("target"),
                    "target_session": row["manager_session_name"],
                },
            )
            conn.commit()
        result.update({"state": "delivered"})
    except Exception as exc:
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            if side_effect_audit.get("side_effect_started"):
                worker_db.mark_routed_notification_side_effect_started(conn, notification_id=notification_id)
                worker_db.finish_routed_notification(
                    conn,
                    notification_id=notification_id,
                    state="failed",
                    error=str(exc),
                )
            else:
                worker_db.defer_routed_notification_before_side_effect(
                    conn,
                    notification_id=notification_id,
                    error=str(exc),
                )
            worker_db.emit_telemetry_event(
                conn,
                actor="dispatch",
                event_type="dispatch_signal_failed",
                severity="error",
                task_id=row["task_id"],
                summary=f"Dispatch failed to notify manager {row['manager_session_name']}.",
                correlation={
                    "binding_id": row["binding_id"],
                    "correlation_id": row["correlation_id"],
                    "dispatcher_id": dispatcher_id,
                    "routed_notification_id": notification_id,
                    "source_event_id": row["source_event_id"],
                    "signal_type": "worker_task_complete",
                },
                attributes={
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "recovered": True,
                    "target_session": row["manager_session_name"],
                },
            )
            conn.commit()
        result.update({"error": str(exc), "state": "failed"})
    return result


def _dispatch_once_pass(
    args: argparse.Namespace,
    *,
    worker_db,
    worker_tmux,
    limit: int,
    dispatcher_id: str,
    db_path: Path | None,
    dry_run: bool,
    lease_seconds: int,
) -> list[dict[str, Any]]:
    processed: list[dict[str, Any]] = []
    command_types = _dispatch_command_types(getattr(args, "type", None))
    remaining = limit
    if command_types:
        if dry_run:
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                for command in worker_db.claimable_dispatch_commands(
                    conn,
                    command_types=command_types,
                    limit=remaining,
                ):
                    processed.append(
                        {
                            "command_id": command["id"],
                            "command_type": command["type"],
                            "correlation_id": command["correlation_id"],
                            "dry_run": True,
                            "state": "planned",
                            "task": command["task_id"],
                        }
                    )
            remaining = max(0, limit - len(processed))
        else:
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                recovered = worker_db.recover_stale_dispatch_claims(
                    conn,
                    dispatcher_id=dispatcher_id,
                    command_types=command_types,
                    limit=remaining,
                )
                processed.extend(recovered)
                remaining = max(0, remaining - len(recovered))
                conn.commit()
            while remaining > 0:
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    claimed = worker_db.claim_next_dispatch_command(
                        conn,
                        dispatcher_id=dispatcher_id,
                        command_types=command_types,
                        lease_seconds=lease_seconds,
                    )
                    conn.commit()
                if claimed is None:
                    break
                command = claimed["command"]
                attempt = claimed["attempt"]
                processed.append(
                    _execute_dispatch_command(
                        worker_db=worker_db,
                        worker_tmux=worker_tmux,
                        db_path=db_path,
                        command=command,
                        attempt=attempt,
                        dispatcher_id=dispatcher_id,
                    )
                )
                remaining -= 1
    rows = []
    if remaining > 0 and getattr(args, "type", None) in {None, "worker_task_complete"}:
        if not dry_run:
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                abandoned = worker_db.fail_stale_started_routed_notifications(conn, limit=remaining)
                for notification in abandoned:
                    worker_db.emit_telemetry_event(
                        conn,
                        actor="dispatch",
                        event_type="dispatch_signal_failed",
                        severity="error",
                        task_id=notification["task_id"],
                        summary="Dispatch found stale pending completion notification with side-effect risk.",
                        correlation={
                            "binding_id": notification["binding_id"],
                            "correlation_id": notification["correlation_id"],
                            "dispatcher_id": dispatcher_id,
                            "routed_notification_id": notification["notification_id"],
                            "source_event_id": notification["source_event_id"],
                            "signal_type": notification["signal_type"],
                        },
                        attributes={
                            "claim_expires_at": notification["claim_expires_at"],
                            "claimed_by": notification["claimed_by"],
                            "error": notification["error"],
                            "side_effect_risk": True,
                        },
                    )
                claimed_notifications = worker_db.claim_pending_routed_completion_notifications(
                    conn,
                    dispatcher_id=dispatcher_id,
                    lease_seconds=lease_seconds,
                    limit=remaining,
                )
                conn.commit()
            for notification in claimed_notifications:
                processed.append(
                    _deliver_claimed_worker_completion(
                        worker_db=worker_db,
                        worker_tmux=worker_tmux,
                        db_path=db_path,
                        row=notification,
                        dispatcher_id=dispatcher_id,
                        lease_seconds=lease_seconds,
                    )
                )
            remaining = max(0, remaining - len(claimed_notifications))
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            rows = worker_db.unrouted_worker_completion_events(conn, limit=remaining)
            conn.commit()
    for row in rows:
        processed.append(
            _route_worker_completion(
                worker_db=worker_db,
                worker_tmux=worker_tmux,
                db_path=db_path,
                row=row,
                dispatcher_id=dispatcher_id,
                dry_run=dry_run,
                lease_seconds=lease_seconds,
            )
        )
    return processed


def _emit_dispatch_watch_heartbeat(
    *,
    worker_db,
    db_path: Path | None,
    dispatcher_id: str,
    iteration: int,
    processed_count: int,
    dry_run: bool,
) -> None:
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        worker_db.emit_telemetry_event(
            conn,
            actor="dispatch",
            event_type="dispatch_watch_heartbeat",
            summary=f"Dispatch watch heartbeat {iteration}.",
            correlation={"dispatcher_id": dispatcher_id, "iteration": iteration},
            attributes={"dry_run": dry_run, "processed_count": processed_count},
        )
        conn.commit()


def command_dispatch(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    if getattr(args, "once", False) and getattr(args, "watch", False):
        raise WorkerError("dispatch accepts either --once or --watch, not both")
    if getattr(args, "type", None) not in {None, "notify_manager", "nudge_worker", "worker_task_complete"}:
        raise WorkerError("dispatch --type supports notify_manager, nudge_worker, and worker_task_complete")
    limit = max(1, int(getattr(args, "limit", 10) or 10))
    dispatcher_id = getattr(args, "dispatcher_id", None) or "dispatch-local"
    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    dry_run = bool(getattr(args, "dry_run", False))
    watch = bool(getattr(args, "watch", False))
    interval = max(0.0, float(getattr(args, "interval", 2.0) or 0.0))
    watch_iterations = getattr(args, "watch_iterations", None)
    lease_seconds = max(1, int(getattr(args, "lease_seconds", 60) or 60))
    processed: list[dict[str, Any]] = []
    iterations = 0
    try:
        while True:
            iterations += 1
            batch = _dispatch_once_pass(
                args,
                worker_db=worker_db,
                worker_tmux=worker_tmux,
                limit=limit,
                dispatcher_id=dispatcher_id,
                db_path=db_path,
                dry_run=dry_run,
                lease_seconds=lease_seconds,
            )
            processed.extend(batch)
            if watch:
                _emit_dispatch_watch_heartbeat(
                    worker_db=worker_db,
                    db_path=db_path,
                    dispatcher_id=dispatcher_id,
                    iteration=iterations,
                    processed_count=len(batch),
                    dry_run=dry_run,
                )
            if not watch:
                break
            if watch_iterations is not None and iterations >= int(watch_iterations):
                break
            time.sleep(interval)
    except KeyboardInterrupt:
        pass
    output = {
        "dispatcher_id": dispatcher_id,
        "dry_run": dry_run,
        "iterations": iterations,
        "processed": processed,
        "processed_count": len(processed),
        "watch": watch,
    }
    if getattr(args, "json", False):
        print(json.dumps(output, indent=2, sort_keys=True))
    else:
        print(f"dispatch processed {len(processed)} item(s)")
    return 0


def _epilogue_status_payload(conn, *, task_id: str, config: dict[str, Any] | None) -> dict[str, Any]:
    steps = clean_epilogue_steps((config or {}).get("epilogues") or [])
    return {
        "configured_steps": steps,
        "runs": worker_db_epilogue_runs(conn, task_id=task_id),
        "status": worker_db_epilogue_status(conn, task_id=task_id, required_steps=steps),
    }


def worker_db_epilogue_runs(conn, *, task_id: str) -> list[dict[str, Any]]:
    from workerctl import db as worker_db

    return worker_db.epilogue_runs(conn, task_id=task_id)


def worker_db_epilogue_status(conn, *, task_id: str, required_steps: list[str]) -> dict[str, Any]:
    from workerctl import db as worker_db

    return worker_db.epilogue_status(conn, task_id=task_id, required_steps=required_steps)


def _run_epilogue_step(conn, *, task: dict[str, Any], config: dict[str, Any] | None, step: str) -> tuple[str, dict[str, Any] | None, str | None]:
    if step == "run-tools":
        tools = clean_manager_tools((config or {}).get("tools") or [])
        results = []
        for tool in tools:
            executable = shutil.which(tool)
            if executable is None:
                return "failed", {"tools": results}, f"configured tool not found: {tool}"
            proc = subprocess.run([executable, "--version"], capture_output=True, text=True, cwd=str(PROJECT_ROOT), timeout=30)
            results.append(
                {
                    "returncode": proc.returncode,
                    "stderr": proc.stderr[-1000:],
                    "stdout": proc.stdout[-1000:],
                    "tool": tool,
                }
            )
            if proc.returncode != 0:
                return "failed", {"tools": results}, f"configured tool failed version check: {tool}"
        return "succeeded", {"tools": results, "tool_count": len(tools)}, None
    if step == "draft-pr":
        audit = worker_db_task_audit(conn, task=task["name"])
        result = {
            "acceptance_criteria_count": len(audit.get("acceptance_criteria", [])),
            "command_count": len(audit.get("commands", [])),
            "event_count": len(audit.get("events", [])),
            "summary": f"Task {task['name']} epilogue draft ready from audit data.",
        }
        return "succeeded", result, None
    if step == "subagent-review":
        from workerctl import db as worker_db

        reviews = worker_db.continuation_reviews(conn, task_id=task["id"])
        if not reviews:
            return "failed", None, "subagent-review requires a recorded continuation review"
        latest = reviews[-1]
        return (
            "succeeded",
            {
                "agreement": latest["agreement"],
                "continuation_review_id": latest["id"],
                "operator_routing_required": latest["subagent_run"].get("operator_routing_required", False),
                "verdict": latest["verdict"],
            },
            None,
        )
    if step == "record-handoff":
        from workerctl import db as worker_db

        handoff = worker_db.latest_worker_handoff(conn, task_id=task["id"])
        if handoff is None:
            return "failed", None, "record-handoff requires an existing worker handoff"
        return "succeeded", {"handoff_id": handoff["id"], "summary": handoff["summary"]}, None
    raise WorkerError(f"unknown epilogue step: {step}")


def worker_db_task_audit(conn, *, task: str) -> dict[str, Any]:
    from workerctl import db as worker_db

    return worker_db.task_audit(conn, task=task)


def command_epilogue(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    if not (getattr(args, "list", False) or getattr(args, "status", False) or getattr(args, "step", None)):
        raise WorkerError("epilogue requires --list, --status, or --step")
    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        config = worker_db.manager_config(conn, task_id=task["id"])
        configured_steps = clean_epilogue_steps((config or {}).get("epilogues") or [])
        if getattr(args, "step", None):
            step = args.step
            if step not in configured_steps:
                raise WorkerError(f"epilogue step {step!r} is not configured for task {task['name']}")
            correlation_id = getattr(args, "correlation_id", None) or f"epilogue-{uuid.uuid4()}"
            state, result, error = _run_epilogue_step(conn, task=dict(task), config=config, step=step)
            run_id = worker_db.insert_epilogue_run(
                conn,
                task_id=task["id"],
                step_name=step,
                state=state,
                result=result,
                error=error,
                correlation_id=correlation_id,
            )
            worker_db.insert_event(
                conn,
                "epilogue_step_recorded",
                actor="workerctl",
                correlation_id=correlation_id,
                task_id=task["id"],
                payload={"epilogue_run_id": run_id, "state": state, "step_name": step},
            )
            conn.commit()
        payload = {
            "configured_steps": configured_steps,
            "runs": worker_db.epilogue_runs(conn, task_id=task["id"]),
            "status": worker_db.epilogue_status(conn, task_id=task["id"], required_steps=configured_steps),
            "task": {"id": task["id"], "name": task["name"]},
        }
    if getattr(args, "json", False) or getattr(args, "status", False) or getattr(args, "list", False):
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"epilogue {args.step}: {payload['status']['steps']}")
    return 0


def worker_ack_task_prompt(task_name: str | None, task_prompt: str | None) -> str | None:
    if task_prompt is None:
        return None
    task_ref = task_name or "<task>"
    workerctl = workerctl_cli()
    return f"""{task_prompt}

Before editing files or running implementation work, acknowledge the task contract:

{workerctl} worker-ack {task_ref} --from-stdin

Use a JSON object with goal_restatement, proposed_criteria, expected_tools,
open_questions, and ready_to_start."""


def manager_config_questions(existing: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    existing = existing or {}
    permissions = normalize_manager_permissions(existing.get("permissions") or {})
    return [
        {
            "id": "supervision_mode",
            "kind": "choice",
            "choices": ["guided", "light", "strict"],
            "default": existing.get("supervision_mode") or "guided",
            "question": "How structured should manager supervision be?",
            "help": "Use guided for normal nudges, light for loose progress checks, strict when the manager must regularly check acceptance criteria.",
        },
        {
            "id": "objective",
            "kind": "text",
            "default": existing.get("objective"),
            "question": "What should the manager do or check against?",
            "help": "Examples: a PRD, implementation plan, mockup, GitHub issue, branch goal, or testing checklist.",
        },
        {
            "id": "guidelines",
            "kind": "list",
            "default": existing.get("guidelines") or [],
            "question": "What guidelines should constrain manager nudges?",
            "help": "Examples: nudge only when stale, do not change scope, ask before destructive commands.",
        },
        {
            "id": "acceptance_criteria",
            "kind": "list",
            "default": existing.get("acceptance_criteria") or [],
            "question": "What acceptance criteria should the manager check regularly?",
            "help": "Examples: tests pass, matches mockup, docs updated, PR opened.",
        },
        {
            "id": "reference_paths",
            "kind": "list",
            "default": existing.get("reference_paths") or [],
            "question": "What planning, PRD, mockup, issue, or file references should be saved?",
            "help": "Use repo paths or URLs.",
        },
        {
            "id": "permissions",
            "kind": "categorized_permissions",
            "default": permissions,
            "question": "Which high-level actions may the manager instruct the worker to do?",
            "choices": {
                category: sorted(actions)
                for category, actions in MANAGER_PERMISSION_TAXONOMY.items()
            },
        },
        {
            "id": "tools",
            "kind": "list",
            "default": existing.get("tools") or [],
            "question": "Which verification or context tools should the manager expect?",
            "help": "Examples: pytest, playwright, xcodebuild, cargo, gh.",
        },
        {
            "id": "epilogues",
            "kind": "choice_list",
            "default": existing.get("epilogues") or [],
            "question": "Which built-in epilogue steps should be required before finish?",
            "choices": sorted(EPILOGUE_STEPS),
        },
        {
            "id": "nudge_on_completion",
            "kind": "choice",
            "default": existing.get("nudge_on_completion") if existing else "ask-operator",
            "question": "What should happen when worker completion creates continuation proposals?",
            "choices": sorted(NUDGE_ON_COMPLETION_MODES),
        },
        {
            "id": "require_acks",
            "kind": "boolean",
            "default": bool(existing.get("require_acks", False)),
            "question": "Should cycle fail closed until both worker and manager acknowledgements exist?",
            "help": "Use this when the task contract must be acknowledged before manager cycles begin.",
        },
    ]


def _split_interactive_list(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _interactive_bool(prompt: str, *, default: bool) -> bool:
    suffix = "Y/n" if default else "y/N"
    answer = input(f"{prompt} [{suffix}]: ").strip().lower()
    if not answer:
        return default
    return answer in {"y", "yes", "true", "1"}


def _apply_interactive_manager_config(args: argparse.Namespace, existing: dict[str, Any] | None) -> None:
    questions = {question["id"]: question for question in manager_config_questions(existing)}
    print("Manager configuration setup. Press Enter to keep defaults.")
    mode_default = questions["supervision_mode"]["default"]
    mode_answer = input(f"{questions['supervision_mode']['question']} [{mode_default}]: ").strip()
    if mode_answer:
        if mode_answer not in {"light", "guided", "strict"}:
            raise WorkerError("--mode must be one of: light, guided, strict")
        args.mode = mode_answer
    else:
        args.mode = mode_default

    objective_default = questions["objective"]["default"] or ""
    objective_answer = input(f"{questions['objective']['question']} [{objective_default}]: ").strip()
    args.objective = objective_answer or objective_default or None

    for attr, question_id in (
        ("guideline", "guidelines"),
        ("acceptance", "acceptance_criteria"),
        ("reference", "reference_paths"),
    ):
        question = questions[question_id]
        default_values = question["default"]
        default_text = ", ".join(default_values)
        answer = input(f"{question['question']} (comma-separated) [{default_text}]: ").strip()
        setattr(args, attr, _split_interactive_list(answer) if answer else list(default_values))

    permission_defaults = flatten_manager_permissions(questions["permissions"]["default"])
    permissions = {
        "create_pr": _interactive_bool("Allow manager to instruct worker to create a PR?", default="repo.open_pr" in permission_defaults),
        "merge_green_pr": _interactive_bool("Allow manager to instruct merging a green PR?", default="repo.merge_green_pr" in permission_defaults),
        "worker_compact_clear": _interactive_bool(
            "Allow manager to instruct worker compact/clear after a saved handoff?",
            default={"worker_session.compact", "worker_session.clear"}.issubset(permission_defaults),
        ),
    }
    args.allow_pr = permissions["create_pr"]
    args.allow_merge_green = permissions["merge_green_pr"]
    args.allow_worker_compact_clear = permissions["worker_compact_clear"]
    args.permissions_json = json.dumps(permissions, sort_keys=True)
    tools_question = questions["tools"]
    tools_default = tools_question["default"]
    tools_text = ", ".join(tools_default)
    tools_answer = input(f"{tools_question['question']} (comma-separated) [{tools_text}]: ").strip()
    args.tool = _split_interactive_list(tools_answer) if tools_answer else list(tools_default)
    epilogues_question = questions["epilogues"]
    epilogues_default = epilogues_question["default"]
    epilogues_text = ", ".join(epilogues_default)
    epilogues_answer = input(f"{epilogues_question['question']} (comma-separated) [{epilogues_text}]: ").strip()
    args.epilogue = clean_epilogue_steps(_split_interactive_list(epilogues_answer) if epilogues_answer else list(epilogues_default))
    nudge_question = questions["nudge_on_completion"]
    nudge_default = nudge_question["default"]
    nudge_answer = input(f"{nudge_question['question']} [{nudge_default}]: ").strip()
    args.nudge_on_completion = clean_nudge_on_completion(nudge_answer or nudge_default)
    args.require_acks = _interactive_bool(
        questions["require_acks"]["question"],
        default=questions["require_acks"]["default"],
    )


MANAGER_PERMISSION_TAXONOMY = {
    "repo": {"open_pr", "push_branch", "merge_green_pr"},
    "verification": {"run_playwright", "run_xcodebuild", "run_pytest", "run_cargo"},
    "context": {"spawn_reviewer", "fetch_prs", "fetch_issues"},
    "communication": {"comment_on_pr", "notify_operator"},
    "worker_session": {"compact", "clear", "interrupt", "stop"},
}

MANAGER_PERMISSION_ACTIONS = {
    f"{category}.{action}"
    for category, actions in MANAGER_PERMISSION_TAXONOMY.items()
    for action in actions
}

MANAGER_PERMISSION_ALIASES = {
    "allow_pr": "repo.open_pr",
    "create_pr": "repo.open_pr",
    "allow_merge_green": "repo.merge_green_pr",
    "merge_green_pr": "repo.merge_green_pr",
    "allow_worker_compact_clear": ["worker_session.compact", "worker_session.clear"],
    "worker_compact_clear": ["worker_session.compact", "worker_session.clear"],
}

EPILOGUE_STEPS = {"run-tools", "draft-pr", "subagent-review", "record-handoff"}
NUDGE_ON_COMPLETION_MODES = {"off", "ask-operator", "auto-review", "auto-proceed"}


def empty_manager_permissions() -> dict[str, list[str]]:
    return {category: [] for category in MANAGER_PERMISSION_TAXONOMY}


def _canonical_permission_names(name: str) -> list[str]:
    alias = MANAGER_PERMISSION_ALIASES.get(name, name)
    if isinstance(alias, list):
        return alias
    return [alias]


def _grant_manager_permission(normalized: dict[str, list[str]], name: str) -> bool:
    granted = False
    for canonical in _canonical_permission_names(name):
        if "." not in canonical:
            continue
        category, action = canonical.split(".", 1)
        if action in MANAGER_PERMISSION_TAXONOMY.get(category, set()):
            bucket = normalized.setdefault(category, [])
            if action not in bucket:
                bucket.append(action)
                bucket.sort()
            granted = True
    return granted


def flatten_manager_permissions(permissions: dict[str, Any] | None) -> set[str]:
    normalized = normalize_manager_permissions(permissions)
    return {
        f"{category}.{action}"
        for category, actions in normalized.items()
        for action in actions
    }


def manager_permission_warnings(permissions: dict[str, Any] | None) -> list[str]:
    warnings: list[str] = []
    for key, value in (permissions or {}).items():
        if key in MANAGER_PERMISSION_ALIASES:
            continue
        if key in MANAGER_PERMISSION_TAXONOMY:
            if not isinstance(value, list):
                warnings.append(f"permission category {key!r} must be a list")
                continue
            for action in value:
                if action not in MANAGER_PERMISSION_TAXONOMY[key]:
                    warnings.append(f"unknown permission {key}.{action}")
            continue
        if "." in key and _canonical_permission_names(key)[0] in MANAGER_PERMISSION_ACTIONS:
            continue
        warnings.append(f"unknown permission key {key!r}")
    return warnings


def normalize_manager_permissions(permissions: dict[str, Any] | None) -> dict[str, list[str]]:
    normalized = empty_manager_permissions()
    for key, value in (permissions or {}).items():
        if key in MANAGER_PERMISSION_TAXONOMY and isinstance(value, list):
            for action in value:
                if action in MANAGER_PERMISSION_TAXONOMY[key]:
                    _grant_manager_permission(normalized, f"{key}.{action}")
            continue
        if bool(value):
            _grant_manager_permission(normalized, key)
    return normalized


def normalize_manager_permission_overrides(permissions: dict[str, Any] | None) -> dict[str, list[str]]:
    normalized = empty_manager_permissions()
    for key, value in (permissions or {}).items():
        if key in MANAGER_PERMISSION_TAXONOMY and isinstance(value, list):
            for action in value:
                if action in MANAGER_PERMISSION_TAXONOMY[key]:
                    _grant_manager_permission(normalized, f"{key}.{action}")
            continue
        if bool(value):
            _grant_manager_permission(normalized, key)
    return normalized


def merge_manager_permissions(base: dict[str, list[str]], overrides: dict[str, list[str]]) -> dict[str, list[str]]:
    merged = {category: list(actions) for category, actions in base.items()}
    for category, actions in overrides.items():
        for action in actions:
            _grant_manager_permission(merged, f"{category}.{action}")
    return merged


def _revoke_manager_permission(normalized: dict[str, list[str]], name: str) -> None:
    for canonical in _canonical_permission_names(name):
        if "." not in canonical:
            continue
        category, action = canonical.split(".", 1)
        if action in normalized.get(category, []):
            normalized[category].remove(action)


def apply_manager_permission_overrides(base: dict[str, list[str]], overrides: dict[str, Any] | None) -> dict[str, list[str]]:
    updated = {category: list(actions) for category, actions in base.items()}
    for key, value in (overrides or {}).items():
        if key in MANAGER_PERMISSION_TAXONOMY:
            if isinstance(value, list):
                updated[key] = sorted(
                    action for action in value
                    if action in MANAGER_PERMISSION_TAXONOMY[key]
                )
            continue
        if bool(value):
            _grant_manager_permission(updated, key)
        else:
            _revoke_manager_permission(updated, key)
    return updated


def add_manager_permission_flags(permissions: dict[str, list[str]], flags: list[str]) -> dict[str, list[str]]:
    updated = {category: list(actions) for category, actions in permissions.items()}
    for flag in flags:
        _grant_manager_permission(updated, flag)
    return updated


def clean_manager_tools(values: list[str] | None) -> list[str]:
    seen = set()
    tools: list[str] = []
    for value in values or []:
        tool = value.strip()
        if tool and tool not in seen:
            seen.add(tool)
            tools.append(tool)
    return tools


def clean_epilogue_steps(values: list[str] | None) -> list[str]:
    seen = set()
    steps: list[str] = []
    for value in values or []:
        step = value.strip()
        if not step:
            continue
        if step not in EPILOGUE_STEPS:
            raise WorkerError(f"unknown epilogue step: {step}")
        if step not in seen:
            seen.add(step)
            steps.append(step)
    return steps


def clean_nudge_on_completion(value: str | None) -> str:
    mode = value or "ask-operator"
    if mode not in NUDGE_ON_COMPLETION_MODES:
        raise WorkerError("--nudge-on-completion must be one of: off, ask-operator, auto-review, auto-proceed")
    return mode


def manager_permission_allowed(config: dict[str, Any] | None, action: str) -> bool:
    if not config:
        return False
    return all(
        permission in flatten_manager_permissions(config.get("permissions"))
        for permission in _canonical_permission_names(action)
    )


def manager_permission_display(config: dict[str, Any] | None) -> str:
    permissions = normalize_manager_permissions(config.get("permissions") if config else None)
    granted = sorted(flatten_manager_permissions(permissions))
    all_permissions = sorted(MANAGER_PERMISSION_ACTIONS)
    denied = [permission for permission in all_permissions if permission not in granted]
    granted_text = ", ".join(granted) if granted else "none"
    denied_text = ", ".join(denied) if denied else "none"
    return f"You may: {granted_text}.\nYou may NOT: {denied_text}."


MANAGER_DECISIONS = {
    "wait",
    "nudge",
    "interrupt",
    "escalate",
    "stop",
    "inspect",
}


def command_record_decision(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    if args.decision not in MANAGER_DECISIONS:
        raise WorkerError(f"unknown manager decision: {args.decision}")
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    payload = _json_arg(args.payload_json, flag="--payload-json")
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        result = record_manager_decision(
            conn,
            task=task,
            manager_cycle_id=args.cycle_id,
            decision=args.decision,
            reason=args.reason,
            payload=payload,
        )
        conn.commit()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def record_manager_decision(
    conn: Any,
    *,
    task: dict[str, Any],
    decision: str,
    reason: str,
    manager_cycle_id: int | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from workerctl import db as worker_db

    manager = worker_db.active_manager(conn, task=task["id"])
    decision_id = worker_db.insert_manager_decision(
        conn,
        task_id=task["id"],
        manager_id=manager["id"] if manager else None,
        manager_cycle_id=manager_cycle_id,
        decision=decision,
        reason=reason,
        payload=payload,
    )
    row = conn.execute(
        """
        select id, task_id, manager_id, manager_cycle_id, decision, reason,
               created_at, payload_json
        from manager_decisions
        where id = ?
        """,
        (decision_id,),
    ).fetchone()
    result = {
        "created_at": row["created_at"],
        "decision": row["decision"],
        "id": row["id"],
        "manager_cycle_id": row["manager_cycle_id"],
        "manager_id": row["manager_id"],
        "payload": json.loads(row["payload_json"]),
        "reason": row["reason"],
        "task": {"id": task["id"], "name": task["name"]},
        "task_id": row["task_id"],
    }
    worker_db.insert_event(
        conn,
        "manager_decision_recorded",
        actor="workerctl",
        task_id=task["id"],
        manager_id=manager["id"] if manager else None,
        payload={
            "decision": row["decision"],
            "decision_id": row["id"],
            "manager_cycle_id": row["manager_cycle_id"],
            "reason": row["reason"],
        },
    )
    return result


def command_manager_permission(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        config = worker_db.manager_config(conn, task_id=task["id"])
        handoff = worker_db.latest_worker_handoff(conn, task_id=task["id"])
        reasons: list[str] = []
        allowed = False
        listed_permissions: list[str] | None = None
        if config is None:
            reasons.append("missing_manager_config")
        else:
            config["permissions"] = normalize_manager_permissions(config.get("permissions"))
            if getattr(args, "list", False):
                if args.action not in MANAGER_PERMISSION_TAXONOMY:
                    raise WorkerError(f"--list expects a permission category, got: {args.action}")
                listed_permissions = list(config["permissions"].get(args.action, []))
                allowed = True
            else:
                unknown = [
                    permission for permission in _canonical_permission_names(args.action)
                    if permission not in MANAGER_PERMISSION_ACTIONS
                ]
                if unknown:
                    raise WorkerError(f"unknown manager permission action: {args.action}")
                allowed = manager_permission_allowed(config, args.action)
                if not allowed:
                    reasons.append("permission_not_enabled")
        if not getattr(args, "list", False) and args.require_handoff and handoff is None:
            allowed = False
            reasons.append("missing_worker_handoff")
        result = {
            "action": args.action,
            "allowed": allowed,
            "config": config,
            "handoff_id": handoff["id"] if handoff else None,
            "listed_permissions": listed_permissions,
            "require_handoff": args.require_handoff,
            "reasons": reasons,
            "task": {"id": task["id"], "name": task["name"]},
        }
        worker_db.insert_event(
            conn,
            "manager_permission_checked",
            actor="workerctl",
            task_id=task["id"],
            payload=result,
        )
        worker_db.emit_telemetry_event(
            conn,
            actor="manager",
            event_type="manager_permission_checked",
            task_id=task["id"],
            severity="info" if allowed else "warning",
            summary=f"Checked manager permission {args.action}.",
            correlation={"action": args.action, "handoff_id": result["handoff_id"]},
            attributes={
                "allowed": allowed,
                "reasons": reasons,
                "require_handoff": args.require_handoff,
            },
        )
        conn.commit()
    print(json.dumps(result, indent=2, sort_keys=True))
    if args.require and not allowed:
        return 1
    return 0


def worker_compact_request_text(task_name: str, handoff: dict[str, Any]) -> str:
    return (
        "Manager request: prepare for context compaction/clear only if supported by this Codex session.\n\n"
        f"Task: {task_name}\n"
        f"Saved handoff id: {handoff['id']}\n"
        f"Saved handoff summary: {handoff['summary']}\n\n"
        "Before compacting or clearing visible context, verify the saved handoff still captures current progress. "
        "If it is stale, update it with `scripts/workerctl handoff` first. "
        "Then run the Codex compact/clear action only if supported and appropriate. "
        "Afterward, report whether compaction happened and what the next concrete step is. "
        "Do not edit project files as part of this request."
    )


def worker_compact_slash_command(args: argparse.Namespace) -> str | None:
    if args.prompt_only:
        return None
    return "/clear" if args.clear else "/compact"


def command_request_worker_compact(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        binding = worker_db.active_binding_for_task(conn, task_name=task["name"])
        config = worker_db.manager_config(conn, task_id=task["id"])
        handoff = worker_db.latest_worker_handoff(conn, task_id=task["id"])
        manager = worker_db.active_manager(conn, task=task["id"])
        decision_check = worker_db.assess_manager_decision(
            conn,
            task_id=task["id"],
            decision_id=args.decision_id,
            allowed_decisions={"nudge"},
        )
        permission_reasons: list[str] = []
        permission_allowed = manager_permission_allowed(config, "worker_compact_clear")
        if config is None:
            permission_reasons.append("missing_manager_config")
        elif not permission_allowed:
            permission_reasons.append("permission_not_enabled")
        if handoff is None:
            permission_allowed = False
            permission_reasons.append("missing_worker_handoff")
        permission_check = {
            "action": "worker_compact_clear",
            "allowed": permission_allowed,
            "handoff_id": handoff["id"] if handoff else None,
            "reasons": permission_reasons,
        }
        worker_db.insert_event(
            conn,
            "manager_permission_checked",
            actor="workerctl",
            task_id=task["id"],
            payload={
                **permission_check,
                "source": "request_worker_compact",
            },
        )
        worker_db.emit_telemetry_event(
            conn,
            actor="manager",
            event_type="manager_permission_checked",
            task_id=task["id"],
            severity="info" if permission_allowed else "warning",
            summary="Checked manager permission worker_compact_clear.",
            correlation={
                "action": "worker_compact_clear",
                "binding_id": binding["binding_id"],
                "handoff_id": handoff["id"] if handoff else None,
                "source": "request_worker_compact",
            },
            attributes={
                "allowed": permission_allowed,
                "reasons": permission_reasons,
                "worker_session": binding["worker_session_name"],
            },
        )
        slash_command = worker_compact_slash_command(args)
        message = args.message or (
            worker_compact_request_text(task["name"], handoff)
            if handoff is not None
            else "Manager request: prepare for context compaction/clear after a saved handoff exists."
        )
        send_text_value = message if slash_command is None else slash_command
        command_id = worker_db.create_command(
            conn,
            command_type="request_worker_compact",
            task_id=task["id"],
            manager_id=manager["id"] if manager else None,
            payload={
                "manager_decision": decision_check,
                "message": message,
                "permission_check": permission_check,
                "send_text": send_text_value,
                "slash_command": slash_command,
                "task": task["name"],
                "worker_session": binding["worker_session_name"],
            },
        )
        try:
            worker_db.require_manager_decision_ok(
                command_type="request_worker_compact",
                decision_check=decision_check,
                strict=args.strict_decisions,
            )
            if not permission_allowed:
                raise WorkerError(f"worker compact request is not allowed: {json.dumps(permission_check, sort_keys=True)}")
        except Exception as exc:
            result = {
                "command_id": command_id,
                "expected_failure": True,
                "failure_stage": "preflight",
                "manager_decision": decision_check,
                "permission_check": permission_check,
                "task": task["name"],
                "worker_session": binding["worker_session_name"],
            }
            worker_db.mark_command_attempted(conn, command_id=command_id)
            worker_db.finish_command(conn, command_id=command_id, state="failed", result=result, error=str(exc))
            worker_db.insert_event(
                conn,
                "worker_compact_request_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=task["id"],
                manager_id=manager["id"] if manager else None,
                payload={**result, "error": str(exc), "error_type": type(exc).__name__},
            )
            conn.commit()
            raise
        worker_db.insert_event(
            conn,
            "worker_compact_requested",
            actor="workerctl",
            command_id=command_id,
            task_id=task["id"],
            manager_id=manager["id"] if manager else None,
            payload={
                "permission_check": permission_check,
                "worker_session": binding["worker_session_name"],
            },
        )
        conn.commit()

    result = {
        "command_id": command_id,
        "manager_decision": decision_check,
        "message": message,
        "permission_check": permission_check,
        "send_text": send_text_value,
        "slash_command": slash_command,
        "task": task["name"],
        "worker_session": binding["worker_session_name"],
    }
    try:
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            worker_db.mark_command_attempted(conn, command_id=command_id)
            send_result = worker_tmux.send_text_to_session(
                conn,
                session_name=binding["worker_session_name"],
                text=send_text_value,
                dry_run=args.dry_run,
            )
            result["send_result"] = send_result
            worker_db.finish_command(conn, command_id=command_id, state="succeeded", result=result)
            worker_db.insert_event(
                conn,
                "worker_compact_request_succeeded",
                actor="workerctl",
                command_id=command_id,
                task_id=task["id"],
                manager_id=manager["id"] if manager else None,
                payload=result,
            )
            conn.commit()
    except Exception as exc:
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            worker_db.finish_command(conn, command_id=command_id, state="failed", result=result, error=str(exc))
            worker_db.insert_event(
                conn,
                "worker_compact_request_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=task["id"],
                manager_id=manager["id"] if manager else None,
                payload={**result, "error": str(exc), "error_type": type(exc).__name__},
            )
            conn.commit()
        raise
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_compact_worker(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    decision_payload = {
        "source": "compact-worker",
        "slash_command": "/clear" if args.clear else (None if args.prompt_only else "/compact"),
    }
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        decision = record_manager_decision(
            conn,
            task=task,
            manager_cycle_id=args.cycle_id,
            decision="nudge",
            reason=args.reason,
            payload=decision_payload,
        )
        conn.commit()

    request_args = argparse.Namespace(
        clear=args.clear,
        decision_id=decision["id"],
        dry_run=args.dry_run,
        message=args.message,
        path=args.path,
        prompt_only=args.prompt_only,
        strict_decisions=True,
        task=args.task,
    )
    return command_request_worker_compact(request_args)


def command_manager_config(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        existing = worker_db.manager_config(conn, task_id=task["id"])
        if args.questions:
            print(json.dumps({
                "recommended_collection": "manager_codex_chat",
                "fallback_collection": "workerctl manager-config --interactive",
                "questions": manager_config_questions(existing),
                "task": {"id": task["id"], "name": task["name"]},
            }, indent=2, sort_keys=True))
            return 0
        if args.interactive:
            try:
                _apply_interactive_manager_config(args, existing)
            except EOFError as exc:
                raise WorkerError("--interactive requires answers on stdin or a terminal") from exc
        mutating = any(
            [
                args.mode is not None,
                args.objective is not None,
                args.guideline,
                args.acceptance,
                args.reference,
                getattr(args, "permit", []),
                getattr(args, "tool", []),
                getattr(args, "epilogue", []),
                getattr(args, "nudge_on_completion", None) is not None,
                getattr(args, "require_acks", False),
                args.permissions_json,
                args.allow_pr,
                args.allow_merge_green,
                args.allow_worker_compact_clear,
            ]
        )
        permission_warnings: list[str] = []
        if mutating or existing is None:
            permissions = normalize_manager_permissions(existing["permissions"] if existing else None)
            permissions = add_manager_permission_flags(
                permissions,
                [
                    flag for flag, enabled in (
                        ("create_pr", args.allow_pr),
                        ("merge_green_pr", args.allow_merge_green),
                        ("worker_compact_clear", args.allow_worker_compact_clear),
                    )
                    if enabled
                ],
            )
            permissions = add_manager_permission_flags(permissions, getattr(args, "permit", []))
            permissions_json = _json_arg(args.permissions_json, flag="--permissions-json")
            permission_warnings = manager_permission_warnings(permissions_json)
            permissions = apply_manager_permission_overrides(permissions, permissions_json)
            tools = clean_manager_tools(getattr(args, "tool", []) or (existing["tools"] if existing else []))
            epilogues = clean_epilogue_steps(getattr(args, "epilogue", []) or (existing["epilogues"] if existing else []))
            nudge_on_completion = clean_nudge_on_completion(
                getattr(args, "nudge_on_completion", None)
                or (existing["nudge_on_completion"] if existing else "ask-operator")
            )
            worker_db.upsert_manager_config(
                conn,
                task_id=task["id"],
                supervision_mode=args.mode or (existing["supervision_mode"] if existing else "guided"),
                objective=args.objective if args.objective is not None else (existing["objective"] if existing else None),
                guidelines=args.guideline or (existing["guidelines"] if existing else []),
                acceptance_criteria=args.acceptance or (existing["acceptance_criteria"] if existing else []),
                reference_paths=args.reference or (existing["reference_paths"] if existing else []),
                permissions=permissions,
                tools=tools,
                epilogues=epilogues,
                nudge_on_completion=nudge_on_completion,
                require_acks=bool(getattr(args, "require_acks", False) or (existing["require_acks"] if existing else False)),
            )
            worker_db.insert_event(
                conn,
                "manager_config_recorded",
                actor="workerctl",
                task_id=task["id"],
                payload={
                    "acceptance_count": len(args.acceptance),
                    "epilogue_count": len(epilogues),
                    "guideline_count": len(args.guideline),
                    "permission_warnings": permission_warnings,
                    "reference_count": len(args.reference),
                    "require_acks": bool(getattr(args, "require_acks", False) or (existing["require_acks"] if existing else False)),
                    "nudge_on_completion": nudge_on_completion,
                    "supervision_mode": args.mode or (existing["supervision_mode"] if existing else "guided"),
                    "tool_count": len(tools),
                },
            )
            conn.commit()
        config = worker_db.manager_config(conn, task_id=task["id"])
        if permission_warnings:
            config = {**config, "warnings": permission_warnings}
    print(json.dumps(config, indent=2, sort_keys=True))
    return 0


def command_commands(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    filters = []
    params: list[Any] = []
    if args.task:
        filters.append("commands.task_id in (select id from tasks where id = ? or name = ?)")
        params.extend([args.task, args.task])
    if args.state:
        filters.append("commands.state = ?")
        params.append(args.state)
    if args.type:
        filters.append("commands.type = ?")
        params.append(args.type)
    if args.worker:
        filters.append("commands.worker_id = ?")
        params.append(args.worker)
    if args.manager:
        filters.append("commands.manager_id = ?")
        params.append(args.manager)
    where = f"where {' and '.join(filters)}" if filters else ""
    with connect_db(db_path) as conn:
        initialize_database(conn)
        rows = conn.execute(
            f"""
            select commands.id, commands.type, commands.state, commands.created_at,
                   commands.updated_at, commands.task_id, tasks.name as task_name,
                   commands.worker_id, commands.manager_id, commands.correlation_id,
                   commands.available_at, commands.claimed_by, commands.claimed_at,
                   commands.claim_expires_at, commands.attempts, commands.max_attempts,
                   commands.required_permission, commands.payload_json, commands.result_json,
                   commands.error
            from commands
            left join tasks on tasks.id = commands.task_id
            {where}
            order by commands.created_at, commands.id
            """,
            params,
        ).fetchall()
        attempts_by_command: dict[str, list[dict[str, Any]]] = {}
        if args.attempts and rows:
            command_ids = [row["id"] for row in rows]
            placeholders = ",".join("?" for _ in command_ids)
            attempt_rows = conn.execute(
                f"""
                select id, command_id, correlation_id, dispatcher_id, started_at,
                       finished_at, state, result_json, error, side_effect_started,
                       side_effect_completed
                from command_attempts
                where command_id in ({placeholders})
                order by command_id, id
                """,
                command_ids,
            ).fetchall()
            for attempt in attempt_rows:
                attempts_by_command.setdefault(attempt["command_id"], []).append(
                    {
                        "correlation_id": attempt["correlation_id"],
                        "dispatcher_id": attempt["dispatcher_id"],
                        "error": attempt["error"],
                        "finished_at": attempt["finished_at"],
                        "id": attempt["id"],
                        "result": json.loads(attempt["result_json"]) if attempt["result_json"] else None,
                        "side_effect_completed": bool(attempt["side_effect_completed"]),
                        "side_effect_started": bool(attempt["side_effect_started"]),
                        "started_at": attempt["started_at"],
                        "state": attempt["state"],
                    }
                )
    records = [
        {
            "created_at": row["created_at"],
            "error": row["error"],
            "id": row["id"],
            "attempts": row["attempts"],
            "available_at": row["available_at"],
            "claim_expires_at": row["claim_expires_at"],
            "claimed_at": row["claimed_at"],
            "claimed_by": row["claimed_by"],
            "correlation_id": row["correlation_id"],
            "manager_id": row["manager_id"],
            "max_attempts": row["max_attempts"],
            "payload": json.loads(row["payload_json"]),
            "required_permission": row["required_permission"],
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "state": row["state"],
            "task_id": row["task_id"],
            "task_name": row["task_name"],
            "type": row["type"],
            "updated_at": row["updated_at"],
            "worker_id": row["worker_id"],
            **({"attempt_history": attempts_by_command.get(row["id"], [])} if args.attempts else {}),
        }
        for row in rows
    ]
    if args.json:
        print(json.dumps(records, indent=2, sort_keys=True))
        return 0
    for record in records:
        suffix = ""
        if args.attempts:
            history = record.get("attempt_history") or []
            last_state = history[-1]["state"] if history else "-"
            suffix = f"\tattempt_history={len(history)}\tlast_attempt={last_state}"
        print(f"{record['id']}\t{record['state']}\t{record['type']}\t{record['task_name'] or '-'}{suffix}")
    return 0


def command_prune(args: argparse.Namespace) -> int:
    if args.keep_latest < 0:
        raise WorkerError("--keep-latest must be >= 0")
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        rows = conn.execute(
            """
            select id, worker_id
            from transcript_captures
            where content is not null
            order by worker_id, id desc
            """
        ).fetchall()
        seen: dict[str, int] = {}
        prune_ids = []
        for row in rows:
            worker_id = row["worker_id"]
            seen[worker_id] = seen.get(worker_id, 0) + 1
            if seen[worker_id] > args.keep_latest:
                prune_ids.append(row["id"])
        if prune_ids and not args.dry_run:
            conn.executemany(
                """
                update transcript_captures
                set content = null, capture_kind = 'metadata_only', retention_class = 'warm'
                where id = ?
                """,
                [(capture_id,) for capture_id in prune_ids],
            )
            insert_db_event(
                conn,
                "transcript_captures_pruned",
                actor="workerctl",
                payload={"capture_ids": prune_ids, "keep_latest": args.keep_latest},
            )
            conn.commit()
    result = {
        "dry_run": args.dry_run,
        "keep_latest": args.keep_latest,
        "pruned_count": 0 if args.dry_run else len(prune_ids),
        "would_prune_count": len(prune_ids),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def capture_task_terminal(
    db_path: Path | None,
    *,
    task: str,
    role: str,
    lines: int,
    source: str,
    command_id: str | None = None,
    transcript_mode: str = "none",
) -> dict[str, Any]:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=task)
        binding = active_task_worker(conn, task=task) if snapshot["worker"] else None
        try:
            session_binding = active_binding_for_task(conn, task_name=snapshot["name"])
        except WorkerError:
            try:
                session_binding = latest_session_binding_for_task(conn, task_name=snapshot["name"])
            except WorkerError:
                session_binding = None
        worker_session = (
            dict(session_by_id(conn, session_id=session_binding["worker_session_id"]))
            if session_binding
            else None
        )
        manager_session = (
            dict(session_by_id(conn, session_id=session_binding["manager_session_id"]))
            if session_binding
            else None
        )
        manager = active_manager(conn, task=snapshot["id"])

    if role == "worker":
        if binding is None and worker_session is None:
            raise WorkerError(f"Task {snapshot['name']} has no active worker")
        if binding is not None:
            verification = identity.verify_worker_binding_identity(binding)
            output = capture_output(binding["worker_name"], lines)
            tmux_session_value = binding["worker_tmux_session"]
            tmux_pane_id = verification.get("live_pane_id") or binding.get("worker_tmux_pane_id")
        else:
            verification = _verify_session_capture_identity(worker_session)
            proc = run(["tmux", "capture-pane", "-p", "-t", worker_session["tmux_session"], "-S", f"-{lines}"])
            output = proc.stdout
            tmux_session_value = worker_session["tmux_session"]
            tmux_pane_id = verification.get("live_pane_id") or worker_session.get("tmux_pane_id")
        worker_id = binding["worker_id"] if binding else None
        manager_id = None
    elif role == "manager":
        if manager is None and manager_session is None:
            raise WorkerError(f"Task {snapshot['name']} has no active manager")
        if manager is not None:
            verification = identity.verify_manager_identity(manager)
            tmux_session_value = manager["tmux_session"]
            tmux_pane_id = verification.get("live_pane_id") or manager.get("tmux_pane_id")
        else:
            verification = _verify_session_capture_identity(manager_session)
            tmux_session_value = manager_session["tmux_session"]
            tmux_pane_id = verification.get("live_pane_id") or manager_session.get("tmux_pane_id")
        proc = run(["tmux", "capture-pane", "-p", "-t", tmux_session_value, "-S", f"-{lines}"])
        output = proc.stdout
        worker_id = None
        manager_id = manager["id"] if manager else None
    else:
        raise WorkerError(f"Unsupported capture role: {role}")

    content_sha256 = hashlib.sha256(output.encode()).hexdigest()
    classifier = {
        "busy_wait": classify_busy_wait(output, status_age=10**9, busy_wait_seconds=0),
        "startup": classify_startup_output(output),
    }
    with connect_db(db_path) as conn:
        initialize_database(conn)
        previous_capture = latest_terminal_capture_for_role(conn, task_id=snapshot["id"], role=role)
        capture_id = insert_terminal_capture(
            conn,
            task_id=snapshot["id"],
            worker_id=worker_id,
            manager_id=manager_id,
            role=role,
            tmux_session=tmux_session_value,
            tmux_pane_id=tmux_pane_id,
            command_id=command_id,
            history_lines=lines,
            content_sha256=content_sha256,
            content=output,
            classifier=classifier,
            source=source,
        )
        transcript_segment = None
        if transcript_mode != "none":
            transcript_segment = record_transcript_segment(
                conn,
                task_id=snapshot["id"],
                role=role,
                source_capture_id=capture_id,
                previous_capture=previous_capture,
                content_sha256=content_sha256,
                content=output,
                mode=transcript_mode,
            )
        if role == "manager" and manager_id:
            mark_manager_seen(conn, manager_id=manager_id, last_capture_sha256=content_sha256)
        insert_db_event(
            conn,
            f"{role}_terminal_captured",
            actor="workerctl",
            command_id=command_id,
            task_id=snapshot["id"],
            worker_id=worker_id,
            manager_id=manager_id,
            payload={"capture_id": capture_id, "content_sha256": content_sha256, "history_lines": lines, "source": source},
        )
        observation_id = insert_agent_observation(
            conn,
            task_id=snapshot["id"],
            worker_id=worker_id,
            manager_id=manager_id,
            role=role,
            observation_type="capture",
            severity="info",
            source_capture_id=capture_id,
            command_id=command_id,
            message=f"{role} terminal captured",
            payload={
                "content_sha256": content_sha256,
                "history_lines": lines,
                "source": source,
                "transcript_segment_id": transcript_segment["id"] if transcript_segment else None,
            },
        )
        conn.commit()
    return {
        "binding_id": binding["binding_id"] if binding else None,
        "capture": {
            "classifier": classifier,
            "content_sha256": content_sha256,
            "history_lines": lines,
            "id": capture_id,
            "line_count": len(output.splitlines()),
            "output": output,
            "source": source,
        },
        "observation_id": observation_id,
        "role": role,
        "task": {"id": snapshot["id"], "name": snapshot["name"], "state": snapshot["state"]},
        "transcript_segment": transcript_segment,
        role: {
            "id": worker_id
            or manager_id
            or (
                worker_session["id"]
                if role == "worker" and worker_session
                else manager_session["id"] if role == "manager" and manager_session else None
            ),
            "name": (
                binding["worker_name"]
                if role == "worker" and binding
                else worker_session["name"]
                if role == "worker" and worker_session
                else manager["name"]
                if role == "manager" and manager
                else manager_session["name"]
                if role == "manager" and manager_session
                else None
            ),
            "state": (
                binding["worker_state"]
                if role == "worker" and binding
                else worker_session["state"]
                if role == "worker" and worker_session
                else manager["state"]
                if role == "manager" and manager
                else manager_session["state"]
                if role == "manager" and manager_session
                else None
            ),
            "tmux_pane_id": tmux_pane_id,
            "tmux_session": tmux_session_value,
        },
    }


def _verify_session_capture_identity(session: dict[str, Any] | None) -> dict[str, Any]:
    if session is None:
        raise WorkerError("session capture identity missing")
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


def segment_text_delta(previous: str | None, current: str) -> tuple[str | None, int | None, int | None, str]:
    current_lines = current.splitlines()
    if previous is None:
        if not current_lines:
            return ("", 1, 0, "reset")
        return (current, 1, len(current_lines), "reset")
    previous_lines = previous.splitlines()
    if previous_lines == current_lines:
        return (None, None, None, "metadata")
    max_overlap = min(len(previous_lines), len(current_lines))
    overlap = 0
    for size in range(max_overlap, 0, -1):
        if previous_lines[-size:] == current_lines[:size]:
            overlap = size
            break
    if overlap:
        new_lines = current_lines[overlap:]
        if not new_lines:
            return (None, None, None, "metadata")
        return ("\n".join(new_lines), overlap + 1, len(current_lines), "segment")
    return (current, 1, len(current_lines), "reset")


def record_transcript_segment(
    conn,
    *,
    task_id: str,
    role: str,
    source_capture_id: int,
    previous_capture: dict[str, Any] | None,
    content_sha256: str,
    content: str,
    mode: str,
) -> dict[str, Any] | None:
    previous_id = previous_capture["id"] if previous_capture else None
    previous_content = previous_capture.get("content") if previous_capture else None
    if previous_capture and previous_capture.get("content_sha256") == content_sha256 and mode not in {"metadata"}:
        return None
    segment_text, start_line, end_line, segment_kind = segment_text_delta(previous_content, content)
    if segment_text is None and mode != "metadata":
        return None
    if mode == "metadata":
        segment_text = None
        start_line = None
        end_line = None
        segment_kind = "metadata"
    elif mode == "excerpt":
        source_lines = (segment_text or content).splitlines()
        excerpt_lines = source_lines[-40:]
        segment_text = "\n".join(excerpt_lines)
        end_line = end_line if end_line is not None else len(content.splitlines())
        start_line = max(1, (end_line or 0) - len(excerpt_lines) + 1)
        segment_kind = "excerpt"
    elif mode == "snapshot":
        segment_text = content
        start_line = 1
        end_line = len(content.splitlines())
        segment_kind = "snapshot"
    elif mode == "full":
        segment_kind = "segment" if segment_kind != "reset" else "reset"
    elif mode != "segment":
        raise WorkerError(f"Unsupported transcript mode: {mode}")
    segment_id = insert_transcript_segment(
        conn,
        task_id=task_id,
        role=role,
        source_capture_id=source_capture_id,
        previous_capture_id=previous_id,
        content_sha256=content_sha256,
        segment_text=segment_text,
        segment_start_line=start_line,
        segment_end_line=end_line,
        segment_kind=segment_kind,
    )
    return {
        "id": segment_id,
        "line_count": len((segment_text or "").splitlines()),
        "mode": mode,
        "previous_capture_id": previous_id,
        "segment_kind": segment_kind,
        "source_capture_id": source_capture_id,
    }


def task_transcript_segments(db_path: Path | None, *, task: str, role: str = "all", limit: int | None = None) -> dict[str, Any]:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=task)
        where = "task_id = ?"
        params: list[Any] = [snapshot["id"]]
        if role != "all":
            where += " and role = ?"
            params.append(role)
        limit_clause = "limit ?" if limit else ""
        if limit:
            params.append(limit)
        rows = conn.execute(
            f"""
            select *
            from (
                select id, task_id, role, source_capture_id, previous_capture_id,
                       captured_at, content_sha256, segment_text, segment_start_line,
                       segment_end_line, byte_count, line_count, retention_class,
                       segment_kind, redacted, created_at
                from transcript_segments
                where {where}
                order by id desc
                {limit_clause}
            )
            order by id
            """,
            params,
        ).fetchall()
    return {
        "segments": [
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
            for row in rows
        ],
        "task": {"id": snapshot["id"], "name": snapshot["name"], "state": snapshot["state"]},
    }


def command_transcript_capture(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    roles = ("worker", "manager") if args.role == "all" else (args.role,)
    captures = []
    for role in roles:
        try:
            captures.append(
                capture_task_terminal(
                    db_path,
                    task=args.task,
                    role=role,
                    lines=args.lines,
                    source="transcript_capture",
                    transcript_mode=args.mode,
                )
            )
        except WorkerError as exc:
            if args.role != "all":
                raise
            captures.append({"error": str(exc), "role": role})
    if getattr(args, "require_segment", False):
        missing = []
        for capture in captures:
            segment = capture.get("transcript_segment")
            if capture.get("error") or not segment or int(segment.get("line_count") or 0) <= 0:
                missing.append(capture.get("role", "unknown"))
        if missing:
            raise WorkerError(
                "no non-empty transcript segment captured for role(s): "
                + ", ".join(missing)
            )
    result = {"captures": captures, "mode": args.mode, "role": args.role, "task": args.task}
    if args.json:
        if not getattr(args, "include_content", False):
            result = redact_capture_result(result)
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        for capture in captures:
            if capture.get("error"):
                print(f"{capture['role']}: {capture['error']}")
                continue
            segment = capture.get("transcript_segment")
            segment_text = "no new transcript segment" if segment is None else f"segment {segment['id']} ({segment['segment_kind']}, {segment['line_count']} lines)"
            print(f"{capture['role']}: capture {capture['capture']['id']} {segment_text}")
    return 0


def command_transcript_show(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    result = task_transcript_segments(db_path, task=args.task, role=args.role, limit=args.limit)
    if args.json:
        if not getattr(args, "include_content", False):
            result = redact_transcript_segments(result)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    for segment in result["segments"]:
        timestamp = segment["captured_at"].split("T", 1)[-1].replace("Z", "")
        print(f"--- {segment['role']} transcript segment {segment['id']} {timestamp} ({segment['segment_kind']}) ---")
        text = segment.get("segment_text")
        if text and getattr(args, "include_content", False):
            print(text)
        elif text:
            print(f"[content redacted: {len(text.splitlines())} lines, {len(text.encode())} bytes]")
        else:
            print("[metadata only]")
    return 0


def command_transcript_prune(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        rows = conn.execute(
            """
            select id, role
            from transcript_segments
            where task_id = ? and segment_text is not null
            order by role, id desc
            """,
            (snapshot["id"],),
        ).fetchall()
        seen: dict[str, int] = {}
        prune_ids = []
        for row in rows:
            role = row["role"]
            seen[role] = seen.get(role, 0) + 1
            if seen[role] > args.keep_latest:
                prune_ids.append(row["id"])
        if prune_ids and not args.dry_run:
            conn.executemany(
                """
                update transcript_segments
                set segment_text = null, retention_class = 'cold', segment_kind = 'metadata'
                where id = ?
                """,
                [(segment_id,) for segment_id in prune_ids],
            )
            insert_db_event(
                conn,
                "transcript_segments_pruned",
                actor="workerctl",
                task_id=snapshot["id"],
                payload={"keep_latest": args.keep_latest, "segment_ids": prune_ids},
            )
            conn.commit()
    result = {"dry_run": args.dry_run, "keep_latest": args.keep_latest, "pruned_count": 0 if args.dry_run else len(prune_ids), "would_prune_count": len(prune_ids)}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_audit(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        audit = task_audit(conn, task=args.task)
    if args.json:
        if not getattr(args, "include_content", False):
            audit = redact_audit(audit)
        print(json.dumps(audit, indent=2, sort_keys=True))
        return 0
    print(f"{audit['task']['name']}\t{audit['task']['state']}\t{audit['task']['goal']}")
    for event in audit["events"]:
        command = f"\tcommand={event['command_id']}" if event["command_id"] else ""
        print(f"{event['created_at']}\t{event['type']}\tactor={event['actor']}{command}")
    return 0


def command_mutation_audit(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        audit = task_audit(conn, task=args.task)
    result = mutation_audit_result(audit)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1
    print(f"{result['task']['name']}\tmutations={result['summary']['mutations']}\twarnings={result['summary']['with_warnings']}")
    for record in result["records"]:
        warning_text = ",".join(record["warnings"]) if record["warnings"] else "ok"
        linked = record["linked_decision"]["id"] if record["linked_decision"] else "-"
        print(f"{record['command']['created_at']}\t{record['command']['type']}\tdecision={linked}\t{warning_text}")
    return 0 if result["ok"] else 1


def command_events(args: argparse.Namespace) -> int:
    _worker_config_or_session(args.name)
    events, skipped = read_events_with_stats(args.name)
    if skipped:
        print(
            f"workerctl: {skipped} malformed event line(s) skipped",
            file=sys.stderr,
        )
    if args.type:
        events = [event for event in events if event.get("type") == args.type]
    if args.limit:
        events = events[-args.limit :]
    for event in events:
        print(json.dumps(event, sort_keys=True))
    return 0


def command_interrupt(args: argparse.Namespace) -> int:
    followup = None if args.no_followup else args.followup
    result = interrupt_worker(args.name, key=args.key, followup=followup, dry_run=args.dry_run)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_classify(args: argparse.Namespace) -> int:
    if args.text is not None:
        output = args.text
    elif args.file:
        output = Path(args.file).read_text()
    else:
        output = sys.stdin.read()
    startup, startup_reason = classify_startup_output(output)
    busy_wait = classify_busy_wait(output, args.status_age_seconds, args.busy_wait_seconds)
    result = {
        "busy_wait": busy_wait,
        "busy_wait_seconds": args.busy_wait_seconds,
        "startup": startup,
        "startup_reason": startup_reason,
        "status_age_seconds": args.status_age_seconds,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_nudge(args: argparse.Namespace) -> int:
    message = args.message
    try:
        send_text(args.name, message)
        append_event(args.name, "nudge", {"message": message})
        print(f"sent nudge to {args.name}")
        return 0
    except WorkerError as exc:
        if not str(exc).startswith("Unknown worker:"):
            raise

    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    with worker_db.connect() as conn:
        worker_db.initialize_database(conn)
        try:
            result = worker_tmux.send_text_to_session(
                conn, session_name=args.name, text=message,
            )
        except WorkerError as session_exc:
            raise WorkerError(
                f"Unknown worker: {args.name}; also failed to resolve registered session "
                f"{args.name!r}. For session-backed workers, use "
                f"`workerctl session-nudge {args.name} \"...\"`. "
                f"Session lookup error: {session_exc}"
            ) from session_exc
        worker_db.insert_event(
            conn,
            "session_nudged",
            actor="workerctl",
            payload={
                "legacy_command": "nudge",
                "session": args.name,
                "text_length": len(message),
                "success": True,
            },
        )
        conn.commit()
    print(f"sent nudge to session {result['session']} via session-nudge target {result['target']}")
    return 0


def command_stop(args: argparse.Namespace) -> int:
    config = _worker_config_or_session(args.name)
    if config.get("_workerctl_lookup_source") == "legacy":
        if args.message and session_exists(args.name):
            send_text(args.name, args.message)
            append_event(args.name, "stop_message", {"message": args.message})
        if session_exists(args.name):
            run(["tmux", "kill-session", "-t", tmux_target(args.name)])
            append_event(args.name, "stop", {"killed_session": True})
            print(f"stopped {args.name}")
        else:
            append_event(args.name, "stop", {"killed_session": False})
            print(f"{args.name} was not running")
        return 0

    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    target = _tmux_target_for_config(args.name, config)
    running = _session_exists_for_config(args.name, config)
    if args.message and running:
        with worker_db.connect() as conn:
            worker_db.initialize_database(conn)
            worker_tmux.send_text_to_session(conn, session_name=args.name, text=args.message)
            worker_db.insert_event(
                conn,
                "session_stop_message",
                actor="workerctl",
                payload={
                    "session": args.name,
                    "role": config.get("role"),
                    "text_length": len(args.message),
                    "target": target,
                },
            )
            conn.commit()

    killed = False
    if running:
        run(["tmux", "kill-session", "-t", target])
        killed = True
        print(f"stopped {args.name}")
    else:
        print(f"{args.name} was not running")

    stopped_at = now_iso()
    with worker_db.connect() as conn:
        worker_db.initialize_database(conn)
        conn.execute(
            "update sessions set state='gone', last_heartbeat_at=? where name=?",
            (stopped_at, args.name),
        )
        worker_db.insert_event(
            conn,
            "session_stopped",
            actor="workerctl",
            payload={
                "session": args.name,
                "role": config.get("role"),
                "target": target,
                "killed_session": killed,
            },
        )
        conn.commit()
    append_event(
        args.name,
        "stop",
        {
            "killed_session": killed,
            "lookup_source": "session",
            "role": config.get("role"),
            "target": target,
        },
    )
    return 0


_CODEX_ROLLOUT_PATTERN = re.compile(r"(/[^ \t]+\.codex/sessions/[^ \t]+\.jsonl)")


def _lsof_codex_rollout(pid: int) -> str | None:
    """Run lsof -p <pid> and extract the rollout JSONL path, if found.

    Returns the path string or None if not found or lsof fails.
    """
    try:
        proc = subprocess.run(
            ["lsof", "-p", str(pid)],
            capture_output=True, text=True, check=False, timeout=5.0,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        # lsof returns non-zero if some fds can't be inspected — but stdout may still be useful.
        pass
    for line in proc.stdout.splitlines():
        m = _CODEX_ROLLOUT_PATTERN.search(line)
        if m:
            return m.group(1)
    return None


def _parse_rollout_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _register_session_from_args(args: argparse.Namespace, *, role: str) -> dict:
    from workerctl import codex_session as cs
    from workerctl import db as worker_db

    codex_session = args.codex_session
    if codex_session is None and args.pid is not None:
        # When --codex-session is omitted but --pid is given, use lsof to find the rollout.
        codex_session = _lsof_codex_rollout(args.pid)
        if codex_session is None:
            raise WorkerError(
                f"could not find a codex rollout JSONL for pid {args.pid} via lsof. "
                "The codex session may not have written its rollout yet — type any "
                "input into the codex prompt and retry, or pass --codex-session explicitly."
            )

    if codex_session:
        rollout_path = Path(codex_session)
        meta = cs.read_session_meta(rollout_path)
        codex_session_path = str(rollout_path)
        codex_session_id = meta["id"]
        cwd = args.cwd or meta.get("cwd", "")
        pid = args.pid
        if pid is None:
            raise WorkerError("--pid is required when --codex-session is supplied")
    else:
        raise WorkerError("must supply --pid or --codex-session")

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    conn = worker_db.connect(db_path)
    worker_db.initialize_database(conn)
    try:
        session_id = worker_db.register_session(
            conn,
            name=args.name,
            role=role,
            codex_session_path=codex_session_path,
            codex_session_id=codex_session_id,
            pid=pid,
            cwd=cwd,
            tmux_session=getattr(args, "tmux_session", None),
        )
        worker_db.insert_event(
            conn,
            "session_registered",
            actor="workerctl",
            payload={
                "name": args.name, "role": role, "session_id": session_id,
                "pid": pid, "codex_session_id": codex_session_id,
            },
        )
        conn.commit()
        return {
            "session_id": session_id, "name": args.name, "role": role,
            "pid": pid, "codex_session_id": codex_session_id,
            "codex_session_path": codex_session_path, "cwd": cwd,
        }
    finally:
        conn.close()


def command_register_worker(args: argparse.Namespace) -> int:
    result = _register_session_from_args(args, role="worker")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_register_manager(args: argparse.Namespace) -> int:
    result = _register_session_from_args(args, role="manager")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def _discover_codex_session_in_tmux(
    tmux_session: str,
    *,
    timeout_seconds: int = 15,
    poll_interval: float = 0.5,
    minimum_session_timestamp: datetime | None = None,
) -> dict:
    """Poll until we find the native codex pid + open rollout in a tmux session's
    process tree. Raises WorkerError on timeout.

    The tmux pane runs the user's shell which forks the `codex` wrapper, which in
    turn spawns the native binary that holds the rollout file open. We walk the
    pane's process tree breadth-first and probe each pid via lsof, returning the
    first one whose open files include a `rollout-*.jsonl` path.

    Returns dict: {native_pid, codex_session_path, codex_session_id, cwd, originator, cli_version}.
    """
    import time

    from workerctl import codex_session as cs
    from workerctl import tmux as worker_tmux

    deadline = time.monotonic() + timeout_seconds
    last_error: str | None = None
    while time.monotonic() < deadline:
        try:
            proc = worker_tmux.run(
                ["tmux", "list-panes", "-t", tmux_session, "-F", "#{pane_pid}"],
                check=False,
            )
            if proc.returncode != 0:
                last_error = (
                    f"tmux list-panes failed: {proc.stderr.strip() or proc.stdout.strip()}"
                )
                time.sleep(poll_interval)
                continue
            shell_pid_str = ""
            for line in proc.stdout.splitlines():
                stripped = line.strip()
                if stripped:
                    shell_pid_str = stripped
                    break
            if not shell_pid_str:
                last_error = "tmux pane has no pid yet"
                time.sleep(poll_interval)
                continue
            try:
                shell_pid = int(shell_pid_str)
            except ValueError:
                last_error = f"tmux pane pid is not an integer: {shell_pid_str!r}"
                time.sleep(poll_interval)
                continue

            # Walk pid children breadth-first looking for one that holds a rollout open.
            queue: list[int] = [shell_pid]
            visited: set[int] = set()
            while queue:
                pid = queue.pop(0)
                if pid in visited:
                    continue
                visited.add(pid)
                try:
                    rollout_path = cs.find_rollout_path_for_pid(pid)
                except cs.CodexSessionError:
                    queue.extend(cs._ps_children_default(pid))
                    continue
                meta = cs.read_session_meta(rollout_path)
                meta_timestamp = _parse_rollout_timestamp(meta.get("timestamp"))
                if minimum_session_timestamp is not None and meta_timestamp is None:
                    last_error = (
                        "found codex rollout "
                        f"{rollout_path} without parseable session timestamp; "
                        "waiting for fresh session_meta"
                    )
                    continue
                if (
                    minimum_session_timestamp is not None
                    and meta_timestamp < minimum_session_timestamp
                ):
                    last_error = (
                        "found stale codex rollout "
                        f"{rollout_path} from {meta_timestamp.isoformat()}; "
                        "waiting for fresh session_meta"
                    )
                    continue
                return {
                    "native_pid": pid,
                    "codex_session_path": str(rollout_path),
                    "codex_session_id": meta["id"],
                    "cwd": meta.get("cwd", ""),
                    "originator": meta.get("originator", ""),
                    "cli_version": meta.get("cli_version", ""),
                }
            last_error = "no codex rollout open in tmux pane process tree yet"
        except Exception as exc:  # noqa: BLE001 - want to surface as polling error
            last_error = str(exc)
        time.sleep(poll_interval)

    raise WorkerError(
        f"codex did not write session_meta within {timeout_seconds}s "
        f"in tmux session {tmux_session!r}: {last_error}"
    )


def _spawn_codex_and_register(
    *,
    name: str,
    role: str,
    cwd: str | None = None,
    task: str | None = None,
    initial_prompt: str | None = None,
    sandbox: str | None = None,
    ask_for_approval: str | None = None,
    timeout_seconds: int = 60,
) -> dict:
    """Spawn codex in a fresh tmux session and register it in one call.

    Common logic for start-worker and start-manager. Spawns tmux + codex,
    discovers the pid + rollout, and registers the session in the DB.

    Refuses if either the tmux session `codex-<name>` already exists or the DB
    already has a session named `<name>`.

    Returns dict: {session_id, name, role, pid, codex_session_id, codex_session_path, cwd, tmux_session}.
    """
    import shlex

    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    tmux_session_name = f"codex-{name}"

    # Pre-flight: refuse if name is taken in DB.
    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        existing = conn.execute(
            "select id from sessions where name = ?", (name,)
        ).fetchone()
        if existing is not None:
            raise WorkerError(
                f"a session named {name!r} is already registered; "
                f"choose a different name or `workerctl deregister {name}` first"
            )
    finally:
        conn.close()

    # Pre-flight: refuse if tmux session already exists.
    if worker_tmux.session_exists(name):
        raise WorkerError(
            f"tmux session {tmux_session_name!r} already exists; "
            f"choose a different name or `tmux kill-session -t {tmux_session_name}` first"
        )

    # Build the codex command. An initial prompt opens Codex's rollout metadata
    # reliably and gives manager sessions setup context without assigning them
    # the worker task.
    codex_executable = shutil.which("codex") or "codex"
    codex_args: list[str] = [codex_executable]
    if sandbox:
        codex_args += ["--sandbox", sandbox]
    if ask_for_approval:
        codex_args += ["--ask-for-approval", ask_for_approval]
    prompt = initial_prompt if initial_prompt is not None else task
    if prompt:
        codex_args.append(prompt)
    codex_cmd = " ".join(shlex.quote(a) for a in codex_args)

    # Spawn tmux + codex. Discovery must ignore older rollout files briefly held
    # by a newly-started Codex process before it opens the fresh session file.
    spawn_started_at = datetime.now(timezone.utc)
    worker_tmux.run([
        "tmux", "new-session", "-d", "-s", tmux_session_name, "-c", cwd, codex_cmd,
    ])

    # Discover codex pid + rollout.
    try:
        discovery = _discover_codex_session_in_tmux(
            tmux_session_name,
            timeout_seconds=timeout_seconds,
            minimum_session_timestamp=spawn_started_at,
        )
    except WorkerError as exc:
        raise WorkerError(
            f"{exc}\n"
            f"Recovery: tmux session {tmux_session_name!r} may still be alive. "
            f"Inspect it with `tmux attach -t {tmux_session_name}`. If Codex is visible, "
            "submit a prompt or press Enter, then register it with "
            f"`workerctl register-{role} --name {name} --pid <pid> "
            f"--codex-session <rollout.jsonl> --cwd {shlex.quote(str(cwd or ''))} "
            f"--tmux-session {tmux_session_name}`. To clean up, run "
            f"`tmux kill-session -t {tmux_session_name}` and `workerctl deregister {name}` "
            "if it was registered."
        ) from exc

    # Register the session.
    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        session_id = worker_db.register_session(
            conn,
            name=name,
            role=role,
            codex_session_path=discovery["codex_session_path"],
            codex_session_id=discovery["codex_session_id"],
            pid=discovery["native_pid"],
            cwd=cwd,
            tmux_session=tmux_session_name,
        )
        worker_db.insert_event(
            conn, "session_registered", actor="workerctl",
            payload={
                "name": name, "role": role, "session_id": session_id,
                "pid": discovery["native_pid"],
                "codex_session_id": discovery["codex_session_id"],
                "via": f"start-{role}",
            },
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "session_id": session_id,
        "name": name,
        "role": role,
        "pid": discovery["native_pid"],
        "codex_session_id": discovery["codex_session_id"],
        "codex_session_path": discovery["codex_session_path"],
        "cwd": cwd,
        "tmux_session": tmux_session_name,
    }


def command_start_worker(args: argparse.Namespace) -> int:
    """Spawn codex in a fresh tmux session and register it as a worker in one call.

    Equivalent to: `tmux new-session -d -s codex-<name>` running `codex <flags>`,
    followed by `workerctl register-worker --pid <discovered>`. Polls for codex's
    open rollout file to confirm the session is up before registering.

    Refuses if either the tmux session `codex-<name>` already exists or the DB
    already has a session named `<name>`.
    """
    sandbox, ask_for_approval = resolve_codex_startup_options(
        profile=getattr(args, "codex_profile", None),
        sandbox=args.sandbox,
        ask_for_approval=args.ask_for_approval,
    )
    result = _spawn_codex_and_register(
        name=args.name,
        role="worker",
        cwd=args.cwd,
        task=args.task,
        sandbox=sandbox,
        ask_for_approval=ask_for_approval,
        timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_start_manager(args: argparse.Namespace) -> int:
    """Spawn codex in a fresh tmux session and register it as a manager in one call.

    Mirrors command_start_worker but with role="manager" and a manager bootstrap
    prompt. Managers supervise rather than execute; optional task context only
    teaches the bootstrap prompt which workerctl commands to run.

    Refuses if either the tmux session `codex-<name>` already exists or the DB
    already has a session named `<name>`.
    """
    sandbox, ask_for_approval = resolve_codex_startup_options(
        profile=getattr(args, "codex_profile", None),
        sandbox=args.sandbox,
        ask_for_approval=args.ask_for_approval,
    )
    task_name = getattr(args, "task", None)
    task_goal = getattr(args, "task_goal", None)
    manager_config_seeded = False
    manager_config = None
    if task_name:
        from workerctl import db as worker_db

        with worker_db.connect() as conn:
            worker_db.initialize_database(conn)
            try:
                task = worker_db.task_row(conn, task=task_name)
            except WorkerError:
                task = None
            if task is not None:
                task_goal = task_goal or task["goal"]
                manager_config = worker_db.manager_config(conn, task_id=task["id"])
                manager_config_seeded = manager_config is not None
    result = _spawn_codex_and_register(
        name=args.name,
        role="manager",
        cwd=args.cwd,
        task=None,
        initial_prompt=manager_bootstrap_prompt(
            manager_name=args.name,
            cwd=args.cwd,
            task_name=task_name,
            task_goal=task_goal,
            worker_name=getattr(args, "worker", None),
            manager_config_seeded=manager_config_seeded,
            manager_config=manager_config,
        ),
        sandbox=sandbox,
        ask_for_approval=ask_for_approval,
        timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def pair_manager_config_requested(args: argparse.Namespace) -> bool:
    return any(
        [
            getattr(args, "manager_mode", None) is not None,
            getattr(args, "manager_objective", None) is not None,
            bool(getattr(args, "manager_guideline", None)),
            bool(getattr(args, "manager_acceptance", None)),
            bool(getattr(args, "manager_reference", None)),
            bool(getattr(args, "manager_permit", None)),
            bool(getattr(args, "manager_tool", None)),
            bool(getattr(args, "manager_epilogue", None)),
            getattr(args, "manager_nudge_on_completion", None) is not None,
            bool(getattr(args, "manager_require_acks", False)),
            getattr(args, "manager_permissions_json", None) is not None,
            bool(getattr(args, "manager_allow_pr", False)),
            bool(getattr(args, "manager_allow_merge_green", False)),
            bool(getattr(args, "manager_allow_worker_compact_clear", False)),
        ]
    )


def command_pair(args: argparse.Namespace) -> int:
    """Spawn worker + manager and bind to a task in one shot.

    Combines start-worker + start-manager + bind. If the task doesn't exist
    and no --task-goal is provided, raises an error with a hint.
    """
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if hasattr(args, 'path') and args.path else None
    dispatch_payload = pair_dispatch_payload(args, db_path)
    if getattr(args, "dry_run", False):
        payload = {
            "dispatch_command": dispatch_payload["dispatch_command"],
            "ensure_dispatch": dispatch_payload["ensure_dispatch"],
            "manager": args.manager_name,
            "task": args.task,
            "worker": args.worker_name,
        }
        if getattr(args, "json", False):
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    task_id = None
    task_created = False
    manager_config_seeded = False
    manager_config_seeded_by_pair = False
    manager_acceptance_criteria_seeded: list[int] = []
    run_id = None
    binding_id = None
    worker_info = None
    manager_info = None

    def record_pair_telemetry(
        event_type: str,
        summary: str,
        *,
        severity: str = "info",
        extra_correlation: dict[str, Any] | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        if task_id is None:
            return
        correlation = {
            "binding_id": binding_id,
            "manager": args.manager_name,
            "source": "pair",
            "task": args.task,
            "worker": args.worker_name,
        }
        if extra_correlation:
            correlation.update(extra_correlation)
        with worker_db.connect(db_path) as telemetry_conn:
            worker_db.initialize_database(telemetry_conn)
            worker_db.emit_telemetry_event(
                telemetry_conn,
                actor="workerctl",
                event_type=event_type,
                severity=severity,
                summary=summary,
                run_id=run_id,
                task_id=task_id,
                correlation=correlation,
                attributes=attributes or {},
            )

    # 1. Task lookup/create
    conn = worker_db.connect(db_path)
    worker_db.initialize_database(conn)
    try:
        task_row = None
        try:
            task_row = worker_db.task_row(conn, task=args.task)
        except WorkerError:
            pass

        if task_row is None:
            if not args.task_goal:
                raise WorkerError(
                    f"Task '{args.task}' does not exist. Pass --task-goal to "
                    "create it, or run `workerctl tasks --create ...` first."
                )
            task_id = worker_db.create_task(
                conn,
                name=args.task,
                goal=args.task_goal,
                summary=args.task_summary,
            )
            task_created = True
            conn.commit()
        else:
            task_id = task_row["id"]
        worker_db.emit_telemetry_event(
            conn,
            actor="workerctl",
            event_type="pair_started",
            summary=f"Started pair setup for task {args.task}.",
            task_id=task_id,
            correlation={
                "manager": args.manager_name,
                "source": "pair",
                "task": args.task,
                "worker": args.worker_name,
            },
            attributes={
                "cwd": args.cwd,
                "task_created": task_created,
                "task_goal_provided": bool(args.task_goal),
            },
        )
        worker_db.emit_telemetry_event(
            conn,
            actor="workerctl",
            event_type="pair_task_resolved",
            summary=f"{'Created' if task_created else 'Resolved'} task {args.task}.",
            task_id=task_id,
            correlation={
                "manager": args.manager_name,
                "source": "pair",
                "task": args.task,
                "worker": args.worker_name,
            },
            attributes={"created": task_created},
        )

        existing_manager_config = worker_db.manager_config(conn, task_id=task_id)
        if pair_manager_config_requested(args):
            permissions = normalize_manager_permissions(
                existing_manager_config["permissions"] if existing_manager_config else None
            )
            permissions = add_manager_permission_flags(
                permissions,
                [
                    flag for flag, enabled in (
                        ("create_pr", getattr(args, "manager_allow_pr", False)),
                        ("merge_green_pr", getattr(args, "manager_allow_merge_green", False)),
                        ("worker_compact_clear", getattr(args, "manager_allow_worker_compact_clear", False)),
                    )
                    if enabled
                ],
            )
            permissions = add_manager_permission_flags(permissions, getattr(args, "manager_permit", None) or [])
            permissions = apply_manager_permission_overrides(
                permissions,
                _json_arg(getattr(args, "manager_permissions_json", None), flag="--manager-permissions-json"),
            )
            tools = clean_manager_tools(
                getattr(args, "manager_tool", None) or (existing_manager_config["tools"] if existing_manager_config else [])
            )
            epilogues = clean_epilogue_steps(
                getattr(args, "manager_epilogue", None) or (existing_manager_config["epilogues"] if existing_manager_config else [])
            )
            nudge_on_completion = clean_nudge_on_completion(
                getattr(args, "manager_nudge_on_completion", None)
                or (existing_manager_config["nudge_on_completion"] if existing_manager_config else "ask-operator")
            )
            worker_db.upsert_manager_config(
                conn,
                task_id=task_id,
                supervision_mode=getattr(args, "manager_mode", None)
                or (existing_manager_config["supervision_mode"] if existing_manager_config else "guided"),
                objective=getattr(args, "manager_objective", None)
                if getattr(args, "manager_objective", None) is not None
                else (existing_manager_config["objective"] if existing_manager_config else None),
                guidelines=getattr(args, "manager_guideline", None)
                or (existing_manager_config["guidelines"] if existing_manager_config else []),
                acceptance_criteria=getattr(args, "manager_acceptance", None)
                or (existing_manager_config["acceptance_criteria"] if existing_manager_config else []),
                reference_paths=getattr(args, "manager_reference", None)
                or (existing_manager_config["reference_paths"] if existing_manager_config else []),
                permissions=permissions,
                tools=tools,
                epilogues=epilogues,
                nudge_on_completion=nudge_on_completion,
                require_acks=bool(
                    getattr(args, "manager_require_acks", False)
                    or (existing_manager_config["require_acks"] if existing_manager_config else False)
                ),
            )
            existing_manager_config = worker_db.manager_config(conn, task_id=task_id)
            manager_config_seeded_by_pair = True
            worker_db.insert_event(
                conn,
                "manager_config_recorded",
                actor="workerctl",
                task_id=task_id,
                payload={
                    "acceptance_count": len(existing_manager_config["acceptance_criteria"]),
                    "guideline_count": len(existing_manager_config["guidelines"]),
                    "reference_count": len(existing_manager_config["reference_paths"]),
                    "nudge_on_completion": existing_manager_config["nudge_on_completion"],
                    "source": "pair",
                    "supervision_mode": existing_manager_config["supervision_mode"],
                },
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="pair_manager_config_seeded",
                summary=f"Seeded manager config for task {args.task}.",
                task_id=task_id,
                correlation={
                    "manager": args.manager_name,
                    "source": "pair",
                    "task": args.task,
                    "worker": args.worker_name,
                },
                attributes={
                    "acceptance_count": len(existing_manager_config["acceptance_criteria"]),
                    "guideline_count": len(existing_manager_config["guidelines"]),
                    "reference_count": len(existing_manager_config["reference_paths"]),
                    "nudge_on_completion": existing_manager_config["nudge_on_completion"],
                    "supervision_mode": existing_manager_config["supervision_mode"],
                },
            )
        if existing_manager_config is not None:
            manager_acceptance_criteria_seeded = worker_db.seed_manager_acceptance_criteria(
                conn,
                task_id=task_id,
                criteria=existing_manager_config["acceptance_criteria"],
            )
            if manager_acceptance_criteria_seeded:
                worker_db.insert_event(
                    conn,
                    "manager_acceptance_criteria_seeded",
                    actor="workerctl",
                    task_id=task_id,
                    payload={
                        "criterion_ids": manager_acceptance_criteria_seeded,
                        "source": "manager_config",
                    },
                )
        manager_config_seeded = existing_manager_config is not None
        conn.commit()
    finally:
        conn.close()

    sandbox, ask_for_approval = resolve_codex_startup_options(
        profile=getattr(args, "codex_profile", None),
        sandbox=args.sandbox,
        ask_for_approval=args.ask_for_approval,
    )
    try:
        # 2. Worker spawn
        worker_info = _spawn_codex_and_register(
            name=args.worker_name,
            role="worker",
            cwd=args.cwd,
            task=worker_ack_task_prompt(args.task, args.task_prompt),
            sandbox=sandbox,
            ask_for_approval=ask_for_approval,
            timeout_seconds=args.timeout_seconds,
        )
        record_pair_telemetry(
            "pair_worker_spawned",
            f"Spawned worker session {args.worker_name}.",
            extra_correlation={"worker_session_id": worker_info.get("session_id")},
            attributes={
                "codex_session_id": worker_info.get("codex_session_id"),
                "codex_session_path": worker_info.get("codex_session_path"),
                "pid": worker_info.get("pid"),
                "tmux_session": worker_info.get("tmux_session"),
            },
        )

        # 3. Manager spawn
        manager_info = _spawn_codex_and_register(
            name=args.manager_name,
            role="manager",
            cwd=args.cwd,
            task=None,
            initial_prompt=manager_bootstrap_prompt(
                manager_name=args.manager_name,
                cwd=args.cwd,
                task_name=args.task,
                task_goal=args.task_goal if task_created else task_row["goal"],
                worker_name=args.worker_name,
                manager_config_seeded=manager_config_seeded,
                manager_config=existing_manager_config,
            ),
            sandbox=sandbox,
            ask_for_approval=ask_for_approval,
            timeout_seconds=args.timeout_seconds,
        )
        record_pair_telemetry(
            "pair_manager_spawned",
            f"Spawned manager session {args.manager_name}.",
            extra_correlation={"manager_session_id": manager_info.get("session_id")},
            attributes={
                "codex_session_id": manager_info.get("codex_session_id"),
                "codex_session_path": manager_info.get("codex_session_path"),
                "pid": manager_info.get("pid"),
                "tmux_session": manager_info.get("tmux_session"),
            },
        )

        # 4. Bind
        conn = worker_db.connect(db_path)
        worker_db.initialize_database(conn)
        try:
            binding_id = worker_db.bind_sessions(
                conn,
                task_name=args.task,
                worker_session_name=args.worker_name,
                manager_session_name=args.manager_name,
            )
            worker_db.insert_event(
                conn, "binding_created", actor="workerctl",
                task_id=task_id,
                payload={
                    "binding_id": binding_id, "task": args.task,
                    "worker": args.worker_name, "manager": args.manager_name,
                },
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="pair_binding_created",
                summary=f"Bound worker {args.worker_name} and manager {args.manager_name}.",
                task_id=task_id,
                correlation={
                    "binding_id": binding_id,
                    "manager": args.manager_name,
                    "source": "pair",
                    "task": args.task,
                    "worker": args.worker_name,
                },
                attributes={
                    "manager_session_id": manager_info.get("session_id"),
                    "worker_session_id": worker_info.get("session_id"),
                },
            )
            run_id = worker_db.create_run(
                conn,
                task_id=task_id,
                purpose=args.task_goal if task_created else task_row["goal"],
                metadata={
                    "binding_id": binding_id,
                    "manager": args.manager_name,
                    "manager_config_seeded": manager_config_seeded,
                    "manager_config_seeded_by_pair": manager_config_seeded_by_pair,
                    "source": "pair",
                    "worker": args.worker_name,
                },
            )
            worker_db.insert_event(
                conn,
                "run_created",
                actor="workerctl",
                task_id=task_id,
                payload={"run_id": run_id, "source": "pair"},
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="pair_run_created",
                summary=f"Created active telemetry run for pair task {args.task}.",
                run_id=run_id,
                task_id=task_id,
                correlation={
                    "binding_id": binding_id,
                    "manager": args.manager_name,
                    "source": "pair",
                    "task": args.task,
                    "worker": args.worker_name,
                },
                attributes={
                    "manager_config_seeded": manager_config_seeded,
                    "manager_config_seeded_by_pair": manager_config_seeded_by_pair,
                    "manager_acceptance_criteria_seeded": len(manager_acceptance_criteria_seeded),
                },
            )
            conn.commit()
        finally:
            conn.close()

        dispatch_result = {
            "command": dispatch_payload["dispatch_command"],
            "ensure": dispatch_payload["ensure_dispatch"],
            "pid": None,
            "started": False,
        }
        if dispatch_payload["ensure_dispatch"] and dispatch_payload["dispatch_command"]:
            if _recent_active_dispatch_heartbeat(db_path) is None:
                dispatch_process = subprocess.Popen(
                    dispatch_payload["dispatch_command"],
                    cwd=PROJECT_ROOT,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                dispatch_result["pid"] = dispatch_process.pid
                dispatch_result["started"] = True
                _release_detached_popen_handle(dispatch_process)

        result = {
            "task": {"name": args.task, "id": task_id, "created": task_created},
            "worker": worker_info,
            "manager": manager_info,
            "binding_id": binding_id,
            "run_id": run_id,
            "dispatch": dispatch_result,
            "dispatch_command": dispatch_payload["dispatch_command"],
            "ensure_dispatch": dispatch_payload["ensure_dispatch"],
            "manager_config_seeded": manager_config_seeded,
            "manager_config_seeded_by_pair": manager_config_seeded_by_pair,
            "manager_acceptance_criteria_seeded": len(manager_acceptance_criteria_seeded),
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        try:
            record_pair_telemetry(
                "pair_failed",
                f"Pair setup failed for task {args.task}.",
                severity="error",
                attributes={
                    "binding_created": binding_id is not None,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "manager_spawned": manager_info is not None,
                    "run_created": run_id is not None,
                    "worker_spawned": worker_info is not None,
                },
            )
        except Exception:
            pass
        # If binding or manager spawn fails, worker is left registered.
        # User can clean up with `workerctl deregister`.
        raise


def command_deregister(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        session = conn.execute(
            "select id, role from sessions where name = ?",
            (args.name,),
        ).fetchone()
        active_binding = None
        task_id = None
        command_id = None
        if session is not None:
            active_binding = conn.execute(
                """
                select bindings.id, bindings.task_id
                from bindings
                where bindings.state in ('active', 'ending')
                  and (bindings.worker_session_id = ? or bindings.manager_session_id = ?)
                limit 1
                """,
                (session["id"], session["id"]),
            ).fetchone()
            task_id = active_binding["task_id"] if active_binding is not None else None
            command_id = worker_db.create_command(
                conn,
                command_type="deregister_session",
                task_id=task_id,
                payload={
                    "active_binding": dict(active_binding) if active_binding is not None else None,
                    "expected_failure": active_binding is not None,
                    "name": args.name,
                    "role": session["role"],
                },
            )
            worker_db.mark_command_attempted(conn, command_id=command_id)
        worker_db.deregister_session(conn, name=args.name)
        worker_db.insert_event(
            conn, "session_deregistered", actor="workerctl",
            command_id=command_id,
            task_id=task_id,
            payload={"name": args.name},
        )
        if command_id is not None:
            worker_db.finish_command(
                conn,
                command_id=command_id,
                state="succeeded",
                result={"command_id": command_id, "name": args.name, "state": "gone"},
            )
        conn.commit()
    except Exception as exc:
        if command_id is not None:
            worker_db.finish_command(
                conn,
                command_id=command_id,
                state="failed",
                result={
                    "active_binding": dict(active_binding) if active_binding is not None else None,
                    "command_id": command_id,
                    "expected_failure": active_binding is not None,
                    "name": args.name,
                },
                error=str(exc),
            )
            worker_db.insert_event(
                conn,
                "session_deregister_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=task_id,
                payload={
                    "active_binding": dict(active_binding) if active_binding is not None else None,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "expected_failure": active_binding is not None,
                    "name": args.name,
                },
            )
            conn.commit()
        raise
    finally:
        conn.close()
    print(json.dumps({"name": args.name, "state": "gone"}))
    return 0


def command_sessions(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        rows = worker_db.list_sessions(
            conn,
            role=args.role,
            include_legacy=args.include_legacy,
            state=args.state,
        )
    finally:
        conn.close()
    print(json.dumps(rows, indent=2, sort_keys=True, default=str))
    return 0


def _matches_query(value: Any, query: str) -> bool:
    if not query:
        return True
    if value is None:
        return False
    if isinstance(value, (dict, list, tuple)):
        haystack = json.dumps(value, sort_keys=True, default=str)
    else:
        haystack = str(value)
    return query.lower() in haystack.lower()


def _row_matches_query(row: dict[str, Any], query: str, fields: list[str]) -> bool:
    return any(_matches_query(row.get(field), query) for field in fields)


def _active_bindings(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        select bindings.id, bindings.state, bindings.created_at,
               tasks.name as task_name, tasks.goal as task_goal,
               ws.name as worker_name, ws.state as worker_state, ws.tmux_session as worker_tmux_session,
               ms.name as manager_name, ms.state as manager_state, ms.tmux_session as manager_tmux_session
        from bindings
        join tasks on tasks.id = bindings.task_id
        left join sessions ws on ws.id = bindings.worker_session_id
        left join sessions ms on ms.id = bindings.manager_session_id
        where bindings.state in ('active', 'ending')
        order by bindings.created_at desc
        """
    ).fetchall()
    return [dict(row) for row in rows]


def _discover_suggestions(tasks: list[dict[str, Any]], sessions: list[dict[str, Any]], bindings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    active_bound_tasks = {binding["task_name"] for binding in bindings if binding.get("task_name")}
    workers = [session for session in sessions if session.get("role") == "worker" and session.get("state") == "active"]
    managers = [session for session in sessions if session.get("role") == "manager" and session.get("state") == "active"]
    for task in tasks:
        if task.get("state") not in {"candidate", "managed", "paused"}:
            continue
        if task.get("name") in active_bound_tasks:
            continue
        if workers and managers:
            suggestions.append({
                "command": (
                    f"workerctl bind --task {sh_quote(str(task['name']))} "
                    f"--worker {sh_quote(str(workers[0]['name']))} "
                    f"--manager {sh_quote(str(managers[0]['name']))}"
                ),
                "kind": "bind",
                "manager": managers[0]["name"],
                "task": task["name"],
                "worker": workers[0]["name"],
            })
            break
    if not workers:
        suggestions.append({
            "kind": "register-worker",
            "prompt": "Open the intended worker Codex session and ask it to use the manage-codex-workers skill to register as the worker for this dashboard setup.",
        })
    if not managers:
        suggestions.append({
            "kind": "register-manager",
            "prompt": "Open the intended manager Codex session and ask it to use the manage-codex-workers skill to register as the manager for this dashboard setup.",
        })
    return suggestions


def command_discover(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    query = args.query.strip()
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        tasks = worker_db.list_tasks(conn, active_only=not args.all)
        sessions = worker_db.list_sessions(conn, state="all" if args.all else "active")
        bindings = _active_bindings(conn)
        telemetry = worker_db.query_telemetry_events(conn, search=query or None, limit=args.limit) if query else []

    matched_tasks = [
        task for task in tasks
        if _row_matches_query(task, query, ["name", "goal", "summary", "state"])
    ][:args.limit]
    matched_sessions = [
        session for session in sessions
        if _row_matches_query(session, query, ["name", "role", "state", "cwd", "tmux_session", "codex_session_id"])
    ][:args.limit]
    matched_bindings = [
        binding for binding in bindings
        if _row_matches_query(binding, query, ["task_name", "task_goal", "worker_name", "manager_name", "state"])
    ][:args.limit]
    payload = {
        "bindings": matched_bindings,
        "query": query,
        "sessions": matched_sessions,
        "suggestions": _discover_suggestions(matched_tasks, matched_sessions, matched_bindings),
        "tasks": matched_tasks,
        "telemetry": telemetry[:args.limit],
    }
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return 0


def command_ingest(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import ingest as worker_ingest

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        result = worker_ingest.ingest_session(conn, session_name=args.name)
    finally:
        conn.close()
    print(json.dumps({"session": args.name, **result}, indent=2, sort_keys=True))
    return 0


def command_tail(args: argparse.Namespace) -> int:
    """Print the most recent codex_events for a session as JSON, newest first.

    Output is a JSON list of dicts with stable keys:
      - `id`: int, autoincrement event id
      - `timestamp`: str, ISO timestamp from the codex rollout (or ingest time fallback)
      - `type`: str, top-level record type (session_meta, event_msg, response_item, ...)
      - `subtype`: str | None, inner payload type for event_msg, else null
      - `byte_offset`: int, absolute byte offset of this record in the rollout file
      - `payload`: dict, the raw payload object from the rollout

    Phase 3 supervision consumes this shape; do not break the keys without coordination.
    """
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        session = worker_db.session_row(conn, name=args.name)
        rows = worker_db.latest_codex_events_for_session(
            conn, session_id=session["id"], limit=args.limit, subtype=args.subtype,
        )
        worker_db.emit_telemetry_event(
            conn,
            actor="workerctl",
            event_type="codex_events_tail_read",
            summary=f"Read recent Codex events for session {args.name}.",
            correlation={"session": args.name, "session_id": session["id"]},
            attributes={
                "limit": args.limit,
                "returned_count": len(rows),
                "subtype": args.subtype,
            },
        )
        conn.commit()
    finally:
        conn.close()
    events = [
        {
            "id": r["id"],
            "timestamp": r["timestamp"],
            "type": r["type"],
            "subtype": r["subtype"],
            "byte_offset": r["byte_offset"],
            "payload": (
                json.loads(r["payload_json"])
                if getattr(args, "include_content", False)
                else redact_payload(json.loads(r["payload_json"]))
            ),
        }
        for r in rows
    ]
    print(json.dumps(events, indent=2, sort_keys=True, default=str))
    return 0


def command_bind(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    conn = worker_db.connect(db_path)
    worker_db.initialize_database(conn)
    try:
        binding_id = worker_db.bind_sessions(
            conn,
            task_name=args.task,
            worker_session_name=args.worker,
            manager_session_name=args.manager,
        )
        task_id = worker_db.task_row(conn, task=args.task)["id"]
        worker_db.insert_event(
            conn, "binding_created", actor="workerctl",
            task_id=task_id,
            payload={
                "binding_id": binding_id, "task": args.task,
                "worker": args.worker, "manager": args.manager,
            },
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps({
        "binding_id": binding_id, "task": args.task,
        "worker": args.worker, "manager": args.manager,
    }, indent=2, sort_keys=True))
    return 0


def command_unbind(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        worker_db.unbind_task(conn, task_name=args.task)
        task_id = worker_db.task_row(conn, task=args.task)["id"]
        worker_db.insert_event(
            conn, "binding_ended", actor="workerctl",
            task_id=task_id,
            payload={"task": args.task},
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps({"task": args.task, "state": "ended"}))
    return 0


def command_session_nudge(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    conn = worker_db.connect(db_path)
    worker_db.initialize_database(conn)
    try:
        telemetry_context = _session_action_telemetry_context(conn, session_name=args.name)
        try:
            result = worker_tmux.send_text_to_session(
                conn, session_name=args.name, text=args.text, dry_run=args.dry_run,
            )
            worker_db.insert_event(
                conn, "session_nudged", actor="workerctl",
                payload={
                    "session": args.name,
                    "dry_run": args.dry_run,
                    "text_length": len(args.text),
                    "success": True,
                },
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="session_nudge_succeeded",
                task_id=telemetry_context["task_id"],
                summary=f"Nudged session {args.name}.",
                correlation={
                    **telemetry_context["correlation"],
                    "dry_run": args.dry_run,
                    "session": args.name,
                },
                attributes={
                    "dry_run": args.dry_run,
                    "success": True,
                    "text_length": len(args.text),
                },
            )
            conn.commit()
        except Exception as exc:
            rollback_error = None
            try:
                conn.rollback()
            except Exception as rollback_exc:
                rollback_error = f"{type(rollback_exc).__name__}: {rollback_exc}"
            worker_db.insert_event(
                conn, "session_nudged", actor="workerctl",
                payload={
                    "session": args.name,
                    "dry_run": args.dry_run,
                    "text_length": len(args.text),
                    "success": False,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "rollback_error": rollback_error,
                },
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="session_nudge_failed",
                severity="error",
                task_id=telemetry_context["task_id"],
                summary=f"Failed to nudge session {args.name}.",
                correlation={
                    **telemetry_context["correlation"],
                    "dry_run": args.dry_run,
                    "session": args.name,
                },
                attributes={
                    "dry_run": args.dry_run,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "rollback_error": rollback_error,
                    "success": False,
                    "text_length": len(args.text),
                },
            )
            conn.commit()
            raise
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_session_interrupt(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db
    from workerctl import tmux as worker_tmux

    db_path = Path(args.path).expanduser().resolve() if getattr(args, "path", None) else None
    conn = worker_db.connect(db_path)
    worker_db.initialize_database(conn)
    try:
        telemetry_context = _session_action_telemetry_context(conn, session_name=args.name)
        try:
            result = worker_tmux.interrupt_session(
                conn, session_name=args.name, key=args.key,
                followup=args.followup, dry_run=args.dry_run,
            )
            worker_db.insert_event(
                conn, "session_interrupted", actor="workerctl",
                payload={
                    "session": args.name,
                    "key": args.key,
                    "dry_run": args.dry_run,
                    "followup_length": len(args.followup) if args.followup else 0,
                    "success": True,
                },
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="session_interrupt_succeeded",
                task_id=telemetry_context["task_id"],
                summary=f"Interrupted session {args.name}.",
                correlation={
                    **telemetry_context["correlation"],
                    "dry_run": args.dry_run,
                    "key": args.key,
                    "session": args.name,
                },
                attributes={
                    "dry_run": args.dry_run,
                    "followup_length": len(args.followup) if args.followup else 0,
                    "success": True,
                },
            )
            conn.commit()
        except Exception as exc:
            rollback_error = None
            try:
                conn.rollback()
            except Exception as rollback_exc:
                rollback_error = f"{type(rollback_exc).__name__}: {rollback_exc}"
            worker_db.insert_event(
                conn, "session_interrupted", actor="workerctl",
                payload={
                    "session": args.name,
                    "key": args.key,
                    "dry_run": args.dry_run,
                    "followup_length": len(args.followup) if args.followup else 0,
                    "success": False,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "rollback_error": rollback_error,
                },
            )
            worker_db.emit_telemetry_event(
                conn,
                actor="workerctl",
                event_type="session_interrupt_failed",
                severity="error",
                task_id=telemetry_context["task_id"],
                summary=f"Failed to interrupt session {args.name}.",
                correlation={
                    **telemetry_context["correlation"],
                    "dry_run": args.dry_run,
                    "key": args.key,
                    "session": args.name,
                },
                attributes={
                    "dry_run": args.dry_run,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "followup_length": len(args.followup) if args.followup else 0,
                    "rollback_error": rollback_error,
                    "success": False,
                },
            )
            conn.commit()
            raise
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def _session_action_telemetry_context(conn: Any, *, session_name: str) -> dict[str, Any]:
    row = conn.execute(
        """
        select sessions.id as session_id, sessions.role, bindings.id as binding_id,
               bindings.task_id
        from sessions
        left join bindings
          on bindings.state in ('active', 'ending')
         and (bindings.worker_session_id = sessions.id or bindings.manager_session_id = sessions.id)
        where sessions.name = ?
        order by bindings.id desc
        limit 1
        """,
        (session_name,),
    ).fetchone()
    if row is None:
        return {
            "task_id": None,
            "correlation": {"binding_id": None, "role": None, "session_id": None},
        }
    return {
        "task_id": row["task_id"],
        "correlation": {
            "binding_id": row["binding_id"],
            "role": row["role"],
            "session_id": row["session_id"],
        },
    }


def command_cycle(args: argparse.Namespace) -> int:
    """Run one observation cycle for a bound task. Output is structured JSON.

    The manager Codex (or an operator) is expected to read the output and decide
    whether to call `session-nudge`, `session-interrupt`, `finish-task`, or wait.
    The cycle command does NOT decide on the manager's behalf — it observes only.
    """
    from workerctl import db as worker_db
    from workerctl import supervise_cycle

    db_path = Path(args.path).expanduser().resolve() if args.path else None
    conn = worker_db.connect(db_path)
    worker_db.initialize_database(conn)
    try:
        result = supervise_cycle.run_cycle(
            conn, task_name=args.task, busy_wait_seconds=args.busy_wait_seconds
        )
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0


def command_divergences(args: argparse.Namespace) -> int:
    """List Phase 4 cycle observations where the shadow pane signal flagged a pattern.

    Output is a JSON list. Each entry has stable keys: `id`, `task_id`,
    `started_at`, `completed_at`, `state`, `notable_pane_pattern`, `status` (the
    parsed cycle status). Newest first, capped by `--limit` (default 50).
    """
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        rows = worker_db.divergent_cycles_for_task(
            conn, task_name=args.task, limit=args.limit,
        )
    finally:
        conn.close()
    print(json.dumps(rows, indent=2, sort_keys=True, default=str))
    return 0


def _pid_is_alive(pid: int) -> bool:
    """Return True if `pid` corresponds to a running process.

    Uses os.kill(pid, 0) - does not actually signal. ProcessLookupError means
    "no such process" -> False. PermissionError means "process exists but is owned
    by another user" -> True (not our problem to reconcile).
    """
    import os
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def collect_reconcile_report(conn: "sqlite3.Connection", stale_cycles_seconds: float = 3600.0) -> dict:
    """Build a read-only reconciliation report.

    Returns a dict with keys:
      - `schema_health`: dict from `db.database_health`
      - `dead_pid_sessions`: [{name, role, pid, last_heartbeat_at}, ...] - active
        sessions whose `pid` is no longer alive.
      - `dangling_bindings`: [{binding_id, task_name, gone_role, gone_session_name}, ...]
        - active or ending bindings whose worker_session_id or manager_session_id
        points at a session with `state='gone'`.
      - `stuck_tasks`: [{task_name, binding_id, last_cycle_at, age_seconds}, ...]
        - active-bound tasks whose newest manager_cycles row is older than
        stale_cycles_seconds (default 3600). Tasks with no cycles yet are skipped
        (they may be freshly bound).
    """
    from workerctl import db as worker_db

    schema = worker_db.database_health(conn)

    dead_pid_sessions = []
    for row in conn.execute(
        "select name, role, pid, last_heartbeat_at from sessions "
        "where state = 'active' and pid is not null"
    ):
        if not _pid_is_alive(int(row["pid"])):
            dead_pid_sessions.append({
                "name": row["name"],
                "role": row["role"],
                "pid": int(row["pid"]),
                "last_heartbeat_at": row["last_heartbeat_at"],
            })

    dangling_bindings = []
    for row in conn.execute(
        """
        select
          b.id as binding_id, t.id as task_id, t.name as task_name,
          ws.state as worker_state, ws.name as worker_name,
          ms.state as manager_state, ms.name as manager_name
        from bindings b
        join tasks t on t.id = b.task_id
        left join sessions ws on ws.id = b.worker_session_id
        left join sessions ms on ms.id = b.manager_session_id
        where b.state in ('active', 'ending')
          and b.worker_session_id is not null
        """
    ):
        if row["worker_state"] == "gone":
            dangling_bindings.append({
                "binding_id": row["binding_id"],
                "task_id": row["task_id"],
                "task_name": row["task_name"],
                "gone_role": "worker",
                "gone_session_name": row["worker_name"],
            })
        if row["manager_state"] == "gone":
            dangling_bindings.append({
                "binding_id": row["binding_id"],
                "task_id": row["task_id"],
                "task_name": row["task_name"],
                "gone_role": "manager",
                "gone_session_name": row["manager_name"],
            })

    stuck_tasks = []
    from datetime import datetime, timezone
    now_dt = datetime.now(timezone.utc)
    for row in conn.execute(
        """
        select t.name as task_name, b.id as binding_id,
               max(mc.completed_at) as last_cycle_at
        from bindings b
        join tasks t on t.id = b.task_id
        left join manager_cycles mc on mc.task_id = b.task_id
        where b.state in ('active', 'ending')
        group by b.id
        having last_cycle_at is not null
        """
    ):
        ts = row["last_cycle_at"]
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        last_dt = datetime.fromisoformat(ts).astimezone(timezone.utc)
        age = (now_dt - last_dt).total_seconds()
        if age > stale_cycles_seconds:
            stuck_tasks.append({
                "task_name": row["task_name"],
                "binding_id": row["binding_id"],
                "last_cycle_at": row["last_cycle_at"],
                "age_seconds": age,
            })

    return {
        "schema_health": schema,
        "dead_pid_sessions": dead_pid_sessions,
        "dangling_bindings": dangling_bindings,
        "stuck_tasks": stuck_tasks,
    }


def apply_reconcile(conn: "sqlite3.Connection", stale_cycles_seconds: float = 3600.0) -> dict:
    """Apply the reconcile changes and return the report with an `applied` key.

    Mutations:
      - Mark every dead-pid session `state='gone'` with `last_heartbeat_at=now()`.
      - After that, mark every binding that becomes dangling `state='invalid'` and
        set `ended_at=now()`.
      - Stuck tasks are reported but NEVER auto-closed (operators decide).

    Writes `session_marked_gone_by_reconcile` and `binding_marked_invalid_by_reconcile`
    events for audit.
    """
    from workerctl import db as worker_db
    from workerctl.core import now_iso

    report = collect_reconcile_report(conn, stale_cycles_seconds=stale_cycles_seconds)
    now = now_iso()
    applied = {"sessions_marked_gone": [], "bindings_marked_invalid": []}

    for s in report["dead_pid_sessions"]:
        conn.execute(
            "update sessions set state='gone', last_heartbeat_at=? where name=?",
            (now, s["name"]),
        )
        applied["sessions_marked_gone"].append(s["name"])
        worker_db.insert_event(
            conn, "session_marked_gone_by_reconcile", actor="workerctl",
            payload={"name": s["name"], "pid": s["pid"], "reason": "pid not alive"},
        )

    # Re-collect dangling after session updates so newly-dangling rows are included.
    report_post = collect_reconcile_report(conn, stale_cycles_seconds=stale_cycles_seconds)
    for b in report_post["dangling_bindings"]:
        conn.execute(
            "update bindings set state='invalid', ended_at=? where id=?",
            (now, b["binding_id"]),
        )
        applied["bindings_marked_invalid"].append(b["binding_id"])
        worker_db.insert_event(
            conn, "binding_marked_invalid_by_reconcile", actor="workerctl",
            task_id=b["task_id"],
            payload={
                "binding_id": b["binding_id"],
                "task_name": b["task_name"],
                "gone_role": b["gone_role"],
                "gone_session_name": b["gone_session_name"],
            },
        )

    conn.commit()
    report["applied"] = applied
    return report


def command_reconcile(args: argparse.Namespace) -> int:
    """Reconcile DB state with reality.

    Without `--apply`: print a JSON report of dead-pid sessions, dangling bindings,
    and stuck tasks. With `--apply`: mark dead-pid sessions `state='gone'` and
    mark dangling bindings `state='invalid'`, writing audit events for each
    mutation. Stuck tasks are reported but never auto-closed.
    """
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        if args.apply:
            report = apply_reconcile(conn, stale_cycles_seconds=args.stale_cycles_seconds)
        else:
            report = collect_reconcile_report(conn, stale_cycles_seconds=args.stale_cycles_seconds)
    finally:
        conn.close()
    print(json.dumps(report, indent=2, sort_keys=True, default=str))
    return 0
