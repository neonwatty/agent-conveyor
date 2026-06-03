# Adversarial Proof

Every CTM closeout should include a burden-of-proof attempt: name the strongest
realistic failure mode, check it with concrete evidence, and report the result.
Adversarial proof is the stricter gated version used by manager-led and
Ralph-loop workflows when proof must be stored as structured
`adversarial_check` evidence before continuing or finishing.

## Required Receipt

An adversarial proof receipt must record:

- `failure_mode`: the strongest realistic failure mode considered.
- `check`: the command, test, trace, screenshot, audit record, diff, or inspection used.
- `result`: why the check rules out the failure mode, or what remains unresolved.

For ordinary, ungated closeout, these same fields can appear in the final agent
handoff instead of a `loop-evidence adversarial-check` receipt. Use the
structured receipt when Dispatch, a loop policy, or
`finish-task --require-adversarial-proof` needs to enforce the proof.

## CTM Enforcement

- Manager prompts include burden-of-proof guidance.
- `loop-evidence adversarial-check` records structured `evidence_type=adversarial_check`.
- Quality loop templates can require `adversarial_check` in `required_before_continue`.
- Dispatch blocks `continue_iteration` when required adversarial evidence is missing, malformed, or failed.
- `finish-task --require-adversarial-proof` blocks task completion until satisfied structured adversarial proof exists.

## Natural Language Triggers

Use these phrases when you want the manager to turn the feature on without
remembering command flags:

- "Run this as an adversarially gated Ralph loop."
- "Require adversarial proof before the worker gets another iteration."
- "Do not let this finish until the manager has tried to disprove it."
- "Before continuing, record the strongest realistic failure mode, the check,
  and the result."

The manager should first run `conveyor loop-triggers --classify "<prompt>"
--json`. A matched controlled trigger should then be translated into:

- a loop policy whose `required_before_continue` includes `adversarial_check`;
- a recorded `loop-evidence adversarial-check` receipt before each gated retry;
- `finish-task --require-adversarial-proof` when final completion should also
  be blocked until proof exists.

Unmatched generic caution stays ordinary guidance. Use
`conveyor qa-plan adversarial-triggers`,
`conveyor qa-run adversarial-triggers`, and
`docs/qa/adversarial-triggers.md` to run the natural-language trigger QA suite.

## GoalBuddy Usage

When planning with GoalBuddy, include adversarial proof in the oracle:

> The goal is complete only when the implementation has passing verification and a recorded adversarial check naming the strongest realistic failure mode, the check that tried to disprove it, and evidence that rules it out or converts it into an explicit follow-up.
