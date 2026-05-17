# Manager-Led Gate 5 Resume And Handoff

## Objective

Validate Gate 5 readiness by running Scenario 9 from the dogfood reliability
ladder: a disposable manager/worker task must be resumable from durable
workerctl state, not live chat memory.

## Scope

This tranche covers:

- Scenario 9: Resume And Handoff Dogfood.
- Verification that `criteria-plan` exists or that the criteria extraction risk
  is explicitly accepted.
- A final Gate 5 decision: passed, intentionally deferred, or blocked.

## Must Preserve

- Use disposable task/session names.
- Use isolated `WORKERCTL_STATE_ROOT` for the live drill.
- Do not do meaningful project work.
- Do not compact, clear, PR, merge, or run destructive cleanup except through
  the approved disposable cleanup path.
- Evidence must be scrubbed for session tokens and private absolute paths
  before packaging.

## Completion Proof

The tranche is complete only when `state.yaml` records a final audit showing
one of:

- `Gate 5 passed`: Scenario 9 passed, durable replay/export/handoff/criteria
  state was enough to resume safely, cleanup is clean, and criteria-plan risk
  is resolved or accepted.
- `Gate 5 blocked`: The exact blocker is recorded with evidence.
- `Gate 5 deferred`: Scenario 9 is intentionally deferred with rationale.

## Starter Command

```text
/goal Follow docs/goals/manager-led-gate5-resume-handoff/goal.md.
```
