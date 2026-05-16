from __future__ import annotations

import json
import sqlite3
import sys
from typing import Any

from workerctl import db as worker_db
from workerctl import ingest as worker_ingest
from workerctl import shadow_state as worker_shadow
from workerctl.core import WorkerError, now_iso
from workerctl.commands import _pid_is_alive


DEFAULT_BUSY_WAIT_SECONDS = 90
ACCEPTANCE_CRITERION_STATUSES = ("proposed", "accepted", "satisfied", "deferred", "rejected")
CRITERIA_NEGOTIATION_PROMPT = (
    "Please propose 2-4 acceptance criteria for the current slice. "
    "Split them into must-have current-task criteria and follow-up criteria. "
    "Include the verification you expect for each."
)


def _acceptance_criteria_context(
    conn: sqlite3.Connection,
    *,
    task_id: str,
) -> dict[str, Any]:
    grouped = {status: [] for status in ACCEPTANCE_CRITERION_STATUSES}
    for criterion in worker_db.acceptance_criteria_for_task(conn, task_id=task_id):
        grouped[criterion["status"]].append(criterion)

    return {
        "summary": {
            status: len(grouped[status])
            for status in ACCEPTANCE_CRITERION_STATUSES
        },
        "open": grouped["accepted"],
        "proposed": grouped["proposed"],
        "satisfied": grouped["satisfied"],
        "deferred": grouped["deferred"],
        "rejected": grouped["rejected"],
    }


def _criteria_negotiation_context(
    *,
    task_name: str,
    criteria_context: dict[str, Any],
) -> dict[str, Any]:
    summary = criteria_context["summary"]
    active_count = summary["proposed"] + summary["accepted"] + summary["satisfied"]
    total_count = sum(summary.values())
    if total_count == 0:
        reason = "no_criteria"
    elif active_count == 0:
        reason = "no_current_task_criteria"
    else:
        return {
            "needed": False,
            "reason": "active_criteria_present",
            "prompt": None,
            "suggested_actions": [],
        }

    return {
        "needed": True,
        "reason": reason,
        "prompt": CRITERIA_NEGOTIATION_PROMPT,
        "suggested_actions": [
            "Ask the worker to split must-have current-task criteria from follow-up criteria.",
            f"Record accepted current-task criteria with workerctl criteria {task_name} --add --criterion \"...\" --source worker_proposed --status accepted.",
            f"Record proposed current-task criteria with workerctl criteria {task_name} --add --criterion \"...\" --source worker_proposed --status proposed.",
            f"Record follow-up criteria with workerctl criteria {task_name} --add --criterion \"...\" --source worker_proposed --status deferred.",
        ],
    }


