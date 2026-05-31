# Adversarial Proof

Adversarial proof is the burden-of-proof check used by manager-led and Ralph-loop workflows. It asks the manager or worker to assume the implementation may still be wrong until evidence proves otherwise.

## Required Receipt

An adversarial proof receipt must record:

- `failure_mode`: the strongest realistic failure mode considered.
- `check`: the command, test, trace, screenshot, audit record, diff, or inspection used.
- `result`: why the check rules out the failure mode, or what remains unresolved.

## CTM Enforcement

- Manager prompts include burden-of-proof guidance.
- `loop-evidence adversarial-check` records structured `evidence_type=adversarial_check`.
- Quality loop templates can require `adversarial_check` in `required_before_continue`.
- Dispatch blocks `continue_iteration` when required adversarial evidence is missing, malformed, or failed.
- `finish-task --require-adversarial-proof` blocks task completion until satisfied structured adversarial proof exists.

## GoalBuddy Usage

When planning with GoalBuddy, include adversarial proof in the oracle:

> The goal is complete only when the implementation has passing verification and a recorded adversarial check naming the strongest realistic failure mode, the check that tried to disprove it, and evidence that rules it out or converts it into an explicit follow-up.
