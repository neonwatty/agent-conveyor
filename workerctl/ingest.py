from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from workerctl import db as worker_db
from workerctl.core import WorkerError, now_iso


class IngestError(Exception):
    """Raised when ingestion can't proceed for a structural reason (missing rollout, etc)."""


def parse_jsonl_events(content: bytes, *, start_offset: int) -> Iterator[dict[str, Any]]:
    """Yield parsed JSONL records from `content`, tracking absolute byte offsets.

    `start_offset` is the absolute file offset corresponding to `content[0]`.
    The caller is expected to have read the file from that offset.

    Each yielded dict has:
      - `type`: top-level record type (session_meta, event_msg, response_item, ...).
      - `subtype`: inner payload type for event_msg, else None.
      - `timestamp`: ISO timestamp from the record, or None if absent.
      - `payload`: the raw payload dict.
      - `byte_offset`: absolute file offset where this record's line starts.
      - `new_offset`: absolute file offset just after this record's terminating newline.

    Lines without a trailing newline are NOT yielded (assumed to be a partial write).
    Malformed lines (invalid JSON) are silently skipped, but the offset still advances
    past them so they aren't reprocessed.
    """
    cursor = 0
    while True:
        newline = content.find(b"\n", cursor)
        if newline == -1:
            return
        line_bytes = content[cursor:newline]
        next_cursor = newline + 1
        absolute_line_start = start_offset + cursor
        absolute_after_line = start_offset + next_cursor
        cursor = next_cursor

        try:
            record = json.loads(line_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        record_type = record.get("type")
        if not isinstance(record_type, str):
            continue
        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}
        subtype = payload.get("type") if record_type == "event_msg" else None
        if subtype is not None and not isinstance(subtype, str):
            subtype = None
        yield {
            "type": record_type,
            "subtype": subtype,
            "timestamp": record.get("timestamp"),
            "payload": payload,
            "byte_offset": absolute_line_start,
            "new_offset": absolute_after_line,
        }


# Mapping from event_msg subtype -> high-level session state.
# None means "this event does not change state."
_STATE_MAP: dict[str, str] = {
    "task_started": "busy",
    "user_message": "busy",
    "task_complete": "idle",
}


def infer_state(event: dict[str, Any]) -> str | None:
    """Return the high-level state implied by `event`, or None if no change.

    `event` is one of the dicts yielded by `parse_jsonl_events` or the equivalent
    shape from a `codex_events` row. Only `event_msg` records influence state.
    """
    if event.get("type") != "event_msg":
        return None
    subtype = event.get("subtype")
    if not isinstance(subtype, str):
        return None
    return _STATE_MAP.get(subtype)


_STATE_BEARING_SUBTYPES = tuple(_STATE_MAP.keys())


def current_state(conn: sqlite3.Connection, *, session_id: str) -> str:
    """Return the latest high-level state for `session_id`, or 'unknown' if none.

    Walks the most recent state-bearing codex_events for the session. State-bearing
    means `type='event_msg'` and `subtype` in {task_started, user_message, task_complete}.
    """
    placeholders = ",".join("?" * len(_STATE_BEARING_SUBTYPES))
    row = conn.execute(
        f"""
        select subtype from codex_events
        where session_id = ?
          and type = 'event_msg'
          and subtype in ({placeholders})
        order by id desc
        limit 1
        """,
        (session_id, *_STATE_BEARING_SUBTYPES),
    ).fetchone()
    if row is None:
        return "unknown"
    return _STATE_MAP[row["subtype"]]


