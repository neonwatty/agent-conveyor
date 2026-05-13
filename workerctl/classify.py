from __future__ import annotations

from typing import Any


RECENT_EVENT_QUIET_THRESHOLD = 10
BUSY_WAIT_PATTERNS = [
    (
        "mcp_startup",
        "Starting MCP servers",
        "terminal shows Codex waiting on MCP server startup",
        "inspect_or_interrupt",
    ),
    (
        "rate_limit_prompt",
        "Approaching rate limits",
        "terminal shows a rate-limit model switch prompt",
        "inspect_or_interrupt",
    ),
    (
        "enter_to_confirm",
        "Press enter to confirm",
        "terminal is waiting for Enter confirmation",
        "inspect_or_confirm",
    ),
    (
        "trust_prompt",
        "Do you trust the contents of this directory",
        "terminal is waiting for workspace trust confirmation",
        "inspect_or_accept_trust",
    ),
    (
        "plan_prompt",
        "Create a plan?",
        "terminal is waiting at Codex plan-mode suggestion",
        "inspect_or_confirm",
    ),
    (
        "approval_prompt",
        "approval",
        "terminal appears to mention an approval prompt",
        "inspect_or_approve",
    ),
]


def classify_startup_output(output: str) -> tuple[str, str]:
    normalized = output.lower()
    if "do you trust the contents of this directory" in normalized:
        return ("needs_trust", "Codex is waiting for workspace trust confirmation")
    if "openai codex" in normalized and "›" in output:
        return ("ready", "Codex input prompt is visible")
    if "working" in normalized and "esc to interrupt" in normalized:
        return ("working", "Codex is already working")
    if "error" in normalized or "failed" in normalized:
        return ("error", "terminal output contains an error-like message")
    if not output.strip():
        return ("starting", "terminal output is empty")
    return ("starting", "Codex has not reached a recognized startup state")


def classify_busy_wait(output: str, status_age: int | None, busy_wait_seconds: int, recent_event_count: int = 0) -> dict[str, Any] | None:
    if status_age is not None and status_age < busy_wait_seconds:
        return None
    for pattern_id, needle, reason, recommended_action in BUSY_WAIT_PATTERNS:
        if needle.lower() in output.lower():
            return {
                "pattern": pattern_id,
                "reason": reason,
                "recommended_action": recommended_action,
            }
    if "esc to interrupt" in output.lower() and status_age is not None and status_age >= busy_wait_seconds:
        # Suppress long_running_interruptible when the worker is actively emitting events.
        if recent_event_count >= RECENT_EVENT_QUIET_THRESHOLD:
            return None
        return {
            "pattern": "long_running_interruptible",
            "reason": "terminal shows an interruptible Codex operation while status.json is stale",
            "recommended_action": "inspect_or_interrupt",
        }
    return None

