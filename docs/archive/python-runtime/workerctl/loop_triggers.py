from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LoopTrigger:
    name: str
    canonical_phrase: str
    intent: str
    pattern: str
    acceptance: str
    operator_actions: tuple[str, ...]
    required_before_continue: tuple[str, ...] = ()
    negative_controls: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "acceptance": self.acceptance,
            "canonical_phrase": self.canonical_phrase,
            "intent": self.intent,
            "name": self.name,
            "negative_controls": list(self.negative_controls),
            "operator_actions": list(self.operator_actions),
            "required_before_continue": list(self.required_before_continue),
        }


LOOP_TRIGGERS: tuple[LoopTrigger, ...] = (
    LoopTrigger(
        name="loop-gate-trigger",
        canonical_phrase="Run this as an adversarially gated Ralph loop.",
        intent="create_loop_policy",
        pattern=r"\brun this as an adversarial(?:ly)? gated (?:ralph )?loop\b",
        required_before_continue=("adversarial_check",),
        acceptance="Create or reuse a loop policy whose required_before_continue includes adversarial_check.",
        operator_actions=(
            "loop-triggers --classify '<prompt>' --json",
            "loop-templates --create-run <task> --template <template> --current-iteration 1",
            "enqueue-continue-iteration <task> --loop-run <run> --requested-iteration 2",
        ),
        negative_controls=(
            "Run tests before declaring this done.",
            "Be adversarial in your review, but do not create a loop.",
        ),
    ),
    LoopTrigger(
        name="iteration-gate-trigger",
        canonical_phrase="Do not send the worker another iteration until adversarial proof exists.",
        intent="gate_next_iteration",
        pattern=(
            r"\b(?:do not send the worker another iteration until adversarial proof exists|"
            r"require adversarial proof before (?:the worker gets another iteration|another worker iteration))\b"
        ),
        required_before_continue=("adversarial_check",),
        acceptance="Dispatch blocks continue_iteration before worker delivery until structured adversarial_check proof exists.",
        operator_actions=(
            "enqueue-continue-iteration <task> --loop-run <run> --requested-iteration <next>",
            "dispatch --once --type continue_iteration",
            "loop-evidence adversarial-check <task> --loop-run <run> --iteration <previous>",
        ),
        negative_controls=(
            "Ask the worker for another iteration.",
            "Wait for tests before sending a note.",
        ),
    ),
    LoopTrigger(
        name="finish-gate-trigger",
        canonical_phrase="Do not mark this done until you have tried to disprove it.",
        intent="require_finish_adversarial_proof",
        pattern=(
            r"\b(?:do not mark this done until you have tried to disprove it|"
            r"do not finish until you have tried to disprove it|"
            r"do not let this finish until the manager has tried to disprove it)\b"
        ),
        acceptance="finish-task uses --require-adversarial-proof and fails closed before structured proof exists.",
        operator_actions=(
            "finish-task <task> --require-adversarial-proof",
            "criteria <task> --satisfy <criterion> --evidence-json <structured adversarial_check>",
        ),
        negative_controls=(
            "Summarize risks before finishing.",
            "Do not mark this done until tests pass.",
        ),
    ),
    LoopTrigger(
        name="worker-directed-trigger",
        canonical_phrase="Ask the worker to identify the strongest realistic failure mode and prove it is handled.",
        intent="request_worker_adversarial_proof",
        pattern=(
            r"\b(?:ask the worker to identify the strongest realistic failure mode and prove it is handled|"
            r"before continuing, record the strongest realistic failure mode, the check, and the result)\b"
        ),
        acceptance="Worker response must contain failure_mode, check, and result, then be recorded as worker_proposed adversarial_check evidence.",
        operator_actions=(
            "session-nudge <worker> 'Reply with failure_mode, check, result'",
            "loop-evidence adversarial-check <task> --source worker_proposed",
        ),
        negative_controls=(
            "Ask the worker to summarize what changed.",
            "Ask the worker to run the tests.",
        ),
    ),
    LoopTrigger(
        name="acceptance-criteria-trigger",
        canonical_phrase="Each loop must include adversarial acceptance criteria from manager to worker.",
        intent="create_adversarial_acceptance_criteria",
        pattern=r"\beach loop must include adversarial acceptance criteria from manager to worker\b",
        acceptance="Manager records manager_inferred criteria that require negative Dispatch/evidence checks, not only happy-path tests.",
        operator_actions=(
            "criteria <task> --add --source manager_inferred --status accepted",
            "audit <task> && replay <task> && commands --task <task> --attempts",
        ),
        negative_controls=(
            "Each loop should have acceptance criteria.",
            "Ask the worker for a checklist.",
        ),
    ),
)


def _normalize_prompt(prompt: str) -> str:
    return " ".join(prompt.strip().lower().split())


def list_loop_triggers() -> list[dict[str, Any]]:
    return [trigger.to_dict() for trigger in LOOP_TRIGGERS]


def classify_loop_trigger(prompt: str) -> dict[str, Any]:
    normalized = _normalize_prompt(prompt)
    for trigger in LOOP_TRIGGERS:
        if re.search(trigger.pattern, normalized):
            return {
                "guidance": "Approved loop trigger matched. Follow the operator_actions exactly and preserve the correlation receipt.",
                "matched": True,
                "matched_trigger": trigger.to_dict(),
                "prompt": prompt,
            }
    return {
        "guidance": "No approved loop trigger matched; treat this as ordinary manager guidance and do not create loop policy or continuation gates automatically.",
        "matched": False,
        "matched_trigger": None,
        "prompt": prompt,
    }
