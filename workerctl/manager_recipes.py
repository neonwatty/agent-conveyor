from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from workerctl.core import WorkerError


@dataclass(frozen=True)
class ManagerRecipe:
    name: str
    display_name: str
    description: str
    mode: str
    objective: str
    guidelines: tuple[str, ...]
    acceptance: tuple[str, ...]
    permissions: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    epilogues: tuple[str, ...] = ()
    evidence_gates: tuple[str, ...] = ()
    cleanup: str = "off"
    loop_template: str | None = None
    support_patterns: tuple[str, ...] = ()
    disallowed_actions: tuple[str, ...] = ()

    def summary(self) -> dict[str, Any]:
        return {
            "acceptance": list(self.acceptance),
            "cleanup": self.cleanup,
            "description": self.description,
            "disallowed_actions": list(self.disallowed_actions),
            "display_name": self.display_name,
            "epilogues": list(self.epilogues),
            "evidence_gates": list(self.evidence_gates),
            "guidelines": list(self.guidelines),
            "locked_summary_template": locked_summary_template(self),
            "loop_template": self.loop_template,
            "manager_config_command": manager_config_command(self),
            "mode": self.mode,
            "name": self.name,
            "objective": self.objective,
            "permissions": list(self.permissions),
            "support_patterns": list(self.support_patterns),
            "tools": list(self.tools),
        }


MANAGER_RECIPES: dict[str, ManagerRecipe] = {
    "goalbuddy-conveyor": ManagerRecipe(
        name="goalbuddy-conveyor",
        display_name="GoalBuddy Conveyor",
        description="Run broad work as one parent GoalBuddy board with one active child board at a time.",
        mode="strict",
        objective="Run a one-child-at-a-time GoalBuddy conveyor until every child is merged, proven satisfied, or blocked with evidence.",
        guidelines=(
            "Keep exactly one child board active at a time.",
            "Before activating the next child, update the parent receipt.",
        ),
        acceptance=(
            "Every child board has PR/CI/merge, satisfied_on_main, or blocker proof.",
            "Parent state records final status for every child.",
        ),
        permissions=("repo.open_pr", "repo.merge_green_pr", "worker_session.compact", "worker_session.clear"),
        tools=("verification.run_tests", "context.fetch_prs"),
        epilogues=("draft-pr", "record-handoff"),
        evidence_gates=(
            "child receipt with focused verification",
            "adversarial review",
            "PR/CI/merge or satisfied_on_main proof",
            "parent receipt update before the next child",
        ),
        cleanup="compact between child boards after saved handoff",
        support_patterns=("Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"),
        disallowed_actions=(
            "Do not run two child boards at once.",
            "Do not merge without green CI.",
            "Do not compact or clear before a saved handoff.",
        ),
    ),
    "test-coverage-loop": ManagerRecipe(
        name="test-coverage-loop",
        display_name="Test Coverage Loop",
        description="Improve or prove test confidence with coverage evidence before another pass.",
        mode="strict",
        objective="Improve or prove test coverage for the requested behavior.",
        guidelines=("Record coverage evidence before asking for another worker pass.",),
        acceptance=(
            "Coverage or targeted test evidence is recorded before another worker pass.",
            "Structured adversarial proof names the strongest realistic failure mode.",
        ),
        permissions=("worker_session.compact", "worker_session.clear"),
        tools=("verification.run_tests",),
        evidence_gates=("test_coverage", "adversarial_check"),
        cleanup="clear by default",
        loop_template="test_coverage_loop",
        support_patterns=("Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"),
        disallowed_actions=("Do not continue after only generic tests-passed text.",),
    ),
    "ux-polish-loop": ManagerRecipe(
        name="ux-polish-loop",
        display_name="UX Polish Loop",
        description="Iterate on visible UI quality using browser, screenshot, and visual-diff evidence.",
        mode="guided",
        objective="Iterate on visible UI quality using browser and screenshot evidence.",
        guidelines=("Compare visible output against references before requesting another pass.",),
        acceptance=(
            "Reference artifact, candidate screenshot, visual diff report, and below-threshold evidence are recorded.",
            "Structured adversarial proof is recorded before another visual pass.",
        ),
        permissions=("worker_session.compact", "worker_session.clear"),
        tools=("verification.run_playwright",),
        evidence_gates=(
            "reference_artifact",
            "candidate_screenshot",
            "visual_diff_report",
            "diff_below_threshold",
            "adversarial_check",
        ),
        cleanup="compact by default",
        loop_template="visual_diff_loop",
        support_patterns=("Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"),
        disallowed_actions=("Do not approve a visual pass without screenshot or browser evidence.",),
    ),
    "nudge-whats-next": ManagerRecipe(
        name="nudge-whats-next",
        display_name="Nudge / What's Next Manager",
        description="Observe, ask useful status questions, negotiate criteria, and keep permissions minimal.",
        mode="guided",
        objective="Observe the worker, ask useful status and next-step questions, and finish only with evidence.",
        guidelines=(
            "Prefer wait over nudge while the worker is active.",
            "Ask for must-have current-task criteria versus follow-ups when scope changes.",
        ),
        acceptance=(
            "Accepted criteria are satisfied or explicitly deferred.",
            "The final summary names commands run, changed files, and residual risk.",
        ),
        evidence_gates=("manager decision", "worker receipt", "accepted criteria closure"),
        cleanup="off by default",
        support_patterns=("Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"),
        disallowed_actions=("Do not grant repo or worker-session mutation permissions by default.",),
    ),
    "pr-ci-merge-ralph-loop": ManagerRecipe(
        name="pr-ci-merge-ralph-loop",
        display_name="PR/CI/Merge Ralph Loop",
        description="Drive delivery through PR readiness, CI, merge, handoff, and worker clear receipts.",
        mode="strict",
        objective="Drive the worker through PR readiness, CI, merge, handoff, and clear receipts.",
        guidelines=("Merge only after green CI and recorded manager decision evidence.",),
        acceptance=(
            "PR URL, green CI, merge receipt, and adversarial proof are recorded.",
            "Worker handoff exists before compact or clear.",
        ),
        permissions=("repo.open_pr", "repo.merge_green_pr", "worker_session.compact", "worker_session.clear"),
        tools=("verification.run_tests", "context.fetch_prs"),
        epilogues=("draft-pr", "record-handoff"),
        evidence_gates=("pr_url", "ci_green", "merge", "adversarial_check"),
        cleanup="clear after saved handoff",
        loop_template="pr_ci_merge_loop",
        support_patterns=("Inbox / No-Tmux App Loop", "Recovery / Resume / Handoff"),
        disallowed_actions=(
            "Do not open PRs before repo.open_pr is permitted.",
            "Do not merge before repo.merge_green_pr is permitted and CI is green.",
            "Do not clear before a saved handoff.",
        ),
    ),
}


