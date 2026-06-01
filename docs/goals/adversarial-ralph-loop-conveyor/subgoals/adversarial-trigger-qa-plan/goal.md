# Child Board: Adversarial Trigger QA Plan

## Objective

Create and merge the first conveyor vertical slice: natural-language trigger
phrases plus a runnable `workerctl qa-plan adversarial-triggers` QA plan that
proves those phrases map to Ralph-loop policy, Dispatch continuation gating,
finish gating, worker-proposed proof receipts, and manager-created adversarial
acceptance criteria.

## Parent Board

`docs/goals/adversarial-ralph-loop-conveyor/goal.md`

## Completion Proof

This child is complete only when:

- implementation is on a PR;
- focused verification passes;
- adversarial review is recorded;
- CI is green;
- the PR is merged;
- the merge SHA is recorded in this child and the parent board.

## Current PR

`https://github.com/neonwatty/codex-terminal-manager/pull/179`

## Oracle

The slice is true when `workerctl qa-plan adversarial-triggers` exists, prints
all five trigger drills, documents the QA in `docs/qa/adversarial-triggers.md`,
and focused tests plus a mechanical smoke prove the generated plan aligns with
the actual Dispatch and finish gates.

## Run Command

```text
/goal Follow docs/goals/adversarial-ralph-loop-conveyor/subgoals/adversarial-trigger-qa-plan/goal.md.
```
