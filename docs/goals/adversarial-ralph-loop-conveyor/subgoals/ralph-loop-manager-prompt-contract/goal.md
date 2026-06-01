# Child Board: Ralph Loop Manager Prompt Contract

## Objective

Tighten the manager prompt examples and operator guidance so adversarial
acceptance criteria are reliably transmitted from manager to worker during
Ralph-loop iterations.

## Parent Board

`docs/goals/adversarial-ralph-loop-conveyor/goal.md`

## Completion Proof

This child is complete only when live QA evidence from the prior child has been
reviewed, any prompt-contract gap is fixed or proven already satisfied on
`main`, focused verification passes, adversarial review is clean, and any needed
PR is green and merged.

## Activation Rule

Activate after `adversarial-trigger-live-run` has a pass/fail receipt.

## Oracle

The slice is true when manager-facing natural language reliably results in
worker-visible adversarial criteria with evidence requirements, or code evidence
proves the existing contract already satisfies that behavior.
