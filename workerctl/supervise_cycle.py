from __future__ import annotations

import json
import shlex
import sqlite3
import sys
import time
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


class _CycleSpanRecorder:
    def __init__(self, *, task_id: str, manager_cycle_id: int) -> None:
        self.task_id = task_id
        self.manager_cycle_id = manager_cycle_id
        self._spans: list[dict[str, Any]] = []

    def start(self, phase: str) -> dict[str, Any]:
        return {"phase": phase, "started_at": now_iso(), "perf": time.perf_counter()}

    def finish(
        self,
        token: dict[str, Any],
        *,
        state: str = "succeeded",
        attributes: dict[str, Any] | None = None,
        error_type: str | None = None,
    ) -> None:
        completed_at = now_iso()
        self._spans.append(
            {
                "attributes": attributes or {},
                "completed_at": completed_at,
                "duration_ms": max((time.perf_counter() - token["perf"]) * 1000.0, 0.0),
                "error_type": error_type,
                "phase": token["phase"],
                "started_at": token["started_at"],
                "state": state,
            }
        )

    def failed(self, token: dict[str, Any], exc: BaseException) -> None:
        self.finish(token, state="failed", attributes={}, error_type=type(exc).__name__)

    def instant(
        self,
        phase: str,
        *,
        state: str = "succeeded",
        attributes: dict[str, Any] | None = None,
        error_type: str | None = None,
    ) -> None:
        token = self.start(phase)
        self.finish(token, state=state, attributes=attributes, error_type=error_type)

    def flush(self, conn: sqlite3.Connection) -> None:
        for span in self._spans:
            worker_db.insert_manager_cycle_span(
                conn,
                manager_cycle_id=self.manager_cycle_id,
                task_id=self.task_id,
                phase=span["phase"],
                started_at=span["started_at"],
                completed_at=span["completed_at"],
                duration_ms=span["duration_ms"],
                state=span["state"],
                attributes=span["attributes"],
                error_type=span["error_type"],
            )
        self._spans.clear()


