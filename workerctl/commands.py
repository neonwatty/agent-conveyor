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
import time
import uuid
from pathlib import Path
from typing import Any

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
    start_manager_template = f"workerctl start-manager --name <manager-name> --cwd {sh_quote(str(cwd))}{manager_suffix}"
    return f"""You are a raw worker candidate running inside workerctl tmux session {session_name}.

Current working directory: {cwd}

You are not registered as a worker yet.

The supported manager/worker setup is session-based:

1. Register this session as a worker after identifying the Codex process pid and
   rollout JSONL:

   workerctl register-worker --name <worker-name> --pid <pid> --codex-session <rollout.jsonl> --cwd {sh_quote(str(cwd))} --tmux-session {session_name}

2. Create or select a task:

   workerctl tasks --create <task-name> --goal "<goal>"

3. Start a manager:

   {start_manager_template}

4. Bind the sessions:

   workerctl bind --task <task-name> --worker <worker-name> --manager <manager-name>

5. Configure manager supervision:

   workerctl manager-config <task-name> --questions

Required fields:
- worker name
- manager name
- task name
- goal

If any required field is missing, ask the user for it. Do not invent worker
name, manager name, task name, or goal values unless the user explicitly asks
you to choose them.

If the user asks to see the manager or worker terminal for your task, run:

workerctl open-manager <task-name>
workerctl open-worker <task-name>
"""


