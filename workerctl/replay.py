from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError
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


def _acceptance_criterion_summary(event: dict[str, Any]) -> str | None:
    payload = event.get("payload") or {}
    criterion_id = payload.get("criterion_id")
    criterion_label = f"#{criterion_id}" if criterion_id is not None else "<unknown>"
    status = payload.get("status")
    criterion = payload.get("criterion")
    previous_status = payload.get("previous_status")
    transition = f" ({previous_status} -> {status})" if previous_status and status else ""
    if event.get("type") == "acceptance_criterion_added":
        if status == "proposed":
            return f"proposed criterion {criterion_label}: {_shorten(criterion or '')}"
        if status == "accepted":
            return f"accepted criterion {criterion_label}: {_shorten(criterion or '')}"
        if status == "satisfied":
            proof = payload.get("proof")
            if proof:
                return f"satisfied criterion {criterion_label}: proof recorded ({_shorten(proof)})"
            return f"satisfied criterion {criterion_label}: proof recorded"
        if status == "deferred":
            rationale = payload.get("rationale")
            return f"deferred criterion {criterion_label}: {_shorten(rationale or criterion or '')}"
        if status == "rejected":
            rationale = payload.get("rationale")
            return f"rejected criterion {criterion_label}: {_shorten(rationale or criterion or '')}"
        return f"added {status or 'unknown'} criterion {criterion_label}: {_shorten(criterion or '')}"
    if event.get("type") != "acceptance_criterion_updated":
        return None
    if status == "accepted":
        return f"accepted criterion {criterion_label}{transition}: {_shorten(criterion or '')}"
    if status == "satisfied":
        proof = payload.get("proof")
        if proof:
            return f"satisfied criterion {criterion_label}{transition}: proof recorded ({_shorten(proof)})"
        return f"satisfied criterion {criterion_label}{transition}: proof recorded"
    if status == "deferred":
        rationale = payload.get("rationale")
        suffix = rationale or criterion or ""
        return f"deferred criterion {criterion_label}{transition}: {_shorten(suffix)}"
    if status == "rejected":
        rationale = payload.get("rationale")
        suffix = rationale or criterion or ""
        return f"rejected criterion {criterion_label}{transition}: {_shorten(suffix)}"
    fallback_transition = f"{previous_status} -> {status}" if previous_status else status or "updated"
    return f"updated criterion {criterion_label}: {fallback_transition}"


