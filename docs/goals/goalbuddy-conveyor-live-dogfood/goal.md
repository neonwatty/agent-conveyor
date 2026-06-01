# GoalBuddy Conveyor Live Dogfood

## Objective

Dogfood the natural-language GoalBuddy conveyor path with one already-satisfied
child and one tiny real implementation child, preserving one-child-at-a-time
state, focused proof, adversarial review, PR/CI/merge receipts, and parent
handoff evidence.

## Original Request

Begin the next slice: dogfood the new conveyor for real.

## Intake Summary

- Input shape: `specific`
- Audience: maintainers, GoalBuddy managers, and workerctl operators.
- Authority: `requested`
- Proof type: `test + review + CI + merge receipt`
- Completion proof: the parent board records the satisfied-on-main child, the
  tiny implementation child, green PR/CI/merge receipts, and final PM audit.
- Likely misfire: creating a board that describes the conveyor but does not
  prove sequential child activation or the satisfied-on-main branch.

## Conveyor Rules

- Work exactly one child board at a time.
- A child already satisfied on `main` must be proven with source evidence and
  focused tests, then recorded as `satisfied_on_main`.
- A child that changes code or docs must complete focused verification,
  adversarial review, PR creation, CI monitoring, merge, and parent receipt
  update before the next child activates.
- The parent board must stay the durable source of truth for active child,
  PR URL, CI result, merge SHA, and final audit.

## Child Sequence

1. `satisfied-main-proof`: prove the reusable conveyor command and docs already
   exist on `main`, then record `satisfied_on_main`.
2. `tiny-doc-slice`: add a small live-dogfood QA note and run it through
   review, PR, CI, merge, and receipt update.

## Goal Oracle

The dogfood run is complete only when the parent and both child boards pass the
GoalBuddy checker and the parent receipt proves either `satisfied_on_main` or
PR/CI/merge evidence for every child.

## Run Command

```text
/goal Follow docs/goals/goalbuddy-conveyor-live-dogfood/goal.md.
```
