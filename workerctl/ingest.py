from __future__ import annotations

import json
import sqlite3
from typing import Any, Iterator


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