def run_cycle(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    busy_wait_seconds: int = DEFAULT_BUSY_WAIT_SECONDS,
    now: str | None = None,
) -> dict[str, Any]:
    """Perform one observation cycle for a session-bound task.

    Steps:
      1. Resolve the active binding for `task_name` (raises WorkerError if missing).
      2. Run `ingest_session` on the worker session to pull any new rollout events.
      3. Compute `current_state` and staleness from `codex_events`.
      4. Write a `manager_cycles` row with the structured status.
      5. Return a JSON-serializable dict for the manager Codex (or operator) to act on.

    The returned dict has two groups of keys.

    Persisted in `manager_cycles.status_json` (and therefore present on this
    return AND on replay/`divergent_cycles_for_task` reads):
      - `kind` (always "session_cycle", a shape discriminator that `replay.py`
        branches on)
      - `task`, `binding_id`, `worker_session`, `manager_session`
      - `ingest` ({new_events, new_offset})
      - `state`, `last_state_event_at`, `staleness_seconds`
      - `pane_signal` — always a dict (see shadow_state.PaneSignal). Callers
        must check `pane_signal["captured"]`; pane_signal is NEVER None.
      - `notable_pane_pattern` — top-level shortcut to
        `pane_signal["notable_pattern"]`, for cheap `json_extract` filtering.
      - `worker_alive`, `manager_alive` — boolean pid probes for registered
        sessions; always present (False for None/dead pids).

    Return-only (NOT persisted; computed at return time):
      - `cycle_id`, `cycle_started_at`, `cycle_completed_at`.

    Phase 3 supervision consumers depend on these names.

    On any exception during ingest / state inference / cycle-row write, the
    function rolls back uncommitted writes, records a `state='failed'` row in
    `manager_cycles` with `error` populated, then re-raises. The audit trail
    captures both successful and unsuccessful cycle attempts.

    Raises:
      - WorkerError: task or active binding missing (no failure row written —
        these errors occur before any state could be observed).
      - IngestError: rollout file missing, rotated, or unreadable.
      - Other exceptions: re-raised after recording a failure row.
    """
    # TODO(phase-5): promote run_cycle return to a TypedDict (SessionCycleResult)
    # once the nested `ingest` and `pane_signal` shapes stabilize.
    started_at = now or now_iso()
    binding = worker_db.active_binding_for_task(conn, task_name=task_name)

    try:
        ingest_result = worker_ingest.ingest_session(
            conn,
            session_name=binding["worker_session_name"],
            now=started_at,
        )
        state = worker_ingest.current_state(
            conn, session_id=binding["worker_session_id"],
        )
        last_state_event_at = worker_ingest.last_state_event_timestamp(
            conn, session_id=binding["worker_session_id"],
        )
        staleness = worker_ingest.session_staleness_seconds(
            conn, session_id=binding["worker_session_id"], now=started_at,
        )

        # Phase 4 shadow signal — best-effort pane-pattern detection alongside the
        # JSON state. Wrapped in a narrow try/except so transient sqlite/Worker
        # failures don't abort the cycle; genuine programmer bugs (KeyError,
        # AttributeError, etc.) in shadow_state.py / classify.py / ingest.py
        # propagate to the outer cycle handler and get recorded as a `failed` row.
        try:
            pane_signal = worker_shadow.pane_signal_for_session(
                conn,
                session_id=binding["worker_session_id"],
                busy_wait_seconds=busy_wait_seconds,
                now=started_at,
                recent_event_count=ingest_result.get("new_events", 0),
            )
        except (sqlite3.Error, WorkerError) as exc:  # pragma: no cover — defensive belt-and-suspenders
            pane_signal = {
                "captured": False,
                "classifier": None,
                "notable_pattern": None,
                "status_age_seconds": None,
                "reason": f"pane_signal_for_session raised: {exc}",
                "degraded": False,
            }
        notable_pane_pattern = pane_signal.get("notable_pattern")
    except Exception as exc:
        # Discard any partial inserts (e.g. codex_events from a half-finished
        # ingest_session call) before committing the audit row, so re-running
        # the cycle picks the same events up again rather than skipping them.
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        completed_at = now_iso()
        failure_status = {
            "kind": "session_cycle",
            "task": task_name,
            "binding_id": binding["binding_id"],
            "worker_session": binding["worker_session_name"],
            "manager_session": binding["manager_session_name"],
            "error_type": type(exc).__name__,
        }
        try:
            conn.execute(
                """
                insert into manager_cycles(
                  task_id, started_at, completed_at, state, status_json, error
                )
                values (?, ?, ?, 'failed', ?, ?)
                """,
                (
                    binding["task_id"],
                    started_at,
                    completed_at,
                    json.dumps(failure_status, sort_keys=True, default=str),
                    str(exc),
                ),
            )
            conn.commit()
        except sqlite3.Error as audit_exc:
            print(
                f"workerctl: failed to record cycle audit row for task "
                f"{task_name!r}: {type(audit_exc).__name__}: {audit_exc}",
                file=sys.stderr,
            )
        raise

    completed_at = now_iso()

    # Probe worker and manager session pids for liveness.
    worker_row = worker_db.session_by_id(conn, session_id=binding["worker_session_id"])
    manager_row = worker_db.session_by_id(conn, session_id=binding["manager_session_id"])

    def _alive(row) -> bool:
        if row is None or row["pid"] is None:
            return False
        try:
            return _pid_is_alive(int(row["pid"]))
        except (TypeError, ValueError):
            return False

    last_subtype = worker_db.latest_codex_event_subtype(
        conn, session_id=binding["worker_session_id"]
    )
    criteria_context = _acceptance_criteria_context(conn, task_id=binding["task_id"])
    manager_context = {
        "manager_config": worker_db.manager_config(conn, task_id=binding["task_id"]),
        "worker_handoff": worker_db.latest_worker_handoff(conn, task_id=binding["task_id"]),
        "acceptance_criteria": criteria_context,
        "criteria_negotiation": _criteria_negotiation_context(
            task_name=task_name,
            criteria_context=criteria_context,
        ),
    }
    status_payload = {
        "kind": "session_cycle",
        "task": task_name,
        "binding_id": binding["binding_id"],
        "worker_session": binding["worker_session_name"],
        "manager_session": binding["manager_session_name"],
        "ingest": ingest_result,
        "state": state,
        "last_state_event_at": last_state_event_at,
        "staleness_seconds": staleness,
        "pane_signal": pane_signal,
        "notable_pane_pattern": notable_pane_pattern,
        "worker_alive": _alive(worker_row),
        "manager_alive": _alive(manager_row),
        "manager_context": manager_context,
        "last_event_subtype": last_subtype,
        "task_completed": last_subtype == "task_complete",
    }
    cursor = conn.execute(
        """
        insert into manager_cycles(
          task_id, started_at, completed_at, state, status_json
        )
        values (?, ?, ?, 'succeeded', ?)
        """,
        (
            binding["task_id"],
            started_at,
            completed_at,
            json.dumps(status_payload, sort_keys=True, default=str),
        ),
    )
    cycle_id = int(cursor.lastrowid)
    conn.commit()

    return {
        **status_payload,
        "cycle_id": cycle_id,
        "cycle_started_at": started_at,
        "cycle_completed_at": completed_at,
    }
