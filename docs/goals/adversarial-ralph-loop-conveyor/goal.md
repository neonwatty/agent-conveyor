# Adversarial Ralph Loop Conveyor

## Objective

Run the remaining Ralph-loop and adversarial-trigger work as an autonomous
GoalBuddy conveyor: one vertical-slice child board at a time, each with
implementation, focused verification, adversarial review, PR creation, CI
monitoring, merge, and parent receipt update before the next child activates.

## Original Request

Create an autonomous GoalBuddy conveyor for this project. Split the work into
vertical-slice child GoalBuddy prep boards under one parent conveyor board, then
run the first slice all the way through PR review, CI, merge, and handoff.

## Intake Summary

- Input shape: `existing_plan`
- Audience: maintainers and operators validating Ralph-loop manager, Dispatch,
  worker, GoalBuddy, and adversarial-proof behavior.
- Authority: `requested`
- Proof type: `test + review + CI + merge receipt`
- Completion proof: every child board is either merged, proven already satisfied
  on `main`, or blocked with evidence; the parent board records PR URL, CI
  result, merge SHA, and adversarial proof for each child.
- Likely misfire: creating a large planning board that is not used to drive
  actual PR review, CI monitoring, merge, and parent receipts.

## Conveyor Rules

- Work one child board at a time.
- Do not mark a child complete until implementation, focused verification,
  adversarial review, PR creation, CI monitoring, merge, and handoff are done.
- If a queued child is already satisfied on `main`, prove it with code evidence
  and focused tests, then record it as satisfied rather than inventing work.
- After each merge, update the parent board receipt with PR URL, CI result,
  merge SHA, and the next activated child.
- If CI fails, inspect logs, fix, push, and re-monitor.
- Continue autonomously until all child boards are merged, proven satisfied, or
  explicitly blocked with evidence.

## Current Child Sequence

1. `adversarial-trigger-qa-plan`: natural-language trigger phrases and runnable
   QA plan proving they map to operational gates.
2. `adversarial-trigger-live-run`: run the new QA plan against disposable live
   manager/worker tasks and record pass/fail evidence.
3. `ralph-loop-manager-prompt-contract`: tighten manager prompt examples so
   natural-language adversarial acceptance criteria are reliably sent from
   manager to worker.
4. `ralph-loop-conveyor-automation`: add or document the reusable conveyor
   command/prompt pattern once the live trigger QA proves the contract.

## Goal Oracle

The conveyor is complete only when the parent `state.yaml` records every child
as one of:

- `done`: merged with PR URL, green CI result, merge SHA, verification commands,
  and adversarial review receipt.
- `satisfied_on_main`: code evidence and focused tests prove no new work was
  needed.
- `blocked`: the same blocker recurred with evidence and no safe next local
  action remains.

## Canonical Board

Machine truth lives at:

`docs/goals/adversarial-ralph-loop-conveyor/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/adversarial-ralph-loop-conveyor/goal.md.
```
