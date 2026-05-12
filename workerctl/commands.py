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
from workerctl.constants import RECOMMENDED_MANAGER_CODEX_ARGS
from workerctl.core import WorkerError, ensure_tool, now_iso, run, sh_quote
from workerctl.db import active_manager, active_task_worker
from workerctl.db import assess_manager_decision
from workerctl.db import bind_task_worker
from workerctl.db import connect as connect_db
from workerctl.db import create_command as create_db_command
from workerctl.db import create_manager_cycle
from workerctl.db import create_task as create_db_task
from workerctl.db import database_health, default_db_path, initialize_database
from workerctl.db import extend_nudge_budget
from workerctl.db import finish_command as finish_db_command
from workerctl.db import finish_manager_cycle
from workerctl.db import insert_agent_observation
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_manager_decision
from workerctl.db import insert_status as insert_db_status
from workerctl.db import insert_terminal_capture
from workerctl.db import insert_transcript_segment
from workerctl.db import latest_terminal_capture_for_role
from workerctl.db import list_tasks as list_db_tasks
from workerctl.db import mark_manager_seen
from workerctl.db import mark_command_attempted
from workerctl.db import mark_worker_state, upsert_worker
from workerctl.db import reserve_nudge_budget
from workerctl.db import require_manager_decision_ok
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
from workerctl.supervise import command_idle_check, command_supervise, command_watch, idle_summary, supervise_once
from workerctl.lifecycle import manager_liveness_warnings, reconcile_rows
from workerctl.tmux import (
    capture_output,
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


def recommended_manager_codex_args_suffix() -> str:
    return codex_arg_suffix(RECOMMENDED_MANAGER_CODEX_ARGS)


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
            except WorkerError:
                pass
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


def command_name_session(args: argparse.Namespace) -> int:
    ensure_tool("tmux")
    name = args.name
    validate_name(name)
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    directory = Path(args.cwd).expanduser().resolve()
    if not directory.exists() or not directory.is_dir():
        raise WorkerError(f"Worker cwd does not exist or is not a directory: {directory}")

    source_session = args.session or current_session_name()
    if not source_session:
        raise WorkerError("Cannot infer current tmux session. Run inside tmux or pass --session.")
    desired_session = tmux_session(name)
    existing_config = load_json(config_path(name), {}) if config_path(name).exists() else {}
    if existing_config and existing_config.get("tmux_session") not in {None, desired_session} and not args.force:
        raise WorkerError(f"Worker {name} already refers to {existing_config.get('tmux_session')}; rerun with --force to replace it.")

    with connect_db(db_path) as conn:
        initialize_database(conn)
        existing_worker = conn.execute(
            "select id, identity_token, tmux_session from workers where name = ?",
            (name,),
        ).fetchone()
    if existing_worker and existing_worker["tmux_session"] != desired_session and not args.force:
        raise WorkerError(
            f"Worker {name} is already claimed by worker id {existing_worker['id']} "
            f"in tmux session {existing_worker['tmux_session']}. Current session {source_session} "
            "cannot claim it. Use --force or --force-name only if replacing that worker is intentional."
        )
    force_reclaim = bool(existing_worker and existing_worker["tmux_session"] != desired_session and args.force)
    identity_token = (None if force_reclaim else existing_config.get("identity_token")) or (
        existing_worker["identity_token"] if existing_worker else f"workerctl-{uuid.uuid4()}"
    )
    if force_reclaim:
        identity_token = f"workerctl-{uuid.uuid4()}"

    if source_session != desired_session:
        if session_exists(name):
            raise WorkerError(f"tmux session already exists for worker {name}: {desired_session}")
        run(["tmux", "rename-session", "-t", source_session, desired_session])

    worker_dir(name).mkdir(parents=True, exist_ok=True)
    timestamp = now_iso()
    status = None if force_reclaim else load_json(status_path(name), None)
    if status is None:
        status = initial_status(name, args.task or "Named current tmux session as worker.")
        status["last_update"] = timestamp
        write_json(status_path(name), status)
    transcript_path(name).touch()
    config_base = {} if force_reclaim else existing_config
    config = {
        **config_base,
        "created_at": config_base.get("created_at") or timestamp,
        "cwd": str(directory),
        "identity_token": identity_token,
        "name": name,
        "state_dir": str(worker_dir(name)),
        "tmux_pane_id": current_pane_id(desired_session),
        "tmux_session": desired_session,
        "tmux_target": desired_session,
    }
    config["named_at"] = timestamp
    write_json(config_path(name), config)
    contract_path = write_worker_contract(name, args.task, identity_token)

    with connect_db(db_path) as conn:
        initialize_database(conn)
        if force_reclaim:
            replaced_name = f"{name}-replaced-{uuid.uuid4().hex[:8]}"
            conn.execute(
                "update workers set name = ?, state = 'missing', updated_at = ? where id = ?",
                (replaced_name, timestamp, existing_worker["id"]),
            )
        worker_id = upsert_worker(
            conn,
            name=name,
            cwd=str(directory),
            tmux_session=desired_session,
            identity_token=identity_token,
            tmux_pane_id=config.get("tmux_pane_id"),
            state="active",
            timestamp=timestamp,
        )
        config["worker_id"] = worker_id
        write_json(config_path(name), config)
        if existing_worker and existing_worker["tmux_session"] != desired_session and args.force:
            insert_db_event(
                conn,
                "worker_name_reclaimed",
                actor="workerctl",
                worker_id=worker_id,
                payload={
                    "current_session": source_session,
                    "previous_name": name,
                    "previous_tmux_session": existing_worker["tmux_session"],
                    "previous_worker_id": existing_worker["id"],
                    "replaced_name": replaced_name,
                    "worker": name,
                },
            )
        insert_db_status(conn, worker_id=worker_id, status=status, timestamp=status.get("last_update"))
        insert_db_event(
            conn,
            "worker_session_named",
            actor="workerctl",
            worker_id=worker_id,
            payload={
                "contract_path": str(contract_path),
                "cwd": str(directory),
                "source_session": source_session,
                "tmux_pane_id": config.get("tmux_pane_id"),
                "tmux_session": desired_session,
                "worker": name,
            },
        )
        conn.commit()
    append_event(
        name,
        "session_named",
        {
            "contract_path": str(contract_path),
            "cwd": str(directory),
            "source_session": source_session,
            "tmux_pane_id": config.get("tmux_pane_id"),
            "tmux_session": desired_session,
        },
    )
    result = {
        "contract_path": str(contract_path),
        "name": name,
        "renamed": source_session != desired_session,
        "source_session": source_session,
        "state_dir": str(worker_dir(name)),
        "tmux_pane_id": config.get("tmux_pane_id"),
        "tmux_session": desired_session,
        "worker_id": worker_id,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
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
    if running and args.refresh:
        try:
            capture_output(args.name, args.lines)
            capture_meta = load_json(capture_meta_path(args.name), {})
        except WorkerError as exc:
            capture_meta = {"error": str(exc)}

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
    }
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


MANAGED_FLOW_REQUIRED_VALUES = [
    {
        "name": "worker_name",
        "description": "Stable worker name to claim for the current Codex session.",
        "ask_when_missing": True,
    },
    {
        "name": "task_name",
        "description": "Stable task name for the worker-manager relationship.",
        "ask_when_missing": True,
    },
    {
        "name": "goal",
        "description": "Concrete goal the manager should supervise.",
        "ask_when_missing": True,
    },
    {
        "name": "summary",
        "description": "Short current-state summary; use a concise default only if the user supplied enough context.",
        "ask_when_missing": False,
    },
]


MANAGED_FLOW_PHRASE_MAPPINGS = [
    {
        "phrases": ["become managed", "manage yourself", "create a manager", "launch a manager"],
        "command": "workerctl doctor-self, then the recommended workerctl become-managed template when can_promote_in_place is true",
        "ask_for": ["worker_name", "task_name", "goal"],
    },
    {
        "phrases": ["stop supervising me", "stop managing me", "take back manual control", "unmanage this worker"],
        "command": "workerctl unmanage",
        "ask_for": ["task_name or session only if workerctl cannot infer it"],
    },
    {
        "phrases": ["resume supervision", "restart management", "get a manager again"],
        "command": "workerctl remanage --open-manager",
        "ask_for": ["task_name or session only if workerctl cannot infer it"],
    },
    {
        "phrases": ["finish this managed task", "close this task", "mark this task done"],
        "command": "workerctl finish-task <task-name> --reason \"<reason>\"",
        "ask_for": ["task_name", "reason", "whether to stop the manager only if the user asked to close its terminal"],
    },
    {
        "phrases": ["close the manager terminal", "review is complete", "clean up the manager"],
        "command": "workerctl close-manager <task-name> --reason \"<reason>\"",
        "ask_for": ["task_name", "reason"],
    },
    {
        "phrases": ["show me the manager", "open the manager terminal"],
        "command": "workerctl open-manager <task-name>",
        "ask_for": ["task_name"],
    },
    {
        "phrases": ["show me the worker", "open the worker terminal"],
        "command": "workerctl open-worker <task-name>",
        "ask_for": ["task_name"],
    },
]


def managed_flow_payload(*, session: str | None = None) -> dict[str, Any]:
    session_value = session or "<session-name>"
    return {
        "ask_questions_rule": "Ask for worker_name, task_name, and goal before become-managed unless the user explicitly supplied them or explicitly asked you to choose names.",
        "commands": {
            "preflight": "workerctl doctor-self",
            "become_managed_template": (
                f"workerctl become-managed --session {session_value} --worker <worker-name> "
                '--task <task-name> --goal "<goal>" --summary "<summary>"'
            ),
            "become_managed_recommended_template": (
                f"workerctl become-managed --session {session_value} --worker <worker-name> "
                '--task <task-name> --goal "<goal>" --summary "<summary>"'
            ),
            "cannot_promote_in_place": 'workerctl start <session-name> --cwd "$PWD" -- --sandbox danger-full-access --ask-for-approval never',
            "unmanage": "workerctl unmanage",
            "remanage": "workerctl remanage --open-manager",
            "finish": 'workerctl finish-task <task-name> --reason "<reason>"',
            "finish_and_stop_manager": 'workerctl finish-task <task-name> --reason "<reason>" --stop-manager',
            "close_manager": 'workerctl close-manager <task-name> --reason "<reason>"',
            "observe": "workerctl manager-observe <task-name> --compact --json",
        },
        "flow": [
            "Run workerctl doctor-self when asked to make this plain Codex session managed.",
            "If can_promote_in_place is false, explain that non-tmux Codex cannot be promoted in place and offer workerctl start.",
            "If can_promote_in_place is true, fill the recommended become-managed template only after required values are known.",
            "By default workerctl starts the manager with the recommended Codex args; pass explicit args after -- only when overriding that behavior.",
            "After become-managed succeeds, the current tmux session is renamed to codex-<worker-name> and a visible Codex manager is spawned.",
            "Use workerctl unmanage to stop only the manager and return manual control.",
            "Use workerctl remanage --open-manager to restart supervision for a paused managed worker.",
            "Use finish-task when work is complete; it records completion and leaves the manager terminal open by default.",
            "Add --stop-manager only when the user explicitly wants the manager terminal closed after completion.",
            "Use close-manager after post-finish review to close the manager terminal without changing task or worker state.",
        ],
        "phrase_mappings": MANAGED_FLOW_PHRASE_MAPPINGS,
        "required_values": MANAGED_FLOW_REQUIRED_VALUES,
    }


def print_managed_flow_text(payload: dict[str, Any]) -> None:
    print("Managed worker flow")
    print("")
    print(f"Preflight: {payload['commands']['preflight']}")
    print(f"Become managed: {payload['commands']['become_managed_template']}")
    print(f"Recommended: {payload['commands']['become_managed_recommended_template']}")
    print(f"Fallback: {payload['commands']['cannot_promote_in_place']}")
    print("")
    print("Required values before become-managed:")
    for value in payload["required_values"]:
        marker = "ask" if value["ask_when_missing"] else "optional"
        print(f"- {value['name']} ({marker}): {value['description']}")
    print("")
    print(f"Rule: {payload['ask_questions_rule']}")
    print("")
    print("Natural-language mappings:")
    for mapping in payload["phrase_mappings"]:
        print(f"- {', '.join(mapping['phrases'])}: {mapping['command']}")


def command_doctor_self(args: argparse.Namespace) -> int:
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

    can_promote_in_place = all(
        check["ok"]
        for check in checks
        if check["name"] in {"workerctl_on_path", "tmux_on_path", "inside_tmux", "current_tmux_session_live"}
    )
    if can_promote_in_place:
        recommended_action = "run_become_managed"
        why_or_why_not = "Current Codex process is inside a live tmux session and workerctl can promote it in place."
        become_managed_template = (
            f"workerctl become-managed --session {session} --worker <worker-name> --task <task-name> "
            '--goal "<goal>" --summary "<summary>"'
        )
        become_managed_recommended_template = become_managed_template
        manage_template = (
            f"workerctl manage --session {session} --worker <worker-name> --task <task-name> "
            '--goal "<goal>" --summary "<summary>" --open-manager'
        )
        manage_recommended_template = manage_template
    else:
        recommended_action = "cannot_promote_in_place"
        failed = [check["name"] for check in checks if not check["ok"]]
        why_or_why_not = (
            "This Codex process cannot be promoted in place as a tmux-backed worker. "
            f"Failed checks: {', '.join(failed) if failed else 'unknown'}."
        )
        become_managed_template = None
        become_managed_recommended_template = None
        manage_template = None
        manage_recommended_template = None
    flow = managed_flow_payload(session=session)
    recommended_command = become_managed_recommended_template or flow["commands"]["cannot_promote_in_place"]
    warnings = []
    result = {
        "become_managed_command_template": become_managed_template,
        "become_managed_recommended_command_template": become_managed_recommended_template,
        "can_promote_in_place": can_promote_in_place,
        "checks": checks,
        "current_session": session,
        "example_natural_language_prompt": (
            "Please become managed. Use worker name <worker-name>, task name <task-name>, "
            "goal '<goal>', and summary '<summary>'."
        ),
        "flow": flow["flow"],
        "manage_command_template": manage_template,
        "manage_recommended_command_template": manage_recommended_template,
        "manager_codex_args_default": RECOMMENDED_MANAGER_CODEX_ARGS,
        "manager_codex_args_recommendation": " ".join(RECOMMENDED_MANAGER_CODEX_ARGS),
        "manager_codex_args_required": False,
        "ok": can_promote_in_place,
        "phrase_mappings": flow["phrase_mappings"],
        "recommended_action": recommended_action,
        "recommended_command": recommended_command,
        "required_values": flow["required_values"],
        "skill_path": str(skill_path),
        "warnings": warnings,
        "why_or_why_not": why_or_why_not,
    }
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if can_promote_in_place else 1


def command_explain_managed_flow(args: argparse.Namespace) -> int:
    payload = managed_flow_payload(session=getattr(args, "session", None))
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print_managed_flow_text(payload)
    return 0


def command_qa_plan(args: argparse.Namespace) -> int:
    scenario = getattr(args, "scenario", "self-management")
    if scenario != "self-management":
        raise WorkerError(f"Unsupported QA scenario: {scenario}")
    payload = {
        "expected_observations": [
            "raw Codex session starts inside tmux",
            "natural-language prompt causes the worker to run become-managed or ask for missing required values",
            "worker session is renamed to codex-<worker-name>",
            "visible Codex manager session is spawned",
            "manager starts with manager-observe <task> --compact --json",
            "manager records manager-decision before any nudge, interrupt, finish, pause, or stop",
            "manager does not interrupt unless busy-wait/interruptible state is clear or user explicitly asks",
            "task-health reports nudge_budget_exhausted when the live budget reaches zero",
            "extend-nudge-budget requires an escalate decision and preserves nudges_used while increasing max_nudges",
            "a strict task-nudge succeeds after the audited budget extension",
            "finish-task marks the task done, records a final stop decision, and leaves the manager terminal open unless --stop-manager is used",
            "db-doctor --live reports no drift or unfinished commands after cleanup",
        ],
        "scenario": scenario,
        "steps": [
            'Run workerctl start <raw-session> --cwd "$PWD" -- --sandbox danger-full-access --ask-for-approval never.',
            "Open or attach to the raw session if visual confirmation is needed.",
            "Ask the raw worker in natural language to become managed, providing worker name, task name, goal, and summary.",
            "Run workerctl task-status <task> --json and confirm state is managed with active worker and manager.",
            "Inspect the manager terminal or audit and confirm the first loop used manager-observe --compact --json.",
            "Confirm manager-decision precedes any task-nudge/task-interrupt/finish-task mutation.",
            "Use strict decision-linked task-nudge calls until nudges_remaining is 0.",
            "Run workerctl task-health <task> --audit-decisions --json and confirm it reports nudge_budget_exhausted with an extend-nudge-budget recommendation.",
            "Record workerctl manager-decision <task> --decision escalate --reason \"nudge budget exhausted; extending for QA\".",
            "Run workerctl extend-nudge-budget <task> --add-nudges 2 --decision-id <escalate-decision-id> --strict-decisions.",
            "Send one more strict decision-linked task-nudge and confirm it succeeds.",
            "Run workerctl mutation-audit <task> --json and confirm the task_nudge and extend_nudge_budget mutations have zero warnings.",
            "Run workerctl audit <task> --json and confirm captures, observations, cycles, and decisions are present.",
            'Run workerctl finish-task <task> --stop-manager --stop-worker --reason "manual QA complete".',
            "Run workerctl task-status <task> --json and confirm state is done with no active worker or manager.",
            "Run workerctl db-doctor --live and confirm ok is true.",
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


def command_task_events(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    filters = ["events.task_id in (select id from tasks where id = ? or name = ?)"]
    params: list[Any] = [args.task, args.task]
    if args.type:
        filters.append("events.type = ?")
        params.append(args.type)
    where = " and ".join(filters)
    limit = "limit ?" if args.limit else ""
    if args.limit:
        params.append(args.limit)
    with connect_db(db_path) as conn:
        initialize_database(conn)
        rows = conn.execute(
            f"""
            select events.id, events.created_at, events.actor, events.command_id,
                   events.correlation_id, events.task_id, tasks.name as task_name,
                   events.worker_id, events.manager_id, events.type, events.payload_json
            from events
            left join tasks on tasks.id = events.task_id
            where {where}
            order by events.id desc
            {limit}
            """,
            params,
        ).fetchall()
    records = [
        {
            "actor": row["actor"],
            "command_id": row["command_id"],
            "correlation_id": row["correlation_id"],
            "created_at": row["created_at"],
            "id": row["id"],
            "manager_id": row["manager_id"],
            "payload": json.loads(row["payload_json"]),
            "task_id": row["task_id"],
            "task_name": row["task_name"],
            "type": row["type"],
            "worker_id": row["worker_id"],
        }
        for row in reversed(rows)
    ]
    if args.json:
        print(json.dumps(records, indent=2, sort_keys=True))
        return 0
    for record in records:
        command = f"\tcommand={record['command_id']}" if record["command_id"] else ""
        print(f"{record['created_at']}\t{record['type']}\tactor={record['actor']}{command}")
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


def command_bind_task(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding_id = bind_task_worker(conn, task=args.task, worker=args.worker)
        conn.commit()
    result = {
        "binding_id": binding_id,
        "task": args.task,
        "worker": args.worker,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_task_status(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
    if args.json:
        print(json.dumps(snapshot, indent=2, sort_keys=True))
        return 0
    worker_name = snapshot["worker"]["name"] if snapshot["worker"] else "-"
    worker_state = snapshot["worker_status"]["state"] if snapshot["worker_status"] else "-"
    print(f"{snapshot['name']}\t{snapshot['state']}\t{worker_name}\t{worker_state}")
    return 0


def command_task_health(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    result = task_health_result(
        db_path,
        args.task,
        audit_decisions=getattr(args, "audit_decisions", False),
        manager_stale_seconds=args.manager_stale_seconds,
    )
    if getattr(args, "record", False):
        severity = "info" if result["ok"] else "error"
        message = "task health ok" if result["ok"] else "task health needs attention"
        with connect_db(db_path) as conn:
            initialize_database(conn)
            observation_id = insert_agent_observation(
                conn,
                task_id=result["task"]["id"],
                role="workerctl",
                observation_type="health",
                severity=severity,
                message=message,
                payload=result,
                manager_id=result["live_reconcile"]["manager"]["id"] if result.get("live_reconcile") and result["live_reconcile"].get("manager") else None,
                worker_id=result["live_reconcile"]["worker"]["id"] if result.get("live_reconcile") and result["live_reconcile"].get("worker") else None,
            )
            insert_db_event(
                conn,
                "task_health_checked",
                actor="workerctl",
                task_id=result["task"]["id"],
                manager_id=result["live_reconcile"]["manager"]["id"] if result.get("live_reconcile") and result["live_reconcile"].get("manager") else None,
                worker_id=result["live_reconcile"]["worker"]["id"] if result.get("live_reconcile") and result["live_reconcile"].get("worker") else None,
                payload={"observation_id": observation_id, "ok": result["ok"], "issues": result["issues"]},
            )
            conn.commit()
        result["observation_id"] = observation_id
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1
    status = "ok" if result["ok"] else "needs_attention"
    print(f"{result['task']['name']}\t{result['task']['state']}\t{status}")
    for issue in result["issues"]:
        print(f"issue: {issue['source']}:{issue['code']}")
    for action in result["recommended_actions"]:
        print(f"next: {action}")
    return 0 if result["ok"] else 1


def task_health_result(
    db_path: Path | None,
    task: str,
    *,
    audit_decisions: bool = False,
    manager_stale_seconds: int,
) -> dict[str, Any]:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=task)
        audit = task_audit(conn, task=task) if audit_decisions else None
    reconcile = reconcile_rows(db_path, task=snapshot["id"], recover=False)
    reconcile_result = reconcile[0] if reconcile else None
    liveness_warnings = manager_liveness_warnings(reconcile, stale_seconds=manager_stale_seconds)
    latest_manager_capture_classifier = None
    if snapshot.get("manager"):
        with connect_db(db_path) as conn:
            initialize_database(conn)
            row = conn.execute(
                """
                select classifier_json
                from terminal_captures
                where task_id = ? and role = 'manager'
                order by id desc
                limit 1
                """,
                (snapshot["id"],),
            ).fetchone()
            if row:
                latest_manager_capture_classifier = json.loads(row["classifier_json"])
    decision_audit = mutation_audit_result(audit) if audit_decisions and audit else None
    issues: list[dict[str, Any]] = []
    recommended_actions: list[str] = []
    review_manager_idle: list[dict[str, Any]] = []
    for issue in snapshot["integrity"]["issues"]:
        issues.append({"code": issue, "source": "integrity"})
    if reconcile_result:
        for drift in reconcile_result["drift"]:
            issues.append({"code": drift, "source": "live_reconcile"})
        for command in reconcile_result["unfinished_commands"]:
            issues.append(
                {
                    "code": "unfinished_command",
                    "command_id": command["id"],
                    "command_type": command["type"],
                    "source": "commands",
                    "state": command["state"],
                }
            )
    manager_prompt_wait = None
    if latest_manager_capture_classifier:
        busy_wait = latest_manager_capture_classifier.get("busy_wait")
        if isinstance(busy_wait, dict) and busy_wait.get("pattern") == "rate_limit_prompt":
            manager_prompt_wait = busy_wait
    for warning in liveness_warnings:
        if snapshot["state"] in {"done", "failed", "cancelled"} and warning["reason"] == "manager_seen_stale":
            review_manager_idle.append(
                {
                    "code": "review_manager_idle",
                    "manager_id": warning["manager_id"],
                    "manager": warning["manager"],
                    "last_seen_at": warning.get("last_seen_at"),
                    "age_seconds": warning.get("age_seconds"),
                    "prompt_pattern": manager_prompt_wait.get("pattern") if manager_prompt_wait else None,
                    "source": "manager_liveness",
                }
            )
        elif manager_prompt_wait:
            issues.append(
                {
                    "code": "manager_waiting_for_user_choice",
                    "manager_id": warning["manager_id"],
                    "pattern": manager_prompt_wait.get("pattern"),
                    "source": "manager_terminal",
                }
            )
        else:
            issues.append({"code": warning["reason"], "manager_id": warning["manager_id"], "source": "manager_liveness"})
    budget = snapshot.get("budget")
    if snapshot["state"] == "managed" and budget:
        if budget["expires_at"] < now_iso():
            issues.append({"code": "nudge_budget_expired", "expires_at": budget["expires_at"], "source": "budget"})
        elif budget["nudges_remaining"] <= 0:
            issues.append({"code": "nudge_budget_exhausted", "source": "budget"})
    if decision_audit:
        for record in decision_audit["records"]:
            if record["warnings"]:
                issues.append(
                    {
                        "code": "manager_decision_audit_warning",
                        "command_id": record["command"]["id"],
                        "command_type": record["command"]["type"],
                        "source": "manager_decision_audit",
                        "warnings": record["warnings"],
                    }
                )

    issue_codes = {issue["code"] for issue in issues}
    if "managed_without_active_worker_binding" in issue_codes:
        recommended_actions.append("Do not resume or nudge this task; inspect task-events and close-stale or recreate the worker binding.")
    if "managed_without_active_manager" in issue_codes or "manager_missing" in issue_codes:
        recommended_actions.append("Run workerctl reconcile <task>; if confirmed missing, run workerctl recover <task> or remanage from the worker.")
    if "worker_missing" in issue_codes:
        recommended_actions.append("Confirm whether the worker tmux session was intentionally stopped before restarting management.")
    if "worker_pane_mismatch" in issue_codes or "manager_pane_mismatch" in issue_codes:
        recommended_actions.append("Inspect the terminal; if the live pane is correct, run workerctl recover <task> --sync-pane-ids.")
    if "unfinished_commands" in issue_codes or "unfinished_command" in issue_codes:
        recommended_actions.append("Inspect workerctl commands --task <task> and retry or resolve unfinished side effects manually.")
    if any(issue["source"] == "manager_liveness" for issue in issues):
        recommended_actions.append("Inspect the manager terminal before taking recovery action; heartbeat warnings are not hard drift.")
    if "manager_waiting_for_user_choice" in issue_codes:
        recommended_actions.append("Choose the pending Codex prompt in the manager terminal, or run workerctl close-manager <task> after review.")
    if any(issue["source"] == "manager_decision_audit" for issue in issues):
        recommended_actions.append("Run workerctl mutation-audit <task> --json; future manager mutations should record manager-decision first and pass --decision-id.")
    if any(issue["source"] == "budget" for issue in issues):
        recommended_actions.append("Record an escalate decision, then run workerctl extend-nudge-budget <task> --add-nudges <n> --decision-id <id> --strict-decisions, or stop and escalate to the user.")
    if not recommended_actions:
        recommended_actions.append("No action required.")

    result = {
        "decision_audit": decision_audit,
        "integrity": snapshot["integrity"],
        "issues": issues,
        "live_reconcile": reconcile_result,
        "manager_liveness_warnings": liveness_warnings,
        "ok": not issues,
        "recommended_actions": recommended_actions,
        "review_manager_idle": review_manager_idle,
        "task": {
            "id": snapshot["id"],
            "name": snapshot["name"],
            "state": snapshot["state"],
        },
    }
    return result


def command_extend_nudge_budget(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    if args.add_nudges <= 0:
        raise WorkerError("--add-nudges must be > 0")
    expires_at = args.budget_expires_at
    if not expires_at:
        hours = getattr(args, "budget_hours", 24)
        expires_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + (hours * 3600)))
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        if snapshot["state"] in {"done", "failed"}:
            raise WorkerError(f"Task {snapshot['name']} is closed; current state is {snapshot['state']}")
        manager = active_manager(conn, task=snapshot["id"])
        decision_check = assess_manager_decision(
            conn,
            task_id=snapshot["id"],
            decision_id=getattr(args, "decision_id", None),
            allowed_decisions={"escalate"},
        )
        require_manager_decision_ok(
            command_type="extend_nudge_budget",
            decision_check=decision_check,
            strict=getattr(args, "strict_decisions", False),
        )
        command_id = create_db_command(
            conn,
            command_type="extend_nudge_budget",
            task_id=snapshot["id"],
            manager_id=manager["id"] if manager else None,
            payload={
                "add_nudges": args.add_nudges,
                "budget_expires_at": expires_at,
                "manager_decision": decision_check,
                "task": snapshot["name"],
            },
        )
        insert_db_event(
            conn,
            "extend_nudge_budget_intent",
            actor="workerctl",
            command_id=command_id,
            task_id=snapshot["id"],
            manager_id=manager["id"] if manager else None,
            payload={
                "add_nudges": args.add_nudges,
                "budget_expires_at": expires_at,
                "manager_decision": decision_check,
            },
        )
        mark_command_attempted(conn, command_id=command_id)
        budget = extend_nudge_budget(
            conn,
            task_id=snapshot["id"],
            add_nudges=args.add_nudges,
            expires_at=expires_at,
        )
        result_payload = {
            "add_nudges": args.add_nudges,
            "budget": budget,
            "command_id": command_id,
            "manager_decision": decision_check,
            "task": snapshot["name"],
        }
        finish_db_command(conn, command_id=command_id, state="succeeded", result=result_payload)
        insert_db_event(
            conn,
            "extend_nudge_budget_succeeded",
            actor="workerctl",
            command_id=command_id,
            task_id=snapshot["id"],
            manager_id=manager["id"] if manager else None,
            payload=result_payload,
        )
        conn.commit()
    print(json.dumps(result_payload, indent=2, sort_keys=True))
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


def command_task_capture(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    role = getattr(args, "role", "worker")
    result = capture_task_terminal(
        db_path,
        task=args.task,
        role=role,
        lines=args.lines,
        source="task_capture",
        transcript_mode=getattr(args, "transcript_mode", "none"),
    )
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    output = result["capture"]["output"]
    if output:
        print(output)
    return 0


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


def compact_capture_result(result: dict[str, Any] | None, *, excerpt_lines: int = 20) -> dict[str, Any] | None:
    if result is None:
        return None
    capture = result["capture"]
    output = capture.get("output") or ""
    lines = output.splitlines()
    excerpt = "\n".join(lines[-excerpt_lines:])
    return {
        "binding_id": result.get("binding_id"),
        "capture": {
            "classifier": capture.get("classifier"),
            "content_sha256": capture.get("content_sha256"),
            "excerpt": excerpt,
            "history_lines": capture.get("history_lines"),
            "id": capture.get("id"),
            "line_count": capture.get("line_count"),
            "source": capture.get("source"),
        },
        "observation_id": result.get("observation_id"),
        "role": result.get("role"),
        "task": result.get("task"),
        result["role"]: result.get(result["role"]),
    }


def compact_status_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "budget": snapshot.get("budget"),
        "id": snapshot.get("id"),
        "integrity": snapshot.get("integrity"),
        "manager": snapshot.get("manager"),
        "name": snapshot.get("name"),
        "state": snapshot.get("state"),
        "worker": snapshot.get("worker"),
        "worker_status": snapshot.get("worker_status"),
    }


def compact_health_result(health: dict[str, Any]) -> dict[str, Any]:
    return {
        "issues": health.get("issues", []),
        "manager_liveness_warnings": health.get("manager_liveness_warnings", []),
        "ok": health.get("ok"),
        "recommended_actions": health.get("recommended_actions", []),
        "review_manager_idle": health.get("review_manager_idle", []),
        "task": health.get("task"),
    }


def command_task_idle_check(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = active_task_worker(conn, task=args.task)
    summary = idle_summary(
        binding["worker_name"],
        status_stale_seconds=args.status_stale_seconds,
        terminal_stale_seconds=args.terminal_stale_seconds,
        busy_wait_seconds=args.busy_wait_seconds,
        refresh=args.refresh,
        lines=args.lines,
    )
    summary["binding_id"] = binding["binding_id"]
    summary["task_id"] = binding["task_id"]
    summary["task_name"] = binding["task_name"]
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def command_manager_observe(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        manager = active_manager(conn, task=snapshot["id"])
        manager_id = manager["id"] if manager else None
        cycle_id = create_manager_cycle(conn, task_id=snapshot["id"], manager_id=manager_id)
        conn.commit()
    try:
        transcript_mode = getattr(args, "transcript_mode", "segment")
        worker_capture = capture_task_terminal(
            db_path,
            task=snapshot["id"],
            role="worker",
            lines=args.lines,
            source="manager_observe",
            transcript_mode=transcript_mode,
        )
        manager_capture = None
        if manager:
            manager_capture = capture_task_terminal(
                db_path,
                task=snapshot["id"],
                role="manager",
                lines=args.lines,
                source="manager_observe",
                transcript_mode=transcript_mode,
            )
        health = task_health_result(db_path, snapshot["id"], manager_stale_seconds=args.manager_stale_seconds)
        severity = "info" if health["ok"] else "error"
        with connect_db(db_path) as conn:
            initialize_database(conn)
            health_observation_id = insert_agent_observation(
                conn,
                task_id=snapshot["id"],
                manager_id=manager_id,
                worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
                role="manager",
                observation_type="health",
                severity=severity,
                message="manager observed task health",
                payload=health,
            )
            insert_db_event(
                conn,
                "manager_health_observed",
                actor="manager",
                task_id=snapshot["id"],
                manager_id=manager_id,
                worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
                payload={"cycle_id": cycle_id, "observation_id": health_observation_id, "ok": health["ok"], "issues": health["issues"]},
            )
            conn.commit()
        idle = idle_summary(
            snapshot["worker"]["name"],
            status_stale_seconds=args.status_stale_seconds,
            terminal_stale_seconds=args.terminal_stale_seconds,
            busy_wait_seconds=args.busy_wait_seconds,
            refresh=args.refresh,
            lines=args.lines,
        ) if snapshot["worker"] else None
        with connect_db(db_path) as conn:
            initialize_database(conn)
            latest_snapshot = task_status_snapshot(conn, task=snapshot["id"])
            finish_manager_cycle(
                conn,
                cycle_id=cycle_id,
                state="succeeded",
                health_observation_id=health_observation_id,
                manager_capture_id=manager_capture["capture"]["id"] if manager_capture else None,
                worker_capture_id=worker_capture["capture"]["id"],
                status=latest_snapshot,
                health=health,
            )
            insert_db_event(
                conn,
                "manager_observe_succeeded",
                actor="manager",
                task_id=snapshot["id"],
                manager_id=manager_id,
                worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
                payload={"cycle_id": cycle_id, "health_ok": health["ok"]},
            )
            conn.commit()
        result = {
            "cycle_id": cycle_id,
            "health": health,
            "idle": idle,
            "manager_capture": manager_capture,
            "status": latest_snapshot,
            "worker_capture": worker_capture,
        }
        if getattr(args, "compact", False):
            result = {
                "compact": True,
                "cycle_id": cycle_id,
                "health": compact_health_result(health),
                "idle": idle,
                "manager_capture": compact_capture_result(manager_capture),
                "status": compact_status_snapshot(latest_snapshot),
                "worker_capture": compact_capture_result(worker_capture),
            }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if health["ok"] else 1
    except Exception as exc:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            finish_manager_cycle(conn, cycle_id=cycle_id, state="failed", error=str(exc))
            insert_db_event(
                conn,
                "manager_observe_failed",
                actor="manager",
                task_id=snapshot["id"],
                manager_id=manager_id,
                worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
                payload={"cycle_id": cycle_id, "error": str(exc)},
            )
            conn.commit()
        raise


def command_manager_decision(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        terminal_states = {"done", "failed", "cancelled"}
        if snapshot["state"] in terminal_states and not getattr(args, "allow_post_terminal", False):
            raise WorkerError(
                f"Task {snapshot['name']} is {snapshot['state']}; refusing post-terminal manager decision. "
                "Use --allow-post-terminal only for explicit review annotations."
            )
        manager = active_manager(conn, task=snapshot["id"])
        decision_id = insert_manager_decision(
            conn,
            task_id=snapshot["id"],
            manager_id=manager["id"] if manager else None,
            manager_cycle_id=args.cycle_id,
            decision=args.decision,
            reason=args.reason,
            payload={
                "post_terminal": snapshot["state"] in terminal_states,
                "source": "manager_decision",
            },
        )
        observation_id = insert_agent_observation(
            conn,
            task_id=snapshot["id"],
            manager_id=manager["id"] if manager else None,
            worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
            role="manager",
            observation_type="decision",
            severity="info" if args.decision in {"wait", "inspect", "nudge"} else "warning",
            message=args.reason,
            payload={"decision": args.decision, "decision_id": decision_id, "manager_cycle_id": args.cycle_id},
        )
        insert_db_event(
            conn,
            "manager_decision_recorded",
            actor="manager",
            task_id=snapshot["id"],
            manager_id=manager["id"] if manager else None,
            worker_id=snapshot["worker"]["id"] if snapshot["worker"] else None,
            payload={"decision": args.decision, "decision_id": decision_id, "observation_id": observation_id, "reason": args.reason},
        )
        conn.commit()
    result = {"decision": args.decision, "decision_id": decision_id, "observation_id": observation_id, "task": snapshot["name"]}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def command_task_nudge(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = active_task_worker(conn, task=args.task)
        if binding["task_state"] != "managed":
            raise WorkerError(f"Task {binding['task_name']} is not managed; current state is {binding['task_state']}")
        budget = None
        decision_check = assess_manager_decision(
            conn,
            task_id=binding["task_id"],
            decision_id=getattr(args, "decision_id", None),
            allowed_decisions={"nudge"},
        )
        require_manager_decision_ok(
            command_type="task_nudge",
            decision_check=decision_check,
            strict=getattr(args, "strict_decisions", False),
        )
        command_id = create_db_command(
            conn,
            command_type="task_nudge",
            task_id=binding["task_id"],
            worker_id=binding["worker_id"],
            payload={
                "binding_id": binding["binding_id"],
                "dry_run": args.dry_run,
                "message": args.message,
                "manager_decision": decision_check,
                "task": binding["task_name"],
                "worker": binding["worker_name"],
                "budget": budget,
            },
        )
        insert_db_event(
            conn,
            "task_nudge_intent",
            actor="workerctl",
            command_id=command_id,
            task_id=binding["task_id"],
            worker_id=binding["worker_id"],
            payload={
                "binding_id": binding["binding_id"],
                "dry_run": args.dry_run,
                "message": args.message,
                "manager_decision": decision_check,
                "budget": budget,
            },
        )
        conn.commit()

    result_payload = {
        "binding_id": binding["binding_id"],
        "command_id": command_id,
        "dry_run": args.dry_run,
        "message": args.message,
        "manager_decision": decision_check,
        "task": binding["task_name"],
        "worker": binding["worker_name"],
        "budget": budget,
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            conn.commit()
        if not args.dry_run:
            verification = identity.verify_worker_binding_identity(binding)
            with connect_db(db_path) as conn:
                initialize_database(conn)
                budget = reserve_nudge_budget(conn, task_id=binding["task_id"])
                insert_db_event(
                    conn,
                    "worker_identity_verified",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=binding["task_id"],
                    worker_id=binding["worker_id"],
                    payload=verification,
                )
                conn.commit()
            result_payload["budget"] = budget
            send_text(binding["worker_name"], args.message)
            append_event(
                binding["worker_name"],
                "task_nudge",
                {
                    "command_id": command_id,
                    "message": args.message,
                    "task": binding["task_name"],
                },
            )
        with connect_db(db_path) as conn:
            initialize_database(conn)
            finish_db_command(
                conn,
                command_id=command_id,
                state="succeeded",
                result=result_payload,
            )
            insert_db_event(
                conn,
                "task_nudge_succeeded",
                actor="workerctl",
                command_id=command_id,
                task_id=binding["task_id"],
                worker_id=binding["worker_id"],
                payload=result_payload,
            )
            conn.commit()
    except Exception as exc:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            finish_db_command(conn, command_id=command_id, state="failed", error=str(exc))
            insert_db_event(
                conn,
                "task_nudge_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=binding["task_id"],
                worker_id=binding["worker_id"],
                payload={**result_payload, "error": str(exc)},
            )
            conn.commit()
        raise
    print(json.dumps(result_payload, indent=2, sort_keys=True))
    return 0


def command_task_interrupt(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    followup = None if args.no_followup else args.followup
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = active_task_worker(conn, task=args.task)
        if binding["task_state"] != "managed":
            raise WorkerError(f"Task {binding['task_name']} is not managed; current state is {binding['task_state']}")
        decision_check = assess_manager_decision(
            conn,
            task_id=binding["task_id"],
            decision_id=getattr(args, "decision_id", None),
            allowed_decisions={"interrupt"},
        )
        require_manager_decision_ok(
            command_type="task_interrupt",
            decision_check=decision_check,
            strict=getattr(args, "strict_decisions", False),
        )
        command_id = create_db_command(
            conn,
            command_type="task_interrupt",
            task_id=binding["task_id"],
            worker_id=binding["worker_id"],
            payload={
                "binding_id": binding["binding_id"],
                "dry_run": args.dry_run,
                "followup": followup,
                "key": args.key,
                "manager_decision": decision_check,
                "task": binding["task_name"],
                "worker": binding["worker_name"],
            },
        )
        insert_db_event(
            conn,
            "task_interrupt_intent",
            actor="workerctl",
            command_id=command_id,
            task_id=binding["task_id"],
            worker_id=binding["worker_id"],
            payload={
                "binding_id": binding["binding_id"],
                "dry_run": args.dry_run,
                "followup": followup,
                "key": args.key,
                "manager_decision": decision_check,
            },
        )
        conn.commit()

    result_payload = {
        "binding_id": binding["binding_id"],
        "command_id": command_id,
        "dry_run": args.dry_run,
        "followup": followup,
        "key": args.key,
        "manager_decision": decision_check,
        "task": binding["task_name"],
        "worker": binding["worker_name"],
    }
    try:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            mark_command_attempted(conn, command_id=command_id)
            conn.commit()
        if not args.dry_run:
            verification = identity.verify_worker_binding_identity(binding)
            with connect_db(db_path) as conn:
                initialize_database(conn)
                insert_db_event(
                    conn,
                    "worker_identity_verified",
                    actor="workerctl",
                    command_id=command_id,
                    task_id=binding["task_id"],
                    worker_id=binding["worker_id"],
                    payload=verification,
                )
                conn.commit()
            interrupt_result = interrupt_worker(
                binding["worker_name"],
                key=args.key,
                followup=followup,
                dry_run=False,
            )
            result_payload["interrupt"] = interrupt_result
        with connect_db(db_path) as conn:
            initialize_database(conn)
            finish_db_command(
                conn,
                command_id=command_id,
                state="succeeded",
                result=result_payload,
            )
            insert_db_event(
                conn,
                "task_interrupt_succeeded",
                actor="workerctl",
                command_id=command_id,
                task_id=binding["task_id"],
                worker_id=binding["worker_id"],
                payload=result_payload,
            )
            conn.commit()
    except Exception as exc:
        with connect_db(db_path) as conn:
            initialize_database(conn)
            finish_db_command(conn, command_id=command_id, state="failed", error=str(exc))
            insert_db_event(
                conn,
                "task_interrupt_failed",
                actor="workerctl",
                command_id=command_id,
                task_id=binding["task_id"],
                worker_id=binding["worker_id"],
                payload={**result_payload, "error": str(exc)},
            )
            conn.commit()
        raise
    print(json.dumps(result_payload, indent=2, sort_keys=True))
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