def manager_bootstrap_prompt(
    *,
    manager_name: str,
    cwd: str | Path,
    task_name: str | None = None,
    task_goal: str | None = None,
    worker_name: str | None = None,
    manager_config_seeded: bool = False,
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
    if manager_config_seeded:
        initial_setup = f"""Initial setup:
- Manager config has already been recorded for this task.
- Start with `{cycle_command}` and inspect `manager_context.manager_config`.
- Ask setup questions only if the cycle output shows missing or unsuitable manager config."""
    else:
        initial_setup = f"""Initial setup:
1. Run `{setup_command}`.
2. Ask the user the returned setup questions in this manager Codex chat.
3. Persist the answers with `{workerctl} manager-config`.
4. Use `workerctl manager-config --interactive` only when a human is directly
   running workerctl in a terminal."""

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


def command_telemetry(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
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


def manager_config_questions(existing: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    existing = existing or {}
    permissions = existing.get("permissions") or {}
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
            "kind": "booleans",
            "default": {
                "create_pr": bool(permissions.get("create_pr", False)),
                "merge_green_pr": bool(permissions.get("merge_green_pr", False)),
                "worker_compact_clear": bool(permissions.get("worker_compact_clear", False)),
            },
            "question": "Which high-level actions may the manager instruct the worker to do?",
            "choices": ["create_pr", "merge_green_pr", "worker_compact_clear"],
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

    permission_defaults = questions["permissions"]["default"]
    permissions = {
        "create_pr": _interactive_bool("Allow manager to instruct worker to create a PR?", default=permission_defaults["create_pr"]),
        "merge_green_pr": _interactive_bool("Allow manager to instruct merging a green PR?", default=permission_defaults["merge_green_pr"]),
        "worker_compact_clear": _interactive_bool(
            "Allow manager to instruct worker compact/clear after a saved handoff?",
            default=permission_defaults["worker_compact_clear"],
        ),
    }
    args.allow_pr = permissions["create_pr"]
    args.allow_merge_green = permissions["merge_green_pr"]
    args.allow_worker_compact_clear = permissions["worker_compact_clear"]
    args.permissions_json = json.dumps(permissions, sort_keys=True)


MANAGER_PERMISSION_ACTIONS = {
    "create_pr",
    "merge_green_pr",
    "worker_compact_clear",
}

MANAGER_PERMISSION_ALIASES = {
    "allow_pr": "create_pr",
    "allow_merge_green": "merge_green_pr",
    "allow_worker_compact_clear": "worker_compact_clear",
}


def normalize_manager_permissions(permissions: dict[str, Any] | None) -> dict[str, bool]:
    normalized = {
        "create_pr": False,
        "merge_green_pr": False,
        "worker_compact_clear": False,
    }
    for key, value in (permissions or {}).items():
        canonical = MANAGER_PERMISSION_ALIASES.get(key, key)
        if canonical in normalized:
            normalized[canonical] = bool(value)
    return normalized


def normalize_manager_permission_overrides(permissions: dict[str, Any] | None) -> dict[str, bool]:
    normalized: dict[str, bool] = {}
    for key, value in (permissions or {}).items():
        canonical = MANAGER_PERMISSION_ALIASES.get(key, key)
        if canonical in MANAGER_PERMISSION_ACTIONS:
            normalized[canonical] = bool(value)
    return normalized


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

    if args.action not in MANAGER_PERMISSION_ACTIONS:
        raise WorkerError(f"unknown manager permission action: {args.action}")
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with worker_db.connect(db_path) as conn:
        worker_db.initialize_database(conn)
        task = worker_db.task_row(conn, task=args.task)
        config = worker_db.manager_config(conn, task_id=task["id"])
        handoff = worker_db.latest_worker_handoff(conn, task_id=task["id"])
        reasons: list[str] = []
        allowed = False
        if config is None:
            reasons.append("missing_manager_config")
        else:
            config["permissions"] = normalize_manager_permissions(config["permissions"])
            allowed = bool(config["permissions"].get(args.action, False))
            if not allowed:
                reasons.append("permission_not_enabled")
        if args.require_handoff and handoff is None:
            allowed = False
            reasons.append("missing_worker_handoff")
        result = {
            "action": args.action,
            "allowed": allowed,
            "config": config,
            "handoff_id": handoff["id"] if handoff else None,
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
        permission_allowed = bool(config and config["permissions"].get("worker_compact_clear", False))
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
                args.permissions_json,
                args.allow_pr,
                args.allow_merge_green,
                args.allow_worker_compact_clear,
            ]
        )
        if mutating or existing is None:
            permissions = normalize_manager_permissions(existing["permissions"] if existing else None)
            if args.allow_pr:
                permissions["create_pr"] = True
            if args.allow_merge_green:
                permissions["merge_green_pr"] = True
            if args.allow_worker_compact_clear:
                permissions["worker_compact_clear"] = True
            permissions.update(normalize_manager_permission_overrides(_json_arg(args.permissions_json, flag="--permissions-json")))
            worker_db.upsert_manager_config(
                conn,
                task_id=task["id"],
                supervision_mode=args.mode or (existing["supervision_mode"] if existing else "guided"),
                objective=args.objective if args.objective is not None else (existing["objective"] if existing else None),
                guidelines=args.guideline or (existing["guidelines"] if existing else []),
                acceptance_criteria=args.acceptance or (existing["acceptance_criteria"] if existing else []),
                reference_paths=args.reference or (existing["reference_paths"] if existing else []),
                permissions=permissions,
            )
            worker_db.insert_event(
                conn,
                "manager_config_recorded",
                actor="workerctl",
                task_id=task["id"],
                payload={
                    "acceptance_count": len(args.acceptance),
                    "guideline_count": len(args.guideline),
                    "reference_count": len(args.reference),
                    "supervision_mode": args.mode or (existing["supervision_mode"] if existing else "guided"),
                },
            )
            conn.commit()
        config = worker_db.manager_config(conn, task_id=task["id"])
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
    codex_args: list[str] = ["codex"]
    if sandbox:
        codex_args += ["--sandbox", sandbox]
    if ask_for_approval:
        codex_args += ["--ask-for-approval", ask_for_approval]
    prompt = initial_prompt if initial_prompt is not None else task
    if prompt:
        codex_args.append(prompt)
    codex_cmd = " ".join(shlex.quote(a) for a in codex_args)

    # Spawn tmux + codex.
    worker_tmux.run([
        "tmux", "new-session", "-d", "-s", tmux_session_name, "-c", cwd, codex_cmd,
    ])

    # Discover codex pid + rollout.
    try:
        discovery = _discover_codex_session_in_tmux(
            tmux_session_name, timeout_seconds=timeout_seconds,
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

    Mirrors command_start_worker but with role="manager" and no task prompt.
    Managers supervise rather than execute, so they don't take an initial prompt.

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
        role="manager",
        cwd=args.cwd,
        task=None,
        initial_prompt=manager_bootstrap_prompt(
            manager_name=args.name,
            cwd=args.cwd,
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
    task_id = None
    task_created = False
    manager_config_seeded = False
    manager_config_seeded_by_pair = False
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
            if getattr(args, "manager_allow_pr", False):
                permissions["create_pr"] = True
            if getattr(args, "manager_allow_merge_green", False):
                permissions["merge_green_pr"] = True
            if getattr(args, "manager_allow_worker_compact_clear", False):
                permissions["worker_compact_clear"] = True
            permissions.update(
                normalize_manager_permission_overrides(
                    _json_arg(getattr(args, "manager_permissions_json", None), flag="--manager-permissions-json")
                )
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
                    "supervision_mode": existing_manager_config["supervision_mode"],
                },
            )
            conn.commit()
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
            task=args.task_prompt,
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
                },
            )
            conn.commit()
        finally:
            conn.close()

        result = {
            "task": {"name": args.task, "id": task_id, "created": task_created},
            "worker": worker_info,
            "manager": manager_info,
            "binding_id": binding_id,
            "run_id": run_id,
            "manager_config_seeded": manager_config_seeded,
            "manager_config_seeded_by_pair": manager_config_seeded_by_pair,
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

    conn = worker_db.connect()
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

    conn = worker_db.connect()
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
