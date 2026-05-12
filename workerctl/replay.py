from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from workerctl.db import connect as connect_db
from workerctl.db import initialize_database
from workerctl.db import task_audit


def _shorten(value: str, *, max_length: int = 220) -> str:
    text = " ".join(value.split())
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "..."


def _capture_summary(capture: dict[str, Any]) -> str:
    classifier = capture.get("classifier") or {}
    busy_wait = classifier.get("busy_wait")
    startup = classifier.get("startup")
    parts = []
    if isinstance(busy_wait, dict) and busy_wait.get("pattern"):
        pattern = busy_wait["pattern"]
        if pattern == "rate_limit_prompt":
            parts.append("waiting_for_model_choice")
        elif pattern != "approval_prompt":
            parts.append(f"busy_wait={pattern}")
    if isinstance(startup, list) and startup:
        parts.append(f"startup={startup[0]}")
    if not parts:
        parts.append(f"{capture.get('line_count', 0)} lines")
    return ", ".join(parts)


def _capture_excerpt(capture: dict[str, Any]) -> str | None:
    content = capture.get("content")
    if not content:
        return None
    lines = [line.rstrip() for line in content.splitlines() if line.strip()]
    if not lines:
        return None
    interesting = []
    for line in lines[-12:]:
        stripped = line.strip()
        if stripped.startswith(("•", "›", ">", "Ran ", "Edited ", "Added ", "Built ", "Task is complete")):
            interesting.append(stripped)
    source_lines = interesting or lines[-4:]
    return _shorten(" / ".join(source_lines), max_length=320)


def _command_summary(command: dict[str, Any]) -> tuple[str, str, str]:
    command_type = command["type"]
    payload = command.get("payload") or {}
    result = command.get("result") or {}
    if command_type == "promote":
        return (
            "system",
            "command",
            f"promoted worker {payload.get('worker') or result.get('worker')} and launched manager {result.get('manager_session')}",
        )
    if command_type == "task_interrupt":
        followup = result.get("followup") or payload.get("followup") or "interrupt"
        return ("manager -> worker", "command", f"sent interrupt: {_shorten(followup)}")
    if command_type == "task_nudge":
        message = result.get("message") or payload.get("message") or "nudge"
        return ("manager -> worker", "command", f"sent nudge: {_shorten(message)}")
    if command_type == "finish_task":
        reason = result.get("reason") or payload.get("reason") or "task finished"
        suffix = "manager left open" if not result.get("stop_manager") else "manager stopped"
        return ("manager", "finish", f"finished task: {_shorten(reason)} ({suffix})")
    if command_type == "close_manager":
        reason = result.get("reason") or payload.get("reason") or "manager closed"
        return ("workerctl", "command", f"closed manager: {_shorten(reason)}")
    return ("workerctl", "command", f"{command_type} {command['state']}")


