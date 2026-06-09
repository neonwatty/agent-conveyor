from __future__ import annotations

from typing import Any

from workerctl.core import WorkerError
from workerctl.loop_templates import (
    LOOP_TEMPLATES as RALPH_LOOP_PRESETS,
    LoopTemplate as RalphLoopPreset,
    list_loop_templates,
)


def list_ralph_loop_presets() -> list[dict[str, Any]]:
    return list_loop_templates()


def ralph_loop_preset(name: str) -> RalphLoopPreset:
    try:
        return RALPH_LOOP_PRESETS[name]
    except KeyError as exc:
        allowed = ", ".join(sorted(RALPH_LOOP_PRESETS))
        raise WorkerError(f"Unknown Ralph loop preset: {name}; expected one of: {allowed}") from exc


def ralph_loop_preset_metadata(
    name: str,
    *,
    max_iterations: int | None = None,
    current_iteration: int = 0,
    seed_prompt_sha256: str | None = None,
) -> dict[str, Any]:
    return ralph_loop_preset(name).to_metadata(
        max_iterations=max_iterations,
        current_iteration=current_iteration,
        seed_prompt_sha256=seed_prompt_sha256,
    )
