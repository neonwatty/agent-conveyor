from __future__ import annotations

import json
import time
from typing import Any

from workerctl.classify import classify_busy_wait
from workerctl.constants import VALID_STATES
from workerctl.core import WorkerError, age_seconds, now_iso
from workerctl.state import (
    append_event,
    capture_meta_path,
    last_event_age_seconds,
    latest_status,
    load_json,
    require_worker,
    transcript_path,
)
from workerctl.tmux import capture_output, capture_tmux_target, interrupt_worker, send_text, session_exists, tmux_target

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
    if running:
        try:
            terminal_output = capture_tmux_target(tmux_target(name), lines)
        except WorkerError:
            terminal_output = transcript_path(name).read_text() if transcript_path(name).exists() else ""
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


def command_supervise(args: argparse.Namespace) -> int:
    interrupt_followup = args.interrupt_followup or None
    result = supervise_once(
        args.name,
        status_stale_seconds=args.status_stale_seconds,
        terminal_stale_seconds=args.terminal_stale_seconds,
        busy_wait_seconds=args.busy_wait_seconds,
        refresh=args.refresh,
        lines=args.lines,
        cooldown_seconds=args.cooldown_seconds,
        message=args.message,
        dry_run=args.dry_run,
        interrupt_busy_wait=args.interrupt_busy_wait,
        interrupt_key=args.interrupt_key,
        interrupt_followup=interrupt_followup,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def supervise_once(
    name: str,
    *,
    status_stale_seconds: int,
    terminal_stale_seconds: int,
    busy_wait_seconds: int,
    refresh: bool,
    lines: int,
    cooldown_seconds: int,
    message: str,
    dry_run: bool,
    interrupt_busy_wait: bool,
    interrupt_key: str,
    interrupt_followup: str | None,
) -> dict[str, Any]:
    summary = idle_summary(
        name,
        status_stale_seconds=status_stale_seconds,
        terminal_stale_seconds=terminal_stale_seconds,
        busy_wait_seconds=busy_wait_seconds,
        refresh=refresh,
        lines=lines,
    )

    action_taken = "none"
    sent_message = None
    cooldown_remaining = None
    reason = summary["reason"]
    health = summary["health"]

    if health == "stale":
        last_nudge_age = last_event_age_seconds(name, "supervise_nudge")
        if last_nudge_age is not None and last_nudge_age < cooldown_seconds:
            action_taken = "cooldown"
            cooldown_remaining = cooldown_seconds - last_nudge_age
            reason = f"last supervise nudge was {last_nudge_age}s ago"
        elif dry_run:
            action_taken = "would_nudge"
            sent_message = message
        else:
            sent_message = message
            send_text(name, sent_message)
            append_event(name, "supervise_nudge", {"message": sent_message, "health": health})
            action_taken = "nudge"
    elif health == "blocked":
        action_taken = "read_blocker"
    elif health == "done":
        action_taken = "review_result"
    elif health == "stopped":
        action_taken = "none"
    elif health in {"active", "quiet", "status_stale"}:
        action_taken = "wait"
    elif health == "busy_wait":
        if interrupt_busy_wait:
            if dry_run:
                action_taken = "would_interrupt"
            else:
                interrupt_worker(name, key=interrupt_key, followup=interrupt_followup, dry_run=False)
                action_taken = "interrupt"
        else:
            action_taken = "inspect_or_interrupt"
    elif health == "unknown":
        action_taken = "inspect_terminal"

    result = {
        "action_taken": action_taken,
        "blocker": summary.get("blocker"),
        "cooldown_remaining_seconds": cooldown_remaining,
        "current_task": summary.get("current_task"),
        "dry_run": dry_run,
        "health": health,
        "message": sent_message,
        "name": name,
        "next_action": summary.get("next_action"),
        "reason": reason,
        "recommended_action": summary.get("recommended_action"),
        "state": summary.get("state"),
        "time": now_iso(),
        "busy_wait_pattern": summary.get("busy_wait_pattern"),
    }
    append_event(name, "supervise", result)
    return result


def command_watch(args: argparse.Namespace) -> int:
    cycle = 0
    interrupt_followup = args.interrupt_followup or None
    try:
        while True:
            cycle += 1
            result = supervise_once(
                args.name,
                status_stale_seconds=args.status_stale_seconds,
                terminal_stale_seconds=args.terminal_stale_seconds,
                busy_wait_seconds=args.busy_wait_seconds,
                refresh=args.refresh,
                lines=args.lines,
                cooldown_seconds=args.cooldown_seconds,
                message=args.message,
                dry_run=args.dry_run,
                interrupt_busy_wait=args.interrupt_busy_wait,
                interrupt_key=args.interrupt_key,
                interrupt_followup=interrupt_followup,
            )
            result["cycle"] = cycle
            print(json.dumps(result, sort_keys=True), flush=True)
            if args.max_cycles is not None and cycle >= args.max_cycles:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print(json.dumps({"event": "watch_interrupted", "name": args.name, "time": now_iso()}), flush=True)
    return 0