def _pane_span_attributes(pane_signal: dict[str, Any]) -> dict[str, Any]:
    return {
        "captured": bool(pane_signal.get("captured")),
        "classifier": pane_signal.get("classifier"),
        "degraded": bool(pane_signal.get("degraded")),
        "notable_pattern": pane_signal.get("notable_pattern"),
        "status_age_seconds": pane_signal.get("status_age_seconds"),
    }


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

    task_arg = shlex.quote(task_name)
    return {
        "needed": True,
        "reason": reason,
        "prompt": CRITERIA_NEGOTIATION_PROMPT,
        "suggested_actions": [
            "Ask the worker to split must-have current-task criteria from follow-up criteria.",
            f"Record accepted current-task criteria with workerctl criteria {task_arg} --add --criterion \"...\" --source worker_proposed --status accepted.",
            f"Record proposed current-task criteria with workerctl criteria {task_arg} --add --criterion \"...\" --source worker_proposed --status proposed.",
            f"Record follow-up criteria with workerctl criteria {task_arg} --add --criterion \"...\" --source worker_proposed --status deferred.",
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
    binding_token = {"phase": "resolve_active_binding", "started_at": now_iso(), "perf": time.perf_counter()}
    binding = worker_db.active_binding_for_task(conn, task_name=task_name)
    cycle_id = worker_db.create_manager_cycle(
        conn,
        task_id=binding["task_id"],
        manager_id=None,
        timestamp=started_at,
    )
    spans = _CycleSpanRecorder(task_id=binding["task_id"], manager_cycle_id=cycle_id)
    spans.finish(
        binding_token,
        attributes={
            "binding_id": binding["binding_id"],
            "binding_state": binding["state"],
            "manager_session": binding["manager_session_name"],
            "worker_session": binding["worker_session_name"],
        },
    )
    worker_db.emit_telemetry_event(
        conn,
        actor="manager",
        event_type="manager_cycle_started",
        task_id=binding["task_id"],
        timestamp=started_at,
        summary=f"Started manager cycle for task {task_name}.",
        correlation={
            "binding_id": binding["binding_id"],
            "manager_session": binding["manager_session_name"],
            "worker_session": binding["worker_session_name"],
        },
        attributes={"busy_wait_seconds": busy_wait_seconds, "cycle_id": cycle_id},
    )
    spans.flush(conn)
    conn.commit()

    active_phase: dict[str, Any] | None = None
    try:
        active_phase = spans.start("ingest_rollout")
        ingest_result = worker_ingest.ingest_session(
            conn,
            session_name=binding["worker_session_name"],
            now=started_at,
        )
        spans.finish(
            active_phase,
            attributes={
                "new_events": ingest_result.get("new_events", 0),
                "new_offset": ingest_result.get("new_offset"),
                "worker_session": binding["worker_session_name"],
            },
        )
        active_phase = None
        active_phase = spans.start("infer_worker_state")
        state = worker_ingest.current_state(
            conn, session_id=binding["worker_session_id"],
        )
        last_state_event_at = worker_ingest.last_state_event_timestamp(
            conn, session_id=binding["worker_session_id"],
        )
        staleness = worker_ingest.session_staleness_seconds(
            conn, session_id=binding["worker_session_id"], now=started_at,
        )
        spans.finish(
            active_phase,
            attributes={
                "last_state_event_present": last_state_event_at is not None,
                "state": state,
                "staleness_seconds": staleness,
            },
        )
        active_phase = None

        # Phase 4 shadow signal — best-effort pane-pattern detection alongside the
        # JSON state. Wrapped in a narrow try/except so transient sqlite/Worker
        # failures don't abort the cycle; genuine programmer bugs (KeyError,
        # AttributeError, etc.) in shadow_state.py / classify.py / ingest.py
        # propagate to the outer cycle handler and get recorded as a `failed` row.
        try:
            active_phase = spans.start("capture_pane_signal")
            pane_signal = worker_shadow.pane_signal_for_session(
                conn,
                session_id=binding["worker_session_id"],
                busy_wait_seconds=busy_wait_seconds,
                now=started_at,
                recent_event_count=ingest_result.get("new_events", 0),
            )
            spans.finish(
                active_phase,
                state="degraded" if pane_signal.get("degraded") else "succeeded",
                attributes=_pane_span_attributes(pane_signal),
            )
            active_phase = None
        except (sqlite3.Error, WorkerError) as exc:  # pragma: no cover — defensive belt-and-suspenders
            pane_signal = {
                "captured": False,
                "classifier": None,
                "notable_pattern": None,
                "status_age_seconds": None,
                "reason": f"pane_signal_for_session raised: {type(exc).__name__}",
                "degraded": False,
            }
            spans.finish(
                active_phase,
                state="degraded",
                attributes=_pane_span_attributes(pane_signal),
                error_type=type(exc).__name__,
            )
            active_phase = None
        notable_pane_pattern = pane_signal.get("notable_pattern")
        spans.instant(
            "classify_pane_signal",
            state="degraded" if pane_signal.get("degraded") else "succeeded",
            attributes={
                "captured": bool(pane_signal.get("captured")),
                "notable_pattern": notable_pane_pattern,
            },
        )

        completed_at = now_iso()

        # Probe worker and manager session pids for liveness.
        active_phase = spans.start("load_manager_context")
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
        manager_config = worker_db.manager_config(conn, task_id=binding["task_id"])
        worker_ack = worker_db.latest_task_acknowledgement(
            conn, task_id=binding["task_id"], role="worker"
        )
        manager_ack = worker_db.latest_task_acknowledgement(
            conn, task_id=binding["task_id"], role="manager"
        )
        if manager_config and manager_config.get("require_acks"):
            stale = [
                role
                for role, ack in (("worker", worker_ack), ("manager", manager_ack))
                if (
                    ack is None
                    or ack.get("binding_id") != binding["binding_id"]
                    or ack.get("manager_config_revision") != manager_config.get("revision")
                )
            ]
        else:
            stale = []
        if stale:
            raise WorkerError(
                "cycle requires current acknowledgement(s) before first observation: "
                + ", ".join(stale)
            )
        consumed_notifications = worker_db.consume_routed_notifications_for_cycle(
            conn,
            task_id=binding["task_id"],
            binding_id=binding["binding_id"],
            manager_cycle_id=cycle_id,
            timestamp=started_at,
        )
        manager_context = {
            "manager_config": manager_config,
            "worker_ack": worker_ack,
            "manager_ack": manager_ack,
            "worker_handoff": worker_db.latest_worker_handoff(conn, task_id=binding["task_id"]),
            "acceptance_criteria": criteria_context,
            "criteria_negotiation": _criteria_negotiation_context(
                task_name=task_name,
                criteria_context=criteria_context,
            ),
        }
        spans.finish(
            active_phase,
            attributes={
                "accepted_criteria": criteria_context["summary"]["accepted"],
                "manager_config_present": manager_config is not None,
                "manager_ack_present": manager_ack is not None,
                "require_acks": bool(manager_config and manager_config.get("require_acks")),
                "worker_ack_present": worker_ack is not None,
                "worker_handoff_present": manager_context["worker_handoff"] is not None,
                "consumed_dispatch_notifications": consumed_notifications,
            },
        )
        active_phase = None
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
            "consumed_dispatch_notifications": consumed_notifications,
            "last_event_subtype": last_subtype,
            "task_completed": last_subtype == "task_complete",
        }
        active_phase = spans.start("persist_cycle_row")
        worker_db.finish_manager_cycle(
            conn,
            cycle_id=cycle_id,
            state="succeeded",
            status=status_payload,
            timestamp=completed_at,
        )
        spans.finish(
            active_phase,
            attributes={
                "manager_alive": status_payload["manager_alive"],
                "state": state,
                "task_completed": last_subtype == "task_complete",
                "worker_alive": status_payload["worker_alive"],
            },
        )
        active_phase = None
        spans.flush(conn)
    except Exception as exc:
        # Discard any partial inserts (e.g. codex_events from a half-finished
        # ingest_session call) before committing the audit row, so re-running
        # the cycle picks the same events up again rather than skipping them.
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        completed_at = now_iso()
        failure_phase = active_phase["phase"] if active_phase is not None else "unknown"
        if active_phase is not None:
            spans.failed(active_phase, exc)
        failure_status = {
            "kind": "session_cycle",
            "task": task_name,
            "binding_id": binding["binding_id"],
            "worker_session": binding["worker_session_name"],
            "manager_session": binding["manager_session_name"],
            "error_type": type(exc).__name__,
            "failure_phase": failure_phase,
        }
        try:
            worker_db.finish_manager_cycle(
                conn,
                cycle_id=cycle_id,
                state="failed",
                status=failure_status,
                error=str(exc),
                timestamp=completed_at,
            )
            spans.flush(conn)
            worker_db.emit_telemetry_event(
                conn,
                actor="manager",
                event_type="manager_cycle_failed",
                severity="error",
                task_id=binding["task_id"],
                summary=f"Manager cycle failed for task {task_name}.",
                correlation={
                    "binding_id": binding["binding_id"],
                    "cycle_id": cycle_id,
                    "manager_session": binding["manager_session_name"],
                    "worker_session": binding["worker_session_name"],
                },
                attributes={
                    "error_type": type(exc).__name__,
                    "failure_phase": failure_phase,
                },
            )
            conn.commit()
        except sqlite3.Error as audit_exc:
            print(
                f"workerctl: failed to record cycle audit row for task "
                f"{task_name!r}: {type(audit_exc).__name__}: {audit_exc}",
                file=sys.stderr,
            )
        raise
    worker_db.emit_telemetry_event(
        conn,
        actor="manager",
        event_type="manager_cycle_succeeded",
        task_id=binding["task_id"],
        summary=f"Manager cycle succeeded for task {task_name}.",
        correlation={
            "binding_id": binding["binding_id"],
            "cycle_id": cycle_id,
            "manager_session": binding["manager_session_name"],
            "worker_session": binding["worker_session_name"],
        },
        attributes={
            "ingest": ingest_result,
            "last_event_subtype": last_subtype,
            "notable_pane_pattern": notable_pane_pattern,
            "state": state,
            "task_completed": last_subtype == "task_complete",
            "worker_alive": status_payload["worker_alive"],
            "manager_alive": status_payload["manager_alive"],
        },
    )
    conn.commit()

    return {
        **status_payload,
        "cycle_id": cycle_id,
        "cycle_started_at": started_at,
        "cycle_completed_at": completed_at,
    }
