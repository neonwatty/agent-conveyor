from __future__ import annotations

import hashlib
import sqlite3
import time
from typing import Any

from workerctl.classify import classify_startup_output
from workerctl.constants import DEFAULT_HISTORY_LINES
from workerctl.core import WorkerError, now_iso, raise_for_tmux_permission_failure, run
from workerctl.db import connect as connect_db
from workerctl.db import initialize_database, insert_transcript_capture, upsert_worker
from workerctl.state import (
    append_event,
    capture_meta_path,
    load_json,
    require_worker,
    transcript_path,
    write_json,
)


PASTE_SUBMIT_DELAY_SECONDS = 0.1
SUBMIT_KEY = "C-m"


def tmux_session(name: str) -> str:
    return f"codex-{name}"


def tmux_target(name: str) -> str:
    return tmux_session(name)


def session_exists(name: str) -> bool:
    proc = run(["tmux", "has-session", "-t", tmux_target(name)], check=False)
    raise_for_tmux_permission_failure(proc)
    return proc.returncode == 0


def current_pane_id(target: str) -> str | None:
    proc = run(["tmux", "list-panes", "-t", target, "-F", "#{pane_id}"], check=False)
    raise_for_tmux_permission_failure(proc)
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        pane_id = line.strip()
        if pane_id:
            return pane_id
    return None


def current_session_name() -> str | None:
    proc = run(["tmux", "display-message", "-p", "#S"], check=False)
    raise_for_tmux_permission_failure(proc)
    if proc.returncode != 0:
        return None
    session = proc.stdout.strip()
    return session or None


def capture_tmux_target(target: str, history_lines: int = DEFAULT_HISTORY_LINES) -> str:
    proc = run(["tmux", "capture-pane", "-p", "-S", f"-{history_lines}", "-t", target])
    return proc.stdout.rstrip("\n")


def capture_output(name: str, history_lines: int = DEFAULT_HISTORY_LINES) -> str:
    config = require_worker(name)
    if not session_exists(name):
        raise WorkerError(f"tmux session is not running for worker {name}: {tmux_target(name)}")
    output = capture_tmux_target(tmux_target(name), history_lines)
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
            tmux_session=config.get("tmux_session", tmux_session(name)),
            identity_token=config.get("identity_token"),
            tmux_pane_id=config.get("tmux_pane_id") or current_pane_id(config.get("tmux_session", tmux_session(name))),
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
        time.sleep(PASTE_SUBMIT_DELAY_SECONDS)
        run(["tmux", "send-keys", "-t", tmux_target(name), SUBMIT_KEY])
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


def session_tmux_target(row: sqlite3.Row) -> str:
    """Build a `tmux send-keys -t TARGET` string from a `sessions` row.

    If the row has a `tmux_pane_id` (e.g. `%5`), the target is `<session>:<pane_id>`
    so we hit a specific pane. Otherwise the target is the session name and tmux
    routes to the active pane in window 0.

    Raises WorkerError if the row has no tmux_session (e.g. a manager registered
    outside tmux).
    """
    session_name = row["tmux_session"]
    if not session_name:
        raise WorkerError(
            "session has no tmux_session; cannot build tmux target "
            "(session likely registered outside tmux)"
        )
    pane_id = row["tmux_pane_id"]
    if pane_id:
        return f"{session_name}:{pane_id}"
    return session_name


def _tmux_session_running(tmux_session: str) -> bool:
    """Return True if a tmux server has a session named `tmux_session`.

    Unlike `session_exists`, this takes the raw tmux session name (not a worker
    name), making it safe to call for session-keyed lookups where the legacy
    `codex-{name}` convention does not apply.
    """
    proc = run(["tmux", "has-session", "-t", tmux_session], check=False)
    raise_for_tmux_permission_failure(proc)
    return proc.returncode == 0


def send_text_to_session(
    conn: sqlite3.Connection,
    *,
    session_name: str,
    text: str,
    dry_run: bool = False,
    side_effect_audit: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Send `text` (followed by Enter) to the session's tmux pane.

    Resolves the session via `db.session_row` and rejects sessions without a tmux
    session attached (e.g. managers running outside tmux). Mirrors `send_text` but
    keyed by session_id instead of worker name.
    """
    from workerctl import db as worker_db

    row = worker_db.session_row(conn, name=session_name)
    target = session_tmux_target(row)
    result = {
        "dry_run": dry_run,
        "session": session_name,
        "side_effect_completed": False,
        "side_effect_started": False,
        "target": target,
        "text": text,
        "time": now_iso(),
    }
    if side_effect_audit is not None:
        side_effect_audit.update(
            {
                "side_effect_completed": False,
                "side_effect_started": False,
                "target": target,
            }
        )
    if dry_run:
        return result
    if not _tmux_session_running(row["tmux_session"]):
        raise WorkerError(
            f"tmux session is not running for session {session_name!r}: "
            f"{row['tmux_session']}"
        )
    buffer_name = f"workerctl-session-{session_name}"
    try:
        run(["tmux", "set-buffer", "-b", buffer_name, text])
        run(["tmux", "paste-buffer", "-b", buffer_name, "-t", target])
        result["side_effect_started"] = True
        if side_effect_audit is not None:
            side_effect_audit["side_effect_started"] = True
        time.sleep(PASTE_SUBMIT_DELAY_SECONDS)
        run(["tmux", "send-keys", "-t", target, SUBMIT_KEY])
        result["side_effect_completed"] = True
        if side_effect_audit is not None:
            side_effect_audit["side_effect_completed"] = True
    finally:
        run(["tmux", "delete-buffer", "-b", buffer_name], check=False)
    return result


def interrupt_session(
    conn: sqlite3.Connection,
    *,
    session_name: str,
    key: str = "C-c",
    followup: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Send an interrupt key (default Ctrl-C) to the session's tmux pane.

    Optional `followup` text is paste-buffered after a short delay. Mirrors
    `interrupt_worker` but keyed by session_id.
    """
    from workerctl import db as worker_db

    row = worker_db.session_row(conn, name=session_name)
    target = session_tmux_target(row)
    result = {
        "dry_run": dry_run,
        "followup": followup,
        "key": key,
        "session": session_name,
        "target": target,
        "time": now_iso(),
    }
    if dry_run:
        return result
    if not _tmux_session_running(row["tmux_session"]):
        raise WorkerError(
            f"tmux session is not running for session {session_name!r}: "
            f"{row['tmux_session']}"
        )
    run(["tmux", "send-keys", "-t", target, key])
    if followup:
        time.sleep(0.5)
        send_text_to_session(conn, session_name=session_name, text=followup)
    return result
