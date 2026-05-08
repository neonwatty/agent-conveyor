from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from workerctl.classify import classify_busy_wait, classify_startup_output
from workerctl.constants import DEFAULT_MANAGER_STALE_SECONDS, PROJECT_ROOT, VALID_STATES
from workerctl.core import WorkerError, ensure_tool, now_iso, run, sh_quote
from workerctl.db import active_task_worker
from workerctl.db import bind_task_worker
from workerctl.db import connect as connect_db
from workerctl.db import create_command as create_db_command
from workerctl.db import create_task as create_db_task
from workerctl.db import database_health, default_db_path, initialize_database
from workerctl.db import finish_command as finish_db_command
from workerctl.db import insert_event as insert_db_event
from workerctl.db import insert_status as insert_db_status
from workerctl.db import list_tasks as list_db_tasks
from workerctl.db import mark_command_attempted
from workerctl.db import mark_worker_state, upsert_worker
from workerctl.db import reserve_nudge_budget
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

    codex_args = " ".join(sh_quote(arg) for arg in (args.codex_args or []))
    shell_command = f"{cli_path_prefix()} codex --cd {sh_quote(str(directory))} --no-alt-screen"
    if codex_args:
        shell_command = f"{shell_command} {codex_args}"
    run(["tmux", "new-session", "-d", "-s", session_name, shell_command])
    result = {
        "attach_command": attach_session_command(session_name),
        "cwd": str(directory),
        "manage_command": f"workerctl manage --worker <name> --task <task> --goal <goal>",
        "session": session_name,
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


def command_tail(args: argparse.Namespace) -> int:
    output = capture_output(args.name, args.lines)
    lines = output.splitlines()
    print("\n".join(lines[-args.lines :]))
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


def command_task_capture(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = active_task_worker(conn, task=args.task)
    output = capture_output(binding["worker_name"], args.lines)
    if args.json:
        capture_meta = load_json(capture_meta_path(binding["worker_name"]), {})
        result = {
            "binding_id": binding["binding_id"],
            "capture": {
                "history_lines": args.lines,
                "output": output,
                **capture_meta,
            },
            "task": {
                "id": binding["task_id"],
                "name": binding["task_name"],
                "state": binding["task_state"],
            },
            "worker": {
                "id": binding["worker_id"],
                "name": binding["worker_name"],
                "state": binding["worker_state"],
                "tmux_session": binding["worker_tmux_session"],
            },
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if output:
        print(output)
    return 0


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


def command_task_nudge(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        binding = active_task_worker(conn, task=args.task)
        if binding["task_state"] != "managed":
            raise WorkerError(f"Task {binding['task_name']} is not managed; current state is {binding['task_state']}")
        budget = None
        command_id = create_db_command(
            conn,
            command_type="task_nudge",
            task_id=binding["task_id"],
            worker_id=binding["worker_id"],
            payload={
                "binding_id": binding["binding_id"],
                "dry_run": args.dry_run,
                "message": args.message,
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
                "budget": budget,
            },
        )
        conn.commit()

    result_payload = {
        "binding_id": binding["binding_id"],
        "command_id": command_id,
        "dry_run": args.dry_run,
        "message": args.message,
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
            },
        )
        conn.commit()

    result_payload = {
        "binding_id": binding["binding_id"],
        "command_id": command_id,
        "dry_run": args.dry_run,
        "followup": followup,
        "key": args.key,
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
