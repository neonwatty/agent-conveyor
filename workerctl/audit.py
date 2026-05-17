from __future__ import annotations

from typing import Any


MUTATING_COMMAND_DECISIONS = {
    "deregister_session": set(),
    "extend_nudge_budget": {"escalate"},
    "finish_task": {"stop"},
    "pause_manager": {"escalate", "stop"},
    "request_worker_compact": {"nudge"},
    "stop_task": {"stop"},
    "task_interrupt": {"interrupt"},
    "task_nudge": {"nudge"},
}


def nearest_prior_decision(command: dict[str, Any], decisions: list[dict[str, Any]]) -> dict[str, Any] | None:
    prior = [
        decision
        for decision in decisions
        if decision["created_at"] <= command["created_at"]
    ]
    return prior[-1] if prior else None


def command_effect(command: dict[str, Any]) -> dict[str, Any]:
    payload = command.get("payload") or {}
    result = command.get("result") or {}
    send_result = result.get("send_result") if isinstance(result.get("send_result"), dict) else None
    dry_run = bool(send_result.get("dry_run")) if send_result else False
    sent = command["state"] == "succeeded" and send_result is not None and not dry_run
    return {
        "dry_run": dry_run,
        "permission_check": result.get("permission_check") or payload.get("permission_check"),
        "send_text": result.get("send_text") or payload.get("send_text"),
        "sent": sent,
        "slash_command": result.get("slash_command") if "slash_command" in result else payload.get("slash_command"),
        "worker_session": result.get("worker_session") or payload.get("worker_session"),
    }


def mutation_audit_result(audit: dict[str, Any]) -> dict[str, Any]:
    decisions = audit["manager_decisions"]
    decisions_by_id = {decision["id"]: decision for decision in decisions}
    records = []
    for command in audit["commands"]:
        allowed = MUTATING_COMMAND_DECISIONS.get(command["type"])
        if allowed is None:
            continue
        payload = command.get("payload") or {}
        result = command.get("result") or {}
        expected_failure = bool(result.get("expected_failure") or payload.get("expected_failure"))
        decision_check = result.get("manager_decision") or payload.get("manager_decision")
        if (
            command["type"] == "finish_task"
            and isinstance(result.get("final_decision_id"), int)
            and result["final_decision_id"] in decisions_by_id
        ):
            decision_check = {"decision": decisions_by_id[result["final_decision_id"]], "warnings": []}
        nearest = nearest_prior_decision(command, decisions)
        linked = decision_check.get("decision") if isinstance(decision_check, dict) else None
        warnings = []
        if expected_failure and command["state"] == "failed":
            pass
        elif not allowed:
            if linked:
                warnings.append("unexpected_linked_decision")
        elif isinstance(decision_check, dict):
            warnings.extend(decision_check.get("warnings", []))
        else:
            warnings.append("missing_decision_metadata")
        if allowed and nearest and not linked:
            warnings.append("nearest_decision_unlinked")
        if allowed and linked and linked.get("decision") not in allowed:
            warnings.append("linked_decision_incompatible")
        records.append(
            {
                "allowed_decisions": sorted(allowed),
                "command": {
                    "created_at": command["created_at"],
                    "id": command["id"],
                    "state": command["state"],
                    "type": command["type"],
                },
                "effect": command_effect(command),
                "expected_failure": expected_failure,
                "linked_decision": linked,
                "nearest_prior_decision": nearest,
                "ok": not warnings,
                "warnings": warnings,
            }
        )
    return {
        "ok": all(record["ok"] for record in records),
        "records": records,
        "summary": {
            "mutations": len(records),
            "with_warnings": sum(1 for record in records if record["warnings"]),
        },
        "task": audit["task"],
    }
