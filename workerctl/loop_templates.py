from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from workerctl.core import WorkerError


@dataclass(frozen=True)
class LoopTemplate:
    name: str
    description: str
    max_iterations: int
    cleanup_policy: str
    required_before_continue: tuple[str, ...]
    stop_conditions: tuple[str, ...] = ("max_iterations", "required_evidence")
    artifact_requirements: dict[str, dict[str, Any]] = field(default_factory=dict)
    recommended_tools: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()

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
            "artifact_requirements": deepcopy(self.artifact_requirements),
            "cleanup_policy": self.cleanup_policy,
            "current_iteration": current_iteration,
            "kind": "ralph_loop",
            "max_iterations": effective_max,
            "preset": self.name,
            "recommended_tools": list(self.recommended_tools),
            "required_before_continue": list(self.required_before_continue),
            "seed_prompt_sha256": seed_prompt_sha256,
            "stop_conditions": list(self.stop_conditions),
            "tags": list(self.tags),
            "template": self.name,
        }

    def summary(self) -> dict[str, Any]:
        return {
            "artifact_requirements": deepcopy(self.artifact_requirements),
            "cleanup_policy": self.cleanup_policy,
            "description": self.description,
            "max_iterations": self.max_iterations,
            "name": self.name,
            "recommended_tools": list(self.recommended_tools),
            "required_before_continue": list(self.required_before_continue),
            "stop_conditions": list(self.stop_conditions),
            "tags": list(self.tags),
        }


ADVERSARIAL_CHECK_REQUIREMENT: dict[str, Any] = {
    "type": "object",
    "description": "Structured proof that the manager or worker tried to disprove the iteration before continuing.",
    "required": ["failure_mode", "check", "result"],
    "properties": {
        "failure_mode": {"type": "string", "description": "Strongest realistic failure mode considered."},
        "check": {
            "type": "string",
            "description": "Command, test, trace, screenshot, audit, diff, or inspection used.",
        },
        "result": {
            "type": "string",
            "description": "Why the check rules out the failure mode or what remains unresolved.",
        },
    },
}


LOOP_TEMPLATES: dict[str, LoopTemplate] = {
    "build_then_clear": LoopTemplate(
        name="build_then_clear",
        description="Require build evidence before the manager can route another iteration, then clear worker context between iterations.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("build_passed", "cleanup"),
        tags=("build", "context"),
    ),
    "compact_then_continue": LoopTemplate(
        name="compact_then_continue",
        description="Require worker completion and cleanup evidence before compacting context and continuing.",
        max_iterations=4,
        cleanup_policy="compact",
        required_before_continue=("worker_completion", "cleanup"),
        tags=("context",),
    ),
    "pr_ci_merge_loop": LoopTemplate(
        name="pr_ci_merge_loop",
        description="Require PR URL, green CI, and merge evidence before continuing a manager-led PR loop.",
        max_iterations=2,
        cleanup_policy="clear",
        required_before_continue=("pr_url", "ci_green", "merge", "adversarial_check"),
        artifact_requirements={"adversarial_check": ADVERSARIAL_CHECK_REQUIREMENT},
        recommended_tools=("gh", "verification.run_tests"),
        tags=("repo", "ci"),
    ),
    "test_coverage_loop": LoopTemplate(
        name="test_coverage_loop",
        description="Repeat a test-coverage analysis/fix loop until coverage evidence is recorded or max iterations is reached.",
        max_iterations=3,
        cleanup_policy="clear",
        required_before_continue=("test_coverage", "adversarial_check"),
        artifact_requirements={"adversarial_check": ADVERSARIAL_CHECK_REQUIREMENT},
        recommended_tools=("coverage", "verification.run_tests"),
        tags=("tests",),
    ),
    "visual_diff_loop": LoopTemplate(
        name="visual_diff_loop",
        description="Repeat screenshot-to-HTML or UX visual-diff passes until screenshot artifacts and an acceptable diff report are recorded.",
        max_iterations=4,
        cleanup_policy="compact",
        required_before_continue=(
            "reference_artifact",
            "candidate_screenshot",
            "visual_diff_report",
            "diff_below_threshold",
            "adversarial_check",
        ),
        stop_conditions=("max_iterations", "required_evidence", "manager_accepts"),
        artifact_requirements={
            "adversarial_check": ADVERSARIAL_CHECK_REQUIREMENT,
            "reference_artifact": {"type": "path", "description": "Desired UX screenshot or reference image path."},
            "candidate_screenshot": {"type": "path", "description": "Screenshot captured from the worker-produced HTML or app view."},
            "visual_diff_report": {"type": "path", "description": "Readable report describing visual differences and screenshots compared."},
            "diff_score": {"type": "number", "description": "Numeric diff score where lower means closer to the reference."},
            "viewport": {"type": "string", "description": "Viewport used for the candidate screenshot, such as 1440x900."},
        },
        recommended_tools=("browser", "playwright", "pixelmatch"),
        tags=("visual", "frontend", "qa"),
    ),
}


def list_loop_templates() -> list[dict[str, Any]]:
    return [LOOP_TEMPLATES[name].summary() for name in sorted(LOOP_TEMPLATES)]


def loop_template(name: str) -> LoopTemplate:
    try:
        return LOOP_TEMPLATES[name]
    except KeyError as exc:
        allowed = ", ".join(sorted(LOOP_TEMPLATES))
        raise WorkerError(f"Unknown loop template: {name}; expected one of: {allowed}") from exc


def loop_template_metadata(
    name: str,
    *,
    max_iterations: int | None = None,
    current_iteration: int = 0,
    seed_prompt_sha256: str | None = None,
) -> dict[str, Any]:
    return loop_template(name).to_metadata(
        max_iterations=max_iterations,
        current_iteration=current_iteration,
        seed_prompt_sha256=seed_prompt_sha256,
    )
