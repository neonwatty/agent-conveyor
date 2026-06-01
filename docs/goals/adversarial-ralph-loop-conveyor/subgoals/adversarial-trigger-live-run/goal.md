# Child Board: Adversarial Trigger Live Run

## Objective

Run `workerctl qa-plan adversarial-triggers` against disposable live
manager/worker tasks and record evidence for each trigger: loop policy creation,
Dispatch continuation block, finish gate, worker-proposed proof, and
manager-created adversarial criteria.

## Parent Board

`docs/goals/adversarial-ralph-loop-conveyor/goal.md`

## Completion Proof

This child is complete only when the live QA run has pass/fail receipts,
focused verification, adversarial review, PR creation if fixes are needed, CI
monitoring, merge when applicable, and a parent receipt update.

## Activation Rule

Activate only after `adversarial-trigger-qa-plan` is merged or proven satisfied
on `main`.

## Oracle

The slice is true when disposable live-run artifacts can reconstruct each
natural-language trigger, the operational gate it caused, the blocked or allowed
Dispatch/finish outcome, and the cleanup state.
