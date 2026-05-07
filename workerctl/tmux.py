from __future__ import annotations

import hashlib
import time
from typing import Any

from workerctl.classify import classify_startup_output
from workerctl.constants import DEFAULT_HISTORY_LINES
from workerctl.core import WorkerError, now_iso, run
from workerctl.state import (
    append_event,
    capture_meta_path,
    load_json,
    require_worker,
    transcript_path,
    write_json,
)


def tmux_session(name: str) -> str:
    return f"codex-{name}"


def tmux_target(name: str) -> str:
    return tmux_session(name)


def session_exists(name: str) -> bool:
    proc = run(["tmux", "has-session", "-t", tmux_target(name)], check=False)
    return proc.returncode == 0


def capture_tmux_target(target: str, history_lines: int = DEFAULT_HISTORY_LINES) -> str:
    proc = run(["tmux", "capture-pane", "-p", "-S", f"-{history_lines}", "-t", target])
    return proc.stdout.rstrip("\n")


def capture_output(name: str, history_lines: int = DEFAULT_HISTORY_LINES) -> str:
    require_worker(name)
    if not session_exists(name):
        raise WorkerError(f"tmux session is not running for worker {name}: {tmux_target(name)}")
    output = capture_tmux_target(tmux_target(name), history_lines)
    digest = hashlib.sha256(output.encode()).hexdigest()
    meta = load_json(capture_meta_path(name), {})
    previous_digest = meta.get("sha256")
    previous_changed_at = meta.get("changed_at")
    changed_at = now_iso() if digest != previous_digest else previous_changed_at
    write_json(
        capture_meta_path(name),
        {
            "captured_at": now_iso(),
            "changed_at": changed_at or now_iso(),
            "sha256": digest,
            "history_lines": history_lines,
        },
    )
    transcript_path(name).write_text(output + ("\n" if output else ""))
    return output


def wait_ready(name: str, timeout_seconds: int, accept_trust: bool) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    trust_accepted = False
    last_state = "starting"
    last_reason = "waiting for terminal output"

    while time.monotonic() < deadline:
        if not session_exists(name):
            return {
                "reason": "tmux session exited during startup",
                "startup": "exited",
                "trust_accepted": trust_accepted,
            }
        last_output = capture_tmux_target(tmux_target(name), 80)
        last_state, last_reason = classify_startup_output(last_output)
        if last_state == "needs_trust" and accept_trust and not trust_accepted:
            run(["tmux", "send-keys", "-t", tmux_target(name), "Enter"])
            trust_accepted = True
            append_event(name, "accept_trust")
            time.sleep(1)
            continue
        if last_state in {"ready", "working", "needs_trust", "error"}:
            break
        time.sleep(1)

    result = {
        "reason": last_reason,
        "startup": last_state,
        "timeout_seconds": timeout_seconds,
        "trust_accepted": trust_accepted,
    }
    if last_state == "needs_trust" and not accept_trust:
        result["recommended_action"] = "rerun with --accept-trust if this directory is trusted"
    elif last_state == "starting":
        result["recommended_action"] = "inspect terminal capture"
    else:
        result["recommended_action"] = "none"
    return result


def send_text(name: str, text: str) -> None:
    require_worker(name)
    if not session_exists(name):
        raise WorkerError(f"tmux session is not running for worker {name}: {tmux_target(name)}")
    buffer_name = f"workerctl-{name}"
    run(["tmux", "set-buffer", "-b", buffer_name, text])
    try:
        run(["tmux", "paste-buffer", "-b", buffer_name, "-t", tmux_target(name)])
        run(["tmux", "send-keys", "-t", tmux_target(name), "Enter"])
    finally:
        run(["tmux", "delete-buffer", "-b", buffer_name], check=False)


def interrupt_worker(name: str, *, key: str, followup: str | None, dry_run: bool) -> dict[str, Any]:
    require_worker(name)
    if not session_exists(name):
        raise WorkerError(f"tmux session is not running for worker {name}: {tmux_target(name)}")
    result = {
        "dry_run": dry_run,
        "followup": followup,
        "key": key,
        "name": name,
        "time": now_iso(),
    }
    if not dry_run:
        run(["tmux", "send-keys", "-t", tmux_target(name), key])
        if followup:
            time.sleep(0.5)
            send_text(name, followup)
        append_event(name, "interrupt", result)
    return result

