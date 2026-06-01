# Child Board: Tiny Doc Slice

## Objective

Add a tiny live-dogfood QA note that explains how to run the two-child conveyor
smoke after the reusable `goalbuddy-conveyor` plan exists.

## Parent Board

`docs/goals/goalbuddy-conveyor-live-dogfood/goal.md`

## Completion Proof

This child is complete only after the docs change is implemented, focused
verification passes, adversarial review is clean, a PR is created, CI is
monitored green, the PR is merged, and the parent receipt records the merge.

## Oracle

The slice is true when the note exists on `main` and the parent board records
PR URL, green CI, merge SHA, adversarial review, and final GoalBuddy checker
proof.
