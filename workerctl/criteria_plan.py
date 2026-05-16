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


def parse_worker_criteria_response(text: str) -> tuple[list[CriteriaSuggestion], list[str]]:
    suggestions: list[CriteriaSuggestion] = []
    warnings: list[str] = []
    current_status: str | None = None
    saw_heading = False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        match = _LIST_ITEM_RE.match(raw_line)
        if match is not None and current_status is not None:
            criterion = _clean_item(match.group("text"))
            if not criterion:
                continue
            suggestions.append(
                CriteriaSuggestion(
                    criterion=criterion,
                    status=current_status,
                    rationale=DEFAULT_DEFERRED_RATIONALE if current_status == "deferred" else None,
                )
            )
            continue

        heading_status = _heading_status(line)
        if heading_status is not None:
            current_status = heading_status
            saw_heading = True
            continue

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
        "workerctl",
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
