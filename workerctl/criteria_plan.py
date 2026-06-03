from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from typing import Any


DEFAULT_DEFERRED_RATIONALE = "Follow-up after this QA slice."


@dataclass(frozen=True)
class CriteriaSuggestion:
    criterion: str
    status: str
    source: str = "worker_proposed"
    rationale: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "criterion": self.criterion,
            "source": self.source,
            "status": self.status,
            "rationale": self.rationale,
        }


_ACCEPTED_HEADING_RE = re.compile(r"\b(must[- ]?have|current[- ]?task|accepted)\b", re.IGNORECASE)
_DEFERRED_HEADING_RE = re.compile(r"\b(follow[- ]?up|deferred)\b", re.IGNORECASE)
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+(?P<text>.+?)\s*$")
_EMPTY_ITEM_RE = re.compile(r"^(?:n/?a|none|no follow[- ]?ups?|no deferred(?: criteria)?|nothing)$", re.IGNORECASE)
_INDENTED_CONTINUATION_RE = re.compile(r"^\s+\S")


def _heading_status(line: str) -> str | None:
    cleaned = line.strip().strip("#").strip().rstrip(":").strip()
    if not cleaned:
        return None
    if _DEFERRED_HEADING_RE.search(cleaned):
        return "deferred"
    if _ACCEPTED_HEADING_RE.search(cleaned):
        return "accepted"
    return None


def _clean_item(text: str) -> str:
    text = text.strip().strip("`").strip()
    return re.sub(r"\s+", " ", text)


def _is_empty_placeholder(text: str) -> bool:
    return _EMPTY_ITEM_RE.fullmatch(text.strip().rstrip(".")) is not None


def _make_suggestion(text: str, status: str) -> CriteriaSuggestion | None:
    criterion = _clean_item(text)
    if not criterion or _is_empty_placeholder(criterion):
        return None
    return CriteriaSuggestion(
        criterion=criterion,
        status=status,
        rationale=DEFAULT_DEFERRED_RATIONALE if status == "deferred" else None,
    )


def parse_worker_criteria_response(text: str) -> tuple[list[CriteriaSuggestion], list[str]]:
    suggestions: list[CriteriaSuggestion] = []
    warnings: list[str] = []
    current_status: str | None = None
    active_item_parts: list[str] = []
    active_item_status: str | None = None
    saw_heading = False

    def flush_active_item() -> None:
        nonlocal active_item_parts, active_item_status
        if active_item_status is not None:
            suggestion = _make_suggestion(" ".join(active_item_parts), active_item_status)
            if suggestion is not None:
                suggestions.append(suggestion)
        active_item_parts = []
        active_item_status = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            flush_active_item()
            continue

        match = _LIST_ITEM_RE.match(raw_line)
        if match is not None and current_status is not None:
            flush_active_item()
            active_item_parts = [match.group("text")]
            active_item_status = current_status
            continue

        if active_item_status is not None and _INDENTED_CONTINUATION_RE.match(raw_line):
            active_item_parts.append(line)
            continue

        heading_status = _heading_status(line)
        if heading_status is not None:
            flush_active_item()
            current_status = heading_status
            saw_heading = True
            continue

        flush_active_item()

    flush_active_item()

    if not saw_heading:
        warnings.append(
            "No clear must-have/current-task or follow-up/deferred headings found. "
            "Ask the worker to separate current-task criteria from deferred follow-ups."
        )
    elif not suggestions:
        warnings.append("Clear criteria headings were found, but no bullet or numbered criteria items were detected.")

    return suggestions, warnings


def suggestion_to_argv(task: str, suggestion: CriteriaSuggestion, *, path: str | None = None) -> list[str]:
    argv = [
        "conveyor",
        "criteria",
        task,
        "--add",
        "--criterion",
        suggestion.criterion,
        "--source",
        suggestion.source,
        "--status",
        suggestion.status,
    ]
    if suggestion.rationale:
        argv.extend(["--rationale", suggestion.rationale])
    if path:
        argv.extend(["--path", path])
    return argv


def suggestion_to_shell(task: str, suggestion: CriteriaSuggestion, *, path: str | None = None) -> str:
    return " ".join(shlex.quote(part) for part in suggestion_to_argv(task, suggestion, path=path))


def plan_criteria_commands(task: str, text: str, *, path: str | None = None) -> dict[str, Any]:
    suggestions, warnings = parse_worker_criteria_response(text)
    return {
        "task": task,
        "suggestions": [
            {
                **suggestion.as_dict(),
                "command": suggestion_to_argv(task, suggestion, path=path),
            }
            for suggestion in suggestions
        ],
        "warnings": warnings,
    }