def ingest_session(
    conn: sqlite3.Connection,
    *,
    session_name: str,
    now: str | None = None,
) -> dict[str, Any]:
    """Run one ingest cycle for the named session.

    Reads new bytes from the session's rollout file starting at the recorded offset,
    parses JSONL records, persists each to `codex_events`, advances the session's
    `last_ingest_offset`, and bumps `last_heartbeat_at`.

    Returns a dict with `new_events` (int) and `new_offset` (int).

    Raises:
      - WorkerError if the session is unknown.
      - IngestError if the rollout path is missing or unreadable.
    """
    row = worker_db.session_row(conn, name=session_name)
    if row["state"] != "active":
        raise IngestError(
            f"session {session_name!r} is in state {row['state']!r}; "
            f"re-register it before ingesting"
        )
    session_id = row["id"]
    rollout_path_str = row["codex_session_path"]
    if not rollout_path_str:
        raise IngestError(f"session {session_name!r} has no codex_session_path")

    rollout_path = Path(rollout_path_str)
    if not rollout_path.exists():
        raise IngestError(f"rollout file does not exist: {rollout_path}")

    start_offset = row["last_ingest_offset"] if row["last_ingest_offset"] is not None else 0
    try:
        file_size = rollout_path.stat().st_size
    except OSError as exc:
        raise IngestError(f"failed to stat rollout file: {exc}") from exc
    if start_offset > file_size:
        raise IngestError(
            f"rollout file shrank: cached offset {start_offset} > current size {file_size}. "
            f"The rollout was likely rotated or truncated. Reset the session's last_ingest_offset "
            f"(e.g. via re-register) before retrying."
        )
    try:
        with open(rollout_path, "rb") as fh:
            fh.seek(start_offset)
            content = fh.read()
    except OSError as exc:
        raise IngestError(f"failed to read rollout file: {exc}") from exc

    timestamp = now or now_iso()
    new_events = 0
    new_offset = start_offset
    for event in parse_jsonl_events(content, start_offset=start_offset):
        worker_db.insert_codex_event(
            conn,
            session_id=session_id,
            timestamp=event["timestamp"] or timestamp,
            event_type=event["type"],
            subtype=event["subtype"],
            payload=event["payload"],
            byte_offset=event["byte_offset"],
            ingested_at=timestamp,
        )
        new_offset = event["new_offset"]
        new_events += 1

    if new_offset != start_offset:
        worker_db.set_session_ingest_offset(conn, session_id=session_id, offset=new_offset)
    worker_db.bump_session_heartbeat(conn, session_id=session_id, timestamp=timestamp)
    conn.commit()

    return {"new_events": new_events, "new_offset": new_offset}


def last_state_event_timestamp(conn: sqlite3.Connection, *, session_id: str) -> str | None:
    """Return the ISO timestamp of the most recent state-bearing event for `session_id`,
    or None if no state-bearing event has been ingested.

    State-bearing means type='event_msg' and subtype in {task_started, user_message,
    task_complete}. Mirrors `current_state`'s filter so the timestamp and the inferred
    state always refer to the same row.
    """
    placeholders = ",".join("?" * len(_STATE_BEARING_SUBTYPES))
    row = conn.execute(
        f"""
        select timestamp from codex_events
        where session_id = ?
          and type = 'event_msg'
          and subtype in ({placeholders})
        order by id desc
        limit 1
        """,
        (session_id, *_STATE_BEARING_SUBTYPES),
    ).fetchone()
    if row is None:
        return None
    return row["timestamp"]


def _parse_iso_z(value: str) -> datetime:
    """Parse an ISO-8601 string with a trailing 'Z' or numeric offset into an aware datetime."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def session_staleness_seconds(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    now: str | None = None,
) -> float | None:
    """Return seconds since the most recent state-bearing event for `session_id`.

    Returns None if no state-bearing event has been ingested. `now` defaults to the
    current UTC time; it accepts an ISO string for deterministic tests.
    """
    last = last_state_event_timestamp(conn, session_id=session_id)
    if last is None:
        return None
    now_dt = _parse_iso_z(now) if now else datetime.now(timezone.utc)
    last_dt = _parse_iso_z(last)
    return (now_dt - last_dt).total_seconds()
