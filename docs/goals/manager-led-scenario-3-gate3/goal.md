# Manager-Led Scenario 3 Gate 3

## Objective

Unlock or precisely block Gate 3 by preparing and then running the next dogfood reliability tranche: a manager-led disposable edit readiness scenario.

Gate 2 proved the manager can drive emergent acceptance criteria without the PM mutating criteria directly. Gate 3 should raise the bar from status-only/live-control proof to a disposable workflow where a real manager supervises a real worker through a bounded, reversible edit while preserving guardrails, cleanup, evidence, and acceptance criteria discipline.

## Motivating Principle

This app is for project workflows that require nudging. The manager should be able to keep a worker moving when the full plan cannot be known upfront, and should discover emergent acceptance criteria as work reveals new details. Gate 3 should prove that this manager-led loop remains reliable when a worker is allowed to change a tightly scoped disposable artifact, not just report status.

## Must Preserve

- The PM thread owns the GoalBuddy board and may start, configure, observe, package, and audit.
- The manager must drive the live worker session and the criteria loop wherever feasible.
- The worker must operate on disposable, bounded files only.
- No meaningful project work should be risked during Gate 3.
- No destructive cleanup, compact, clear, PR, merge, or broad product edits unless the Gate 3 runbook explicitly permits the action and the operator has approved it.
- Evidence must be scrubbed for session tokens and private absolute paths before packaging.

## Completion Proof

The tranche is complete only when `state.yaml` records a final Judge or PM audit showing one of:

- `Gate 3 passed`: a real disposable worker/manager pair completed the bounded edit scenario with manager-led criteria negotiation, criteria closure, replay/export visibility, cleanup, and clean git/session state.
- `Gate 3 blocked`: the exact blocker is recorded with enough evidence to pick the next safe helper or protocol fix.

## Starter Command

```text
/goal Follow docs/goals/manager-led-scenario-3-gate3/goal.md.
```
