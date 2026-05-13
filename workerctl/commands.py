from __future__ import annotations

import argparse
import hashlib
import os
import json
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from workerctl.classify import classify_busy_wait, classify_startup_output
from workerctl.audit import mutation_audit_result
from workerctl.constants import DEFAULT_MANAGER_STALE_SECONDS, PROJECT_ROOT, VALID_STATES
from workerctl.core import WorkerError, age_seconds, ensure_tool, now_iso, run, sh_quote
from workerctl.db import active_manager, active_task_worker
from workerctl.db import connect as connect_db
from workerctl.db import create_task as create_db_task
from workerctl.db import database_health, default_db_path, initialize_database
from workerctl.db import insert_agent_observation
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_status as insert_db_status
from workerctl.db import insert_terminal_capture
from workerctl.db import insert_transcript_segment
from workerctl.db import latest_terminal_capture_for_role
from workerctl.db import list_tasks as list_db_tasks
from workerctl.db import mark_manager_seen
from workerctl.db import mark_worker_state, upsert_worker
from workerctl.db import set_worker_pane_id
from workerctl.db import task_audit
from workerctl.db import task_status_snapshot
from workerctl import identity
from workerctl.state import (
    append_event,
    capture_meta_path,
    config_path,
    initial_status,
    latest_status,
    load_json,
    read_events,
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


def raw_worker_start_prompt(session_name: str, cwd: Path, manager_codex_args: list[str] | None = None) -> str:
    manager_suffix = codex_arg_suffix(manager_codex_args or [])
    become_managed_template = (
        f"workerctl become-managed --session {session_name} --worker <worker-name> "
        f"--task <task-name> --goal \"<goal>\" --summary \"<summary>\"{manager_suffix}"
    )
    return f"""You are a raw worker candidate running inside workerctl tmux session {session_name}.

Current working directory: {cwd}

You are not registered as a worker yet.

If the user asks you to become managed, launch your manager by running:

{become_managed_template}

Required fields:
- worker name
- task name
- goal

If any required field is missing, ask the user for it before running workerctl become-managed.
Do not invent worker name, task name, or goal values unless the user explicitly asks you to choose them.

After workerctl become-managed succeeds, your current tmux session will be renamed to codex-<worker-name>, and a manager tmux session will be spawned to supervise you. Preserve any arguments after `--` in the template when launching the manager.

After you are managed, if the user asks to take back manual control, stop supervising you, pause your manager, or unmanage this worker, run:

workerctl unmanage

This stops only the manager. It does not stop your worker session. If workerctl unmanage asks for a missing task or session, ask the user for the missing value.

If the user asks for your current managed status, run:

workerctl my-status

If you are paused and the user asks to restart management or get a manager again, run:

workerctl remanage --open-manager

If the user asks to see the manager or worker terminal for your task, run:

workerctl open-manager <task-name>
workerctl open-worker <task-name>
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


def command_start(args: argparse.Namespace) -> int:
    ensure_tool("tmux")
    ensure_tool("codex")
    session_name = args.session
    validate_name(session_name)
    directory = Path(args.cwd).expanduser().resolve()
    if not directory.exists() or not directory.is_dir():
        raise WorkerError(f"Session cwd does not exist or is not a directory: {directory}")
    if run(["tmux", "has-session", "-t", session_name], check=False).returncode == 0:
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
        "become_managed_command_template": f"workerctl become-managed --session {session_name} --worker <worker-name> --task <task-name> --goal \"<goal>\" --summary \"<summary>\"{manager_suffix}",
        "cwd": str(directory),
        "manage_command_template": f"workerctl manage --session {session_name} --worker <worker-name> --task <task-name> --goal \"<goal>\" --summary \"<summary>\" --open-manager{manager_suffix}",
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
        running = session_exists(name)
        workers.append(
            {
                "name": name,
                "running": running,
                "status": "running" if running else "stopped",
                "state": status.get("state", "unknown"),
                "current_task": status.get("current_task", ""),
            }
        )
    if args.json:
        print(json.dumps(workers, indent=2, sort_keys=True))
        return 0
    for worker in workers:
        print(f"{worker['name']}\t{worker['status']}\t{worker['state']}\t{worker['current_task']}")
    return 0


def command_capture(args: argparse.Namespace) -> int:
    output = capture_output(args.name, args.lines)
    if output:
        print(output)
    return 0


def command_status(args: argparse.Namespace) -> int:
    config = require_worker(args.name)
    running = session_exists(args.name)
    status = latest_status(args.name)
    capture_meta = load_json(capture_meta_path(args.name), {})
    terminal_capture_error: str | None = None
    if running and args.refresh:
        try:
            capture_output(args.name, args.lines)
            capture_meta = load_json(capture_meta_path(args.name), {})
        except WorkerError as exc:
            terminal_capture_error = str(exc)
            capture_meta = {"error": terminal_capture_error}
    elif capture_meta.get("error"):
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
    config = require_worker(name)
    running = session_exists(name)
    status = latest_status(name)
    capture_meta = load_json(capture_meta_path(name), {})
    capture_error = None

    if running and refresh:
        try:
            capture_output(name, lines)
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
            terminal_output = capture_tmux_target(tmux_target(name), lines)
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
                    {
                        "name": name,
                        "running": session_exists(name),
                        "startup": config.get("startup"),
                        "state": load_json(path / "status.json", {}).get("state", "unknown"),
                    }
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
    session = getattr(args, "session", None) or current_session_name()
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
    if session and tmux_path:
        proc = run(["tmux", "has-session", "-t", session], check=False)
        checks.append({"name": "current_tmux_session_live", "ok": proc.returncode == 0, "session": session})
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
    if scenario != "self-management":
        raise WorkerError(f"Unsupported QA scenario: {scenario}")
    payload = {
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
        "scenario": scenario,
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
    }
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
                   commands.worker_id, commands.manager_id, commands.payload_json,
                   commands.result_json, commands.error
            from commands
            left join tasks on tasks.id = commands.task_id
            {where}
            order by commands.created_at, commands.id
            """,
            params,
        ).fetchall()
    records = [
        {
            "created_at": row["created_at"],
            "error": row["error"],
            "id": row["id"],
            "manager_id": row["manager_id"],
            "payload": json.loads(row["payload_json"]),
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "state": row["state"],
            "task_id": row["task_id"],
            "task_name": row["task_name"],
            "type": row["type"],
            "updated_at": row["updated_at"],
            "worker_id": row["worker_id"],
        }
        for row in rows
    ]
    if args.json:
        print(json.dumps(records, indent=2, sort_keys=True))
        return 0
    for record in records:
        print(f"{record['id']}\t{record['state']}\t{record['type']}\t{record['task_name'] or '-'}")
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
        manager = active_manager(conn, task=snapshot["id"])

    if role == "worker":
        if binding is None:
            raise WorkerError(f"Task {snapshot['name']} has no active worker")
        verification = identity.verify_worker_binding_identity(binding)
        output = capture_output(binding["worker_name"], lines)
        worker_id = binding["worker_id"]
        manager_id = None
        tmux_session_value = binding["worker_tmux_session"]
        tmux_pane_id = verification.get("live_pane_id") or binding.get("worker_tmux_pane_id")
    elif role == "manager":
        if manager is None:
            raise WorkerError(f"Task {snapshot['name']} has no active manager")
        verification = identity.verify_manager_identity(manager)
        proc = run(["tmux", "capture-pane", "-p", "-t", manager["tmux_session"], "-S", f"-{lines}"])
        output = proc.stdout
        worker_id = None
        manager_id = manager["id"]
        tmux_session_value = manager["tmux_session"]
        tmux_pane_id = verification.get("live_pane_id") or manager.get("tmux_pane_id")
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
            "id": worker_id or manager_id,
            "name": binding["worker_name"] if role == "worker" and binding else manager["name"] if role == "manager" and manager else None,
            "state": binding["worker_state"] if role == "worker" and binding else manager["state"] if role == "manager" and manager else None,
            "tmux_pane_id": tmux_pane_id,
            "tmux_session": tmux_session_value,
        },
    }


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
    result = {"captures": captures, "mode": args.mode, "role": args.role, "task": args.task}
    if args.json:
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
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    for segment in result["segments"]:
        timestamp = segment["captured_at"].split("T", 1)[-1].replace("Z", "")
        print(f"--- {segment['role']} transcript segment {segment['id']} {timestamp} ({segment['segment_kind']}) ---")
        text = segment.get("segment_text")
        if text:
            print(text)
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
    require_worker(args.name)
    events = read_events(args.name)
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
    send_text(args.name, message)
    append_event(args.name, "nudge", {"message": message})
    print(f"sent nudge to {args.name}")
    return 0


