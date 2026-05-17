# Manager-Led Gate 4 Recovery Readiness

## Objective

Unlock or precisely block Gate 4 by validating and then running the recovery
readiness tranche from the dogfood reliability ladder.

Gate 4 is not a normal happy-path manager/worker run. It must prove the app can
handle blocked work, killed or stale sessions, partial lifecycle failures, and
guardrail-denied commands without recording fake success or leaving control
state dirty.

## Ladder Scope

Gate 4 requires:

- Scenario 5: intentional blocker task.
- Scenario 7: failure recovery drill.
- Scenario 8: guardrail drill.
- Isolated state roots for destructive or synthetic failure drills where
  appropriate.
- No fake success events in audit or replay.

## Must Preserve

- PM owns the GoalBuddy board and may start, configure, observe, package, and
  audit.
- Live destructive or synthetic failure tests must not contaminate the default
  state root.
- Any real default-state worker/manager pair must use disposable names and must
  clean up fully.
- No meaningful project work should be risked.
- No destructive cleanup, compact, clear, PR, merge, or broad product edits
  unless the runbook explicitly permits the action and the operator has approved
  it.
- Evidence must be scrubbed for session tokens and private absolute paths before
  packaging.

## Completion Proof

The tranche is complete only when `state.yaml` records a final Judge or PM audit
showing one of:

- `Gate 4 passed`: Scenarios 5, 7, and 8 passed with evidence, recovery cleanup
  is clean, and no fake success events appear in audit or replay.
- `Gate 4 blocked`: The exact blocker is recorded with enough evidence to choose
  the next helper or protocol fix.

## Starter Command

```text
/goal Follow docs/goals/manager-led-gate4-recovery-readiness/goal.md.
```