ALIASES = {
    "goalbuddy conveyor": "goalbuddy-conveyor",
    "goalbuddy": "goalbuddy-conveyor",
    "test coverage loop": "test-coverage-loop",
    "test coverage": "test-coverage-loop",
    "ux polish loop": "ux-polish-loop",
    "ux polish": "ux-polish-loop",
    "visual polish": "ux-polish-loop",
    "nudge / what's next manager": "nudge-whats-next",
    "nudge whats next": "nudge-whats-next",
    "what's next": "nudge-whats-next",
    "whats next": "nudge-whats-next",
    "pr/ci/merge ralph loop": "pr-ci-merge-ralph-loop",
    "pr ci merge ralph loop": "pr-ci-merge-ralph-loop",
    "ralph loop": "pr-ci-merge-ralph-loop",
}


def list_manager_recipes() -> list[dict[str, Any]]:
    return [MANAGER_RECIPES[name].summary() for name in sorted(MANAGER_RECIPES)]


def manager_recipe(name: str) -> ManagerRecipe:
    key = normalize_recipe_name(name)
    try:
        return MANAGER_RECIPES[key]
    except KeyError as exc:
        allowed = ", ".join(sorted(MANAGER_RECIPES))
        raise WorkerError(f"Unknown manager recipe: {name}; expected one of: {allowed}") from exc


def normalize_recipe_name(name: str) -> str:
    normalized = " ".join(name.strip().lower().split())
    return ALIASES.get(normalized, normalized.replace("_", "-").replace(" ", "-"))


def manager_config_command(recipe: ManagerRecipe, task_placeholder: str = "<task>") -> list[str]:
    command = ["conveyor", "manager-config", task_placeholder, "--mode", recipe.mode, "--objective", recipe.objective]
    for guideline in recipe.guidelines:
        command.extend(["--guideline", guideline])
    for acceptance in recipe.acceptance:
        command.extend(["--acceptance", acceptance])
    permissions = set(recipe.permissions)
    if {"worker_session.compact", "worker_session.clear"}.issubset(permissions):
        command.append("--allow-worker-compact-clear")
        permissions.discard("worker_session.compact")
        permissions.discard("worker_session.clear")
    if "repo.open_pr" in permissions:
        command.append("--allow-pr")
        permissions.discard("repo.open_pr")
    if "repo.merge_green_pr" in permissions:
        command.append("--allow-merge-green")
        permissions.discard("repo.merge_green_pr")
    for permission in sorted(permissions):
        command.extend(["--permit", permission])
    for tool in recipe.tools:
        command.extend(["--tool", tool])
    for epilogue in recipe.epilogues:
        command.extend(["--epilogue", epilogue])
    return command


def locked_summary_template(recipe: ManagerRecipe) -> str:
    return "\n".join(
        [
            f"Selected recipe: {recipe.display_name}",
            f"Mode: {recipe.mode}",
            f"Permissions: {', '.join(recipe.permissions) if recipe.permissions else 'none'}",
            f"Tools: {', '.join(recipe.tools) if recipe.tools else 'none'}",
            f"Epilogues: {', '.join(recipe.epilogues) if recipe.epilogues else 'none'}",
            f"Cleanup: {recipe.cleanup}",
            f"Evidence gates: {', '.join(recipe.evidence_gates) if recipe.evidence_gates else 'manager-reviewed evidence'}",
            f"Not allowed: {'; '.join(recipe.disallowed_actions) if recipe.disallowed_actions else 'unconfirmed custom actions'}",
            "User confirmed: <yes|no>",
        ]
    )


def recipe_for_json(name: str) -> dict[str, Any]:
    return deepcopy(manager_recipe(name).summary())