def replay_entries(audit: dict[str, Any], *, role: str = "all", mode: str = "timeline") -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen_capture_hashes_by_role: dict[str, set[str]] = {}
    include_captures = mode == "transcript"
    include_segments = mode == "full-transcript"
    include_observes = mode != "compact"

    for command in audit.get("commands", []):
        actor, kind, summary = _command_summary(command)
        if role != "all" and actor not in {role, f"manager -> {role}", f"{role} -> manager"}:
            if not (role == "manager" and actor in {"workerctl", "system"}):
                continue
        entries.append(
            {
                "actor": actor,
                "details": {
                    "command_id": command["id"],
                    "state": command["state"],
                    "type": command["type"],
                },
                "kind": kind,
                "source": "commands",
                "source_id": command["id"],
                "summary": summary,
                "timestamp": command["created_at"],
            }
        )

    for decision in audit.get("manager_decisions", []):
        if role not in {"all", "manager"}:
            continue
        entries.append(
            {
                "actor": "manager",
                "details": {"decision": decision["decision"], "manager_cycle_id": decision.get("manager_cycle_id")},
                "kind": "decision",
                "source": "manager_decisions",
                "source_id": decision["id"],
                "summary": f"decision {decision['decision']}: {_shorten(decision['reason'])}",
                "timestamp": decision["created_at"],
            }
        )

    if include_observes:
        for cycle in audit.get("manager_cycles", []):
            if role not in {"all", "manager"}:
                continue
            status = cycle.get("status") or {}
            summary = "observed task"

            # Detect Phase 3 session_cycle rows
            kind = status.get("kind") if isinstance(status, dict) else None
            if kind == "session_cycle":
                state = status.get("state") or "unknown"
                worker_session = status.get("worker_session") or ""
                staleness = status.get("staleness_seconds")
                if staleness is not None:
                    summary = (
                        f"observed session {worker_session} state {state} "
                        f"(staleness {staleness:.1f}s)"
                    )
                else:
                    summary = f"observed session {worker_session} state {state}"
            else:
                # Legacy logic for older status shapes
                worker_status = status.get("worker_status") or {}
                if worker_status:
                    state = worker_status.get("state") or "unknown"
                    current = worker_status.get("current_task") or ""
                    summary = f"observed worker status {state}: {_shorten(current)}"
                elif cycle.get("error"):
                    summary = f"observe failed: {_shorten(cycle['error'])}"

            entries.append(
                {
                    "actor": "manager",
                    "details": {
                        "cycle_id": cycle["id"],
                        "state": cycle["state"],
                        "worker_capture_id": cycle.get("worker_capture_id"),
                        "manager_capture_id": cycle.get("manager_capture_id"),
                    },
                    "kind": "observe",
                    "source": "manager_cycles",
                    "source_id": cycle["id"],
                    "summary": summary,
                    "timestamp": cycle.get("completed_at") or cycle["started_at"],
                }
            )

    if include_captures:
        for capture in audit.get("terminal_captures", []):
            capture_role = capture["role"]
            if role != "all" and role != capture_role:
                continue
            seen_hashes = seen_capture_hashes_by_role.setdefault(capture_role, set())
            if capture["content_sha256"] in seen_hashes:
                continue
            seen_hashes.add(capture["content_sha256"])
            excerpt = _capture_excerpt(capture)
            summary = f"{capture_role} terminal capture: {_capture_summary(capture)}"
            if excerpt:
                summary = f"{summary} | {excerpt}"
            entries.append(
                {
                    "actor": capture_role,
                    "details": {
                        "capture_id": capture["id"],
                        "classifier": capture.get("classifier"),
                        "content_sha256": capture["content_sha256"],
                        "line_count": capture["line_count"],
                        "source": capture["source"],
                    },
                    "kind": "capture",
                    "source": "terminal_captures",
                    "source_id": capture["id"],
                    "summary": summary,
                    "timestamp": capture["captured_at"],
                }
            )

    if include_segments:
        for segment in audit.get("transcript_segments", []):
            segment_role = segment["role"]
            if role != "all" and role != segment_role:
                continue
            text = segment.get("segment_text")
            if text:
                summary = f"{segment_role} transcript segment ({segment['line_count']} lines)"
            else:
                summary = f"{segment_role} transcript metadata ({segment['segment_kind']})"
            entries.append(
                {
                    "actor": segment_role,
                    "content": text,
                    "details": {
                        "content_sha256": segment["content_sha256"],
                        "line_count": segment["line_count"],
                        "previous_capture_id": segment.get("previous_capture_id"),
                        "retention_class": segment["retention_class"],
                        "segment_kind": segment["segment_kind"],
                        "source_capture_id": segment["source_capture_id"],
                    },
                    "kind": "transcript_segment",
                    "source": "transcript_segments",
                    "source_id": segment["id"],
                    "summary": summary,
                    "timestamp": segment["captured_at"],
                }
            )

    entries.sort(key=lambda entry: (entry["timestamp"], str(entry["source"]), str(entry["source_id"])))
    return entries


def replay_result(db_path: Path | None, *, task: str, role: str, mode: str, limit: int | None = None) -> dict[str, Any]:
    with connect_db(db_path) as conn:
        initialize_database(conn)
        audit = task_audit(conn, task=task)
    entries = replay_entries(audit, role=role, mode=mode)
    if limit is not None:
        entries = entries[-limit:]
    return {
        "entries": entries,
        "entry_count": len(entries),
        "mode": mode,
        "role": role,
        "task": audit["task"],
    }


def render_replay_text(result: dict[str, Any]) -> str:
    task = result["task"]
    lines = [
        f"Task: {task['name']}",
        f"State: {task['state']}",
        f"Mode: {result['mode']}",
        "",
    ]
    finish_entries = [entry for entry in result["entries"] if entry["kind"] == "finish"]
    if task["state"] in {"done", "failed"} and finish_entries:
        final = finish_entries[-1]
        lines.extend(
            [
                "Finished:",
                f"- {final['summary']}",
                "- Review: workerctl replay <task> --format compact",
                "- Audit: workerctl mutation-audit <task> --json",
                "",
            ]
        )
    for entry in result["entries"]:
        hhmmss = entry["timestamp"].split("T", 1)[-1].replace("Z", "")
        lines.append(f"{hhmmss}  {entry['actor']:<16} {entry['summary']}")
        if result["mode"] == "full-transcript" and entry["kind"] == "transcript_segment":
            content = entry.get("content")
            if content:
                lines.append(content)
            else:
                lines.append("[metadata only]")
    return "\n".join(lines)


def command_replay(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    result = replay_result(db_path, task=args.task, role=args.role, mode=args.format, limit=args.limit)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(render_replay_text(result))
    return 0
