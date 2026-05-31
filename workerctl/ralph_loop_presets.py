from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from workerctl.core import WorkerError


@dataclass(frozen=True)
class RalphLoopPreset:
    name: str
    description: str
    max_iterations: int
    cleanup_policy: str
    required_before_continue: tuple[str, ...]
    stop_conditions: tuple[str, ...] = ("max_iterations", "required_evidence")

    def to_metadata(
        self,
        *,
        max_iterations: int | None = None,
        current_iteration: int = 0,
        seed_prompt_sha256: str | None = None,
    ) -> dict[str, Any]:
        effective_max = self.max_iterations if max_iterations is None else max_iterations
        if effective_max < 1:
            raise WorkerError("max_iterations must be at least 1")
        if current_iteration < 0:
            raise WorkerError("current_iteration must be non-negative")
        if current_iteration > effective_max:
            raise WorkerError("current_iteration must not exceed max_iterations")
        return {
            "cleanup_policy": self.cleanup_policy,
            "current_iteration": current_iteration,
            "kind": "ralph_loop",
            "max_iterations": effective_max,
            "preset": self.name,
            "required_before_continue": list(self.required_before_continue),
            "seed_prompt_sha256": seed_prompt_sha256,
            "stop_conditions": list(self.stop_conditions),
        }

    def summary(self) -> dict[str, Any]:
        return {
            "cleanup_policy": self.cleanup_policy,
            "description": self.description,
            "max_iterations": self.max_iterations,
            "name": self.name,
            "required_before_continue": list(self.required_before_continue),
            "stop_conditions": list(self.stop_conditions),
        }


RALPH_LOOP_PRESETS: dict[str, RalphLoopPreset] = {
    "build_then_clear": RalphLoopPreset(
        name="build_then_clear",
        description="Require build evidence before the manager can route another iteration, then clear worker context between iterations.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("build_passed", "cleanup"),
    ),
    "compact_then_continue": RalphLoopPreset(
        name="compact_then_continue",
        description="Require worker completion and cleanup evidence before compacting context and continuing.",
        max_iterations=4,
        cleanup_policy="compact",
        required_before_continue=("worker_completion", "cleanup"),
    ),
    "pr_ci_merge_loop": RalphLoopPreset(
        name="pr_ci_merge_loop",
        description="Require PR URL, green CI, and merge evidence before continuing a manager-led PR loop.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("pr_url", "ci_green", "merge"),
    ),
    "test_coverage_loop": RalphLoopPreset(
        name="test_coverage_loop",
        description="Repeat a test-coverage analysis/fix loop until coverage evidence is recorded or max iterations is reached.",
        max_iterations=3,
        cleanup_policy="clear",
        required_before_continue=("test_coverage",),
    ),
}


def list_ralph_loop_presets() -> list[dict[str, Any]]:
    return [RALPH_LOOP_PRESETS[name].summary() for name in sorted(RALPH_LOOP_PRESETS)]


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
