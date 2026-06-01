# Child Board: Ralph Loop Conveyor Automation

## Objective

Create or document the reusable conveyor command/prompt pattern once the live
trigger behavior and manager prompt contract are proven.

## Parent Board

`docs/goals/adversarial-ralph-loop-conveyor/goal.md`

## Completion Proof

This child is complete only when the reusable conveyor path is implemented or
documented, focused verification passes, adversarial review is clean, and any
needed PR is green and merged.

## Activation Rule

Activate after `ralph-loop-manager-prompt-contract` is merged, proven satisfied
on `main`, or blocked with evidence.

## Oracle

The slice is true when a manager can start the same one-child-at-a-time conveyor
flow from natural language or documented commands, and receipts prove the
handoff between child boards stays on the rails.