def command_stop(args: argparse.Namespace) -> int:
    require_worker(args.name)
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


def _register_session_from_args(args: argparse.Namespace, *, role: str) -> dict:
    from workerctl import codex_session as cs
    from workerctl import db as worker_db

    if args.codex_session:
        rollout_path = Path(args.codex_session)
        meta = cs.read_session_meta(rollout_path)
        codex_session_path = str(rollout_path)
        codex_session_id = meta["id"]
        cwd = args.cwd or meta.get("cwd", "")
        pid = args.pid
        if pid is None:
            raise WorkerError("--pid is required when --codex-session is supplied")
    elif args.pid is not None:
        info = cs.discover_session(pid=args.pid)
        codex_session_path = info["codex_session_path"]
        codex_session_id = info["codex_session_id"]
        cwd = args.cwd or info["cwd"]
        pid = args.pid
    else:
        raise WorkerError("must supply --pid or --codex-session")

    conn = worker_db.connect()
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


def command_deregister(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        worker_db.deregister_session(conn, name=args.name)
        worker_db.insert_event(
            conn, "session_deregistered", actor="workerctl",
            payload={"name": args.name},
        )
        conn.commit()
    finally:
        conn.close()
    print(json.dumps({"name": args.name, "state": "gone"}))
    return 0


def command_sessions(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        rows = worker_db.list_sessions(conn, role=args.role)
    finally:
        conn.close()
    print(json.dumps(rows, indent=2, sort_keys=True, default=str))
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
    finally:
        conn.close()
    events = [
        {
            "id": r["id"],
            "timestamp": r["timestamp"],
            "type": r["type"],
            "subtype": r["subtype"],
            "byte_offset": r["byte_offset"],
            "payload": json.loads(r["payload_json"]),
        }
        for r in rows
    ]
    print(json.dumps(events, indent=2, sort_keys=True, default=str))
    return 0


def command_bind(args: argparse.Namespace) -> int:
    from workerctl import db as worker_db

    conn = worker_db.connect()
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

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
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
            conn.commit()
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            worker_db.insert_event(
                conn, "session_nudged", actor="workerctl",
                payload={
                    "session": args.name,
                    "dry_run": args.dry_run,
                    "text_length": len(args.text),
                    "success": False,
                    "error": str(exc),
                    "error_type": type(exc).__name__,
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

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
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
            conn.commit()
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
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
                },
            )
            conn.commit()
            raise
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_cycle(args: argparse.Namespace) -> int:
    """Run one observation cycle for a bound task. Output is structured JSON.

    The manager Codex (or an operator) is expected to read the output and decide
    whether to call `session-nudge`, `session-interrupt`, `finish-task`, or wait.
    The cycle command does NOT decide on the manager's behalf — it observes only.
    """
    from workerctl import db as worker_db
    from workerctl import supervise_cycle

    conn = worker_db.connect()
    worker_db.initialize_database(conn)
    try:
        result = supervise_cycle.run_cycle(conn, task_name=args.task)
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


def collect_reconcile_report(conn: "sqlite3.Connection") -> dict:
    """Build a read-only reconciliation report.

    Returns a dict with keys:
      - `schema_health`: dict from `db.database_health`
      - `dead_pid_sessions`: [{name, role, pid, last_heartbeat_at}, ...] - active
        sessions whose `pid` is no longer alive.
      - `dangling_bindings`: [{binding_id, task_name, gone_role, gone_session_name}, ...]
        - active or ending bindings whose worker_session_id or manager_session_id
        points at a session with `state='gone'`.
      - `stuck_tasks`: [{task_name, binding_id, last_cycle_at, age_seconds}, ...]
        - active-bound tasks whose newest manager_cycles row is older than 1 hour.
        Tasks with no cycles yet are skipped (they may be freshly bound).
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
        if age > 3600:
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


def apply_reconcile(conn: "sqlite3.Connection") -> dict:
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

    report = collect_reconcile_report(conn)
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
    report_post = collect_reconcile_report(conn)
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
            report = apply_reconcile(conn)
        else:
            report = collect_reconcile_report(conn)
    finally:
        conn.close()
    print(json.dumps(report, indent=2, sort_keys=True, default=str))
    return 0
