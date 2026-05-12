from __future__ import annotations

import sqlite3
from typing import Optional, TypedDict

from workerctl import classify as worker_classify
from workerctl import core as worker_core
from workerctl import db as worker_db
from workerctl import ingest as worker_ingest
from workerctl import tmux as worker_tmux


DEFAULT_BUSY_WAIT_SECONDS = 90


class Classifier(TypedDict):
    """Return shape of `classify.classify_busy_wait`. Locked here because we
    persist this through `manager_cycles.status_json` via `pane_signal.classifier`.
    Any change to classify_busy_wait's return shape becomes a stored-data
    compatibility concern."""
    pattern: str
    reason: str
    recommended_action: str


class PaneSignal(TypedDict):
    """Stable contract for the shadow pane signal. Persisted into
    `manager_cycles.status_json` as `pane_signal`. Phase 4 consumers
    (`run_cycle`, `replay.py`, the `divergences` CLI, tests) depend on
    every key listed here."""
    captured: bool
    classifier: Optional[Classifier]
    notable_pattern: Optional[str]
    status_age_seconds: Optional[int]
    reason: Optional[str]
    degraded: bool


def _pane_signal(
    *,
    captured: bool,
    classifier: Optional[Classifier] = None,
    status_age_seconds: Optional[int] = None,
    reason: Optional[str] = None,
    degraded: bool = False,
) -> PaneSignal:
    """Construct a `PaneSignal` from individual fields.

    Derives `notable_pattern` from `classifier["pattern"]` automatically so
    callers cannot forget the consistency invariant. This factory is the ONLY
    constructor of `PaneSignal` dicts; do not inline-construct elsewhere.
    """
    notable_pattern = classifier["pattern"] if classifier else None
    return {
        "captured": captured,
        "classifier": classifier,
        "notable_pattern": notable_pattern,
        "status_age_seconds": status_age_seconds,
        "reason": reason,
        "degraded": degraded,
    }


def pane_signal_for_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    busy_wait_seconds: int = DEFAULT_BUSY_WAIT_SECONDS,
    now: str | None = None,
) -> PaneSignal:
    """Capture the session's tmux pane and run `classify_busy_wait` on the text.

    Returns a `PaneSignal` dict with stable keys:
      - `captured` (bool): whether the tmux capture succeeded.
      - `classifier` (dict | None): the raw output of `classify_busy_wait` if a
        pattern matched, else None.
      - `notable_pattern` (str | None): the `pattern` key from `classifier` for
        easy filtering, else None.
      - `status_age_seconds` (int | None): the staleness used as the classifier's
        `status_age` argument (Phase 2 JSON staleness, truncated to int seconds).
      - `reason` (str | None): a short message describing a non-default outcome.
        Non-None when `captured=False` (e.g. "no tmux session attached",
        "<exception text>"), AND non-None on the captured-but-degraded path
        (`captured=True, degraded=True`) where it explains why classification
        ran with reduced inputs. None on the clean success path.
      - `degraded` (bool): True when the signal was collected but classification
        ran with reduced inputs (currently: when staleness was unavailable).
        Operators / callers should distinguish this from clean captures.

    The returned dict ALWAYS contains all six keys — callers must NOT check
    `pane_signal is None`. Use `pane_signal["captured"]` (and optionally
    `pane_signal["degraded"]`) instead.

    This function is best-effort: tmux capture exceptions are caught and surfaced
    in `reason` rather than raised. The caller (e.g. `supervise_cycle.run_cycle`)
    should be able to enrich a cycle with a pane signal without aborting on a
    transient tmux failure.
    """
    row = worker_db.session_by_id(conn, session_id=session_id)
    if row is None:
        return _pane_signal(
            captured=False,
            reason=f"unknown session id {session_id!r}",
        )
    if not row["tmux_session"]:
        return _pane_signal(
            captured=False,
            reason="no tmux session attached",
        )
    target = worker_tmux.session_tmux_target(row)
    try:
        output = worker_tmux.capture_tmux_target(target)
    except (worker_core.WorkerError, OSError) as exc:
        return _pane_signal(
            captured=False,
            reason=f"tmux capture failed: {exc}",
        )
    try:
        staleness = worker_ingest.session_staleness_seconds(
            conn, session_id=session_id, now=now,
        )
    except worker_ingest.IngestError as exc:
        # Best-effort: a malformed timestamp in codex_events shouldn't kill the
        # pane signal. Surface it in `reason`, mark `degraded=True`, and proceed
        # without a status age.
        classifier = worker_classify.classify_busy_wait(
            output, None, busy_wait_seconds,
        )
        return _pane_signal(
            captured=True,
            classifier=classifier,
            status_age_seconds=None,
            reason=f"staleness unavailable: {exc}",
            degraded=True,
        )
    status_age_seconds = int(staleness) if staleness is not None else None
    classifier = worker_classify.classify_busy_wait(
        output, status_age_seconds, busy_wait_seconds,
    )
    return _pane_signal(
        captured=True,
        classifier=classifier,
        status_age_seconds=status_age_seconds,
        reason=None,
        degraded=False,
    )
