from __future__ import annotations

import sqlite3
from typing import Any

from workerctl import classify as worker_classify
from workerctl import ingest as worker_ingest
from workerctl import tmux as worker_tmux


DEFAULT_BUSY_WAIT_SECONDS = 90


def pane_signal_for_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    busy_wait_seconds: int = DEFAULT_BUSY_WAIT_SECONDS,
    now: str | None = None,
) -> dict[str, Any]:
    """Capture the session's tmux pane and run `classify_busy_wait` on the text.

    Returns a dict with stable keys:
      - `captured` (bool): whether the tmux capture succeeded.
      - `classifier` (dict | None): the raw output of `classify_busy_wait` if a
        pattern matched, else None.
      - `notable_pattern` (str | None): the `pattern` key from `classifier` for
        easy filtering, else None.
      - `status_age_seconds` (int | None): the staleness used as the classifier's
        `status_age` argument (Phase 2 JSON staleness, rounded to int seconds).
      - `reason` (str | None): a short message when `captured=False`, explaining
        why (e.g. "no tmux session attached", "<exception text>").

    This function is best-effort: tmux capture exceptions are caught and surfaced
    in `reason` rather than raised. The caller (e.g. `supervise_cycle.run_cycle`)
    should be able to enrich a cycle with a pane signal without aborting on a
    transient tmux failure.
    """
    row = conn.execute(
        "select * from sessions where id = ?", (session_id,)
    ).fetchone()
    if row is None:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"unknown session id {session_id!r}",
        }
    if not row["tmux_session"]:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": "no tmux session attached",
        }
    target = worker_tmux.session_tmux_target(row)
    try:
        output = worker_tmux.capture_tmux_target(target)
    except Exception as exc:
        return {
            "captured": False,
            "classifier": None,
            "notable_pattern": None,
            "status_age_seconds": None,
            "reason": f"tmux capture failed: {exc}",
        }
    staleness = worker_ingest.session_staleness_seconds(
        conn, session_id=session_id, now=now,
    )
    status_age_seconds = int(staleness) if staleness is not None else None
    classifier = worker_classify.classify_busy_wait(
        output, status_age_seconds, busy_wait_seconds,
    )
    return {
        "captured": True,
        "classifier": classifier,
        "notable_pattern": classifier["pattern"] if classifier else None,
        "status_age_seconds": status_age_seconds,
        "reason": None,
    }
