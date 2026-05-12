from __future__ import annotations

import json
import sqlite3
from typing import Any

from workerctl import db as worker_db
from workerctl import ingest as worker_ingest
from workerctl.core import WorkerError, now_iso


def run_cycle(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    now: str | None = None,
) -> dict[str, Any]:
    """Perform one observation cycle for a session-bound task.

    Steps:
      1. Resolve the active binding for `task_name` (raises WorkerError if missing).
      2. Run `ingest_session` on the worker session to pull any new rollout events.
      3. Compute `current_state` and staleness from `codex_events`.
      4. Write a `manager_cycles` row with the structured status.
      5. Return a JSON-serializable dict for the manager Codex (or operator) to act on.

    The returned dict has stable keys: `task`, `binding_id`, `worker_session`,
    `manager_session`, `ingest` ({new_events, new_offset}), `state`,
    `last_state_event_at`, `staleness_seconds`, `cycle_id`, `cycle_started_at`,
    `cycle_completed_at`. Phase 3 supervision consumers depend on these names.

    Raises:
      - WorkerError: task or active binding missing.
      - IngestError: rollout file missing or unreadable.
    """
    started_at = now or now_iso()
    binding = worker_db.active_binding_for_task(conn, task_name=task_name)

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

    completed_at = now_iso()
    status_payload = {
        "task": task_name,
        "binding_id": binding["binding_id"],
        "worker_session": binding["worker_session_name"],
        "manager_session": binding["manager_session_name"],
        "ingest": ingest_result,
        "state": state,
        "last_state_event_at": last_state_event_at,
        "staleness_seconds": staleness,
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
