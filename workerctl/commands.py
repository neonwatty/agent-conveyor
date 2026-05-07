from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from workerctl.classify import classify_busy_wait, classify_startup_output
from workerctl.constants import PROJECT_ROOT, VALID_STATES
from workerctl.core import WorkerError, ensure_tool, now_iso, run, sh_quote
from workerctl.state import (
    append_event,
    capture_meta_path,
    config_path,
    initial_status,
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
from workerctl.tmux import (
    capture_output,
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
    return f"scripts/workerctl stop {name}"


def print_worker_commands(name: str) -> None:
    print("")
    print("Attach:")
    print(f"  {attach_command(name)}")
    print("")
    print("Stop:")
    print(f"  {stop_command(name)}")


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

    worker_dir(name).mkdir(parents=True, exist_ok=True)
    write_json(
        config_path(name),
        {
            "created_at": now_iso(),
            "cwd": str(directory),
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

    contract_path = write_worker_contract(name, args.task)
    if args.initial_prompt:
        shell_command = (
            f"codex --cd {sh_quote(str(directory))} --no-alt-screen "
            f"\"$(cat {sh_quote(str(contract_path))})\""
        )
    else:
        shell_command = f"codex --cd {sh_quote(str(directory))} --no-alt-screen"
    run(["tmux", "new-session", "-d", "-s", tmux_session(name), shell_command])
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
        f"Read README.md and update only .codex-workers/{name}/status.json with a short summary. "
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
    status = load_json(status_path(args.name), {})
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