def _acceptance_criterion_details(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload") or {}
    keys = (
        "criterion_id",
        "criterion",
        "status",
        "previous_status",
        "source",
        "task_id",
        "proof",
        "previous_proof",
        "rationale",
        "previous_rationale",
        "evidence",
        "previous_evidence",
        "created",
    )
    details = {"event_type": event.get("type")}
    for key in keys:
        if key in payload:
            details[key] = payload[key]
    return details


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

    for attempt in audit.get("command_attempts", []):
        if role != "all" and role != "manager":
            continue
        details = {
            "attempt_id": attempt["id"],
            "command_id": attempt["command_id"],
            "correlation_id": attempt["correlation_id"],
            "dispatcher_id": attempt["dispatcher_id"],
            "error": attempt.get("error"),
            "result": attempt.get("result"),
            "side_effect_completed": attempt["side_effect_completed"],
            "side_effect_started": attempt["side_effect_started"],
            "state": attempt["state"],
        }
        entries.append(
            {
                "actor": "dispatch",
                "details": details,
                "kind": "command_attempt",
                "source": "command_attempts",
                "source_id": attempt["id"],
                "summary": f"dispatch attempt {attempt['state']}: {attempt['command_id']}",
                "timestamp": attempt["started_at"],
            }
        )

    for notification in audit.get("routed_notifications", []):
        if role != "all" and role != "manager":
            continue
        details = {
            "command_id": notification.get("command_id"),
            "consumed_at": notification.get("consumed_at"),
            "consumed_by_session_id": notification.get("consumed_by_session_id"),
            "consumed_by_session_name": notification.get("consumed_by_session_name"),
            "correlation_id": notification["correlation_id"],
            "delivered_at": notification.get("delivered_at"),
            "delivery_mode": notification.get("delivery_mode"),
            "notification_id": notification["id"],
            "signal_type": notification["signal_type"],
            "source_session_id": notification.get("source_session_id"),
            "source_session_name": notification.get("source_session_name"),
            "state": notification["state"],
            "target_session_id": notification.get("target_session_id"),
            "target_session_name": notification.get("target_session_name"),
        }
        entries.append(
            {
                "actor": "dispatch",
                "details": details,
                "kind": "routed_notification",
                "source": "routed_notifications",
                "source_id": notification["id"],
                "summary": (
                    f"dispatch notification {notification['signal_type']}: "
                    f"{notification['state']} via {notification.get('delivery_mode') or 'unknown'}"
                ),
                "timestamp": notification.get("delivered_at") or notification["created_at"],
            }
        )

    for chain in audit.get("correlation_chains", []):
        if role != "all" and role != "manager":
            continue
        parts = [chain["command_type"], chain["command_state"]]
        if chain.get("command_id") is None and chain.get("source_event_id") is not None:
            parts.append(f"source event #{chain['source_event_id']}")
        if chain.get("manager_decision_id") is not None:
            parts.append(f"decision #{chain['manager_decision_id']}")
        if chain.get("manager_cycle_id") is not None:
            parts.append(f"cycle #{chain['manager_cycle_id']}")
        if chain.get("attempt_ids"):
            parts.append(f"{len(chain['attempt_ids'])} attempt(s)")
        if chain.get("routed_notification_ids"):
            parts.append(f"{len(chain['routed_notification_ids'])} notification(s)")
        entries.append(
            {
                "actor": "dispatch",
                "details": chain,
                "kind": "correlation_chain",
                "source": "correlation_chains",
                "source_id": chain["command_id"] or chain.get("correlation_id") or chain.get("source_event_id"),
                "summary": " -> ".join(parts),
                "timestamp": next(
                    (
                        command["created_at"]
                        for command in audit.get("commands", [])
                        if command["id"] == chain["command_id"]
                    ),
                    chain.get("created_at") or audit["task"]["created_at"],
                ),
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

    for ack in audit.get("task_acknowledgements", []):
        ack_role = ack["role"]
        if role != "all" and role != ack_role:
            continue
        entries.append(
            {
                "actor": ack_role,
                "details": {
                    "ack_id": ack["id"],
                    "binding_id": ack.get("binding_id"),
                    "correlation_id": ack.get("correlation_id"),
                    "revision": ack["revision"],
                    "role": ack_role,
                },
                "kind": "acknowledgement",
                "source": "task_acknowledgements",
                "source_id": ack["id"],
                "summary": f"{ack_role} acknowledged task contract (revision {ack['revision']})",
                "timestamp": ack["created_at"],
            }
        )

    for continuation in audit.get("task_continuations", []):
        proposer = continuation["proposer"]
        if role != "all" and role != proposer:
            continue
        entries.append(
            {
                "actor": proposer,
                "details": {
                    "continuation_id": continuation["id"],
                    "correlation_id": continuation["correlation_id"],
                    "payload_keys": sorted((continuation.get("payload") or {}).keys()),
                    "revision": continuation["revision"],
                },
                "kind": "continuation",
                "source": "task_continuations",
                "source_id": continuation["id"],
                "summary": f"{proposer} proposed continuation (revision {continuation['revision']})",
                "timestamp": continuation["created_at"],
            }
        )

    for review in audit.get("continuation_reviews", []):
        if role not in {"all", "manager", "reviewer", "workerctl"}:
            continue
        entries.append(
            {
                "actor": "reviewer",
                "details": {
                    "agreement": review["agreement"],
                    "correlation_id": review["correlation_id"],
                    "manager_continuation_id": review["manager_continuation_id"],
                    "operator_routing_required": review["subagent_run"].get("operator_routing_required", False),
                    "verdict": review["verdict"],
                    "worker_continuation_id": review["worker_continuation_id"],
                },
                "kind": "continuation_review",
                "source": "continuation_reviews",
                "source_id": review["id"],
                "summary": f"continuation review {review['agreement']} -> {review['verdict']}",
                "timestamp": review["created_at"],
            }
        )

    for run in audit.get("epilogue_runs", []):
        if role not in {"all", "manager", "workerctl"}:
            continue
        entries.append(
            {
                "actor": "manager",
                "details": {
                    "correlation_id": run.get("correlation_id"),
                    "error": run.get("error"),
                    "state": run["state"],
                    "step_name": run["step_name"],
                },
                "kind": "epilogue",
                "source": "epilogue_runs",
                "source_id": run["id"],
                "summary": f"epilogue {run['step_name']}: {run['state']}",
                "timestamp": run.get("finished_at") or run["started_at"],
            }
        )

    for event in audit.get("events", []):
        if role not in {"all", "manager"}:
            continue
        summary = _acceptance_criterion_summary(event)
        if summary is None:
            continue
        entries.append(
            {
                "actor": event.get("actor") or "workerctl",
                "details": _acceptance_criterion_details(event),
                "kind": "acceptance_criterion",
                "source": "events",
                "source_id": event["id"],
                "summary": summary,
                "timestamp": event["created_at"],
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
                worker_session = status.get("worker_session") or "<unknown>"
                if cycle.get("error") or cycle.get("state") == "failed":
                    error_text = cycle.get("error") or "unknown error"
                    summary = (
                        f"observe failed for session {worker_session}: "
                        f"{_shorten(error_text)}"
                    )
                else:
                    state = status.get("state") or "unknown"
                    staleness = status.get("staleness_seconds")
                    if staleness is not None:
                        summary = (
                            f"observed session {worker_session} state {state} "
                            f"(staleness {staleness:.1f}s)"
                        )
                    else:
                        summary = f"observed session {worker_session} state {state}"
                    notable = status.get("notable_pane_pattern")
                    if notable:
                        summary += f" [pane pattern: {notable}]"
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

        for span in audit.get("manager_cycle_spans", []):
            if role not in {"all", "manager"}:
                continue
            suffix = ""
            if span.get("error_type"):
                suffix = f" ({span['error_type']})"
            entries.append(
                {
                    "actor": "manager",
                    "details": {
                        "attributes": span.get("attributes") or {},
                        "command_id": span.get("command_id"),
                        "duration_ms": span.get("duration_ms"),
                        "error_type": span.get("error_type"),
                        "manager_cycle_id": span.get("manager_cycle_id"),
                        "manager_decision_id": span.get("manager_decision_id"),
                        "run_id": span.get("run_id"),
                        "state": span.get("state"),
                    },
                    "kind": "manager_cycle_span",
                    "source": "manager_cycle_spans",
                    "source_id": span["id"],
                    "summary": (
                        f"cycle #{span['manager_cycle_id']} phase {span['phase']} "
                        f"{span['state']} in {span['duration_ms']:.1f}ms{suffix}"
                    ),
                    "timestamp": span.get("completed_at") or span["started_at"],
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

    entries.sort(key=lambda entry: (entry["timestamp"], str(entry["source"]), entry["source_id"]))
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
                "- Review: conveyor replay <task> --format compact",
                "- Audit: conveyor mutation-audit <task> --json",
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
    if args.format == "full-transcript" and not getattr(args, "include_content", False):
        raise WorkerError(
            "full-transcript replay prints stored terminal content; rerun with "
            "--include-content only when stdout is redirected or you intentionally "
            "want verbatim transcript output."
        )
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    result = replay_result(db_path, task=args.task, role=args.role, mode=args.format, limit=args.limit)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(render_replay_text(result))
    return 0
